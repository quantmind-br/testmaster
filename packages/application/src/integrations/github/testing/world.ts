import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GithubRepositoryPatch,
  githubDefaultScopes,
  githubEventTypes,
  type InboundWebhookReceipt,
  type IntegrationMetadata,
} from "@testmaster/contracts";
import { Application } from "../../../application.js";
import { scaffoldPlan } from "../../../authoring.js";
import { authenticateSession } from "../../../identity.js";
import type { ServerConfig } from "../../../server-config.js";
import { type DeliverOptions, FakeGithub, type FakeRepository } from "./fake-github.js";

export interface WorldOptions {
  /** Run on PostgreSQL as a server-profile deployment: one workspace and an owner session. */
  server?: ServerConfig;
  /** `process` (default) replaces the sandbox with the unsafe-local executor; `docker` runs the real sandbox. */
  executor?: "process" | "docker";
  /** Add `contents: write` to the installation and `allowAgentPullRequests` to the integration. */
  agentPullRequests?: boolean;
  installationPermissions?: Record<string, "read" | "write">;
}
/** A complete GitHub App deployment against the fake: Application, fake GitHub, preview target and clock. */
export interface GithubWorld {
  /** The application the test acts through: the root instance on SQLite, the owner's workspace-bound one on PostgreSQL. */
  app: Application;
  /** The process-wide instance (controller scopes, HTTP server). */
  runtime: Application;
  fake: FakeGithub;
  clock: { t: number };
  /** The preview origin every deployment points at; `healthy` flips `/health` to a 500. */
  target: { origin: string; healthy: boolean; hits: string[]; redirect: string | null };
  projectId: string;
  environmentId: string;
  testId: string;
  integration: IntegrationMetadata;
  repository: FakeRepository;
  installationId: number;
  secrets: { privateKeyRef: string; webhookSecretRef: string };
  /** Addresses a preview hostname resolves to; every unlisted host resolves to loopback. */
  resolutions: Map<string, string[]>;
  send(event: string, payload: unknown, options?: DeliverOptions): Promise<InboundWebhookReceipt>;
  configureRepository(patch?: GithubRepositoryPatch): void;
  /** Delivers the `installation created` webhook and binds the repository to the project. */
  install(): Promise<void>;
  openPr(
    number: number,
    headSha: string,
    extra?: {
      action?: string;
      draft?: boolean;
      fork?: { fullName: string };
      state?: "open" | "closed";
      headRef?: string;
      deliver?: DeliverOptions;
    },
  ): Promise<InboundWebhookReceipt>;
  deploy(
    deploymentId: number,
    sha: string,
    extra?: { url?: string | null; environment?: string; state?: string },
  ): Promise<InboundWebhookReceipt>;
  /** The stored pull row for one head commit. */
  pull(headSha: string): Record<string, unknown>;
  /** What GitHub currently shows for the commit, ordered by check name as published. */
  checks(headSha: string): {
    name: string;
    status: string;
    conclusion: string | null;
    title: string;
    summary: string;
    detailsUrl: string | null;
  }[];
  /** Runs reconcile ticks and ephemeral workers until no pull is awaiting a result. */
  drive(maxTicks?: number): Promise<void>;
  stop(): Promise<void>;
}

export async function startGithubWorld(options: WorldOptions = {}): Promise<GithubWorld> {
  const docker = options.executor === "docker";
  const resolutions = new Map<string, string[]>();
  const root = await mkdtemp(join(tmpdir(), "tm-github-"));
  const home = join(root, "home");
  await mkdir(join(home, ".config", "testmaster"), { recursive: true });
  if (!docker)
    await writeFile(
      join(home, ".config", "testmaster", "policy.json"),
      JSON.stringify({ security: { allowUnsafeProcessExecution: true } }),
    );
  // Starts at the real time: server cursors cut off at the wall clock, so a fake future would hide every row.
  const clock = { t: Date.now() };
  const target = { origin: "", healthy: true, hits: [] as string[], redirect: null as string | null };
  const server: Server = createServer((request, response) => {
    target.hits.push(`${request.method} ${request.url}`);
    if (target.redirect) {
      response.writeHead(302, { location: target.redirect });
      response.end();
      return;
    }
    response.writeHead(target.healthy ? 200 : 500, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: target.healthy ? "ok" : "down" }));
  });
  await new Promise<void>((resolve) => server.listen(0, docker ? "0.0.0.0" : "127.0.0.1", resolve));
  target.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fake = await FakeGithub.start({ now: () => clock.t });
  const runtime = await Application.open({
    cwd: root,
    home,
    env: docker ? {} : { TESTMASTER_EXECUTOR: "process" },
    ...(options.server ? { server: options.server } : {}),
    github: {
      apiBaseUrl: fake.url,
      now: () => clock.t,
      sleep: () => Promise.resolve(),
      resolveHost: (host) => Promise.resolve(resolutions.get(host) ?? ["127.0.0.1"]),
      random: () => 0.5,
    },
  });
  const app = options.server ? await signInOwner(runtime) : runtime;
  // The acting application of an integration is a separate instance, so the stub lives on the class
  // for the lifetime of the world: the process executor here replaces Docker only inside tests.
  const originalPreflight = Application.prototype.preflight;
  if (!docker) Application.prototype.preflight = async () => {};
  const init = options.server ? seedServerProject(app) : await app.init();
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  const origin = new URL(fake.url).origin;
  const privateKeyRef = (await app.secrets.set("github-private-key", fake.privateKeyPem, { allowedOrigins: [origin] })).id;
  const webhookSecretRef = (await app.secrets.set("github-webhook-secret", fake.webhookSecret, { allowedOrigins: [origin] })).id;
  const integration = app.integrations.create({
    provider: "github",
    name: "github-app",
    projectIds: [init.projectId],
    events: [...githubEventTypes],
    consent: { scopes: [...githubDefaultScopes, ...(options.agentPullRequests ? ["github:contents:write"] : [])] },
    secretRefs: [privateKeyRef, webhookSecretRef],
    settings: {
      appId: String(fake.appId),
      appSlug: fake.slug,
      publicOrigin: "https://testmaster.example.test",
      allowAgentPullRequests: options.agentPullRequests === true,
      credentials: {
        privateKeyRef,
        webhookSecretRef,
        previousWebhookSecretRef: null,
        previousWebhookSecretExpiresAt: null,
        clientSecretRef: null,
      },
    },
  } as never);
  const repository: FakeRepository = { id: 501, fullName: "acme/shop" };
  const installationId = 777;
  fake.install({
    id: installationId,
    repositories: [repository],
    ...(options.installationPermissions
      ? { permissions: options.installationPermissions }
      : options.agentPullRequests
        ? { permissions: { metadata: "read", contents: "write", checks: "write", pull_requests: "write", deployments: "read" } }
        : {}),
  });
  fake.branchHeads.set(`${repository.fullName}:main`, "b".repeat(40));
  const world: GithubWorld = {
    app,
    fake,
    clock,
    target,
    projectId: init.projectId,
    environmentId: init.environmentId,
    testId: test.id,
    integration,
    repository,
    installationId,
    secrets: { privateKeyRef, webhookSecretRef },
    resolutions,
    runtime,
    send: (event, payload, deliver) => {
      const request = fake.signedRequest(event, payload, deliver);
      return runtime.controllerScope().integrations.receiveWebhook("github", request);
    },
    async install() {
      const installation = fake.installations.get(installationId);
      if (!installation) throw new Error("fake installation missing");
      await world.send("installation", fake.installationPayload("created", installation));
      world.configureRepository();
    },
    openPr: (number, headSha, extra = {}) =>
      world.send(
        "pull_request",
        fake.pullRequestPayload({ installationId, repository, number, headSha, ...extra }),
        extra.deliver,
      ),
    deploy: (deploymentId, sha, extra = {}) =>
      world.send(
        "deployment_status",
        fake.deploymentStatusPayload({
          installationId,
          repository,
          deploymentId,
          sha,
          url: extra.url === undefined ? target.origin : extra.url,
          ...(extra.environment ? { environment: extra.environment } : {}),
          ...(extra.state ? { state: extra.state } : {}),
        }),
      ),
    pull: (headSha) => {
      const row = app.database.get("SELECT * FROM github_pulls WHERE head_sha=?", headSha);
      if (!row) throw new Error(`no pull for ${headSha}`);
      return row;
    },
    checks: (headSha) =>
      fake
        .checksFor(repository.fullName, headSha)
        .map((check) => ({ name: check.name, status: check.status, conclusion: check.conclusion, title: check.output.title ?? "", summary: check.output.summary ?? "", detailsUrl: check.details_url })),
    configureRepository: (patch = {}) => {
      app.github.updateRepository(integration.id, String(repository.id), {
        enabled: true,
        projectId: init.projectId,
        baseEnvironmentId: init.environmentId,
        ...patch,
      });
    },
    async drive(maxTicks = 8) {
      for (let tick = 0; tick < maxTicks; tick++) {
        const before = JSON.stringify(app.database.all("SELECT id,state FROM github_pulls ORDER BY id"));
        await runtime.controllerScope().github.reconcile();
        await app.github.settle();
        await runtime.controllerScope().github.reconcile();
        const rows = app.database.all("SELECT state FROM github_pulls WHERE state IN ('awaiting_preview','running')");
        const after = JSON.stringify(app.database.all("SELECT id,state FROM github_pulls ORDER BY id"));
        if (!rows.length || (before === after && tick > 1)) return;
      }
    },
    async stop() {
      await app.github.settle();
      Application.prototype.preflight = originalPreflight;
      runtime.close();
      await fake.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
  return world;
}

/** A server-profile project with a default environment: `init` is a single-user local command. */
function seedServerProject(app: Application): { projectId: string; environmentId: string } {
  const project = app.projects.create({ name: "github-project" });
  const environment = app.environments.create({
    projectId: project.id,
    name: "local",
    baseUrl: "http://127.0.0.1:3000",
    networkProfile: "local-loopback",
    locale: "en-US",
    timezone: "UTC",
  });
  app.environments.setDefault(project.id, environment.id, project.version ?? 1);
  return { projectId: project.id, environmentId: environment.id };
}

const ownerLogin = "github-owner";
const ownerPassword = "correct horse battery staple";
/** Bootstraps the first workspace of a server-profile database and returns the owner's workspace-bound application. */
async function signInOwner(runtime: Application): Promise<Application> {
  const boot = runtime.operator.bootstrap({ workspaceName: "GitHub Acme", ownerLogin });
  await runtime.identityService.recover({
    principal: ownerLogin,
    recoveryToken: boot.ownerRecovery.recoveryToken,
    newPassword: ownerPassword,
  });
  const login = await runtime.identityService.login({ principal: ownerLogin, password: ownerPassword });
  return runtime.forIdentity(authenticateSession(runtime, login.sessionToken));
}
