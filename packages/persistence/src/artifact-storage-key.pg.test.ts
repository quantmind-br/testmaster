import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { constraintSeed, statementOutcome as outcome } from "./constraint-fixtures.js";
import { loadMigrations, PersistenceDatabase } from "./database.js";
import { createTestDatabase } from "./testing/postgres.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const at = "2026-10-05T00:00:00.000Z";
const artifactInsert = (id: string, storageKey: string) =>
  `INSERT INTO artifacts(workspace_id,id,created_at,run_id,attempt_id,revision_id,snapshot_id,bytes,storage_key,state,redaction_status,hash) VALUES('ws-a','${id}','${at}','run-a','att-a','rev-a','snp-a',1,'${storageKey}','available','not_applicable','h')`;
const longKey = `runs/${"w".repeat(39)}/${"r".repeat(40)}/${"a".repeat(40)}/browser/downloads/${"d".repeat(200)}`;

it("OPS-005 migration 0023 admits a storage key over 200 characters on a populated v22 database and keeps the PATH_MAX bound", async () => {
  const created = await createTestDatabase({ migrate: false });
  cleanups.push(() => created.drop());
  const db = PersistenceDatabase.openPostgres(created.config);
  cleanups.push(() => {
    if (db.isOpen) db.close();
  });
  const available = await loadMigrations("postgres");
  expect(available.find((migration) => migration.version === 23)?.name).toBe(
    "artifact_storage_key",
  );
  const directory = await mkdtemp(join(tmpdir(), "tm-pg-storage-key-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  for (const migration of available.filter((candidate) => candidate.version < 23))
    await writeFile(
      join(directory, `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`),
      migration.sql,
    );
  await db.migrate(directory);
  expect(db.status().currentVersion).toBe(22);
  db.withTx(() => {
    for (const sql of constraintSeed) db.exec(sql);
    db.exec(artifactInsert("art-short", "runs/ws-a/run-a/att-a/http/get.json"));
  });
  const artifacts = () => db.all("SELECT * FROM artifacts ORDER BY id");
  const before = artifacts();
  // Control: the previous schema refuses a key over 200 characters.
  expect(outcome(db, artifactInsert("art-early", longKey))).toBe("check");

  await db.migrate();
  expect(db.status()).toMatchObject({ currentVersion: available.length, pending: [] });
  expect(artifacts()).toEqual(before);
  expect(outcome(db, artifactInsert("art-long", longKey))).toBe("accepted");
  expect(outcome(db, artifactInsert("art-huge", "k".repeat(4097)))).toBe("check");
  expect(outcome(db, artifactInsert("art-empty", ""))).toBe("check");
  expect(outcome(db, artifactInsert("art-bad", "k").replace("'available'", "'unknown'"))).toBe(
    "check",
  );
});
