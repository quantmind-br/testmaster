import { createHmac, randomUUID } from "node:crypto";
import { defaults } from "@testmaster/contracts";
import { canonicalJson, sha256 } from "@testmaster/domain";
import { auxiliaryQueues, type PersistenceDatabase } from "@testmaster/persistence";
import { auditSecurity } from "./audit.js";
import { type BackupKey, deriveSubkey, readKeyFile } from "./backup-crypto.js";
import type { ServiceContext } from "./context.js";
import { stateJson } from "./operations.js";
import type { ServerConfig } from "./server-config.js";

/**
 * Retention of the metadata and audit classes (OPS-021). Artifacts keep their own collector in
 * `retention.ts`. Legal holds and anything still in use are never purged; every purge of audit
 * events leaves a signed, chained summary behind.
 */
const dayMs = 86_400_000;
const purgePermitKey = (workspaceId: string): string => `retention:purge-permit:${workspaceId}`;
const legalHoldPrefix = (workspaceId: string): string => `retention:legal-hold:${workspaceId}`;
/**
 * The auxiliary jobs of a Run (its analysis and healing requests) name the Run in their payload;
 * their `resource_id` is a semantic hash. One placeholder: the Run id.
 */
const auxiliaryJobOfRun = `queue IN (${auxiliaryQueues.map((queue) => `'${queue}'`).join(",")}) AND json_extract(data_json,'$.payload.targetId')=?`;
/** Job states no holder works on any more; the purge deletes auxiliary jobs in these states only. */
const settledJobStates = "('completed','cancelled')";
const settledAuxiliaryJobOfRun = `${auxiliaryJobOfRun} AND state IN ${settledJobStates}`;
/** What the delete transaction of a Run returns when it finds a hold on the whole workspace. */
const workspaceHoldPlaced = Symbol("workspace hold placed");

export interface PurgeOptions {
  /** Clock hook; tests move it past the retention windows. */
  now?: Date;
  /** Reports what would be purged without changing anything. */
  dryRun?: boolean;
  /** Called at every write boundary; throwing aborts the pass (VAL-045 fault matrix). */
  faultHook?: (point: PurgePoint) => void;
  /** Upper bound of Runs and audit events handled in one pass. */
  limit?: number;
}

export const purgePoints = [
  "purge.run_deleted",
  "purge.runs_committed",
  "purge.audit_summarized",
  "purge.audit_deleted",
  "purge.audit_committed",
] as const;
export type PurgePoint = (typeof purgePoints)[number];

export interface PurgeReport {
  dryRun: boolean;
  legalHold: boolean;
  cutoffs: { metadata: string; audit: string };
  runs: { eligible: number; purged: number; skipped: { runId: string; reason: string }[] };
  batches: number;
  outboxEvents: number;
  sessions: number;
  /** Idempotency receipts of this workspace with `expires_at` before `cutoffs.metadata` deleted by a run; 0 in a preview and under a workspace hold. */
  idempotencyReceipts: number;
  audit: {
    eligible: number;
    purged: number;
    summaryId: string | null;
    skipped: "signing_key_unavailable" | "legal_hold" | null;
  };
}

interface AuditRow {
  id: string;
  actor: string;
  action: string;
  resource_id: string;
  request_id: string;
  timestamp: string;
  before_hash: string | null;
  after_hash: string | null;
}

interface SummaryRow {
  id: string;
  from_at: string;
  to_at: string;
  event_count: number;
  digest: string;
  previous_digest: string | null;
  signature: string;
  key_id: string;
}

interface PurgeTotals {
  at: string;
  runsPurged: number;
  auditEventsPurged: number;
}

const summarySignature = (
  subkey: Buffer,
  workspaceId: string,
  summary: {
    digest: string;
    previousDigest: string | null;
    fromAt: string;
    toAt: string;
    eventCount: number;
    keyId: string;
  },
): string =>
  createHmac("sha256", subkey)
    .update(canonicalJson({ workspaceId, ...summary }))
    .digest("hex");

export class RetentionPurgeService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly deps: { server?: ServerConfig },
  ) {}

  private get database(): PersistenceDatabase {
    return this.ctx.database;
  }

  private async signingKey(): Promise<BackupKey | null> {
    const path = this.deps.server?.security.masterKeyFile;
    if (!path) return null;
    try {
      return await readKeyFile(path, "master key");
    } catch {
      return null;
    }
  }

  private holds(): { workspace: boolean; keys: Set<string> } {
    const prefix = legalHoldPrefix(this.ctx.workspaceId);
    const keys = new Set(
      this.database
        .all<{ key: string }>(
          "SELECT key FROM operational_state WHERE (key=? OR key LIKE ?) AND value<>'released'",
          prefix,
          `${prefix}:%`,
        )
        .map((row) => row.key),
    );
    return { workspace: keys.has(prefix), keys };
  }

  /** Whether a legal hold covers the whole workspace. */
  private workspaceHeld(): boolean {
    return Boolean(
      this.database.get(
        "SELECT 1 FROM operational_state WHERE key=? AND value<>'released'",
        legalHoldPrefix(this.ctx.workspaceId),
      ),
    );
  }

  /**
   * Why a terminal Run must stay, or null when its whole subtree may go. `held` are the legal-hold
   * keys; only holds on the Run and its artifacts count here, since a hold on the workspace is
   * checked by the pass before any deletion: at its start, in each Run's delete transaction, and
   * before the receipts and audit transactions.
   */
  private blocker(runId: string, now: Date, held: Set<string>): string | null {
    const ws = this.ctx.workspaceId;
    const one = (sql: string, ...values: unknown[]): boolean =>
      Boolean(this.database.get(sql, ws, runId, ...values));
    if (held.has(`${legalHoldPrefix(ws)}:${runId}`)) return "legal_hold";
    const artifacts = this.database.all<{ id: string }>(
      "SELECT id FROM artifacts WHERE workspace_id=? AND run_id=?",
      ws,
      runId,
    );
    if (artifacts.some((artifact) => held.has(`${legalHoldPrefix(ws)}:${artifact.id}`)))
      return "legal_hold";
    if (
      one(
        "SELECT 1 FROM artifacts WHERE workspace_id=? AND run_id=? AND state IN ('available','partial')",
      )
    )
      return "artifacts_not_collected";
    if (
      one(
        "SELECT 1 FROM backup_object_holds h JOIN artifacts a ON a.workspace_id=h.workspace_id AND a.id=h.artifact_id WHERE a.workspace_id=? AND a.run_id=? AND h.expires_at>?",
        now.toISOString(),
      )
    )
      return "backup_hold";
    if (
      one(
        "SELECT 1 FROM test_revisions t JOIN artifacts a ON a.workspace_id=t.workspace_id AND a.id=t.code_artifact_id WHERE a.workspace_id=? AND a.run_id=?",
      )
    )
      return "artifact_referenced_by_revision";
    if (
      one(
        "SELECT 1 FROM outbox WHERE workspace_id=? AND aggregate_id=? AND delivery_state='pending' AND dispatchable=1",
      )
    )
      return "pending_outbox";
    if (
      one(
        "SELECT 1 FROM deliveries d JOIN outbox o ON o.workspace_id=d.workspace_id AND o.id=d.event_id WHERE d.workspace_id=? AND o.aggregate_id=? AND d.state='pending'",
      )
    )
      return "pending_delivery";
    if (
      one(
        "SELECT 1 FROM healing_proposals WHERE workspace_id=? AND (failed_run_id=? OR verification_run_id=?) AND status IN ('proposed','approved')",
        runId,
      )
    )
      return "healing_review_open";
    if (
      one(
        `SELECT 1 FROM job_leases WHERE workspace_id=? AND ${auxiliaryJobOfRun} AND state NOT IN ${settledJobStates}`,
      )
    )
      return "auxiliary_job_active";
    return null;
  }

  private deleteRun(runId: string): void {
    const ws = this.ctx.workspaceId;
    const attempts = "(SELECT id FROM attempts WHERE workspace_id=? AND run_id=?)";
    const jobs = `(SELECT id FROM job_leases WHERE workspace_id=? AND (resource_id=? OR (${settledAuxiliaryJobOfRun})))`;
    const artifactIds = this.database
      .all<{ id: string }>("SELECT id FROM artifacts WHERE workspace_id=? AND run_id=?", ws, runId)
      .map((row) => row.id);
    const statements: [string, unknown[]][] = [
      [
        "DELETE FROM healing_proposals WHERE workspace_id=? AND (failed_run_id=? OR verification_run_id=?)",
        [ws, runId, runId],
      ],
      ["DELETE FROM analyses WHERE workspace_id=? AND run_id=?", [ws, runId]],
      [
        "DELETE FROM backup_object_holds WHERE workspace_id=? AND artifact_id IN (SELECT id FROM artifacts WHERE workspace_id=? AND run_id=?)",
        [ws, ws, runId],
      ],
      ["DELETE FROM artifacts WHERE workspace_id=? AND run_id=?", [ws, runId]],
      ["DELETE FROM snapshots WHERE workspace_id=? AND run_id=?", [ws, runId]],
      [`DELETE FROM steps WHERE workspace_id=? AND attempt_id IN ${attempts}`, [ws, ws, runId]],
      [
        `DELETE FROM observations WHERE workspace_id=? AND attempt_id IN ${attempts}`,
        [ws, ws, runId],
      ],
      [
        `DELETE FROM resources WHERE workspace_id=? AND creator_attempt_id IN ${attempts}`,
        [ws, ws, runId],
      ],
      ["DELETE FROM auth_checkpoints WHERE workspace_id=? AND run_id=?", [ws, runId]],
      ["DELETE FROM variables WHERE workspace_id=? AND producer_run_id=?", [ws, runId]],
      ["DELETE FROM batch_members WHERE workspace_id=? AND run_id=?", [ws, runId]],
      [
        `DELETE FROM deliveries WHERE workspace_id=? AND event_id IN (SELECT id FROM outbox WHERE workspace_id=? AND (aggregate_id=? OR aggregate_id IN ${jobs}))`,
        [ws, ws, runId, ws, runId, runId],
      ],
      ["DELETE FROM attempts WHERE workspace_id=? AND run_id=?", [ws, runId]],
      [
        `DELETE FROM outbox WHERE workspace_id=? AND (aggregate_id=? OR aggregate_id IN ${jobs})`,
        [ws, runId, ws, runId, runId],
      ],
      [
        `DELETE FROM job_leases WHERE workspace_id=? AND (resource_id=? OR (${settledAuxiliaryJobOfRun}))`,
        [ws, runId, runId],
      ],
      ["DELETE FROM runs WHERE workspace_id=? AND id=?", [ws, runId]],
    ];
    for (const [sql, values] of statements) this.database.run(sql, ...values);
    for (const id of artifactIds)
      this.database.run(
        "DELETE FROM operational_state WHERE key=?",
        `retention:artifact:${ws}:${id}`,
      );
  }

  private grantPermit(): void {
    this.database.run(
      "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      purgePermitKey(this.ctx.workspaceId),
      new Date().toISOString(),
    );
  }

  private revokePermit(): void {
    this.database.run(
      "DELETE FROM operational_state WHERE key=?",
      purgePermitKey(this.ctx.workspaceId),
    );
  }

  /**
   * One purge pass for this workspace: terminal Runs older than the metadata window with their
   * subtrees, orphaned batches, delivered events and expired sessions, then audit events older than
   * the audit window behind a signed summary. Each Run and the audit batch commit atomically.
   */
  async run(options: PurgeOptions = {}): Promise<PurgeReport> {
    this.ctx.authorize("A");
    const ws = this.ctx.workspaceId;
    const now = options.now ?? new Date();
    const limit = options.limit ?? 200;
    const hook = options.faultHook ?? (() => undefined);
    const cutoffs = {
      metadata: new Date(now.getTime() - defaults.metadataRetentionDays * dayMs).toISOString(),
      audit: new Date(now.getTime() - defaults.auditRetentionDays * dayMs).toISOString(),
    };
    const { workspace: heldAtStart, keys } = this.holds();
    const report: PurgeReport = {
      dryRun: options.dryRun === true,
      legalHold: heldAtStart,
      cutoffs,
      runs: { eligible: 0, purged: 0, skipped: [] },
      batches: 0,
      outboxEvents: 0,
      sessions: 0,
      idempotencyReceipts: 0,
      audit: { eligible: 0, purged: 0, summaryId: null, skipped: null },
    };
    if (heldAtStart) {
      report.runs.skipped.push({ runId: "*", reason: "legal_hold" });
      report.audit.skipped = "legal_hold";
      return report;
    }
    const candidates = this.database
      .all<{ id: string; created_at: string; last: string | null }>(
        "SELECT r.id AS id, r.created_at AS created_at, MAX(a.ended_at) AS last FROM runs r LEFT JOIN attempts a ON a.workspace_id=r.workspace_id AND a.run_id=r.id WHERE r.workspace_id=? AND r.phase='completed' GROUP BY r.id,r.created_at ORDER BY r.created_at,r.id",
        ws,
      )
      .filter((row) => (row.last ?? row.created_at) < cutoffs.metadata);
    for (const candidate of candidates.slice(0, limit)) {
      const blocked = this.blocker(candidate.id, now, keys);
      if (blocked) {
        report.runs.skipped.push({ runId: candidate.id, reason: blocked });
        continue;
      }
      if (report.dryRun) {
        report.runs.eligible++;
        continue;
      }
      try {
        // The write transaction checks again, with the legal holds read again: a hold, pending
        // delivery, open review or running job that appeared since the check above keeps the Run,
        // and a hold placed on the workspace ends the pass.
        const late = this.database.withTx(() => {
          const fresh = this.holds();
          if (fresh.workspace) return workspaceHoldPlaced;
          const reason = this.blocker(candidate.id, now, fresh.keys);
          if (reason) return reason;
          this.grantPermit();
          this.deleteRun(candidate.id);
          hook("purge.run_deleted");
          this.revokePermit();
          return null;
        });
        if (late === workspaceHoldPlaced) {
          report.legalHold = true;
          report.runs.skipped.push({ runId: "*", reason: "legal_hold" });
          break;
        }
        if (late) report.runs.skipped.push({ runId: candidate.id, reason: late });
        else {
          report.runs.eligible++;
          report.runs.purged++;
        }
      } catch (error) {
        // A reference this pass did not anticipate keeps the Run; nothing is half deleted.
        if (!/foreign key/i.test(error instanceof Error ? error.message : "")) throw error;
        report.runs.skipped.push({ runId: candidate.id, reason: "referenced" });
      }
    }
    if (!report.dryRun) {
      this.database.withTx(() => {
        // A workspace hold placed while this pass ran keeps the rest of the workspace.
        if (report.legalHold || this.workspaceHeld()) {
          report.legalHold = true;
          return;
        }
        report.batches = this.deleteOrphanBatches(cutoffs.metadata);
        report.outboxEvents = this.deleteSettledEvents(cutoffs.metadata);
        report.sessions = this.database.run(
          "DELETE FROM sessions WHERE workspace_id=? AND expires_at<?",
          ws,
          cutoffs.metadata,
        ).changes;
        report.idempotencyReceipts = this.database.run(
          "DELETE FROM idempotency_receipts WHERE workspace_id=? AND expires_at<?",
          ws,
          cutoffs.metadata,
        ).changes;
      });
      hook("purge.runs_committed");
    }
    await this.purgeAudit(report, options, hook, now, limit);
    if (!report.dryRun && (report.runs.purged || report.audit.purged)) {
      const previous = stateJson<PurgeTotals>(this.database, `purge:last:${ws}`);
      this.database.run(
        "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        `purge:last:${ws}`,
        JSON.stringify({
          at: now.toISOString(),
          runsPurged: (previous?.runsPurged ?? 0) + report.runs.purged,
          auditEventsPurged: (previous?.auditEventsPurged ?? 0) + report.audit.purged,
        } satisfies PurgeTotals),
      );
    }
    return report;
  }

  private deleteOrphanBatches(cutoff: string): number {
    const ws = this.ctx.workspaceId;
    const orphans = this.database.all<{ id: string }>(
      "SELECT b.id AS id FROM batches b WHERE b.workspace_id=? AND b.created_at<? AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.workspace_id=b.workspace_id AND r.batch_id=b.id) AND NOT EXISTS(SELECT 1 FROM batch_members m WHERE m.workspace_id=b.workspace_id AND m.batch_id=b.id) AND NOT EXISTS(SELECT 1 FROM variables v WHERE v.workspace_id=b.workspace_id AND v.batch_id=b.id) AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.workspace_id=b.workspace_id AND d.batch_id=b.id)",
      ws,
      cutoff,
    );
    for (const batch of orphans) {
      this.database.run("DELETE FROM outbox WHERE workspace_id=? AND aggregate_id=?", ws, batch.id);
      this.database.run("DELETE FROM batches WHERE workspace_id=? AND id=?", ws, batch.id);
    }
    return orphans.length;
  }

  /** Delivered or dead-lettered events whose aggregate is gone and which no delivery refers to. */
  private deleteSettledEvents(cutoff: string): number {
    return this.database.run(
      "DELETE FROM outbox WHERE workspace_id=? AND created_at<? AND delivery_state IN ('delivered','dead_letter') AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.workspace_id=outbox.workspace_id AND d.event_id=outbox.id) AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.workspace_id=outbox.workspace_id AND r.id=outbox.aggregate_id) AND NOT EXISTS(SELECT 1 FROM job_leases j WHERE j.workspace_id=outbox.workspace_id AND j.id=outbox.aggregate_id) AND NOT EXISTS(SELECT 1 FROM batches b WHERE b.workspace_id=outbox.workspace_id AND b.id=outbox.aggregate_id)",
      this.ctx.workspaceId,
      cutoff,
    ).changes;
  }

  private async purgeAudit(
    report: PurgeReport,
    options: PurgeOptions,
    hook: (point: PurgePoint) => void,
    now: Date,
    limit: number,
  ): Promise<void> {
    const ws = this.ctx.workspaceId;
    if (report.legalHold) {
      report.audit.skipped = "legal_hold";
      return;
    }
    const events = this.database.all<AuditRow>(
      "SELECT id,actor,action,resource_id,request_id,timestamp,before_hash,after_hash FROM audit_events WHERE workspace_id=? AND timestamp<? ORDER BY timestamp,id LIMIT ?",
      ws,
      report.cutoffs.audit,
      Math.max(limit, 1) * 25,
    );
    report.audit.eligible = events.length;
    if (!events.length || options.dryRun) return;
    const key = await this.signingKey();
    if (!key) {
      report.audit.skipped = "signing_key_unavailable";
      return;
    }
    const subkey = deriveSubkey(key.key, "audit-purge");
    this.database.withTx(() => {
      // A workspace hold placed while this pass ran keeps the audit events.
      if (this.workspaceHeld()) {
        report.legalHold = true;
        report.audit.skipped = "legal_hold";
        return;
      }
      const previous = this.database.get<{ digest: string }>(
        "SELECT digest FROM audit_purge_summaries WHERE workspace_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
        ws,
      );
      const lines = events.map((event) =>
        canonicalJson({
          id: event.id,
          actor: event.actor,
          action: event.action,
          resourceId: event.resource_id,
          requestId: event.request_id,
          timestamp: event.timestamp,
          beforeHash: event.before_hash,
          afterHash: event.after_hash,
        }),
      );
      const previousDigest = previous?.digest ?? null;
      const digest = sha256(`${previousDigest ?? ""}\n${lines.join("\n")}`);
      const first = events[0];
      const last = events.at(-1);
      if (!first || !last) return;
      const summary = {
        digest,
        previousDigest,
        fromAt: first.timestamp,
        toAt: last.timestamp,
        eventCount: events.length,
        keyId: key.keyId,
      };
      const id = `aps_${randomUUID()}`;
      this.database.run(
        "INSERT INTO audit_purge_summaries(workspace_id,id,created_at,from_at,to_at,event_count,digest,previous_digest,signature,key_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ws,
        id,
        now.toISOString(),
        summary.fromAt,
        summary.toAt,
        summary.eventCount,
        digest,
        previousDigest,
        summarySignature(subkey, ws, summary),
        key.keyId,
      );
      hook("purge.audit_summarized");
      this.grantPermit();
      for (let index = 0; index < events.length; index += 200) {
        const chunk = events.slice(index, index + 200);
        this.database.run(
          `DELETE FROM audit_events WHERE workspace_id=? AND id IN (${chunk.map(() => "?").join(",")})`,
          ws,
          ...chunk.map((event) => event.id),
        );
      }
      hook("purge.audit_deleted");
      this.revokePermit();
      auditSecurity(this.ctx, "ops.retention.audit_purge", id, "allowed");
      report.audit.purged = events.length;
      report.audit.summaryId = id;
    });
    hook("purge.audit_committed");
  }

  /** Recomputes the chain and signatures of every audit purge summary of this workspace. */
  async verifySummaries(): Promise<{ valid: boolean; summaries: number; problems: string[] }> {
    this.ctx.authorize("R");
    const rows = this.database.all<SummaryRow>(
      "SELECT id,from_at,to_at,event_count,digest,previous_digest,signature,key_id FROM audit_purge_summaries WHERE workspace_id=? ORDER BY created_at,id",
      this.ctx.workspaceId,
    );
    const key = await this.signingKey();
    const problems: string[] = [];
    let previous: string | null = null;
    for (const row of rows) {
      if (row.previous_digest !== previous) problems.push(`${row.id}: chain broken`);
      if (!key) problems.push(`${row.id}: signing key unavailable`);
      else if (
        key.keyId !== row.key_id ||
        summarySignature(deriveSubkey(key.key, "audit-purge"), this.ctx.workspaceId, {
          digest: row.digest,
          previousDigest: row.previous_digest,
          fromAt: row.from_at,
          toAt: row.to_at,
          eventCount: Number(row.event_count),
          keyId: row.key_id,
        }) !== row.signature
      )
        problems.push(`${row.id}: signature mismatch`);
      previous = row.digest;
    }
    return { valid: problems.length === 0, summaries: rows.length, problems };
  }
}
