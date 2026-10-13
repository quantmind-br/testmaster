import { createHash } from "node:crypto";
import {
  type Application,
  type NotificationsService,
  Scheduler,
  scaffoldPlan,
} from "@testmaster/application";
import { runNotificationOutage } from "@testmaster/application/testing/j13-notify";
import {
  createNotificationHarness,
  type NotificationHarness,
} from "@testmaster/application/testing/notification-harness";
import {
  type HttpsReceiver,
  startHttpsReceiver,
} from "@testmaster/application/testing/notifications";
import { OutboxRepository } from "@testmaster/persistence";
import { createTestDatabase, type TestDatabase } from "@testmaster/persistence/testing";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Journey } from "./harness.js";
import {
  finishBatch,
  runScheduleJourneyPart,
  type ScheduleJourneyEvidence,
} from "./schedule-helpers.js";

/**
 * J13 (delivery, schedule and issue), server profile on PostgreSQL: a New York schedule fires a
 * cross-project list through the real scheduler, then the notification layer meets a Slack outage, a
 * webhook that times out after the request was sent and a forged (SSRF) callback destination.
 * Delivery trouble must never move a Run, a gate or the number of Runs, every event reaches every
 * destination exactly once as a delivery, and a dead letter is requeued from the operations DLQ.
 * The Jira/Linear tracker half of J13 (import as intent, issue preview and link, ticket prompt
 * injection) is M5 and is not exercised here.
 */
let session: Journey;
let failure: unknown;
beforeAll(async () => {
  session = await Journey.create("j13-schedule-notify", {
    class: "deterministic-e2e",
    runner: "scheduler-and-notification-controllers-postgres",
    externalDependency: "postgres-container-and-local-https-receivers",
    limitations: [
      "Local HTTPS receivers stand in for Slack and the webhook consumer; no Slack, Jira, Linear or SaaS endpoint is contacted.",
      "The scheduled batches are admitted by the real scheduler and finished with the SQL a worker runs; no sandbox executes them, so verdict content is not the subject.",
      "The Jira/Linear tracker import, issue preview and link, and ticket prompt-injection handling are M5 and are not covered.",
      "PostgreSQL 17 on one host; the harness clock is fake, so wall-clock backoff is simulated, not waited.",
    ],
  });
});
afterAll(async () => {
  await session.close(failure);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2027-03-13T00:00:00Z"));
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function recorded(name: string, body: () => Promise<Record<string, unknown>>): Promise<void> {
  try {
    session.oracles.push({ scenario: name, ...(await body()) });
  } catch (error) {
    failure ??= error;
    throw error;
  }
}

const hostStubs = (application: Application): void => {
  application.preflight = async () => {};
  application.runs.host.liveWorker = () => true;
};
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const count = (h: NotificationHarness, sql: string, ...values: unknown[]): number =>
  Number(h.app.database.get(sql, h.workspaceId, ...values)?.n);

interface World {
  h: NotificationHarness;
  evidence: ScheduleJourneyEvidence;
  projectIds: string[];
  /** One more dispatcher on its own connection, opened before the events exist (a second process). */
  second: NotificationsService;
  /** Every Run of both scheduled batches with the fields a delivery must never change. */
  verdicts(): Record<string, unknown>[];
  totals(): { runs: number; batches: number; firings: number };
  /** Runs one scheduler pass at an explicit instant, as a restarted scheduler process would. */
  tickScheduler(iso: string): Promise<void>;
}

/**
 * Builds the schedule half of J13 on PostgreSQL through the shared drivers and leaves the outbox
 * events a worker would: a `run.completed` per Run of both batches (the second batch failed) and the
 * `schedule.misfire` the scheduler records for a late occurrence. `destinations` runs before any event
 * exists so each integration is older than the events it must announce.
 */
async function scheduledWorld(
  destinations: (h: NotificationHarness, projectIds: string[]) => Promise<void>,
): Promise<World> {
  const database: TestDatabase = await createTestDatabase();
  cleanups.push(() => database.drop());
  const h = await createNotificationHarness({ postgres: database.config });
  cleanups.push(() => h.close());
  const second = await h.dispatcher();

  // A second project with its own test and environment: the list spans both.
  const projectB = h.app.projects.create({ name: "Billing" });
  const environmentB = h.app.environments.create({
    projectId: projectB.id,
    name: "local",
    baseUrl: "http://127.0.0.1:3001",
  });
  h.app.tests.create({ projectId: projectB.id, plan: scaffoldPlan("backend"), name: "invoices" });
  const projectIds = [h.projectId, projectB.id];
  await destinations(h, projectIds);

  const holder = "j13-journey";
  const evidence = await runScheduleJourneyPart({
    app: h.app,
    projectId: h.projectId,
    environmentId: h.environmentId,
    additionalBindings: [{ projectId: projectB.id, environmentId: environmentB.id }],
    setClock: (epochMs) => vi.setSystemTime(epochMs),
    holder,
  });

  // The second batch fails: a worker would leave a failed Run and a failed gate behind.
  finishBatch(h.app, evidence.second.batchId, "failed");
  const scheduler = new Scheduler(h.app.controllerScope(), {
    holder,
    configureApplication: hostStubs,
  });
  const tickScheduler = async (iso: string): Promise<void> => {
    const ms = Date.parse(iso);
    vi.setSystemTime(ms);
    await scheduler.tick(ms);
  };
  // 17 March, six minutes late for the 06:30 occurrence and past the 300 s grace: a recorded misfire.
  await tickScheduler("2027-03-17T06:36:00Z");

  const outbox = new OutboxRepository(h.app.database);
  h.app.database.withTx(() => {
    for (const [batchId, outcome] of [
      [evidence.first.batchId, "passed"],
      [evidence.second.batchId, "failed"],
    ] as const) {
      const batch = h.app.context.entities.get("BatchRun", h.workspaceId, batchId);
      for (const runId of (batch?.memberRuns as string[]) ?? [])
        outbox.append(h.workspaceId, runId, "run.completed", { outcome });
    }
  });
  h.clock.now = new Date(Date.now());

  const runIds = [...evidence.first.runIds, ...evidence.second.runIds];
  return {
    h,
    evidence,
    projectIds,
    second,
    verdicts: () =>
      h.app.database
        .all(
          "SELECT id,outcome,gate,phase,status FROM runs WHERE workspace_id=? ORDER BY id",
          h.workspaceId,
        )
        .filter((row) => runIds.includes(String(row.id))),
    totals: () => ({
      runs: count(h, "SELECT COUNT(*) AS n FROM runs WHERE workspace_id=?"),
      batches: count(h, "SELECT COUNT(*) AS n FROM batches WHERE workspace_id=?"),
      firings: count(h, "SELECT COUNT(*) AS n FROM schedule_firings WHERE workspace_id=?"),
    }),
    tickScheduler,
  };
}

const announced = ["batch.completed", "run.failed", "schedule.misfire"] as const;

it("J13 M4-06 M4-08 OPS-016 OPS-018 REQ-035 INT-003 INT-026 INT-028 OPS-011 ARCH-004 a schedule fires a cross-project list and a Slack outage, a webhook timeout and a forged callback never change a Run, a gate or the Run count", async () => {
  await recorded("schedule-and-delivery-outage", async () => {
    let slackReceiver!: HttpsReceiver;
    let hookReceiver!: HttpsReceiver;
    let forgedReceiver!: HttpsReceiver;
    const ids = { slack: "", webhook: "", forged: "" };
    const world = await scheduledWorld(async (h, projectIds) => {
      slackReceiver = await h.receiver("/slack");
      hookReceiver = await h.receiver("/hook");
      // A callback whose port the egress policy was never told about: the SSRF-style destination.
      forgedReceiver = await startHttpsReceiver(h.tls, "/callback");
      cleanups.push(() => forgedReceiver.close());
      slackReceiver.behave(() => ({ status: 503 }));
      hookReceiver.behave((_request, requestNumber) =>
        requestNumber === 1 ? { hang: true } : { status: 200 },
      );
      const options = { events: [...announced], projectIds };
      ids.slack = (await h.slack(slackReceiver, options)).id;
      ids.webhook = (await h.webhook(hookReceiver, options)).id;
      ids.forged = (await h.webhook(forgedReceiver, options)).id;
    });
    const { h, evidence, second } = world;

    // --- the schedule half: DST gap, overlap, then a new BatchRun with a Run per revision and cell ---
    expect(evidence.timezone).toBe("America/New_York");
    expect(evidence.gap).toMatchObject({ state: "skipped", dst: "gap_skipped", batchId: null });
    expect(evidence.overlap).toMatchObject({ state: "overlap", batchId: null });
    expect(evidence.first.runIds).toHaveLength(4);
    expect(new Set(evidence.first.revisionIds).size).toBe(4);
    expect(evidence.second.batchId).not.toBe(evidence.first.batchId);
    const projectsOfFirstBatch = h.app.database.all(
      "SELECT DISTINCT t.project_id FROM runs r JOIN tests t ON t.workspace_id=r.workspace_id AND t.id=r.test_id WHERE r.workspace_id=? AND r.batch_id=?",
      h.workspaceId,
      evidence.first.batchId,
    );
    expect(projectsOfFirstBatch).toHaveLength(2);
    const misfires = h.app.database.all(
      "SELECT 1 AS present FROM outbox WHERE workspace_id=? AND type='schedule.misfire'",
      h.workspaceId,
    );
    expect(misfires).toHaveLength(1);

    const verdictsBefore = world.verdicts();
    const totalsBefore = world.totals();
    expect(verdictsBefore).toHaveLength(8);
    expect(verdictsBefore.filter((row) => row.outcome === "failed")).toHaveLength(4);
    // 2 batch.completed + 4 run.failed + 1 schedule.misfire, to each of three destinations.
    const events = 2 + evidence.second.runIds.length + 1;

    // --- the outage: Slack answers 503 every time, one webhook request hangs, the forged callback is refused ---
    await h.settle(160);
    const deliveries = (integrationId: string) => h.service.list({ integrationId, limit: 100 });
    const slack = deliveries(ids.slack);
    const webhook = deliveries(ids.webhook);
    const forged = deliveries(ids.forged);
    expect([slack.length, webhook.length, forged.length]).toEqual([events, events, events]);
    expect(count(h, "SELECT COUNT(*) AS n FROM notification_deliveries WHERE workspace_id=?")).toBe(
      3 * events,
    );
    // Exactly one delivery per event and destination, whatever happened to the transport.
    expect(
      h.app.database.all(
        "SELECT integration_id,event_ref,COUNT(*) AS n FROM notification_deliveries WHERE workspace_id=? GROUP BY integration_id,event_ref HAVING COUNT(*)>1",
        h.workspaceId,
      ),
    ).toEqual([]);
    expect(new Set(slack.map((delivery) => delivery.eventRef)).size).toBe(events);

    // Slack: retried to the budget with one delivery ID each, then visible dead letters.
    expect(
      slack.every((delivery) => delivery.state === "dead_letter" && delivery.attempts === 10),
    ).toBe(true);
    expect(slack.every((delivery) => delivery.lastReasonCode === "attempts_exhausted")).toBe(true);
    expect(slackReceiver.requests).toHaveLength(10 * events);
    expect(
      new Set(slackReceiver.requests.map((request) => request.headers["testmaster-delivery-id"]))
        .size,
    ).toBe(events);
    // The webhook: one request timed out after it was sent (uncertain), was retried under the same IDs.
    expect(webhook.every((delivery) => delivery.state === "delivered")).toBe(true);
    const retried = webhook.filter((delivery) => delivery.attempts === 2);
    expect(retried).toHaveLength(1);
    expect(
      h.service.get(String(retried[0]?.id)).attemptLog.some((attempt) => attempt.uncertain),
    ).toBe(true);
    expect(hookReceiver.requests).toHaveLength(events + 1);
    expect(
      new Set(hookReceiver.requests.map((request) => request.headers["testmaster-delivery-id"]))
        .size,
    ).toBe(events);
    expect(
      new Set(hookReceiver.requests.map((request) => request.headers["testmaster-event-id"])).size,
    ).toBe(events);
    // The forged callback: policy denial before any byte left, so the receiver saw nothing.
    expect(forgedReceiver.requests).toHaveLength(0);
    expect(forged.every((delivery) => delivery.state === "dead_letter")).toBe(true);
    expect(forged.every((delivery) => delivery.lastReasonCode === "egress_denied")).toBe(true);

    // The operations DLQ shows every dead letter; none of this touched a verdict, a gate or the Run count.
    const dlqBefore = h.app.operations.dlq().filter((entry) => entry.source === "notification");
    expect(dlqBefore).toHaveLength(2 * events);
    expect(world.verdicts()).toEqual(verdictsBefore);
    expect(world.totals()).toEqual(totalsBefore);
    expect(
      h.app.database.all(
        "SELECT 1 AS present FROM outbox WHERE workspace_id=? AND type='delivery.dead_letter'",
        h.workspaceId,
      ),
    ).toHaveLength(2 * events);

    // --- recovery: Slack answers again; the operator requeues from the DLQ ---
    slackReceiver.behave(() => ({ status: 200 }));
    const firstBodies = new Map<string, string>();
    for (const request of slackReceiver.requests) {
      const id = String(request.headers["testmaster-delivery-id"]);
      if (!firstBodies.has(id)) firstBodies.set(id, sha256(request.body));
    }
    // One clock for the operator and the dispatcher, as in production: the retry window restarts now.
    vi.setSystemTime(h.clock.now.getTime());
    for (const delivery of slack)
      h.app.operations.requeue({ source: "notification", id: delivery.id });
    await h.settle(60);
    const recovered = deliveries(ids.slack);
    expect(recovered).toHaveLength(events);
    expect(recovered.every((delivery) => delivery.state === "delivered")).toBe(true);
    expect(recovered.map((delivery) => delivery.deliveryId).sort()).toEqual(
      slack.map((delivery) => delivery.deliveryId).sort(),
    );
    // The redelivery carries the bytes of the first attempt under the same delivery ID, once each.
    expect(slackReceiver.requests).toHaveLength(11 * events);
    for (const request of slackReceiver.requests.slice(-events))
      expect(sha256(request.body)).toBe(
        firstBodies.get(String(request.headers["testmaster-delivery-id"])),
      );
    // The forged callback stays refused: requeueing is not a way around egress policy.
    expect(forgedReceiver.requests).toHaveLength(0);
    expect(h.app.operations.dlq().filter((entry) => entry.source === "notification")).toHaveLength(
      events,
    );
    expect(count(h, "SELECT COUNT(*) AS n FROM notification_deliveries WHERE workspace_id=?")).toBe(
      3 * events,
    );
    expect(world.verdicts()).toEqual(verdictsBefore);
    expect(world.totals()).toEqual(totalsBefore);

    // --- restart and redelivery: a second dispatcher and a restarted scheduler duplicate nothing ---
    expect(await second.tick()).toEqual({ created: 0, attempted: 0 });
    expect(h.service.fanOut()).toBe(0);
    expect(await h.tick()).toEqual({ created: 0, attempted: 0 });
    await world.tickScheduler("2027-03-17T06:36:30Z");
    expect(count(h, "SELECT COUNT(*) AS n FROM notification_deliveries WHERE workspace_id=?")).toBe(
      3 * events,
    );
    expect(slackReceiver.requests).toHaveLength(11 * events);
    expect(hookReceiver.requests).toHaveLength(events + 1);
    expect(world.totals()).toEqual(totalsBefore);

    // --- the generic outage scenario on the same harness: the earlier destinations stay out of it ---
    vi.setSystemTime(h.clock.now.getTime());
    for (const id of Object.values(ids)) {
      const current = h.app.integrations.get(id);
      h.app.integrations.pause(id, Number(current.version));
    }
    const report = await runNotificationOutage(h);
    expect(report.slack).toMatchObject({
      state: "delivered",
      attempts: 3,
      requests: 3,
      distinctDeliveryIds: 1,
      distinctEventIds: 1,
      sawUncertainAttempt: false,
    });
    expect(report.webhook).toMatchObject({
      state: "delivered",
      attempts: 2,
      requests: 2,
      distinctDeliveryIds: 1,
      distinctEventIds: 1,
      sawUncertainAttempt: true,
    });
    expect(report.runsAfter).toBe(report.runsBefore);
    expect(report.runAfter).toEqual(report.runBefore);
    expect(slackReceiver.requests).toHaveLength(11 * events);
    expect(hookReceiver.requests).toHaveLength(events + 1);

    return {
      check: "schedule-fires-cross-project-list-and-outage-dead-letters-without-moving-a-verdict",
      passed: true,
      timezone: evidence.timezone,
      tzdataVersion: evidence.tzdataVersion,
      firstBatchId: evidence.first.batchId,
      secondBatchId: evidence.second.batchId,
      runsPerBatch: evidence.first.runIds.length,
      eventsAnnounced: events,
      deliveries: 3 * events,
      slackAttempts: slackReceiver.requests.length,
      deadLettersBeforeRecovery: dlqBefore.length,
      forgedCallbackRequests: forgedReceiver.requests.length,
    };
  });
});

it("J13 M4-06 INT-003 INT-026 OPS-011 negative control: healthy destinations deliver every scheduled event once on the first attempt with no dead letter", async () => {
  await recorded("healthy-destinations-control", async () => {
    let slackReceiver!: HttpsReceiver;
    let hookReceiver!: HttpsReceiver;
    const world = await scheduledWorld(async (h, projectIds) => {
      slackReceiver = await h.receiver("/slack");
      hookReceiver = await h.receiver("/hook");
      const options = { events: [...announced], projectIds };
      await h.slack(slackReceiver, options);
      await h.webhook(hookReceiver, options);
    });
    const { h, evidence } = world;
    const events = 2 + evidence.second.runIds.length + 1;
    const verdictsBefore = world.verdicts();
    const totalsBefore = world.totals();

    await h.settle();

    const all = h.service.list({ limit: 100 });
    expect(all).toHaveLength(2 * events);
    expect(all.every((delivery) => delivery.state === "delivered" && delivery.attempts === 1)).toBe(
      true,
    );
    expect(h.service.deadLetters()).toEqual([]);
    expect(slackReceiver.requests).toHaveLength(events);
    expect(hookReceiver.requests).toHaveLength(events);
    expect(
      new Set(hookReceiver.requests.map((request) => request.headers["testmaster-event-id"])).size,
    ).toBe(events);
    // Delivering never reruns a Run or moves a verdict either.
    expect(world.verdicts()).toEqual(verdictsBefore);
    expect(world.totals()).toEqual(totalsBefore);
    // Negative control for the schedule half: the DST gap and the overlap admitted no batch.
    expect(evidence.firings.filter((firing) => firing.batchId !== null)).toHaveLength(2);
    return {
      check: "healthy-destinations-deliver-once-without-dead-letters",
      passed: true,
      deliveries: all.length,
    };
  });
});
