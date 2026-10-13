import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@testmaster/persistence/testing";
import { afterEach, expect, it } from "vitest";
import {
  Application,
  authenticateBearer,
  authenticateSession,
  type ServerConfig,
  scaffoldPlan,
} from "./index.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const password = "correct horse battery staple";

async function serverApplication() {
  const database: TestDatabase = await createTestDatabase();
  cleanups.push(() => database.drop());
  const root = await mkdtemp(join(tmpdir(), "tm-identity-pg-"));
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
  const application = await Application.open({ cwd: root, home, env: {}, server });
  cleanups.push(() => application.close());
  return { application, database, root };
}

it("ADR-017 bootstraps the first workspace on PostgreSQL once and refuses service calls without an identity", async () => {
  const { application } = await serverApplication();
  const created = application.operator.bootstrap({
    workspaceName: "Acme",
    ownerLogin: "acme-owner",
  });
  expect(created.ownerLogin).toBe("acme-owner");
  expect(application.operator.workspaceIds()).toEqual([String(created.workspace.id)]);
  expect(() =>
    application.operator.bootstrap({ workspaceName: "Again", ownerLogin: "second" }),
  ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  // The server profile never guesses a workspace: a call without identity is unauthenticated.
  expect(() => application.projects.list()).toThrowError(
    expect.objectContaining({ code: "UNAUTHENTICATED" }),
  );
  await expect(application.init()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
});

it("ADR-017 lets an operator token create further workspaces whose owners sign in with a recovery token", async () => {
  const { application } = await serverApplication();
  const first = application.operator.bootstrap({ workspaceName: "Acme", ownerLogin: "acme-owner" });
  const operator = application.operator.operatorToken();
  const identity = authenticateBearer(application, operator.token);
  const second = application.forIdentity(identity).workspaces.create({
    name: "Globex",
    ownerLogin: "globex-owner",
  });
  expect(application.operator.workspaceIds()).toHaveLength(2);
  expect(second.workspace.id).not.toBe(first.workspace.id);
  await application.identityService.recover({
    principal: "globex-owner",
    recoveryToken: second.ownerRecovery.recoveryToken,
    newPassword: password,
  });
  const login = await application.identityService.login({ principal: "globex-owner", password });
  const session = authenticateSession(application, login.sessionToken);
  expect(session.workspaceId).toBe(String(second.workspace.id));
  // Negative control: a member token cannot create workspaces.
  await application.identityService.recover({
    principal: "acme-owner",
    recoveryToken: first.ownerRecovery.recoveryToken,
    newPassword: password,
  });
  const acme = authenticateSession(
    application,
    (await application.identityService.login({ principal: "acme-owner", password })).sessionToken,
  );
  expect(() =>
    application.forIdentity(acme).workspaces.create({ name: "Rogue", ownerLogin: "rogue-owner" }),
  ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  expect(application.operator.workspaceIds()).toHaveLength(2);
});

it("ADR-017 keeps a login globally unique and scopes sessions and recovery to their workspace on PostgreSQL", async () => {
  const { application } = await serverApplication();
  const first = application.operator.bootstrap({
    workspaceName: "Acme",
    ownerLogin: "shared-name",
  });
  const operator = authenticateBearer(application, application.operator.operatorToken().token);
  expect(() =>
    application
      .forIdentity(operator)
      .workspaces.create({ name: "Globex", ownerLogin: "shared-name" }),
  ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  expect(application.operator.workspaceIds()).toEqual([String(first.workspace.id)]);
});

it("ADR-017 ends a queued Run blocked with actor_revoked on PostgreSQL when the member is demoted", async () => {
  const { application } = await serverApplication();
  const created = application.operator.bootstrap({
    workspaceName: "Acme",
    ownerLogin: "acme-owner",
  });
  const workspaceId = String(created.workspace.id);
  await application.identityService.recover({
    principal: "acme-owner",
    recoveryToken: created.ownerRecovery.recoveryToken,
    newPassword: password,
  });
  const owner = application.forIdentity(
    authenticateSession(
      application,
      (await application.identityService.login({ principal: "acme-owner", password })).sessionToken,
    ),
  );
  const project = owner.projects.create({ name: "Shop" });
  const environment = owner.environments.create({
    projectId: project.id,
    name: "local",
    baseUrl: "http://127.0.0.1:9",
  });
  const test = owner.tests.create({ projectId: project.id, plan: scaffoldPlan("backend") });
  const added = owner.members.add(workspaceId, {
    login: "maintainer-one",
    displayName: "Maintainer",
    role: "maintainer",
    projectRestrictions: [],
  });
  await application.identityService.recover({
    principal: "maintainer-one",
    recoveryToken: String(added.recovery?.recoveryToken),
    newPassword: password,
  });
  const maintainer = application.forIdentity(
    authenticateSession(
      application,
      (await application.identityService.login({ principal: "maintainer-one", password }))
        .sessionToken,
    ),
  );
  maintainer.preflight = async () => {};
  const receipt = await maintainer.runs.admit(
    { testId: test.id, environmentId: environment.id },
    { wait: true },
  );
  owner.members.update(workspaceId, added.member.id, { role: "viewer" }, added.member.version);
  await application.forWorkspaceSystem(workspaceId).worker.run({
    ephemeral: true,
    runIds: [receipt.runId],
  });
  expect(owner.runs.get(receipt.runId)).toMatchObject({ phase: "completed", status: "blocked" });
  expect(
    owner.runs.events(receipt.runId).find((event) => event.type === "run.completed")?.payload,
  ).toMatchObject({ reasonCode: "actor_revoked" });
});
