import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  constraintSeed,
  revisionInsert as insertRevision,
  statementOutcome as reject,
} from "./constraint-fixtures.js";
import { loadMigrations, PersistenceDatabase } from "./database.js";
import { postgresParity } from "./testing/postgres.js";
import { upgradeDatabase } from "./upgrade.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const at = "2026-10-05T00:00:00.000Z";
const revisions = (db: PersistenceDatabase) =>
  db.all("SELECT * FROM test_revisions ORDER BY workspace_id,id");
const dependents = (db: PersistenceDatabase) =>
  ["runs", "snapshots", "artifacts"].map((table) => db.all(`SELECT * FROM ${table} ORDER BY id`));

/** A data directory written by the release before 0022, with one revision of each old runner kind. */
async function releaseBeforeTerminal() {
  const root = await mkdtemp(join(tmpdir(), "tm-terminal-migration-"));
  roots.push(root);
  const all = await loadMigrations();
  expect(all.find((migration) => migration.version === 22)?.name).toBe("terminal_runner");
  const legacyDir = join(root, "release-before-terminal");
  await mkdir(legacyDir);
  for (const migration of all.filter((candidate) => candidate.version < 22))
    await writeFile(
      join(legacyDir, `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`),
      migration.sql,
    );
  const dataDir = join(root, "data");
  const path = join(dataDir, "testmaster.db");
  const old = await PersistenceDatabase.open(path, { migrationsDir: legacyDir });
  expect(old.status().currentVersion).toBe(21);
  old.withTx(() => {
    for (const sql of constraintSeed) old.exec(sql);
    old.exec(insertRevision("rev-pw", 2, "playwright", "rev-a"));
    old.exec(insertRevision("rev-py", 3, "python", "rev-pw"));
  });
  old.run(
    "INSERT INTO artifacts(workspace_id,id,created_at,run_id,attempt_id,revision_id,snapshot_id,bytes,storage_key,state,redaction_status,hash) VALUES('ws-a','art-a',?,'run-a','att-a','rev-a','snp-a',1,'k','available','not_applicable','h')",
    at,
  );
  // The seeded work has finished, so the in-place upgrade's drain step has nothing to wait for.
  old.run("UPDATE attempts SET phase='completed'");
  return { root, legacyDir, path, old, all };
}

// Not run on PostgreSQL: Opens a legacy SQLite data directory by path and upgrades it in place;
// terminal-runner.pg.test.ts runs the same real migration chain on PostgreSQL.
it.skipIf(postgresParity)(
  "migration 0022 rebuilds test_revisions keeping every row, reference and immutability, and admits terminal",
  async () => {
    const { path, old } = await releaseBeforeTerminal();
    const before = revisions(old);
    const referencing = dependents(old);
    expect(before.map((row) => row.runner_kind)).toEqual(["http", "playwright", "python"]);
    // Control: the previous schema refuses the new runner kind.
    expect(reject(old, insertRevision("rev-early", 4, "terminal", "rev-py"))).toBe("check");
    old.close();

    const db = await PersistenceDatabase.open(path);
    try {
      expect(db.status()).toMatchObject({ currentVersion: 22, pending: [] });
      expect(revisions(db)).toEqual(before);
      expect(dependents(db)).toEqual(referencing);
      expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
      expect(db.get("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
      expect(reject(db, insertRevision("rev-term", 4, "terminal", "rev-py"))).toBe("accepted");
      expect(db.get("SELECT runner_kind FROM test_revisions WHERE id='rev-term'")).toEqual({
        runner_kind: "terminal",
      });
      expect(reject(db, insertRevision("rev-shell", 5, "shell", "rev-py"))).toBe("check");
      // The rebuilt table is still the target of its dependents and of its own parent link.
      const run = (id: string, revision: string) =>
        `INSERT INTO runs(workspace_id,id,created_at,test_id,revision_id,environment_revision_id,mode,phase,status,gate,cleanup_outcome,analysis_status) VALUES('ws-a','${id}','${at}','tst-a','${revision}','evr-a','replay','queued','queued','pending','not_required','not_requested')`;
      expect(reject(db, run("run-term", "rev-term"))).toBe("accepted");
      expect(reject(db, run("run-dangling", "rev-missing"))).toBe("foreign_key");
      expect(reject(db, insertRevision("rev-orphan", 6, "http", "rev-missing"))).toBe(
        "foreign_key",
      );
      // Revisions stay immutable: no update, no delete, for old and new kinds alike.
      for (const id of ["rev-a", "rev-term"]) {
        expect(reject(db, `UPDATE test_revisions SET content_hash='tamper' WHERE id='${id}'`)).toBe(
          "check",
        );
        expect(reject(db, `DELETE FROM test_revisions WHERE id='${id}'`)).toBe("check");
      }
      expect(revisions(db)).toHaveLength(4);
    } finally {
      db.close();
    }
  },
);

// Not run on PostgreSQL: Backs up and restores a SQLite data directory through the in-place upgrade;
// PostgreSQL upgrades go through db migrate (terminal-runner.pg.test.ts).
it.skipIf(postgresParity)(
  "restores a pre-0022 backup at its own schema or forward into the terminal schema without altering any revision",
  async () => {
    const { root, path, old, legacyDir } = await releaseBeforeTerminal();
    const before = revisions(old);
    old.close();
    const backupDir = join(root, "backup");
    const receipt = await upgradeDatabase(path, { backupDir, drainTimeoutMs: 0 });
    expect(receipt).toMatchObject({ upgraded: true, fromVersion: 21, toVersion: 22 });

    const kept = await PersistenceDatabase.restore(backupDir, join(root, "restore-kept"), {
      keepSchema: true,
    });
    try {
      expect(kept.database.status().currentVersion).toBe(21);
      expect(revisions(kept.database)).toEqual(before);
      expect(reject(kept.database, insertRevision("rev-term", 4, "terminal", "rev-py"))).toBe(
        "check",
      );
    } finally {
      kept.database.close();
    }
    // The previous release opens the kept restore; it cannot open the upgraded live database.
    const older = await PersistenceDatabase.open(join(root, "restore-kept", "testmaster.db"), {
      migrationsDir: legacyDir,
      migrate: false,
    });
    older.close();
    await expect(
      PersistenceDatabase.open(path, { migrationsDir: legacyDir, migrate: false }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const forward = await PersistenceDatabase.restore(backupDir, join(root, "restore-forward"));
    try {
      expect(forward.database.status()).toMatchObject({ currentVersion: 22, pending: [] });
      expect(revisions(forward.database)).toEqual(before);
      expect(forward.database.all("PRAGMA foreign_key_check")).toEqual([]);
      expect(reject(forward.database, insertRevision("rev-term", 4, "terminal", "rev-py"))).toBe(
        "accepted",
      );
    } finally {
      forward.database.close();
    }
  },
);
