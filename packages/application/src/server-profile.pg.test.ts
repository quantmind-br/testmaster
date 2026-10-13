import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestDatabase,
  type TestDatabase,
  withAdminClient,
} from "@testmaster/persistence/testing";
import { afterEach, expect, it } from "vitest";
import {
  Application,
  type AuthenticatedIdentity,
  authenticateSession,
  type PermissionGrant,
  type ServerConfig,
} from "./index.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const password = "correct horse battery staple";

async function stack() {
  const database: TestDatabase = await createTestDatabase();
  cleanups.push(() => database.drop());
  const root = await mkdtemp(join(tmpdir(), "tm-server-profile-"));
  cleanups.push(async () => {
    await chmod(join(root, "evidence"), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, "home");
  const keys = join(root, "keys");
  await mkdir(home);
  await mkdir(keys, { mode: 0o700 });
  await mkdir(join(root, "evidence"), { mode: 0o700 });
  const masterKeyFile = join(keys, "master.key");
  await writeFile(masterKeyFile, randomBytes(32), { mode: 0o600 });
  const server: ServerConfig = {
    mode: "server",
    database: { engine: "postgres", ...database.config },
    storage: { kind: "filesystem", root: join(root, "evidence") },
    server: {
      listen: { host: "127.0.0.1", port: 0 },
      publicOrigin: "https://tm.example",
      trustedProxies: [],
      origins: ["https://tm.example"],
    },
    security: {
      masterKeyFile,
      backupKeyFile: join(keys, "backup.key"),
      atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
    },
  };
  const application = await Application.open({ cwd: root, home, env: {}, server });
  cleanups.push(() => application.close());
  const created = application.operator.bootstrap({
    workspaceName: "Acme",
    ownerLogin: "acme-owner",
  });
  await application.identityService.recover({
    principal: "acme-owner",
    recoveryToken: created.ownerRecovery.recoveryToken,
    newPassword: password,
  });
  const owner = authenticateSession(
    application,
    (await application.identityService.login({ principal: "acme-owner", password })).sessionToken,
  );
  return {
    application,
    database,
    root,
    server,
    masterKeyFile,
    owner,
    workspaceId: String(created.workspace.id),
  };
}

it("OPS-001 server readiness reports every probe and attests operator-managed volume encryption", async () => {
  const { application } = await stack();
  const report = await application.readiness();
  expect(report).toMatchObject({
    status: "ready",
    reasons: [],
    atRestEncryption: "operator_attested",
    components: {
      persistence: "ready",
      admission: "ready",
      schema: "ready",
      tenantIsolation: "ready",
      storage: "ready",
      masterKey: "ready",
    },
    worker: { status: "degraded", ready: 0 },
  });
  expect(report.schema.state).toBe("current");
});

it("OPS-001 server readiness reports the failing probe with its reason code", async () => {
  const { application, masterKeyFile, root, database } = await stack();
  // Storage: an unwritable evidence volume.
  await chmod(join(root, "evidence"), 0o500);
  expect(await application.readiness()).toMatchObject({
    status: "unavailable",
    // The master key store lives on the same volume, so it fails with it.
    reasons: ["storage_unwritable", "master_key_unavailable"],
    components: { storage: "unavailable", persistence: "ready" },
  });
  await chmod(join(root, "evidence"), 0o700);
  // Master key: the operator removed the key file.
  await rm(masterKeyFile);
  expect(await application.readiness()).toMatchObject({
    status: "unavailable",
    reasons: ["master_key_unavailable"],
  });
  await writeFile(masterKeyFile, randomBytes(32), { mode: 0o600 });
  // Tenant isolation: the runtime role gained BYPASSRLS after the connection was opened.
  await withAdminClient(async (client) => {
    await client.query(`ALTER ROLE "${database.role}" BYPASSRLS`);
  });
  expect(await application.readiness()).toMatchObject({
    status: "unavailable",
    reasons: ["rls_role_bypass"],
    components: { tenantIsolation: "unavailable" },
  });
  await withAdminClient(async (client) => {
    await client.query(`ALTER ROLE "${database.role}" NOBYPASSRLS`);
  });
  // Negative control: with every fault removed the server is ready again.
  expect(await application.readiness()).toMatchObject({ status: "ready", reasons: [] });
});

it("OPS-001 server readiness counts only workers with a recent heartbeat", async () => {
  const { application, workspaceId } = await stack();
  const insert = (id: string, state: string, heartbeat: Date) =>
    application.database.withTx(() =>
      application.database.run(
        "INSERT INTO workers(workspace_id,id,created_at,state,last_heartbeat_at) VALUES(?,?,?,?,?)",
        workspaceId,
        id,
        new Date().toISOString(),
        state,
        heartbeat.toISOString(),
      ),
    );
  insert("wrk_stale", "ready", new Date(Date.now() - 120_000));
  insert("wrk_offline", "offline", new Date());
  expect((await application.readiness()).worker).toEqual({ status: "degraded", ready: 0 });
  insert("wrk_live", "ready", new Date());
  expect((await application.readiness()).worker).toEqual({ status: "ready", ready: 1 });
});

it("OPS-001 doctor in server mode fails closed on a failing server probe and lists it as blocking", async () => {
  const { application, masterKeyFile, owner } = await stack();
  await rm(masterKeyFile);
  const report = await application.forIdentity(owner).doctor();
  expect(report.blocking).toContain("server");
  expect(report.checks.server).toMatchObject({
    status: "FAIL",
    diagnostics: ["master_key_unavailable"],
    atRestEncryption: "operator_attested",
  });
});

it("SEC-036 decrypting a secret needs an explicit unexpired secrets:export grant even for the organization owner", async () => {
  const { application, owner } = await stack();
  const grant = (overrides: Partial<PermissionGrant> = {}): PermissionGrant => ({
    resourceType: "secrets",
    actions: ["export"],
    projectIds: [],
    environmentIds: [],
    expiresAt: null,
    grantedBy: owner.principalId,
    ...overrides,
  });
  const as = (grants: PermissionGrant[]) =>
    application.forIdentity({ ...owner, grants } as AuthenticatedIdentity);
  const stored = await as([]).secrets.set("db-password", "plaintext-canary-sec036", {
    allowedOrigins: ["https://shop.example"],
  });
  // No grant, an expired grant, a grant for another resource type and a deny grant are all refused.
  for (const grants of [
    [],
    [grant({ expiresAt: new Date(Date.now() - 1000).toISOString() })],
    [grant({ resourceType: "Run" })],
    [grant(), grant({ deny: true })],
  ])
    await expect(as(grants).secrets.reveal(stored.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  // Positive control: the same owner with an explicit grant decrypts.
  await expect(as([grant()]).secrets.reveal(stored.id)).resolves.toMatchObject({
    id: stored.id,
    value: "plaintext-canary-sec036",
  });
});
