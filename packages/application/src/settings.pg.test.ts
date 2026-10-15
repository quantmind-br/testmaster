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
} from "./index.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const password = "correct horse battery staple";

/** Two workspaces on one PostgreSQL database, each with a signed-in owner. */
async function twoWorkspaces() {
  const database: TestDatabase = await createTestDatabase();
  cleanups.push(() => database.drop());
  const root = await mkdtemp(join(tmpdir(), "tm-settings-pg-"));
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
  const acmeCreated = application.operator.bootstrap({
    workspaceName: "Acme",
    ownerLogin: "acme-owner",
  });
  const operator = authenticateBearer(application, application.operator.operatorToken().token);
  const globexCreated = application
    .forIdentity(operator)
    .workspaces.create({ name: "Globex", ownerLogin: "globex-owner" });
  const signIn = async (login: string, recoveryToken: string) => {
    await application.identityService.recover({
      principal: login,
      recoveryToken,
      newPassword: password,
    });
    const result = await application.identityService.login({ principal: login, password });
    return application.forIdentity(authenticateSession(application, result.sessionToken));
  };
  const acme = await signIn("acme-owner", acmeCreated.ownerRecovery.recoveryToken);
  const globex = await signIn("globex-owner", globexCreated.ownerRecovery.recoveryToken);
  const project = acme.projects.create({ name: "Acme shop" });
  const environment = acme.environments.create({
    projectId: project.id,
    name: "local",
    baseUrl: "http://127.0.0.1:9",
  });
  const secret = await acme.secrets.set("acme-token", "ACME-CANARY-0001", { ephemeral: true });
  return { application, acme, globex, project, environment, secret };
}
const notFound = expect.objectContaining({ code: "NOT_FOUND" });

it("UX-046 answers another workspace's secret with not found for history and rotation", async () => {
  const { acme, globex, secret } = await twoWorkspaces();
  expect(() => globex.secrets.history(secret.id)).toThrowError(notFound);
  await expect(globex.secrets.rotate(secret.id, "GLOBEX-CANARY-0002")).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  // Positive control: the owner reads the history and the rotation left no trace in the other tenant.
  expect(acme.secrets.history(secret.id).map((record) => record.event)).toEqual(["created"]);
  expect(acme.secrets.get(secret.id).secretVersion).toBe(1);
  expect(globex.secrets.list()).toEqual([]);
});

it("UX-048 answers another workspace's project and operations with not found and never lists them", async () => {
  const { acme, globex, project } = await twoWorkspaces();
  const archived = acme.projects.archive(project.id, Number(acme.projects.get(project.id).version));
  expect(() => globex.retention.purgeProject(archived.id, String(archived.slug))).toThrowError(
    notFound,
  );
  expect(() => globex.retention.listDeletionOperations({ projectId: project.id })).toThrowError(
    notFound,
  );
  const operation = acme.retention.purgeProject(archived.id, String(archived.slug));
  expect(operation.physicalState).toBe("completed");
  expect(() => globex.retention.deletionStatus(operation.id)).toThrowError(notFound);
  expect(globex.retention.listDeletionOperations()).toEqual([]);
  // Positive control: the owning workspace sees its operation in both list forms.
  expect(acme.retention.listDeletionOperations().map((entry) => entry.id)).toEqual([operation.id]);
  expect(
    acme.retention.listDeletionOperations({ projectId: project.id }).map((entry) => entry.id),
  ).toEqual([operation.id]);
});

it("UX-047 answers another workspace's project with not found for model provider settings", async () => {
  const { acme, globex, project } = await twoWorkspaces();
  expect(() => globex.model.settings(project.id)).toThrowError(notFound);
  // Positive control: the owner reads the settings.
  expect(acme.model.settings(project.id).projectId).toBe(project.id);
});

it("M4-05 answers another workspace's environment with not found for revisions", async () => {
  const { acme, globex, environment } = await twoWorkspaces();
  expect(() => globex.environments.revisions(environment.id)).toThrowError(notFound);
  expect(acme.environments.revisions(environment.id)).toHaveLength(1);
});
