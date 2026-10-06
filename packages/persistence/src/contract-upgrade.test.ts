import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadMigrations, PersistenceDatabase } from "./database.js";

it("catalog projection upgrade validates existing data and rolls back without rewriting incompatible rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tm-contract-upgrade-"));
  const db = PersistenceDatabase.memory();
  try {
    const migrations = await loadMigrations();
    const old = join(directory, "old");
    await mkdir(old);
    for (const migration of migrations.filter((item) => item.version < 4))
      await writeFile(
        join(old, `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`),
        migration.sql,
      );
    await db.migrate(old);
    db.run(
      "INSERT INTO workspaces(workspace_id,id,created_at,name,mode)VALUES('legacy','legacy','2026-10-05T00:00:00.000Z',?,'single-user')",
      "x".repeat(201),
    );
    await expect(db.migrate()).rejects.toThrow(
      "contract constraint migration: invalid existing workspaces",
    );
    expect(db.get("SELECT name FROM workspaces WHERE id='legacy'")?.name).toBe("x".repeat(201));
    expect(db.status().currentVersion).toBe(3);
    db.run("UPDATE workspaces SET name='valid' WHERE id='legacy'");
    await db.migrate();
    expect(db.status().currentVersion).toBe(migrations.length);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
