import { randomUUID } from "node:crypto";
import {
  ContractError,
  INBOUND_WEBHOOK_MAX_BYTES,
  type InboundWebhookReceipt,
  type IntegrationInput,
  type IntegrationMetadata,
  type IntegrationPatchInput,
  type IntegrationProviderIdValue,
  type IntegrationTestReceipt,
  integrationProviderIds,
  validate,
} from "@testmaster/contracts";
import { sha256 } from "@testmaster/domain";
import { AuditRepository } from "@testmaster/persistence";
import { auditSecurity } from "../audit.js";
import type { ServiceContext } from "../context.js";
import { isRestoreIsolated } from "../operations-state.js";
import {
  adapterCompatible,
  type DeliveryContext,
  type DeliveryOutcome,
  type DeliveryOutcomeState,
  deliveryOutcomeStates,
  type InboundOutcome,
  type InboundRequest,
  type IntegrationContext,
  type IntegrationProvider,
  type IntegrationSecrets,
  type IntegrationState,
  type StoredIntegration,
} from "./provider.js";
import { type IntegrationProviderRegistry, integrationProviders } from "./registry.js";

export interface IntegrationsOptions {
  /** Adapters to use; defaults to the process-wide registry. */
  providers?: IntegrationProviderRegistry;
  now?: () => Date;
  /** A delivery recorded as `received` for longer than this is treated as abandoned and may be processed again. */
  receivedStaleMs?: number;
  /** Resolves secrets for delivery; the Application supplies a workspace-system resolver. */
  secrets?: IntegrationSecrets;
  publicOrigin?: string;
}
type Row = Record<string, unknown>;
interface InboundRow {
  id: string;
  workspaceId: string | null;
  provider: string;
  deliveryId: string;
  integrationId: string | null;
  installationKey: string;
  projectId: string;
  eventType: string;
  action: string;
  payloadSha256: string;
  outcome: "received" | "accepted" | "ignored" | "failed" | "tampered";
  ignoredReason: string | null;
  reference: string | null;
  errorCode: string | null;
  originalId: string | null;
  attempts: number;
  receivedAt: string;
  updatedAt: string;
  version: number;
}
type Admission =
  | { kind: "new"; row: InboundRow }
  | { kind: "duplicate"; row: InboundRow }
  | { kind: "tampered"; row: InboundRow }
  | { kind: "retry" };

const TEST_LABEL = "test notification" as const;
const DETAIL_LIMIT = 500;
const defaultReceivedStaleMs = 300_000;

function inTx<T>(ctx: ServiceContext, action: () => T): T {
  return ctx.database.inTransaction ? action() : ctx.database.withTx(action);
}
function expectVersion(current: StoredIntegration, expectedVersion: number): void {
  if (expectedVersion === undefined || expectedVersion === null)
    throw new ContractError("PRECONDITION_REQUIRED", "Expected version is required");
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
    throw new ContractError("INVALID_ARGUMENT", "Expected version must be a positive integer");
  if (current.version !== expectedVersion)
    throw new ContractError("REVISION_CONFLICT", "Entity version changed");
}
function decode(row: Row): StoredIntegration {
  const document = JSON.parse(String(row.data_json)) as Record<string, unknown>;
  return {
    ...document,
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    provider: String(row.provider),
    name: String(row.name),
    state: String(row.state),
    version: Number(row.version),
    createdAt: String(row.created_at),
  } as StoredIntegration;
}
function decodeInbound(row: Row): InboundRow {
  return {
    id: String(row.id),
    workspaceId: row.workspace_id === null ? null : String(row.workspace_id),
    provider: String(row.provider),
    deliveryId: String(row.delivery_id),
    integrationId: row.integration_id === null ? null : String(row.integration_id),
    installationKey: String(row.installation_key),
    projectId: String(row.project_id),
    eventType: String(row.event_type),
    action: String(row.action),
    payloadSha256: String(row.payload_sha256),
    outcome: String(row.outcome) as InboundRow["outcome"],
    ignoredReason: row.ignored_reason === null ? null : String(row.ignored_reason),
    reference: row.reference === null ? null : String(row.reference),
    errorCode: row.error_code === null ? null : String(row.error_code),
    originalId: row.original_id === null ? null : String(row.original_id),
    attempts: Number(row.attempts),
    receivedAt: String(row.received_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
  };
}
/** Adapter faults surface as structured errors; raw adapter messages never reach the caller. */
async function runAdapter<T>(
  provider: IntegrationProvider,
  call: () => Promise<T> | T,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError("INTERNAL", "Integration adapter failed", {
      provider: provider.id,
      reasonCode: "adapter_error",
    });
  }
}
function boundedString(value: unknown, field: string, max = 200): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters never belong in IDs.
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new ContractError("INTERNAL", "Integration adapter returned an invalid delivery", {
      reasonCode: "adapter_contract_violation",
      field,
    });
  return value;
}
function optionalString(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : boundedString(value, field);
}
function checkEnvelope(provider: IntegrationProvider, raw: InboundOutcome): InboundOutcome {
  const disposition: unknown = raw.disposition;
  if (disposition !== "accepted" && disposition !== "ignored")
    throw new ContractError("INTERNAL", "Integration adapter returned an unknown disposition", {
      provider: provider.id,
      reasonCode: "adapter_contract_violation",
      field: "disposition",
    });
  boundedString(raw.deliveryId, "deliveryId");
  boundedString(raw.eventType, "eventType");
  optionalString(raw.installationKey, "installationKey");
  optionalString(raw.projectId, "projectId");
  optionalString(raw.action, "action");
  optionalString(raw.workspaceId, "workspaceId");
  optionalString(raw.integrationId, "integrationId");
  if (disposition === "ignored") boundedString(raw.ignoredReason, "ignoredReason");
  else if (!raw.workspaceId || !raw.integrationId || typeof raw.process !== "function")
    throw new ContractError("INTERNAL", "Accepted deliveries need an integration and a handler", {
      provider: provider.id,
      reasonCode: "adapter_contract_violation",
    });
  return raw;
}
interface NormalizedOutcome {
  state: DeliveryOutcomeState;
  detail: string | null;
}
function normalizeOutcome(raw: DeliveryOutcome | undefined): NormalizedOutcome {
  const detail = typeof raw?.detail === "string" ? raw.detail.slice(0, DETAIL_LIMIT) : null;
  // An outcome outside the contract is a failure, never a delivery (INT-001).
  const state = deliveryOutcomeStates.find((known) => known === raw?.state);
  if (!state) return { state: "failed", detail: "Adapter reported an unrecognized outcome" };
  return { state, detail };
}

const unavailableSecrets: IntegrationSecrets = {
  async resolveBound() {
    throw new ContractError("CAPABILITY_UNAVAILABLE", "Secret resolution is not configured", {
      capability: "integration-secrets",
    });
  },
};

export class IntegrationsService {
  private readonly providers: IntegrationProviderRegistry;
  private readonly now: () => Date;
  private readonly receivedStaleMs: number;
  private secrets: IntegrationSecrets;
  private publicOrigin: string;
  constructor(
    private readonly ctx: ServiceContext,
    options: IntegrationsOptions = {},
  ) {
    this.providers = options.providers ?? integrationProviders;
    this.now = options.now ?? (() => new Date());
    this.receivedStaleMs = options.receivedStaleMs ?? defaultReceivedStaleMs;
    this.secrets = options.secrets ?? unavailableSecrets;
    this.publicOrigin = options.publicOrigin ?? "http://127.0.0.1:7331";
  }

  /** Supplies the platform secret resolver and the portal origin used for test and notification deliveries. */
  useDelivery(delivery: { secrets: IntegrationSecrets; publicOrigin: string }): void {
    this.secrets = delivery.secrets;
    this.publicOrigin = delivery.publicOrigin;
  }

  create(input: IntegrationInput): IntegrationMetadata {
    this.ctx.authorize("A");
    validate("IntegrationInput", input);
    const provider = this.providers.resolve(input.provider);
    const settings = this.parseSettings(provider, input.settings);
    this.requireConsent(provider, settings, input.consent.scopes);
    this.requireListedSecrets(provider, settings, input.secretRefs);
    return inTx(this.ctx, () => {
      this.checkEvents(provider, input.events);
      this.checkReferences(input.projectIds, input.secretRefs);
      if (
        this.ctx.database.get(
          "SELECT 1 AS present FROM integrations WHERE workspace_id=? AND provider=? AND name=?",
          this.ctx.workspaceId,
          provider.id,
          input.name,
        )
      )
        throw new ContractError("INVALID_ARGUMENT", "Integration name already exists", {
          name: input.name,
        });
      const at = this.now().toISOString();
      const id = `int_${randomUUID()}`;
      const document = {
        projectIds: [...new Set(input.projectIds)],
        events: [...new Set(input.events)],
        consent: {
          scopes: [...new Set(input.consent.scopes)],
          grantedBy: this.ctx.principalId,
          grantedAt: at,
        },
        secretRefs: [...new Set(input.secretRefs)],
        settings,
        lastTest: null,
        updatedAt: at,
      };
      this.ctx.database.run(
        "INSERT INTO integrations(workspace_id,id,created_at,version,data_json,provider,name,state) VALUES(?,?,?,?,?,?,?,?)",
        this.ctx.workspaceId,
        id,
        at,
        1,
        JSON.stringify(document),
        provider.id,
        input.name,
        "active",
      );
      auditSecurity(this.ctx, "integrations.create", id, "allowed");
      return this.describe(this.load(id));
    });
  }

  list(): IntegrationMetadata[] {
    this.ctx.authorize("A");
    return this.ctx.database
      .all(
        "SELECT * FROM integrations WHERE workspace_id=? ORDER BY created_at DESC,id DESC",
        this.ctx.workspaceId,
      )
      .map((row) => this.describe(decode(row)));
  }

  get(id: string): IntegrationMetadata {
    this.ctx.authorize("A");
    return this.describe(this.load(id));
  }

  update(id: string, patch: IntegrationPatchInput, expectedVersion: number): IntegrationMetadata {
    this.ctx.authorize("A");
    validate("IntegrationPatchInput", patch);
    return inTx(this.ctx, () => {
      const current = this.load(id);
      expectVersion(current, expectedVersion);
      if (current.state === "revoked")
        throw new ContractError("PRECONDITION_FAILED", "Integration is revoked", {
          reasonCode: "integration_revoked",
        });
      const provider = this.providers.resolve(current.provider);
      const revoking = patch.state === "revoked";
      const settings =
        patch.settings === undefined
          ? (current.settings as never)
          : this.parseSettings(provider, patch.settings);
      const state: IntegrationState = patch.state ?? current.state;
      const at = this.now().toISOString();
      const consent = patch.consent
        ? {
            scopes: [...new Set(patch.consent.scopes)],
            grantedBy: this.ctx.principalId,
            grantedAt: at,
          }
        : current.consent;
      const projectIds = [...new Set(patch.projectIds ?? current.projectIds)];
      const events = [...new Set(patch.events ?? current.events)];
      const secretRefs = [...new Set(patch.secretRefs ?? current.secretRefs)];
      if (!revoking) {
        // Consent is re-checked on every change that could widen access, including resuming a pause.
        this.requireConsent(provider, settings, consent.scopes);
        this.requireListedSecrets(provider, settings, secretRefs);
        if (patch.events) this.checkEvents(provider, events);
        this.checkReferences(
          patch.projectIds ? projectIds : [],
          patch.secretRefs ? secretRefs : [],
        );
        if (patch.name && patch.name !== current.name)
          this.requireFreeName(provider.id, patch.name);
      }
      // Revocation ends access with no fallback: no consent and no secret binding survive.
      const document = {
        projectIds,
        events,
        consent: revoking ? { ...consent, scopes: [] } : consent,
        secretRefs: revoking ? [] : secretRefs,
        settings,
        lastTest: current.lastTest,
        updatedAt: at,
      };
      const changed = this.ctx.database.run(
        "UPDATE integrations SET data_json=?,name=?,state=?,version=version+1 WHERE workspace_id=? AND id=? AND version=?",
        JSON.stringify(document),
        patch.name ?? current.name,
        state,
        this.ctx.workspaceId,
        id,
        expectedVersion,
      );
      if (Number(changed.changes) !== 1)
        throw new ContractError("REVISION_CONFLICT", "Entity version changed");
      auditSecurity(
        this.ctx,
        revoking
          ? "integrations.revoke"
          : patch.state && patch.state !== current.state
            ? `integrations.${patch.state === "paused" ? "pause" : "resume"}`
            : "integrations.update",
        id,
        "allowed",
      );
      return this.describe(this.load(id));
    });
  }

  pause(id: string, expectedVersion: number): IntegrationMetadata {
    return this.update(id, { state: "paused" }, expectedVersion);
  }

  revoke(id: string, expectedVersion: number): IntegrationMetadata {
    return this.update(id, { state: "revoked" }, expectedVersion);
  }

  /**
   * Sends a labelled test message through the adapter. A test is never a Run, a check or a
   * notification of record: it writes no delivery row and creates no Run.
   */
  async test(id: string): Promise<IntegrationTestReceipt> {
    this.ctx.authorize("A");
    const integration = this.load(id);
    if (integration.state !== "active")
      throw new ContractError("PRECONDITION_FAILED", "Integration is not active", {
        reasonCode: `integration_${integration.state}`,
      });
    const provider = this.providers.resolve(integration.provider);
    this.requireConsent(provider, integration.settings, integration.consent.scopes);
    const deliveryId = `tst_${randomUUID()}`;
    const correlationId = this.ctx.correlationId ?? randomUUID();
    const context = {
      ...this.integrationContext(correlationId, true),
      workspaceId: this.ctx.workspaceId,
      secrets: this.secrets,
      publicOrigin: this.publicOrigin,
      test: { test: true, deliveryId, label: TEST_LABEL },
    } as const;
    let outcome: NormalizedOutcome;
    try {
      outcome = normalizeOutcome(await provider.sendTest(context, integration as never));
    } catch (error) {
      outcome = {
        state: "failed",
        detail: error instanceof ContractError ? `adapter_error:${error.code}` : "adapter_error",
      };
    }
    inTx(this.ctx, () => {
      const fresh = this.load(id);
      const document = {
        projectIds: fresh.projectIds,
        events: fresh.events,
        consent: fresh.consent,
        secretRefs: fresh.secretRefs,
        settings: fresh.settings,
        lastTest: {
          deliveryId,
          state: outcome.state,
          at: this.now().toISOString(),
          detail: outcome.detail,
        },
        updatedAt: fresh.updatedAt,
      };
      this.ctx.database.run(
        "UPDATE integrations SET data_json=?,version=version+1 WHERE workspace_id=? AND id=? AND version=?",
        JSON.stringify(document),
        this.ctx.workspaceId,
        id,
        fresh.version,
      );
      auditSecurity(this.ctx, "integrations.test", id, "allowed", correlationId);
    });
    return {
      integrationId: id,
      test: true,
      label: TEST_LABEL,
      deliveryId,
      state: outcome.state,
      detail: outcome.detail,
      correlationId,
    };
  }

  /** Internal: active integrations of this workspace for the given providers (no end-user call). */
  activeFor(providerIds: readonly string[]): StoredIntegration[] {
    if (!providerIds.length) return [];
    return this.ctx.database
      .all(
        `SELECT * FROM integrations WHERE workspace_id=? AND state='active' AND provider IN (${providerIds.map(() => "?").join(",")}) ORDER BY created_at,id`,
        this.ctx.workspaceId,
        ...providerIds,
      )
      .map(decode);
  }

  /** Internal: one integration of this workspace in any state. */
  stored(id: string): StoredIntegration {
    return this.load(id);
  }

  /** Internal: the adapter registered for a provider, after the compatibility check. */
  adapter(providerId: string): IntegrationProvider {
    return this.providers.resolve(providerId);
  }

  /** Internal: the context an adapter receives for one outbound notification attempt. */
  deliveryContext(correlationId: string): DeliveryContext {
    return {
      ...this.integrationContext(correlationId, true),
      workspaceId: this.ctx.workspaceId,
      secrets: this.secrets,
      publicOrigin: this.publicOrigin,
    };
  }

  /** Durable dedupe records of this workspace, newest first. */
  inbound(options: { integrationId?: string; limit?: number } = {}): InboundRow[] {
    this.ctx.authorize("A");
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ContractError("INVALID_ARGUMENT", "Page size must be 1–100");
    return this.ctx.database
      .all(
        `SELECT * FROM inbound_webhook_deliveries WHERE workspace_id=? ${options.integrationId ? "AND integration_id=?" : ""} ORDER BY received_at DESC,id DESC LIMIT ?`,
        this.ctx.workspaceId,
        ...(options.integrationId ? [options.integrationId] : []),
        limit,
      )
      .map(decodeInbound);
  }

  /**
   * Public, signature-authenticated entry (ADR-020): content type, body limit, provider signature and
   * schema (inside the adapter), then dedupe and tamper detection, then the adapter's handler.
   */
  async receiveWebhook(
    providerId: string,
    request: {
      headers: Readonly<Record<string, string | readonly string[] | undefined>>;
      rawBody: Buffer;
    },
  ): Promise<InboundWebhookReceipt> {
    const provider = this.providers.resolve(providerId);
    // OPS-025: a restored copy accepts no webhook until an operator releases it. Nothing is recorded, so
    // the sender's redelivery after the release is processed instead of deduplicated as already ignored.
    if (isRestoreIsolated(this.ctx.database))
      throw new ContractError("UNAVAILABLE", "Restored copy is isolated; webhooks are refused", {
        reasonCode: "restore_isolated",
        retryable: true,
      });
    if (!provider.receive)
      throw new ContractError("CAPABILITY_UNAVAILABLE", "Provider does not accept webhooks", {
        capability: "webhooks",
        provider: provider.id,
      });
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers))
      if (value !== undefined)
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    if ((headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() !== "application/json")
      throw new ContractError("INVALID_ARGUMENT", "Webhook content type must be application/json", {
        reason: "unsupported_content_type",
      });
    if (request.rawBody.length > INBOUND_WEBHOOK_MAX_BYTES)
      throw new ContractError("PAYLOAD_TOO_LARGE", "Webhook body exceeds the 5 MiB limit", {
        limitBytes: INBOUND_WEBHOOK_MAX_BYTES,
      });
    const receivedAt = this.now().toISOString();
    const correlationId = this.ctx.correlationId ?? randomUUID();
    const raw = await runAdapter(provider, () =>
      provider.receive?.(this.integrationContext(correlationId), {
        headers,
        rawBody: request.rawBody,
        receivedAt,
      } satisfies InboundRequest),
    );
    const outcome = this.bindIntegration(provider, checkEnvelope(provider, raw as InboundOutcome));
    const payloadSha256 = sha256(request.rawBody);
    let admission: Admission = { kind: "retry" };
    for (let attempt = 0; attempt < 3 && admission.kind === "retry"; attempt++)
      admission = this.admit(provider.id, outcome, payloadSha256, receivedAt);
    if (admission.kind === "retry")
      throw new ContractError("UNAVAILABLE", "Webhook admission is contended; redeliver", {
        retryable: true,
      });
    const event = (row: InboundRow) => ({
      eventId: row.deliveryId,
      provider: provider.id,
      payloadHash: row.payloadSha256,
      occurredAt: row.receivedAt,
      receiptRef: row.id,
    });
    const receipt = (row: InboundRow, duplicate: boolean): InboundWebhookReceipt => ({
      event: event(row),
      outcome: row.outcome as InboundWebhookReceipt["outcome"],
      duplicate,
      ignoredReason: row.ignoredReason,
      reference: row.reference,
    });
    if (admission.kind === "tampered") {
      const original = admission.row;
      this.auditInbound(provider.id, outcome.workspaceId, "tampered", original.id, correlationId);
      throw new ContractError(
        "IDEMPOTENCY_CONFLICT",
        "Webhook delivery ID was already used with a different payload or scope",
        {
          provider: provider.id,
          deliveryId: outcome.deliveryId,
          originalReceipt: original.originalId,
          tamperRecord: original.id,
          reason: "tampered",
        },
      );
    }
    if (admission.kind === "duplicate") return receipt(admission.row, true);
    const row = admission.row;
    if (row.outcome === "ignored") {
      this.auditInbound(provider.id, outcome.workspaceId, "ignored", row.id, correlationId);
      return receipt(row, false);
    }
    try {
      const result = await runAdapter(provider, () => outcome.process?.());
      const done = this.settle(row, "accepted", { reference: result?.reference ?? null });
      this.auditInbound(provider.id, outcome.workspaceId, "accepted", row.id, correlationId);
      return receipt(done, false);
    } catch (error) {
      const code = error instanceof ContractError ? error.code : "INTERNAL";
      this.settle(row, "failed", { errorCode: code });
      this.auditInbound(provider.id, outcome.workspaceId, "failed", row.id, correlationId);
      throw error;
    }
  }

  /** `ownWorkspaceOnly` confines lookups to this service's workspace (configuration paths); webhook intake spans all. */
  private integrationContext(correlationId: string, ownWorkspaceOnly = false): IntegrationContext {
    return {
      workspaceId: null,
      correlationId,
      now: this.now,
      findIntegrations: (provider: IntegrationProviderIdValue) =>
        this.ctx.database
          .all(
            `SELECT * FROM integrations WHERE provider=? ${ownWorkspaceOnly ? "AND workspace_id=?" : ""} ORDER BY created_at,id`,
            provider,
            ...(ownWorkspaceOnly ? [this.ctx.workspaceId] : []),
          )
          .map(decode),
    };
  }

  /** The stored integration decides whether a delivery may act; an adapter cannot override it. */
  private bindIntegration(provider: IntegrationProvider, outcome: InboundOutcome): InboundOutcome {
    if (!outcome.integrationId) return outcome;
    const row = outcome.workspaceId
      ? this.ctx.database.get(
          "SELECT * FROM integrations WHERE workspace_id=? AND id=? AND provider=?",
          outcome.workspaceId,
          outcome.integrationId,
          provider.id,
        )
      : undefined;
    if (!row)
      throw new ContractError("INTERNAL", "Integration adapter named an unknown integration", {
        provider: provider.id,
        reasonCode: "adapter_contract_violation",
        field: "integrationId",
      });
    const state = String(row.state);
    if (state === "active") return outcome;
    return {
      workspaceId: outcome.workspaceId,
      integrationId: outcome.integrationId,
      deliveryId: outcome.deliveryId,
      installationKey: outcome.installationKey,
      projectId: outcome.projectId,
      eventType: outcome.eventType,
      action: outcome.action,
      disposition: "ignored",
      ignoredReason: `${state}_integration`,
    };
  }

  private admit(
    provider: string,
    outcome: InboundOutcome,
    payloadSha256: string,
    receivedAt: string,
  ): Admission {
    const scope = {
      installationKey: outcome.installationKey ?? "",
      projectId: outcome.projectId ?? "",
      eventType: outcome.eventType,
      action: outcome.action ?? "",
    };
    return inTx(this.ctx, () => {
      const existing = this.ctx.database.get(
        `SELECT * FROM inbound_webhook_deliveries WHERE provider=? AND delivery_id=? AND outcome<>'tampered' AND ${outcome.workspaceId ? "workspace_id=?" : "workspace_id IS NULL"}`,
        provider,
        outcome.deliveryId,
        ...(outcome.workspaceId ? [outcome.workspaceId] : []),
      );
      if (!existing) {
        const id = `iwd_${randomUUID()}`;
        const inserted = this.ctx.database.run(
          "INSERT INTO inbound_webhook_deliveries(id,workspace_id,created_at,version,provider,delivery_id,integration_id,installation_key,project_id,event_type,action,payload_sha256,outcome,ignored_reason,received_at,updated_at) VALUES(?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
          id,
          outcome.workspaceId,
          receivedAt,
          provider,
          outcome.deliveryId,
          outcome.integrationId,
          scope.installationKey,
          scope.projectId,
          scope.eventType,
          scope.action,
          payloadSha256,
          outcome.disposition === "ignored" ? "ignored" : "received",
          outcome.disposition === "ignored" ? (outcome.ignoredReason ?? null) : null,
          receivedAt,
          receivedAt,
        );
        if (Number(inserted.changes) !== 1) return { kind: "retry" } as const;
        return { kind: "new", row: this.inboundById(id) } as const;
      }
      const row = decodeInbound(existing);
      const same =
        row.payloadSha256 === payloadSha256 &&
        row.installationKey === scope.installationKey &&
        row.projectId === scope.projectId &&
        row.eventType === scope.eventType &&
        row.action === scope.action;
      if (!same) {
        const id = `iwd_${randomUUID()}`;
        this.ctx.database.run(
          "INSERT INTO inbound_webhook_deliveries(id,workspace_id,created_at,version,provider,delivery_id,integration_id,installation_key,project_id,event_type,action,payload_sha256,outcome,original_id,received_at,updated_at) VALUES(?,?,?,1,?,?,?,?,?,?,?,?,'tampered',?,?,?)",
          id,
          outcome.workspaceId,
          receivedAt,
          provider,
          outcome.deliveryId,
          outcome.integrationId,
          scope.installationKey,
          scope.projectId,
          scope.eventType,
          scope.action,
          payloadSha256,
          row.id,
          receivedAt,
          receivedAt,
        );
        return { kind: "tampered", row: this.inboundById(id) } as const;
      }
      const inFlight =
        row.outcome === "received" &&
        Date.parse(receivedAt) - Date.parse(row.updatedAt) < this.receivedStaleMs;
      if (row.outcome === "accepted" || row.outcome === "ignored" || inFlight)
        return { kind: "duplicate", row } as const;
      // `failed`, or `received` long enough ago to be abandoned: the redelivery claims it again.
      const claimed = this.ctx.database.run(
        "UPDATE inbound_webhook_deliveries SET outcome='received',error_code=NULL,attempts=attempts+1,updated_at=?,version=version+1 WHERE id=? AND version=?",
        receivedAt,
        row.id,
        row.version,
      );
      if (Number(claimed.changes) !== 1) return { kind: "retry" } as const;
      return { kind: "new", row: this.inboundById(row.id) } as const;
    });
  }

  private settle(
    row: InboundRow,
    outcome: "accepted" | "failed",
    fields: { reference?: string | null; errorCode?: string },
  ): InboundRow {
    return inTx(this.ctx, () => {
      this.ctx.database.run(
        "UPDATE inbound_webhook_deliveries SET outcome=?,reference=?,error_code=?,updated_at=?,version=version+1 WHERE id=?",
        outcome,
        fields.reference ?? null,
        fields.errorCode ?? null,
        this.now().toISOString(),
        row.id,
      );
      return this.inboundById(row.id);
    });
  }

  private auditInbound(
    provider: string,
    workspaceId: string | null,
    outcome: string,
    recordId: string,
    requestId: string,
  ): void {
    if (!workspaceId) return;
    new AuditRepository(this.ctx.database).append({
      workspaceId,
      actor: `integration:${provider}`,
      action: `integrations.webhook.${outcome}`,
      resourceId: recordId,
      requestId,
      timestamp: this.now().toISOString(),
      beforeHash: null,
      afterHash: null,
    });
  }

  private inboundById(id: string): InboundRow {
    const row = this.ctx.database.get("SELECT * FROM inbound_webhook_deliveries WHERE id=?", id);
    if (!row) throw new ContractError("INTERNAL", "Webhook delivery record vanished", { id });
    return decodeInbound(row);
  }

  private load(id: string): StoredIntegration {
    const row = this.ctx.database.get(
      "SELECT * FROM integrations WHERE workspace_id=? AND id=?",
      this.ctx.workspaceId,
      id,
    );
    if (!row) throw new ContractError("NOT_FOUND", "Integration does not exist", { id });
    return decode(row);
  }

  private describe(stored: StoredIntegration): IntegrationMetadata {
    const provider = this.providers.peek(stored.provider);
    return {
      ...stored,
      projectIds: [...stored.projectIds],
      events: [...stored.events],
      secretRefs: [...stored.secretRefs],
      consent: { ...stored.consent, scopes: [...stored.consent.scopes] },
      adapter: provider
        ? {
            id: provider.id,
            version: provider.version,
            schemaVersion: provider.schemaVersion,
            capabilities: [...provider.capabilities],
          }
        : null,
      adapterStatus: !provider
        ? "unregistered"
        : adapterCompatible(provider)
          ? "compatible"
          : "incompatible",
    } as IntegrationMetadata;
  }

  private parseSettings(provider: IntegrationProvider, input: unknown): unknown {
    try {
      return provider.parseSettings(input);
    } catch (error) {
      if (error instanceof ContractError) throw error;
      throw new ContractError("INVALID_ARGUMENT", "Integration settings are invalid", {
        provider: provider.id,
      });
    }
  }

  /** INT-004: the caller must have consented to every scope the adapter needs. */
  private requireConsent(
    provider: IntegrationProvider,
    settings: unknown,
    granted: readonly string[],
  ): void {
    let required: readonly string[];
    try {
      required = provider.requiredScopes(settings);
    } catch (error) {
      if (error instanceof ContractError) throw error;
      throw new ContractError("INTERNAL", "Integration adapter failed", {
        provider: provider.id,
        reasonCode: "adapter_error",
      });
    }
    const missing = required.filter((scope) => !granted.includes(scope));
    if (missing.length)
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Integration consent does not cover every required scope",
        { provider: provider.id, missingScopes: missing, nextActions: ["grant-consent"] },
      );
  }

  /** Every secret the settings point at must be a listed, existing binding of the integration. */
  private requireListedSecrets(
    provider: IntegrationProvider,
    settings: unknown,
    secretRefs: readonly string[],
  ): void {
    const referenced = provider.referencedSecrets?.(settings as never) ?? [];
    const unlisted = referenced.filter((ref) => !secretRefs.includes(ref));
    if (unlisted.length)
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Settings reference secrets that are not listed",
        {
          provider: provider.id,
          unlistedSecretRefs: unlisted,
        },
      );
  }

  private checkEvents(provider: IntegrationProvider, events: readonly string[]): void {
    const unsupported = provider.supportedEvents
      ? events.filter((event) => !provider.supportedEvents?.includes(event))
      : [];
    if (unsupported.length)
      throw new ContractError("INVALID_ARGUMENT", "Provider does not support these events", {
        provider: provider.id,
        unsupportedEvents: unsupported,
      });
  }

  private checkReferences(projectIds: readonly string[], secretRefs: readonly string[]): void {
    for (const projectId of projectIds) {
      this.ctx.authorize("A", projectId);
      const project = this.ctx.entities.get("Project", this.ctx.workspaceId, projectId);
      if (!project || project.archivedAt)
        throw new ContractError("NOT_FOUND", "Project does not exist", { id: projectId });
    }
    for (const secretId of secretRefs) {
      const secret = this.ctx.entities.get("SecretReference", this.ctx.workspaceId, secretId);
      if (!secret || secret.revokedAt)
        throw new ContractError("NOT_FOUND", "Secret reference is unavailable", { id: secretId });
    }
  }

  private requireFreeName(provider: string, name: string): void {
    if (
      this.ctx.database.get(
        "SELECT 1 AS present FROM integrations WHERE workspace_id=? AND provider=? AND name=?",
        this.ctx.workspaceId,
        provider,
        name,
      )
    )
      throw new ContractError("INVALID_ARGUMENT", "Integration name already exists", { name });
  }
}

export const knownIntegrationProviders: readonly string[] = integrationProviderIds;
