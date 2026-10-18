import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { type AlertRuleView, type AlertView, ContractError, validate } from "@testmaster/contracts";
import {
  AuditRepository,
  OutboxRepository,
  type PersistenceDatabase,
} from "@testmaster/persistence";
import { authoringTransaction } from "./authoring.js";
import type { ServiceContext } from "./context.js";
import { type OperationsService, stateJson } from "./operations.js";
import type { ServerConfig } from "./server-config.js";

/** Alert rules of OPS-028: every rule has an owner and a runbook section in docs/operations/alerts.md. */
type Severity = AlertRuleView["severity"];
type Owner = "platform-operator" | "security-owner" | "workspace-admin";

export interface Finding {
  /** Distinguishes simultaneous alerts of one rule (a project id, a path); empty for singletons. */
  subject: string;
  summary: string;
  detail: Record<string, unknown>;
}

/** Overrides for synthetic tests and for hosts whose probes differ from the defaults. */
export interface AlertProbes {
  now?: Date;
  storageUsedFraction?: () => Promise<number>;
  auditWritable?: () => boolean;
}

interface Environment {
  database: PersistenceDatabase;
  workspaceId: string;
  dataDir: string;
  server: ServerConfig | undefined;
  now: Date;
  probes: AlertProbes;
  operations: OperationsService;
  liveWorker: () => boolean;
}

interface RuleDefinition extends Omit<AlertRuleView, "id" | "runbook"> {
  owner: Owner;
  find(environment: Environment): Finding[] | Promise<Finding[]>;
}

const minute = 60_000;
export const queueAgeThresholdSeconds = 300;
export const storageWarningFraction = 0.8;
export const storageCriticalFraction = 0.9;
export const leaseExpirationThreshold = { count: 3, windowMinutes: 15 };
export const backupStaleHours = 26;

const count = (environment: Environment, sql: string, ...values: unknown[]): number =>
  Number(environment.database.get(sql, environment.workspaceId, ...values)?.n ?? 0);

const sinceIso = (environment: Environment, minutes: number): string =>
  new Date(environment.now.getTime() - minutes * minute).toISOString();

async function storageUsed(environment: Environment): Promise<number> {
  if (environment.probes.storageUsedFraction) return environment.probes.storageUsedFraction();
  const storage = await statfs(environment.dataDir);
  return 1 - Number(storage.bavail) / Number(storage.blocks);
}

function auditProbe(environment: Environment): boolean {
  if (environment.probes.auditWritable) return environment.probes.auditWritable();
  const marker = new Error("audit probe rollback");
  try {
    environment.database.get(
      "SELECT id FROM audit_events WHERE workspace_id=? LIMIT 1",
      environment.workspaceId,
    );
    environment.database.withTx(() => {
      new AuditRepository(environment.database).append({
        workspaceId: environment.workspaceId,
        actor: "system:alerts",
        action: "alert.audit_probe",
        resourceId: environment.workspaceId,
        requestId: randomUUID(),
        timestamp: environment.now.toISOString(),
        beforeHash: null,
        afterHash: null,
      });
      throw marker;
    });
  } catch (error) {
    return error === marker;
  }
  return true;
}

const storageFinding = (fraction: number, used: number, subject = "data-dir"): Finding => ({
  subject,
  summary: `Evidence storage is ${Math.floor(used * 100)}% full`,
  detail: { usedFraction: used, thresholdFraction: fraction },
});

export const alertRuleCatalog: Record<string, RuleDefinition> = {
  lease_expirations_abnormal: {
    title: "Abnormal lease expirations",
    severity: "high",
    owner: "platform-operator",
    description: `At least ${leaseExpirationThreshold.count} attempts lost their lease within ${leaseExpirationThreshold.windowMinutes} minutes.`,
    threshold: leaseExpirationThreshold,
    find(environment) {
      const expired = count(
        environment,
        "SELECT COUNT(*) AS n FROM outbox WHERE workspace_id=? AND type='attempt.lease_expired' AND created_at>=?",
        sinceIso(environment, leaseExpirationThreshold.windowMinutes),
      );
      return expired >= leaseExpirationThreshold.count
        ? [
            {
              subject: "",
              summary: `${expired} attempt leases expired in ${leaseExpirationThreshold.windowMinutes} minutes`,
              detail: { expired, ...leaseExpirationThreshold },
            },
          ]
        : [];
    },
  },
  queue_age_high: {
    title: "Oldest queued job is waiting too long",
    severity: "high",
    owner: "platform-operator",
    description: `A dispatchable job waited more than ${queueAgeThresholdSeconds} seconds while a worker is alive.`,
    threshold: { seconds: queueAgeThresholdSeconds },
    find(environment) {
      if (!environment.liveWorker()) return [];
      const oldest = environment.database.get(
        "SELECT MIN(available_at) AS oldest FROM job_leases WHERE workspace_id=? AND state='queued' AND dispatchable=1 AND queue='local' AND available_at<=?",
        environment.workspaceId,
        environment.now.toISOString(),
      )?.oldest;
      if (typeof oldest !== "string") return [];
      const age = (environment.now.getTime() - Date.parse(oldest)) / 1000;
      return age > queueAgeThresholdSeconds
        ? [
            {
              subject: "",
              summary: `Oldest queued job has waited ${Math.floor(age)} seconds`,
              detail: { ageSeconds: Math.floor(age), threshold: queueAgeThresholdSeconds },
            },
          ]
        : [];
    },
  },
  storage_warning: {
    title: "Evidence storage above the warning watermark",
    severity: "medium",
    owner: "platform-operator",
    description: "Used storage reached 80% but is below the 90% critical watermark.",
    threshold: { fraction: storageWarningFraction },
    async find(environment) {
      const used = await storageUsed(environment);
      return used >= storageWarningFraction && used < storageCriticalFraction
        ? [storageFinding(storageWarningFraction, used)]
        : [];
    },
  },
  storage_critical: {
    title: "Evidence storage above the critical watermark",
    severity: "critical",
    owner: "platform-operator",
    description:
      "Used storage reached 90%. Runs are still admitted while the free space holds their worst-case evidence; plan more space before admission refuses them.",
    threshold: { fraction: storageCriticalFraction },
    async find(environment) {
      const used = await storageUsed(environment);
      return used >= storageCriticalFraction ? [storageFinding(storageCriticalFraction, used)] : [];
    },
  },
  backup_failing: {
    title: "Server backups keep failing",
    severity: "high",
    owner: "platform-operator",
    description: `Backups are configured, the last attempt failed and no backup succeeded in ${backupStaleHours} hours.`,
    threshold: { hours: backupStaleHours },
    find(environment) {
      if (!environment.server?.backup || environment.server.backup.schedule === "disabled")
        return [];
      const failure = stateJson<{ at?: string }>(environment.database, "backup:last-failure");
      const success = stateJson<{ at?: string }>(environment.database, "backup:last-success");
      if (!failure?.at) return [];
      const successAt = success?.at ? Date.parse(success.at) : 0;
      const stale = environment.now.getTime() - successAt > backupStaleHours * 60 * minute;
      return Date.parse(failure.at) > successAt && stale
        ? [
            {
              subject: "",
              summary: "Backups failed and none succeeded recently",
              detail: { lastFailureAt: failure.at, lastSuccessAt: success?.at ?? null },
            },
          ]
        : [];
    },
  },
  dlq_not_empty: {
    title: "Dead-letter queue is not empty",
    severity: "medium",
    owner: "workspace-admin",
    description: "At least one delivery or auxiliary job exhausted its retries.",
    threshold: { entries: 1 },
    find(environment) {
      const entries = environment.operations.dlq();
      return entries.length
        ? [
            {
              subject: "",
              summary: `${entries.length} dead-lettered entries wait for an operator`,
              detail: {
                entries: entries.length,
                sources: [...new Set(entries.map((entry) => entry.source))],
              },
            },
          ]
        : [];
    },
  },
  audit_unavailable: {
    title: "Audit log cannot be read or written",
    severity: "critical",
    owner: "security-owner",
    description: "A read or a rolled-back write probe against the audit log failed.",
    threshold: { probe: "read+write" },
    find(environment) {
      return auditProbe(environment)
        ? []
        : [
            {
              subject: "",
              summary: "Audit log probe failed; security-relevant actions are not being recorded",
              detail: {},
            },
          ];
    },
  },
  cancellation_stuck: {
    title: "Cancellation requested but the Run keeps going",
    severity: "high",
    owner: "platform-operator",
    description: `A cancel request is older than ${queueAgeThresholdSeconds} seconds, the Run is not terminal and a worker is alive.`,
    threshold: { seconds: queueAgeThresholdSeconds },
    find(environment) {
      if (!environment.liveWorker()) return [];
      return environment.database
        .all<{ run_id: string; requested: string }>(
          "SELECT o.aggregate_id AS run_id, MIN(o.created_at) AS requested FROM outbox o JOIN runs r ON r.workspace_id=o.workspace_id AND r.id=o.aggregate_id WHERE o.workspace_id=? AND o.type='run.cancel_requested' AND r.phase<>'completed' AND o.created_at<=? GROUP BY o.aggregate_id",
          environment.workspaceId,
          new Date(environment.now.getTime() - queueAgeThresholdSeconds * 1000).toISOString(),
        )
        .map((row) => ({
          subject: row.run_id,
          summary: "Cancel request has not been honoured",
          detail: { runId: row.run_id, requestedAt: row.requested },
        }));
    },
  },
  tenant_violation: {
    title: "Cross-tenant request refused",
    severity: "critical",
    owner: "security-owner",
    description: "A credential tried to act on another workspace within the last 15 minutes.",
    threshold: { count: 1, windowMinutes: 15 },
    find(environment) {
      const refused = count(
        environment,
        "SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id=? AND action='tenant.violation.denied' AND timestamp>=?",
        sinceIso(environment, 15),
      );
      return refused
        ? [
            {
              subject: "",
              summary: `${refused} cross-tenant requests were refused`,
              detail: { refused, windowMinutes: 15 },
            },
          ]
        : [];
    },
  },
  egress_denied: {
    title: "Sandbox egress denied",
    severity: "high",
    owner: "security-owner",
    description: "A Run was blocked by the egress policy within the last 15 minutes.",
    threshold: { count: 1, windowMinutes: 15 },
    find(environment) {
      const denied = count(
        environment,
        "SELECT COUNT(DISTINCT aggregate_id) AS n FROM outbox WHERE workspace_id=? AND type IN ('run.completed','run.execution_error') AND created_at>=? AND json_extract(data_json,'$.reasonCode')='egress_denied'",
        sinceIso(environment, 15),
      );
      return denied
        ? [
            {
              subject: "",
              summary: `${denied} Runs were blocked by the egress policy`,
              detail: { denied, windowMinutes: 15 },
            },
          ]
        : [];
    },
  },
};

interface AlertRow {
  id: string;
  workspace_id: string;
  created_at: string;
  version: number;
  data_json: string;
  rule: string;
  subject: string;
  severity: Severity;
  state: AlertView["state"];
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

interface AlertData {
  summary: string;
  detail: Record<string, unknown>;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
}

const columns =
  "id,workspace_id,created_at,version,data_json,rule,subject,severity,state,first_seen_at,last_seen_at,resolved_at";

const runbook = (rule: string): string => `docs/operations/alerts.md#${rule}`;

export function alertRules(): AlertRuleView[] {
  return Object.entries(alertRuleCatalog).map(([id, rule]) =>
    validate<AlertRuleView>("AlertRuleView", {
      id,
      title: rule.title,
      severity: rule.severity,
      owner: rule.owner,
      runbook: runbook(id),
      description: rule.description,
      threshold: rule.threshold,
    }),
  );
}

export interface AlertsDeps {
  server?: ServerConfig;
  dataDir: string;
  operations(): OperationsService;
  liveWorker(): boolean;
}

export class AlertsService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly deps: AlertsDeps,
  ) {}

  rules(): AlertRuleView[] {
    this.ctx.authorize("R");
    return alertRules();
  }

  private view(row: AlertRow): AlertView {
    const data = JSON.parse(row.data_json) as AlertData;
    const definition = alertRuleCatalog[row.rule];
    return validate<AlertView>("Alert", {
      id: row.id,
      workspaceId: row.workspace_id,
      rule: row.rule,
      subject: row.subject,
      severity: row.severity,
      state: row.state,
      summary: data.summary,
      detail: data.detail,
      owner: definition?.owner ?? "platform-operator",
      runbook: runbook(row.rule),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      resolvedAt: row.resolved_at,
      acknowledgedBy: data.acknowledgedBy,
      acknowledgedAt: data.acknowledgedAt,
      createdAt: row.created_at,
      version: Number(row.version),
    });
  }

  list(filter: { state?: AlertView["state"] } = {}): AlertView[] {
    this.ctx.authorize("R");
    return this.ctx.database
      .all<AlertRow>(
        `SELECT ${columns} FROM alerts WHERE workspace_id=? AND (? IS NULL OR state=?) ORDER BY last_seen_at DESC,id DESC LIMIT 500`,
        this.ctx.workspaceId,
        filter.state ?? null,
        filter.state ?? null,
      )
      .map((row) => this.view(row));
  }

  acknowledge(id: string): AlertView {
    this.ctx.authorize("A");
    return authoringTransaction(this.ctx, () => {
      const row = this.ctx.database.get<AlertRow>(
        `SELECT ${columns} FROM alerts WHERE workspace_id=? AND id=?`,
        this.ctx.workspaceId,
        id,
      );
      if (!row) throw new ContractError("NOT_FOUND", "Alert does not exist", { id });
      if (row.state !== "firing")
        throw new ContractError("PRECONDITION_FAILED", "Only a firing alert can be acknowledged", {
          state: row.state,
        });
      const now = new Date().toISOString();
      const data = JSON.parse(row.data_json) as AlertData;
      this.ctx.database.run(
        "UPDATE alerts SET state='acknowledged',version=version+1,data_json=? WHERE workspace_id=? AND id=?",
        JSON.stringify({ ...data, acknowledgedBy: this.ctx.principalId, acknowledgedAt: now }),
        this.ctx.workspaceId,
        id,
      );
      new AuditRepository(this.ctx.database).append({
        workspaceId: this.ctx.workspaceId,
        actor: this.ctx.principalId,
        action: "alert.acknowledge.allowed",
        resourceId: id,
        requestId: this.ctx.correlationId ?? randomUUID(),
        timestamp: now,
        beforeHash: null,
        afterHash: null,
      });
      return this.view({
        ...row,
        state: "acknowledged",
        data_json: JSON.stringify({
          ...data,
          acknowledgedBy: this.ctx.principalId,
          acknowledgedAt: now,
        }),
        version: row.version + 1,
      });
    });
  }

  /**
   * Evaluates every rule once for this workspace: opens alerts for new findings (with one
   * `alert.fired` outbox event each), refreshes alerts that still hold and resolves those that
   * cleared. A rule that throws is reported and skipped; it never hides the other rules.
   */
  async evaluate(
    probes: AlertProbes = {},
  ): Promise<{ fired: AlertView[]; resolved: string[]; errors: Record<string, string> }> {
    this.ctx.authorize("A");
    const environment: Environment = {
      database: this.ctx.database,
      workspaceId: this.ctx.workspaceId,
      dataDir: this.deps.dataDir,
      server: this.deps.server,
      now: probes.now ?? new Date(),
      probes,
      operations: this.deps.operations(),
      liveWorker: this.deps.liveWorker,
    };
    const findings = new Map<string, Finding[]>();
    const errors: Record<string, string> = {};
    for (const [rule, definition] of Object.entries(alertRuleCatalog))
      try {
        findings.set(rule, await definition.find(environment));
      } catch (error) {
        errors[rule] = error instanceof Error ? error.message : String(error);
      }
    const fired: AlertView[] = [];
    const resolved: string[] = [];
    this.ctx.database.withTx(() => {
      const nowIso = environment.now.toISOString();
      const open = this.ctx.database.all<AlertRow>(
        `SELECT ${columns} FROM alerts WHERE workspace_id=? AND state<>'resolved'`,
        this.ctx.workspaceId,
      );
      const seen = new Set<string>();
      for (const [rule, ruleFindings] of findings)
        for (const finding of ruleFindings) {
          const key = `${rule}\u0000${finding.subject}`;
          seen.add(key);
          const existing = open.find((row) => row.rule === rule && row.subject === finding.subject);
          const previous = existing ? (JSON.parse(existing.data_json) as AlertData) : null;
          const data: AlertData = {
            summary: finding.summary,
            detail: finding.detail,
            acknowledgedBy: previous?.acknowledgedBy ?? null,
            acknowledgedAt: previous?.acknowledgedAt ?? null,
          };
          if (existing) {
            this.ctx.database.run(
              "UPDATE alerts SET last_seen_at=?,version=version+1,data_json=? WHERE workspace_id=? AND id=?",
              nowIso,
              JSON.stringify(data),
              this.ctx.workspaceId,
              existing.id,
            );
            continue;
          }
          const definition = alertRuleCatalog[rule];
          if (!definition) continue;
          const id = `alr_${randomUUID()}`;
          this.ctx.database.run(
            "INSERT INTO alerts(workspace_id,id,created_at,data_json,rule,subject,severity,state,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?,'firing',?,?)",
            this.ctx.workspaceId,
            id,
            nowIso,
            JSON.stringify(data),
            rule,
            finding.subject,
            definition.severity,
            nowIso,
            nowIso,
          );
          new OutboxRepository(this.ctx.database).append(this.ctx.workspaceId, id, "alert.fired", {
            alertId: id,
            rule,
            severity: definition.severity,
            projectId: finding.subject.startsWith("prj_") ? finding.subject : null,
          });
          new AuditRepository(this.ctx.database).append({
            workspaceId: this.ctx.workspaceId,
            actor: this.ctx.principalId || "system:alerts",
            action: "alert.fired.allowed",
            resourceId: id,
            requestId: this.ctx.correlationId ?? randomUUID(),
            timestamp: nowIso,
            beforeHash: null,
            afterHash: null,
          });
          fired.push(
            this.view({
              id,
              workspace_id: this.ctx.workspaceId,
              created_at: nowIso,
              version: 1,
              data_json: JSON.stringify(data),
              rule,
              subject: finding.subject,
              severity: definition.severity,
              state: "firing",
              first_seen_at: nowIso,
              last_seen_at: nowIso,
              resolved_at: null,
            }),
          );
        }
      for (const row of open) {
        // A rule that failed to evaluate keeps its alerts open: absence of evidence is not recovery.
        if (seen.has(`${row.rule}\u0000${row.subject}`) || !findings.has(row.rule)) continue;
        this.ctx.database.run(
          "UPDATE alerts SET state='resolved',resolved_at=?,version=version+1 WHERE workspace_id=? AND id=?",
          nowIso,
          this.ctx.workspaceId,
          row.id,
        );
        resolved.push(row.id);
      }
    });
    return { fired, resolved, errors };
  }
}
