import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { entities } from "../entities.js";
import * as P from "../primitives.js";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** Events a notification channel can subscribe to (ADR-021). `integration.test` is never fanned out. */
export const notificationTypes = [
  "run.completed",
  "run.failed",
  "batch.completed",
  "schedule.misfire",
  "schedule.paused",
  "delivery.dead_letter",
  "worker.offline",
  "alert.fired",
  "integration.test",
] as const;
export type NotificationType = (typeof notificationTypes)[number];
/** The types an integration may subscribe to: everything except the labelled test event. */
export const subscribableNotificationTypes = notificationTypes.filter(
  (type) => type !== "integration.test",
);
export const notificationRedactionLevels = ["summary", "minimal"] as const;
export const notificationDeliveryStates = ["pending", "delivered", "dead_letter"] as const;
export const notificationAttemptOutcomes = [
  "in_flight",
  "delivered",
  "failed",
  "rejected",
  "abandoned",
] as const;
/** Outbound HTTP header names an HTTP receiver can rely on (ADR-021). */
export const NOTIFICATION_SIGNATURE_HEADERS = {
  eventId: "testmaster-event-id",
  deliveryId: "testmaster-delivery-id",
  timestamp: "testmaster-timestamp",
  signature: "testmaster-signature",
} as const;
/** Consumers should reject a delivery whose timestamp is older than this (seconds). */
export const NOTIFICATION_REPLAY_TOLERANCE_SECONDS = 300;
/** A rotated webhook secret keeps signing alongside the new one for this long. */
export const NOTIFICATION_ROTATION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const NOTIFICATION_PAYLOAD_VERSION = "1.0.0" as const;

const SecretId = P.id("sec");
const NotificationDeliveryId = Type.String({ pattern: `^ntd_${P.uuidPattern}$` });
const Counts = P.Obj({
  passed: P.Nonnegative,
  failed: P.Nonnegative,
  blocked: P.Nonnegative,
  cancelled: P.Nonnegative,
  inconclusive: P.Nonnegative,
});
const Redaction = P.Obj({ level: P.Enum(notificationRedactionLevels) });
/** Only deliveries that match every present filter are created; an absent filter matches everything. */
const Rules = P.Obj({
  suiteIds: Type.Optional(Type.Array(P.id("sui"), { maxItems: 100 })),
  environmentIds: Type.Optional(Type.Array(P.id("env"), { maxItems: 100 })),
});
const Domain = Type.String({
  pattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$",
});

const NotificationDeliverySummary = {
  id: NotificationDeliveryId,
  kind: Type.Literal("notification"),
  workspaceId: P.id("ws"),
  integrationId: Type.String({ pattern: `^int_${P.uuidPattern}$` }),
  provider: P.Enum(["slack", "email", "webhook"]),
  /** Outbox event (or the synthetic batch key) this delivery notifies about. */
  eventRef: P.Name,
  type: P.Enum(notificationTypes),
  /** Stable across every retry; the receiver dedupes on it. At-least-once, never exactly-once. */
  deliveryId: P.Name,
  state: P.Enum(notificationDeliveryStates),
  attempts: P.Nonnegative,
  nextAttemptAt: nullable(P.Timestamp),
  /** True when a request may have reached the destination but its outcome was not observed. */
  outcomeUncertain: Type.Boolean(),
  lastReasonCode: nullable(P.Name),
  lastError: nullable(P.Description),
  payloadHash: P.ContentDigest,
  createdAt: P.Timestamp,
  updatedAt: P.Timestamp,
  deliveredAt: nullable(P.Timestamp),
  version: P.Version,
};
const NotificationAttempt = P.Obj({
  number: P.Positive,
  startedAt: P.Timestamp,
  finishedAt: nullable(P.Timestamp),
  outcome: P.Enum(notificationAttemptOutcomes),
  httpStatus: nullable(Type.Integer({ minimum: 100, maximum: 599 })),
  uncertain: Type.Boolean(),
  reasonCode: nullable(P.Name),
  detail: nullable(P.Description),
});
const NotificationPayload = P.Obj({
  schemaVersion: Type.Literal(NOTIFICATION_PAYLOAD_VERSION),
  eventId: P.Name,
  deliveryId: P.Name,
  type: P.Enum(notificationTypes),
  occurredAt: P.Timestamp,
  test: Type.Boolean(),
  workspaceId: P.id("ws"),
  projectId: nullable(P.id("prj")),
  runId: nullable(P.id("run")),
  batchId: nullable(P.id("bat")),
  scheduleId: nullable(P.id("sch")),
  summary: P.Obj({
    outcome: nullable(P.Outcome),
    gate: nullable(P.Gate),
    counts: nullable(Counts),
    reasonCode: nullable(P.Name),
  }),
  link: P.Name,
});

export const notificationContracts = {
  NotificationRedaction: Redaction,
  NotificationRules: Rules,
  SlackSettings: P.Obj({
    /** Reference of the secret holding the Slack incoming-webhook URL. */
    secretRef: SecretId,
    rules: Type.Optional(Rules),
    redaction: Type.Optional(Redaction),
  }),
  EmailSettings: P.Obj({
    /** Secret holding JSON `{host, port, user, password}`; bound to `https://<host>:<port>`. */
    smtpSecretRef: SecretId,
    security: P.Enum(["tls", "starttls"]),
    from: Type.String({ pattern: '^[^\\s@<>"]{1,64}@[^\\s@<>"]{1,190}$' }),
    recipients: Type.Array(Type.String({ pattern: '^[^\\s@<>"]{1,64}@[^\\s@<>"]{1,190}$' }), {
      minItems: 1,
      maxItems: 20,
    }),
    /** Optional subject prefix; a CR or LF in it is refused at send time as `header_injection`. */
    subjectPrefix: Type.Optional(Type.String({ maxLength: 120 })),
    allowedRecipientDomains: Type.Array(Domain, { minItems: 1, maxItems: 20 }),
    rules: Type.Optional(Rules),
    redaction: Type.Optional(Redaction),
  }),
  WebhookSettings: P.Obj({
    url: Type.String({ pattern: "^https://", maxLength: 2000 }),
    signingSecretRef: SecretId,
    /** The superseded signing secret, accepted by consumers until `previousSecretUntil`. */
    previousSigningSecretRef: Type.Optional(SecretId),
    previousSecretUntil: Type.Optional(P.Timestamp),
    rules: Type.Optional(Rules),
    redaction: Type.Optional(Redaction),
  }),
  NotificationPayload,
  NotificationAttempt,
  NotificationDelivery: P.Obj(NotificationDeliverySummary),
  NotificationDeliveryDetail: P.Obj({
    ...NotificationDeliverySummary,
    attemptLog: Type.Array(NotificationAttempt),
    payload: NotificationPayload,
  }),
};
const NotificationDelivery = notificationContracts.NotificationDelivery;
const NotificationDeliveryDetail = notificationContracts.NotificationDeliveryDetail;
/** `/deliveries` serves GitHub check deliveries and notification deliveries side by side. */
export const deliveryContracts = {
  DeliveryRecord: Type.Union([entities.Delivery, NotificationDelivery]),
  DeliveryDetail: Type.Union([entities.Delivery, NotificationDeliveryDetail]),
};
export type NotificationPayload = Static<typeof NotificationPayload>;
export type NotificationAttempt = Static<typeof NotificationAttempt>;
export type NotificationDelivery = Static<typeof NotificationDelivery>;
export type NotificationDeliveryDetail = Static<typeof NotificationDeliveryDetail>;
export type SlackSettings = Static<typeof notificationContracts.SlackSettings>;
export type EmailSettings = Static<typeof notificationContracts.EmailSettings>;
export type WebhookSettings = Static<typeof notificationContracts.WebhookSettings>;
export type NotificationRedaction = Static<typeof Redaction>;
export type NotificationRules = Static<typeof Rules>;
