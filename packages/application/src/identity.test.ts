import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Role, rbacMatrix } from "@testmaster/contracts";
import { afterEach, expect, it, vi } from "vitest";
import {
  Application,
  authenticateBearer,
  authenticateSession,
  insertToken,
  issueLocalToken,
  lockoutPolicy,
  type PermissionGrant,
  scaffoldPlan,
  sessionPolicy,
} from "./index.js";

const roots: string[] = [];
const apps: Application[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const password = "correct horse battery staple";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tm-identity-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home, env: {} });
  apps.push(app);
  const init = await app.init();
  let counter = 0;
  /** Adds a member, sets their password through the recovery flow and returns their session. */
  const member = async (role: Role, projectRestrictions: string[] = []) => {
    const login = `${role.replace("_", "-")}-${++counter}`;
    const added = app.members.add(init.workspaceId, {
      login,
      displayName: login,
      role,
      projectRestrictions,
    });
    if (added.recovery)
      await app.identityService.recover({
        principal: login,
        recoveryToken: added.recovery.recoveryToken,
        newPassword: password,
      });
    return { login, view: added.member, recovery: added.recovery };
  };
  const session = async (login: string) => {
    const result = await app.identityService.login({ principal: login, password });
    const identity = authenticateSession(app, result.sessionToken);
    return { ...result, identity, scoped: app.forIdentity(identity) };
  };
  return { app, init, member, session };
}

it("ADR-017 locks a credential after ten failures with the same generic error and unlocks after fifteen minutes", async () => {
  const { app, member } = await fixture();
  const owner = await member("maintainer");
  vi.useFakeTimers({ toFake: ["Date"] });
  const wrong = () =>
    app.identityService.login({ principal: owner.login, password: "wrong wrong wrong" });
  const failure = await wrong().catch((error) => error);
  const unknown = await app.identityService
    .login({ principal: "nobody-here", password: "wrong wrong wrong" })
    .catch((error) => error);
  expect(failure).toMatchObject({ code: "UNAUTHENTICATED", message: "Invalid credentials" });
  expect(unknown.code).toBe(failure.code);
  expect(unknown.message).toBe(failure.message);
  for (let index = 1; index < lockoutPolicy.maxFailures; index++) await wrong().catch(() => {});
  // The correct password is refused while the credential is locked, with the same generic error.
  await expect(
    app.identityService.login({ principal: owner.login, password }),
  ).rejects.toMatchObject({ code: "UNAUTHENTICATED", message: "Invalid credentials" });
  vi.setSystemTime(Date.now() + lockoutPolicy.lockMs + 1000);
  const receipt = await app.identityService.login({ principal: owner.login, password });
  expect(receipt.receipt.state).toBe("authenticated");
});

it("ADR-017 expires sessions at the idle and absolute limits, and activity extends only the idle window", async () => {
  const { app, member, session } = await fixture();
  const user = await member("maintainer");
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.now();
  const idle = await session(user.login);
  expect(authenticateSession(app, idle.sessionToken).workspaceId).toBe(idle.identity.workspaceId);
  vi.setSystemTime(start + sessionPolicy.idleMs + 1000);
  expect(() => authenticateSession(app, idle.sessionToken)).toThrowError(
    expect.objectContaining({ code: "UNAUTHENTICATED" }),
  );
  // Activity inside the idle window keeps a session alive until the absolute limit.
  vi.setSystemTime(start);
  const active = await session(user.login);
  for (let minute = 20; minute <= 700; minute += 20) {
    vi.setSystemTime(start + minute * 60_000);
    authenticateSession(app, active.sessionToken);
  }
  vi.setSystemTime(start + sessionPolicy.absoluteMs - 60_000);
  authenticateSession(app, active.sessionToken);
  vi.setSystemTime(start + sessionPolicy.absoluteMs + 1000);
  expect(() => authenticateSession(app, active.sessionToken)).toThrowError(
    expect.objectContaining({ code: "UNAUTHENTICATED" }),
  );
});

it("ADR-017 recovery tokens work once within thirty minutes and revoke every session of the principal", async () => {
  const { app, init, member, session } = await fixture();
  const user = await member("maintainer");
  const live = await session(user.login);
  const grant = app.identityService.issueRecoveryToken(user.login);
  await expect(
    app.identityService.recover({
      principal: user.login,
      recoveryToken: `${grant.recoveryToken.slice(0, -1)}${grant.recoveryToken.endsWith("A") ? "B" : "A"}`,
      newPassword: "another long password",
    }),
  ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  const receipt = await app.identityService.recover({
    principal: user.login,
    recoveryToken: grant.recoveryToken,
    newPassword: "another long password",
  });
  expect(receipt.workspaceId).toBe(init.workspaceId);
  expect(() => authenticateSession(app, live.sessionToken)).toThrowError(
    expect.objectContaining({ code: "UNAUTHENTICATED" }),
  );
  await expect(
    app.identityService.recover({
      principal: user.login,
      recoveryToken: grant.recoveryToken,
      newPassword: "third long password",
    }),
  ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  const expiring = app.identityService.issueRecoveryToken(user.login);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 31 * 60_000);
  await expect(
    app.identityService.recover({
      principal: user.login,
      recoveryToken: expiring.recoveryToken,
      newPassword: "fourth long password",
    }),
  ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
});

it("ADR-017 distinguishes bearer token kinds, refuses worker tokens as bearers and honors revocation and expiry", async () => {
  const { app, init } = await fixture();
  const local = await issueLocalToken(app);
  expect(authenticateBearer(app, local.token).credential.kind).toBe("local");
  const created = app.tokens.create({
    name: "ci",
    scopes: ["R"],
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  expect(created.token.startsWith("tm_api_")).toBe(true);
  const identity = authenticateBearer(app, created.token);
  expect(identity).toMatchObject({
    workspaceId: init.workspaceId,
    credential: { kind: "api" },
    scopes: ["R"],
  });
  // A read-only token cannot write, a worker-prefixed secret is never a bearer.
  expect(() =>
    app
      .forIdentity(identity)
      .tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") }),
  ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  // A stored, unexpired worker-enrollment token still never authenticates an API request.
  const worker = insertToken(app.database, {
    workspaceId: init.workspaceId,
    principalId: init.principalId,
    kind: "worker",
    name: "enrollment",
    scopes: ["R"],
    grants: [],
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  expect(worker.token.startsWith("tm_wrk_")).toBe(true);
  expect(() => authenticateBearer(app, worker.token)).toThrowError(
    expect.objectContaining({ code: "UNAUTHENTICATED" }),
  );
  expect(() => authenticateBearer(app, "tm_unknown_token")).toThrowError(
    expect.objectContaining({ code: "UNAUTHENTICATED" }),
  );
  app.tokens.revoke(created.metadata.id);
  expect(() => authenticateBearer(app, created.token)).toThrowError(
    expect.objectContaining({ code: "UNAUTHENTICATED" }),
  );
  const short = app.tokens.create({
    name: "short",
    scopes: ["R"],
    expiresAt: new Date(Date.now() + 5000).toISOString(),
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 10_000);
  expect(() => authenticateBearer(app, short.token)).toThrowError(
    expect.objectContaining({ code: "UNAUTHENTICATED" }),
  );
});

it("ADR-017 refuses self-promotion and removing or demoting the last org_owner", async () => {
  const { app, init, member, session } = await fixture();
  const admin = await member("org_admin");
  const adminSession = await session(admin.login);
  for (const role of ["org_owner", "maintainer"] as const)
    expect(() =>
      adminSession.scoped.members.update(
        init.workspaceId,
        admin.view.id,
        { role },
        admin.view.version,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN", details: { reason: "self_promotion" } }),
    );
  // Positive control: someone else can change that membership.
  const changed = app.members.update(
    init.workspaceId,
    admin.view.id,
    { role: "maintainer" },
    admin.view.version,
  );
  expect(changed.role).toBe("maintainer");
  const owners = app.members.list(init.workspaceId).filter((item) => item.role === "org_owner");
  expect(owners).toHaveLength(1);
  const only = owners[0];
  if (!only) throw new Error("The workspace owner must exist");
  expect(() =>
    app.members.update(init.workspaceId, only.id, { role: "viewer" }, only.version),
  ).toThrowError(
    expect.objectContaining({
      code: "PRECONDITION_FAILED",
      message: "Workspace needs an org_owner",
    }),
  );
  expect(() => app.members.remove(init.workspaceId, only.id)).toThrowError(
    expect.objectContaining({
      code: "PRECONDITION_FAILED",
      message: "Workspace needs an org_owner",
    }),
  );
  const second = await member("org_owner");
  // A second owner may demote the first; the first owner still cannot change their own membership.
  const secondSession = await session(second.login);
  expect(
    secondSession.scoped.members.update(init.workspaceId, only.id, { role: "viewer" }, only.version)
      .role,
  ).toBe("viewer");
  expect(second.view.role).toBe("org_owner");
});

it("ADR-017 matches grants by resource type and never lets a grant widen a denied role column", async () => {
  const { app, init, member } = await fixture();
  const viewer = await member("viewer");
  const service = await member("service_account");
  const grant = (resourceType: string, actions: PermissionGrant["actions"]): PermissionGrant => ({
    resourceType,
    actions,
    projectIds: [init.projectId],
    environmentIds: [],
    expiresAt: null,
    grantedBy: init.principalId,
  });
  const identityFor = (principalId: string, grants: PermissionGrant[]) =>
    app.forIdentity({
      principalId,
      scopes: ["R", "W", "X", "A"],
      grants,
      workspaceId: init.workspaceId,
      credential: { kind: "api", id: "tok_test" },
    });
  const create = (scoped: Application) =>
    scoped.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  // Grant-only service accounts: a grant for another resource type does not widen generic scope.
  expect(() =>
    create(identityFor(service.view.principalId, [grant("Run", ["write"])])),
  ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  expect(() => create(identityFor(service.view.principalId, []))).toThrowError(
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
  expect(create(identityFor(service.view.principalId, [grant("*", ["write"])])).id).toMatch(
    /^tst_/,
  );
  // `deny` is absolute for the viewer role: even a wildcard grant cannot widen it.
  expect(() => create(identityFor(viewer.view.principalId, [grant("*", ["write"])]))).toThrowError(
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
});

it("ADR-017 exposes the role matrix as the permissions each role observes", async () => {
  const { app, init, member, session } = await fixture();
  const columns = ["read", "write", "execute", "secret", "export", "admin"] as const;
  for (const role of Object.keys(rbacMatrix) as Role[]) {
    if (role === "service_account") continue;
    const user = await member(role);
    const { scoped } = await session(user.login);
    const observed = scoped.me().permissions;
    for (const column of columns)
      expect(observed[column], `${role}.${column}`).toBe(rbacMatrix[role][column] === "allow");
  }
  expect(app.me().membership.principalId).toBe(init.principalId);
});

it("ADR-017 requires the secret column to write secrets and the export column to export code", async () => {
  const { app, init, member, session } = await fixture();
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  for (const role of ["runner", "viewer", "reviewer"] as const) {
    const user = await member(role);
    const { scoped } = await session(user.login);
    await expect(scoped.secrets.set("token", "value-1234567")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  }
  const maintainer = await session((await member("maintainer")).login);
  expect((await maintainer.scoped.secrets.set("token", "value-1234567")).id).toMatch(/^sec_/);
  // Reviewers may export (redacted) code; viewers may not.
  const viewer = await session((await member("viewer")).login);
  await expect(
    viewer.scoped.codeExport.export(test.id, { format: "playwright" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  const reviewer = await session((await member("reviewer")).login);
  await expect(
    reviewer.scoped.codeExport.export(test.id, { format: "playwright", out: "reviewer-code" }),
  ).resolves.toBeDefined();
});

it("ADR-017 only operator tokens create workspaces and the single-user profile refuses extra workspaces", async () => {
  const { app } = await fixture();
  expect(() => app.workspaces.create({ name: "other", ownerLogin: "other-owner" })).toThrowError(
    expect.objectContaining({ code: "FORBIDDEN", details: { reason: "operator_required" } }),
  );
  const operator = app.operator.operatorToken();
  expect(operator.token.startsWith("tm_op_")).toBe(true);
  const identity = authenticateBearer(app, operator.token);
  expect(identity.credential.kind).toBe("operator");
  // Positive control for the operator gate: the token passes it; SQLite then refuses a second
  // workspace by engine rule, PostgreSQL creates it.
  const create = () =>
    app.forIdentity(identity).workspaces.create({ name: "other", ownerLogin: "other-owner" });
  if (app.database.engine === "postgres") {
    expect(create().ownerLogin).toBe("other-owner");
    expect(app.operator.workspaceIds()).toHaveLength(2);
  } else {
    expect(create).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
    expect(app.operator.workspaceIds()).toHaveLength(1);
  }
});

it("ADR-017 ends a queued Run blocked with actor_revoked when its admitting member loses execute access", async () => {
  const { app, init, member, session } = await fixture();
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  const user = await member("maintainer");
  const { scoped, identity } = await session(user.login);
  scoped.preflight = async () => {};
  const receipt = await scoped.runs.admit(
    { testId: test.id, environmentId: init.environmentId },
    { wait: true },
  );
  const stored = app.runs.get(receipt.runId);
  expect((stored.matrixCell as { actor: { principalId: string } }).actor.principalId).toBe(
    user.view.principalId,
  );
  const actor = {
    principalId: user.view.principalId,
    credentialKind: "session",
    credentialId: identity.credential.id,
  };
  expect(app.forIdentity(identity).context.reauthorizeActor(actor, init.projectId)).toBe(true);
  app.members.update(init.workspaceId, user.view.id, { role: "viewer" }, user.view.version);
  expect(app.forIdentity(identity).context.reauthorizeActor(actor, init.projectId)).toBe(false);
  await app.worker.run({ ephemeral: true, runIds: [receipt.runId] });
  const blocked = app.runs.get(receipt.runId);
  expect(blocked).toMatchObject({ phase: "completed", status: "blocked", outcome: "blocked" });
  expect(app.database.all("SELECT id FROM attempts WHERE run_id=?", receipt.runId)).toHaveLength(0);
  const completed = app.runs.events(receipt.runId).find((event) => event.type === "run.completed");
  expect(completed?.payload).toMatchObject({ outcome: "blocked", reasonCode: "actor_revoked" });
});

it("ADR-017 treats a revoked session or token of the admitting actor as revoked access", async () => {
  const { app, init, member, session } = await fixture();
  const user = await member("maintainer");
  const live = await session(user.login);
  const actor = {
    principalId: user.view.principalId,
    credentialKind: "session",
    credentialId: live.identity.credential.id,
  };
  expect(app.forIdentity(live.identity).context.reauthorizeActor(actor, init.projectId)).toBe(true);
  live.scoped.identityService.logout();
  expect(app.forIdentity(live.identity).context.reauthorizeActor(actor, init.projectId)).toBe(
    false,
  );
});
