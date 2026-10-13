/**
 * Notification integrations and deliveries as the portal presents them (ADR-021, INT-004,
 * INT-026). The portal package does not depend on `@testmaster/contracts`, so the vocabulary below
 * mirrors `packages/contracts/src/m4/notifications.ts`; `notifications.test.ts` fails when the two
 * drift apart.
 */
export const notificationTypes = [
  "run.completed",
  "run.failed",
  "run.recovered",
  "batch.completed",
  "schedule.misfire",
  "schedule.paused",
  "delivery.dead_letter",
  "worker.offline",
  "resource.orphaned",
  "alert.fired",
  "integration.test",
] as const;
export type NotificationType = (typeof notificationTypes)[number];
/** The labelled test event is never subscribable. */
export const subscribableNotificationTypes = notificationTypes.filter(
  (type) => type !== "integration.test",
);
export const notificationTypeLabels: Readonly<Record<NotificationType, string>> = {
  "run.completed": "Run completed",
  "run.failed": "Run failed",
  "run.recovered": "Run recovered (passed after a non-passing Run)",
  "batch.completed": "Batch completed",
  "schedule.misfire": "Schedule misfire",
  "schedule.paused": "Schedule paused",
  "delivery.dead_letter": "Delivery moved to the dead-letter queue",
  "worker.offline": "Worker offline",
  "resource.orphaned": "Resource orphaned (cleanup unconfirmed)",
  "alert.fired": "Alert fired",
  "integration.test": "Test delivery",
};
export const deliveryStates = ["pending", "delivered", "dead_letter"] as const;
export type DeliveryState = (typeof deliveryStates)[number];
export const redactionLevels = ["summary", "minimal"] as const;
export type RedactionLevel = (typeof redactionLevels)[number];
export const notificationProviders = ["slack", "webhook", "email"] as const;
export type NotificationProvider = (typeof notificationProviders)[number];
export const providerLabels: Readonly<Record<NotificationProvider, string>> = {
  slack: "Slack",
  webhook: "Webhook",
  email: "Email",
};
/** Scope the provider needs before it may send (`requiredScopes` of each adapter). */
export const requiredConsent: Readonly<
  Record<NotificationProvider, { scope: string; text: string }>
> = {
  slack: { scope: "notify:slack", text: "Send TestMaster notifications to the Slack channel." },
  webhook: { scope: "notify:webhook", text: "Send signed TestMaster notifications to the URL." },
  email: { scope: "notify:email", text: "Send TestMaster notifications through the SMTP server." },
};
/** Shown wherever an attempt or a delivery may have reached its destination (INT-026). */
export const uncertainText = "Outcome uncertain — the destination may have received it";

export type IntegrationState = "active" | "paused" | "revoked";

/**
 * Provider settings as the server stores them. Every write is validated against the provider's
 * schema, so a stored document always has this shape; each provider uses its own subset.
 */
export interface IntegrationSettings {
  readonly secretRef?: string;
  readonly smtpSecretRef?: string;
  readonly signingSecretRef?: string;
  readonly previousSigningSecretRef?: string;
  readonly previousSecretUntil?: string;
  readonly url?: string;
  readonly security?: "tls" | "starttls";
  readonly from?: string;
  readonly recipients?: readonly string[];
  readonly subjectPrefix?: string;
  readonly allowedRecipientDomains?: readonly string[];
  readonly rules?: {
    readonly environmentIds?: readonly string[];
    readonly suiteIds?: readonly string[];
  };
  readonly redaction?: { readonly level?: string };
}

/** `GET /v1/integrations` item (`IntegrationMetadata`). Secret values are never part of it. */
export interface IntegrationDocument {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly state: IntegrationState;
  readonly projectIds: readonly string[];
  readonly events: readonly string[];
  readonly consent: { readonly scopes: readonly string[] };
  readonly secretRefs: readonly string[];
  readonly settings: IntegrationSettings;
  readonly adapterStatus: string;
  readonly lastTest: {
    readonly deliveryId: string;
    readonly state: string;
    readonly at: string;
    readonly detail: string | null;
  } | null;
  readonly version: number;
}

export interface TestReceipt {
  readonly integrationId: string;
  readonly deliveryId: string;
  readonly label: string;
  readonly state: string;
  readonly detail: string | null;
}

interface DeliveryBase {
  readonly id: string;
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly lastError: string | null;
  readonly createdAt?: string;
}

export interface NotificationDelivery extends DeliveryBase {
  readonly kind: "notification";
  readonly integrationId: string;
  readonly provider: string;
  readonly eventRef: string;
  readonly type: string;
  readonly deliveryId: string;
  readonly outcomeUncertain: boolean;
  readonly lastReasonCode: string | null;
  readonly payloadHash: string;
  readonly updatedAt: string;
  readonly deliveredAt: string | null;
}

/** GitHub check deliveries (`dlv_`) share the `/deliveries` collection. */
export interface CheckDelivery extends DeliveryBase {
  readonly checkName?: string;
  readonly subjectSha?: string;
  readonly conclusion?: string | null;
  readonly destinationRef?: string;
}

export type DeliveryRow = NotificationDelivery | CheckDelivery;

export interface NotificationAttempt {
  readonly number: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly outcome: string;
  readonly httpStatus: number | null;
  readonly uncertain: boolean;
  readonly reasonCode: string | null;
  readonly detail: string | null;
}

export interface NotificationPayload {
  readonly eventId: string;
  readonly deliveryId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly test: boolean;
  readonly projectId: string | null;
  readonly runId: string | null;
  readonly batchId: string | null;
  readonly scheduleId: string | null;
  readonly summary: {
    readonly outcome: string | null;
    readonly gate: string | null;
    readonly counts: Readonly<Record<string, number>> | null;
    readonly reasonCode: string | null;
  };
  readonly link: string;
}

export interface NotificationDeliveryDetail extends NotificationDelivery {
  readonly attemptLog: readonly NotificationAttempt[];
  readonly payload: NotificationPayload;
}

/** `GET /deliveries/{id}`: a notification delivery with its attempt log, or a GitHub check delivery. */
export type DeliveryDetail = NotificationDeliveryDetail | CheckDelivery;

export function isNotificationDelivery(row: DeliveryRow): row is NotificationDelivery {
  return row.id.startsWith("ntd_");
}

export function isNotificationProvider(value: string): value is NotificationProvider {
  return notificationProviders.some((provider) => provider === value);
}

/** One line of the integrations table: what the rules narrow and how much each message carries. */
export function describeRules(integration: IntegrationDocument): string {
  const { rules, redaction } = integration.settings;
  return [
    `Environments: ${rules?.environmentIds?.length || "all"}`,
    `Suites: ${rules?.suiteIds?.length || "all"}`,
    `Redaction: ${redaction?.level ?? "summary"}`,
  ].join(" · ");
}

export interface IntegrationForm {
  provider: NotificationProvider;
  name: string;
  events: readonly string[];
  projectIds: readonly string[];
  environmentIds: readonly string[];
  suiteIds: readonly string[];
  redaction: RedactionLevel;
  consented: boolean;
  /** Slack webhook-URL secret, webhook signing secret or SMTP credentials secret. */
  secretRef: string;
  url: string;
  security: "tls" | "starttls";
  from: string;
  recipients: string;
  subjectPrefix: string;
  allowedRecipientDomains: string;
}

export function emptyForm(provider: NotificationProvider = "webhook"): IntegrationForm {
  return {
    provider,
    name: "",
    events: [],
    projectIds: [],
    environmentIds: [],
    suiteIds: [],
    redaction: "summary",
    consented: false,
    secretRef: "",
    url: "",
    security: "tls",
    from: "",
    recipients: "",
    subjectPrefix: "",
    allowedRecipientDomains: "",
  };
}

/** Edit starts from what is stored; consent counts as given when it already covers the provider's scope. */
export function formFromIntegration(integration: IntegrationDocument): IntegrationForm {
  const provider = isNotificationProvider(integration.provider) ? integration.provider : "webhook";
  const settings = integration.settings;
  return {
    provider,
    name: integration.name,
    events: integration.events,
    projectIds: integration.projectIds,
    environmentIds: settings.rules?.environmentIds ?? [],
    suiteIds: settings.rules?.suiteIds ?? [],
    redaction: settings.redaction?.level === "minimal" ? "minimal" : "summary",
    consented: integration.consent.scopes.includes(requiredConsent[provider].scope),
    secretRef: settings.secretRef ?? settings.smtpSecretRef ?? settings.signingSecretRef ?? "",
    url: settings.url ?? "",
    security: settings.security ?? "tls",
    from: settings.from ?? "",
    recipients: (settings.recipients ?? []).join("\n"),
    subjectPrefix: settings.subjectPrefix ?? "",
    allowedRecipientDomains: (settings.allowedRecipientDomains ?? []).join("\n"),
  };
}

export type FormField =
  | "name"
  | "events"
  | "secretRef"
  | "url"
  | "from"
  | "recipients"
  | "domains"
  | "subjectPrefix"
  | "consent";

export interface FormIssue {
  readonly field: FormField;
  readonly message: string;
}

const addressPattern = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}$/u;
const domainPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u;
const secretLabel: Record<NotificationProvider, string> = {
  slack: "the secret that holds the Slack incoming-webhook URL",
  webhook: "the webhook signing secret",
  email: "the secret that holds the SMTP credentials",
};

/** Comma, semicolon, space or newline separated entries, lower-cased and de-duplicated when `fold`. */
export function splitList(value: string, fold = false): string[] {
  const entries = value
    .split(/[\s,;]+/u)
    .map((entry) => (fold ? entry.toLowerCase() : entry))
    .filter((entry) => entry !== "");
  return [...new Set(entries)];
}

export function validateForm(form: IntegrationForm): FormIssue[] {
  const issues: FormIssue[] = [];
  const name = form.name.trim();
  if (name === "" || name.length > 200)
    issues.push({ field: "name", message: "Enter a name of 1 to 200 characters." });
  if (form.events.length === 0)
    issues.push({ field: "events", message: "Choose at least one event to notify about." });
  if (form.secretRef === "")
    issues.push({ field: "secretRef", message: `Choose ${secretLabel[form.provider]}.` });
  if (form.provider === "webhook") {
    let secure = false;
    try {
      secure = new URL(form.url).protocol === "https:" && form.url.length <= 2000;
    } catch {
      secure = false;
    }
    if (!secure) issues.push({ field: "url", message: "Enter an https:// URL." });
  }
  if (form.provider === "email") {
    if (!addressPattern.test(form.from.trim()))
      issues.push({ field: "from", message: "Enter the sender as name@example.test." });
    const recipients = splitList(form.recipients);
    if (
      recipients.length === 0 ||
      recipients.length > 20 ||
      !recipients.every((entry) => addressPattern.test(entry))
    )
      issues.push({ field: "recipients", message: "Enter 1 to 20 recipient addresses." });
    const domains = splitList(form.allowedRecipientDomains, true);
    if (
      domains.length === 0 ||
      domains.length > 20 ||
      !domains.every((entry) => domainPattern.test(entry))
    )
      issues.push({
        field: "domains",
        message: "Enter 1 to 20 allowed recipient domains, such as example.test.",
      });
    if (form.subjectPrefix.length > 120 || /[\r\n]/u.test(form.subjectPrefix))
      issues.push({
        field: "subjectPrefix",
        message: "Use a single-line subject prefix of at most 120 characters.",
      });
  }
  if (!form.consented)
    issues.push({
      field: "consent",
      message: `Grant ${requiredConsent[form.provider].scope} to allow this integration to send.`,
    });
  return issues;
}

/**
 * Provider `settings` for the form. `base` carries what the portal does not edit (a webhook
 * rotation window), so saving an integration never drops it.
 */
export function buildSettings(
  form: IntegrationForm,
  base: IntegrationSettings = {},
): IntegrationSettings {
  const rules = {
    ...(form.environmentIds.length > 0 ? { environmentIds: form.environmentIds } : {}),
    ...(form.suiteIds.length > 0 ? { suiteIds: form.suiteIds } : {}),
  };
  const common = {
    ...(Object.keys(rules).length > 0 ? { rules } : {}),
    redaction: { level: form.redaction },
  };
  if (form.provider === "slack") return { secretRef: form.secretRef, ...common };
  if (form.provider === "email")
    return {
      smtpSecretRef: form.secretRef,
      security: form.security,
      from: form.from.trim(),
      recipients: splitList(form.recipients),
      ...(form.subjectPrefix === "" ? {} : { subjectPrefix: form.subjectPrefix }),
      allowedRecipientDomains: splitList(form.allowedRecipientDomains, true),
      ...common,
    };
  const rotation =
    base.previousSigningSecretRef && base.previousSecretUntil
      ? {
          previousSigningSecretRef: base.previousSigningSecretRef,
          previousSecretUntil: base.previousSecretUntil,
        }
      : {};
  return { url: form.url.trim(), signingSecretRef: form.secretRef, ...rotation, ...common };
}

/** The secrets the settings reference; the integration must list every one of them. */
export function referencedSecrets(settings: IntegrationSettings): string[] {
  return [
    settings.secretRef,
    settings.smtpSecretRef,
    settings.signingSecretRef,
    settings.previousSigningSecretRef,
  ].filter((value) => value !== undefined);
}

export interface IntegrationBody {
  readonly name: string;
  readonly projectIds: readonly string[];
  readonly events: readonly string[];
  readonly consent: { readonly scopes: readonly string[] };
  readonly secretRefs: readonly string[];
  readonly settings: IntegrationSettings;
}

/** Body of `POST /integrations` (with `provider`) or `PATCH /integrations/{id}` (without it). */
export function buildBody(form: IntegrationForm, current?: IntegrationDocument): IntegrationBody {
  const settings = buildSettings(form, current?.settings);
  return {
    name: form.name.trim(),
    projectIds: form.projectIds,
    events: form.events,
    consent: { scopes: [requiredConsent[form.provider].scope] },
    secretRefs: referencedSecrets(settings),
    settings,
  };
}

/** A pasted ID or label never needs more than this in a screen-reader name or a dialog line. */
export const shortNameLength = 60;
