import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { constraintSeed, statementOutcome as outcome } from "./constraint-fixtures.js";
import { loadMigrations, PersistenceDatabase } from "./database.js";
import { postgresParity } from "./testing/postgres.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const at = "2026-10-05T00:00:00.000Z";
const artifactInsert = (id: string, storageKey: string) =>
  `INSERT INTO artifacts(workspace_id,id,created_at,run_id,attempt_id,revision_id,snapshot_id,bytes,storage_key,state,redaction_status,hash) VALUES('ws-a','${id}','${at}','run-a','att-a','rev-a','snp-a',1,'${storageKey}','available','not_applicable','h')`;
/** A key as long as a download named with 200 characters yields under the longest run ids. */
const longKey = `runs/${"w".repeat(39)}/${"r".repeat(40)}/${"a".repeat(40)}/browser/downloads/${"d".repeat(200)}`;

// Not run on PostgreSQL: Opens a legacy SQLite data directory by path; the PostgreSQL chain is
// exercised by artifact-storage-key.pg.test.ts.
it.skipIf(postgresParity)(
  "migration 0023 lets an artifact keep the storage key of a long step id or output name and keeps the PATH_MAX bound",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "tm-storage-key-migration-"));
    roots.push(root);
    const all = await loadMigrations();
    expect(all.find((migration) => migration.version === 23)?.name).toBe("artifact_storage_key");
    const legacyDir = join(root, "release-before-storage-key");
    await mkdir(legacyDir);
    for (const migration of all.filter((candidate) => candidate.version < 23))
      await writeFile(
        join(legacyDir, `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`),
        migration.sql,
      );
    const path = join(root, "data", "testmaster.db");
    const old = await PersistenceDatabase.open(path, { migrationsDir: legacyDir });
    old.withTx(() => {
      for (const sql of constraintSeed) old.exec(sql);
      old.exec(artifactInsert("art-short", "runs/ws-a/run-a/att-a/http/get.json"));
    });
    // Control: the previous schema refuses a key over 200 characters.
    expect(longKey.length).toBeGreaterThan(200);
    expect(outcome(old, artifactInsert("art-early", longKey))).toBe("check");
    const before = old.all("SELECT * FROM artifacts ORDER BY id");
    old.close();

    const db = await PersistenceDatabase.open(path);
    try {
      expect(db.status()).toMatchObject({ currentVersion: all.length, pending: [] });
      expect(db.all("SELECT * FROM artifacts ORDER BY id")).toEqual(before);
      expect(outcome(db, artifactInsert("art-long", longKey))).toBe("accepted");
      expect(
        outcome(db, `UPDATE artifacts SET storage_key='${longKey}x' WHERE id='art-short'`),
      ).toBe("accepted");
      // The bound that stays: no key longer than PATH_MAX, and no empty key.
      expect(outcome(db, artifactInsert("art-huge", "k".repeat(4097)))).toBe("check");
      expect(outcome(db, artifactInsert("art-empty", ""))).toBe("check");
      // The other artifact constraints are untouched.
      expect(outcome(db, artifactInsert("art-bad", "k").replace("'available'", "'unknown'"))).toBe(
        "check",
      );
    } finally {
      db.close();
    }
  },
);
