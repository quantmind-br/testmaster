/**
 * The notification half of journey J13 ("schedule publishes a Batch, Slack is unavailable and a
 * webhook times out; both retry and dedupe without a rerun"). The schedule half belongs to the
 * scheduler slice; this helper takes a harness whose Run just finished and drives the outage.
 * W2 calls it from `j13-schedule-notify.pg.test.ts` after the scheduled Batch completes.
 */

import type { NotificationHarness } from "./notification-harness.js";
import type { HttpsReceiver } from "./notifications.js";

export interface DestinationObservation {
  deliveryId: string;
  state: string;
  attempts: number;
  /** Requests the destination actually received, including retries. */
  requests: number;
  /** Distinct delivery IDs in those requests: 1 means every retry carried the same ID. */
  distinctDeliveryIds: number;
  /** Distinct event IDs in those requests. */
  distinctEventIds: number;
  /** True when one attempt timed out after the request was sent (never reported as "not sent"). */
  sawUncertainAttempt: boolean;
}

export interface NotifyOutageReport {
  slack: DestinationObservation;
  webhook: DestinationObservation;
  /** Runs before the outage and after every retry settled: a delivery retry never reruns a Run. */
  runsBefore: number;
  runsAfter: number;
  /** The Run row (outcome, gate) before and after the outage: notifications never move a verdict. */
  runBefore: Record<string, unknown> | undefined;
  runAfter: Record<string, unknown> | undefined;
}

function observe(
  h: NotificationHarness,
  integrationId: string,
  receiver: HttpsReceiver,
): DestinationObservation {
  const [delivery] = h.service.list({ integrationId });
  if (!delivery) throw new Error("The outage scenario produced no delivery");
  const detail = h.service.get(delivery.id);
  return {
    deliveryId: delivery.id,
    state: delivery.state,
    attempts: delivery.attempts,
    requests: receiver.requests.length,
    distinctDeliveryIds: new Set(receiver.requests.map((r) => r.headers["testmaster-delivery-id"]))
      .size,
    distinctEventIds: new Set(receiver.requests.map((r) => r.headers["testmaster-event-id"])).size,
    sawUncertainAttempt: detail.attemptLog.some((attempt) => attempt.uncertain === true),
  };
}

/**
 * Fails one finished Run, makes Slack answer 503 twice and the webhook hang once (a timeout after
 * the request was sent), then lets the retries settle against the fake clock.
 */
export async function runNotificationOutage(h: NotificationHarness): Promise<NotifyOutageReport> {
  const slackReceiver = await h.receiver("/slack");
  const hookReceiver = await h.receiver("/hook");
  slackReceiver.behave((_request, count) => ({ status: count <= 2 ? 503 : 200 }));
  hookReceiver.behave((_request, count) => (count === 1 ? { hang: true } : { status: 200 }));
  const slack = await h.slack(slackReceiver);
  const webhook = await h.webhook(hookReceiver);

  const { runId } = h.completedRun({ outcome: "failed", gate: "failed" });
  const runRow = () =>
    h.app.database.get(
      "SELECT outcome,gate,phase,status FROM runs WHERE workspace_id=? AND id=?",
      h.workspaceId,
      runId,
    );
  const runCount = () =>
    Number(
      h.app.database.get("SELECT COUNT(*) AS n FROM runs WHERE workspace_id=?", h.workspaceId)?.n,
    );
  const runBefore = runRow();
  const runsBefore = runCount();

  await h.settle();

  return {
    slack: observe(h, slack.id, slackReceiver),
    webhook: observe(h, webhook.id, hookReceiver),
    runsBefore,
    runsAfter: runCount(),
    runBefore,
    runAfter: runRow(),
  };
}
