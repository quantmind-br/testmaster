import { randomUUID } from "node:crypto";
import type { PersistenceDatabase } from "@testmaster/persistence";
import { databaseClock, releaseLeasesHeldBy } from "./controller-leases.js";

/** A controller refreshes its row this often; the leader election renews at a third of its TTL. */
export const CONTROLLER_HEARTBEAT_MS = 10_000;
/** A controller is live while its heartbeat is newer than this and it has not stopped. */
export const CONTROLLER_LIVE_MS = 30_000;
/** Rows of controllers that stopped or went silent are kept this long for diagnosis, then pruned. */
export const CONTROLLER_RETENTION_MS = 7 * 86_400_000;
/**
 * The internal origin of a controller that was not given one (a single-controller deployment or a
 * local profile): it names no reachable host, so forwarding never picks it.
 */
export const NO_INTERNAL_ORIGIN = "urn:testmaster:no-internal-origin";

export interface ControllerOptions {
  /** Bare http(s) origin other controllers reach this process at; forwarding uses it (ADR-035). */
  internalOrigin?: string;
  /** Live controllers an operator expects; fewer raises `controllers_below_expected`. Unset keeps that alert off. */
  expectedControllers?: number;
}

/** Who this process is among the controllers sharing a database; generated per process start. */
export interface ControllerIdentity {
  readonly id: string;
  readonly internalOrigin: string;
  /** Live controllers the deployment is configured to run; null when it states none (the alert stays off). */
  readonly expected: number | null;
}

export function newControllerIdentity(options: ControllerOptions = {}): ControllerIdentity {
  return {
    id: `ctl_${randomUUID()}`,
    internalOrigin: options.internalOrigin ?? NO_INTERNAL_ORIGIN,
    expected: options.expectedControllers ?? null,
  };
}

export interface ControllerInstance {
  id: string;
  internalOrigin: string;
  startedAt: string;
  heartbeatAt: string;
  stoppedAt: string | null;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Records this process as a controller; a repeated call refreshes the heartbeat instead of failing. */
export function registerController(
  database: PersistenceDatabase,
  identity: ControllerIdentity,
  nowMs: number = databaseClock(database),
): void {
  database.run(
    "INSERT INTO controller_instances(id,internal_origin,started_at,heartbeat_at,stopped_at) VALUES(?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at,stopped_at=NULL",
    identity.id,
    identity.internalOrigin,
    iso(nowMs),
    iso(nowMs),
  );
}

/** Refreshes the heartbeat; false when the row is gone or already stopped, so the caller registers again. */
export function heartbeatController(
  database: PersistenceDatabase,
  id: string,
  nowMs: number = databaseClock(database),
): boolean {
  return (
    database.run(
      "UPDATE controller_instances SET heartbeat_at=? WHERE id=? AND stopped_at IS NULL",
      iso(nowMs),
      id,
    ).changes > 0
  );
}

/** Releases every lease the controller holds and marks it stopped, so a survivor takes over at once. */
export function stopController(
  database: PersistenceDatabase,
  id: string,
  nowMs: number = databaseClock(database),
): void {
  const stop = () => {
    releaseLeasesHeldBy(database, id, nowMs);
    database.run(
      "UPDATE controller_instances SET stopped_at=? WHERE id=? AND stopped_at IS NULL",
      iso(nowMs),
      id,
    );
  };
  if (database.inTransaction) stop();
  else database.withTx(stop);
}

/** Controllers with a recent heartbeat that have not stopped, oldest first. */
export function liveControllers(
  database: PersistenceDatabase,
  nowMs: number = databaseClock(database),
): ControllerInstance[] {
  return database
    .all(
      "SELECT id,internal_origin,started_at,heartbeat_at,stopped_at FROM controller_instances WHERE stopped_at IS NULL AND heartbeat_at>? ORDER BY started_at,id",
      iso(nowMs - CONTROLLER_LIVE_MS),
    )
    .map((row) => ({
      id: String(row.id),
      internalOrigin: String(row.internal_origin),
      startedAt: String(row.started_at),
      heartbeatAt: String(row.heartbeat_at),
      stoppedAt: row.stopped_at === null ? null : String(row.stopped_at),
    }));
}

/** Metric windows older than the SLO window are of no use to any report. */
const METRICS_RETENTION_MS = 30 * 86_400_000;

/**
 * Deletes expired proof nonces, metric windows past the SLO window and every row of controllers that
 * stopped (or went silent) more than a retention period ago; returns the rows removed per table.
 */
export function pruneControllerState(
  database: PersistenceDatabase,
  nowMs: number = databaseClock(database),
): { nonces: number; metrics: number; controllers: number } {
  const forgotten = iso(nowMs - CONTROLLER_RETENTION_MS);
  const prune = () => ({
    nonces: database.run("DELETE FROM worker_proof_nonces WHERE expires_at<=?", iso(nowMs)).changes,
    metrics: database.run(
      "DELETE FROM controller_metrics WHERE window_start<? OR controller_id IN (SELECT id FROM controller_instances WHERE heartbeat_at<?)",
      iso(nowMs - METRICS_RETENTION_MS),
      forgotten,
    ).changes,
    controllers: database.run("DELETE FROM controller_instances WHERE heartbeat_at<?", forgotten)
      .changes,
  });
  return database.inTransaction ? prune() : database.withTx(prune);
}

/** One controller if it is live, otherwise null; forwarding to a controller that is not live is refused. */
export function liveController(
  database: PersistenceDatabase,
  id: string,
  nowMs: number = databaseClock(database),
): ControllerInstance | null {
  return liveControllers(database, nowMs).find((controller) => controller.id === id) ?? null;
}
