import { chmod, cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { OutboxRepository } from "@testmaster/persistence";
import { createTestDatabase, type TestDatabase } from "@testmaster/persistence/testing";
import { afterEach, expect, it } from "vitest";
import { Application } from "./application.js";
import { authenticateSession } from "./identity.js";
import { type GithubWorld, startGithubWorld } from "./integrations/github/testing/index.js";
import { integrationProviders } from "./integrations/registry.js";
import type { EgressOptions } from "./notifications/https.js";
import { createWebhookProvider } from "./notifications/providers.js";
import { testPgDump, testPgRestore, writeKeyFile } from "./ops.testkit.js";
import { Scheduler } from "./scheduling/scheduler.js";
import {
  createServerBackup,
  readLiveLedger,
  restoreServerBackup,
  type ServerBackupResult,
} from "./server-backup.js";
import type { ServerConfig } from "./server-config.js";
import {
  allowLoopbackPort,
  createTestTls,
  type HttpsReceiver,
  startHttpsReceiver,
} from "./testing/notifications.js";
import { authenticateBearer } from "./tokens.js";

/**
 * OPS-025 on the server profile: a restored PostgreSQL copy starts isolated. With an active schedule
 * that is due, a GitHub App installation with a pull request whose checks are still unpublished and a
 * notification destination with an unannounced event in the backup, the restored copy fires nothing,
 * sends nothing and publishes nothing, until an operator confirms the restore review and the workspace
 * owner releases the isolation. The same pending work then proceeds, which is the positive control.
 */
const SHA_A = "a1".repeat(20);
const SHA_NEW = "b2".repeat(20);
const password = "correct horse battery staple";

const egress: EgressOptions & { allowedHosts?: readonly string[] } = {
  timeoutMs: 1500,
  allowedHosts: ["127.0.0.1"],
  privateTargets: [],
};
// The notification adapter must reach the local receiver; registered before any Application opens.
if (!integrationProviders.peek("webhook"))
  integrationProviders.register(createWebhookProvider(egress));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Source {
  world: GithubWorld;
  server: ServerConfig;
  root: string;
  receiver: HttpsReceiver;
  workspaceId: string;
  webhookIntegrationId: string;
  scheduleId: string;
  tokenScheduleId: string;
  failedRunId: string;
}

/** Hosting preconditions for the scheduler: no executor, a live worker. */
const hostStubs = (application: Application): void => {
  application.preflight = async () => {};
  application.runs.host.liveWorker = () => true;
};

async function source(): Promise<Source> {
  const database: TestDatabase = await createTestDatabase();
  cleanups.push(() => database.drop());
  const root = await mkdtemp(join(tmpdir(), "tm-restore-isolation-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeKeyFile(join(root, "master.key"));
  await writeKeyFile(join(root, "backup.key"));
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
    backup: {
      destination: join(root, "backups"),
      pgDump: testPgDump,
      pgRestore: testPgRestore,
      allowSharedAccess: true,
    },
  };
  const tls = await createTestTls(join(root, "tls"));
  egress.ca = tls.caPem;
  egress.privateTargets = [];
  const receiver = await startHttpsReceiver(tls, "/hook");
  cleanups.push(() => receiver.close());
  allowLoopbackPort(egress, receiver.port);

  const world = await startGithubWorld({ server });
  cleanups.push(() => world.stop());
  const app = world.app;
  const workspaceId = app.context.workspaceId;

  // A notification destination that exists before the event it must announce.
  const signing = (
    await app.secrets.set("notify-signing", "whsec_restore", { allowedOrigins: [receiver.origin] })
  ).id;
  const webhook = app.integrations.create({
    provider: "webhook",
    name: "ops-hook",
    projectIds: [world.projectId],
    events: ["run.failed"],
    consent: { scopes: ["notify:webhook"] },
    secretRefs: [signing],
    settings: { url: receiver.url, signingSecretRef: signing },
  });
  // A failed Run whose `run.completed` event has not been announced yet.
  const test = app.tests.get(world.testId);
  const failedRunId = uuidV7IdGenerator.next("run");
  app.context.entities.insert("Run", {
    id: failedRunId,
    workspaceId,
    testId: world.testId,
    revisionId: test.activeRevisionId,
    environmentRevisionId: app.environments.get(world.environmentId).activeRevisionId,
    batchId: null,
    matrixCell: { environmentId: world.environmentId },
    mode: "replay",
    phase: "completed",
    status: "failed",
    outcome: "failed",
    origin: "restore-isolation-test",
    gatePolicy: {},
    gate: "failed",
    cleanupOutcome: "not_required",
    analysisStatus: "not_requested",
  });
  app.database.withTx(() =>
    new OutboxRepository(app.database).append(workspaceId, failedRunId, "run.completed", {
      outcome: "failed",
    }),
  );

  // An active schedule that is due: one owned by a session, one owned by an API token.
  const suite = app.suites.create({
    name: "restore-nightly",
    selection: {
      kind: "dynamic",
      projects: [{ projectId: world.projectId, environmentId: world.environmentId }],
    },
  });
  const trigger = { kind: "cron", cron: "* * * * *", timezone: "UTC" } as const;
  const schedule = app.schedules.create({
    name: "every-minute",
    selection: { kind: "suite", suiteId: suite.id },
    trigger,
    overlap: "allow",
  });
  const issued = app.tokens.create({
    name: "schedule-owner",
    scopes: ["R", "W", "X"],
    grants: [],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const tokenOwner = world.runtime.forIdentity(authenticateBearer(world.runtime, issued.token));
  const tokenSchedule = tokenOwner.schedules.create({
    name: "token-owned",
    selection: { kind: "suite", suiteId: suite.id },
    trigger,
    overlap: "allow",
  });

  // A GitHub App installation with a pull request opened; its checks are not published yet.
  await world.install();
  await world.openPr(1, SHA_A);
  return {
    world,
    server,
    root,
    receiver,
    workspaceId,
    webhookIntegrationId: webhook.id,
    scheduleId: schedule.id,
    tokenScheduleId: tokenSchedule.id,
    failedRunId,
  };
}

interface Restored {
  application: Application;
  /** Owner, viewer and org_admin sessions of the restored copy. */
  owner: Application;
  viewer: Application;
  admin: Application;
  server: ServerConfig;
  backup: ServerBackupResult;
}

async function restoredCopy(src: Source): Promise<Restored> {
  const { world } = src;
  const members: Record<"viewer" | "admin", string> = { viewer: "", admin: "" };
  for (const [key, role] of [
    ["viewer", "viewer"],
    ["admin", "org_admin"],
  ] as const) {
    const added = world.app.members.add(src.workspaceId, {
      login: `restore-${key}`,
      displayName: key,
      role,
      projectRestrictions: [],
    });
    await world.runtime.identityService.recover({
      principal: `restore-${key}`,
      recoveryToken: String(added.recovery?.recoveryToken),
      newPassword: password,
    });
    members[key] = `restore-${key}`;
  }
  const live = world.runtime.controllerScope().database;
  const backup = await createServerBackup({ database: live, server: src.server });
  const targetDatabase = await createTestDatabase({ migrate: false });
  cleanups.push(() => targetDatabase.drop());
  const server: ServerConfig = {
    ...src.server,
    database: { engine: "postgres", ...targetDatabase.config },
    storage: { kind: "filesystem", root: join(src.root, "restored-evidence") },
  };
  const restored = await restoreServerBackup({
    directory: backup.directory,
    server,
    ledger: readLiveLedger(live),
  });
  expect(restored.evidenceComplete).toBe(true);
  // The backup never carries secret ciphertexts (`secretIncluded: false`): the operator restores the
  // vault from its own copy next to the master key. Without it the copy cannot authenticate GitHub.
  const vault = join(src.root, "restored-evidence", "secrets");
  await cp(join(src.root, "evidence", "secrets"), vault, { recursive: true });
  await chmod(vault, 0o700);
  for (const entry of await readdir(vault)) await chmod(join(vault, entry), 0o600);
  const home = join(src.root, "restored-home");
  await mkdir(home, { recursive: true });
  const application = await Application.open({
    cwd: src.root,
    home,
    env: {},
    server,
    github: {
      apiBaseUrl: world.fake.url,
      now: () => world.clock.t,
      sleep: () => Promise.resolve(),
      resolveHost: (host) => Promise.resolve(world.resolutions.get(host) ?? ["127.0.0.1"]),
      random: () => 0.5,
    },
  });
  cleanups.push(() => application.close());
  const signIn = async (principal: string, secret: string): Promise<Application> =>
    application.forIdentity(
      authenticateSession(
        application,
        (await application.identityService.login({ principal, password: secret })).sessionToken,
      ),
    );
  return {
    application,
    owner: await signIn(String(world.owner?.login), String(world.owner?.password)),
    viewer: await signIn(members.viewer, password),
    admin: await signIn(members.admin, password),
    server,
    backup,
  };
}

const total = (application: Application, sql: string): number =>
  Number(application.controllerScope().database.get(sql)?.n);

/** Everything a restored copy could do to the outside world or to its own queue of work. */
function effects(src: Source, application: Application) {
  return {
    firings: total(application, "SELECT COUNT(*) AS n FROM schedule_firings"),
    batches: total(application, "SELECT COUNT(*) AS n FROM batches"),
    runs: total(application, "SELECT COUNT(*) AS n FROM runs"),
    deliveries: total(application, "SELECT COUNT(*) AS n FROM notification_deliveries"),
    pulls: total(application, "SELECT COUNT(*) AS n FROM github_pulls"),
    inbound: total(application, "SELECT COUNT(*) AS n FROM inbound_webhook_deliveries"),
    notificationRequests: src.receiver.requests.length,
    githubRequests: src.world.fake.requests.length,
    checkRuns: src.world.fake.checkRuns.length,
    comments: src.world.fake.comments.length,
  };
}

/** One pass of every registered server controller, as `server start` would run them. */
async function runEveryController(application: Application): Promise<string[]> {
  const names: string[] = [];
  const signal = new AbortController().signal;
  for (const controller of application.controllers.list("server")) {
    await controller.run(application.controllerScope(), signal);
    names.push(controller.name);
  }
  return names;
}

it("OPS-025 M4-02 a restored server-profile copy fires no schedule, sends no notification and publishes no check until the review is confirmed and the owner releases it", async () => {
  const src = await source();
  const { world } = src;
  // Nothing was published before the backup: the pull's checks are still waiting.
  expect(world.fake.checkRuns).toHaveLength(0);
  const pullState = world.app.database.get(
    "SELECT state FROM github_pulls WHERE head_sha=?",
    SHA_A,
  );
  expect(pullState).toBeDefined();

  const copy = await restoredCopy(src);
  const { application, owner, viewer, admin } = copy;
  const db = application.controllerScope().database;

  // The restore itself isolated the copy and paused every integration it carried.
  expect(db.get("SELECT value FROM operational_state WHERE key='restore:isolated'")?.value).toBe(
    "true",
  );
  expect(db.get("SELECT value FROM operational_state WHERE key='admission'")?.value).toBe(
    "suspended_restore",
  );
  expect(owner.operations.isolated()).toBe(true);
  expect(owner.operations.status().isolation).toMatchObject({ isolated: true });
  expect(
    db
      .all("SELECT provider,state FROM integrations ORDER BY provider")
      .map((row) => `${row.provider}:${row.state}`),
  ).toEqual(["github:paused", "webhook:paused"]);
  // Terminal verdicts survive the restore unchanged.
  expect(db.get("SELECT outcome,gate FROM runs WHERE id=?", src.failedRunId)).toMatchObject({
    outcome: "failed",
    gate: "failed",
  });
  // A token-owned authority does not survive: the restore dropped every token.
  expect(total(application, "SELECT COUNT(*) AS n FROM server_tokens")).toBe(0);

  const before = effects(src, application);
  const dueAt = Date.now() + 120_000;
  const scheduler = new Scheduler(application.controllerScope(), {
    holder: "restored-copy",
    configureApplication: hostStubs,
  });

  // --- isolated, integrations paused: every controller and the inbound webhook do nothing ---
  // One inbound delivery, signed by the real App secret, that GitHub would redeliver later.
  const inbound = world.fake.signedRequest(
    "pull_request",
    world.fake.pullRequestPayload({
      installationId: world.installationId,
      repository: world.repository,
      number: 2,
      headSha: SHA_NEW,
    }),
  );
  const receive = () =>
    application.controllerScope().integrations.receiveWebhook("github", inbound);
  const refused = () =>
    expect(receive()).rejects.toMatchObject({
      code: "UNAVAILABLE",
      details: { reasonCode: "restore_isolated" },
    });
  const names = await runEveryController(application);
  expect(names).toEqual(
    expect.arrayContaining(["scheduler", "notifications", "github-reconciler", "alerts"]),
  );
  expect(await scheduler.tick(dueAt)).toMatchObject({
    isolated: true,
    leader: false,
    claimed: 0,
    dispatched: 0,
  });
  await refused();
  expect(effects(src, application)).toEqual(before);

  // --- an administrator resumes the integrations while the isolation is still in force ---
  for (const integration of owner.integrations.list()) {
    owner.integrations.update(integration.id, { state: "active" }, Number(integration.version));
  }
  expect(
    db
      .all("SELECT provider,state FROM integrations ORDER BY provider")
      .map((row) => `${row.provider}:${row.state}`),
  ).toEqual(["github:active", "webhook:active"]);
  await runEveryController(application);
  expect(await scheduler.tick(dueAt)).toMatchObject({ isolated: true, dispatched: 0 });
  await refused();
  expect(effects(src, application)).toEqual(before);

  // --- only the owner, and only after the review, may release ---
  for (const actor of [viewer, admin])
    expect(() => actor.operations.releaseIsolation("not the owner")).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  expect(() => owner.operations.releaseIsolation("too early")).toThrowError(
    expect.objectContaining({ details: { reasonCode: "restore_review_pending" } }),
  );
  expect(() => viewer.backups.review({ apply: true, revocationsConfirmed: true })).toThrowError(
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
  owner.backups.review({ apply: true, revocationsConfirmed: true });
  // The review reopens admission but is not the release: the controllers still do nothing.
  expect(owner.operations.isolated()).toBe(true);
  await runEveryController(application);
  expect(await scheduler.tick(dueAt)).toMatchObject({ isolated: true, dispatched: 0 });
  expect(effects(src, application)).toEqual(before);
  for (const actor of [viewer, admin])
    expect(() => actor.operations.releaseIsolation("still not the owner")).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  expect(owner.operations.isolated()).toBe(true);

  // --- the owner releases: the same pending work now proceeds (positive control) ---
  expect(owner.operations.releaseIsolation("reviewed restore")).toMatchObject({
    kind: "isolation_release",
  });
  expect(owner.operations.isolated()).toBe(false);
  const released = await scheduler.tick(dueAt);
  expect(released).toMatchObject({ isolated: false, leader: true });
  expect(released.dispatched).toBeGreaterThanOrEqual(1);
  await runEveryController(application);
  const after = effects(src, application);
  expect(after.batches).toBeGreaterThan(before.batches);
  expect(after.notificationRequests).toBe(before.notificationRequests + 1);
  expect(after.checkRuns).toBeGreaterThan(before.checkRuns);
  // The very delivery refused during the isolation is processed now, not deduplicated as seen.
  const accepted = await receive();
  expect(accepted).toMatchObject({ outcome: "accepted", duplicate: false });
  // The token-owned schedule never resumes: the restore withdrew the authority it was created with.
  expect(owner.schedules.get(src.tokenScheduleId)).toMatchObject({
    state: "paused",
    pauseReason: "owner_revoked",
  });
});
