import { lstat, mkdir, readFile, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { ContractError } from "@testmaster/contracts";
import {
  type BackupManifest,
  loadMigrations,
  type Migration,
  PersistenceDatabase,
} from "./database.js";

/** `operational_state` key prefix of durable image revocations (never removed by restore or rollback). */
export const REVOKED_IMAGE_PREFIX = "image:revoked:";
/** Last completed upgrade record; read by operators to find the pre-upgrade backup and rollback rule. */
export const LAST_UPGRADE_KEY = "upgrade:last";
const WORKER_HEARTBEAT_WINDOW_MS = 30000;
/** Operator guidance appended to every refusal caused by an incompatible schema. */
export const RESTORE_GUIDANCE =
  "Application rollback is not allowed. Stop the service, restore the pre-upgrade backup into an isolated directory (`testmaster backup restore <backup> --out <isolated-dir> --keep-schema`, run by the current release), point the older release at that directory and follow the restore review procedure.";

export interface PendingMigration {
  version: number;
  name: string;
  checksum: string;
  /** Every shipped migration is forward-only; no down migration exists. */
  irreversible: true;
}
export interface DatabaseUpgradePlan {
  databasePath: string;
  databaseExists: boolean;
  currentVersion: number;
  supportedVersion: number;
  compatible: boolean;
  /** Why this release cannot open the database (newer schema, checksum mismatch); null when compatible. */
  refusal: string | null;
  pending: PendingMigration[];
  irreversible: boolean;
  /** After applying `pending`, an older application can no longer open the database. */
  rollbackAfterUpgrade: "not-applicable" | "restore-required";
  revokedImageIds: string[];
  warnings: string[];
}
export interface UpgradeStep {
  step: "preflight" | "drain" | "backup" | "migrate" | "readiness" | "resume";
  at: string;
  detail: Record<string, unknown>;
}
export interface UpgradeReceipt {
  upgraded: boolean;
  fromVersion: number;
  toVersion: number;
  steps: UpgradeStep[];
  backup: { path: string; databaseVersion: number; evidenceComplete: boolean } | null;
  irreversible: boolean;
  rollbackPlan: {
    appRollback: "not-applicable" | "restore-required";
    restoreFrom: string | null;
    command: string | null;
  };
  warnings: string[];
}
export interface UpgradeOptions {
  /** Directory created for the pre-migration backup; must not exist. */
  backupDir: string;
  /** Root holding `runs/` and `fixture-inputs/`; defaults to the database directory. */
  evidenceRoot?: string;
  migrationsDir?: string;
  /** Maximum time to wait for in-flight work (default 60 s, the worker drain window). */
  drainTimeoutMs?: number;
  pollIntervalMs?: number;
}

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new ContractError("PRECONDITION_FAILED", message, details);
}
function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
const toPending = (migration: Migration): PendingMigration => ({
  version: migration.version,
  name: migration.name,
  checksum: migration.checksum,
  irreversible: true,
});
function compare(
  rows: { version: number; name: string; checksum: string }[],
  available: Migration[],
): string | null {
  for (const [index, row] of rows.entries()) {
    const migration = available[row.version - 1];
    if (!migration || row.version !== index + 1)
      return `Database schema version ${row.version} is newer than this release supports (${available.length}).`;
    if (migration.name !== row.name || migration.checksum !== row.checksum)
      return `Applied migration ${row.version} (${row.name}) does not match this release's checksum.`;
  }
  return null;
}

/** Read-only inspection: never creates, migrates, locks for writing or otherwise mutates the database. */
export async function planDatabaseUpgrade(
  databasePath: string,
  migrationsDir?: string,
): Promise<DatabaseUpgradePlan> {
  const path = resolve(databasePath);
  const available = await loadMigrations("sqlite", migrationsDir);
  const base = {
    databasePath: path,
    supportedVersion: available.length,
    revokedImageIds: [] as string[],
  };
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const pending = available.map(toPending);
    return {
      ...base,
      databaseExists: false,
      currentVersion: 0,
      compatible: true,
      refusal: null,
      pending,
      irreversible: false,
      rollbackAfterUpgrade: "not-applicable",
      warnings: [],
    };
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = tableExists(db, "schema_migrations")
      ? (db
          .prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version")
          .all() as { version: number; name: string; checksum: string }[])
      : [];
    const refusal = compare(rows, available);
    const currentVersion = rows.at(-1)?.version ?? 0;
    const revokedImageIds = tableExists(db, "operational_state")
      ? (
          db
            .prepare("SELECT key FROM operational_state WHERE key LIKE ? ORDER BY key")
            .all(`${REVOKED_IMAGE_PREFIX}%`) as { key: string }[]
        ).map((row) => row.key.slice(REVOKED_IMAGE_PREFIX.length))
      : [];
    const pending = refusal ? [] : available.slice(currentVersion).map(toPending);
    const warnings: string[] = [];
    if (refusal) warnings.push(`${refusal} ${RESTORE_GUIDANCE}`);
    // Only an existing database that would be migrated forward loses application rollback.
    const irreversible = pending.length > 0 && currentVersion > 0;
    if (irreversible)
      warnings.push(
        `Irreversible migration${pending.length > 1 ? "s" : ""} ${pending
          .map((migration) => `${migration.version}_${migration.name}`)
          .join(
            ", ",
          )}: after applying, the previous application cannot open this database; rollback requires restoring the pre-upgrade backup.`,
      );
    return {
      ...base,
      databaseExists: true,
      currentVersion,
      compatible: refusal === null,
      refusal,
      pending,
      irreversible,
      rollbackAfterUpgrade: irreversible ? "restore-required" : "not-applicable",
      revokedImageIds,
      warnings,
    };
  } finally {
    db.close();
  }
}

function blockers(database: PersistenceDatabase): string[] {
  const result: string[] = [];
  const since = new Date(Date.now() - WORKER_HEARTBEAT_WINDOW_MS).toISOString();
  const workers = Number(
    database.get(
      "SELECT COUNT(*) AS n FROM workers WHERE state IN ('ready','draining') AND last_heartbeat_at>?",
      since,
    )?.n,
  );
  if (workers) result.push(`${workers} worker(s) still heartbeating; stop the controller`);
  const leased = Number(
    database.get("SELECT COUNT(*) AS n FROM job_leases WHERE state='leased'")?.n,
  );
  if (leased) result.push(`${leased} leased job(s) in flight; wait or run worker reconcile`);
  const attempts = Number(
    database.get("SELECT COUNT(*) AS n FROM attempts WHERE phase<>'completed'")?.n,
  );
  if (attempts) result.push(`${attempts} attempt(s) not completed`);
  return result;
}

/**
 * Ordered, offline, local-profile upgrade: preflight (read-only) → drain → backup → migrate →
 * readiness. Each refusal happens before any later step, so a failed preflight leaves the data
 * untouched and a failed drain leaves schema and data unmigrated.
 */
export async function upgradeDatabase(
  databasePath: string,
  options: UpgradeOptions,
): Promise<UpgradeReceipt> {
  const path = resolve(databasePath);
  const steps: UpgradeStep[] = [];
  const record = (step: UpgradeStep["step"], detail: Record<string, unknown>) =>
    steps.push({ step, at: new Date().toISOString(), detail });
  const plan = await planDatabaseUpgrade(path, options.migrationsDir);
  if (!plan.databaseExists) fail("No TestMaster database to upgrade", { databasePath: path });
  if (!plan.compatible)
    fail(`${plan.refusal} ${RESTORE_GUIDANCE}`, {
      databaseVersion: plan.currentVersion,
      supportedVersion: plan.supportedVersion,
    });
  const toVersion = plan.supportedVersion;
  const idle: UpgradeReceipt = {
    upgraded: false,
    fromVersion: plan.currentVersion,
    toVersion: plan.currentVersion,
    steps,
    backup: null,
    irreversible: false,
    rollbackPlan: { appRollback: "not-applicable", restoreFrom: null, command: null },
    warnings: [],
  };
  if (!plan.pending.length) {
    record("preflight", { pending: [], note: "database already at the supported version" });
    return idle;
  }
  const size = Number((await lstat(path)).size);
  const filesystem = await statfs(dirname(path));
  const free = Number(filesystem.bavail) * Number(filesystem.bsize);
  if (free < size * 2)
    fail("Insufficient free space for a pre-upgrade backup and the migration workspace", {
      freeBytes: free,
      requiredBytes: size * 2,
    });
  record("preflight", {
    fromVersion: plan.currentVersion,
    toVersion,
    pending: plan.pending.map((migration) => migration.version),
    irreversible: plan.irreversible,
    warnings: plan.warnings,
    freeBytes: free,
  });

  const database = await PersistenceDatabase.open(path, {
    migrate: false,
    ...(options.migrationsDir ? { migrationsDir: options.migrationsDir } : {}),
  });
  try {
    // Drain: request every ready worker to stop claiming, then wait for in-flight work to finish.
    database.withTx(() => database.run("UPDATE workers SET state='draining' WHERE state='ready'"));
    const deadline = Date.now() + (options.drainTimeoutMs ?? 60000);
    let remaining = blockers(database);
    while (remaining.length && Date.now() < deadline) {
      await sleep(options.pollIntervalMs ?? 250);
      remaining = blockers(database);
    }
    if (remaining.length)
      fail("Drain incomplete; the database was not backed up or migrated", { blockers: remaining });
    record("drain", { blockers: [] });

    const backupDir = resolve(options.backupDir);
    await mkdir(dirname(backupDir), { recursive: true, mode: 0o700 });
    const manifest: BackupManifest = await database.backup(backupDir, {
      evidenceRoot: options.evidenceRoot ?? dirname(path),
    });
    const index = JSON.parse(await readFile(join(backupDir, "evidence-index.json"), "utf8")) as {
      complete: boolean;
      missingObjects: string[];
    };
    if (manifest.databaseVersion !== plan.currentVersion)
      fail("Pre-upgrade backup does not match the database schema; the database was not migrated", {
        backupDatabaseVersion: manifest.databaseVersion,
      });
    // Expired or unavailable evidence is reported, as `backup create` does, never hidden.
    const warnings = [...plan.warnings];
    if (!index.complete)
      warnings.push(
        `The pre-upgrade backup's evidence index is incomplete (${index.missingObjects.length} expired or missing object(s)); a restore will not contain them.`,
      );
    record("backup", {
      path: backupDir,
      databaseVersion: manifest.databaseVersion,
      evidenceComplete: index.complete,
    });

    await database.migrate(options.migrationsDir);
    record("migrate", { applied: plan.pending.map((migration) => migration.version) });

    const status = database.status();
    const problems: string[] = [];
    if (database.get("PRAGMA integrity_check")?.integrity_check !== "ok")
      problems.push("integrity_check failed");
    if (database.all("PRAGMA foreign_key_check").length) problems.push("foreign_key_check failed");
    if (status.pending.length || status.currentVersion !== toVersion)
      problems.push("migrations pending after upgrade");
    if (problems.length)
      fail(
        `Post-upgrade readiness failed (${problems.join(", ")}). Restore ${backupDir} into an isolated directory.`,
        { problems, backup: backupDir },
      );
    const restoreCommand = `testmaster backup restore ${backupDir} --out <isolated-dir> --keep-schema`;
    const receipt: UpgradeReceipt = {
      upgraded: true,
      fromVersion: plan.currentVersion,
      toVersion,
      steps,
      backup: {
        path: backupDir,
        databaseVersion: manifest.databaseVersion,
        evidenceComplete: index.complete,
      },
      irreversible: plan.irreversible,
      rollbackPlan: {
        appRollback: "restore-required",
        restoreFrom: backupDir,
        command: restoreCommand,
      },
      warnings,
    };
    database.withTx(() =>
      database.run(
        "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        LAST_UPGRADE_KEY,
        JSON.stringify({
          fromVersion: receipt.fromVersion,
          toVersion,
          backup: backupDir,
          completedAt: new Date().toISOString(),
          migrations: plan.pending.map((migration) => `${migration.version}_${migration.name}`),
        }),
      ),
    );
    record("readiness", { currentVersion: status.currentVersion, integrity: "ok" });
    record("resume", {
      note: "Workers stay drained until the controller is started; each start registers a fresh worker and checks images, handshake and authenticated readiness.",
    });
    return receipt;
  } finally {
    database.close();
  }
}
