import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { EntityRepository, PersistenceDatabase } from "@testmaster/persistence";
import { afterEach, expect, it, vi } from "vitest";
import { type ResolvedConfig, resolveConfig } from "./config.js";
import type { ServiceContext } from "./context.js";
import { SecretsService } from "./secrets.js";
import type { ServerConfig } from "./server-config.js";

// The server profile never touches the desktop keyring; fail loudly if it ever tries.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    throw new Error("The server vault must not spawn a keychain helper");
  }),
}));
const directories: string[] = [];
const databases: PersistenceDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const origin = { allowedOrigins: ["https://shop.example"] };
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function fixture(options: { decrypt?: ServiceContext["authorizeDecrypt"] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tm-server-vault-"));
  directories.push(root);
  const home = join(root, "home");
  const keyDirectory = join(root, "keys");
  const evidence = join(root, "evidence");
  await mkdir(home);
  await mkdir(keyDirectory, { mode: 0o700 });
  await mkdir(evidence, { mode: 0o700 });
  const masterKey = randomBytes(32);
  const masterKeyFile = join(keyDirectory, "master.key");
  await writeFile(masterKeyFile, masterKey, { mode: 0o600 });
  const config: ResolvedConfig = await resolveConfig({ cwd: root, home, env: {} });
  const server: ServerConfig = {
    mode: "server",
    database: { engine: "postgres", url: "postgres://tm@127.0.0.1:5432/tm" },
    storage: { kind: "filesystem", root: evidence },
    server: {
      listen: { host: "127.0.0.1", port: 0 },
      publicOrigin: "https://tm.example",
      trustedProxies: [],
      origins: ["https://tm.example"],
    },
    security: {
      masterKeyFile,
      backupKeyFile: join(keyDirectory, "backup.key"),
      atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
    },
  };
  const database = await PersistenceDatabase.open(join(root, "metadata.db"));
  databases.push(database);
  const entities = new EntityRepository(database);
  const workspaceId = uuidV7IdGenerator.next("ws");
  entities.insert("Workspace", {
    id: workspaceId,
    workspaceId,
    name: "Server vault",
    mode: "server",
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
    ...(options.decrypt ? { authorizeDecrypt: options.decrypt } : {}),
    actor: { principalId: "local", credentialKind: null, credentialId: null },
    reauthorizeActor: vi.fn(() => true),
  };
  return {
    service: new SecretsService(ctx, config, server),
    ctx,
    config,
    server,
    home,
    keyDirectory,
    evidence,
    masterKey,
    masterKeyFile,
  };
}

it("SEC-036 server vault encrypts under the operator master key file and names the key by its sha256", async () => {
  const { service, home, evidence, masterKey, keyDirectory } = await fixture();
  const canary = "CANARY-server-vault-cleartext";
  const metadata = await service.set("db-password", canary, origin);
  const stored = await readFile(join(evidence, "secrets", `${metadata.id}.1.vault`));
  expect(stored.includes(Buffer.from(canary))).toBe(false);
  const envelope = JSON.parse(stored.toString("utf8")) as { keyId: string };
  expect(envelope.keyId).toBe(sha256(masterKey));
  expect(await service.keyStatus()).toEqual({
    activeKeyId: sha256(masterKey),
    retiredKeyIds: [],
  });
  expect(await (await service.release(metadata.id)).resolve()).toBe(canary);
  // Negative control: nothing was written to the local-profile locations or next to the key.
  await expect(stat(join(home, ".config", "testmaster", "vault.key"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(stat(join(home, ".local", "share", "testmaster"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readdir(keyDirectory)).toEqual(["master.key"]);
});

it("SEC-036 server vault fails closed without the master key and never mints a replacement", async () => {
  const { service, masterKeyFile, masterKey, keyDirectory } = await fixture();
  const metadata = await service.set("token", "server-secret", origin);
  const release = await service.release(metadata.id);
  await rm(masterKeyFile);
  const missing = {
    code: "PRECONDITION_FAILED",
    details: { reasonCode: "master_key_unavailable" },
  };
  await expect(release.resolve()).rejects.toMatchObject(missing);
  await expect(service.set("replacement", "other", origin)).rejects.toMatchObject(missing);
  expect(await readdir(keyDirectory)).toEqual([]);
  // A different key cannot decrypt what the original key sealed.
  await writeFile(masterKeyFile, randomBytes(32), { mode: 0o600 });
  await expect(release.resolve()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  // Positive control: restoring the original key restores access.
  await rm(masterKeyFile);
  await writeFile(masterKeyFile, masterKey, { mode: 0o600 });
  expect(await release.resolve()).toBe("server-secret");
});

it("SEC-036 a copy of the evidence volume without the master key cannot reveal secrets", async () => {
  const { service, evidence, server, config, ctx } = await fixture();
  const canary = "CANARY-evidence-copy";
  const metadata = await service.set("copied", canary, origin);
  const copy = await mkdtemp(join(tmpdir(), "tm-evidence-copy-"));
  directories.push(copy);
  await mkdir(join(copy, "keys"), { mode: 0o700 });
  await mkdir(join(copy, "secrets"), { recursive: true, mode: 0o700 });
  const name = `${metadata.id}.1.vault`;
  await writeFile(join(copy, "secrets", name), await readFile(join(evidence, "secrets", name)), {
    mode: 0o600,
  });
  const thief = new SecretsService(ctx, config, {
    ...server,
    storage: { kind: "filesystem", root: copy },
    security: { ...server.security, masterKeyFile: join(copy, "keys", "master.key") },
  });
  await expect((await thief.release(metadata.id)).resolve()).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
    details: { reasonCode: "master_key_unavailable" },
  });
  expect((await readFile(join(copy, "secrets", name))).includes(Buffer.from(canary))).toBe(false);
});

it("SEC-036 rewrapKeys rotates the master key, keeps reads working and keeps retired keys beside the key", async () => {
  const { service, masterKey, masterKeyFile, keyDirectory, evidence } = await fixture();
  const metadata = await service.set("rotating", "survives-rotation", origin);
  const rotated = await service.rewrapKeys();
  const next = await readFile(masterKeyFile);
  expect(next.equals(masterKey)).toBe(false);
  expect(rotated).toMatchObject({
    previousKeyId: sha256(masterKey),
    activeKeyId: sha256(next),
    rewrapped: 1,
  });
  const envelope = JSON.parse(
    (await readFile(join(evidence, "secrets", `${metadata.id}.1.vault`))).toString("utf8"),
  ) as { keyId: string };
  expect(envelope.keyId).toBe(sha256(next));
  expect(await (await service.release(metadata.id)).resolve()).toBe("survives-rotation");
  // The retired key sits with the master key, never with the ciphertexts it could open.
  expect((await readdir(keyDirectory)).sort()).toEqual(
    ["master.key", `${sha256(masterKey)}.key`].sort(),
  );
  expect((await readdir(join(evidence, "secrets"))).some((name) => name.endsWith(".key"))).toBe(
    false,
  );
});

it("SEC-036 reveal needs an explicit secrets:export grant and returns plaintext only to the authorized caller", async () => {
  const denied = vi.fn(() => {
    throw Object.assign(new Error("Secret decryption requires a secrets:export grant"), {
      code: "FORBIDDEN",
    });
  });
  const missing = await fixture();
  const stored = await missing.service.set("revealed", "plaintext-canary", origin);
  // The context offers no decrypt authority at all: refused before any decryption.
  await expect(missing.service.reveal(stored.id)).rejects.toMatchObject({ code: "FORBIDDEN" });

  const refused = await fixture({ decrypt: denied });
  const secret = await refused.service.set("revealed", "plaintext-canary", origin);
  const failure = await refused.service.reveal(secret.id).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "FORBIDDEN" });
  expect(JSON.stringify(failure)).not.toContain("plaintext-canary");
  expect(denied).toHaveBeenCalledOnce();

  // Positive control: with the authority the same call decrypts, and the audit trail never holds it.
  const allowed = vi.fn();
  const granted = await fixture({ decrypt: allowed });
  const sealed = await granted.service.set("revealed", "plaintext-canary", origin);
  await expect(granted.service.reveal(sealed.id)).resolves.toEqual({
    id: sealed.id,
    secretVersion: 1,
    value: "plaintext-canary",
  });
  expect(allowed).toHaveBeenCalledOnce();
  expect(JSON.stringify(granted.ctx.database.all("SELECT * FROM audit_events"))).not.toContain(
    "plaintext-canary",
  );
  await granted.service.remove(sealed.id);
  await expect(granted.service.reveal(sealed.id)).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
});
