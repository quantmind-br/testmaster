import { ContractError, type SloIndicator, validate } from "@testmaster/contracts";
import type { PersistenceDatabase } from "@testmaster/persistence";
import type { AlertsService } from "./alerts.js";
import type { ServiceContext } from "./context.js";
import { CONTROLLER_LIVE_MS, liveControllers } from "./controller-instances.js";
import { readLease, SCHEDULER_LEASE_MS } from "./controller-leases.js";
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

/** Counter name of one workspace's API metric in `controller_metrics`; the workspace id is part of the name. */
const apiCounter = (metric: string, workspaceId: string): string => `api.${metric}|${workspaceId}`;
/** Deployment-wide counters of the artifact gateway: they have no workspace because a signed link names none. */
const gatewayRequests = "gateway.requests";
const gatewayErrors = "gateway.errors5xx";
/** True for the routes that stream artifact bytes; only their answers feed `artifact_gateway_availability`. */
export const isGatewayRoute = (method: string, route: string): boolean =>
  method === "GET" && /^\/v1\/artifacts\/:id(?:\/content)?$/u.test(route);

/**
 * In-process API counters since server start. Only API responses count: a Run that ends in a
 * target timeout never produces an API error, so target behaviour cannot consume the API budget.
 * The same events also accumulate in `pending`, which `flushApiMetrics` drains into
 * `controller_metrics` so every controller's counters reach the SLO report (ADR-035).
 */
export class ApiMetrics {
  readonly since = new Date();
  private readonly workspaces = new Map<string, WorkspaceApiMetrics>();
  private pending = new Map<string, number>();

  private bump(name: string, amount: number): void {
    this.pending.set(name, (this.pending.get(name) ?? 0) + amount);
  }

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
      if (sample.seconds <= bound) {
        entry.buckets[index] = (entry.buckets[index] ?? 0) + 1;
        this.bump(apiCounter(`bucket.${index}`, sample.workspaceId), 1);
      }
    });
    entry.sum += sample.seconds;
    entry.count++;
    this.bump(apiCounter("sum", sample.workspaceId), sample.seconds);
    this.bump(apiCounter("count", sample.workspaceId), 1);
    if (sample.status >= 500) {
      entry.errors5xx++;
      this.bump(apiCounter("errors5xx", sample.workspaceId), 1);
    }
  }

  /** One artifact download answered by this controller; `status` is the HTTP status it sent. */
  recordGateway(status: number): void {
    this.bump(gatewayRequests, 1);
    if (status >= 500) this.bump(gatewayErrors, 1);
  }

  /** Counters since the last flush, then forgets them. */
  drain(): Map<string, number> {
    const drained = this.pending;
    this.pending = new Map();
    return drained;
  }

  /** Puts drained counters back after a failed flush, so no event is lost. */
  restore(drained: ReadonlyMap<string, number>): void {
    for (const [name, amount] of drained) this.bump(name, amount);
  }

  /** Counters not yet flushed; the SLO report adds them to the rows other flushes wrote. */
  unflushed(name: string): number {
    return this.pending.get(name) ?? 0;
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

const hourMs = 3_600_000;

/**
 * Writes the counters accumulated since the last flush into the row of the current hour (adding to
 * it), so a minute-by-minute flush keeps the table to one row per controller, metric and hour. A
 * failed write puts the counters back and rethrows.
 */
export function flushApiMetrics(
  database: PersistenceDatabase,
  controllerId: string,
  metrics: ApiMetrics,
  nowMs: number = Date.now(),
): void {
  const drained = metrics.drain();
  if (!drained.size) return;
  const windowStart = new Date(Math.floor(nowMs / hourMs) * hourMs).toISOString();
  try {
    database.withTx(() => {
      for (const [name, value] of drained)
        database.run(
          "INSERT INTO controller_metrics(controller_id,window_start,name,value) VALUES(?,?,?,?) ON CONFLICT(controller_id,window_start,name) DO UPDATE SET value=controller_metrics.value+excluded.value",
          controllerId,
          windowStart,
          name,
          value,
        );
    });
  } catch (error) {
    metrics.restore(drained);
    throw error;
  }
}

/**
 * Sums the named counters across the live controllers' flushed rows (and this process's own), plus
 * what this process has not flushed yet. A stopped or silent controller's rows are left out, as its
 * in-memory counters were before the table existed. `sinceWindow` leaves out hour windows that
 * started before it.
 */
function sumCounters(
  database: PersistenceDatabase,
  metrics: ApiMetrics,
  ownId: string,
  names: readonly string[],
  nowMs: number,
  sinceWindow = "",
): Map<string, number> {
  const totals = new Map<string, number>(names.map((name) => [name, metrics.unflushed(name)]));
  const rows = database.all<{ name: string; total: number }>(
    `SELECT name,SUM(value) AS total FROM controller_metrics WHERE name IN (${names.map(() => "?").join(",")}) AND window_start>=? AND (controller_id=? OR controller_id IN (SELECT id FROM controller_instances WHERE stopped_at IS NULL AND heartbeat_at>?)) GROUP BY name`,
    ...names,
    sinceWindow,
    ownId,
    new Date(nowMs - CONTROLLER_LIVE_MS).toISOString(),
  );
  for (const row of rows) totals.set(row.name, (totals.get(row.name) ?? 0) + Number(row.total));
  return totals;
}

/**
 * Artifact downloads and their 5xx answers over the live controllers. With `recent` only the current
 * and the previous hour window count, which is what an alert needs to clear after an incident.
 */
export function gatewayTotals(
  database: PersistenceDatabase,
  metrics: ApiMetrics,
  ownId: string,
  nowMs: number,
  recent = false,
): { requests: number; errors: number } {
  const sinceWindow = recent
    ? new Date(Math.floor(nowMs / hourMs) * hourMs - hourMs).toISOString()
    : "";
  const totals = sumCounters(
    database,
    metrics,
    ownId,
    [gatewayRequests, gatewayErrors],
    nowMs,
    sinceWindow,
  );
  return { requests: totals.get(gatewayRequests) ?? 0, errors: totals.get(gatewayErrors) ?? 0 };
}

interface ApiTotals {
  buckets: number[];
  sum: number;
  count: number;
  errors5xx: number;
}

function apiTotals(
  database: PersistenceDatabase,
  metrics: ApiMetrics,
  ownId: string,
  workspaceId: string,
  nowMs: number,
): ApiTotals {
  const bucketNames = apiLatencyBuckets.map((_, index) =>
    apiCounter(`bucket.${index}`, workspaceId),
  );
  const names = [
    apiCounter("count", workspaceId),
    apiCounter("errors5xx", workspaceId),
    apiCounter("sum", workspaceId),
    ...bucketNames,
  ];
  const totals = sumCounters(database, metrics, ownId, names, nowMs);
  return {
    count: totals.get(names[0] as string) ?? 0,
    errors5xx: totals.get(names[1] as string) ?? 0,
    sum: totals.get(names[2] as string) ?? 0,
    buckets: bucketNames.map((name) => totals.get(name) ?? 0),
  };
}

export interface TelemetryDeps {
  metrics: ApiMetrics;
  /** This process's controller id: its own flushed rows count even before its first heartbeat. */
  controllerId: string;
  /** Expected live controller count; absent means a single controller. */
  controller?: { expected: number | null };
  server?: ServerConfig;
  operations(): OperationsService;
  alerts(): AlertsService;
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
    const api = apiTotals(
      this.ctx.database,
      this.deps.metrics,
      this.deps.controllerId,
      this.ctx.workspaceId,
      now.getTime(),
    );
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
      .all<{ admitted: string; started: string }>(
        "SELECT r.created_at AS admitted, a.started_at AS started FROM attempts a JOIN runs r ON r.workspace_id=a.workspace_id AND r.id=a.run_id WHERE a.workspace_id=? AND a.number=1 AND a.started_at IS NOT NULL AND r.created_at>=?",
        this.ctx.workspaceId,
        since,
      )
      .map((row) => Math.max(0, (Date.parse(row.started) - Date.parse(row.admitted)) / 1000));
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
    const nowMs = now.getTime();
    const database = this.ctx.database;
    const everRegistered = Number(
      database.get("SELECT COUNT(*) AS n FROM controller_instances")?.n ?? 0,
    );
    const expected = this.deps.controller?.expected ?? 1;
    indicators.push(
      ratio(
        "controller_availability",
        "Live controllers",
        1,
        everRegistered ? Math.min(liveControllers(database, nowMs).length, expected) : 0,
        everRegistered ? expected : 0,
        "Controllers with a heartbeat newer than 30 s over the number the deployment expects (ADR-035).",
        "current",
      ),
    );
    const schedulerLease = readLease(database, "scheduler");
    const leaderGap = schedulerLease
      ? Math.max(0, (nowMs - Date.parse(schedulerLease.expiresAt)) / 1000)
      : null;
    indicators.push(
      validate<SloIndicator>("SloIndicator", {
        id: "scheduler_leader_gap",
        title: "Scheduler leaderless time",
        unit: "seconds",
        window: "current",
        proposedTarget: (2 * SCHEDULER_LEASE_MS) / 1000,
        observed: leaderGap,
        measurement: leaderGap === null ? "not_measured" : "measured",
        numerator: null,
        denominator: leaderGap === null ? 0 : 1,
        buckets: [],
        errorBudgetRemaining: null,
        notes:
          "Seconds since the scheduler lease lapsed; 0 while a live controller holds it. The target is twice the lease term.",
      }),
    );
    const gateway = gatewayTotals(database, this.deps.metrics, this.deps.controllerId, nowMs);
    indicators.push(
      ratio(
        "artifact_gateway_availability",
        "Artifact gateway availability",
        0.999,
        gateway.requests - gateway.errors,
        gateway.requests,
        "Artifact downloads answered below 500 over all downloads since the live controllers started; the deployment never exposes object-store URLs.",
        "since_start",
      ),
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
