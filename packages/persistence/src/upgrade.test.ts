import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { loadMigrations, PersistenceDatabase } from "./database.js";
import {
  LAST_UPGRADE_KEY,
  planDatabaseUpgrade,
  REVOKED_IMAGE_PREFIX,
  upgradeDatabase,
} from "./upgrade.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
function versionOf(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.v);
  } finally {
    db.close();
  }
}
/** A data directory created by an older release: only the first `count` migrations exist. */
async function legacyDatabase(count: number) {
  const root = await mkdtemp(join(tmpdir(), "tm-upgrade-"));
  roots.push(root);
  const all = await loadMigrations();
  const legacy = join(root, "release-old");
  await mkdir(legacy);
  for (const migration of all.slice(0, count))
    await writeFile(
      join(legacy, `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`),
      migration.sql,
    );
  const dataDir = join(root, "data");
  const path = join(dataDir, "testmaster.db");
  const db = await PersistenceDatabase.open(path, { migrationsDir: legacy });
  db.run("INSERT INTO operational_state(key,value) VALUES('user:state','keep-me')");
  db.run(
    "INSERT INTO workspaces(workspace_id,id,created_at,name,mode) VALUES('ws','ws',?,'w','single-user')",
    new Date().toISOString(),
  );
  return { root, legacy, dataDir, path, db, all };
}

it("plans irreversible pending migrations read-only and refuses a newer schema with restore guidance", async () => {
  const { root, legacy, path, db, all } = await legacyDatabase((await loadMigrations()).length - 1);
  db.close();
  const before = await readFile(path);
  const plan = await planDatabaseUpgrade(path);
  expect(plan).toMatchObject({
    compatible: true,
    currentVersion: all.length - 1,
    supportedVersion: all.length,
    irreversible: true,
    rollbackAfterUpgrade: "restore-required",
  });
  expect(plan.pending.map((migration) => migration.version)).toEqual([all.length]);
  expect(plan.warnings.join(" ")).toContain(`Irreversible migration ${all.length}_`);
  expect(plan.warnings.join(" ")).toContain("restoring the pre-upgrade backup");
  expect(await readFile(path)).toEqual(before);
  expect(versionOf(path)).toBe(all.length - 1);

  // Control: a database already at the release version has nothing pending and no warning.
  const current = await planDatabaseUpgrade(path, legacy);
  expect(current).toMatchObject({ pending: [], irreversible: false, warnings: [] });

  // Negative: the old release meets a database upgraded by the newer one.
  const upgraded = await upgradeDatabase(path, {
    backupDir: join(root, "backup"),
    drainTimeoutMs: 0,
  });
  expect(upgraded.upgraded).toBe(true);
  const newer = await planDatabaseUpgrade(path, legacy);
  expect(newer).toMatchObject({ compatible: false, pending: [] });
  expect(newer.refusal).toContain("newer than this release supports");
  expect(newer.warnings.join(" ")).toContain("testmaster backup restore");
  await expect(
    upgradeDatabase(path, { backupDir: join(root, "second"), migrationsDir: legacy }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  expect(await exists(join(root, "second"))).toBe(false);
  expect(versionOf(path)).toBe(all.length);
});

it("upgrades in order: preflight, drain, backup of the old schema, migrate, readiness", async () => {
  // The previous release stops before migration 9 (delivery_requeue), which rewrites a trigger;
  // `all` is the release under test through that migration and `shipped` includes later no-op ones.
  const { root, path, db, all: shipped } = await legacyDatabase(8);
  const all = shipped.slice(0, 9);
  db.run(
    "INSERT INTO workers(workspace_id,id,created_at,state,last_heartbeat_at) VALUES('ws','wrk-old',?, 'ready',?)",
    new Date().toISOString(),
    new Date(Date.now() - 3600_000).toISOString(),
  );
  db.close();
  const backupDir = join(root, "backups", "before-upgrade");
  const receipt = await upgradeDatabase(path, { backupDir, drainTimeoutMs: 0 });
  expect(receipt.steps.map((step) => step.step)).toEqual([
    "preflight",
    "drain",
    "backup",
    "migrate",
    "readiness",
    "resume",
  ]);
  const times = receipt.steps.map((step) => step.at);
  expect([...times].sort()).toEqual(times);
  expect(receipt).toMatchObject({
    upgraded: true,
    fromVersion: all.length - 1,
    toVersion: shipped.length,
    irreversible: true,
    rollbackPlan: { appRollback: "restore-required", restoreFrom: backupDir },
  });
  expect(receipt.rollbackPlan.command).toContain(backupDir);
  expect(receipt.backup).toMatchObject({ databaseVersion: all.length - 1, evidenceComplete: true });

  // The backup is the pre-migration schema; the live database is migrated and keeps its state.
  const manifest = JSON.parse(await readFile(join(backupDir, "manifest.json"), "utf8"));
  expect(manifest.databaseVersion).toBe(all.length - 1);
  expect(versionOf(join(backupDir, "testmaster.db"))).toBe(all.length - 1);
  const snapshot = new DatabaseSync(join(backupDir, "testmaster.db"), { readOnly: true });
  expect(
    String(
      snapshot.prepare("SELECT sql FROM sqlite_master WHERE name='deliveries_frozen_subject'").get()
        ?.sql,
    ),
  ).toContain("OLD.state IN ('delivered','dead_letter')");
  snapshot.close();
  const live = await PersistenceDatabase.open(path, { migrate: false });
  try {
    expect(live.status()).toMatchObject({ currentVersion: shipped.length, pending: [] });
    expect(
      String(live.get("SELECT sql FROM sqlite_master WHERE name='deliveries_frozen_subject'")?.sql),
    ).toContain("OLD.state='dead_letter' AND NEW.state<>'pending'");
    expect(live.get("SELECT value FROM operational_state WHERE key='user:state'")?.value).toBe(
      "keep-me",
    );
    expect(live.get("SELECT state FROM workers WHERE id='wrk-old'")?.state).toBe("draining");
    expect(
      JSON.parse(
        String(
          live.get("SELECT value FROM operational_state WHERE key=?", LAST_UPGRADE_KEY)?.value,
        ),
      ),
    ).toMatchObject({ fromVersion: all.length - 1, toVersion: shipped.length, backup: backupDir });
  } finally {
    live.close();
  }
});

it("stops before backup and migration while work is in flight, then upgrades once drained", async () => {
  const { root, path, db, all } = await legacyDatabase((await loadMigrations()).length - 1);
  db.run(
    "INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,state,available_at,lease_owner,lease_expires_at,fence) VALUES('ws','job-1',?,'local','run-1','leased',?,'owner',?,1)",
    new Date().toISOString(),
    new Date().toISOString(),
    new Date(Date.now() + 60_000).toISOString(),
  );
  db.close();
  const backupDir = join(root, "backup");
  await expect(
    upgradeDatabase(path, { backupDir, drainTimeoutMs: 100, pollIntervalMs: 10 }),
  ).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
    details: { blockers: [expect.stringContaining("leased job")] },
  });
  expect(versionOf(path)).toBe(all.length - 1);
  expect(await exists(backupDir)).toBe(false);

  const reopened = await PersistenceDatabase.open(path, {
    migrate: false,
    migrationsDir: join(root, "release-old"),
  });
  reopened.run("UPDATE job_leases SET state='completed',lease_owner=NULL,lease_expires_at=NULL");
  reopened.close();
  expect((await upgradeDatabase(path, { backupDir, drainTimeoutMs: 100 })).upgraded).toBe(true);
  expect(versionOf(path)).toBe(all.length);
});

it("does not migrate when the pre-upgrade backup cannot be written", async () => {
  const { root, path, db, all } = await legacyDatabase((await loadMigrations()).length - 1);
  db.close();
  const backupDir = join(root, "occupied");
  await mkdir(backupDir);
  await expect(upgradeDatabase(path, { backupDir, drainTimeoutMs: 0 })).rejects.toMatchObject({
    code: "EEXIST",
  });
  expect(versionOf(path)).toBe(all.length - 1);
});

it("reports durable image revocations from the database without modifying it", async () => {
  const { path, db } = await legacyDatabase((await loadMigrations()).length);
  const imageId = `sha256:${"a".repeat(64)}`;
  db.run(
    "INSERT INTO operational_state(key,value) VALUES(?,?)",
    `${REVOKED_IMAGE_PREFIX}${imageId}`,
    "{}",
  );
  db.close();
  expect((await planDatabaseUpgrade(path)).revokedImageIds).toEqual([imageId]);
});

it("restores the pre-upgrade backup at its own schema so the older release can open it", async () => {
  const { root, legacy, path, db, all } = await legacyDatabase((await loadMigrations()).length - 1);
  db.close();
  const backupDir = join(root, "backup");
  await upgradeDatabase(path, { backupDir, drainTimeoutMs: 0 });

  // The older release cannot open the upgraded database...
  await expect(
    PersistenceDatabase.open(path, { migrationsDir: legacy, migrate: false }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  // ...a default restore migrates forward and so is no rollback point...
  const forward = await PersistenceDatabase.restore(backupDir, join(root, "restore-forward"));
  expect(forward.database.status().currentVersion).toBe(all.length);
  forward.database.close();
  // ...while --keep-schema keeps the backup's version and the older release opens it unchanged.
  const kept = await PersistenceDatabase.restore(backupDir, join(root, "restore-kept"), {
    keepSchema: true,
  });
  kept.database.close();
  const older = await PersistenceDatabase.open(join(root, "restore-kept", "testmaster.db"), {
    migrationsDir: legacy,
  });
  try {
    expect(older.status()).toMatchObject({ currentVersion: all.length - 1, pending: [] });
    expect(older.get("SELECT value FROM operational_state WHERE key='user:state'")?.value).toBe(
      "keep-me",
    );
    expect(older.get("SELECT value FROM operational_state WHERE key='admission'")?.value).toBe(
      "suspended_restore",
    );
  } finally {
    older.close();
  }
});
