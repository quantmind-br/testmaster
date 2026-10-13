import { afterEach, describe, expect, it } from "vitest";
import {
  createNotificationHarness,
  type NotificationHarness,
} from "../testing/notification-harness.js";

const open: NotificationHarness[] = [];
async function harness(): Promise<NotificationHarness> {
  const created = await createNotificationHarness();
  open.push(created);
  return created;
}
afterEach(async () => {
  for (const item of open.splice(0)) await item.close();
});

function runRow(h: NotificationHarness, runId: string): Record<string, unknown> | undefined {
  return h.app.database.get(
    "SELECT outcome,gate,phase,status FROM runs WHERE workspace_id=? AND id=?",
    h.workspaceId,
    runId,
  );
}
function runCount(h: NotificationHarness): number {
  return Number(
    h.app.database.get("SELECT COUNT(*) AS n FROM runs WHERE workspace_id=?", h.workspaceId)?.n,
  );
}

describe("INT-003 OPS-011 ARCH-004 OPS-037 an unavailable notifier never changes a verdict and keeps a redeliverable record", () => {
  it("INT-003 ARCH-004 OPS-037 a destination outage retries with backoff, dead-letters visibly and leaves the Run and gate untouched", async () => {
    const h = await harness();
    const receiver = await h.receiver();
    receiver.behave(() => ({ status: 503 }));
    const integration = await h.webhook(receiver);
    const { runId } = h.completedRun({ outcome: "failed", gate: "failed" });
    const before = runRow(h, runId);
    const runs = runCount(h);

    await h.settle(60);

    const [delivery] = h.service.list({ integrationId: integration.id });
    if (!delivery) throw new Error("Missing delivery");
    expect(delivery).toMatchObject({
      state: "dead_letter",
      attempts: 10,
      lastReasonCode: "attempts_exhausted",
    });
    expect(receiver.requests).toHaveLength(10);
    expect(new Set(receiver.requests.map((r) => r.headers["testmaster-delivery-id"])).size).toBe(1);
    expect(h.service.deadLetters().map((entry) => entry.id)).toEqual([delivery.id]);
    // The verdict, the gate and the number of Runs are exactly what they were before the outage.
    expect(runRow(h, runId)).toEqual(before);
    expect(runCount(h)).toBe(runs);
    // The dead letter is announced on the outbox for operators, never as a Run event.
    const announced = h.app.database.all(
      "SELECT type FROM outbox WHERE workspace_id=? AND type='delivery.dead_letter'",
      h.workspaceId,
    );
    expect(announced).toHaveLength(1);

    // Negative control: a healthy destination delivers on the first attempt with no DLQ entry.
    const healthy = await harness();
    const ok = await healthy.receiver();
    await healthy.webhook(ok);
    healthy.completedRun();
    await healthy.settle();
    expect(healthy.service.deadLetters()).toHaveLength(0);
    expect(healthy.service.list()[0]).toMatchObject({ state: "delivered", attempts: 1 });
  });

  it("OPS-011 INT-003 requeue after the destination recovers redelivers the same delivery ID and bytes without a new Run", async () => {
    const h = await harness();
    const receiver = await h.receiver();
    receiver.behave(() => ({ status: 500 }));
    await h.webhook(receiver);
    const { runId } = h.completedRun();
    await h.settle(60);
    const [dead] = h.service.list({ state: "dead_letter" });
    if (!dead) throw new Error("Missing dead letter");
    const firstBody = receiver.requests[0]?.body.toString("utf8");
    const runs = runCount(h);

    receiver.behave(() => ({ status: 200 }));
    h.service.requeue(dead.id);
    await h.settle();

    const after = h.service.get(dead.id);
    expect(after.state).toBe("delivered");
    expect(after.deliveryId).toBe(dead.deliveryId);
    expect(receiver.requests.at(-1)?.body.toString("utf8")).toBe(firstBody);
    expect(receiver.requests.at(-1)?.headers["testmaster-delivery-id"]).toBe(dead.deliveryId);
    expect(runCount(h)).toBe(runs);
    expect(runRow(h, runId)).toMatchObject({ phase: "completed" });
    // Negative control: a delivered notification cannot be requeued.
    expect(() => h.service.requeue(dead.id)).toThrow(/dead-lettered/u);
  });

  it("INT-003 a 429 with Retry-After waits at least the advertised time and a 4xx rejection dead-letters at once", async () => {
    const h = await harness();
    const limited = await h.receiver();
    limited.behave((_request, count) =>
      count === 1 ? { status: 429, headers: { "retry-after": "120" } } : { status: 200 },
    );
    await h.webhook(limited);
    h.completedRun();
    await h.tick();
    const [delivery] = h.service.list();
    if (!delivery?.nextAttemptAt) throw new Error("Missing retry time");
    expect(delivery.lastReasonCode).toBe("rate_limited");
    expect(Date.parse(delivery.nextAttemptAt) - h.clock.now.getTime()).toBeGreaterThanOrEqual(
      119_000,
    );
    await h.tick();
    expect(limited.requests).toHaveLength(1);
    h.clock.advance(121_000);
    await h.tick();
    expect(h.service.list()[0]?.state).toBe("delivered");

    const permanent = await harness();
    const refusing = await permanent.receiver();
    refusing.behave(() => ({ status: 404 }));
    await permanent.webhook(refusing);
    permanent.completedRun();
    await permanent.tick();
    expect(permanent.service.list()[0]).toMatchObject({
      state: "dead_letter",
      attempts: 1,
      lastReasonCode: "http_404",
    });
  });
});

describe("INT-026 an ambiguous delivery is reported as uncertain and keeps one event and delivery ID", () => {
  it("INT-026 a timeout after the request was sent marks the delivery uncertain, retries with the same IDs and never claims not-sent", async () => {
    const h = await harness();
    h.egress.timeoutMs = 300;
    const receiver = await h.receiver();
    receiver.behave((_request, count) => (count === 1 ? { hang: true } : { status: 200 }));
    await h.webhook(receiver);
    h.completedRun();
    await h.tick();
    const [pending] = h.service.list();
    if (!pending) throw new Error("Missing delivery");
    expect(pending).toMatchObject({
      state: "pending",
      outcomeUncertain: true,
      lastReasonCode: "timeout",
    });
    expect(h.service.get(pending.id).attemptLog[0]).toMatchObject({
      outcome: "failed",
      uncertain: true,
    });

    await h.settle();
    expect(receiver.requests).toHaveLength(2);
    const [first, second] = receiver.requests;
    expect(second?.headers["testmaster-delivery-id"]).toBe(
      first?.headers["testmaster-delivery-id"],
    );
    expect(second?.headers["testmaster-event-id"]).toBe(first?.headers["testmaster-event-id"]);
    expect(second?.body.equals(first?.body ?? Buffer.alloc(0))).toBe(true);
    // The sticky flag clears once delivered, but the attempt log keeps the uncertain attempt visible.
    const done = h.service.get(pending.id);
    expect(done.state).toBe("delivered");
    expect(done.outcomeUncertain).toBe(false);
    expect(done.attemptLog[0]).toMatchObject({ uncertain: true });
    expect(done.attemptLog.map((a) => a.outcome)).toEqual(["failed", "delivered"]);

    // Negative control: a refused connection before any byte was sent is not flagged uncertain.
    const plain = await harness();
    plain.egress.timeoutMs = 300;
    const closed = await plain.receiver();
    await plain.webhook(closed);
    await closed.close();
    plain.completedRun();
    await plain.tick();
    expect(plain.service.list()[0]).toMatchObject({
      outcomeUncertain: false,
      lastReasonCode: "network_error",
    });
  });
});

describe("INT-028 a private or forged destination never receives a notification and a retry honours the new policy", () => {
  it("INT-028 a loopback destination without an explicit exception is refused by egress policy and the receiver sees nothing", async () => {
    const h = await harness();
    const receiver = await h.receiver();
    h.egress.privateTargets = [];
    await h.webhook(receiver);
    h.completedRun();
    await h.settle();
    expect(receiver.requests).toHaveLength(0);
    expect(h.service.list()[0]).toMatchObject({
      state: "dead_letter",
      lastReasonCode: "egress_denied",
    });
  });

  it("INT-028 a retry re-evaluates egress policy: a destination blocked between attempts is not contacted again", async () => {
    const h = await harness();
    const receiver = await h.receiver();
    receiver.behave(() => ({ status: 503 }));
    await h.webhook(receiver);
    h.completedRun();
    await h.tick();
    expect(receiver.requests).toHaveLength(1);
    const allowed = h.egress.privateTargets;
    h.egress.privateTargets = [];
    h.clock.advance(5_000);
    await h.tick();
    expect(receiver.requests).toHaveLength(1);
    expect(h.service.list()[0]).toMatchObject({
      state: "dead_letter",
      lastReasonCode: "egress_denied",
    });
    expect(allowed?.length).toBeGreaterThan(0);
  });

  it("INT-028 an HTTP redirect is never followed", async () => {
    const h = await harness();
    const target = await h.receiver("/landing");
    const receiver = await h.receiver();
    receiver.behave(() => ({ status: 302, headers: { location: target.url } }));
    await h.webhook(receiver);
    h.completedRun();
    await h.settle();
    expect(target.requests).toHaveLength(0);
    expect(h.service.list()[0]).toMatchObject({
      state: "dead_letter",
      lastReasonCode: "redirect_refused",
    });
  });

  it("INT-028 CRLF in the email subject prefix, a foreign recipient domain or a non-https destination sends nothing", async () => {
    const h = await harness();
    const smtp = await h.smtp({ mode: "tls" });
    await h.email(smtp, { subjectPrefix: "[TM]\r\nBcc: attacker@evil.test" });
    h.completedRun();
    await h.settle();
    expect(smtp.messages).toHaveLength(0);
    expect(h.service.list()[0]).toMatchObject({
      state: "dead_letter",
      lastReasonCode: "header_injection",
    });

    const foreign = await harness();
    const server = await foreign.smtp({ mode: "tls" });
    await foreign.email(server, {
      recipients: ["victim@evil.test"],
      allowedRecipientDomains: ["example.test"],
    });
    foreign.completedRun();
    await foreign.settle();
    expect(server.messages).toHaveLength(0);
    expect(foreign.service.list()[0]).toMatchObject({ lastReasonCode: "recipient_domain_denied" });

    // Positive control: a clean configuration delivers exactly one message over TLS.
    const clean = await harness();
    const ok = await clean.smtp({ mode: "tls" });
    await clean.email(ok);
    clean.completedRun({ outcome: "failed" });
    await clean.settle();
    expect(ok.messages).toHaveLength(1);
    expect(ok.messages[0]?.recipients).toEqual(["ops@example.test"]);
  });
});

describe("J10 OPS-025 a secret in a failing Run never reaches a notification body and a restored copy sends nothing", () => {
  it("J10 INT-025 a canary token in a failing Run's title, message and log is absent from the Slack, webhook and email bodies", async () => {
    const h = await harness();
    const canary = "ghp_CANARYtoken0123456789abcdefghijklmnopqr";
    const hook = await h.receiver();
    const slack = await h.receiver("/slack");
    const smtp = await h.smtp({ mode: "tls" });
    await h.webhook(hook);
    await h.slack(slack);
    await h.email(smtp);
    h.completedRun({ outcome: "failed", reasonCode: "assertion_failed", canary });
    await h.settle();

    expect(hook.requests).toHaveLength(1);
    expect(slack.requests).toHaveLength(1);
    expect(smtp.messages).toHaveLength(1);
    const bodies = [
      hook.requests[0]?.body.toString("utf8"),
      slack.requests[0]?.body.toString("utf8"),
      smtp.messages[0]?.data,
    ];
    for (const body of bodies) {
      expect(body).toBeTruthy();
      expect(body).not.toContain(canary);
      expect(body).not.toContain("CANARY");
    }
    // Positive control: the allowed identifiers do travel.
    expect(bodies[0]).toContain('"outcome":"failed"');
    expect(bodies[2]).toContain("run.failed");
  });

  it("OPS-025 an isolated restore sends nothing until the flag is cleared", async () => {
    const h = await harness();
    const receiver = await h.receiver();
    await h.webhook(receiver);
    h.app.database.run(
      "INSERT INTO operational_state(key,value) VALUES('restore:isolated','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    );
    h.completedRun();
    expect(await h.tick()).toEqual({ created: 0, attempted: 0 });
    expect(receiver.requests).toHaveLength(0);
    h.app.database.run("UPDATE operational_state SET value='0' WHERE key='restore:isolated'");
    await h.settle();
    expect(receiver.requests).toHaveLength(1);
  });
});
