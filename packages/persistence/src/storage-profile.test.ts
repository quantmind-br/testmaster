import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { PersistenceDatabase } from "./database.js";

it("OPS-005 refuses a real SQLite connection forced into non-WAL journal storage before migrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-no-wal-"));
  const execute = DatabaseSync.prototype.exec;
  const hook = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    execute.call(this, sql.replace("journal_mode=WAL", "journal_mode=DELETE"));
  });
  try {
    await expect(PersistenceDatabase.open(join(root, "testmaster.db"))).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    hook.mockRestore();
    const db = new DatabaseSync(join(root, "testmaster.db"));
    try {
      expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='schema_migrations'").get()
          ?.n,
      ).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    hook.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
