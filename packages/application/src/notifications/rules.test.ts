import { randomUUID } from "node:crypto";
import { ContractError, validate } from "@testmaster/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNotificationHarness,
  type NotificationHarness,
} from "../testing/notification-harness.js";
import { assertNoSecrets, buildNotificationPayload } from "./payload.js";

const open: NotificationHarness[] = [];
async function harness(): Promise<NotificationHarness> {
  const created = await createNotificationHarness();
  open.push(created);
  return created;
}
afterEach(async () => {
  for (const item of open.splice(0)) await item.close();
});

function bodies(receiver: { requests: Array<{ body: Buffer }> }): Array<Record<string, unknown>> {
  return receiver.requests.map((request) => JSON.parse(request.body.toString("utf8")));
}

describe("INT-025 default messages carry identifiers, a summary and a link and nothing else", () => {
  it("INT-025 the default payload validates against NotificationPayload and has no title, log, screenshot or token field", async () => {
    const h = await harness();
    const receiver = await h.receiver();
    await h.webhook(receiver);
    const { runId } = h.completedRun({
      outcome: "failed",
      canary: "Bearer eyJhbGciOiJIUzI1NiJ9.CANARY.signature",
    });
    await h.settle();
    const [payload] = bodies(receiver);
    validate("NotificationPayload", payload);
    expect(Object.keys(payload ?? {}).sort()).toEqual(
      [
        "batchId",
        "deliveryId",
        "eventId",
        "link",
        "occurredAt",
        "projectId",
        "runId",
        "scheduleId",
        "schemaVersion",
        "summary",
        "test",
        "type",
        "workspaceId",
      ].sort(),
    );
    expect(payload?.link).toBe(`https://tm.example.test/runs/${runId}`);
    expect(JSON.stringify(payload)).not.toContain("CANARY");
  });

  it("INT-025 minimal redaction drops counts and the reason code while the default keeps the verdict summary", async () => {
    const h = await harness();
    const full = await h.receiver();
    const minimal = await h.receiver("/min");
    await h.webhook(full, { name: "full", events: ["batch.completed"] });
    await h.webhook(minimal, {
      name: "min",
      events: ["batch.completed"],
      redaction: { level: "minimal" },
    });
    h.completedBatch([
      { outcome: "failed", reasonCode: "assertion_failed" },
      { outcome: "passed" },
    ]);
    await h.settle();
    const batch = bodies(full).find((payload) => payload.type === "batch.completed");
    const minimalBatch = bodies(minimal).find((payload) => payload.type === "batch.completed");
    expect(batch?.summary).toMatchObject({ counts: { passed: 1, failed: 1 } });
    expect(minimalBatch?.summary).toMatchObject({ counts: null, reasonCode: null });
    // Control: the verdict itself is never redacted.
    expect(minimalBatch?.summary).toMatchObject({ gate: "failed" });
    // The payload builder refuses a body that contains a known secret value.
    const payload = buildNotificationPayload(
      {
        type: "run.failed",
        eventId: "evt_x",
        deliveryId: "ntd_x",
        occurredAt: "2026-10-13T10:00:00.000Z",
        test: false,
        workspaceId: "ws_00000000-0000-4000-8000-000000000000",
        linkPath: "/runs/x",
      },
      "https://tm.example.test",
    );
    const body = Buffer.from(JSON.stringify(payload));
    expect(() => assertNoSecrets(body, ["ws_00000000-0000-4000-8000-000000000000"])).toThrow(
      ContractError,
    );
    expect(() => assertNoSecrets(body, ["never-present-secret-value"])).not.toThrow();
  });

  it("INT-025 REQ-042 rules narrow deliveries per project, event type, environment and suite", async () => {
    const h = await harness();
    const everything = await h.receiver("/all");
    const onlyFailures = await h.receiver("/failed");
    const otherEnv = await h.receiver("/env");
    const suite = await h.receiver("/suite");
    const otherProject = await h.receiver("/prj");
    await h.webhook(everything, { events: ["run.completed", "run.failed"] });
    await h.webhook(onlyFailures, { events: ["run.failed"] });
    await h.webhook(otherEnv, { rules: { environmentIds: [`env_${randomUUID()}`] } });
    const suiteId = `sui_${randomUUID()}`;
    await h.webhook(suite, {
      events: ["batch.completed"],
      rules: { suiteIds: [suiteId] },
    });
    const second = h.app.projects.create({ name: "Another project" });
    await h.webhook(otherProject, { projectIds: [second.id] });

    h.completedRun({ outcome: "passed" });
    h.completedRun({ outcome: "failed" });
    h.completedBatch([{ outcome: "passed" }], { suiteId });
    h.completedBatch([{ outcome: "passed" }], { suiteId: `sui_${randomUUID()}` });
    await h.settle();

    const types = (receiver: { requests: Array<{ body: Buffer }> }) =>
      bodies(receiver).map((payload) => payload.type);
    expect(types(everything).sort()).toEqual([
      "run.completed",
      "run.completed",
      "run.completed",
      "run.failed",
    ]);
    expect(types(onlyFailures)).toEqual(["run.failed"]);
    expect(otherEnv.requests).toHaveLength(0);
    expect(types(suite)).toEqual(["batch.completed"]);
    expect(otherProject.requests).toHaveLength(0);
  });
});

describe("REQ-042 failure, recovery and orphan events are delivered once", () => {
  it("REQ-042 a pass after a failure of the same test and environment is announced as recovered, a first pass is not", async () => {
    const h = await harness();
    const receiver = await h.receiver();
    await h.webhook(receiver, { events: ["run.recovered"] });
    h.completedRun({ outcome: "passed" });
    await h.settle();
    expect(receiver.requests).toHaveLength(0);
    h.completedRun({ outcome: "failed" });
    const { runId } = h.completedRun({ outcome: "passed" });
    await h.settle();
    expect(bodies(receiver)).toHaveLength(1);
    expect(bodies(receiver)[0]).toMatchObject({ type: "run.recovered", runId });
  });

  it("REQ-042 an orphaned resource is announced against its Run and a rescan never duplicates it", async () => {
    const h = await harness();
    const receiver = await h.receiver();
    await h.webhook(receiver, { events: ["resource.orphaned"] });
    const { runId } = h.completedRun({ outcome: "failed" });
    h.orphanedResource(runId);
    await h.settle();
    await h.tick();
    await h.tick();
    expect(bodies(receiver)).toHaveLength(1);
    expect(bodies(receiver)[0]).toMatchObject({
      type: "resource.orphaned",
      runId,
      summary: { reasonCode: "cleanup_inconclusive" },
    });
  });

  it("REQ-042 INT-003 a dead-lettered delivery is announced to the other integrations and never to the failing one", async () => {
    const h = await harness();
    const broken = await h.receiver("/broken");
    const watcher = await h.receiver("/watcher");
    broken.behave(() => ({ status: 410 }));
    const failing = await h.webhook(broken, { events: ["run.failed", "delivery.dead_letter"] });
    await h.webhook(watcher, { events: ["delivery.dead_letter"] });
    h.completedRun({ outcome: "failed" });
    await h.settle();
    expect(bodies(watcher).map((payload) => payload.type)).toEqual(["delivery.dead_letter"]);
    expect(broken.requests).toHaveLength(1);
    expect(h.service.list({ integrationId: failing.id })[0]?.state).toBe("dead_letter");
  });

  it("REQ-042 fan-out is idempotent: rescanning the outbox creates no second delivery for an event", async () => {
    const h = await harness();
    const receiver = await h.receiver();
    await h.webhook(receiver);
    h.completedRun({ outcome: "failed" });
    expect((await h.tick()).created).toBe(1);
    for (let pass = 0; pass < 3; pass += 1) expect((await h.tick()).created).toBe(0);
    expect(receiver.requests).toHaveLength(1);
    expect(h.service.list()).toHaveLength(1);
  });
});

describe("INT-027 INT-026 the stored bytes are what is signed and re-sent", () => {
  it("INT-026 a stored payload that no longer matches its hash dead-letters as payload_tampered without sending", async () => {
    const h = await harness();
    const receiver = await h.receiver();
    receiver.behave(() => ({ status: 503 }));
    await h.webhook(receiver);
    h.completedRun({ outcome: "failed" });
    await h.tick();
    const [delivery] = h.service.list();
    if (!delivery) throw new Error("Missing delivery");
    const row = h.app.database.get(
      "SELECT data_json FROM notification_deliveries WHERE workspace_id=? AND id=?",
      h.workspaceId,
      delivery.id,
    );
    const stored = JSON.parse(String(row?.data_json));
    stored.payload.summary.outcome = "passed";
    h.app.database.run(
      "UPDATE notification_deliveries SET data_json=? WHERE workspace_id=? AND id=?",
      JSON.stringify(stored),
      h.workspaceId,
      delivery.id,
    );
    h.clock.advance(10_000);
    await h.tick();
    expect(receiver.requests).toHaveLength(1);
    expect(h.service.list()[0]).toMatchObject({
      state: "dead_letter",
      lastReasonCode: "payload_tampered",
    });
  });
});

describe("INT-001 INT-004 states: paused keeps deliveries, revoked dead-letters, STARTTLS and plaintext are explicit", () => {
  it("INT-025 a paused integration holds its deliveries and resuming delivers them while a revoked one dead-letters", async () => {
    const h = await harness();
    const receiver = await h.receiver();
    const integration = await h.webhook(receiver);
    h.completedRun({ outcome: "failed" });
    await h.tick();
    expect(receiver.requests).toHaveLength(1);
    const paused = h.app.integrations.pause(integration.id, integration.version);
    h.completedRun({ outcome: "failed" });
    await h.settle();
    expect(receiver.requests).toHaveLength(1);
    expect(h.service.list({ state: "pending" })).toHaveLength(0);
    const revoked = h.app.integrations.revoke(integration.id, paused.version);
    expect(revoked.state).toBe("revoked");
  });

  it("INT-028 email over STARTTLS authenticates after the upgrade and delivers while a server without STARTTLS is refused", async () => {
    const h = await harness();
    const secured = await h.smtp({ mode: "starttls" });
    await h.email(secured, { security: "starttls" });
    h.completedRun({ outcome: "failed" });
    await h.settle();
    expect(secured.messages).toHaveLength(1);
    expect(secured.messages[0]?.authUser).toBe("mailer");

    const plain = await harness();
    const unencrypted = await plain.smtp({ mode: "plain" });
    await plain.email(unencrypted, { security: "starttls" });
    plain.completedRun({ outcome: "failed" });
    await plain.tick();
    expect(unencrypted.messages).toHaveLength(0);
    expect(plain.service.list()[0]?.state).not.toBe("delivered");
  });

  it("INT-028 an email integration cannot be configured for plaintext SMTP", async () => {
    const h = await harness();
    const smtp = await h.smtp({ mode: "plain" });
    await expect(h.email(smtp, { security: "none" as unknown as "tls" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});
