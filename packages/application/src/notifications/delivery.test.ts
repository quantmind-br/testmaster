import { createHmac } from "node:crypto";
import { ContractError, validate } from "@testmaster/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNotificationHarness,
  type NotificationHarness,
} from "../testing/notification-harness.js";
import { createReferenceConsumer } from "../testing/notifications.js";
import { signNotification, verifyNotification } from "./signature.js";

const open: NotificationHarness[] = [];
async function harness(): Promise<NotificationHarness> {
  const created = await createNotificationHarness();
  open.push(created);
  return created;
}
afterEach(async () => {
  for (const item of open.splice(0)) await item.close();
});

function rejectedCode(call: () => unknown): Promise<string | undefined> {
  return Promise.resolve()
    .then(call)
    .then(
      () => undefined,
      (error: unknown) => (error instanceof ContractError ? error.code : "NOT_A_CONTRACT_ERROR"),
    );
}

describe("INT-027 outbound webhooks are signed over the original bytes", () => {
  it("INT-027 a consumer validates the original bytes, dedupes on the delivery ID and rejects a tampered body", async () => {
    const h = await harness();
    const receiver = await h.receiver();
    await h.webhook(receiver);
    const consumer = createReferenceConsumer(["whsec_current"], () => h.clock.now);
    receiver.behave((request) => {
      const verdict = consumer.handle(request);
      return { status: verdict.status };
    });
    const { runId } = h.completedRun({ outcome: "failed", reasonCode: "assertion_failed" });
    await h.settle();

    expect(receiver.requests).toHaveLength(1);
    const [request] = receiver.requests;
    if (!request) throw new Error("Missing request");
    expect(request.headers["testmaster-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/u);
    expect(request.headers["testmaster-event-id"]).toBeTruthy();
    expect(request.headers["testmaster-delivery-id"]).toMatch(/^ntd_/u);
    expect(consumer.accepted).toHaveLength(1);
    const payload = JSON.parse(request.body.toString("utf8"));
    validate("NotificationPayload", payload);
    expect(payload.runId).toBe(runId);

    // Replaying the exact request is a duplicate, not a second acceptance.
    expect(consumer.handle(request)).toMatchObject({ status: 200, outcome: "duplicate" });
    expect(consumer.accepted).toHaveLength(1);

    // One flipped byte in the body breaks the signature.
    const tampered = {
      ...request,
      body: Buffer.from(request.body.toString("utf8").replace("failed", "passed")),
    };
    expect(consumer.handle(tampered)).toMatchObject({
      status: 401,
      outcome: "rejected",
      reason: "signature_mismatch",
    });
    expect(consumer.accepted).toHaveLength(1);
  });

  it("INT-027 a consumer with the wrong secret or a stale timestamp refuses the delivery", async () => {
    const h = await harness();
    const receiver = await h.receiver();
    await h.webhook(receiver);
    h.completedRun();
    await h.settle();
    const [request] = receiver.requests;
    if (!request) throw new Error("Missing request");

    const wrongSecret = createReferenceConsumer(["whsec_other"], () => h.clock.now);
    expect(wrongSecret.handle(request)).toMatchObject({
      status: 401,
      reason: "signature_mismatch",
    });

    const stale = new Date(h.clock.now.getTime() + 301_000);
    const late = createReferenceConsumer(["whsec_current"], () => stale);
    expect(late.handle(request)).toMatchObject({ status: 401, reason: "stale_timestamp" });

    const fresh = createReferenceConsumer(["whsec_current"], () => h.clock.now);
    expect(fresh.handle(request)).toMatchObject({ status: 200, outcome: "accepted" });
  });

  it("INT-027 a rotation signs with both secrets only inside the controlled window", async () => {
    const h = await harness();
    const receiver = await h.receiver();
    const previous = await h.secret("whsec-previous", "whsec_previous", [receiver.origin]);
    const current = await h.secret("whsec-current", "whsec_current", [receiver.origin]);
    // The adapter reads the real clock, so the window is short enough to let expire.
    const windowEnd = new Date(Date.now() + 2_000).toISOString();
    const integration = await h.app.integrations.create({
      provider: "webhook",
      name: "rotating",
      projectIds: [h.projectId],
      events: ["run.failed"],
      consent: { scopes: ["notify:webhook"] },
      secretRefs: [current, previous],
      settings: {
        url: receiver.url,
        signingSecretRef: current,
        previousSigningSecretRef: previous,
        previousSecretUntil: windowEnd,
      },
    });
    h.completedRun();
    await h.settle();
    const [inside] = receiver.requests;
    if (!inside) throw new Error("Missing request");
    expect(inside.headers["testmaster-signature"]?.match(/v1=/gu)).toHaveLength(2);
    // A consumer still holding only the previous secret keeps verifying during the window.
    expect(
      createReferenceConsumer(["whsec_previous"], () => h.clock.now).handle(inside).status,
    ).toBe(200);
    expect(
      createReferenceConsumer(["whsec_current"], () => h.clock.now).handle(inside).status,
    ).toBe(200);

    // After the window closes only the current secret signs.
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    h.completedRun();
    await h.settle();
    const outside = receiver.requests.at(-1);
    if (!outside || outside === inside) throw new Error("Missing second request");
    expect(outside.headers["testmaster-signature"]?.match(/v1=/gu)).toHaveLength(1);
    expect(
      createReferenceConsumer(["whsec_previous"], () => h.clock.now).handle(outside),
    ).toMatchObject({ status: 401 });
    expect(
      createReferenceConsumer(["whsec_current"], () => h.clock.now).handle(outside).status,
    ).toBe(200);

    // The window cannot exceed 24 hours and needs both halves.
    const tooLong = new Date(Date.now() + 25 * 3_600_000).toISOString();
    expect(
      await rejectedCode(() =>
        h.app.integrations.update(
          integration.id,
          {
            settings: {
              url: receiver.url,
              signingSecretRef: current,
              previousSigningSecretRef: previous,
              previousSecretUntil: tooLong,
            },
          },
          integration.version,
        ),
      ),
    ).toBe("INVALID_ARGUMENT");
    expect(
      await rejectedCode(() =>
        h.app.integrations.update(
          integration.id,
          {
            settings: {
              url: receiver.url,
              signingSecretRef: current,
              previousSigningSecretRef: previous,
            },
          },
          integration.version,
        ),
      ),
    ).toBe("INVALID_ARGUMENT");
  });

  it("INT-027 signNotification and verifyNotification agree on the documented HMAC construction", () => {
    const body = Buffer.from('{"a":1}');
    const header = signNotification(["s3cret"], 1_780_000_000, "ntd_x", body);
    const expected = createHmac("sha256", "s3cret")
      .update(`1780000000.ntd_x.${body.toString("utf8")}`)
      .digest("hex");
    expect(header).toBe(`t=1780000000,v1=${expected}`);
    const now = new Date(1_780_000_100_000);
    expect(
      verifyNotification({ header, deliveryId: "ntd_x", body, secrets: ["s3cret"], now }),
    ).toMatchObject({ valid: true });
    expect(
      verifyNotification({ header, deliveryId: "ntd_y", body, secrets: ["s3cret"], now }),
    ).toMatchObject({ valid: false });
    expect(
      verifyNotification({
        header: "garbage",
        deliveryId: "ntd_x",
        body,
        secrets: ["s3cret"],
        now,
      }),
    ).toMatchObject({ valid: false, reason: "malformed_signature" });
  });
});
