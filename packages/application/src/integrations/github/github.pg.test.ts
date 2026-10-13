import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubDefaultScopes, githubEventTypes } from "@testmaster/contracts";
import { createTestDatabase } from "@testmaster/persistence/testing";
import { afterEach, expect, it } from "vitest";
import { authenticateSession } from "../../identity.js";
import type { ServerConfig } from "../../server-config.js";
import { authenticateBearer } from "../../tokens.js";
import { type GithubWorld, startGithubWorld } from "./testing/world.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b1".repeat(20);
const TABLES = ["github_installations", "github_repositories", "github_pulls", "github_deployments", "github_checks"];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Workspace A (the world) and workspace B in one PostgreSQL database, each with its own GitHub App integration. */
async function twoTenants() {
  const database = await createTestDatabase();
  const directory = await mkdtemp(join(tmpdir(), "tm-github-pg-"));
  await mkdir(join(directory, "evidence"), { recursive: true });
  const server: ServerConfig = {
    mode: "server",
    database: { engine: "postgres", ...database.config },
    storage: { kind: "filesystem", root: join(directory, "evidence") },
    server: {
      listen: { host: "127.0.0.1", port: 0 },
      publicOrigin: "https://testmaster.example.test",
      trustedProxies: [],
      origins: ["https://testmaster.example.test"],
    },
    security: {
      masterKeyFile: join(directory, "master.key"),
      backupKeyFile: join(directory, "backup.key"),
      atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
    },
  };
  const world: GithubWorld = await startGithubWorld({ server });
  cleanups.push(async () => {
    await world.stop();
    await database.drop();
    await rm(directory, { recursive: true, force: true });
  });
  const runtime = world.runtime;
  const operator = runtime.forIdentity(authenticateBearer(runtime, runtime.operator.operatorToken().token));
  const created = operator.workspaces.create({ name: "Globex", ownerLogin: "globex-owner" });
  const password = "correct horse battery staple";
  await runtime.identityService.recover({
    principal: "globex-owner",
    recoveryToken: created.ownerRecovery.recoveryToken,
    newPassword: password,
  });
  const login = await runtime.identityService.login({ principal: "globex-owner", password });
  const b = runtime.forIdentity(authenticateSession(runtime, login.sessionToken));
  const project = b.projects.create({ name: "globex-project" });
  const origin = new URL(world.fake.url).origin;
  const privateKeyRef = (await b.secrets.set("github-private-key", world.fake.privateKeyPem, { allowedOrigins: [origin] })).id;
  const webhookSecretRef = (await b.secrets.set("github-webhook-secret", "globex-webhook-secret", { allowedOrigins: [origin] })).id;
  const integrationB = b.integrations.create({
    provider: "github",
    name: "globex-app",
    projectIds: [project.id],
    events: [...githubEventTypes],
    consent: { scopes: [...githubDefaultScopes] },
    secretRefs: [privateKeyRef, webhookSecretRef],
    settings: {
      appId: "9002",
      appSlug: "globex-app",
      publicOrigin: "https://testmaster.example.test",
      allowAgentPullRequests: false,
      credentials: { privateKeyRef, webhookSecretRef, previousWebhookSecretRef: null, previousWebhookSecretExpiresAt: null, clientSecretRef: null },
    },
  } as never);
  world.fake.install({ id: 888, repositories: [{ id: 502, fullName: "globex/shop" }] });
  const deliverB = (event: string, payload: unknown, deliveryId: string) =>
    runtime
      .controllerScope()
      .integrations.receiveWebhook("github", world.fake.signedRequest(event, payload, { secret: "globex-webhook-secret", appId: 9002, deliveryId }));
  return {
    world,
    b,
    integrationB,
    workspaceA: world.app.context.workspaceId,
    workspaceB: String(created.workspace.id),
    deliverB,
  };
}

it("INT-014 INT-002 PostgreSQL row-level security hides one workspace's GitHub installations, pulls, checks and deployments from another", async () => {
  const { world, integrationB, workspaceA, workspaceB, deliverB } = await twoTenants();
  const installationB = world.fake.installations.get(888);
  if (!installationB) throw new Error("fake installation missing");
  expect(await deliverB("installation", world.fake.installationPayload("created", installationB), "b-install")).toMatchObject({ outcome: "accepted" });
  await world.install();
  await world.openPr(7, SHA_A);
  await world.deploy(1, SHA_A);
  await world.drive();
  expect(world.checks(SHA_A).map((check) => check.conclusion)).toEqual(["success", "success"]);
  const scoped = (workspace: string) => world.runtime.database.forWorkspace(workspace);
  for (const table of TABLES) {
    const own = scoped(workspaceA).all(`SELECT DISTINCT workspace_id FROM ${table}`);
    expect(own.every((row) => row.workspace_id === workspaceA), table).toBe(true);
    // Negative control: a raw query scoped to A that names B's workspace still sees nothing of B's.
    expect(scoped(workspaceA).all(`SELECT 1 AS one FROM ${table} WHERE workspace_id=?`, workspaceB), table).toEqual([]);
  }
  // Positive control: B's own scope sees B's installation and A's rows are invisible to it.
  expect(scoped(workspaceB).all("SELECT installation_id FROM github_installations")).toEqual([{ installation_id: "888" }]);
  expect(scoped(workspaceB).all("SELECT 1 AS one FROM github_pulls")).toEqual([]);
  expect(scoped("*").all("SELECT installation_id FROM github_installations ORDER BY installation_id").map((row) => row.installation_id)).toEqual(["777", "888"]);
  // Writes are isolated too: A's scope cannot revoke or delete B's installation, even naming it exactly.
  expect(scoped(workspaceA).run("UPDATE github_installations SET state='revoked' WHERE installation_id='888'").changes).toBe(0);
  expect(scoped(workspaceA).run("DELETE FROM github_installations WHERE installation_id='888'").changes).toBe(0);
  expect(scoped(workspaceB).all("SELECT state FROM github_installations")).toEqual([{ state: "active" }]);
  expect(integrationB.id).not.toBe(world.integration.id);
});

it("INT-014 SEC-047 a tenant cannot claim another tenant's installation or read its management views by ID", async () => {
  const { world, b, integrationB, deliverB } = await twoTenants();
  const installationB = world.fake.installations.get(888);
  if (!installationB) throw new Error("fake installation missing");
  await deliverB("installation", world.fake.installationPayload("created", installationB), "b-install");
  // A's App, with A's valid signature, cannot take over B's installation.
  const claim = await world.send("installation", world.fake.installationPayload("created", installationB));
  expect(claim).toMatchObject({ outcome: "ignored", ignoredReason: "installation_owned_elsewhere" });
  // A pull request event for B's installation signed by A is ignored; signed by B it is B's.
  const repositoryB = { id: 502, fullName: "globex/shop" };
  const payload = world.fake.pullRequestPayload({ installationId: 888, repository: repositoryB, number: 3, headSha: SHA_B });
  expect(await world.send("pull_request", payload)).toMatchObject({ outcome: "ignored", ignoredReason: "unknown_installation" });
  // Management views are workspace-scoped: another tenant's integration ID does not exist.
  expect(() => b.github.installations(world.integration.id)).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  expect(() => world.app.github.pulls(integrationB.id)).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  expect(b.github.installations(integrationB.id).map((installation) => installation.installationId)).toEqual(["888"]);
});
