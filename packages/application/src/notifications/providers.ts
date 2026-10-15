import { isIP } from "node:net";
import {
  ContractError,
  type EmailSettings,
  NOTIFICATION_ROTATION_WINDOW_MS,
  type NotificationPayload,
  SCHEMA_VERSION,
  type SlackSettings,
  subscribableNotificationTypes,
  validate,
  type WebhookSettings,
} from "@testmaster/contracts";
import { sha256 } from "@testmaster/domain";
import { canonicalUrl, EgressPolicy, PolicyDenied } from "@testmaster/sandbox";
import nodemailer from "nodemailer";
import type {
  DeliveryAttemptOutcome,
  DeliveryContext,
  DeliveryOutcome,
  IntegrationProvider,
  IntegrationSecrets,
  OutboundNotification,
  StoredIntegration,
  TestDeliveryContext,
} from "../integrations/provider.js";
import type { IntegrationProviderRegistry } from "../integrations/registry.js";
import { integrationProviders } from "../integrations/registry.js";
import {
  defaultDeliveryTimeoutMs,
  type EgressOptions,
  httpsOrigin,
  type PostResult,
  postHttps,
  systemResolver,
} from "./https.js";
import {
  assertNoSecrets,
  buildNotificationPayload,
  describeNotification,
  escapeHtml,
  escapeSlack,
  notificationBody,
} from "./payload.js";
import { notificationHeaders, signNotification } from "./signature.js";

const adapterVersion = "1.0.0";
const maxRetryAfterMs = 3_600_000;
const crlf = /[\r\n]/u;

function rejected(reasonCode: string, detail: string): DeliveryAttemptOutcome {
  return { state: "rejected", reasonCode, detail };
}
function failed(
  reasonCode: string,
  detail: string,
  extra: Partial<DeliveryAttemptOutcome> = {},
): DeliveryAttemptOutcome {
  return { state: "failed", reasonCode, detail, ...extra };
}

/** Seconds or an HTTP date, bounded: a destination cannot park a delivery for longer than an hour. */
export function parseRetryAfter(value: string | string[] | undefined, now: Date): number | null {
  const text = Array.isArray(value) ? value[0] : value;
  if (!text) return null;
  const seconds = /^[0-9]{1,7}$/u.test(text)
    ? Number(text) * 1000
    : Date.parse(text) - now.getTime();
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, maxRetryAfterMs) : null;
}

const tlsFailures: Record<string, true> = {
  DEPTH_ZERO_SELF_SIGNED_CERT: true,
  SELF_SIGNED_CERT_IN_CHAIN: true,
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: true,
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: true,
  CERT_HAS_EXPIRED: true,
  ERR_TLS_CERT_ALTNAME_INVALID: true,
};

/** Normalizes one HTTP exchange; the destination's answer decides retry versus permanent failure. */
export function classifyHttp(result: PostResult, now: Date): DeliveryAttemptOutcome {
  switch (result.kind) {
    case "denied":
      return rejected("egress_denied", `Destination refused by egress policy: ${result.reason}`);
    case "timeout":
      return failed("timeout", "Destination did not answer in time", { uncertain: result.sent });
    case "error":
      return failed(
        tlsFailures[result.code] ? "tls_error" : "network_error",
        `Transport failed: ${result.code}`,
        { uncertain: result.sent },
      );
    case "response": {
      const status = result.status;
      if (status >= 200 && status < 300) return { state: "delivered", httpStatus: status };
      if (status >= 300 && status < 400)
        return {
          ...rejected("redirect_refused", "Destination answered with a redirect"),
          httpStatus: status,
        };
      if (status === 429)
        return failed("rate_limited", "Destination rate-limited the delivery", {
          httpStatus: status,
          retryAfterMs: parseRetryAfter(result.headers["retry-after"], now),
        });
      if (status === 408 || status >= 500)
        return failed(`http_${status}`, `Destination answered ${status}`, { httpStatus: status });
      return {
        ...rejected(`http_${status}`, `Destination answered ${status}`),
        httpStatus: status,
      };
    }
  }
}

/** Resolves a bound secret, translating "revoked or unavailable" into a permanent failure. */
async function resolveSecret(
  secrets: IntegrationSecrets,
  ref: string,
): Promise<{ value: string; allowedOrigins: readonly string[] } | DeliveryAttemptOutcome> {
  try {
    return await secrets.resolveBound(ref);
  } catch (error) {
    if (error instanceof ContractError && error.code === "CAPABILITY_UNAVAILABLE")
      return failed("secrets_unavailable", "Secret resolution is not available");
    return rejected("secret_unavailable", "The referenced secret cannot be released");
  }
}

function isOutcome(value: unknown): value is DeliveryAttemptOutcome {
  return typeof value === "object" && value !== null && "state" in value;
}

function payloadFor(
  context: DeliveryContext | TestDeliveryContext,
  notification: OutboundNotification | null,
  test: TestDeliveryContext["test"] | null,
  settings: { redaction?: { level: "summary" | "minimal" } },
): NotificationPayload {
  if (notification) return notification.payload;
  if (!test) throw new ContractError("INTERNAL", "A test delivery needs a test marker");
  return buildNotificationPayload(
    {
      type: "integration.test",
      eventId: `test:${test.deliveryId}`,
      deliveryId: test.deliveryId,
      occurredAt: context.now().toISOString(),
      test: true,
      workspaceId: context.workspaceId,
      linkPath: "/settings/notifications",
    },
    context.publicOrigin,
    settings.redaction,
  );
}

function checkOriginBinding(
  secret: { allowedOrigins: readonly string[] },
  url: string,
): DeliveryAttemptOutcome | null {
  const origin = httpsOrigin(url);
  if (!origin) return rejected("egress_denied", "Destination must be an https URL");
  const allowed = secret.allowedOrigins.some((candidate) => {
    try {
      return canonicalUrl(candidate).origin === origin;
    } catch {
      return false;
    }
  });
  return allowed
    ? null
    : rejected("secret_origin_mismatch", "The secret is not bound to this destination");
}

export interface SlackProviderOptions extends EgressOptions {
  /** Hosts a Slack incoming-webhook URL may point at; tests add a local receiver. */
  allowedHosts?: readonly string[];
}

export function createSlackProvider(
  options: SlackProviderOptions = {},
): IntegrationProvider<SlackSettings> {
  const allowedHosts = options.allowedHosts ?? ["hooks.slack.com"];
  async function send(
    context: DeliveryContext | TestDeliveryContext,
    integration: StoredIntegration<SlackSettings>,
    payload: NotificationPayload,
    deliveryId: string,
  ): Promise<DeliveryAttemptOutcome> {
    const secret = await resolveSecret(context.secrets, integration.settings.secretRef);
    if (isOutcome(secret)) return secret;
    let host: string;
    try {
      host = canonicalUrl(secret.value).hostname;
    } catch {
      return rejected("egress_denied", "The Slack secret is not a valid URL");
    }
    if (!allowedHosts.includes(host))
      return rejected("egress_denied", "The Slack secret does not point at a Slack host");
    const mismatch = checkOriginBinding(secret, secret.value);
    if (mismatch) return mismatch;
    const text = `${escapeSlack(describeNotification(payload))}\n<${payload.link}|Open in TestMaster>`;
    const body = Buffer.from(JSON.stringify({ text }), "utf8");
    assertNoSecrets(body, [secret.value]);
    const result = await postHttps(
      secret.value,
      {
        "content-type": "application/json",
        "user-agent": `TestMaster-Notifications/${adapterVersion}`,
        "testmaster-delivery-id": deliveryId,
      },
      body,
      options,
    );
    return classifyHttp(result, context.now());
  }
  return {
    id: "slack",
    version: adapterVersion,
    schemaVersion: SCHEMA_VERSION,
    capabilities: ["notifications", "test-delivery"],
    supportedEvents: subscribableNotificationTypes,
    parseSettings: (input) => {
      validate("SlackSettings", input);
      return input as SlackSettings;
    },
    referencedSecrets: (settings) => [settings.secretRef],
    async sendTest(context, integration): Promise<DeliveryOutcome> {
      const payload = payloadFor(context, null, context.test, integration.settings);
      return send(context, integration, payload, context.test.deliveryId);
    },
    async deliver(context, integration, notification) {
      return send(context, integration, notification.payload, notification.deliveryId);
    },
  };
}

export function createWebhookProvider(
  options: EgressOptions = {},
): IntegrationProvider<WebhookSettings> {
  async function send(
    context: DeliveryContext | TestDeliveryContext,
    integration: StoredIntegration<WebhookSettings>,
    payload: NotificationPayload,
    ids: { eventId: string; deliveryId: string },
  ): Promise<DeliveryAttemptOutcome> {
    const settings = integration.settings;
    const secret = await resolveSecret(context.secrets, settings.signingSecretRef);
    if (isOutcome(secret)) return secret;
    const mismatch = checkOriginBinding(secret, settings.url);
    if (mismatch) return mismatch;
    const signing = [secret.value];
    const now = context.now();
    if (
      settings.previousSigningSecretRef &&
      settings.previousSecretUntil &&
      Date.parse(settings.previousSecretUntil) > now.getTime()
    ) {
      const previous = await resolveSecret(context.secrets, settings.previousSigningSecretRef);
      if (isOutcome(previous)) return previous;
      signing.push(previous.value);
    }
    const body = notificationBody(payload);
    assertNoSecrets(body, signing);
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const result = await postHttps(
      settings.url,
      {
        "content-type": "application/json",
        "user-agent": `TestMaster-Notifications/${adapterVersion}`,
        ...notificationHeaders({
          eventId: ids.eventId,
          deliveryId: ids.deliveryId,
          timestampSeconds,
          signature: signNotification(signing, timestampSeconds, ids.deliveryId, body),
        }),
      },
      body,
      options,
    );
    return classifyHttp(result, now);
  }
  return {
    id: "webhook",
    version: adapterVersion,
    schemaVersion: SCHEMA_VERSION,
    capabilities: ["notifications", "signed-delivery", "test-delivery"],
    supportedEvents: subscribableNotificationTypes,
    parseSettings: (input) => {
      validate("WebhookSettings", input);
      const settings = input as WebhookSettings;
      try {
        if (canonicalUrl(settings.url).protocol !== "https")
          throw new PolicyDenied("protocol_denied");
      } catch {
        throw new ContractError("INVALID_ARGUMENT", "Webhook URL must be a plain https URL");
      }
      if (Boolean(settings.previousSigningSecretRef) !== Boolean(settings.previousSecretUntil))
        throw new ContractError(
          "INVALID_ARGUMENT",
          "A rotation needs both previousSigningSecretRef and previousSecretUntil",
        );
      if (
        settings.previousSecretUntil &&
        Date.parse(settings.previousSecretUntil) >
          Date.now() + NOTIFICATION_ROTATION_WINDOW_MS + 60_000
      )
        throw new ContractError("INVALID_ARGUMENT", "The rotation window is at most 24 hours");
      return settings;
    },
    referencedSecrets: (settings) => [
      settings.signingSecretRef,
      ...(settings.previousSigningSecretRef ? [settings.previousSigningSecretRef] : []),
    ],
    async sendTest(context, integration) {
      const payload = payloadFor(context, null, context.test, integration.settings);
      return send(context, integration, payload, {
        eventId: payload.eventId,
        deliveryId: context.test.deliveryId,
      });
    },
    async deliver(context, integration, notification) {
      return send(context, integration, notification.payload, notification);
    },
  };
}

/** What nodemailer needs to open one SMTP session; tests intercept it to reach a local server. */
export interface SmtpSession {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth: { user: string; pass: string };
  tls: { servername?: string; ca?: string | Buffer; rejectUnauthorized: true };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  disableFileAccess: true;
  disableUrlAccess: true;
}
export interface EmailMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  messageId: string;
  headers: Record<string, string>;
}
export type EmailTransport = (session: SmtpSession, message: EmailMessage) => Promise<void>;

export interface EmailProviderOptions extends EgressOptions {
  /** Replaces the nodemailer transport; the production default opens a real SMTP session. */
  transport?: EmailTransport;
}

const nodemailerTransport: EmailTransport = async (session, message) => {
  const transporter = nodemailer.createTransport(session);
  try {
    await transporter.sendMail(message);
  } finally {
    transporter.close();
  }
};

interface SmtpSecret {
  host: string;
  port: number;
  user: string;
  password: string;
}
function parseSmtpSecret(value: string): SmtpSecret | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { host, port, user, password } = parsed as Record<string, unknown>;
    if (
      typeof host !== "string" ||
      typeof user !== "string" ||
      typeof password !== "string" ||
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !/^[A-Za-z0-9.-]{1,253}$/u.test(host)
    )
      return null;
    return { host, port, user, password };
  } catch {
    return null;
  }
}

function recipientDomain(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

export function createEmailProvider(
  options: EmailProviderOptions = {},
): IntegrationProvider<EmailSettings> {
  const transport = options.transport ?? nodemailerTransport;
  const timeoutMs = options.timeoutMs ?? defaultDeliveryTimeoutMs;
  async function send(
    context: DeliveryContext | TestDeliveryContext,
    integration: StoredIntegration<EmailSettings>,
    payload: NotificationPayload,
    ids: { eventId: string; deliveryId: string },
  ): Promise<DeliveryAttemptOutcome> {
    const settings = integration.settings;
    const allowed = settings.allowedRecipientDomains.map((domain) => domain.toLowerCase());
    const denied = settings.recipients.filter(
      (address) => !allowed.includes(recipientDomain(address)),
    );
    if (denied.length)
      return rejected("recipient_domain_denied", "A recipient is outside the allowed domains");
    const subject = `${settings.subjectPrefix ?? "[TestMaster]"} ${payload.test ? "[TEST] " : ""}${payload.type}${payload.runId ? ` ${payload.runId}` : ""}${payload.summary.outcome ? ` ${payload.summary.outcome}` : ""}`;
    for (const value of [
      subject,
      settings.from,
      ...settings.recipients,
      ids.deliveryId,
      ids.eventId,
    ])
      if (crlf.test(value))
        return rejected("header_injection", "A header value contains a line break");
    const secret = await resolveSecret(context.secrets, settings.smtpSecretRef);
    if (isOutcome(secret)) return secret;
    const smtp = parseSmtpSecret(secret.value);
    if (!smtp) return rejected("secret_unavailable", "The SMTP secret is malformed");
    const origin = `https://${smtp.host}:${smtp.port}`;
    const mismatch = checkOriginBinding(secret, origin);
    if (mismatch) return mismatch;
    let pinnedIp: string;
    try {
      const policy = new EgressPolicy({
        defaultAction: "deny",
        allowedOrigins: [origin],
        privateTargets: options.privateTargets ?? [],
        allowedProtocols: ["https"],
        allowRedirects: false,
        maxRedirects: 0,
        allowInsecureTls: false,
      });
      pinnedIp = (await policy.authorize(origin, options.resolver ?? systemResolver)).pinnedIp;
    } catch (error) {
      if (error instanceof PolicyDenied)
        return rejected("egress_denied", `Destination refused by egress policy: ${error.reason}`);
      return failed("network_error", "The SMTP host could not be resolved");
    }
    const text = `${describeNotification(payload)}\n${payload.link}\n`;
    const html = `<p>${escapeHtml(describeNotification(payload))}</p><p><a href="${escapeHtml(payload.link)}">Open in TestMaster</a></p>`;
    assertNoSecrets(Buffer.from(`${subject}\n${text}${html}`, "utf8"), [
      secret.value,
      smtp.password,
    ]);
    try {
      await transport(
        {
          host: pinnedIp,
          port: smtp.port,
          secure: settings.security === "tls",
          requireTLS: settings.security === "starttls",
          auth: { user: smtp.user, pass: smtp.password },
          tls: {
            ...(isIP(smtp.host) === 0 ? { servername: smtp.host } : {}),
            ...(options.ca ? { ca: options.ca } : {}),
            rejectUnauthorized: true,
          },
          connectionTimeout: timeoutMs,
          greetingTimeout: timeoutMs,
          socketTimeout: timeoutMs,
          disableFileAccess: true,
          disableUrlAccess: true,
        },
        {
          from: settings.from,
          to: [...settings.recipients],
          subject,
          text,
          html,
          // Stable across retries, so a receiver can dedupe a message sent twice after a timeout.
          messageId: `<${ids.deliveryId}@testmaster.invalid>`,
          headers: {
            "X-TestMaster-Event-Id": ids.eventId,
            "X-TestMaster-Delivery-Id": ids.deliveryId,
          },
        },
      );
      return { state: "delivered" };
    } catch (error) {
      return classifySmtp(error);
    }
  }
  return {
    id: "email",
    version: adapterVersion,
    schemaVersion: SCHEMA_VERSION,
    capabilities: ["notifications", "test-delivery"],
    supportedEvents: subscribableNotificationTypes,
    parseSettings: (input) => {
      validate("EmailSettings", input);
      return input as EmailSettings;
    },
    referencedSecrets: (settings) => [settings.smtpSecretRef],
    async sendTest(context, integration) {
      const payload = payloadFor(context, null, context.test, integration.settings);
      return send(context, integration, payload, {
        eventId: payload.eventId,
        deliveryId: context.test.deliveryId,
      });
    },
    async deliver(context, integration, notification) {
      return send(context, integration, notification.payload, notification);
    },
  };
}

interface SmtpError {
  code?: string;
  command?: string;
  responseCode?: number;
  message?: string;
}
function classifySmtp(error: unknown): DeliveryAttemptOutcome {
  const smtp: SmtpError = typeof error === "object" && error !== null ? error : {};
  const uncertain = smtp.command === "DATA" || smtp.command === "DATA END";
  if (smtp.code === "EAUTH") return rejected("smtp_auth_failed", "SMTP authentication was refused");
  if (typeof smtp.responseCode === "number") {
    if (smtp.responseCode >= 500)
      return rejected(
        `smtp_${smtp.responseCode}`,
        `SMTP server refused the message (${smtp.responseCode})`,
      );
    return failed(
      `smtp_${smtp.responseCode}`,
      `SMTP server deferred the message (${smtp.responseCode})`,
    );
  }
  if (smtp.code === "ETIMEDOUT")
    return failed("timeout", "SMTP server did not answer in time", { uncertain });
  if (/certificate|self.signed|verify/iu.test(smtp.message ?? ""))
    return failed("tls_error", "SMTP TLS verification failed");
  return failed("network_error", `SMTP transport failed: ${smtp.code ?? "unknown"}`, { uncertain });
}

/** Registers slack, email and webhook once; an adapter registered earlier (a test double) wins. */
export function registerNotificationProviders(
  registry: IntegrationProviderRegistry = integrationProviders,
): void {
  if (!registry.peek("slack")) registry.register(createSlackProvider());
  if (!registry.peek("email")) registry.register(createEmailProvider());
  if (!registry.peek("webhook")) registry.register(createWebhookProvider());
}

/** Hash used to detect that a retry would send different bytes than the first attempt. */
export function payloadHash(payload: NotificationPayload): string {
  return sha256(notificationBody(payload));
}
