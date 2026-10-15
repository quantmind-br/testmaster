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

it("OPS-005 migration 0022 admits terminal revisions on a populated v21 database without touching existing rows", async () => {
  const created = await createTestDatabase({ migrate: false });
  cleanups.push(() => created.drop());
  const db = PersistenceDatabase.openPostgres(created.config);
  cleanups.push(() => {
    if (db.isOpen) db.close();
  });
  const available = await loadMigrations("postgres");
  expect(available.find((migration) => migration.version === 22)?.name).toBe("terminal_runner");
  const directory = await mkdtemp(join(tmpdir(), "tm-pg-terminal-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  for (const migration of available.filter((candidate) => candidate.version < 22))
    await writeFile(
      join(directory, `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`),
      migration.sql,
    );
  await db.migrate(directory);
  expect(db.status().currentVersion).toBe(21);
  db.withTx(() => {
    for (const sql of constraintSeed) db.exec(sql);
    db.exec(revisionInsert("rev-pw", 2, "playwright", "rev-a"));
    db.exec(revisionInsert("rev-py", 3, "python", "rev-pw"));
  });
  const revisions = () => db.all("SELECT * FROM test_revisions ORDER BY workspace_id,id");
  const before = revisions();
  expect(before.map((row) => row.runner_kind)).toEqual(["http", "playwright", "python"]);
  // Control: the previous schema refuses the new runner kind.
  expect(outcome(db, revisionInsert("rev-early", 4, "terminal", "rev-py"))).toBe("check");

  await db.migrate();
  expect(db.status()).toMatchObject({ currentVersion: available.length, pending: [] });
  expect(revisions()).toEqual(before);
  expect(outcome(db, revisionInsert("rev-term", 4, "terminal", "rev-py"))).toBe("accepted");
  expect(outcome(db, revisionInsert("rev-shell", 5, "shell", "rev-py"))).toBe("check");
  for (const id of ["rev-a", "rev-term"]) {
    expect(outcome(db, `UPDATE test_revisions SET content_hash='tamper' WHERE id='${id}'`)).toBe(
      "check",
    );
    expect(outcome(db, `DELETE FROM test_revisions WHERE id='${id}'`)).toBe("check");
  }
  expect(revisions()).toHaveLength(4);
});
