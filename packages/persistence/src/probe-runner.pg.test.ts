import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  constraintSeed,
  statementOutcome as outcome,
  revisionInsert,
} from "./constraint-fixtures.js";
import { loadMigrations, PersistenceDatabase } from "./database.js";
import { createTestDatabase } from "./testing/postgres.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("REQ-050 migration 0027 admits probe revisions on a populated v26 database without touching existing rows", async () => {
  const created = await createTestDatabase({ migrate: false });
  cleanups.push(() => created.drop());
  const db = PersistenceDatabase.openPostgres(created.config);
  cleanups.push(() => {
    if (db.isOpen) db.close();
  });
  const available = await loadMigrations("postgres");
  expect(available.find((migration) => migration.version === 27)?.name).toBe("probe_runner");
  const directory = await mkdtemp(join(tmpdir(), "tm-pg-probe-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  for (const migration of available.filter((candidate) => candidate.version < 27))
    await writeFile(
      join(directory, `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`),
      migration.sql,
    );
  await db.migrate(directory);
  expect(db.status().currentVersion).toBe(26);
  db.withTx(() => {
    for (const sql of constraintSeed) db.exec(sql);
    db.exec(revisionInsert("rev-py", 2, "python", "rev-a"));
    db.exec(revisionInsert("rev-term", 3, "terminal", "rev-py"));
  });
  const revisions = () => db.all("SELECT * FROM test_revisions ORDER BY workspace_id,id");
  const before = revisions();
  expect(before.map((row) => row.runner_kind)).toEqual(["http", "python", "terminal"]);
  // Control: the previous schema refuses the new runner kind.
  expect(outcome(db, revisionInsert("rev-early", 4, "probe", "rev-term"))).toBe("check");

  await db.migrate();
  expect(db.status()).toMatchObject({ currentVersion: available.length, pending: [] });
  expect(revisions()).toEqual(before);
  expect(outcome(db, revisionInsert("rev-probe", 4, "probe", null))).toBe("accepted");
  expect(outcome(db, revisionInsert("rev-shell", 5, "shell", "rev-term"))).toBe("check");
  for (const id of ["rev-a", "rev-probe"]) {
    expect(outcome(db, `UPDATE test_revisions SET content_hash='tamper' WHERE id='${id}'`)).toBe(
      "check",
    );
    expect(outcome(db, `DELETE FROM test_revisions WHERE id='${id}'`)).toBe("check");
  }
  expect(revisions()).toHaveLength(4);
});
