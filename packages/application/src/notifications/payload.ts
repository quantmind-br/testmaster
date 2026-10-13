import {
  ContractError,
  NOTIFICATION_PAYLOAD_VERSION,
  type NotificationPayload,
  type NotificationRedaction,
  type NotificationType,
  validate,
} from "@testmaster/contracts";
import { canonicalJson, scrubEvidenceText } from "@testmaster/domain";

export const defaultPublicOrigin = "http://127.0.0.1:7331";
const reasonShape = /^[a-z][a-z0-9_.-]{0,63}$/u;

/** What the dispatcher knows about one notifiable event; nothing here is free text from a Run. */
export interface NotificationSource {
  type: NotificationType;
  eventId: string;
  deliveryId: string;
  occurredAt: string;
  test: boolean;
  workspaceId: string;
  projectId?: string | null;
  runId?: string | null;
  batchId?: string | null;
  scheduleId?: string | null;
  outcome?: NotificationPayload["summary"]["outcome"];
  gate?: NotificationPayload["summary"]["gate"];
  counts?: NotificationPayload["summary"]["counts"];
  reasonCode?: string | null;
  /** Portal path (leading slash) the message links to. */
  linkPath: string;
}

/**
 * Builds the frozen v1.0.0 payload from an allowlist of identifiers and verdict fields. Titles,
 * step logs, screenshots, request tokens and secret values have no field to travel in.
 */
export function buildNotificationPayload(
  source: NotificationSource,
  publicOrigin: string,
  redaction: NotificationRedaction = { level: "summary" },
): NotificationPayload {
  const minimal = redaction.level === "minimal";
  const reason = source.reasonCode ?? null;
  const payload: NotificationPayload = {
    schemaVersion: NOTIFICATION_PAYLOAD_VERSION,
    eventId: source.eventId,
    deliveryId: source.deliveryId,
    type: source.type,
    occurredAt: source.occurredAt,
    test: source.test,
    workspaceId: source.workspaceId,
    projectId: source.projectId ?? null,
    runId: source.runId ?? null,
    batchId: source.batchId ?? null,
    scheduleId: source.scheduleId ?? null,
    summary: {
      outcome: source.outcome ?? null,
      gate: source.gate ?? null,
      counts: minimal ? null : (source.counts ?? null),
      reasonCode:
        minimal || reason === null ? null : reasonShape.test(reason) ? reason : "unspecified",
    },
    link: `${publicOrigin.replace(/\/+$/u, "")}${source.linkPath}`,
  };
  validate("NotificationPayload", payload);
  return payload;
}

/** The exact bytes that are signed, stored and re-sent on every retry. */
export function notificationBody(payload: NotificationPayload): Buffer {
  return Buffer.from(canonicalJson(payload), "utf8");
}

/**
 * Last line of defence before bytes leave the platform: the default secret and PII patterns plus
 * every secret value the integration owns must not appear anywhere in the body.
 */
export function assertNoSecrets(body: Buffer, secrets: readonly string[] = []): void {
  const text = body.toString("utf8");
  if (scrubEvidenceText(text, secrets).redacted)
    throw new ContractError("INTERNAL", "Notification payload failed redaction", {
      reasonCode: "redaction_failed",
    });
}

/** Escapes the three characters Slack mrkdwn treats as control characters. */
export function escapeSlack(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Escapes text for an HTML mail body. */
export function escapeHtml(text: string): string {
  return escapeSlack(text).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** One-line, human-readable rendering shared by Slack and email; every value is an ID or enum. */
export function describeNotification(payload: NotificationPayload): string {
  const parts: string[] = [payload.test ? "[TEST NOTIFICATION]" : "", `TestMaster ${payload.type}`];
  const subject = payload.runId ?? payload.batchId ?? payload.scheduleId ?? payload.projectId;
  if (subject) parts.push(subject);
  if (payload.summary.outcome) parts.push(`outcome ${payload.summary.outcome}`);
  if (payload.summary.gate) parts.push(`gate ${payload.summary.gate}`);
  const counts = payload.summary.counts;
  if (counts)
    parts.push(
      `passed ${counts.passed}, failed ${counts.failed}, blocked ${counts.blocked}, cancelled ${counts.cancelled}, inconclusive ${counts.inconclusive}`,
    );
  if (payload.summary.reasonCode) parts.push(`reason ${payload.summary.reasonCode}`);
  return parts.filter(Boolean).join(" — ");
}
