import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { EntityRepository, PersistenceDatabase } from "@testmaster/persistence";
import { afterEach, expect, it, vi } from "vitest";
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
