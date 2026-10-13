import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@testmaster/persistence/testing";
import { AttemptExecutor } from "@testmaster/sandbox";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaults, httpFormConfig, type ReferenceAuth, start } from "../../test/auth-lab.js";
import {
  Application,
  authenticateBearer,
  authenticateSession,
  type ServerConfig,
  scaffoldPlan,
} from "../index.js";

const cleanups: (() => Promise<void> | void)[] = [];
const ci = process.env.CI;
beforeEach(() => {
  process.env.CI = "true";
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (ci === undefined) delete process.env.CI;
  else process.env.CI = ci;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const password = "correct horse battery staple";

/** A PostgreSQL server-profile Application with two tenants and a reference auth site. */
async function serverLab() {
  const database: TestDatabase = await createTestDatabase();
  cleanups.push(() => database.drop());
  const root = await mkdtemp(join(tmpdir(), "tm-auth-pg-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(home);
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
      masterKeyFile: join(root, "master.key"),
      backupKeyFile: join(root, "backup.key"),
      atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
    },
  };
  const open = async () => {
    const opened = await Application.open({ cwd: root, home, env: {}, server });
    cleanups.push(() => opened.close());
    return opened;
  };
  const application = await open();
  const site: ReferenceAuth = await start();
  cleanups.push(() => site.close());
  const session = async (login: string) =>
    authenticateSession(
      application,
      (await application.identityService.login({ principal: login, password })).sessionToken,
    );
  const signIn = async (login: string) => application.forIdentity(await session(login));
  return { application, open, site, session, signIn };
}

type MemberRole = "org_admin" | "maintainer" | "runner" | "reviewer" | "viewer";
type Lab = Awaited<ReturnType<typeof serverLab>>;
interface Tenant {
  workspaceId: string;
  owner: Application;
  add(login: string, role: MemberRole): Promise<Application>;
  projectId: string;
  environmentId: string;
  profileId: string;
  testId: string;
  secretId: string;
}

async function firstTenant(lab: Lab): Promise<Tenant> {
  const created = lab.application.operator.bootstrap({
    workspaceName: "Acme",
    ownerLogin: "acme-owner",
  });
  await lab.application.identityService.recover({
    principal: "acme-owner",
    recoveryToken: created.ownerRecovery.recoveryToken,
    newPassword: password,
  });
  return await populate(lab, String(created.workspace.id), await lab.signIn("acme-owner"), "acme");
}
async function secondTenant(lab: Lab): Promise<Tenant> {
  const operator = authenticateBearer(
    lab.application,
    lab.application.operator.operatorToken().token,
  );
  const created = lab.application
    .forIdentity(operator)
    .workspaces.create({ name: "Globex", ownerLogin: "globex-owner" });
  await lab.application.identityService.recover({
    principal: "globex-owner",
    recoveryToken: created.ownerRecovery.recoveryToken,
    newPassword: password,
  });
  return await populate(
    lab,
    String(created.workspace.id),
    await lab.signIn("globex-owner"),
    "globex",
  );
}
async function populate(
  lab: Lab,
  workspaceId: string,
  owner: Application,
  label: string,
): Promise<Tenant> {
  owner.preflight = async () => {};
  const project = owner.projects.create({ name: `${label}-shop` });
  const username = await owner.secrets.set(`${label}-user`, defaults.username, {
    allowedOrigins: [lab.site.url],
  });
  const secret = await owner.secrets.set(`${label}-pass`, defaults.password, {
    allowedOrigins: [lab.site.url],
  });
  const profile = await owner.authProfiles.create({
    projectId: project.id,
    name: `${label}-login`,
    kind: "form",
    originBindings: [lab.site.url],
    config: httpFormConfig(lab.site, { success: { statusIn: [200], tokenPointer: "/token" } }),
    secrets: { username: username.id, password: secret.id },
  } as never);
  const environment = owner.environments.create({
    projectId: project.id,
    name: `${label}-env`,
    baseUrl: lab.site.url,
    networkProfile: "local-loopback",
    authRefs: [profile.id],
  });
  const plan = scaffoldPlan("backend");
  const request = plan.steps.find((step) => step.operation === "request");
  if (request?.operation !== "request") throw new Error("Request step missing");
  request.input.headers = { authorization: { secretRef: profile.managedSecrets.token as string } };
  const test = owner.tests.create({ projectId: project.id, plan });
  return {
    workspaceId,
    owner,
    projectId: project.id,
    environmentId: environment.id,
    profileId: profile.id,
    testId: test.id,
    secretId: secret.id,
    async add(login, role) {
      const added = owner.members.add(workspaceId, {
        login,
        displayName: login,
        role,
        projectRestrictions: [],
      });
      await lab.application.identityService.recover({
        principal: login,
        recoveryToken: String(added.recovery?.recoveryToken),
        newPassword: password,
      });
      const member = await lab.signIn(login);
      member.preflight = async () => {};
      return member;
    },
  };
}
/** Admits a Run as `requester` and lets the controller try to start it. */
async function blockedRun(lab: Lab, tenant: Tenant, requester: Application) {
  const executions: unknown[] = [];
  vi.spyOn(AttemptExecutor.prototype, "execute").mockImplementation(async (input) => {
    executions.push(input);
    return { outcome: "passed", reasonCode: "passed", logDropped: 0, events: [] };
  });
  const receipt = await requester.runs.admit(
    {
      testId: tenant.testId,
      environmentId: tenant.environmentId,
      extensions: { "testmaster:executor": "process" },
    },
    { wait: true },
  );
  const system = lab.application.forWorkspaceSystem(tenant.workspaceId);
  system.preflight = async () => {};
  await system.worker.run({
    ephemeral: true,
    runIds: [receipt.runId],
  });
  const [checkpoint] = tenant.owner.authCheckpoints.list({ runId: receipt.runId });
  return { runId: receipt.runId, checkpoint, executions };
}

it("SEC-024 only the requester or an admin of the same workspace can resolve a checkpoint", async () => {
  const lab = await serverLab();
  const tenant = await firstTenant(lab);
  const requester = await tenant.add("requester", "maintainer");
  const peer = await tenant.add("peer-runner", "runner");
  const viewer = await tenant.add("quiet-viewer", "viewer");
  lab.site.control.captcha = true;
  const first = await blockedRun(lab, tenant, requester);
  expect(first.checkpoint).toMatchObject({ state: "pending", kind: "captcha" });
  const id = String(first.checkpoint?.id);
  for (const outsider of [peer, viewer]) {
    await expect(outsider.authCheckpoints.continue(id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(outsider.authCheckpoints.cancel(id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  }
  expect(tenant.owner.authCheckpoints.get(id).state).toBe("pending");
  lab.site.control.captcha = false;
  const resolved = await requester.authCheckpoints.continue(id);
  expect(resolved).toMatchObject({ state: "completed", resolvedBy: expect.any(String) });
  expect(resolved.resolvedBy).not.toBe(tenant.owner.me().principal.id);
  expect(first.executions).toHaveLength(0);
});

it("SEC-024 an admin of the workspace can cancel a checkpoint somebody else's Run is waiting on", async () => {
  const lab = await serverLab();
  const tenant = await firstTenant(lab);
  const requester = await tenant.add("requester", "maintainer");
  lab.site.control.captcha = true;
  const pending = await blockedRun(lab, tenant, requester);
  const id = String(pending.checkpoint?.id);
  const cancelled = await tenant.owner.authCheckpoints.cancel(id);
  expect(cancelled.state).toBe("cancelled");
  expect(cancelled.resolvedBy).toBe(tenant.owner.me().principal.id);
  await expect(requester.authCheckpoints.continue(id)).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
  expect(pending.executions).toHaveLength(0);
});

it("SEC-024 SEC-030 a checkpoint of another tenant is invisible and cannot be resolved", async () => {
  const lab = await serverLab();
  const acme = await firstTenant(lab);
  const globex = await secondTenant(lab);
  const requester = await acme.add("acme-requester", "maintainer");
  lab.site.control.captcha = true;
  const pending = await blockedRun(lab, acme, requester);
  const id = String(pending.checkpoint?.id);
  expect(() => globex.owner.authCheckpoints.get(id)).toThrowError(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  await expect(globex.owner.authCheckpoints.continue(id)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(globex.owner.authCheckpoints.cancel(id)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(globex.owner.authCheckpoints.list()).toEqual([]);
  expect(acme.owner.authCheckpoints.get(id).state).toBe("pending");
  // Raw rows seen through the tenant-scoped connection never include the other tenant's.
  expect(globex.owner.database.all("SELECT id FROM auth_checkpoints")).toEqual([]);
  expect(
    globex.owner.database
      .all("SELECT DISTINCT workspace_id FROM auth_profile_state")
      .map((row) => row.workspace_id),
  ).not.toContain(acme.workspaceId);
  expect(acme.owner.database.all("SELECT id FROM auth_checkpoints")).toHaveLength(1);
});

it("SEC-022 SEC-030 an auth profile or credential of one tenant can never be referenced from another", async () => {
  const lab = await serverLab();
  const acme = await firstTenant(lab);
  const globex = await secondTenant(lab);
  expect(() => globex.owner.authProfiles.get(acme.profileId)).toThrowError(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  expect(globex.owner.authProfiles.list().map((profile) => profile.id)).toEqual([globex.profileId]);
  await expect(
    globex.owner.authProfiles.testLogin(acme.profileId, globex.environmentId),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(() =>
    globex.owner.environments.create({
      projectId: globex.projectId,
      name: "borrowed-profile",
      baseUrl: lab.site.url,
      networkProfile: "local-loopback",
      authRefs: [acme.profileId],
    }),
  ).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  await expect(
    globex.owner.authProfiles.create({
      projectId: globex.projectId,
      name: "borrowed-secret",
      kind: "basic",
      originBindings: [lab.site.url],
      config: {},
      secrets: { username: acme.secretId, password: acme.secretId },
    } as never),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  // Same name in both tenants resolves to each tenant's own record.
  expect(acme.owner.secrets.get("acme-pass").id).toBe(acme.secretId);
  expect(() => globex.owner.secrets.get("acme-pass")).toThrowError(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  await expect(
    acme.owner.authProfiles.testLogin(acme.profileId, acme.environmentId),
  ).resolves.toMatchObject({ outcome: "authenticated" });
});

it("SEC-022 exporting a storage state needs the export permission, the caller's password and a bounded lifetime", async () => {
  const lab = await serverLab();
  const tenant = await firstTenant(lab);
  const profile = await tenant.owner.authProfiles.create({
    projectId: tenant.projectId,
    name: "manual-export",
    kind: "manual",
    originBindings: [lab.site.url],
    config: { challenge: { kind: "captcha", resolution: "storage-state" } },
    secrets: {},
  } as never);
  const hostname = new URL(lab.site.url).hostname;
  const input = await tenant.owner.secrets.set(
    "state-input",
    JSON.stringify({
      cookies: [
        { name: "session", value: "pg-export-cookie", domain: hostname, path: "/", expires: -1 },
      ],
      origins: [],
    }),
    { allowedOrigins: [lab.site.url] },
  );
  await tenant.owner.authProfiles.importState(profile.id, { inputRef: input.id, ttlSeconds: 3600 });
  const maintainer = await tenant.add("exporter", "maintainer");
  const runner = await tenant.add("plain-runner", "runner");
  const viewer = await tenant.add("plain-viewer", "viewer");
  for (const denied of [runner, viewer])
    await expect(denied.authProfiles.exportState(profile.id, { password })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  await expect(
    maintainer.authProfiles.exportState(profile.id, { password: "not the password at all" }),
  ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  await expect(
    maintainer.authProfiles.exportState(profile.id, { password, ttlSeconds: 901 }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  const exported = await maintainer.authProfiles.exportState(profile.id, {
    password,
    ttlSeconds: 300,
  });
  expect(exported.storageState).toContain("pg-export-cookie");
  expect(Date.parse(exported.exportExpiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
  // A bearer token carries no implicit export right: it needs an explicit unexpired grant.
  const principalId = maintainer.me().principal.id;
  // Issuing a token with explicit grants needs an issuer that holds those grants explicitly.
  const issuer = lab.application.forIdentity({
    ...(await lab.session("acme-owner")),
    grants: [
      {
        resourceType: "*",
        actions: ["read", "write", "execute", "admin", "export"],
        projectIds: [],
        environmentIds: [],
        expiresAt: null,
        grantedBy: tenant.owner.me().principal.id,
      },
    ],
  });
  const plain = issuer.tokens.create({
    name: "no-grant",
    scopes: ["R", "W", "X"],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    principalId,
  });
  const withoutGrant = lab.application.forIdentity(
    authenticateBearer(lab.application, plain.token),
  );
  await expect(
    withoutGrant.authProfiles.exportState(profile.id, { password }),
  ).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  const granted = issuer.tokens.create({
    principalId,
    name: "export-grant",
    scopes: ["R", "W", "X"],
    grants: [
      {
        resourceType: "SecretReference",
        actions: ["export"],
        projectIds: [tenant.projectId],
        environmentIds: [],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        grantedBy: tenant.owner.me().principal.id,
      },
    ],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const withGrant = lab.application.forIdentity(authenticateBearer(lab.application, granted.token));
  const viaToken = await withGrant.authProfiles.exportState(profile.id, {
    password,
    ttlSeconds: 300,
  });
  expect(viaToken.sha256).toBe(exported.sha256);
});

it("M4-03 SEC-023 two server processes sharing one database sign in once and never double-spend a login", async () => {
  const lab = await serverLab();
  const tenant = await firstTenant(lab);
  const second = await lab.open();
  const peer = second.forIdentity(
    authenticateSession(
      second,
      (await second.identityService.login({ principal: "acme-owner", password })).sessionToken,
    ),
  );
  lab.site.control.loginDelayMs = 600;
  const [first, other] = await Promise.all([
    tenant.owner.authProfiles.testLogin(tenant.profileId, tenant.environmentId),
    peer.authProfiles.testLogin(tenant.profileId, tenant.environmentId),
  ]);
  expect(lab.site.counters.logins).toBe(1);
  expect([first.outcome, other.outcome].sort()).toEqual(["authenticated", "authenticated"]);
});
