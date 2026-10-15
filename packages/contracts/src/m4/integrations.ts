import { type Static, Type } from "@sinclair/typebox";
import { IntegrationEvent } from "../entities.js";
import * as P from "../primitives.js";

/** Largest inbound webhook body the receiver reads (ADR-020: 5 MiB, refused before any signature work). */
export const INBOUND_WEBHOOK_MAX_BYTES = 5 * 1024 * 1024;
export const integrationProviderIds = ["github", "slack", "email", "webhook"] as const;
export type IntegrationProviderIdValue = (typeof integrationProviderIds)[number];
export const integrationStates = ["active", "paused", "revoked"] as const;

const IntegrationId = Type.String({ pattern: `^int_${P.uuidPattern}$` });
const ProjectIds = Type.Array(P.id("prj"), { maxItems: 100 });
const EventTypes = Type.Array(P.Name, { maxItems: 64 });
const SecretRefs = Type.Array(P.id("sec"), { maxItems: 16 });
const IntegrationState = P.Enum(integrationStates);

/** Adapter identity and declared capabilities as exposed on every integration (INT-001). */
const IntegrationAdapter = P.Obj({
  id: P.Enum(integrationProviderIds),
  version: P.Name,
  schemaVersion: P.Name,
  capabilities: Type.Array(P.Name, { maxItems: 64 }),
});
const IntegrationTestState = P.Enum(["delivered", "failed", "rejected"]);

export const integrationContracts = {
  IntegrationInput: P.Obj({
    provider: P.Enum(integrationProviderIds),
    name: P.Name,
    projectIds: ProjectIds,
    events: EventTypes,
    secretRefs: SecretRefs,
    settings: P.Json,
  }),
  /** Provider is immutable; `state` moves active ↔ paused and anything → revoked (terminal). */
  IntegrationPatchInput: Type.Partial(
    P.Obj({
      name: P.Name,
      projectIds: ProjectIds,
      events: EventTypes,
      secretRefs: SecretRefs,
      settings: P.Json,
      state: IntegrationState,
    }),
  ),
  IntegrationMetadata: P.Obj({
    id: IntegrationId,
    workspaceId: P.id("ws"),
    provider: P.Enum(integrationProviderIds),
    name: P.Name,
    state: IntegrationState,
    projectIds: ProjectIds,
    events: EventTypes,
    /** Principal that created the integration; the server records it. */
    createdBy: P.Name,
    secretRefs: SecretRefs,
    settings: P.Json,
    /** Null when no adapter is registered for the provider; `adapterStatus` says why it cannot run. */
    adapter: Type.Union([IntegrationAdapter, Type.Null()]),
    adapterStatus: P.Enum(["compatible", "incompatible", "unregistered"]),
    lastTest: Type.Union([
      P.Obj({
        deliveryId: P.Name,
        state: IntegrationTestState,
        at: P.Timestamp,
        detail: Type.Union([P.Description, Type.Null()]),
      }),
      Type.Null(),
    ]),
    version: P.Version,
    createdAt: P.Timestamp,
    updatedAt: P.Timestamp,
  }),
  /** Always labelled; a test delivery is never a Run, check or notification of record. */
  IntegrationTestReceipt: P.Obj({
    integrationId: IntegrationId,
    test: Type.Literal(true),
    label: Type.Literal("test notification"),
    deliveryId: P.Name,
    state: IntegrationTestState,
    detail: Type.Union([P.Description, Type.Null()]),
    correlationId: P.Name,
  }),
  /** Provider-specific payload; the receiver hashes the raw bytes and the adapter validates the shape. */
  InboundWebhookBody: P.Json,
  InboundWebhookReceipt: P.Obj({
    event: IntegrationEvent,
    outcome: P.Enum(["received", "accepted", "ignored", "failed"]),
    duplicate: Type.Boolean(),
    ignoredReason: Type.Union([P.Name, Type.Null()]),
    reference: Type.Union([P.Name, Type.Null()]),
  }),
};
export type IntegrationInput = Static<typeof integrationContracts.IntegrationInput>;
export type IntegrationPatchInput = Static<typeof integrationContracts.IntegrationPatchInput>;
export type IntegrationMetadata = Static<typeof integrationContracts.IntegrationMetadata>;
export type IntegrationTestReceipt = Static<typeof integrationContracts.IntegrationTestReceipt>;
export type InboundWebhookReceipt = Static<typeof integrationContracts.InboundWebhookReceipt>;
