import { afterEach, expect, it } from "vitest";
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

it("SEC-013 a webhook integration cannot be configured for a plain http URL, and the https one delivers a signed, timestamped request", async () => {
  const h = await harness();
  const receiver = await h.receiver();
  const signing = await h.secret("hook-plain", "whsec_current", [receiver.origin]);
  const plainUrl = receiver.url.replace(/^https:/u, "http:");
  expect(plainUrl.startsWith("http://")).toBe(true);
  expect(() =>
    h.app.integrations.create({
      provider: "webhook",
      name: "plain-http",
      projectIds: [h.projectId],
      events: ["run.completed", "run.failed"],
      consent: { scopes: ["notify:webhook"] },
      secretRefs: [signing],
      settings: { url: plainUrl, signingSecretRef: signing },
    }),
  ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  expect(h.app.integrations.list()).toEqual([]);
  h.completedRun();
  await h.settle();
  expect(receiver.requests).toHaveLength(0);

  // Positive control: the https configuration delivers once, carrying timestamp and signature.
  await h.webhook(receiver);
  h.completedRun({ outcome: "failed" });
  await h.settle();
  expect(receiver.requests).toHaveLength(1);
  const [request] = receiver.requests;
  expect(request?.headers["testmaster-timestamp"]).toMatch(/^\d{10}$/u);
  expect(request?.headers["testmaster-signature"]).toMatch(/^t=\d{10},v1=[0-9a-f]{64}$/u);
});

it("SEC-013 a signing secret bound to another origin never sends the notification to this webhook URL", async () => {
  const h = await harness();
  const receiver = await h.receiver();
  const elsewhere = await h.secret("hook-elsewhere", "whsec_current", ["https://other.example"]);
  await h.app.integrations.create({
    provider: "webhook",
    name: "wrong-origin",
    projectIds: [h.projectId],
    events: ["run.completed", "run.failed"],
    consent: { scopes: ["notify:webhook"] },
    secretRefs: [elsewhere],
    settings: { url: receiver.url, signingSecretRef: elsewhere },
  });
  h.completedRun({ outcome: "failed" });
  await h.settle();
  expect(receiver.requests).toHaveLength(0);
  expect(h.service.list()[0]).toMatchObject({
    state: "dead_letter",
    lastReasonCode: "secret_origin_mismatch",
  });
});
