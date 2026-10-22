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

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const at = "2026-10-22T00:00:00.000Z";
const revisions = (db: PersistenceDatabase) =>
  db.all("SELECT * FROM test_revisions ORDER BY workspace_id,id");
const dependents = (db: PersistenceDatabase) =>
  ["runs", "snapshots", "artifacts"].map((table) => db.all(`SELECT * FROM ${table} ORDER BY id`));

// Not run on PostgreSQL: Opens a legacy SQLite data directory by path and upgrades it in place;
// probe-runner.pg.test.ts runs the same real migration chain on PostgreSQL.
it.skipIf(postgresParity)(
  "REQ-050 migration 0027 rebuilds test_revisions keeping every row and reference, and admits probe revisions",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "tm-probe-migration-"));
    roots.push(root);
    const all = await loadMigrations();
    expect(all.find((migration) => migration.version === 27)?.name).toBe("probe_runner");
    const legacyDir = join(root, "release-before-probe");
    await mkdir(legacyDir);
    for (const migration of all.filter((candidate) => candidate.version < 27))
      await writeFile(
        join(legacyDir, `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`),
        migration.sql,
      );
    const path = join(root, "data", "testmaster.db");
    const old = await PersistenceDatabase.open(path, { migrationsDir: legacyDir });
    expect(old.status().currentVersion).toBe(26);
    old.withTx(() => {
      for (const sql of constraintSeed) old.exec(sql);
      old.exec(insertRevision("rev-pw", 2, "playwright", "rev-a"));
      old.exec(insertRevision("rev-py", 3, "python", "rev-pw"));
      old.exec(insertRevision("rev-term", 4, "terminal", "rev-py"));
    });
    old.run(
      "INSERT INTO artifacts(workspace_id,id,created_at,run_id,attempt_id,revision_id,snapshot_id,bytes,storage_key,state,redaction_status,hash) VALUES('ws-a','art-a',?,'run-a','att-a','rev-a','snp-a',1,'k','available','not_applicable','h')",
      at,
    );
    const before = revisions(old);
    const referencing = dependents(old);
    expect(before.map((row) => row.runner_kind)).toEqual([
      "http",
      "playwright",
      "python",
      "terminal",
    ]);
    // Control: the previous schema refuses the new runner kind.
    expect(reject(old, insertRevision("rev-early", 5, "probe", "rev-term"))).toBe("check");
    old.close();

    const db = await PersistenceDatabase.open(path);
    try {
      expect(db.status()).toMatchObject({ currentVersion: all.length, pending: [] });
      expect(revisions(db)).toEqual(before);
      expect(dependents(db)).toEqual(referencing);
      expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
      expect(reject(db, insertRevision("rev-probe", 5, "probe", null))).toBe("accepted");
      expect(reject(db, insertRevision("rev-shell", 6, "shell", "rev-term"))).toBe("check");
      const run = (id: string, revision: string) =>
        `INSERT INTO runs(workspace_id,id,created_at,test_id,revision_id,environment_revision_id,mode,phase,status,gate,cleanup_outcome,analysis_status) VALUES('ws-a','${id}','${at}','tst-a','${revision}','evr-a','replay','queued','queued','pending','not_required','not_requested')`;
      expect(reject(db, run("run-probe", "rev-probe"))).toBe("accepted");
      expect(reject(db, run("run-dangling", "rev-missing"))).toBe("foreign_key");
      for (const id of ["rev-a", "rev-probe"]) {
        expect(reject(db, `UPDATE test_revisions SET content_hash='tamper' WHERE id='${id}'`)).toBe(
          "check",
        );
        expect(reject(db, `DELETE FROM test_revisions WHERE id='${id}'`)).toBe("check");
      }
      expect(revisions(db)).toHaveLength(5);
    } finally {
      db.close();
    }
  },
);
