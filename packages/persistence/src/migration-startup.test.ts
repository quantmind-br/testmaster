import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadMigrations, PersistenceDatabase } from "./database.js";

const roots: string[] = [];
const connections: PersistenceDatabase[] = [];
afterEach(async () => {
  for (const db of connections.splice(0)) if (db.db.isOpen) db.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tm-migrations-"));
  roots.push(root);
  const path = join(root, "testmaster.db");
  const db = await PersistenceDatabase.open(path);
  connections.push(db);
  return { root, path, db };
}
it("denies a second actual migrator while preserving queued data and permits normal concurrent startup", async () => {
  const { root, path, db } = await fixture();
  const second = await PersistenceDatabase.open(path);
  connections.push(second);
  const migrations = await loadMigrations();
  const directory = join(root, "upgrade");
  await mkdir(directory);
  for (const migration of migrations)
    await writeFile(
      join(directory, `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`),
      migration.sql,
    );
  await writeFile(
    join(directory, `${String(migrations.length + 1).padStart(4, "0")}_probe.sql`),
    "CREATE TABLE migration_probe(id TEXT PRIMARY KEY);",
  );
  db.run("INSERT INTO operational_state(key,value) VALUES('upgrade:queued','durable')");
  db.db.exec("BEGIN EXCLUSIVE");
  try {
    await expect(second.migrate(directory)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(
      second.get("SELECT name FROM sqlite_master WHERE name='migration_probe'"),
    ).toBeUndefined();
  } finally {
    db.db.exec("ROLLBACK");
  }
  expect(second.get("SELECT value FROM operational_state WHERE key='upgrade:queued'")?.value).toBe(
    "durable",
  );
  await second.migrate(directory);
  expect(second.status().currentVersion).toBe(migrations.length + 1);
});
it("refuses incompatible controller startup even when migrations are disabled without mutating newer data", async () => {
  const { root, path, db } = await fixture();
  db.run("INSERT INTO operational_state(key,value) VALUES('newer:state','preserve')");
  const migrations = await loadMigrations();
  const old = join(root, "old-controller");
  await mkdir(old);
  const initial = migrations[0];
  if (!initial) throw new Error("Missing initial migration fixture");
  await writeFile(join(old, `0001_${initial.name}.sql`), initial.sql);
  await expect(PersistenceDatabase.open(path, { migrationsDir: old })).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
  await expect(
    PersistenceDatabase.open(path, { migrationsDir: old, migrate: false }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  expect(db.get("SELECT value FROM operational_state WHERE key='newer:state'")?.value).toBe(
    "preserve",
  );
  expect(db.status().currentVersion).toBe(migrations.length);
});
it("failed startup rolls back migration DDL and records only committed versions", async () => {
  const { root, path, db } = await fixture();
  const directory = join(root, "broken-upgrade");
  await mkdir(directory);
  const migrations = await loadMigrations();
  for (const migration of migrations)
    await writeFile(
      join(directory, `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`),
      migration.sql,
    );
  await writeFile(
    join(directory, `${String(migrations.length + 1).padStart(4, "0")}_broken.sql`),
    "CREATE TABLE must_rollback(id TEXT); INSERT INTO missing_table VALUES(1);",
  );
  await expect(PersistenceDatabase.open(path, { migrationsDir: directory })).rejects.toThrow();
  expect(db.get("SELECT name FROM sqlite_master WHERE name='must_rollback'")).toBeUndefined();
  expect(db.status().currentVersion).toBe(migrations.length);
});
