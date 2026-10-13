import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadMigrations, PersistenceDatabase } from "./database.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

it("ADR-017 migration 0010 moves local-token rows into server_tokens, keeps other state and creates the identity tables", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-identity-migration-"));
  roots.push(root);
  const all = await loadMigrations();
  const before = all.filter((migration) => migration.version < 10);
  expect(before).toHaveLength(9);
  const legacy = join(root, "release-before-identity");
  await mkdir(legacy);
  for (const migration of before)
    await writeFile(
      join(legacy, `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`),
      migration.sql,
    );
  const path = join(root, "testmaster.db");
  const old = await PersistenceDatabase.open(path, { migrationsDir: legacy });
  const now = new Date().toISOString();
  old.run(
    "INSERT INTO workspaces(workspace_id,id,created_at,name,mode) VALUES('ws','ws',?,'w','single-user')",
    now,
  );
  old.run(
    "INSERT INTO principals(workspace_id,id,created_at,kind,display_name) VALUES('ws','usr_1',?,'human','Dev')",
    now,
  );
  const identity = { principalId: "usr_1", scopes: ["R", "W"], grants: [] };
  const record = (revoked: boolean) =>
    JSON.stringify({
      workspaceId: "ws",
      audience: "testmaster-local",
      identity,
      expiresAt: "2099-01-01T00:00:00.000Z",
      revoked,
    });
  old.run(
    "INSERT INTO operational_state(key,value) VALUES(?,?)",
    `local-token:${hashOf("a")}`,
    record(false),
  );
  old.run(
    "INSERT INTO operational_state(key,value) VALUES(?,?)",
    `local-token:${hashOf("b")}`,
    record(true),
  );
  old.run("INSERT INTO operational_state(key,value) VALUES('user:state','keep-me')");
  expect(old.status().currentVersion).toBe(9);
  old.close();

  const migrated = await PersistenceDatabase.open(path);
  try {
    expect(migrated.status()).toMatchObject({ currentVersion: all.length, pending: [] });
    const rows = migrated.all(
      "SELECT token_hash,principal_id,expires_at,revoked_at,data_json FROM server_tokens ORDER BY token_hash",
    );
    expect(rows).toHaveLength(2);
    const active = rows.find((row) => row.token_hash === hashOf("a"));
    const revoked = rows.find((row) => row.token_hash === hashOf("b"));
    expect(active).toMatchObject({
      principal_id: "usr_1",
      expires_at: "2099-01-01T00:00:00.000Z",
      revoked_at: null,
    });
    expect(JSON.parse(String(active?.data_json))).toMatchObject({
      kind: "local",
      audience: "testmaster-local",
      scopes: ["R", "W"],
      grants: [],
      operator: false,
    });
    expect(revoked?.revoked_at).not.toBeNull();
    // Clean cutover: no local-token row is left behind and unrelated state survives.
    expect(
      migrated.get("SELECT COUNT(*) AS n FROM operational_state WHERE key LIKE 'local-token:%'")?.n,
    ).toBe(0);
    expect(migrated.get("SELECT value FROM operational_state WHERE key='user:state'")?.value).toBe(
      "keep-me",
    );
    for (const table of ["password_credentials", "sessions"])
      expect(
        migrated.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table)?.name,
      ).toBe(table);
  } finally {
    migrated.close();
  }
});
