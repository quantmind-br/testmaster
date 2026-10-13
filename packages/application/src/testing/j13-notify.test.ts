import { afterEach, expect, it } from "vitest";
import { runNotificationOutage } from "./j13-notify.js";
import { createNotificationHarness, type NotificationHarness } from "./notification-harness.js";

const open: NotificationHarness[] = [];
afterEach(async () => {
  for (const item of open.splice(0)) await item.close();
});

it("INT-003 INT-026 OPS-011 the J13 notify scenario retries a Slack outage and a webhook timeout under one delivery ID each without rerunning the Run", async () => {
  const h = await createNotificationHarness();
  open.push(h);
  const report = await runNotificationOutage(h);

  // Slack answered 503 twice, then recovered: three requests, one delivery, one event.
  expect(report.slack).toMatchObject({
    state: "delivered",
    attempts: 3,
    requests: 3,
    distinctDeliveryIds: 1,
    distinctEventIds: 1,
    sawUncertainAttempt: false,
  });
  // The webhook timed out after the request was sent: uncertain, retried under the same IDs.
  expect(report.webhook).toMatchObject({
    state: "delivered",
    attempts: 2,
    requests: 2,
    distinctDeliveryIds: 1,
    distinctEventIds: 1,
    sawUncertainAttempt: true,
  });
  // Neither destination can rerun a Run or move its verdict.
  expect(report.runsAfter).toBe(report.runsBefore);
  expect(report.runAfter).toEqual(report.runBefore);
  // Negative control: the two destinations never share a delivery.
  expect(report.slack.deliveryId).not.toBe(report.webhook.deliveryId);
});
