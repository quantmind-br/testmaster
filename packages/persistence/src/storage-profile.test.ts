import { existsSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { PersistenceDatabase } from "./database.js";

const forcedFilesystem = vi.hoisted(() => ({ type: undefined as number | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const statfs = (async (path: string) => {
    const real = await actual.statfs(path);
    return forcedFilesystem.type === undefined ? real : { ...real, type: forcedFilesystem.type };
  }) as typeof FsPromises.statfs;
  return { ...actual, default: { ...actual, statfs }, statfs };
});

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

it("OPS-005 refuses SQLite on network or FUSE storage before creating the database", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-network-fs-"));
  try {
    // NFS, SMB, CIFS and FUSE super-block magic numbers.
    for (const type of [0x6969, 0xff534d42, 0xfe534d42, 0x65735546]) {
      forcedFilesystem.type = type;
      await expect(PersistenceDatabase.open(join(root, "testmaster.db"))).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
      expect(existsSync(join(root, "testmaster.db"))).toBe(false);
    }
    forcedFilesystem.type = undefined;
    const control = await PersistenceDatabase.open(join(root, "testmaster.db"));
    control.close();
    expect(existsSync(join(root, "testmaster.db"))).toBe(true);
  } finally {
    forcedFilesystem.type = undefined;
    await rm(root, { recursive: true, force: true });
  }
});
