import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ContractError,
  type IntegrationProviderIdValue,
  type NotificationPayload,
  SCHEMA_VERSION,
} from "@testmaster/contracts";

/** Normalized outcome of one delivery attempt. Anything an adapter reports outside this set is `failed`. */
export const deliveryOutcomeStates = ["delivered", "failed", "rejected"] as const;
export type DeliveryOutcomeState = (typeof deliveryOutcomeStates)[number];
export interface DeliveryOutcome {
  readonly state: DeliveryOutcomeState;
  /** Human-readable, secret-free detail (bounded to 500 characters by the service). */
  readonly detail?: string | null;
}

export type IntegrationState = "active" | "paused" | "revoked";
export interface StoredIntegration<Settings = unknown> {
  readonly id: string;
  readonly workspaceId: string;
  readonly provider: IntegrationProviderIdValue;
  readonly name: string;
  readonly state: IntegrationState;
  readonly projectIds: readonly string[];
  readonly events: readonly string[];
  /** Principal that created the integration; GitHub acts as it, so it stays accountable for what the integration does. */
  readonly createdBy: string;
  readonly secretRefs: readonly string[];
  readonly settings: Settings;
  readonly lastTest: {
    readonly deliveryId: string;
    readonly state: DeliveryOutcomeState;
    readonly at: string;
    readonly detail: string | null;
  } | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IntegrationContext {
  /** Null while an inbound delivery is not yet attributed to a workspace. */
  readonly workspaceId: string | null;
  readonly correlationId: string;
  now(): Date;
  /**
   * Stored integrations of one provider across workspaces. Inbound adapters resolve an installation
   * through it; the receiver ignores deliveries that map to a paused or revoked integration.
   */
  findIntegrations(provider: IntegrationProviderIdValue): StoredIntegration[];
}
/**
 * Secrets of the integration's own workspace, resolved by the platform for delivery (never for an
 * end user). A secret whose allowed origins do not cover the destination must be refused by the adapter.
 */
export interface IntegrationSecrets {
  resolveBound(ref: string): Promise<{ value: string; allowedOrigins: readonly string[] }>;
}
/** Marks a delivery as a configuration test; the payload an adapter builds must carry the same label. */
export interface TestDeliveryContext extends IntegrationContext {
  readonly secrets: IntegrationSecrets;
  /** Origin the portal is served from; message links are built on it. */
  readonly publicOrigin: string;
  readonly workspaceId: string;
  readonly test: {
    readonly test: true;
    readonly deliveryId: string;
    readonly label: "test notification";
  };
}

/** Context of one outbound notification attempt. */
export interface DeliveryContext extends IntegrationContext {
  readonly workspaceId: string;
  readonly secrets: IntegrationSecrets;
  readonly publicOrigin: string;
}
/** One frozen notification: the same bytes and delivery ID on every retry. */
export interface OutboundNotification {
  /** Stable across retries; receivers dedupe on it. */
  readonly deliveryId: string;
  readonly eventId: string;
  /** 1-based number of this attempt. */
  readonly attempt: number;
  readonly payload: NotificationPayload;
  /** Canonical JSON of `payload`; signatures cover exactly these bytes. */
  readonly body: Buffer;
}
/**
 * Result of one attempt. `failed` is retried with backoff; `rejected` is permanent (policy,
 * validation, authorization) and dead-letters at once. `uncertain` marks a request that may have
 * reached the destination without an observed answer.
 */
export interface DeliveryAttemptOutcome extends DeliveryOutcome {
  readonly reasonCode?: string | null;
  readonly httpStatus?: number | null;
  readonly retryAfterMs?: number | null;
  readonly uncertain?: boolean;
}

export interface InboundRequest {
  /** Lower-cased header names; repeated headers are joined with ", ". */
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: Buffer;
  readonly receivedAt: string;
}
/**
 * What an adapter learned from an authenticated, schema-valid delivery. Nothing here has happened yet:
 * `process` runs once, after the receiver has durably recorded first sight of the delivery.
 */
export interface InboundOutcome {
  /** Null when the installation maps to no workspace. */
  readonly workspaceId: string | null;
  readonly integrationId: string | null;
  /** Provider-assigned unique ID of this delivery (GitHub: `X-GitHub-Delivery`). */
  readonly deliveryId: string;
  readonly installationKey: string | null;
  readonly projectId: string | null;
  readonly eventType: string;
  readonly action: string | null;
  readonly disposition: "accepted" | "ignored";
  /** Required when ignored: `unknown_installation`, `revoked_installation`, `repository_not_allowed`, … */
  readonly ignoredReason?: string;
  process?(): Promise<{ readonly reference: string | null }>;
}

export interface IntegrationProvider<Settings = unknown> {
  readonly id: IntegrationProviderIdValue;
  /** Semver of the adapter itself. */
  readonly version: string;
  /** Core contract `schemaVersion` the adapter was written against; major must match, minor must not exceed. */
  readonly schemaVersion: string;
  readonly capabilities: readonly string[];
  /** Event types the adapter can handle; when declared, an integration may subscribe only to these. */
  readonly supportedEvents?: readonly string[];
  /** Throws `INVALID_ARGUMENT` on bad settings and returns the normalized value that is stored. */
  parseSettings(input: unknown): Settings;
  /** Deliver a clearly labelled test message; `context.test` must be carried into the message. */
  sendTest(
    context: TestDeliveryContext,
    integration: StoredIntegration<Settings>,
  ): Promise<DeliveryOutcome>;
  /** Secret references the settings point at; each must also be listed in the integration's `secretRefs`. */
  referencedSecrets?(settings: Settings): readonly string[];
  /** Deliver one outbound notification. Absent for providers that only receive. */
  deliver?(
    context: DeliveryContext,
    integration: StoredIntegration<Settings>,
    notification: OutboundNotification,
  ): Promise<DeliveryAttemptOutcome>;
  /** Verify the provider signature, validate the schema and classify the delivery. */
  receive?(context: IntegrationContext, request: InboundRequest): Promise<InboundOutcome>;
}

const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const capabilityName = /^[a-z][a-z0-9-]{0,63}$/;
function parts(version: string): [number, number, number] {
  const match = semver.exec(version);
  return [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])];
}
/** A provider that does not declare itself well is a programming error, caught at registration. */
export function assertWellFormedProvider(provider: IntegrationProvider): void {
  if (!semver.test(provider.version) || !semver.test(provider.schemaVersion))
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Adapter version and schemaVersion must be semver",
      {
        provider: provider.id,
      },
    );
  if (
    !provider.capabilities.length ||
    new Set(provider.capabilities).size !== provider.capabilities.length ||
    !provider.capabilities.every((capability) => capabilityName.test(capability))
  )
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Adapter must declare unique, lower-case capability names",
      { provider: provider.id },
    );
}
export function adapterCompatible(provider: IntegrationProvider): boolean {
  const [adapterMajor, adapterMinor] = parts(provider.schemaVersion);
  const [coreMajor, coreMinor] = parts(SCHEMA_VERSION);
  return adapterMajor === coreMajor && adapterMinor <= coreMinor;
}
/** INT-001: an adapter built for another contract version is refused with the action to take. */
export function assertAdapterCompatible(provider: IntegrationProvider): void {
  if (!adapterCompatible(provider))
    throw new ContractError(
      "PRECONDITION_FAILED",
      "Integration adapter is incompatible with the core contract; update the adapter",
      {
        provider: provider.id,
        adapterVersion: provider.version,
        adapterSchemaVersion: provider.schemaVersion,
        coreSchemaVersion: SCHEMA_VERSION,
        nextActions: ["update-adapter"],
      },
    );
}

/**
 * Verifies a `sha256=<hex>` HMAC header over the raw bytes against every currently accepted secret
 * (two during a rotation window). Comparison is constant-time per candidate.
 */
export function verifyHmacSha256(
  header: string | undefined,
  rawBody: Uint8Array,
  secrets: readonly string[],
): boolean {
  const match = /^sha256=([0-9a-f]{64})$/.exec(header ?? "");
  if (!match?.[1]) return false;
  const presented = Buffer.from(match[1], "hex");
  let valid = false;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    if (timingSafeEqual(expected, presented)) valid = true;
  }
  return valid;
}
