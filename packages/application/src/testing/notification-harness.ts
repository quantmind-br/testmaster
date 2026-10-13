/**
 * Test-only harness that wires a real `Application` to local notification receivers: a throw-away
 * TLS CA, programmable HTTPS and SMTP servers, ephemeral secrets and a controllable clock. It is
 * also the reusable "notify" half of journey J13.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  IntegrationMetadata,
  NotificationRedaction,
  NotificationRules,
  NotificationType,
} from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { OutboxRepository } from "@testmaster/persistence";
import { Application } from "../application.js";
import { scaffoldPlan } from "../authoring.js";
import { requireEntity } from "../context.js";
import { integrationProviders } from "../integrations/registry.js";
import type { EgressOptions } from "../notifications/https.js";
import {
  createEmailProvider,
  createSlackProvider,
  createWebhookProvider,
  type SlackProviderOptions,
} from "../notifications/providers.js";
import { NotificationsService } from "../notifications/service.js";
import {
  allowLoopbackPort,
  createTestTls,
  type HttpsReceiver,
  type SmtpServer,
  type SmtpServerOptions,
  startHttpsReceiver,
  startSmtpServer,
  type TestTls,
} from "./notifications.js";

/** Shared by the providers registered below; tests mutate it to prove that a retry re-evaluates egress policy. */
const egress: SlackProviderOptions = {
  timeoutMs: 1500,
  allowedHosts: ["127.0.0.1", "hooks.slack.com"],
};
let installed = false;
/** Registers providers wired to the shared `egress` object before any `Application.open`, so the built-ins skip registration. */
function installProviders(): void {
  if (installed) return;
  installed = true;
  integrationProviders.register(createSlackProvider(egress));
  integrationProviders.register(createWebhookProvider(egress));
  integrationProviders.register(createEmailProvider(egress));
}

export interface RunFixtureOptions {
  outcome?: "passed" | "failed" | "blocked" | "inconclusive" | "cancelled";
  gate?: "passed" | "failed" | "pending" | "not_applicable";
  reasonCode?: string;
  environmentId?: string;
  batchId?: string | null;
  /** Free text that must never leave the platform (a title, a log line or a token). */
  canary?: string;
}
export interface IntegrationOptions {
  name?: string;
  events?: NotificationType[];
  projectIds?: string[];
  rules?: NotificationRules;
  redaction?: NotificationRedaction;
}
export interface Clock {
  now: Date;
  advance(ms: number): void;
}

export interface NotificationHarness {
  readonly app: Application;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly tls: TestTls;
  readonly egress: EgressOptions;
  readonly clock: Clock;
  readonly service: NotificationsService;
  receiver(path?: string): Promise<HttpsReceiver>;
  smtp(
    options: Omit<SmtpServerOptions, "user" | "password"> & { user?: string; password?: string },
  ): Promise<SmtpServer>;
  /** Stores an ephemeral secret bound to the given origins and returns its id. */
  secret(name: string, value: string, allowedOrigins: readonly string[]): Promise<string>;
  webhook(
    receiver: HttpsReceiver,
    options?: IntegrationOptions & { secret?: string },
  ): Promise<IntegrationMetadata>;
  slack(receiver: HttpsReceiver, options?: IntegrationOptions): Promise<IntegrationMetadata>;
  email(
    smtp: SmtpServer,
    options?: IntegrationOptions & {
      security?: "tls" | "starttls";
      recipients?: string[];
      allowedRecipientDomains?: string[];
      from?: string;
      subjectPrefix?: string;
    },
  ): Promise<IntegrationMetadata>;
  /** A terminal Run plus its `run.completed` outbox event, exactly as the worker leaves them. */
  completedRun(options?: RunFixtureOptions): { runId: string; eventId: string };
  /** An orphaned-resource outbox event against a Run, as the worker records it when cleanup fails. */
  orphanedResource(runId: string): { eventId: string };
  /** A Batch whose member Runs have all finished with the given outcomes; returns the Batch and Run ids. */
  completedBatch(
    members: RunFixtureOptions[],
    data?: { suiteId?: string },
  ): { batchId: string; runIds: string[] };
  /** One service pass at the current fake time. */
  tick(): Promise<{ created: number; attempted: number }>;
  /** Passes until nothing is due, advancing the fake clock past each backoff. */
  settle(maxPasses?: number): Promise<number>;
  close(): Promise<void>;
}

export async function createNotificationHarness(
  options: { publicOrigin?: string } = {},
): Promise<NotificationHarness> {
  installProviders();
  const root = await mkdtemp(join(tmpdir(), "tm-notify-"));
  const tls = await createTestTls(join(root, "tls"));
  egress.ca = tls.caPem;
  egress.privateTargets = [];
  delete egress.resolver;
  egress.timeoutMs = 1500;
  const app = await Application.open({ cwd: root, home: root });
  const init = await app.init();
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  const environmentRevision = app.environments.get(init.environmentId).activeRevisionId;
  const clock: Clock = {
    now: new Date(),
    advance(ms) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  const publicOrigin = options.publicOrigin ?? "https://tm.example.test";
  const service = new NotificationsService(app.context, app.integrations, app.batches, {
    publicOrigin,
    now: () => clock.now,
    random: () => 0.5,
  });
  const receivers: HttpsReceiver[] = [];
  const smtps: SmtpServer[] = [];
  let counter = 0;
  const nextId = (): number => {
    counter += 1;
    return counter;
  };
  const outbox = new OutboxRepository(app.database);

  const base = (opts: IntegrationOptions) => ({
    name: opts.name ?? `notify-${nextId()}`,
    projectIds: opts.projectIds ?? [init.projectId],
    events: opts.events ?? ["run.completed", "run.failed"],
  });
  const withRules = (opts: IntegrationOptions) => ({
    ...(opts.rules ? { rules: opts.rules } : {}),
    ...(opts.redaction ? { redaction: opts.redaction } : {}),
  });
  const secret = async (name: string, value: string, allowedOrigins: readonly string[]) =>
    (await app.secrets.set(name, value, { ephemeral: true, allowedOrigins: [...allowedOrigins] }))
      .id;

  const harness: NotificationHarness = {
    app,
    workspaceId: init.workspaceId,
    projectId: init.projectId,
    environmentId: init.environmentId,
    tls,
    egress,
    clock,
    service,
    async receiver(path) {
      const started = await startHttpsReceiver(tls, path);
      receivers.push(started);
      allowLoopbackPort(egress, started.port);
      return started;
    },
    async smtp(smtpOptions) {
      const started = await startSmtpServer(tls, {
        user: "mailer",
        password: "smtp-password-canary",
        ...smtpOptions,
      });
      smtps.push(started);
      allowLoopbackPort(egress, started.port);
      return started;
    },
    secret,
    async webhook(receiver, opts = {}) {
      const signing = await secret(`hook-${nextId()}`, opts.secret ?? "whsec_current", [
        receiver.origin,
      ]);
      return app.integrations.create({
        provider: "webhook",
        ...base(opts),
        consent: { scopes: ["notify:webhook"] },
        secretRefs: [signing],
        settings: { url: receiver.url, signingSecretRef: signing, ...withRules(opts) },
      });
    },
    async slack(receiver, opts = {}) {
      const hook = await secret(`slack-${nextId()}`, receiver.url, [receiver.origin]);
      return app.integrations.create({
        provider: "slack",
        ...base(opts),
        consent: { scopes: ["notify:slack"] },
        secretRefs: [hook],
        settings: { secretRef: hook, ...withRules(opts) },
      });
    },
    async email(smtp, opts = {}) {
      const credentials = await secret(
        `smtp-${nextId()}`,
        JSON.stringify({
          host: "127.0.0.1",
          port: smtp.port,
          user: "mailer",
          password: "smtp-password-canary",
        }),
        [`https://127.0.0.1:${smtp.port}`],
      );
      return app.integrations.create({
        provider: "email",
        ...base(opts),
        consent: { scopes: ["notify:email"] },
        secretRefs: [credentials],
        settings: {
          smtpSecretRef: credentials,
          security: opts.security ?? "tls",
          from: opts.from ?? "testmaster@example.test",
          recipients: opts.recipients ?? ["ops@example.test"],
          allowedRecipientDomains: opts.allowedRecipientDomains ?? ["example.test"],
          ...(opts.subjectPrefix ? { subjectPrefix: opts.subjectPrefix } : {}),
          ...withRules(opts),
        },
      });
    },
    completedRun(run = {}) {
      const outcome = run.outcome ?? "failed";
      const runId = uuidV7IdGenerator.next("run");
      app.context.entities.insert("Run", {
        id: runId,
        workspaceId: init.workspaceId,
        testId: test.id,
        revisionId: test.activeRevisionId,
        environmentRevisionId: environmentRevision,
        batchId: run.batchId ?? null,
        matrixCell: { environmentId: run.environmentId ?? init.environmentId },
        mode: "replay",
        phase: "completed",
        status: outcome,
        outcome,
        origin: "notification-test",
        gatePolicy: {},
        gate: run.gate ?? (outcome === "passed" ? "passed" : "failed"),
        cleanupOutcome: "not_required",
        analysisStatus: "not_requested",
      });
      const event = app.database.withTx(() =>
        outbox.append(init.workspaceId, runId, "run.completed", {
          outcome,
          ...(run.reasonCode ? { reasonCode: run.reasonCode } : {}),
          ...(run.canary ? { message: run.canary, title: run.canary, log: run.canary } : {}),
        }),
      );
      return { runId, eventId: event.id };
    },
    orphanedResource(runId) {
      const event = app.database.withTx(() =>
        outbox.append(init.workspaceId, `res_${nextId()}`, "resource.orphaned", {
          runId,
          state: "orphaned",
        }),
      );
      return { eventId: event.id };
    },
    completedBatch(members, data = {}) {
      const batchId = uuidV7IdGenerator.next("bat");
      app.context.entities.insert("BatchRun", {
        id: batchId,
        workspaceId: init.workspaceId,
        createdAt: new Date().toISOString(),
        version: 1,
        selectionSnapshot: {
          hash: "0".repeat(64),
          rejections: [],
          duplicates: 0,
          requestedRunIds: [],
        },
        requestedCount: members.length,
        memberRuns: [],
        rejectedMembers: [],
        commit: null,
        aggregate: {
          counts: { passed: 0, failed: 0, blocked: 0, cancelled: 0, inconclusive: 0, inFlight: 0 },
          gate: "pending",
        },
      });
      const runIds = members.map((member) => harness.completedRun({ ...member, batchId }).runId);
      const stored = requireEntity(app.context, "BatchRun", batchId);
      app.context.entities.update("BatchRun", init.workspaceId, batchId, Number(stored.version), {
        ...stored,
        memberRuns: runIds,
        selectionSnapshot: { ...(stored.selectionSnapshot as object), requestedRunIds: runIds },
      });
      if (data.suiteId) {
        const row = app.database.get(
          "SELECT data_json FROM batches WHERE workspace_id=? AND id=?",
          init.workspaceId,
          batchId,
        );
        app.database.run(
          "UPDATE batches SET data_json=? WHERE workspace_id=? AND id=?",
          JSON.stringify({ ...JSON.parse(String(row?.data_json)), suiteId: data.suiteId }),
          init.workspaceId,
          batchId,
        );
      }
      return { batchId, runIds };
    },
    tick: () => service.tick(),
    async settle(maxPasses = 40) {
      let passes = 0;
      while (passes < maxPasses) {
        passes += 1;
        const { created, attempted } = await service.tick();
        if (created === 0 && attempted === 0) {
          const next = app.database.get(
            "SELECT MIN(next_attempt_at) AS at FROM notification_deliveries WHERE workspace_id=? AND state='pending'",
            init.workspaceId,
          );
          const at = typeof next?.at === "string" ? Date.parse(next.at) : null;
          if (at === null) break;
          clock.advance(Math.max(1, at - clock.now.getTime()) + 1);
        }
      }
      return passes;
    },
    async close() {
      for (const started of receivers) await started.close();
      for (const started of smtps) await started.close();
      app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  return harness;
}
