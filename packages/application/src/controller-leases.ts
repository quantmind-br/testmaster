import type { PersistenceDatabase } from "@testmaster/persistence";

/** A named, fenced lease row: `fence` grows on every takeover, never on renewal. */
export interface Lease {
  holder: string;
  fence: number;
  acquiredAt: string;
  expiresAt: string;
}

/** Term of the scheduler's leadership without renewal; the scheduler is leaderless after 2x this. */
export const SCHEDULER_LEASE_MS = 30_000;
/** Term of an elected loop's lease; the holder renews at a third of it, even between ticks. */
export const LOOP_LEASE_MS = 30_000;

/** Thrown inside the caller's transaction by `assertLease` when the holder no longer owns the lease. */
export class LeaseLostError extends Error {
  constructor(readonly lease: string) {
    super(`Controller lease lost: ${lease}`);
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Leases are read-modify-write; one transaction makes a duplicated election impossible on both engines. */
function atomically<T>(database: PersistenceDatabase, work: () => T): T {
  return database.inTransaction ? work() : database.withTx(work);
}

/** The stored lease of `name`, or null when nobody ever held it. */
export function readLease(database: PersistenceDatabase, name: string): Lease | null {
  const row = database.get(
    "SELECT holder,fence,acquired_at,expires_at FROM controller_leases WHERE name=?",
    name,
  );
  return row
    ? {
        holder: String(row.holder),
        fence: Number(row.fence),
        acquiredAt: String(row.acquired_at),
        expiresAt: String(row.expires_at),
      }
    : null;
}

/**
 * Milliseconds since the epoch on the clock every controller shares: the PostgreSQL server's, so a
 * skewed controller clock decides nothing; SQLite is single-host and shares the process clock.
 */
export function databaseClock(database: PersistenceDatabase): number {
  if (database.engine !== "postgres") return Date.now();
  return Number(
    database.get<{ ms: string | number }>(
      "SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS ms",
    )?.ms,
  );
}

/**
 * Takes or renews the lease of `name`: a free or expired lease is taken with the next fence, one the
 * caller holds unexpired is renewed under its current fence, and one another holder keeps unexpired
 * answers null. The fence only changes hands through this call, so a stale holder is detectable.
 * Expiry is judged on the database clock unless `nowMs` is given (tests), so a controller whose own
 * clock runs ahead cannot take a live lease.
 */
export function acquireLease(
  database: PersistenceDatabase,
  name: string,
  holder: string,
  ttlMs: number,
  nowMs: number = databaseClock(database),
): { fence: number } | null {
  return atomically(database, () => {
    const current = readLease(database, name);
    const expiresAt = iso(nowMs + ttlMs);
    if (!current) {
      database.run(
        "INSERT INTO controller_leases(name,holder,fence,acquired_at,expires_at) VALUES(?,?,?,?,?)",
        name,
        holder,
        1,
        iso(nowMs),
        expiresAt,
      );
      return { fence: 1 };
    }
    const live = Date.parse(current.expiresAt) > nowMs;
    if (current.holder === holder && live) {
      const renewed = database.run(
        "UPDATE controller_leases SET expires_at=? WHERE name=? AND holder=? AND fence=?",
        expiresAt,
        name,
        holder,
        current.fence,
      );
      return renewed.changes > 0 ? { fence: current.fence } : null;
    }
    if (live) return null;
    const taken = database.run(
      "UPDATE controller_leases SET holder=?,fence=?,acquired_at=?,expires_at=? WHERE name=? AND fence=?",
      holder,
      current.fence + 1,
      iso(nowMs),
      expiresAt,
      name,
      current.fence,
    );
    return taken.changes > 0 ? { fence: current.fence + 1 } : null;
  });
}

/** Extends the lease only while the caller still holds it under `fence`; false means it was lost. */
export function renewLease(
  database: PersistenceDatabase,
  name: string,
  holder: string,
  fence: number,
  ttlMs: number,
  nowMs: number = databaseClock(database),
): boolean {
  return atomically(
    database,
    () =>
      database.run(
        "UPDATE controller_leases SET expires_at=? WHERE name=? AND holder=? AND fence=?",
        iso(nowMs + ttlMs),
        name,
        holder,
        fence,
      ).changes > 0,
  );
}

/**
 * Gives the lease up at once so another controller can take over without waiting for the expiry. The
 * row is kept (expired) so the next holder's fence still exceeds this one's.
 */
export function releaseLease(
  database: PersistenceDatabase,
  name: string,
  holder: string,
  fence: number,
): void {
  atomically(database, () =>
    database.run(
      "UPDATE controller_leases SET expires_at=? WHERE name=? AND holder=? AND fence=?",
      iso(0),
      name,
      holder,
      fence,
    ),
  );
}

/** Releases every unexpired lease `holder` owns; a stopping controller calls it once. */
export function releaseLeasesHeldBy(
  database: PersistenceDatabase,
  holder: string,
  nowMs: number = databaseClock(database),
): number {
  return atomically(
    database,
    () =>
      database.run(
        "UPDATE controller_leases SET expires_at=? WHERE holder=? AND expires_at>?",
        iso(0),
        holder,
        iso(nowMs),
      ).changes,
  );
}

/**
 * Throws `LeaseLostError` unless `holder` still owns `name` under `fence`. A write that must not
 * happen after a takeover calls this in its own transaction, so the check and the write are atomic.
 */
export function assertLease(
  database: PersistenceDatabase,
  name: string,
  holder: string,
  fence: number,
): void {
  const current = readLease(database, name);
  if (!current || current.holder !== holder || current.fence !== fence)
    throw new LeaseLostError(name);
}
