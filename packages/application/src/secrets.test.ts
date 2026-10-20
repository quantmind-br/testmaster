import type * as childProcess from "node:child_process";
import { spawn } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { EntityRepository, PersistenceDatabase } from "@testmaster/persistence";
import { postgresParity } from "@testmaster/persistence/testing";
import { afterEach, expect, it, vi } from "vitest";
import { BackupsService } from "./backups.js";
import { type ResolvedConfig, resolveConfig } from "./config.js";
import type { ServiceContext } from "./context.js";
import { health, SecretsService } from "./secrets.js";

// Hermetic tests exercise the real encrypted fallback, never the host keyring.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    throw Object.assign(new Error("Unavailable"), { code: "ENOENT" });
  }),
}));
const directories: string[] = [];
const databases: PersistenceDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(): Promise<{
  service: SecretsService;
  ctx: ServiceContext;
  home: string;
  config: ResolvedConfig;
}> {
  const home = await mkdtemp(join(tmpdir(), "tm-secrets-"));
  directories.push(home);
  const config = await resolveConfig({ cwd: home, home, env: {} });
  const database = await PersistenceDatabase.open(join(home, "metadata.db"));
  databases.push(database);
  const entities = new EntityRepository(database);
  const workspaceId = uuidV7IdGenerator.next("ws");
  entities.insert("Workspace", {
    id: workspaceId,
    workspaceId,
    name: "Secrets test",
    mode: "single-user",
    settingsVersion: 1,
    quotaPolicyId: "local",
  });
  const ctx: ServiceContext = {
    database,
    entities,
    workspaceId,
    principalId: "local",
    authorize: vi.fn(),
    authorizeNamed: vi.fn(),
    authorizeColumn: vi.fn(),
    actor: { principalId: "local", credentialKind: null, credentialId: null },
    reauthorizeActor: vi.fn(() => true),
  };
  return { service: new SecretsService(ctx, config), ctx, home, config };
}

it("persists authenticated ciphertext with private permissions and metadata-only database rows", async () => {
  const { service, ctx, home } = await fixture();
  const value = "CANARY-do-not-persist-cleartext";
  const metadata = await service.set("password", value, {
    allowedOrigins: ["https://shop.example"],
  });
  expect(metadata.provider).toBe("vault");
  const path = join(home, ".local", "share", "testmaster", `${metadata.id}.1.vault`);
  expect((await readFile(path)).includes(Buffer.from(value))).toBe(false);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(home, ".config", "testmaster", "vault.key"))).mode & 0o777).toBe(0o600);
  expect((await stat(join(home, ".local", "share", "testmaster"))).mode & 0o777).toBe(0o700);
  expect(JSON.stringify(ctx.database.all("SELECT data_json FROM secret_references"))).not.toContain(
    value,
  );
  expect(await (await service.release(metadata.id)).resolve()).toBe(value);
});

it("rotation invalidates pinned releases and revocation retains a metadata tombstone", async () => {
  const { service } = await fixture();
  const metadata = await service.set("token", "first", {
    ephemeral: true,
    allowedOrigins: ["https://shop.example"],
  });
  const pinned = await service.release(metadata.id);
  const next = await service.rotate(metadata.id, "second");
  expect(next.secretVersion).toBe(2);
  expect(await pinned.revoked?.()).toBe(true);
  await expect(pinned.resolve()).rejects.toMatchObject({ code: "POLICY_DENIED" });
  const current = await service.release(next.id);
  expect(await current.resolve()).toBe("second");
  await service.remove(next.id);
  expect(await current.revoked?.()).toBe(true);
  expect(service.get(next.id).revokedAt).toBeTruthy();
  await expect(service.release(next.id)).rejects.toMatchObject({ code: "POLICY_DENIED" });
});

it("audits rotate, revoke and release by reference id and never by secret name", async () => {
  const { service, ctx } = await fixture();
  const name = "SENSITIVE-secret-name";
  const metadata = await service.set(name, "first", { allowedOrigins: ["https://shop.example"] });
  await service.release(name);
  await service.rotate(name, "second");
  await service.remove(name);
  await expect(service.rotate(name, "third")).rejects.toMatchObject({ code: "NOT_FOUND" });
  const rows = ctx.database.all(
    "SELECT action,resource_id FROM audit_events WHERE action LIKE 'secret.%' ORDER BY created_at,id",
  ) as { action: string; resource_id: string }[];
  expect(JSON.stringify(rows)).not.toContain(name);
  const rotated = rows.filter((row) => row.action.startsWith("secret.rotate."));
  expect(new Set(rotated.map((row) => row.resource_id))).toEqual(
    new Set([metadata.id, "secret-reference"]),
  );
  for (const prefix of ["secret.revoke.", "secret.release."])
    expect(
      new Set(rows.filter((row) => row.action.startsWith(prefix)).map((row) => row.resource_id)),
    ).toEqual(new Set([metadata.id]));
});

it("requires authorized origins and rejects origin paths or credential-bearing URLs", async () => {
  const { service } = await fixture();
  await expect(
    service.set("bad", "value", {
      ephemeral: true,
      allowedOrigins: ["https://user:password@shop.example"],
    }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(
    service.set("bad", "value", { ephemeral: true, allowedOrigins: ["https://shop.example/path"] }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  const metadata = await service.set("unbound", "value", { ephemeral: true });
  await expect(service.release(metadata.id)).rejects.toMatchObject({ code: "POLICY_DENIED" });
});

it("fails closed on vault tampering and missing keys after metadata restore", async () => {
  const { service, home } = await fixture();
  const metadata = await service.set("token", "secret-value", {
    allowedOrigins: ["https://shop.example"],
  });
  const release = await service.release(metadata.id);
  const path = join(home, ".local", "share", "testmaster", `${metadata.id}.1.vault`);
  const bytes = await readFile(path);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
  await writeFile(path, bytes);
  await expect(release.resolve()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  await rm(join(home, ".config", "testmaster", "vault.key"));
  await expect(release.resolve()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  await expect(
    service.set("replacement", "other-value", { allowedOrigins: ["https://shop.example"] }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  await expect(stat(join(home, ".config", "testmaster", "vault.key"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("keeps a capture out of the host keyring and erases it from the vault on demand", async () => {
  const { service, ctx, home } = await fixture();
  const origin = "https://shop.example";
  const keyring = vi.mocked(spawn);
  keyring.mockClear();
  const ordinary = await service.set("ordinary", "kept-value", { allowedOrigins: [origin] });
  // Control: an operator secret still tries the keyring first.
  expect(keyring).toHaveBeenCalled();
  keyring.mockClear();
  const capture = await service.protectCapture("capture-att_1-token", "CAPTURE-CANARY", [origin]);
  expect(keyring).not.toHaveBeenCalled();
  expect(capture.provider).toBe("vault");
  const path = join(home, ".local", "share", "testmaster", `${capture.id}.1.vault`);
  expect((await readFile(path)).includes(Buffer.from("CAPTURE-CANARY"))).toBe(false);
  expect(await (await service.release(capture.id)).resolve()).toBe('"CAPTURE-CANARY"');
  expect(await service.eraseCapture(capture.id)).toBe(true);
  expect(keyring).not.toHaveBeenCalled();
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(service.get(capture.id).revokedAt).toBeTruthy();
  await expect(service.release(capture.id)).rejects.toMatchObject({ code: "POLICY_DENIED" });
  expect(await service.eraseCapture(capture.id)).toBe(false);
  expect(
    ctx.database.all(
      "SELECT resource_id FROM audit_events WHERE action LIKE 'secret.capture.erase.%'",
    ),
  ).toHaveLength(1);
  // Only captures are erased this way; an operator secret stays usable.
  expect(await service.eraseCapture(ordinary.id)).toBe(false);
  expect(await (await service.release(ordinary.id)).resolve()).toBe("kept-value");
});

it("stores captures from concurrent attempts one after another instead of refusing them as busy", async () => {
  const { service } = await fixture();
  const origin = "https://shop.example";
  // The first write creates the vault key; the concurrent ones then contend for the vault lock.
  await service.protectCapture("capture-att_0-handle", "first", [origin]);
  const captures = await Promise.all(
    Array.from({ length: 9 }, (_, index) =>
      service.protectCapture(`capture-att_${index + 1}-handle`, `value-${index}`, [origin]),
    ),
  );
  for (const [index, capture] of captures.entries())
    expect(await (await service.release(capture.id)).resolve()).toBe(`"value-${index}"`);
});

it("reports the encrypted vault writable without a keychain and leaves no probe behind", async () => {
  const { config, home } = await fixture();
  expect(await health(config)).toEqual({ backend: "vault", writable: true });
  expect(await health(config)).toEqual({ backend: "vault", writable: true });
  expect(await readdir(join(home, ".local", "share", "testmaster"))).toEqual([]);
});

it("refuses symlinked storage while explicit ephemeral secrets remain usable only in this service", async () => {
  const { service, config, home, ctx } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "tm-outside-"));
  directories.push(outside);
  await symlink(outside, join(home, ".config"));
  await expect(
    service.set("persistent", "canary", { allowedOrigins: ["https://shop.example"] }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  expect(await health(config)).toEqual({ backend: "unavailable", writable: false });
  const metadata = await service.set("session", "canary", {
    ephemeral: true,
    allowedOrigins: ["https://shop.example"],
  });
  expect(await (await service.release(metadata.id)).resolve()).toBe("canary");
  const restarted = new SecretsService(ctx, config);
  await expect((await restarted.release(metadata.id)).resolve()).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
});

/** Seeds the cross-process vault lock as another process would have left it. */
async function seedLock(home: string, content: string): Promise<string> {
  const directory = join(home, ".config", "testmaster");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "vault.lock");
  await writeFile(path, content, { mode: 0o600 });
  return path;
}
async function deadPid(): Promise<number> {
  const actual = await vi.importActual<typeof childProcess>("node:child_process");
  const pid = actual.spawnSync(process.execPath, ["-e", ""]).pid;
  if (pid === undefined) throw new Error("spawnSync returned no pid");
  return pid;
}
const origin = "https://shop.example";

it("takes the vault lock whole and leaves neither the lock nor a temporary file behind", async () => {
  const { service, home } = await fixture();
  await service.protectCapture("capture-att_1-token", "value", [origin]);
  const names = await readdir(join(home, ".config", "testmaster"));
  expect(names).not.toContain("vault.lock");
  expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

it("reports a lock held by a live process as busy without the ephemeral advice", async () => {
  const { service, home } = await fixture();
  const path = await seedLock(home, String(process.pid));
  const refused = await service
    .protectCapture("capture-att_1-token", "value", [origin])
    .catch((error: unknown) => error);
  expect(refused).toMatchObject({
    code: "PRECONDITION_FAILED",
    details: { reasonCode: "lock_busy", path },
  });
  expect(refused).toMatchObject({ message: expect.not.stringContaining("ephemeral") });
  expect(await readFile(path, "utf8")).toBe(String(process.pid));
});

it("reclaims a lock whose process is dead", async () => {
  const { service, home } = await fixture();
  const path = await seedLock(home, String(await deadPid()));
  await service.protectCapture("capture-att_1-token", "value", [origin]);
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reports a lock held by a process it may not signal as busy", async () => {
  const { service, home } = await fixture();
  await seedLock(home, String(process.pid));
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("not permitted"), { code: "EPERM" });
  });
  try {
    await expect(
      service.protectCapture("capture-att_1-token", "value", [origin]),
    ).rejects.toMatchObject({ details: { reasonCode: "lock_busy" } });
  } finally {
    kill.mockRestore();
  }
});

it.each([
  ["empty", ""],
  ["non-numeric", "not-a-pid"],
  ["zero", "0"],
  ["out-of-range", "99999999999999999999"],
])("reports a lock with %s content as busy and leaves it untouched", async (_name, content) => {
  const { service, home } = await fixture();
  const path = await seedLock(home, content);
  await expect(
    service.protectCapture("capture-att_1-token", "value", [origin]),
  ).rejects.toMatchObject({ details: { reasonCode: "lock_busy" } });
  expect(await readFile(path, "utf8")).toBe(content);
});

it("reports a live holder that is between its link and unlink steps as busy", async () => {
  const { service, home } = await fixture();
  const path = await seedLock(home, String(process.pid));
  await link(path, join(home, ".config", "testmaster", ".holder.tmp"));
  await expect(
    service.protectCapture("capture-att_1-token", "value", [origin]),
  ).rejects.toMatchObject({ details: { reasonCode: "lock_busy" } });
});

it("passes a busy lock through a local secret write, a rewrap and the health probe", async () => {
  const { service, config, home } = await fixture();
  const path = await seedLock(home, String(process.pid));
  await expect(service.set("persistent", "v", { allowedOrigins: [origin] })).rejects.toMatchObject({
    details: { reasonCode: "lock_busy" },
  });
  await expect(service.rewrapKeys()).rejects.toMatchObject({
    details: { reasonCode: "lock_busy" },
  });
  expect(await health(config)).toEqual({
    backend: "unavailable",
    writable: false,
    reasonCode: "lock_busy",
    path,
  });
});

it("authorizes public methods and reauthorizes every deferred release", async () => {
  const { service, ctx } = await fixture();
  const metadata = await service.set("session", "canary", {
    ephemeral: true,
    allowedOrigins: ["https://shop.example"],
  });
  const release = await service.release(metadata.id);
  const denied = Object.assign(new Error("Denied"), { code: "POLICY_DENIED" });
  ctx.authorize = () => {
    throw denied;
  };
  expect(() => service.list()).toThrow(denied);
  expect(() => service.get(metadata.id)).toThrow(denied);
  await expect(service.set("other", "value")).rejects.toBe(denied);
  await expect(service.rotate(metadata.id, "next")).rejects.toBe(denied);
  await expect(service.remove(metadata.id)).rejects.toBe(denied);
  await expect(service.release(metadata.id)).rejects.toBe(denied);
  await expect(service.health()).rejects.toBe(denied);
  await expect(release.resolve()).rejects.toBe(denied);
});

// Not run on PostgreSQL: Restores a SQLite backup; PostgreSQL backups are pg_dump based (M4-02).
it.skipIf(postgresParity)(
  "SEC-036 restores real backup metadata but missing vault key denies release without replacement",
  async () => {
    const { service, ctx, home, config } = await fixture();
    const secret = await service.set("restored", "backup-canary", {
      allowedOrigins: ["https://shop.example"],
    });
    const backup = join(home, "backup");
    await ctx.database.backup(backup);
    const isolated = join(home, "restore");
    const restored = await PersistenceDatabase.restore(backup, isolated);
    databases.push(restored.database);
    await rm(join(home, ".config", "testmaster", "vault.key"));
    const restoredService = new SecretsService(
      { ...ctx, database: restored.database, entities: new EntityRepository(restored.database) },
      config,
    );
    await expect((await restoredService.release(secret.id)).resolve()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(stat(join(home, ".config", "testmaster", "vault.key"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      restored.database.get("SELECT value FROM operational_state WHERE key='admission'")?.value,
    ).toBe("suspended_restore");
  },
);

// Not run on PostgreSQL: Restores a SQLite backup; PostgreSQL backups are pg_dump based (M4-02).
it.skipIf(postgresParity)(
  "SEC-036 backup files alone cannot reveal secrets and never contain the vault key",
  async () => {
    const { service, ctx, home, config } = await fixture();
    const secret = await service.set("backup-probe", "backup-canary-sec036", {
      allowedOrigins: ["https://shop.example"],
    });
    const backup = join(home, "backup-sec036");
    await new BackupsService(ctx, config, service).create(backup);
    const key = await readFile(join(home, ".config", "testmaster", "vault.key"));
    const files = (await readdir(backup, { recursive: true })) as string[];
    expect(files.filter((name) => /vault/u.test(name))).toEqual([]);
    for (const name of files) {
      if (!(await stat(join(backup, name))).isFile()) continue;
      const bytes = await readFile(join(backup, name));
      expect(bytes.includes(Buffer.from("backup-canary-sec036"))).toBe(false);
      expect(bytes.includes(key)).toBe(false);
    }
    expect(JSON.parse(await readFile(join(backup, "manifest.json"), "utf8")).secretIncluded).toBe(
      false,
    );
    expect(await readdir(join(home, ".local", "share", "testmaster"))).toContain(
      `${secret.id}.1.vault`,
    );
  },
);

it("SEC-036 rewraps all vault ciphertexts before key retirement and refuses restored retired-key bytes", async () => {
  const { service, home } = await fixture();
  const first = await service.set("first", "first-value", {
    allowedOrigins: ["https://shop.example"],
  });
  const second = await service.set("second", "second-value", {
    allowedOrigins: ["https://shop.example"],
  });
  const firstPath = join(home, ".local", "share", "testmaster", `${first.id}.1.vault`);
  const oldBytes = await readFile(firstPath);
  const oldKey = await readFile(join(home, ".config", "testmaster", "vault.key"));
  const oldId = (await service.keyStatus()).activeKeyId;
  await expect(service.retireKey(oldId, false)).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
  const changed = await service.rewrapKeys();
  expect(changed.rewrapped).toBe(2);
  expect(changed.previousKeyId).toBe(oldId);
  expect(changed.activeKeyId).not.toBe(oldId);
  expect(await (await service.release(first.id)).resolve()).toBe("first-value");
  expect(await (await service.release(second.id)).resolve()).toBe("second-value");
  expect(JSON.parse(await readFile(firstPath, "utf8")).keyId).toBe(changed.activeKeyId);
  await writeFile(firstPath, oldBytes);
  expect((await service.retireKey(oldId)).references).toContain(`${first.id}.1.vault`);
  await expect(service.retireKey(oldId, false)).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
  await service.rewrapKeys();
  await service.retireKey(oldId, false);
  await expect(stat(join(home, ".config", "testmaster", `${oldId}.key`))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await writeFile(firstPath, oldBytes);
  await expect((await service.release(first.id)).resolve()).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
  await writeFile(join(home, ".config", "testmaster", "vault.key"), oldKey);
  await expect((await service.release(first.id)).resolve()).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
});
