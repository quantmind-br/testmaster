import { randomUUID } from "node:crypto";
import {
  type AdminOperation,
  ContractError,
  type DlqEntry,
  type OperationsStatus,
  validate,
} from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import {
  AuditRepository,
  AuxiliaryLeaseRepository,
  OutboxRepository,
  type PersistenceDatabase,
} from "@testmaster/persistence";
import { auditSecurity } from "./audit.js";
import type { ServiceContext } from "./context.js";
import type { DeliveryService } from "./delivery.js";
import { backupSettings, listServerBackups } from "./server-backup.js";
import type { ServerConfig } from "./server-config.js";

/**
 * Administrative operations of one workspace (M4-02, OPS-025, OPS-026, OPS-034). Every change is
 * authorized as admin, audited, and recorded in the `admin_operations` ledger; backup requests are
 * fulfilled by the separate backup agent that holds the backup key.
 */
export type DlqEntryView = DlqEntry;
/** A dead-letter queue the operator can list and requeue; services register theirs once per instance. */
export interface DlqSource {
  list(): DlqEntryView[];
  /** Reopens one entry for a new delivery cycle; never reruns a Run. */
  requeue(id: string): unknown;
}

export const isolationKey = "restore:isolated";

/** Reads a JSON document kept in `operational_state`; the writer of each key owns its shape. */
export function stateJson<T>(database: PersistenceDatabase, key: string): T | null {
  const row = database.get("SELECT value FROM operational_state WHERE key=?", key);
  return row ? JSON.parse(String(row.value)) : null;
}
const admissionKey = (workspaceId: string): string => `ops:admission:${workspaceId}`;
const upsert =
  "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value";

export interface AdmissionState {
  state: "paused" | "draining";
  reason: string;
  by: string;
  at: string;
}

interface OperationRow {
  id: string;
  workspace_id: string | null;
  created_at: string;
  version: number;
  data_json: string;
  kind: AdminOperation["kind"];
  state: AdminOperation["state"];
  requested_by: string;
  started_at: string | null;
  finished_at: string | null;
}

interface OperationData {
  reason: string;
  params: unknown;
  result: unknown;
  error: { code: string; message: string } | null;
}

function view(row: OperationRow): AdminOperation {
  const data = JSON.parse(row.data_json) as OperationData;
  return validate<AdminOperation>("AdminOperation", {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    state: row.state,
    requestedBy: row.requested_by,
    reason: data.reason,
    params: data.params ?? {},
    result: data.result ?? {},
    error: data.error ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    version: Number(row.version),
  });
}

const operationColumns =
  "id,workspace_id,created_at,version,data_json,kind,state,requested_by,started_at,finished_at";

export interface OperationsDeps {
  /** The deployment configuration; absent in the local profile. */
  server?: ServerConfig;
  reconcile(options: { dryRun: boolean }): Promise<unknown>;
  deliveries(): DeliveryService;
}

export class OperationsService {
  private readonly sources = new Map<string, DlqSource>();
  constructor(
    readonly ctx: ServiceContext,
    private readonly deps: OperationsDeps,
  ) {
    this.registerDlqSource("delivery", this.deliverySource());
    this.registerDlqSource("auxiliary", this.auxiliarySource());
  }

  registerDlqSource(name: string, source: DlqSource): void {
    if (this.sources.has(name))
      throw new ContractError("INTERNAL", `DLQ source already registered: ${name}`);
    this.sources.set(name, source);
  }

  /** True while a restore keeps schedules, integrations and notification channels inactive. */
  isolated(): boolean {
    return (
      this.ctx.database.get("SELECT value FROM operational_state WHERE key=?", isolationKey)
        ?.value === "true"
    );
  }

  admissionState(): AdmissionState | null {
    if (!this.ctx.workspaceId) return null;
    return stateJson<AdmissionState>(this.ctx.database, admissionKey(this.ctx.workspaceId));
  }

  /** Refuses new admissions while the workspace is paused or draining; running work is untouched. */
  assertAdmitting(): void {
    const state = this.admissionState();
    if (!state) return;
    throw new ContractError(
      "PRECONDITION_FAILED",
      state.state === "paused" ? "Run admission is paused" : "Workspace is draining",
      {
        reasonCode: state.state === "paused" ? "admission_paused" : "admission_draining",
        since: state.at,
        reason: state.reason,
      },
    );
  }

  private requireOwner(): void {
    this.ctx.authorize("A");
    // The host operator acts as the workspace's system principal; the host already controls the deployment.
    if (this.ctx.actor.credentialKind === "system") return;
    const role = this.ctx.database.get(
      "SELECT role FROM memberships WHERE workspace_id=? AND principal_id=?",
      this.ctx.workspaceId,
      this.ctx.principalId,
    )?.role;
    if (role !== "org_owner")
      throw new ContractError("FORBIDDEN", "Instance-level operations require an org_owner", {
        reason: "owner_required",
      });
  }

  private insert(
    kind: AdminOperation["kind"],
    state: AdminOperation["state"],
    reason: string,
    params: unknown,
    result: unknown,
  ): AdminOperation {
    const now = new Date().toISOString();
    const id = `opr_${randomUUID()}`;
    const finished = state === "completed" || state === "failed";
    this.ctx.database.run(
      "INSERT INTO admin_operations(id,workspace_id,created_at,version,data_json,kind,state,requested_by,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      id,
      this.ctx.workspaceId,
      now,
      1,
      JSON.stringify({ reason, params, result, error: null } satisfies OperationData),
      kind,
      state,
      this.ctx.principalId,
      finished ? now : null,
      finished ? now : null,
    );
    return this.get(id);
  }

  list(): AdminOperation[] {
    this.ctx.authorize("R");
    return this.ctx.database
      .all<OperationRow>(
        `SELECT ${operationColumns} FROM admin_operations WHERE workspace_id=? ORDER BY created_at DESC,id DESC LIMIT 500`,
        this.ctx.workspaceId,
      )
      .map(view);
  }

  get(id: string): AdminOperation {
    this.ctx.authorize("R");
    const row = this.ctx.database.get<OperationRow>(
      `SELECT ${operationColumns} FROM admin_operations WHERE workspace_id=? AND id=?`,
      this.ctx.workspaceId,
      id,
    );
    if (!row) throw new ContractError("NOT_FOUND", "Operation does not exist", { id });
    return view(row);
  }

  status(): OperationsStatus {
    this.ctx.authorize("R");
    const database = this.ctx.database;
    const workspaceId = this.ctx.workspaceId;
    const admission = this.admissionState();
    const count = (sql: string): number => Number(database.get(sql, workspaceId)?.n ?? 0);
    const activeRuns = count(
      "SELECT COUNT(*) AS n FROM runs WHERE workspace_id=? AND phase<>'completed'",
    );
    const state = (key: string) => stateJson<{ at?: string }>(database, key);
    const purged = stateJson<{ at: string; runsPurged: number; auditEventsPurged: number }>(
      database,
      `purge:last:${workspaceId}`,
    );
    return validate<OperationsStatus>("OperationsStatus", {
      admission: {
        state: admission?.state ?? "enabled",
        reason: admission?.reason ?? null,
        changedBy: admission?.by ?? null,
        changedAt: admission?.at ?? null,
      },
      globalAdmission: String(
        database.get("SELECT value FROM operational_state WHERE key='admission'")?.value ??
          "enabled",
      ),
      isolation: {
        isolated: this.isolated(),
        review:
          String(
            database.get("SELECT value FROM operational_state WHERE key='restore_review'")?.value ??
              "",
          ) || null,
      },
      work: {
        activeRuns,
        queuedJobs: count(
          "SELECT COUNT(*) AS n FROM job_leases WHERE workspace_id=? AND state='queued' AND dispatchable=1",
        ),
        drained: activeRuns === 0,
      },
      backup: {
        configured: this.deps.server?.backup !== undefined,
        schedule: this.deps.server?.backup ? (this.deps.server.backup.schedule ?? "daily") : null,
        lastSuccessAt: state("backup:last-success")?.at ?? null,
        lastFailureAt: state("backup:last-failure")?.at ?? null,
      },
      retention: {
        lastRunAt: purged?.at ?? null,
        metadataWindowDays: 90,
        auditWindowDays: 365,
        runsPurged: purged?.runsPurged ?? 0,
        auditEventsPurged: purged?.auditEventsPurged ?? 0,
        auditSummaries: count(
          "SELECT COUNT(*) AS n FROM audit_purge_summaries WHERE workspace_id=?",
        ),
      },
    });
  }

  /** Pauses, drains or resumes new Run admission for this workspace; queued and running work continues. */
  admission(input: { action: "pause" | "drain" | "resume"; reason: string }): AdminOperation {
    this.ctx.authorize("A");
    return this.ctx.database.withTx(() => {
      const before = this.admissionState();
      const now = new Date().toISOString();
      const key = admissionKey(this.ctx.workspaceId);
      if (input.action === "resume")
        this.ctx.database.run("DELETE FROM operational_state WHERE key=?", key);
      else
        this.ctx.database.run(
          upsert,
          key,
          JSON.stringify({
            state: input.action === "pause" ? "paused" : "draining",
            reason: input.reason,
            by: this.ctx.principalId,
            at: now,
          } satisfies AdmissionState),
        );
      const active = Number(
        this.ctx.database.get(
          "SELECT COUNT(*) AS n FROM runs WHERE workspace_id=? AND phase<>'completed'",
          this.ctx.workspaceId,
        )?.n ?? 0,
      );
      new AuditRepository(this.ctx.database).append({
        workspaceId: this.ctx.workspaceId,
        actor: this.ctx.principalId,
        action: `ops.admission.${input.action}.allowed`,
        resourceId: this.ctx.workspaceId,
        requestId: this.ctx.correlationId ?? randomUUID(),
        timestamp: now,
        beforeHash: semanticHash(before ?? { state: "enabled" }),
        afterHash: semanticHash({ action: input.action }),
      });
      new OutboxRepository(this.ctx.database).append(
        this.ctx.workspaceId,
        this.ctx.workspaceId,
        "ops.admission.changed",
        { action: input.action, actor: this.ctx.principalId },
      );
      return this.insert(
        "admission",
        "completed",
        input.reason,
        { action: input.action },
        {
          admission:
            input.action === "resume"
              ? "enabled"
              : input.action === "pause"
                ? "paused"
                : "draining",
          activeRuns: active,
          drained: active === 0,
        },
      );
    });
  }

  /** Previews or applies reconciliation of stale leases, orphan staging and unreachable evidence. */
  async reconcile(input: {
    mode: "preview" | "apply";
    approval?: string;
  }): Promise<AdminOperation> {
    this.ctx.authorize("A");
    const result = await this.deps.reconcile({ dryRun: input.mode === "preview" });
    return this.ctx.database.withTx(() => {
      auditSecurity(this.ctx, `ops.reconcile.${input.mode}`, this.ctx.workspaceId, "allowed");
      return this.insert(
        "reconcile",
        "completed",
        `reconcile ${input.mode}`,
        { mode: input.mode, ...(input.approval ? { approval: input.approval } : {}) },
        JSON.parse(JSON.stringify(result ?? {})),
      );
    });
  }

  /** Queues one backup for the backup agent; only the agent holds the backup key and destination. */
  requestBackup(reason: string): AdminOperation {
    this.requireOwner();
    if (!this.deps.server)
      throw new ContractError("CAPABILITY_UNAVAILABLE", "Server backups need the server profile", {
        capability: "server-backup",
        milestone: "M4",
      });
    backupSettings(this.deps.server);
    return this.ctx.database.withTx(() => {
      const pending = this.ctx.database.get<OperationRow>(
        `SELECT ${operationColumns} FROM admin_operations WHERE workspace_id=? AND kind='backup' AND state IN ('requested','running') ORDER BY created_at LIMIT 1`,
        this.ctx.workspaceId,
      );
      if (pending) return view(pending);
      auditSecurity(this.ctx, "ops.backup.request", this.ctx.workspaceId, "requested");
      return this.insert("backup", "requested", reason, {}, {});
    });
  }

  /** Queues a non-destructive verification of one backup (MAC, hashes, decryption, archive listing). */
  requestRestoreVerification(input: { backupId: string; reason: string }): AdminOperation {
    this.requireOwner();
    if (!this.deps.server)
      throw new ContractError("CAPABILITY_UNAVAILABLE", "Server backups need the server profile", {
        capability: "server-backup",
        milestone: "M4",
      });
    backupSettings(this.deps.server);
    return this.ctx.database.withTx(() => {
      auditSecurity(this.ctx, "ops.restore.verify", input.backupId, "requested");
      return this.insert(
        "restore_verify",
        "requested",
        input.reason,
        { backupId: input.backupId },
        {},
      );
    });
  }

  /**
   * Lifts restore isolation after the operator confirmed the review. Integrations that the restore
   * paused stay paused until an admin re-enables each of them.
   */
  releaseIsolation(reason: string): AdminOperation {
    this.requireOwner();
    return this.ctx.database.withTx(() => {
      if (!this.isolated())
        throw new ContractError("PRECONDITION_FAILED", "Workspace is not isolated by a restore", {
          reasonCode: "not_isolated",
        });
      const review = this.ctx.database.get(
        "SELECT value FROM operational_state WHERE key='restore_review'",
      )?.value;
      if (review !== "operator_confirmed")
        throw new ContractError("PRECONDITION_FAILED", "Restore review must be approved first", {
          reasonCode: "restore_review_pending",
        });
      this.ctx.database.run("DELETE FROM operational_state WHERE key=?", isolationKey);
      auditSecurity(this.ctx, "ops.isolation.release", this.ctx.workspaceId, "allowed");
      new OutboxRepository(this.ctx.database).append(
        this.ctx.workspaceId,
        this.ctx.workspaceId,
        "ops.isolation.released",
        { actor: this.ctx.principalId },
      );
      return this.insert(
        "isolation_release",
        "completed",
        reason,
        {},
        { integrationsStayPaused: true },
      );
    });
  }

  dlq(): DlqEntryView[] {
    this.ctx.authorize("R");
    return [...this.sources.values()]
      .flatMap((source) => source.list())
      .sort((left, right) =>
        left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0,
      );
  }

  requeue(input: { source: string; id: string }): DlqEntryView {
    this.ctx.authorize("A");
    const source = this.sources.get(input.source);
    if (!source)
      throw new ContractError("NOT_FOUND", "Unknown dead-letter source", { source: input.source });
    const found = source.list().find((entry) => entry.id === input.id);
    if (!found)
      throw new ContractError("NOT_FOUND", "Entry is not dead-lettered", { id: input.id });
    auditSecurity(this.ctx, "ops.dlq.requeue", `${input.source}:${input.id}`, "requested");
    source.requeue(input.id);
    auditSecurity(this.ctx, "ops.dlq.requeue", `${input.source}:${input.id}`, "allowed");
    return { ...found, state: "requeued" };
  }

  private deliverySource(): DlqSource {
    return {
      list: () =>
        this.deps
          .deliveries()
          .list({ state: "dead_letter" })
          .map((delivery) => ({
            source: "delivery",
            id: delivery.id,
            state: delivery.state,
            attempts: delivery.attempts,
            lastError: delivery.lastError,
            createdAt: delivery.createdAt ?? delivery.nextAttemptAt ?? new Date(0).toISOString(),
            subject: delivery.checkName,
          })),
      requeue: (id) => this.deps.deliveries().requeue(id),
    };
  }

  private auxiliarySource(): DlqSource {
    return {
      list: () =>
        this.ctx.database
          .all<{
            id: string;
            queue: string;
            attempts: number;
            created_at: string;
            result: string | null;
          }>(
            "SELECT id,queue,attempts,created_at,json_extract(data_json,'$.result.state') AS result FROM job_leases WHERE workspace_id=? AND state='completed' AND queue<>'delivery' AND json_extract(data_json,'$.result.state')='dead_letter' ORDER BY created_at DESC LIMIT 500",
            this.ctx.workspaceId,
          )
          .map((job) => ({
            source: "auxiliary",
            id: job.id,
            state: "dead_letter",
            attempts: Number(job.attempts),
            lastError: null,
            createdAt: job.created_at,
            subject: job.queue,
          })),
      requeue: (id) =>
        new AuxiliaryLeaseRepository(this.ctx.database).requeueDeadLetter(
          this.ctx.workspaceId,
          id,
          new Date().toISOString(),
        ),
    };
  }

  /** Backups visible in the configured destination; needs the backup key, so the backup agent calls it. */
  async listBackups(key: Parameters<typeof listServerBackups>[1]) {
    if (!this.deps.server) return [];
    return listServerBackups(backupSettings(this.deps.server).destination, key);
  }
}
