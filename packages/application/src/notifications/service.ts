import { randomUUID } from "node:crypto";
import {
  ContractError,
  type NotificationAttempt,
  type NotificationDelivery,
  type NotificationDeliveryDetail,
  type NotificationPayload,
  type NotificationRedaction,
  type NotificationRules,
  type NotificationType,
  reasonCodes,
} from "@testmaster/contracts";
import { sha256 } from "@testmaster/domain";
import { OutboxRepository } from "@testmaster/persistence";
import { auditSecurity } from "../audit.js";
import type { ServiceContext } from "../context.js";
import { deliveryBackoffMs, deliveryRetryPolicy } from "../delivery.js";
import type {
  DeliveryAttemptOutcome,
  OutboundNotification,
  StoredIntegration,
} from "../integrations/provider.js";
import type { IntegrationsService } from "../integrations/service.js";
import { isRestoreIsolated } from "../operations-state.js";
import type { BatchesService } from "../runs.js";
import { buildNotificationPayload, type NotificationSource, notificationBody } from "./payload.js";

type Row = Record<string, unknown>;

const channelProviders = ["slack", "email", "webhook"] as const;
/** Outbox types that can become notifications; everything else in the outbox is internal. */
const notifiableOutboxTypes = [
  "run.completed",
  "schedule.misfire",
  "schedule.paused",
  "alert.fired",
  "worker.offline",
  "resource.orphaned",
  "delivery.dead_letter",
] as const;
const scanLimit = 500;
const scanOverlapMs = 30_000;
const dispatchBatch = 20;
const defaultLeaseMs = 60_000;
export const notificationRetentionDays = 90;
const detailLimit = 500;

/** The part of channel settings the dispatcher reads; each provider validated it on write. */
interface ChannelSettings {
  rules?: NotificationRules;
  redaction?: NotificationRedaction;
}
interface Notifiable {
  type: NotificationType;
  /** Outbox event ID, or `batch:<id>` for the completion synthesized from member runs. */
  eventRef: string;
  occurredAt: string;
  projectId: string | null;
  environmentId: string | null;
  suiteId: string | null;
  source: Omit<
    NotificationSource,
    "type" | "eventId" | "deliveryId" | "occurredAt" | "test" | "workspaceId"
  >;
  /** Never notify this integration about its own failure. */
  excludeIntegrationId?: string;
}

export interface NotificationFilter {
  state?: NotificationDelivery["state"];
  integrationId?: string;
  type?: NotificationType;
}
export interface NotificationOptions {
  publicOrigin: string;
  now?: () => Date;
  random?: () => number;
  leaseMs?: number;
}
/** One dead notification, in the shape the admin DLQ listing uses. */
export interface NotificationDeadLetter {
  source: "notification";
  id: string;
  state: "dead_letter";
  attempts: number;
  lastError: string | null;
  createdAt: string;
  subject: string;
}

function inTx<T>(ctx: ServiceContext, action: () => T): T {
  return ctx.database.inTransaction ? action() : ctx.database.withTx(action);
}
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function parse(json: unknown): Record<string, unknown> {
  try {
    return record(JSON.parse(String(json)));
  } catch {
    return {};
  }
}
/** Restore isolation (OPS-025): a restored copy sends nothing until an operator releases it. */
function restoreIsolated(ctx: ServiceContext): boolean {
  return isRestoreIsolated(ctx.database);
}
function safeDetail(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, detailLimit);
}

function decodeDelivery(row: Row): NotificationDelivery {
  return {
    id: String(row.id),
    kind: "notification",
    workspaceId: String(row.workspace_id),
    integrationId: String(row.integration_id),
    provider: String(row.provider) as NotificationDelivery["provider"],
    eventRef: String(row.event_ref),
    type: String(row.event_type) as NotificationType,
    deliveryId: String(row.delivery_id),
    state: String(row.state) as NotificationDelivery["state"],
    attempts: Number(row.attempts),
    nextAttemptAt: text(row.next_attempt_at),
    outcomeUncertain: Number(row.outcome_uncertain) === 1,
    lastReasonCode: text(row.last_reason_code),
    lastError: text(row.last_error),
    payloadHash: String(row.payload_sha256),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deliveredAt: text(row.delivered_at),
    version: Number(row.version),
  };
}
function decodeAttempt(row: Row): NotificationAttempt {
  return {
    number: Number(row.number),
    startedAt: String(row.started_at),
    finishedAt: text(row.finished_at),
    outcome: String(row.outcome) as NotificationAttempt["outcome"],
    httpStatus: row.http_status === null ? null : Number(row.http_status),
    uncertain: Number(row.uncertain) === 1,
    reasonCode: text(row.reason_code),
    detail: text(row.detail),
  };
}

export class NotificationsService {
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly leaseMs: number;
  private readonly owner = `dispatcher:${randomUUID()}`;

  constructor(
    private readonly ctx: ServiceContext,
    private readonly integrations: IntegrationsService,
    private readonly batches: BatchesService,
    private readonly options: NotificationOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.leaseMs = options.leaseMs ?? defaultLeaseMs;
  }

  /** Notification deliveries of this workspace the caller may read, newest first. */
  list(filter: NotificationFilter = {}): NotificationDelivery[] {
    this.ctx.authorize("R");
    const clauses = ["workspace_id=?"];
    const params: unknown[] = [this.ctx.workspaceId];
    if (filter.state) {
      clauses.push("state=?");
      params.push(filter.state);
    }
    if (filter.integrationId) {
      clauses.push("integration_id=?");
      params.push(filter.integrationId);
    }
    if (filter.type) {
      clauses.push("event_type=?");
      params.push(filter.type);
    }
    return this.ctx.database
      .all(
        `SELECT * FROM notification_deliveries WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT 2000`,
        ...params,
      )
      .filter((row) => this.mayRead(row))
      .map(decodeDelivery);
  }

  get(id: string): NotificationDeliveryDetail {
    this.ctx.authorize("R");
    const row = this.row(id);
    if (!this.mayRead(row)) throw new ContractError("NOT_FOUND", "Delivery does not exist", { id });
    return {
      ...decodeDelivery(row),
      attemptLog: this.ctx.database
        .all(
          "SELECT * FROM notification_attempts WHERE workspace_id=? AND delivery_ref=? ORDER BY number",
          this.ctx.workspaceId,
          id,
        )
        .map(decodeAttempt),
      payload: this.payloadOf(row),
    };
  }

  /** Reopens a dead letter for another delivery cycle with the same delivery ID and bytes. */
  requeue(id: string): NotificationDelivery {
    const row = this.row(id);
    const payload = this.payloadOf(row);
    this.ctx.authorize("A", payload.projectId ?? undefined);
    const integration = this.integrations.stored(String(row.integration_id));
    if (integration.state !== "active")
      throw new ContractError("PRECONDITION_FAILED", "Integration is not active", {
        reasonCode: `integration_${integration.state}`,
      });
    return inTx(this.ctx, () => {
      const at = this.now().toISOString();
      const changed = this.ctx.database.run(
        "UPDATE notification_deliveries SET state='pending',next_attempt_at=?,window_started_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=?,version=version+1 WHERE workspace_id=? AND id=? AND state='dead_letter'",
        at,
        at,
        at,
        this.ctx.workspaceId,
        id,
      );
      if (Number(changed.changes) !== 1)
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Only a dead-lettered delivery can be requeued",
          {
            id,
            state: String(row.state),
          },
        );
      auditSecurity(this.ctx, "notification.requeue", id, "allowed");
      return decodeDelivery(this.row(id));
    });
  }

  /** Dead-lettered notifications in the admin DLQ shape (independent of any verdict). */
  deadLetters(): NotificationDeadLetter[] {
    this.ctx.authorize("A");
    return this.deadLetterEntries();
  }

  /**
   * The same entries without a permission check, for the operations DLQ whose own listing already
   * requires read access (a notification list needs no more); requeue stays admin-only there.
   */
  deadLetterEntries(): NotificationDeadLetter[] {
    return this.ctx.database
      .all(
        "SELECT * FROM notification_deliveries WHERE workspace_id=? AND state='dead_letter' ORDER BY created_at DESC, id DESC LIMIT 1000",
        this.ctx.workspaceId,
      )
      .map((row) => ({
        source: "notification" as const,
        id: String(row.id),
        state: "dead_letter" as const,
        attempts: Number(row.attempts),
        lastError: text(row.last_error),
        createdAt: String(row.created_at),
        subject: `${String(row.event_type)} → ${String(row.provider)}`,
      }));
  }

  /** Removes finished deliveries and their attempt log once past retention. */
  purge(retentionDays = notificationRetentionDays): number {
    const cutoff = new Date(this.now().getTime() - retentionDays * 86_400_000).toISOString();
    return inTx(this.ctx, () => {
      this.ctx.database.run(
        "DELETE FROM notification_attempts WHERE workspace_id=? AND delivery_ref IN (SELECT id FROM notification_deliveries WHERE workspace_id=? AND state<>'pending' AND created_at<?)",
        this.ctx.workspaceId,
        this.ctx.workspaceId,
        cutoff,
      );
      return Number(
        this.ctx.database.run(
          "DELETE FROM notification_deliveries WHERE workspace_id=? AND state<>'pending' AND created_at<?",
          this.ctx.workspaceId,
          cutoff,
        ).changes,
      );
    });
  }

  /** One controller pass: schedule new deliveries from the outbox, then send what is due. */
  async tick(): Promise<{ created: number; attempted: number }> {
    if (restoreIsolated(this.ctx)) return { created: 0, attempted: 0 };
    const created = this.fanOut();
    const attempted = await this.dispatch();
    return { created, attempted };
  }

  // ---- fan-out -------------------------------------------------------------------------

  /**
   * Creates one delivery per (event, matching integration); the unique key makes a rescan harmless.
   * The scan runs in one transaction: its writes (deliveries, cursor) would otherwise be bare
   * statements, and a busy writer lock would escape as a raw SQLite error (logged `INTERNAL`)
   * instead of the typed, retryable `writer_contention` refusal `withTx` raises.
   */
  fanOut(): number {
    return inTx(this.ctx, () => this.scan());
  }

  private scan(): number {
    const workspaceId = this.ctx.workspaceId;
    const now = this.now();
    const integrations = this.integrations.activeFor(channelProviders);
    const cursorKey = `notifications:cursor:${workspaceId}`;
    const cursor = text(
      this.ctx.database.get("SELECT value FROM operational_state WHERE key=?", cursorKey)?.value,
    );
    const save = (value: string) =>
      this.ctx.database.run(
        "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        cursorKey,
        value,
      );
    if (!integrations.length) {
      save(now.toISOString());
      return 0;
    }
    const earliest = integrations.reduce(
      (min, integration) => (integration.createdAt < min ? integration.createdAt : min),
      integrations[0]?.createdAt ?? now.toISOString(),
    );
    const since = cursor
      ? new Date(Math.min(Date.parse(cursor) - scanOverlapMs, now.getTime())).toISOString()
      : earliest;
    const rows = this.ctx.database.all(
      `SELECT id,created_at,aggregate_id,type,data_json FROM outbox WHERE workspace_id=? AND created_at>=? AND type IN (${notifiableOutboxTypes.map(() => "?").join(",")}) ORDER BY created_at,id LIMIT ?`,
      workspaceId,
      since,
      ...notifiableOutboxTypes,
      scanLimit,
    );
    const batchMemo = new Map<string, Notifiable | null>();
    let created = 0;
    for (const row of rows)
      for (const event of this.classify(row, batchMemo))
        for (const integration of integrations)
          if (
            Date.parse(String(row.created_at)) >= Date.parse(integration.createdAt) &&
            integration.id !== event.excludeIntegrationId &&
            this.matches(integration, event)
          )
            created += this.insertDelivery(integration, event);
    const last = rows.at(-1);
    save(rows.length >= scanLimit && last ? String(last.created_at) : now.toISOString());
    return created;
  }

  private matches(integration: StoredIntegration, event: Notifiable): boolean {
    if (!integration.events.includes(event.type)) return false;
    if (
      integration.projectIds.length &&
      (!event.projectId || !integration.projectIds.includes(event.projectId))
    )
      return false;
    const rules = this.settingsOf(integration).rules;
    if (
      rules?.environmentIds?.length &&
      (!event.environmentId || !rules.environmentIds.includes(event.environmentId))
    )
      return false;
    if (rules?.suiteIds?.length && (!event.suiteId || !rules.suiteIds.includes(event.suiteId)))
      return false;
    return true;
  }

  private settingsOf(integration: StoredIntegration): ChannelSettings {
    // Settings were validated by the provider's parseSettings when the integration was written.
    const settings: ChannelSettings = record(integration.settings);
    return settings;
  }

  private classify(row: Row, batchMemo: Map<string, Notifiable | null>): Notifiable[] {
    const type = String(row.type);
    const payload = parse(row.data_json);
    const eventRef = String(row.id);
    const occurredAt = String(row.created_at);
    const aggregateId = String(row.aggregate_id);
    switch (type) {
      case "run.completed":
        return this.classifyRun(row, payload, batchMemo);
      case "schedule.misfire":
      case "schedule.paused":
        return [
          {
            type: type as NotificationType,
            eventRef,
            occurredAt,
            projectId: text(payload.projectId),
            environmentId: null,
            suiteId: null,
            source: {
              projectId: text(payload.projectId),
              scheduleId: text(payload.scheduleId) ?? aggregateId,
              reasonCode: text(payload.reasonCode),
              linkPath: `/schedules/${text(payload.scheduleId) ?? aggregateId}`,
            },
          },
        ];
      case "alert.fired":
        return [
          {
            type: "alert.fired",
            eventRef,
            occurredAt,
            projectId: text(payload.projectId),
            environmentId: null,
            suiteId: null,
            source: {
              projectId: text(payload.projectId),
              reasonCode: text(payload.rule),
              linkPath: "/operations/alerts",
            },
          },
        ];
      case "resource.orphaned":
        return this.classifyOrphan(row, payload);
      case "worker.offline":
        return [
          {
            type: "worker.offline",
            eventRef,
            occurredAt,
            projectId: null,
            environmentId: null,
            suiteId: null,
            source: { reasonCode: "worker_offline", linkPath: "/workers" },
          },
        ];
      case "delivery.dead_letter":
        return [
          {
            type: "delivery.dead_letter",
            eventRef,
            occurredAt,
            projectId: text(payload.projectId),
            environmentId: null,
            suiteId: null,
            source: {
              projectId: text(payload.projectId),
              reasonCode: text(payload.reasonCode),
              linkPath: `/settings/notifications?delivery=${aggregateId}`,
            },
            ...(text(payload.integrationId)
              ? { excludeIntegrationId: String(payload.integrationId) }
              : {}),
          },
        ];
      default:
        return [];
    }
  }

  private classifyRun(
    row: Row,
    payload: Record<string, unknown>,
    memo: Map<string, Notifiable | null>,
  ): Notifiable[] {
    const runId = String(row.aggregate_id);
    const run = this.ctx.database.get(
      "SELECT r.outcome,r.gate,r.batch_id,r.data_json,t.project_id FROM runs r JOIN tests t ON t.workspace_id=r.workspace_id AND t.id=r.test_id WHERE r.workspace_id=? AND r.id=?",
      this.ctx.workspaceId,
      runId,
    );
    if (!run) return [];
    const outcome = text(run.outcome) as NotificationPayload["summary"]["outcome"];
    const environmentId = text(record(parse(run.data_json).matrixCell).environmentId);
    const batchId = text(run.batch_id);
    const projectId = String(run.project_id);
    const reason = text(payload.reasonCode);
    const events: Notifiable[] = [];
    const batch = batchId
      ? this.batchCompletion(batchId, projectId, environmentId, String(row.created_at), memo)
      : null;
    const primary: Notifiable = {
      type: outcome === "passed" || outcome === "cancelled" ? "run.completed" : "run.failed",
      eventRef: String(row.id),
      occurredAt: String(row.created_at),
      projectId,
      environmentId,
      suiteId: batchId ? this.suiteOf(batchId) : null,
      source: {
        projectId,
        runId,
        batchId,
        outcome,
        gate: text(run.gate) as NotificationPayload["summary"]["gate"],
        reasonCode: reason !== null && reasonCodes.includes(reason) ? reason : null,
        linkPath: `/runs/${runId}`,
      },
    };
    events.push(primary);
    if (outcome === "passed" && this.recoveredFrom(runId, environmentId))
      events.push({ ...primary, type: "run.recovered", eventRef: `recovered:${String(row.id)}` });
    if (batch) events.push(batch);
    return events;
  }

  /** A resource whose cleanup is unknown (REQ-042 orphans): reported against the Run that created it. */
  private classifyOrphan(row: Row, payload: Record<string, unknown>): Notifiable[] {
    const runId = text(payload.runId);
    const owner = runId
      ? this.ctx.database.get(
          "SELECT t.project_id FROM runs r JOIN tests t ON t.workspace_id=r.workspace_id AND t.id=r.test_id WHERE r.workspace_id=? AND r.id=?",
          this.ctx.workspaceId,
          runId,
        )
      : undefined;
    const projectId = owner ? String(owner.project_id) : null;
    return [
      {
        type: "resource.orphaned",
        eventRef: String(row.id),
        occurredAt: String(row.created_at),
        projectId,
        environmentId: null,
        suiteId: null,
        source: {
          projectId,
          runId: owner ? runId : null,
          reasonCode: "cleanup_inconclusive",
          linkPath: owner ? `/runs/${runId}` : "/resources",
        },
      },
    ];
  }

  /** The previous finished Run of the same test and environment, when it did not pass. */
  private recoveredFrom(runId: string, environmentId: string | null): boolean {
    const earlier = this.ctx.database.all(
      "SELECT r.outcome,r.data_json FROM runs r WHERE r.workspace_id=? AND r.phase='completed' AND r.id<? AND r.test_id=(SELECT test_id FROM runs WHERE workspace_id=? AND id=?) ORDER BY r.id DESC LIMIT 20",
      this.ctx.workspaceId,
      runId,
      this.ctx.workspaceId,
      runId,
    );
    const previous = earlier.find(
      (candidate) =>
        text(record(parse(candidate.data_json).matrixCell).environmentId) === environmentId,
    );
    return previous !== undefined && !["passed", "cancelled"].includes(String(previous.outcome));
  }

  private suiteOf(batchId: string): string | null {
    const row = this.ctx.database.get(
      "SELECT data_json FROM batches WHERE workspace_id=? AND id=?",
      this.ctx.workspaceId,
      batchId,
    );
    return row ? text(parse(row.data_json).suiteId) : null;
  }

  /** `batch.completed` exists once every member Run is terminal; the key makes it fire exactly once per integration. */
  private batchCompletion(
    batchId: string,
    projectId: string,
    environmentId: string | null,
    occurredAt: string,
    memo: Map<string, Notifiable | null>,
  ): Notifiable | null {
    if (memo.has(batchId)) return memo.get(batchId) ?? null;
    let result: Notifiable | null = null;
    const open = this.ctx.database.get(
      "SELECT COUNT(*) AS open FROM runs WHERE workspace_id=? AND batch_id=? AND phase<>'completed'",
      this.ctx.workspaceId,
      batchId,
    );
    if (Number(open?.open) === 0) {
      const aggregate = record(this.batches.get(batchId).aggregate);
      const counts = record(aggregate.counts);
      result = {
        type: "batch.completed",
        eventRef: `batch:${batchId}`,
        occurredAt,
        projectId,
        environmentId,
        suiteId: this.suiteOf(batchId),
        source: {
          projectId,
          batchId,
          gate: text(aggregate.gate) as NotificationPayload["summary"]["gate"],
          counts: {
            passed: Number(counts.passed ?? 0),
            failed: Number(counts.failed ?? 0),
            blocked: Number(counts.blocked ?? 0),
            cancelled: Number(counts.cancelled ?? 0),
            inconclusive: Number(counts.inconclusive ?? 0),
          },
          linkPath: `/batches/${batchId}`,
        },
      };
    }
    memo.set(batchId, result);
    return result;
  }

  private insertDelivery(integration: StoredIntegration, event: Notifiable): number {
    const id = `ntd_${randomUUID()}`;
    const at = this.now().toISOString();
    let payload: NotificationPayload;
    try {
      payload = buildNotificationPayload(
        {
          ...event.source,
          type: event.type,
          eventId: event.eventRef,
          deliveryId: id,
          occurredAt: event.occurredAt,
          test: false,
          workspaceId: this.ctx.workspaceId,
        },
        this.options.publicOrigin,
        this.settingsOf(integration).redaction,
      );
    } catch {
      auditSecurity(this.ctx, "notification.payload_invalid", event.eventRef, "denied");
      return 0;
    }
    const body = notificationBody(payload);
    const inserted = this.ctx.database.run(
      "INSERT INTO notification_deliveries(workspace_id,id,created_at,version,data_json,integration_id,provider,event_ref,event_type,delivery_id,state,attempts,next_attempt_at,outcome_uncertain,payload_sha256,window_started_at,updated_at) VALUES(?,?,?,1,?,?,?,?,?,?,'pending',0,?,0,?,?,?) ON CONFLICT DO NOTHING",
      this.ctx.workspaceId,
      id,
      at,
      JSON.stringify({ payload }),
      integration.id,
      integration.provider,
      event.eventRef,
      event.type,
      id,
      at,
      sha256(body),
      at,
      at,
    );
    return Number(inserted.changes);
  }

  // ---- dispatch ------------------------------------------------------------------------

  /** Sends every due delivery once; a failure schedules the retry, it never throws to the caller. */
  async dispatch(): Promise<number> {
    const now = this.now().toISOString();
    const due = this.ctx.database.all(
      "SELECT * FROM notification_deliveries WHERE workspace_id=? AND state='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND (lease_expires_at IS NULL OR lease_expires_at<=?) ORDER BY next_attempt_at, id LIMIT ?",
      this.ctx.workspaceId,
      now,
      now,
      dispatchBatch,
    );
    let attempted = 0;
    for (const row of due) if (await this.attempt(row)) attempted += 1;
    return attempted;
  }

  private async attempt(row: Row): Promise<boolean> {
    const id = String(row.id);
    let integration: StoredIntegration;
    try {
      integration = this.integrations.stored(String(row.integration_id));
    } catch {
      this.deadLetter(row, "integration_missing", "The integration no longer exists");
      return false;
    }
    if (integration.state === "revoked") {
      this.deadLetter(row, "integration_revoked", "The integration was revoked");
      return false;
    }
    // A paused integration keeps its deliveries pending: resuming delivers them.
    if (integration.state !== "active") return false;
    const payload = this.payloadOf(row);
    const body = notificationBody(payload);
    if (sha256(body) !== String(row.payload_sha256)) {
      this.deadLetter(row, "payload_tampered", "The stored payload no longer matches its hash");
      return false;
    }
    const claim = this.claim(row);
    if (!claim) return false;
    if (claim.exhausted) {
      this.deadLetter(this.row(id), "attempts_exhausted", "Retry budget exhausted", claim.number);
      return false;
    }
    let outcome: DeliveryAttemptOutcome;
    try {
      const adapter = this.integrations.adapter(integration.provider);
      if (!adapter.deliver)
        outcome = {
          state: "rejected",
          reasonCode: "adapter_cannot_deliver",
          detail: "Adapter cannot deliver",
        };
      else {
        const notification: OutboundNotification = {
          deliveryId: String(row.delivery_id),
          eventId: payload.eventId,
          attempt: claim.number,
          payload,
          body,
        };
        outcome = await adapter.deliver(
          this.integrations.deliveryContext(this.ctx.correlationId ?? randomUUID()),
          integration,
          notification,
        );
      }
    } catch (error) {
      const reasonCode =
        error instanceof ContractError ? text(record(error.details).reasonCode) : null;
      outcome =
        reasonCode === "redaction_failed"
          ? { state: "rejected", reasonCode, detail: "Payload failed redaction and was not sent" }
          : {
              state: "failed",
              reasonCode: "adapter_error",
              detail: "The adapter failed before sending",
            };
    }
    this.settle(id, claim.number, outcome);
    return true;
  }

  /** Takes the delivery's lease and opens its next attempt; a stale in-flight attempt is closed as uncertain. */
  private claim(row: Row): { number: number; exhausted: boolean } | null {
    const at = this.now();
    const iso = at.toISOString();
    return inTx(this.ctx, () => {
      const leased = this.ctx.database.run(
        "UPDATE notification_deliveries SET lease_owner=?,lease_expires_at=?,updated_at=?,version=version+1 WHERE workspace_id=? AND id=? AND state='pending' AND version=?",
        this.owner,
        new Date(at.getTime() + this.leaseMs).toISOString(),
        iso,
        this.ctx.workspaceId,
        String(row.id),
        Number(row.version),
      );
      if (Number(leased.changes) !== 1) return null;
      // An attempt still in flight under an expired lease may have reached the destination.
      const stale = this.ctx.database.run(
        "UPDATE notification_attempts SET outcome='abandoned',finished_at=?,uncertain=1,reason_code='lease_expired',detail='The dispatcher stopped before the attempt finished' WHERE workspace_id=? AND delivery_ref=? AND outcome='in_flight'",
        iso,
        this.ctx.workspaceId,
        String(row.id),
      );
      if (Number(stale.changes))
        this.ctx.database.run(
          "UPDATE notification_deliveries SET outcome_uncertain=1 WHERE workspace_id=? AND id=?",
          this.ctx.workspaceId,
          String(row.id),
        );
      const used = this.attemptsInWindow(row);
      const exhausted =
        used >= deliveryRetryPolicy.maxAttempts ||
        at.getTime() >= Date.parse(String(row.window_started_at)) + deliveryRetryPolicy.windowMs;
      const number =
        Number(
          this.ctx.database.get(
            "SELECT COALESCE(MAX(number),0) AS n FROM notification_attempts WHERE workspace_id=? AND delivery_ref=?",
            this.ctx.workspaceId,
            String(row.id),
          )?.n,
        ) + 1;
      if (exhausted) return { number, exhausted };
      this.ctx.database.run(
        "INSERT INTO notification_attempts(workspace_id,id,created_at,version,data_json,delivery_ref,number,started_at,outcome,uncertain) VALUES(?,?,?,1,'{}',?,?,?,'in_flight',0)",
        this.ctx.workspaceId,
        `nta_${randomUUID()}`,
        iso,
        String(row.id),
        number,
        iso,
      );
      this.ctx.database.run(
        "UPDATE notification_deliveries SET attempts=attempts+1 WHERE workspace_id=? AND id=?",
        this.ctx.workspaceId,
        String(row.id),
      );
      return { number, exhausted };
    });
  }

  private attemptsInWindow(row: Row): number {
    return Number(
      this.ctx.database.get(
        "SELECT COUNT(*) AS n FROM notification_attempts WHERE workspace_id=? AND delivery_ref=? AND started_at>=?",
        this.ctx.workspaceId,
        String(row.id),
        String(row.window_started_at),
      )?.n,
    );
  }

  /** Records the attempt result and either completes, reschedules or dead-letters the delivery. */
  private settle(id: string, number: number, outcome: DeliveryAttemptOutcome): void {
    const at = this.now();
    const iso = at.toISOString();
    inTx(this.ctx, () => {
      const row = this.row(id);
      const attemptOutcome =
        outcome.state === "delivered"
          ? "delivered"
          : outcome.state === "rejected"
            ? "rejected"
            : "failed";
      this.ctx.database.run(
        "UPDATE notification_attempts SET outcome=?,finished_at=?,http_status=?,uncertain=?,reason_code=?,detail=? WHERE workspace_id=? AND delivery_ref=? AND number=? AND outcome='in_flight'",
        attemptOutcome,
        iso,
        outcome.httpStatus ?? null,
        outcome.uncertain ? 1 : 0,
        outcome.reasonCode ?? null,
        safeDetail(outcome.detail),
        this.ctx.workspaceId,
        id,
        number,
      );
      if (outcome.state === "delivered") {
        this.ctx.database.run(
          "UPDATE notification_deliveries SET state='delivered',delivered_at=?,next_attempt_at=NULL,outcome_uncertain=0,lease_owner=NULL,lease_expires_at=NULL,last_reason_code=NULL,last_error=NULL,updated_at=?,version=version+1 WHERE workspace_id=? AND id=?",
          iso,
          iso,
          this.ctx.workspaceId,
          id,
        );
        return;
      }
      const used = this.attemptsInWindow(row);
      const exhausted =
        used >= deliveryRetryPolicy.maxAttempts ||
        at.getTime() >= Date.parse(String(row.window_started_at)) + deliveryRetryPolicy.windowMs;
      const uncertain = Number(row.outcome_uncertain) === 1 || Boolean(outcome.uncertain);
      if (outcome.state === "rejected" || exhausted) {
        this.finishDead(
          row,
          outcome.state === "rejected" ? (outcome.reasonCode ?? "rejected") : "attempts_exhausted",
          safeDetail(outcome.detail) ?? "Retry budget exhausted",
          uncertain,
        );
        return;
      }
      const wait = Math.max(
        deliveryBackoffMs(Math.max(1, used), this.random),
        outcome.retryAfterMs ?? 0,
      );
      this.ctx.database.run(
        "UPDATE notification_deliveries SET next_attempt_at=?,outcome_uncertain=?,lease_owner=NULL,lease_expires_at=NULL,last_reason_code=?,last_error=?,updated_at=?,version=version+1 WHERE workspace_id=? AND id=?",
        new Date(at.getTime() + wait).toISOString(),
        uncertain ? 1 : 0,
        outcome.reasonCode ?? "failed",
        safeDetail(outcome.detail),
        iso,
        this.ctx.workspaceId,
        id,
      );
    });
  }

  private deadLetter(row: Row, reasonCode: string, detail: string, number?: number): void {
    inTx(this.ctx, () => {
      const fresh = this.row(String(row.id));
      if (String(fresh.state) !== "pending") return;
      if (number !== undefined)
        this.ctx.database.run(
          "UPDATE notification_attempts SET outcome='rejected',finished_at=?,reason_code=?,detail=? WHERE workspace_id=? AND delivery_ref=? AND number=? AND outcome='in_flight'",
          this.now().toISOString(),
          reasonCode,
          detail,
          this.ctx.workspaceId,
          String(row.id),
          number,
        );
      this.finishDead(fresh, reasonCode, detail, Number(fresh.outcome_uncertain) === 1);
    });
  }

  private finishDead(row: Row, reasonCode: string, detail: string, uncertain: boolean): void {
    const iso = this.now().toISOString();
    this.ctx.database.run(
      "UPDATE notification_deliveries SET state='dead_letter',next_attempt_at=NULL,outcome_uncertain=?,lease_owner=NULL,lease_expires_at=NULL,last_reason_code=?,last_error=?,updated_at=?,version=version+1 WHERE workspace_id=? AND id=?",
      uncertain ? 1 : 0,
      reasonCode,
      detail,
      iso,
      this.ctx.workspaceId,
      String(row.id),
    );
    // A dead `delivery.dead_letter` notice does not announce itself again: the chain ends here.
    if (String(row.event_type) === "delivery.dead_letter") return;
    new OutboxRepository(this.ctx.database).append(
      this.ctx.workspaceId,
      String(row.id),
      "delivery.dead_letter",
      {
        deliveryId: String(row.id),
        integrationId: String(row.integration_id),
        provider: String(row.provider),
        eventType: String(row.event_type),
        projectId: this.payloadOf(row).projectId,
        reasonCode: /^[a-z][a-z0-9_.-]{0,63}$/u.test(reasonCode) ? reasonCode : "unspecified",
      },
    );
  }

  // ---- helpers -------------------------------------------------------------------------

  private row(id: string): Row {
    const row = this.ctx.database.get(
      "SELECT * FROM notification_deliveries WHERE workspace_id=? AND id=?",
      this.ctx.workspaceId,
      id,
    );
    if (!row) throw new ContractError("NOT_FOUND", "Delivery does not exist", { id });
    return row;
  }

  private payloadOf(row: Row): NotificationPayload {
    // Stored by `insertDelivery` from a validated payload; the hash check guards the bytes.
    const stored: NotificationPayload = record(parse(row.data_json).payload) as NotificationPayload;
    return stored;
  }

  private mayRead(row: Row): boolean {
    const projectId = this.payloadOf(row).projectId;
    if (!projectId) return true;
    try {
      this.ctx.authorize("R", projectId);
      return true;
    } catch {
      return false;
    }
  }
}
