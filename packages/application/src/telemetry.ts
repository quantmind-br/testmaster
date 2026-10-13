import { ContractError, type SloIndicator, validate } from "@testmaster/contracts";
import type { AlertsService } from "./alerts.js";
import type { ServiceContext } from "./context.js";
import { type OperationsService, stateJson } from "./operations.js";
import type { ServerConfig } from "./server-config.js";

/** Histogram upper bounds (seconds) for API latency. */
export const apiLatencyBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;
/** Histogram upper bounds (seconds) for the wait between admission and the first attempt. */
export const queueWaitBuckets = [1, 5, 15, 30, 60, 120, 300, 600, 1800] as const;

/** Rolling SLO window; indicators cover the last 30 days of Runs. */
const sloWindowDays = 30;
const dayMs = 86_400_000;

export interface ApiSample {
  workspaceId: string;
  method: string;
  /** Catalog path template, never a raw URL, so identifiers never become label values. */
  route: string;
  status: number;
  seconds: number;
}

interface WorkspaceApiMetrics {
  requests: Map<string, number>;
  buckets: number[];
  sum: number;
  count: number;
  errors5xx: number;
}

/**
 * In-process API counters since server start. Only API responses count: a Run that ends in a
 * target timeout never produces an API error, so target behaviour cannot consume the API budget.
 */
export class ApiMetrics {
  readonly since = new Date();
  private readonly workspaces = new Map<string, WorkspaceApiMetrics>();

  record(sample: ApiSample): void {
    let entry = this.workspaces.get(sample.workspaceId);
    if (!entry) {
      entry = {
        requests: new Map(),
        buckets: apiLatencyBuckets.map(() => 0),
        sum: 0,
        count: 0,
        errors5xx: 0,
      };
      this.workspaces.set(sample.workspaceId, entry);
    }
    const key = `${sample.method}\u0000${sample.route}\u0000${Math.floor(sample.status / 100)}xx`;
    entry.requests.set(key, (entry.requests.get(key) ?? 0) + 1);
    apiLatencyBuckets.forEach((bound, index) => {
      if (sample.seconds <= bound) entry.buckets[index] = (entry.buckets[index] ?? 0) + 1;
    });
    entry.sum += sample.seconds;
    entry.count++;
    if (sample.status >= 500) entry.errors5xx++;
  }

  snapshot(workspaceId: string): {
    requests: { method: string; route: string; statusClass: string; count: number }[];
    buckets: number[];
    sum: number;
    count: number;
    errors5xx: number;
  } {
    const entry = this.workspaces.get(workspaceId);
    if (!entry)
      return {
        requests: [],
        buckets: apiLatencyBuckets.map(() => 0),
        sum: 0,
        count: 0,
        errors5xx: 0,
      };
    return {
      requests: [...entry.requests].map(([key, count]) => {
        const [method = "", route = "", statusClass = ""] = key.split("\u0000");
        return { method, route, statusClass, count };
      }),
      buckets: [...entry.buckets],
      sum: entry.sum,
      count: entry.count,
      errors5xx: entry.errors5xx,
    };
  }
}

export interface TelemetryDeps {
  metrics: ApiMetrics;
  server?: ServerConfig;
  operations(): OperationsService;
  alerts(): AlertsService;
}

interface DurationRow {
  seconds: number;
}

/** Reasons a Run ended because of the system under test; never charged to platform or API budgets. */
export const targetReasonCodes = [
  "assertion_timeout",
  "attempt_timeout",
  "execution_timeout",
  "assertion_mismatch",
  "target_unreachable",
];

const quantile = (values: number[], fraction: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? null;
};

const histogram = (values: number[], bounds: readonly number[]): { le: number; count: number }[] =>
  bounds.map((le) => ({ le, count: values.filter((value) => value <= le).length }));

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export class TelemetryService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly deps: TelemetryDeps,
  ) {}

  get enabled(): boolean {
    return this.deps.server?.telemetry?.metrics === true;
  }

  private count(sql: string, ...values: unknown[]): number {
    return Number(this.ctx.database.get(sql, this.ctx.workspaceId, ...values)?.n ?? 0);
  }

  /** SLO indicators of this workspace; proposed targets are reported next to, never instead of, observations. */
  slo(now: Date = new Date()): {
    generatedAt: string;
    workspaceId: string;
    indicators: SloIndicator[];
  } {
    this.ctx.authorize("R");
    const since = new Date(now.getTime() - sloWindowDays * dayMs).toISOString();
    const window = `${sloWindowDays}d`;
    const api = this.deps.metrics.snapshot(this.ctx.workspaceId);
    const indicators: SloIndicator[] = [];
    const base = {
      window,
      buckets: [] as { le: number; count: number }[],
      errorBudgetRemaining: null as number | null,
    };
    const ratio = (
      id: string,
      title: string,
      proposedTarget: number,
      numerator: number,
      denominator: number,
      notes: string,
      windowLabel = window,
    ): SloIndicator => {
      const observed = denominator > 0 ? numerator / denominator : null;
      const allowedFailures = (1 - proposedTarget) * denominator;
      return validate<SloIndicator>("SloIndicator", {
        id,
        title,
        unit: "ratio",
        ...base,
        window: windowLabel,
        proposedTarget,
        observed,
        measurement: denominator > 0 ? "measured" : "not_measured",
        numerator: denominator > 0 ? numerator : null,
        denominator,
        errorBudgetRemaining:
          denominator > 0 && allowedFailures > 0
            ? (allowedFailures - (denominator - numerator)) / allowedFailures
            : null,
        notes,
      });
    };
    const latency = (
      id: string,
      title: string,
      proposedTarget: number,
      values: number[],
      bounds: readonly number[],
      windowLabel: string,
      notes: string,
    ): SloIndicator =>
      validate<SloIndicator>("SloIndicator", {
        id,
        title,
        unit: "seconds",
        window: windowLabel,
        proposedTarget,
        observed: quantile(values, 0.95),
        measurement: values.length ? "measured" : "not_measured",
        numerator: null,
        denominator: values.length,
        buckets: histogram(values, bounds),
        errorBudgetRemaining: null,
        notes,
      });

    indicators.push(
      ratio(
        "api_availability",
        "API availability",
        0.999,
        api.count - api.errors5xx,
        api.count,
        "Responses that are not 5xx over all API responses since server start. Run outcomes, target timeouts and 4xx refusals are not API errors.",
        "since_start",
      ),
    );
    const apiValues: number[] = [];
    api.buckets.forEach((cumulative, index) => {
      const previous = index === 0 ? 0 : (api.buckets[index - 1] ?? 0);
      for (let n = 0; n < cumulative - previous; n++) apiValues.push(apiLatencyBuckets[index] ?? 0);
    });
    const slow = api.count - (api.buckets.at(-1) ?? 0);
    for (let n = 0; n < slow; n++) apiValues.push((apiLatencyBuckets.at(-1) ?? 10) * 2);
    indicators.push(
      latency(
        "api_latency_p95",
        "API latency p95",
        0.5,
        apiValues,
        apiLatencyBuckets,
        "since_start",
        "95th percentile of API response time, estimated from histogram bucket upper bounds.",
      ),
    );
    const waits = this.ctx.database
      .all<DurationRow>(
        "SELECT (julianday(a.started_at)-julianday(r.created_at))*86400.0 AS seconds FROM attempts a JOIN runs r ON r.workspace_id=a.workspace_id AND r.id=a.run_id WHERE a.workspace_id=? AND a.number=1 AND a.started_at IS NOT NULL AND r.created_at>=?",
        this.ctx.workspaceId,
        since,
      )
      .map((row) => Math.max(0, Number(row.seconds)));
    indicators.push(
      latency(
        "queue_wait_p95",
        "Queue wait p95",
        60,
        waits,
        queueWaitBuckets,
        window,
        "Seconds from Run admission to the first attempt start.",
      ),
    );
    const terminal = this.count(
      "SELECT COUNT(*) AS n FROM runs WHERE workspace_id=? AND phase='completed' AND outcome NOT IN ('cancelled') AND created_at>=?",
      since,
    );
    const targetCaused = this.count(
      `SELECT COUNT(DISTINCT r.id) AS n FROM runs r JOIN outbox o ON o.workspace_id=r.workspace_id AND o.aggregate_id=r.id AND o.type='run.completed' WHERE r.workspace_id=? AND r.phase='completed' AND r.outcome NOT IN ('cancelled') AND r.created_at>=? AND json_extract(o.data_json,'$.reasonCode') IN (${targetReasonCodes.map((code) => `'${code}'`).join(",")})`,
      since,
    );
    const platformLoss = this.count(
      `SELECT COUNT(DISTINCT r.id) AS n FROM runs r JOIN outbox o ON o.workspace_id=r.workspace_id AND o.aggregate_id=r.id AND o.type='attempt.lease_expired' WHERE r.workspace_id=? AND r.phase='completed' AND r.outcome='inconclusive' AND r.created_at>=?`,
      since,
    );
    const measurable = terminal - targetCaused;
    indicators.push(
      ratio(
        "run_platform_success",
        "Run platform success",
        0.99,
        Math.max(0, measurable - platformLoss),
        measurable,
        "Terminal Runs that did not end inconclusive because of a lost lease. Cancelled Runs and Runs that ended because of the target (timeouts, assertion mismatch) are excluded from numerator and denominator.",
      ),
    );
    const available = this.count(
      "SELECT COUNT(*) AS n FROM artifacts WHERE workspace_id=? AND state='available'",
    );
    const missing = this.count(
      "SELECT COUNT(*) AS n FROM artifacts WHERE workspace_id=? AND state IN ('missing','partial')",
    );
    indicators.push(
      ratio(
        "evidence_availability",
        "Evidence availability",
        0.9999,
        available,
        available + missing,
        "Artifacts recorded available over artifacts that should be available (expired by retention are excluded).",
        "current",
      ),
    );
    const lastAt = stateJson<{ at?: string }>(this.ctx.database, "backup:last-success")?.at;
    const configured = this.deps.server?.backup !== undefined;
    const age = lastAt ? (now.getTime() - Date.parse(lastAt)) / 1000 : null;
    indicators.push(
      validate<SloIndicator>("SloIndicator", {
        id: "backup_freshness",
        title: "Backup freshness",
        unit: "seconds",
        window: "current",
        proposedTarget: 86400,
        observed: configured ? age : null,
        measurement: configured && age !== null ? "measured" : "not_measured",
        numerator: null,
        denominator: configured && age !== null ? 1 : 0,
        buckets: [],
        errorBudgetRemaining: null,
        notes: "Age of the newest verified server backup.",
      }),
    );
    return { generatedAt: now.toISOString(), workspaceId: this.ctx.workspaceId, indicators };
  }

  /** Prometheus text exposition of the caller's own workspace; there are no tenant-identifying labels. */
  metricsText(): string {
    this.ctx.authorize("R");
    if (!this.enabled)
      throw new ContractError("POLICY_DENIED", "Metrics are disabled by telemetry policy", {
        reasonCode: "metrics_disabled",
      });
    const lines: string[] = [];
    const metric = (name: string, help: string, type: "counter" | "gauge" | "histogram"): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    };
    const api = this.deps.metrics.snapshot(this.ctx.workspaceId);
    metric(
      "testmaster_api_requests_total",
      "API responses by method, route template and status class.",
      "counter",
    );
    for (const row of api.requests)
      lines.push(
        `testmaster_api_requests_total{method="${escapeLabel(row.method)}",route="${escapeLabel(row.route)}",status_class="${row.statusClass}"} ${row.count}`,
      );
    metric("testmaster_api_request_duration_seconds", "API response time.", "histogram");
    apiLatencyBuckets.forEach((bound, index) => {
      lines.push(
        `testmaster_api_request_duration_seconds_bucket{le="${bound}"} ${api.buckets[index] ?? 0}`,
      );
    });
    lines.push(
      `testmaster_api_request_duration_seconds_bucket{le="+Inf"} ${api.count}`,
      `testmaster_api_request_duration_seconds_sum ${api.sum}`,
      `testmaster_api_request_duration_seconds_count ${api.count}`,
    );
    const status = this.deps.operations().status();
    metric("testmaster_runs_active", "Runs that are not terminal.", "gauge");
    lines.push(`testmaster_runs_active ${status.work.activeRuns}`);
    metric("testmaster_queue_depth", "Queued dispatchable jobs.", "gauge");
    lines.push(`testmaster_queue_depth ${status.work.queuedJobs}`);
    const oldest = this.ctx.database.get(
      "SELECT MIN(available_at) AS oldest FROM job_leases WHERE workspace_id=? AND state='queued' AND dispatchable=1 AND queue='local'",
      this.ctx.workspaceId,
    )?.oldest;
    metric("testmaster_queue_oldest_age_seconds", "Age of the oldest queued job.", "gauge");
    lines.push(
      `testmaster_queue_oldest_age_seconds ${typeof oldest === "string" ? Math.max(0, (Date.now() - Date.parse(oldest)) / 1000) : 0}`,
    );
    metric("testmaster_workers", "Workers by state.", "gauge");
    for (const row of this.ctx.database.all<{ state: string; n: number }>(
      "SELECT state,COUNT(*) AS n FROM workers WHERE workspace_id=? GROUP BY state",
      this.ctx.workspaceId,
    ))
      lines.push(`testmaster_workers{state="${escapeLabel(row.state)}"} ${Number(row.n)}`);
    metric("testmaster_artifacts", "Artifacts by state.", "gauge");
    for (const row of this.ctx.database.all<{ state: string; n: number }>(
      "SELECT state,COUNT(*) AS n FROM artifacts WHERE workspace_id=? GROUP BY state",
      this.ctx.workspaceId,
    ))
      lines.push(`testmaster_artifacts{state="${escapeLabel(row.state)}"} ${Number(row.n)}`);
    metric("testmaster_alerts_firing", "Open alerts by rule.", "gauge");
    for (const alert of this.deps.alerts().list())
      if (alert.state !== "resolved")
        lines.push(`testmaster_alerts_firing{rule="${escapeLabel(alert.rule)}"} 1`);
    metric("testmaster_dlq_entries", "Dead-lettered entries awaiting an operator.", "gauge");
    lines.push(`testmaster_dlq_entries ${this.deps.operations().dlq().length}`);
    metric(
      "testmaster_backup_last_success_timestamp_seconds",
      "Unix time of the newest successful backup.",
      "gauge",
    );
    lines.push(
      `testmaster_backup_last_success_timestamp_seconds ${status.backup.lastSuccessAt ? Math.floor(Date.parse(status.backup.lastSuccessAt) / 1000) : 0}`,
    );
    return `${lines.join("\n")}\n`;
  }
}
