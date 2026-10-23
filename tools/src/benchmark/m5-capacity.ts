import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  canonicalJson,
  minimumSamples,
  percentile,
  roundMillis as rounded,
  sha256,
} from "@testmaster/domain";
import {
  type ControllerName,
  controllerNames,
  type DistributedBenchStack,
  dataOf,
  type EvidenceReader,
  jsonAt,
  type RemoteWorker,
  startDistributedBenchStack,
} from "./distributed-stack.js";
import { diskFacts, hardwareFacts, imageFacts, sourceCommit } from "./hardware.js";
import {
  closedLoop,
  exceedanceSamples,
  judgeUpperBound,
  planFor,
  type Sample,
  type Verdict,
} from "./server-load.js";
import type { BenchPrincipal, HttpResult } from "./server-load-stack.js";

const exec = promisify(execFile);

/*
 * M5-08 capacity and isolation evaluation of the distributed profile (OPS-034, NFR-006): two
 * controllers, PostgreSQL, MinIO and Caddy from `deploy/compose/compose.distributed.yaml` plus
 * remote workers, all on one physical host, driven against a loopback fixture target only. The
 * tool measures throughput and latency, runs a soak, induces three failures under load and drives
 * the queue past its bound. Everything it can judge it judges from observations; everything else is
 * listed as not measured.
 */

/* -------------------------------------------------------------------------------------------- */
/* Percentiles with sample-size gating (unit-tested)                                              */
/* -------------------------------------------------------------------------------------------- */

export interface Percentiles {
  readonly n: number;
  readonly unit: "ms";
  readonly min: number | null;
  readonly mean: number | null;
  readonly max: number | null;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  /** Why a percentile is null; a percentile that is reported has no entry. */
  readonly withheld: Readonly<Record<string, string>>;
}

/**
 * Nearest-rank percentiles of unsorted samples. p50 and p90 are reported from one sample; p95 only
 * from `minimumSamples(95)` (100) and p99 only from `minimumSamples(99)` (500), because the tail
 * beyond the percentile must hold at least five samples. A withheld percentile is null with the
 * reason, never an extrapolation.
 */
export function summarizePercentiles(values: readonly number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const withheld: Record<string, string> = {};
  const gated = (q: number, label: string, needed: number): number | null => {
    if (n < needed) {
      withheld[label] = n === 0 ? "no samples" : `needs n >= ${needed}, got ${n}`;
      return null;
    }
    return rounded(percentile(sorted, q));
  };
  return {
    n,
    unit: "ms",
    min: rounded(sorted[0] ?? null),
    mean: n ? rounded(sorted.reduce((sum, value) => sum + value, 0) / n) : null,
    max: rounded(sorted.at(-1) ?? null),
    p50: gated(50, "p50", 1),
    p90: gated(90, "p90", 1),
    p95: gated(95, "p95", minimumSamples(95)),
    p99: gated(99, "p99", minimumSamples(99)),
    withheld,
  };
}

/**
 * Judges "p95 <= limit". Without a supported p95 the verdict is "not measured", except when at
 * least `exceedanceSamples` attempts all failed or all took longer than the limit: then even the
 * fastest request already decides "not met".
 */
export function judgeP95(
  percentiles: Percentiles,
  limitMs: number,
  errors = 0,
): { verdict: Verdict; reason: string } {
  const allExceed =
    percentiles.n + errors >= exceedanceSamples &&
    (percentiles.n === 0 || (percentiles.min ?? Number.POSITIVE_INFINITY) > limitMs);
  const verdict = judgeUpperBound(
    percentiles.p95,
    limitMs,
    percentiles.p95 !== null,
    errors,
    allExceed,
  );
  const reason =
    verdict === "met"
      ? `p95 ${percentiles.p95} ms within ${limitMs} ms over n=${percentiles.n} with zero errors.`
      : verdict === "not met"
        ? allExceed
          ? `Every one of ${percentiles.n + errors} attempts exceeded ${limitMs} ms or failed.`
          : `p95 ${percentiles.p95} ms over n=${percentiles.n} against a limit of ${limitMs} ms, or ${errors} error(s).`
        : `p95 is withheld (${percentiles.withheld.p95 ?? "no samples"}).`;
  return { verdict, reason };
}

/* -------------------------------------------------------------------------------------------- */
/* Drift and growth (unit-tested)                                                                 */
/* -------------------------------------------------------------------------------------------- */

export interface SeriesPoint {
  readonly atSeconds: number;
  readonly value: number;
}

export interface Drift {
  readonly samples: number;
  readonly windowSeconds: number;
  readonly first: number | null;
  readonly last: number | null;
  readonly min: number | null;
  readonly max: number | null;
  /** Least-squares slope per hour over the samples after the warm-up fraction; null below 3 samples. */
  readonly slopePerHour: number | null;
}

/** Least-squares slope in value per second; null for fewer than 3 points or no time spread. */
export function linearSlope(points: readonly SeriesPoint[]): number | null {
  if (points.length < 3) return null;
  const meanX = points.reduce((sum, point) => sum + point.atSeconds, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  let covariance = 0;
  let variance = 0;
  for (const point of points) {
    covariance += (point.atSeconds - meanX) * (point.value - meanY);
    variance += (point.atSeconds - meanX) ** 2;
  }
  return variance === 0 ? null : covariance / variance;
}

/**
 * Describes how a resource series moved over a soak: first, last, extremes and the fitted slope per
 * hour. The first `warmupFraction` of the window is excluded from the fit because caches and heaps
 * fill at the start; it stays in first/min/max. A slope is a measurement over this window only, not
 * a proof that nothing leaks later.
 */
export function summarizeDrift(points: readonly SeriesPoint[], warmupFraction = 0.2): Drift {
  const ordered = [...points].sort((a, b) => a.atSeconds - b.atSeconds);
  const firstAt = ordered[0]?.atSeconds ?? 0;
  const windowSeconds = (ordered.at(-1)?.atSeconds ?? 0) - firstAt;
  const fitted = ordered.filter(
    (point) => point.atSeconds >= firstAt + warmupFraction * windowSeconds,
  );
  const slope = linearSlope(fitted);
  const values = ordered.map((point) => point.value);
  return {
    samples: ordered.length,
    windowSeconds: rounded(windowSeconds) ?? 0,
    first: ordered[0]?.value ?? null,
    last: ordered.at(-1)?.value ?? null,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    slopePerHour: slope === null ? null : rounded(slope * 3600),
  };
}

/** Average cores used between consecutive cumulative CPU readings, placed at the interval midpoint. */
export function cpuCoresSeries(
  readings: readonly { atSeconds: number; cpuSeconds: number | null }[],
): SeriesPoint[] {
  const series: SeriesPoint[] = [];
  let previous: { atSeconds: number; cpuSeconds: number } | null = null;
  for (const reading of readings) {
    if (reading.cpuSeconds === null) continue;
    if (previous && reading.atSeconds > previous.atSeconds)
      series.push({
        atSeconds: (reading.atSeconds + previous.atSeconds) / 2,
        value:
          (reading.cpuSeconds - previous.cpuSeconds) / (reading.atSeconds - previous.atSeconds),
      });
    previous = { atSeconds: reading.atSeconds, cpuSeconds: reading.cpuSeconds };
  }
  return series;
}

/** Growth per completed Run between two readings; null when no Run completed in between. */
export function growthPerRun(
  start: number | null,
  end: number | null,
  runsStart: number,
  runsEnd: number,
): number | null {
  if (start === null || end === null || runsEnd <= runsStart) return null;
  return rounded((end - start) / (runsEnd - runsStart));
}

/** Runs per minute over a window; null for an empty window. */
export function runsPerMinute(completed: number, windowMs: number): number | null {
  return windowMs > 0 ? rounded((completed * 60_000) / windowMs) : null;
}

export interface ResourcePoint {
  readonly atSeconds: number;
  readonly containers: Readonly<
    Record<
      string,
      {
        readonly cpuSeconds: number | null;
        readonly memoryBytes: number | null;
        readonly anonBytes: number | null;
      }
    >
  >;
  readonly postgresBytes: number | null;
  readonly bucketBytes: number | null;
  readonly bucketObjects: number | null;
  /** Runs completed (by the load generator) up to this reading. */
  readonly runsCompleted: number;
}

const present = (points: readonly { atSeconds: number; value: number | null }[]): SeriesPoint[] =>
  points.flatMap((point) =>
    point.value === null ? [] : [{ atSeconds: point.atSeconds, value: point.value }],
  );

/** Drift of every metered quantity of a soak and the storage growth rates derived from it. */
export function summarizeResources(points: readonly ResourcePoint[]) {
  const names = [...new Set(points.flatMap((point) => Object.keys(point.containers)))].sort();
  const series = (pick: (point: ResourcePoint) => number | null) =>
    present(points.map((point) => ({ atSeconds: point.atSeconds, value: pick(point) })));
  const bucketBytes = series((point) => point.bucketBytes);
  const bucketObjects = series((point) => point.bucketObjects);
  const bucketPoints = points.filter((point) => point.bucketBytes !== null);
  const firstBucket = bucketPoints[0];
  const lastBucket = bucketPoints.at(-1);
  return {
    samples: points.length,
    containers: Object.fromEntries(
      names.map((name) => [
        name,
        {
          memoryBytes: summarizeDrift(
            series((point) => point.containers[name]?.memoryBytes ?? null),
          ),
          anonymousMemoryBytes: summarizeDrift(
            series((point) => point.containers[name]?.anonBytes ?? null),
          ),
          cpuCores: summarizeDrift(
            cpuCoresSeries(
              points.map((point) => ({
                atSeconds: point.atSeconds,
                cpuSeconds: point.containers[name]?.cpuSeconds ?? null,
              })),
            ),
          ),
        },
      ]),
    ),
    postgresDatabaseBytes: summarizeDrift(series((point) => point.postgresBytes)),
    evidenceBucketBytes: summarizeDrift(bucketBytes),
    evidenceBucketObjects: summarizeDrift(bucketObjects),
    storageGrowth: {
      bytesPerHour: summarizeDrift(bucketBytes, 0).slopePerHour,
      bytesPerCompletedRun: growthPerRun(
        firstBucket?.bucketBytes ?? null,
        lastBucket?.bucketBytes ?? null,
        firstBucket?.runsCompleted ?? 0,
        lastBucket?.runsCompleted ?? 0,
      ),
      objectsPerCompletedRun: growthPerRun(
        firstBucket?.bucketObjects ?? null,
        lastBucket?.bucketObjects ?? null,
        firstBucket?.runsCompleted ?? 0,
        lastBucket?.runsCompleted ?? 0,
      ),
      postgresBytesPerCompletedRun: growthPerRun(
        points[0]?.postgresBytes ?? null,
        points.at(-1)?.postgresBytes ?? null,
        points[0]?.runsCompleted ?? 0,
        points.at(-1)?.runsCompleted ?? 0,
      ),
    },
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Admission accounting (unit-tested)                                                             */
/* -------------------------------------------------------------------------------------------- */

export type AdmissionOutcome =
  | "accepted"
  | "queue_overflow"
  | "actor_rate_limited"
  | "tenant_rate_limited"
  | "rate_limited_other"
  | "no_live_worker"
  | "refused_other"
  | "storage_unavailable"
  | "retryable_refusal"
  | "server_error"
  | "transport_error";

export const refusalOutcomes: readonly AdmissionOutcome[] = [
  "queue_overflow",
  "actor_rate_limited",
  "tenant_rate_limited",
  "rate_limited_other",
  "no_live_worker",
  "refused_other",
];

/**
 * The reason code of a server envelope that says the refusal is transient (`error.retryable`), such as
 * `UNAVAILABLE` with `writer_contention`; null for anything else, including a proxy's own error page.
 */
export function retryableReason(body: unknown): string | null {
  if (jsonAt(body, "error", "retryable") !== true) return null;
  const reason = jsonAt(body, "error", "details", "reasonCode");
  if (typeof reason === "string") return reason;
  const code = jsonAt(body, "error", "code");
  return typeof code === "string" ? code : "unspecified";
}

/** Maps one admission response to what it says about capacity; `status` is null when no response arrived. */
export function classifyAdmission(status: number | null, body: unknown): AdmissionOutcome {
  if (status === null) return "transport_error";
  if (status === 200 || status === 201 || status === 202) return "accepted";
  if (status >= 500) {
    if (
      jsonAt(body, "error", "code") === "UNAVAILABLE" &&
      jsonAt(body, "error", "details", "reasonCode") === "storage_unavailable"
    )
      return "storage_unavailable";
    return retryableReason(body) !== null ? "retryable_refusal" : "server_error";
  }
  const code = jsonAt(body, "error", "code");
  if (status === 429 || code === "RATE_LIMITED") {
    const reason = jsonAt(body, "error", "details", "reason");
    const scope = jsonAt(body, "error", "details", "scope");
    if (reason === "queue_overflow") return "queue_overflow";
    if (scope === "actor") return "actor_rate_limited";
    if (scope === "tenant") return "tenant_rate_limited";
    return "rate_limited_other";
  }
  const message = jsonAt(body, "error", "message");
  if (typeof message === "string" && /no live worker/iu.test(message)) return "no_live_worker";
  return "refused_other";
}

export interface AdmissionSample {
  readonly outcome: AdmissionOutcome;
  readonly status: number | null;
  readonly ms: number;
  readonly retryAfter: boolean;
  /** Queue depth the receipt or the refusal reported, and the bound it reported with it. */
  readonly queued: number | null;
  readonly limit: number | null;
  /** Reason code of a designed transient refusal (`retryable_refusal`); null otherwise. */
  readonly reasonCode: string | null;
  /** Completion time (epoch ms), to line the answer up with the logs and the fault window. */
  readonly atMs: number;
  /** The request's failure or unexpected answer in words; null for an expected answer. */
  readonly detail: string | null;
}

export interface AdmissionTally {
  readonly requests: number;
  readonly byOutcome: Readonly<Record<AdmissionOutcome, number>>;
  readonly byStatus: Readonly<Record<string, number>>;
  /** Requests refused by a documented limit (queue bound, rate limits, no live worker). */
  readonly refusals: number;
  /**
   * Requests refused with the designed `UNAVAILABLE`/`storage_unavailable` envelope while the
   * evidence bucket was down (OPS-037). Neither a refusal of capacity nor a crash.
   */
  readonly storageUnavailable: number;
  /**
   * Requests the server refused with an envelope that says `retryable` (for example `UNAVAILABLE`
   * with `writer_contention`): designed transient backpressure, counted with its reason codes and
   * neither a refusal of capacity nor a crash.
   */
  readonly retryableRefusals: number;
  readonly retryableReasons: Readonly<Record<string, number>>;
  /** Unexpected 5xx (no designed envelope) and requests that got no response: what a crash looks like. */
  readonly crashes: number;
  readonly refusalsWithRetryAfter: number;
  readonly maxQueuedReported: number | null;
  readonly queueLimitReported: number | null;
}

const emptyOutcomes = (): Record<AdmissionOutcome, number> => ({
  accepted: 0,
  queue_overflow: 0,
  actor_rate_limited: 0,
  tenant_rate_limited: 0,
  rate_limited_other: 0,
  no_live_worker: 0,
  refused_other: 0,
  storage_unavailable: 0,
  retryable_refusal: 0,
  server_error: 0,
  transport_error: 0,
});

/** Counts admissions by outcome so a refusal is never mistaken for a crash, or the reverse. */
export function summarizeAdmissions(samples: readonly AdmissionSample[]): AdmissionTally {
  const byOutcome = emptyOutcomes();
  const byStatus: Record<string, number> = {};
  let withRetryAfter = 0;
  const retryableReasons: Record<string, number> = {};
  let maxQueued: number | null = null;
  let limit: number | null = null;
  for (const sample of samples) {
    byOutcome[sample.outcome]++;
    if (sample.outcome === "retryable_refusal") {
      const reason = sample.reasonCode ?? "unspecified";
      retryableReasons[reason] = (retryableReasons[reason] ?? 0) + 1;
    }
    const status = String(sample.status ?? "error");
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (refusalOutcomes.includes(sample.outcome) && sample.retryAfter) withRetryAfter++;
    if (sample.queued !== null) maxQueued = Math.max(maxQueued ?? 0, sample.queued);
    if (sample.limit !== null) limit = sample.limit;
  }
  return {
    requests: samples.length,
    byOutcome,
    byStatus,
    refusals: refusalOutcomes.reduce((sum, outcome) => sum + byOutcome[outcome], 0),
    storageUnavailable: byOutcome.storage_unavailable,
    retryableRefusals: byOutcome.retryable_refusal,
    retryableReasons,
    crashes: byOutcome.server_error + byOutcome.transport_error,
    refusalsWithRetryAfter: withRetryAfter,
    maxQueuedReported: maxQueued,
    queueLimitReported: limit,
  };
}

/** One admission that ended in neither an acceptance nor a documented refusal, with what it looked like. */
export interface UnexpectedAnswer {
  readonly at: string;
  readonly outcome: AdmissionOutcome;
  readonly status: number | null;
  readonly ms: number;
  readonly detail: string | null;
}

/** The admissions a verdict hinges on (5xx without a designed envelope, no answer, unclassified 4xx), capped. */
export function unexpectedAnswers(
  samples: readonly AdmissionSample[],
  limit = 20,
): UnexpectedAnswer[] {
  return samples
    .filter((sample) =>
      ["server_error", "transport_error", "refused_other"].includes(sample.outcome),
    )
    .slice(0, limit)
    .map((sample) => ({
      at: new Date(sample.atMs).toISOString(),
      outcome: sample.outcome,
      status: sample.status,
      ms: Math.round(sample.ms),
      detail: sample.detail,
    }));
}

/** Log lines that look like an error or a 5xx answer, so a failed request can be matched to its cause. */
export function errorLogLines(log: string, limit = 20): string[] {
  return log
    .split("\n")
    .filter((line) => /"status"\s*:\s*5\d\d|"level"\s*:\s*"(error|fatal)"|\bERROR\b/u.test(line))
    .slice(-limit)
    .map((line) => line.slice(0, 600));
}

/**
 * Backpressure is "met" when the tool drove admissions to the queue bound, every request got an
 * answer that is either an acceptance or a documented refusal, the refusals say when to retry, and
 * the controllers were alive afterwards. A server error or a missing answer is a crash symptom and
 * decides "not met". If the bound was never reached the verdict is "not measured".
 */
export function judgeBackpressure(
  tally: AdmissionTally,
  controllersLiveAfter: boolean,
): { verdict: Verdict; reason: string } {
  if (tally.crashes > 0)
    return {
      verdict: "not met",
      reason: `${tally.crashes} request(s) ended in a server error or without an answer instead of a refusal.`,
    };
  if (!controllersLiveAfter)
    return { verdict: "not met", reason: "A controller was not live after the burst." };
  if (tally.byOutcome.queue_overflow === 0)
    return {
      verdict: "not measured",
      reason: `The queue bound was not reached (${tally.byOutcome.accepted} accepted, ${tally.refusals} refused by other limits${tally.retryableRefusals ? `, ${tally.retryableRefusals} transient server refusals` : ""}).`,
    };
  if (tally.refusalsWithRetryAfter < tally.refusals)
    return {
      verdict: "not met",
      reason: `${tally.refusals - tally.refusalsWithRetryAfter} refusal(s) carried no Retry-After.`,
    };
  return {
    verdict: "met",
    reason: `${tally.byOutcome.queue_overflow} queue_overflow refusal(s) at bound ${tally.queueLimitReported}; 0 crashes${
      tally.retryableRefusals
        ? ` (${tally.retryableRefusals} designed transient refusal(s): ${Object.entries(
            tally.retryableReasons,
          )
            .map(([reason, count]) => `${reason} ${count}`)
            .join(", ")})`
        : ""
    }; every refusal carried Retry-After; controllers live afterwards.`,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Run audit: no invented result (unit-tested)                                                    */
/* -------------------------------------------------------------------------------------------- */

export interface AuditRow {
  readonly runId: string;
  readonly runCreatedAt: string;
  readonly runPhase: string;
  readonly runOutcome: string | null;
  /** The evidence gate of the Run: `passed` only when the evidence the policy requires was published. */
  readonly runGate: string | null;
  readonly attemptId: string | null;
  readonly attemptNumber: number | null;
  readonly workerId: string | null;
  readonly attemptPhase: string | null;
  readonly attemptOutcome: string | null;
  readonly endedAt: string | null;
}

export type AuditRule =
  | "passed_without_passed_attempt"
  | "multiple_passed_attempts"
  | "passed_attempt_superseded"
  | "completed_run_with_open_attempt";

export interface AuditViolation {
  readonly runId: string;
  readonly rule: AuditRule;
  readonly detail: string;
}

export interface RunAudit {
  readonly runs: number;
  readonly byOutcome: Readonly<Record<string, number>>;
  /** Runs that are not completed at audit time. */
  readonly unresolved: readonly string[];
  readonly attempts: number;
  readonly retriedRuns: number;
  readonly violations: readonly AuditViolation[];
}

/**
 * Checks the Runs of a window against the rules that make a result truthful. A Run may pass only
 * through an Attempt that passed; at most one Attempt of a Run may pass; an Attempt that passed
 * cannot have been superseded by a later one (that would mean two executions both claimed the Run);
 * a completed Run has no Attempt still open. Retried Attempts that ended otherwise are legitimate.
 */
export function auditRuns(rows: readonly AuditRow[]): RunAudit {
  const byRun = new Map<string, AuditRow[]>();
  for (const row of rows) byRun.set(row.runId, [...(byRun.get(row.runId) ?? []), row]);
  const violations: AuditViolation[] = [];
  const byOutcome: Record<string, number> = {};
  const unresolved: string[] = [];
  let attempts = 0;
  let retriedRuns = 0;
  for (const [runId, runRows] of byRun) {
    const first = runRows[0];
    if (!first) continue;
    const mine = runRows.filter((row) => row.attemptId !== null);
    attempts += mine.length;
    if (mine.length > 1) retriedRuns++;
    if (first.runPhase !== "completed") {
      unresolved.push(runId);
      continue;
    }
    const outcome = first.runOutcome ?? "unknown";
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
    const passed = mine.filter((row) => row.attemptOutcome === "passed");
    if (outcome === "passed" && passed.length === 0)
      violations.push({
        runId,
        rule: "passed_without_passed_attempt",
        detail: `Run passed with ${mine.length} Attempt(s), none passed`,
      });
    if (passed.length > 1)
      violations.push({
        runId,
        rule: "multiple_passed_attempts",
        detail: `Attempts ${passed.map((row) => row.attemptNumber).join(", ")} all passed`,
      });
    for (const winner of passed) {
      const later = mine.filter((row) => (row.attemptNumber ?? 0) > (winner.attemptNumber ?? 0));
      if (later.length)
        violations.push({
          runId,
          rule: "passed_attempt_superseded",
          detail: `Attempt ${winner.attemptNumber} passed but Attempt ${later.map((row) => row.attemptNumber).join(", ")} followed`,
        });
    }
    const open = mine.filter((row) => row.attemptPhase !== "completed");
    if (open.length)
      violations.push({
        runId,
        rule: "completed_run_with_open_attempt",
        detail: `Attempt ${open.map((row) => row.attemptNumber).join(", ")} still ${open.map((row) => row.attemptPhase).join(", ")}`,
      });
  }
  return {
    runs: byRun.size,
    byOutcome,
    unresolved,
    attempts,
    retriedRuns,
    violations,
  };
}

/** Schedule firings that repeat the same (schedule, revision, instant): a duplicate firing. */
export function duplicateFirings(
  rows: readonly { scheduleId: string; revision: number; fireInstant: string }[],
): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of rows) {
    const key = `${row.scheduleId}|${row.revision}|${row.fireInstant}`;
    if (seen.has(key)) duplicates++;
    seen.add(key);
  }
  return duplicates;
}

/**
 * The fixture target answers one request per Attempt that reached it, so it cannot have served more
 * requests than Attempts were started: more would mean an execution nothing recorded.
 */
export function executionBound(
  targetRequests: number,
  attemptsStarted: number,
): { ok: boolean; targetRequests: number; attemptsStarted: number } {
  return { ok: targetRequests <= attemptsStarted, targetRequests, attemptsStarted };
}

/* -------------------------------------------------------------------------------------------- */
/* Overhead decomposition (unit-tested)                                                           */
/* -------------------------------------------------------------------------------------------- */

export interface TimingParts {
  readonly queueMs: number | null;
  readonly preparationMs: number | null;
  readonly executionMs: number | null;
  readonly collectionMs: number | null;
}

const numeric = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Folds the `attempt.timing` events of Runs into one record each: the queue time of the first
 * Attempt (later Attempts carry none) and the sum of every Attempt's preparation, execution and
 * collection time. A part no Attempt reported stays null.
 */
export function aggregateTimings(
  events: readonly { runId: string; payload: unknown }[],
): Map<string, TimingParts> {
  const sum = (previous: number | null, next: number | null): number | null =>
    next === null ? previous : (previous ?? 0) + next;
  const parts = new Map<string, TimingParts>();
  for (const event of events) {
    const timing = jsonAt(event.payload, "timing");
    const before = parts.get(event.runId);
    parts.set(event.runId, {
      queueMs: before?.queueMs ?? numeric(jsonAt(timing, "queueDuration")),
      preparationMs: sum(
        before?.preparationMs ?? null,
        numeric(jsonAt(timing, "preparationDuration")),
      ),
      executionMs: sum(before?.executionMs ?? null, numeric(jsonAt(timing, "executionDuration"))),
      collectionMs: sum(
        before?.collectionMs ?? null,
        numeric(jsonAt(timing, "collectionDuration")),
      ),
    });
  }
  return parts;
}

/** Wall time of each completed Run: admission to the end of its last Attempt. */
export function wallTimes(rows: readonly AuditRow[]): Map<string, number> {
  const ends = new Map<string, number>();
  const created = new Map<string, number>();
  const incomplete = new Set<string>();
  for (const row of rows) {
    if (row.runPhase !== "completed") continue;
    created.set(row.runId, Date.parse(row.runCreatedAt));
    if (row.attemptId === null) continue;
    if (row.endedAt === null) incomplete.add(row.runId);
    else ends.set(row.runId, Math.max(ends.get(row.runId) ?? 0, Date.parse(row.endedAt)));
  }
  const walls = new Map<string, number>();
  for (const [runId, end] of ends) {
    const start = created.get(runId);
    if (start !== undefined && !incomplete.has(runId) && end >= start)
      walls.set(runId, end - start);
  }
  return walls;
}

/** Where the time of a set of Runs went; every part is a percentile summary with its own n. */
export interface RunDecomposition {
  readonly runsWithWallTime: number;
  readonly runsWithTiming: number;
  readonly targetServiceMsPerRequest: number | null;
  readonly wall: Percentiles;
  readonly queue: Percentiles;
  readonly preparation: Percentiles;
  readonly execution: Percentiles;
  readonly runnerOverhead: Percentiles;
  readonly collection: Percentiles;
  readonly orchestrationOverhead: Percentiles;
  readonly controllerOverhead: Percentiles;
}

/**
 * Separates where a Run's time went (NFR-006: never confuse model or application time with
 * overhead). `execution` is the running phase, which holds the target's time; `queue`,
 * `preparation` and `collection` (evidence publication to storage) are the other measured phases;
 * `orchestrationOverhead` is wall - queue - preparation - execution, so it contains collection;
 * `controllerOverhead` is that minus collection: what remains for claiming, forwarding and
 * recording. `runnerOverhead` is execution minus the target's own service time.
 */
export function decomposeRuns(
  walls: ReadonlyMap<string, number>,
  timings: ReadonlyMap<string, TimingParts>,
  targetServiceMs: number | null,
): RunDecomposition {
  const collect = (pick: (runId: string, wall: number, parts: TimingParts) => number | null) => {
    const values: number[] = [];
    for (const [runId, wall] of walls) {
      const parts = timings.get(runId);
      if (!parts) continue;
      const value = pick(runId, wall, parts);
      if (value !== null) values.push(value);
    }
    return summarizePercentiles(values);
  };
  const remainder = (wall: number, parts: TimingParts, includeCollection: boolean) =>
    parts.queueMs === null || parts.preparationMs === null || parts.executionMs === null
      ? null
      : Math.max(
          0,
          wall -
            parts.queueMs -
            parts.preparationMs -
            parts.executionMs -
            (includeCollection ? 0 : (parts.collectionMs ?? 0)),
        );
  return {
    runsWithWallTime: walls.size,
    runsWithTiming: [...walls.keys()].filter((runId) => timings.has(runId)).length,
    targetServiceMsPerRequest: targetServiceMs,
    wall: summarizePercentiles([...walls.values()]),
    queue: collect((_, __, parts) => parts.queueMs),
    preparation: collect((_, __, parts) => parts.preparationMs),
    execution: collect((_, __, parts) => parts.executionMs),
    runnerOverhead: collect((_, __, parts) =>
      parts.executionMs === null || targetServiceMs === null
        ? null
        : Math.max(0, parts.executionMs - targetServiceMs),
    ),
    collection: collect((_, __, parts) => parts.collectionMs),
    orchestrationOverhead: collect((_, wall, parts) => remainder(wall, parts, true)),
    controllerOverhead: collect((_, wall, parts) => remainder(wall, parts, false)),
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Availability and verdict derivation (unit-tested)                                              */
/* -------------------------------------------------------------------------------------------- */

export interface ProbeSample {
  readonly atMs: number;
  readonly ok: boolean;
}

/**
 * What a fault looked like to a client probing the public address: how many probes failed, the
 * longest unbroken failure streak, and the time from the induced fault to the first success after
 * the last failure (null when nothing failed).
 */
export function outageSummary(samples: readonly ProbeSample[], inducedAtMs: number) {
  const ordered = [...samples].sort((a, b) => a.atMs - b.atMs);
  let failures = 0;
  let longest = 0;
  let streakStart: number | null = null;
  let lastRecovery: number | null = null;
  for (const sample of ordered) {
    if (!sample.ok) {
      failures++;
      streakStart ??= sample.atMs;
    } else if (streakStart !== null) {
      longest = Math.max(longest, sample.atMs - streakStart);
      lastRecovery = sample.atMs;
      streakStart = null;
    }
  }
  const stillFailing = streakStart !== null;
  return {
    probes: ordered.length,
    failures,
    outageObserved: failures > 0,
    longestFailureStreakMs: longest,
    recoveryMs:
      stillFailing || lastRecovery === null ? null : Math.max(0, lastRecovery - inducedAtMs),
    stillFailingAtEnd: stillFailing,
  };
}

export interface Check {
  readonly name: string;
  /** True when the invariant held, false when it was violated, null when the run could not observe it. */
  readonly ok: boolean | null;
  readonly detail: string;
}

/** A case is "not met" when any invariant failed, "not measured" when any could not be observed, else "met". */
export function judgeChecks(checks: readonly Check[]): { verdict: Verdict; reason: string } {
  const failed = checks.filter((check) => check.ok === false);
  if (failed.length)
    return {
      verdict: "not met",
      reason: failed.map((check) => `${check.name}: ${check.detail}`).join("; "),
    };
  const unobserved = checks.filter((check) => check.ok === null);
  if (unobserved.length)
    return {
      verdict: "not measured",
      reason: unobserved.map((check) => `${check.name}: ${check.detail}`).join("; "),
    };
  return { verdict: "met", reason: `${checks.length} invariant(s) held.` };
}

/** Lease an Attempt holds between heartbeats (`LeaseRepository` claim and heartbeat default, 30 s). */
export const remoteLeaseTtlMs = 30_000;
/** Period of the elected `lease-reconciler` controller that reclaims lapsed leases (5 s). */
export const leaseReconcilerIntervalMs = 5_000;

/** An Attempt that was still leased to the frozen worker at the moment of the freeze. */
export interface FrozenAttempt {
  readonly attemptId: string;
  readonly runId: string;
  /** `job_leases.lease_expires_at` read right after SIGSTOP; nothing renews it while frozen. */
  readonly leaseExpiresAtMs: number;
}

/** The time span in which a fault legitimately keeps evidence from being published. */
export interface OutageWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * A Run whose assertions passed but whose evidence gate failed is the product saying the evidence
 * could not be published. That is expected only for Attempts that ended while the bucket was down;
 * anywhere else it is a Run that looks passed and has nothing behind it.
 */
export function judgeGateFailedPasses(
  rows: readonly AuditRow[],
  window: OutageWindow | null,
): Check {
  const name = "gate_failed_passes_explained";
  const failed = gateFailedPasses(rows);
  const outside = failed.filter((row) => {
    const ended = row.endedAt ? Date.parse(row.endedAt) : Number.NaN;
    return !window || !(ended >= window.fromMs && ended <= window.toMs);
  });
  const counts = `${failed.length} Run(s) ended with passed assertions and a failed evidence gate`;
  return {
    name,
    ok: outside.length === 0,
    detail: window
      ? `${counts}, ${failed.length - outside.length} of them inside the outage window${outside.length ? `; outside it: ${outside.map((row) => row.runId).join(", ")}` : ""}`
      : `${counts}; this case has no window in which that is expected${outside.length ? `: ${outside.map((row) => row.runId).join(", ")}` : ""}`,
  };
}

/**
 * Judges a partition per frozen Attempt. If its lease had lapsed by the time the worker resumed,
 * the Attempt must not have passed (its late calls are refused) and its Run must have a later
 * Attempt or end non-passed. If the lease was still valid, the Attempt finishing under its own fence
 * is legitimate and is only reported. With no lapsed lease the invariant was not observed.
 */
export function judgeFrozenAttempts(
  frozen: readonly FrozenAttempt[],
  resumedAtMs: number,
  rows: readonly AuditRow[],
): Check {
  const name = "leases_moved_off_frozen_worker";
  const lapsed = frozen.filter((attempt) => attempt.leaseExpiresAtMs <= resumedAtMs);
  const valid = frozen.length - lapsed.length;
  const broken: string[] = [];
  for (const attempt of lapsed) {
    const mine = rows.filter((row) => row.runId === attempt.runId && row.attemptId !== null);
    const own = mine.find((row) => row.attemptId === attempt.attemptId);
    const later = mine.some((row) => (row.attemptNumber ?? 0) > (own?.attemptNumber ?? 0));
    const endedNonPassed = mine[0]?.runPhase === "completed" && mine[0].runOutcome !== "passed";
    if (own?.attemptOutcome === "passed")
      broken.push(`${attempt.attemptId} passed after its lease lapsed`);
    else if (!later && !endedNonPassed)
      broken.push(`${attempt.runId} got no later Attempt and did not end non-passed`);
  }
  const counts = `${lapsed.length} lapsed, ${valid} still valid at resume of ${frozen.length} frozen Attempt(s)`;
  if (broken.length) return { name, ok: false, detail: `${broken.join("; ")} (${counts})` };
  if (lapsed.length === 0)
    return {
      name,
      ok: null,
      detail: `no frozen lease lapsed, so a lease move was not observed (${counts})`,
    };
  return {
    name,
    ok: true,
    detail: `every lapsed Attempt was refused and its Run moved on or ended non-passed (${counts})`,
  };
}
export interface SoakObservation {
  readonly requestedSeconds: number;
  readonly actualSeconds: number;
  readonly runs: number;
  readonly nonPassedRuns: number;
  readonly unresolvedRuns: number;
  readonly apiErrors: number;
  readonly violations: number;
  readonly containerRestarts: number;
}

/**
 * The soak is "met" when it lasted the requested time, every Run reached a terminal state, every
 * Run against the healthy fixture passed, the API gave no server error, the audit found no invented
 * result and no container restarted. Drift is reported next to the verdict, not judged: the
 * specification names no threshold for it.
 */
export function judgeSoak(observation: SoakObservation): { verdict: Verdict; reason: string } {
  if (observation.runs === 0)
    return { verdict: "not measured", reason: "No Run completed during the soak." };
  const problems: string[] = [];
  if (observation.actualSeconds < observation.requestedSeconds * 0.99)
    problems.push(
      `lasted ${observation.actualSeconds} s of the requested ${observation.requestedSeconds} s`,
    );
  if (observation.nonPassedRuns > 0)
    problems.push(`${observation.nonPassedRuns} Run(s) did not pass against a healthy target`);
  if (observation.unresolvedRuns > 0)
    problems.push(`${observation.unresolvedRuns} Run(s) never reached a terminal state`);
  if (observation.apiErrors > 0) problems.push(`${observation.apiErrors} API error(s)`);
  if (observation.violations > 0) problems.push(`${observation.violations} audit violation(s)`);
  if (observation.containerRestarts > 0)
    problems.push(`${observation.containerRestarts} container restart(s)`);
  return problems.length
    ? { verdict: "not met", reason: problems.join("; ") }
    : {
        verdict: "met",
        reason: `${observation.runs} Runs over ${observation.actualSeconds} s, all passed, no API error, no audit violation, no restart.`,
      };
}

/* -------------------------------------------------------------------------------------------- */
/* Options                                                                                        */
/* -------------------------------------------------------------------------------------------- */

export const phaseNames = ["throughput", "soak", "chaos", "backpressure"] as const;
export type PhaseName = (typeof phaseNames)[number];
export const chaosCaseNames = ["controller_kill", "minio_restart", "worker_partition"] as const;
export type ChaosCaseName = (typeof chaosCaseNames)[number];

export interface CapacityOptions {
  readonly out: string;
  readonly soakMinutes: number;
  /** Closed-loop client concurrency levels of the throughput phase. */
  readonly concurrency: readonly number[];
  readonly runsPerLevel: number;
  readonly workers: number;
  readonly slots: number;
  readonly soakConcurrency: number;
  readonly chaosConcurrency: number;
  readonly targetDelayMs: number;
  readonly apiIterations: number;
  readonly sampleSeconds: number;
  readonly chaosBaselineSeconds: number;
  readonly chaosPostSeconds: number;
  readonly killDownSeconds: number;
  readonly minioOutageSeconds: number;
  readonly partitionSeconds: number;
  readonly backpressurePrincipals: number;
  readonly backpressureMaxSeconds: number;
  readonly phases: readonly PhaseName[];
  readonly chaosCases: readonly ChaosCaseName[];
  /** Service time of the slow fixture the partition case's Runs hit. */
  readonly partitionTargetDelayMs: number;
  /** Leaves the compose project running when a verdict is not met, so the failure can be inspected. */
  readonly keepStackOnFailure: boolean;
  readonly workDirectory: string;
}

export const usage = `Usage: node tools/dist/benchmark/m5-capacity.js --out <file.json> [options]

Boots the distributed compose stack (2 controllers, PostgreSQL, MinIO, Caddy) with remote workers
on this host and measures it against a loopback fixture target. There is no target flag: the tool
never sends load to anything but its own fixture.

  --out <file>                  result JSON (required)
  --soak-minutes <n>            soak duration (default 30)
  --concurrency <a,b,..>        client concurrency of the throughput levels (default 2,4,8)
  --runs-per-level <n>          Runs per throughput level (default 60)
  --workers <n>                 remote workers (default 2)
  --slots <n>                   slots per worker (default 2)
  --soak-concurrency <n>        closed-loop Runs in flight during the soak (default workers*slots/2)
  --chaos-concurrency <n>       Runs in flight during chaos cases (default workers*slots)
  --target-delay-ms <n>         fixture service time per request (default 100)
  --api-iterations <n>          requests per API operation and level (default 200)
  --sample-seconds <n>          soak resource sampling interval (default 15)
  --chaos-baseline-seconds <n>  load before a fault is induced (default 20)
  --chaos-post-seconds <n>      load after recovery before the case ends (default 60)
  --kill-down-seconds <n>       minimum time the killed controller stays down (default 30)
  --minio-outage-seconds <n>    time MinIO stays stopped (default 20)
  --partition-seconds <n>       time a worker stays frozen (default 120)
  --backpressure-principals <n> runner principals used to exceed the queue bound (default 24)
  --backpressure-max-seconds <n> cap of the backpressure burst (default 600; admissions run at about 3 per second, so the 1000-job bound needs about 6 minutes)
  --phases <a,b,..>             subset of ${phaseNames.join(",")} (default all)
  --chaos-cases <a,b,..>        subset of ${chaosCaseNames.join(",")} (default all)
  --partition-target-delay-ms <n> service time of the slow fixture the partition case's Runs hit, so
                                an Attempt is in flight at the freeze (default 20000)
  --keep-stack-on-failure <true|false> leave the compose project up when a verdict is not met, for
                                forensics; the result names the command that removes it (default false)
  --work-dir <dir>              scratch directory (default /var/tmp)
  --help                        this text
`;

function positiveList(value: string, name: string): number[] {
  const list = value.split(",").map(Number);
  if (!list.length || list.some((entry) => !Number.isInteger(entry) || entry < 1))
    throw new Error(`${name} must be a comma-separated list of positive integers`);
  return list;
}

/** Parses `--flag value` pairs; returns "help" when `--help` is present. */
export function parseArguments(argv: readonly string[]): CapacityOptions | "help" {
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined)
      throw new Error(`Expected --flag value pairs, got ${flag ?? "nothing"}`);
    values.set(flag.slice(2), value);
  }
  const known = [
    "out",
    "soak-minutes",
    "concurrency",
    "runs-per-level",
    "workers",
    "slots",
    "soak-concurrency",
    "chaos-concurrency",
    "target-delay-ms",
    "api-iterations",
    "sample-seconds",
    "chaos-baseline-seconds",
    "chaos-post-seconds",
    "kill-down-seconds",
    "minio-outage-seconds",
    "partition-seconds",
    "backpressure-principals",
    "backpressure-max-seconds",
    "phases",
    "chaos-cases",
    "partition-target-delay-ms",
    "keep-stack-on-failure",
    "work-dir",
  ];
  for (const flag of values.keys())
    if (!known.includes(flag)) throw new Error(`Unknown flag --${flag}`);
  const keepStackOnFailure = values.get("keep-stack-on-failure") === "true";
  if (
    values.has("keep-stack-on-failure") &&
    !["true", "false"].includes(values.get("keep-stack-on-failure") ?? "")
  )
    throw new Error("--keep-stack-on-failure takes true or false");
  const out = values.get("out");
  if (!out) throw new Error("--out <file> is required");
  const integer = (name: string, fallback: number, minimum = 1): number => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < minimum)
      throw new Error(`--${name} must be an integer >= ${minimum}`);
    return parsed;
  };
  const workers = integer("workers", 2);
  const slots = integer("slots", 2);
  const phases = values.has("phases")
    ? (values.get("phases") ?? "").split(",").map((phase) => {
        const found = phaseNames.find((name) => name === phase);
        if (!found) throw new Error(`--phases entries must be among ${phaseNames.join(",")}`);
        return found;
      })
    : [...phaseNames];
  const chaosCases = values.has("chaos-cases")
    ? (values.get("chaos-cases") ?? "").split(",").map((entry) => {
        const found = chaosCaseNames.find((name) => name === entry);
        if (!found)
          throw new Error(`--chaos-cases entries must be among ${chaosCaseNames.join(",")}`);
        return found;
      })
    : [...chaosCaseNames];
  const partitionSeconds = integer("partition-seconds", 120);
  if (
    phases.includes("chaos") &&
    chaosCases.includes("worker_partition") &&
    partitionSeconds * 1000 <= remoteLeaseTtlMs + leaseReconcilerIntervalMs
  )
    throw new Error(
      `--partition-seconds must exceed ${(remoteLeaseTtlMs + leaseReconcilerIntervalMs) / 1000} s (the remote Attempt lease of ${remoteLeaseTtlMs / 1000} s plus a ${leaseReconcilerIntervalMs / 1000} s reconciler tick), otherwise a frozen worker's lease may never lapse and the case is not a partition test`,
    );
  return {
    out: resolve(out),
    soakMinutes: integer("soak-minutes", 30),
    concurrency: values.has("concurrency")
      ? positiveList(values.get("concurrency") ?? "", "--concurrency")
      : [2, 4, 8],
    runsPerLevel: integer("runs-per-level", 60),
    workers,
    slots,
    soakConcurrency: integer("soak-concurrency", Math.max(1, Math.floor((workers * slots) / 2))),
    chaosConcurrency: integer("chaos-concurrency", workers * slots),
    targetDelayMs: integer("target-delay-ms", 100, 0),
    apiIterations: integer("api-iterations", 200),
    sampleSeconds: integer("sample-seconds", 15),
    chaosBaselineSeconds: integer("chaos-baseline-seconds", 20),
    chaosPostSeconds: integer("chaos-post-seconds", 60),
    killDownSeconds: integer("kill-down-seconds", 30),
    minioOutageSeconds: integer("minio-outage-seconds", 20),
    partitionSeconds,
    backpressurePrincipals: integer("backpressure-principals", 24),
    backpressureMaxSeconds: integer("backpressure-max-seconds", 600),
    phases,
    chaosCases,
    partitionTargetDelayMs: integer("partition-target-delay-ms", 20_000, 0),
    keepStackOnFailure,
    workDirectory: resolve(values.get("work-dir") ?? "/var/tmp"),
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Fixture target                                                                                 */
/* -------------------------------------------------------------------------------------------- */

interface Fixture {
  readonly url: string;
  hits(): number;
  /** Mean milliseconds the fixture took to answer one request, from its own clock. */
  meanServiceMs(): number | null;
  close(): Promise<void>;
}

/** Local HTTP target with a fixed service time, bound to loopback only: the one target this tool uses. */
async function startFixture(delayMs: number): Promise<Fixture> {
  let hits = 0;
  let serviceMs = 0;
  let answered = 0;
  const server = createServer((incoming, outgoing) => {
    hits++;
    const arrived = performance.now();
    incoming.resume();
    setTimeout(() => {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end('{"status":"ok"}');
      serviceMs += performance.now() - arrived;
      answered++;
    }, delayMs);
  });
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListening);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture target has no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits: () => hits,
    meanServiceMs: () => (answered ? rounded(serviceMs / answered) : null),
    close: () =>
      new Promise<void>((resolveClosed) => {
        server.closeAllConnections();
        server.close(() => resolveClosed());
      }),
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Load driver                                                                                    */
/* -------------------------------------------------------------------------------------------- */

interface DriverRecord {
  readonly runId: string;
  readonly admittedAtMs: number;
  readonly admissionMs: number;
  completedAtMs: number | null;
  outcome: string | null;
}

interface Target {
  readonly projectId: string;
  readonly testId: string;
  readonly environmentId: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

const windowOf = (startMs: number, endMs: number) => ({
  startedAt: iso(startMs),
  endedAt: iso(endMs),
  seconds: rounded((endMs - startMs) / 1000),
});

const parseBody = (result: HttpResult): unknown => {
  try {
    return JSON.parse(result.body.toString());
  } catch {
    return null;
  }
};

/**
 * Closed-loop Run load: each of `concurrency` loops admits a Run, waits until it is completed and
 * starts the next. A 5xx or a missing answer on admission is retried with the same idempotency key
 * (so a Run is never created twice), and every request is counted.
 */
class RunDriver {
  readonly records: DriverRecord[] = [];
  readonly admissions: AdmissionSample[] = [];
  readonly pollErrors: Record<string, number> = {};
  /** Polls the server refused with a `retryable` envelope, by reason code; polling simply continues. */
  readonly pollRetryable: Record<string, number> = {};
  /** The first polls that failed, with what the proxy or the controller answered, to attribute them. */
  readonly pollFailures: { at: string; runId: string; detail: string }[] = [];
  private rotation = 0;

  constructor(
    private readonly stack: DistributedBenchStack,
    private readonly principals: readonly BenchPrincipal[],
    private readonly target: Target,
  ) {}

  async run(concurrency: number, shouldStop: () => boolean, maxRuns = Number.POSITIVE_INFINITY) {
    let started = 0;
    const loop = async () => {
      while (!shouldStop() && started < maxRuns) {
        started++;
        const record = await this.admit();
        if (record) await this.complete(record);
        else {
          started--;
          await sleep(1000);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, loop));
  }

  /** One logical admission; null when it was refused. */
  private async admit(): Promise<DriverRecord | null> {
    const principal = this.principals[this.rotation++ % this.principals.length];
    if (!principal) throw new Error("No admission principal");
    const key = randomUUID();
    for (let attempt = 0; attempt < 4; attempt++) {
      const sample = await admitOnce(this.stack, principal, this.target, key);
      this.admissions.push(sample.sample);
      // A transient refusal is retried like a server error, with the same idempotency key.
      if (
        sample.sample.outcome === "server_error" ||
        sample.sample.outcome === "transport_error" ||
        sample.sample.outcome === "retryable_refusal"
      ) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      if (sample.sample.outcome !== "accepted" || !sample.runId) return null;
      const record: DriverRecord = {
        runId: sample.runId,
        admittedAtMs: Date.now(),
        admissionMs: sample.sample.ms,
        completedAtMs: null,
        outcome: null,
      };
      this.records.push(record);
      return record;
    }
    return null;
  }

  /** Polls the Run until it is completed or the generous per-Run cap passes. */
  private async complete(record: DriverRecord): Promise<void> {
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      const response = await this.stack.client
        .call("GET", `/v1/runs/${record.runId}`, { token: this.stack.owner.token })
        .catch(() => null);
      const designed =
        response && response.status >= 500 ? retryableReason(parseBody(response)) : null;
      if (designed !== null) {
        // The server's own envelope says the refusal is transient: counted by reason, not an error.
        this.pollRetryable[designed] = (this.pollRetryable[designed] ?? 0) + 1;
      } else if (response?.status !== 200) {
        const key = response ? String(response.status) : "transport_error";
        this.pollErrors[key] = (this.pollErrors[key] ?? 0) + 1;
        if (this.pollFailures.length < 20)
          this.pollFailures.push({
            at: new Date().toISOString(),
            runId: record.runId,
            detail: response ? describeResponse(response) : "no response",
          });
      } else {
        const data = dataOf(response);
        if (jsonAt(data, "phase") === "completed") {
          record.completedAtMs = Date.now();
          const outcome = jsonAt(data, "outcome");
          // Assertions that passed with the evidence gate failed are not a pass the client can rely
          // on; they are recorded as their own outcome so no later check counts them as passed.
          record.outcome =
            typeof outcome !== "string"
              ? null
              : outcome === "passed" && jsonAt(data, "gate") !== "passed"
                ? "passed_gate_failed"
                : outcome;
          return;
        }
      }
      await sleep(500);
    }
  }

  get completed(): number {
    return this.records.filter((record) => record.completedAtMs !== null).length;
  }
}

/** Longest response body kept in a record; enough to tell a proxy's page from an API envelope. */
const detailBodyBytes = 400;

/**
 * What an unexpected answer looked like, so a 5xx can be told apart afterwards: an API error
 * carries a JSON envelope with a request id, a proxy's gateway error does not.
 */
function describeResponse(response: HttpResult): string {
  const header = (name: string): string => {
    const value = response.headers[name];
    return (Array.isArray(value) ? value.join(",") : (value ?? "-")) || "-";
  };
  return `HTTP ${response.status} server=${header("server")} via=${header("via")} content-type=${header("content-type")} x-request-id=${header("x-request-id")} body=${JSON.stringify(response.body.subarray(0, detailBodyBytes).toString("utf8"))}`;
}

/** The error a request ended with when no response arrived, including its socket-level cause. */
function describeTransportFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = jsonAt(error, "cause", "code") ?? jsonAt(error, "code");
  return `${error.name}: ${error.message}${typeof cause === "string" ? ` (${cause})` : ""}`;
}

async function admitOnce(
  stack: DistributedBenchStack,
  principal: BenchPrincipal,
  target: Target,
  key: string,
): Promise<{ sample: AdmissionSample; runId: string | null }> {
  const started = performance.now();
  let response: HttpResult;
  try {
    response = await stack.client.call("POST", "/v1/runs", {
      token: principal.token,
      headers: { "idempotency-key": key },
      body: {
        testId: target.testId,
        environmentId: target.environmentId,
        mode: "replay",
        healingPolicy: "off",
        origin: "api",
        limits: { maxAttempts: 2 },
      },
    });
  } catch (error) {
    return {
      sample: {
        outcome: "transport_error",
        status: null,
        ms: performance.now() - started,
        reasonCode: null,
        atMs: Date.now(),
        retryAfter: false,
        queued: null,
        limit: null,
        detail: describeTransportFailure(error),
      },
      runId: null,
    };
  }
  const body = parseBody(response);
  const outcome = classifyAdmission(response.status, body);
  const queue =
    outcome === "accepted" ? jsonAt(body, "data", "queue") : jsonAt(body, "error", "details");
  const runId = jsonAt(body, "data", "runId");
  return {
    sample: {
      outcome,
      status: response.status,
      ms: response.ms,
      reasonCode: outcome === "retryable_refusal" ? retryableReason(body) : null,
      atMs: Date.now(),
      retryAfter: response.headers["retry-after"] !== undefined,
      queued: numeric(jsonAt(queue, "queued")),
      limit: numeric(jsonAt(queue, "limit")),
      detail:
        outcome === "server_error" || outcome === "refused_other"
          ? describeResponse(response)
          : null,
    },
    runId: typeof runId === "string" ? runId : null,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Observation helpers                                                                            */
/* -------------------------------------------------------------------------------------------- */

const safeLiteral = (value: string): string => {
  if (!/^[A-Za-z0-9_.:+-]+$/u.test(value)) throw new Error(`Unsafe SQL literal ${value}`);
  return `'${value}'`;
};

interface Observer {
  readonly stack: DistributedBenchStack;
  readonly fixture: Fixture;
  /** False when the probe Run's evidence object was not found where the layout rule says it is. */
  evidenceLayoutVerified: boolean;
}

async function fetchAudit(observer: Observer, fromMs: number, toMs: number): Promise<AuditRow[]> {
  const rows = await observer.stack.sql<{
    run_id: string;
    run_created_at: string;
    run_phase: string;
    run_outcome: string | null;
    run_gate: string | null;
    attempt_id: string | null;
    attempt_number: number | null;
    worker_id: string | null;
    attempt_phase: string | null;
    attempt_outcome: string | null;
    ended_at: string | null;
  }>(
    `SELECT r.id AS run_id, r.created_at AS run_created_at, r.phase AS run_phase, r.outcome AS run_outcome, r.gate AS run_gate,
       a.id AS attempt_id, a.number AS attempt_number, a.worker_id, a.phase AS attempt_phase,
       a.outcome AS attempt_outcome, a.ended_at
     FROM runs r LEFT JOIN attempts a ON a.workspace_id=r.workspace_id AND a.run_id=r.id
     WHERE r.workspace_id=${safeLiteral(observer.stack.workspaceId)}
       AND r.created_at >= ${safeLiteral(iso(fromMs))} AND r.created_at < ${safeLiteral(iso(toMs))}
     ORDER BY r.created_at, r.id, a.number`,
  );
  return rows.map((row) => ({
    runId: row.run_id,
    runCreatedAt: row.run_created_at,
    runPhase: row.run_phase,
    runOutcome: row.run_outcome,
    runGate: row.run_gate,
    attemptId: row.attempt_id,
    attemptNumber: row.attempt_number,
    workerId: row.worker_id,
    attemptPhase: row.attempt_phase,
    attemptOutcome: row.attempt_outcome,
    endedAt: row.ended_at,
  }));
}

async function fetchTimings(observer: Observer, fromMs: number) {
  const rows = await observer.stack.sql<{ aggregate_id: string; payload: string }>(
    `SELECT aggregate_id, data_json AS payload FROM outbox
     WHERE workspace_id=${safeLiteral(observer.stack.workspaceId)} AND type='attempt.timing'
       AND created_at >= ${safeLiteral(iso(fromMs))}
     ORDER BY created_at`,
  );
  return aggregateTimings(
    rows.map((row) => ({ runId: row.aggregate_id, payload: JSON.parse(row.payload) as unknown })),
  );
}

/** Waits until no Run of the window is open, up to `timeoutMs`; returns the last audit. */
async function settle(observer: Observer, fromMs: number, timeoutMs: number): Promise<AuditRow[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await fetchAudit(observer, fromMs, Date.now() + 1000);
    if (auditRuns(rows).unresolved.length === 0 || Date.now() >= deadline) return rows;
    await sleep(5000);
  }
}

/**
 * Runs whose assertions passed but whose evidence gate did not: the product's record that the
 * evidence could not be published (for example while the bucket was down). Their `outcome` stays
 * `passed`, so a reader of `outcome` alone would take them for complete passes.
 */
export function gateFailedPasses(rows: readonly AuditRow[]): AuditRow[] {
  const found = new Map<string, AuditRow>();
  for (const row of rows)
    if (row.runPhase === "completed" && row.runOutcome === "passed" && row.runGate !== "passed")
      found.set(row.runId, row);
  return [...found.values()];
}

/** Runs that passed with their gate passed, with the Attempt whose bundle carries their evidence. */
export function passedAttempts(rows: readonly AuditRow[]): Map<string, AuditRow> {
  const passed = new Map<string, AuditRow>();
  for (const row of rows)
    if (
      row.runPhase === "completed" &&
      row.runOutcome === "passed" &&
      row.runGate === "passed" &&
      row.attemptOutcome === "passed" &&
      row.attemptId
    )
      passed.set(row.runId, row);
  return passed;
}

const storeAttempts = 3;

/** Retries a store call that threw (a connection reset, a proxy hiccup); an absent object is an answer, not a throw. */
async function withStoreRetries<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= storeAttempts) throw error;
      await sleep(1000);
    }
  }
}

/** What a HEAD said: present with its size, absent, or the failure when the store did not answer. */
export async function headResult(
  evidence: EvidenceReader,
  key: string,
): Promise<{ present: boolean | null; text: string }> {
  try {
    const head = await withStoreRetries(() => evidence.head(key));
    return head
      ? { present: true, text: `present, ${head.sizeBytes} bytes` }
      : { present: false, text: "absent (NotFound)" };
  } catch (error) {
    return { present: null, text: `store error: ${String(error)}` };
  }
}

async function readWhole(
  evidence: EvidenceReader,
  key: string,
  limit: number,
): Promise<Buffer | null> {
  const body = await evidence.get(key);
  if (!body) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error(`${key} is larger than ${limit} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Checks a bundle the way a reader of the evidence does: both commit objects exist, the manifest
 * hashes to what `meta.json` committed, and every available artifact has the size and SHA-256 the
 * manifest lists. Reads only the S3 API.
 */
export async function verifyEvidenceBundle(
  evidence: EvidenceReader,
  bundleKey: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const [metaBytes, manifestBytes] = await withStoreRetries(async () => [
      await readWhole(evidence, `${bundleKey}/meta.json`, 1024 * 1024),
      await readWhole(evidence, `${bundleKey}/manifest.json`, 16 * 1024 * 1024),
    ]);
    if (!metaBytes) return { ok: false, detail: "meta.json is absent" };
    if (!manifestBytes) return { ok: false, detail: "manifest.json is absent" };
    const meta: unknown = JSON.parse(metaBytes.toString("utf8"));
    const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
    if (jsonAt(meta, "manifestHash") !== sha256(canonicalJson(manifest)))
      return { ok: false, detail: "the manifest does not hash to meta.manifestHash" };
    const entries = jsonAt(manifest, "entries");
    if (!Array.isArray(entries))
      return { ok: false, detail: "the manifest lists no entries array" };
    let artifacts = 0;
    for (const entry of entries) {
      if (jsonAt(entry, "state") !== "available") continue;
      const path = jsonAt(entry, "relativePath");
      if (typeof path !== "string") return { ok: false, detail: "an entry has no relativePath" };
      const body = await withStoreRetries(() => evidence.get(`${bundleKey}/${path}`));
      if (!body) return { ok: false, detail: `artifact ${path} is absent` };
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of body) {
        size += chunk.byteLength;
        hash.update(chunk);
      }
      if (size !== jsonAt(entry, "sizeBytes") || hash.digest("hex") !== jsonAt(entry, "sha256"))
        return { ok: false, detail: `artifact ${path} differs from its manifest entry` };
      artifacts++;
    }
    return { ok: true, detail: `manifest hash and ${artifacts} artifact(s) verified` };
  } catch (error) {
    return { ok: false, detail: `bundle unreadable: ${String(error)}` };
  }
}

/** A passed Run whose manifest is not in the bucket, with what the store says about its bundle now. */
export interface MissingEvidence {
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptEndedAt: string | null;
  readonly manifestHead: string;
  readonly metaHead: string;
  readonly bundleVerification: string;
}

export interface EvidenceAudit {
  readonly checked: number;
  readonly missing: readonly MissingEvidence[];
  /** Runs whose manifest could not be looked up because the store did not answer. */
  readonly unreadable: readonly string[];
}

/**
 * Passed Runs whose evidence manifest is absent from the bucket (a passed result with nothing
 * behind it). Every missing one is described further so the cause can be told from the result
 * alone: HEAD of manifest and meta, a full bundle verification, and when its Attempt ended.
 */
export async function auditEvidence(
  evidence: EvidenceReader,
  workspaceId: string,
  rows: readonly AuditRow[],
): Promise<EvidenceAudit> {
  const passed = [...passedAttempts(rows).values()];
  const missing: MissingEvidence[] = [];
  const unreadable: string[] = [];
  const bundleKey = (row: AuditRow) => `runs/${workspaceId}/${row.runId}/${row.attemptId}`;
  for (let from = 0; from < passed.length; from += 16) {
    await Promise.all(
      passed.slice(from, from + 16).map(async (row) => {
        const manifest = await headResult(evidence, `${bundleKey(row)}/manifest.json`);
        if (manifest.present === true) return;
        if (manifest.present === null) {
          unreadable.push(row.runId);
          return;
        }
        const meta = await headResult(evidence, `${bundleKey(row)}/meta.json`);
        missing.push({
          runId: row.runId,
          attemptId: row.attemptId ?? "",
          attemptEndedAt: row.endedAt,
          manifestHead: manifest.text,
          metaHead: meta.text,
          bundleVerification: (await verifyEvidenceBundle(evidence, bundleKey(row))).detail,
        });
      }),
    );
  }
  return { checked: passed.length, missing, unreadable };
}

async function scheduleFirings(observer: Observer, scheduleId: string) {
  const rows = await observer.stack.sql<{
    schedule_id: string;
    revision: number;
    fire_instant: string;
  }>(
    `SELECT schedule_id, revision, fire_instant FROM schedule_firings WHERE workspace_id=${safeLiteral(observer.stack.workspaceId)} AND schedule_id=${safeLiteral(scheduleId)} ORDER BY fire_instant`,
  );
  return rows.map((row) => ({
    scheduleId: row.schedule_id,
    revision: Number(row.revision),
    fireInstant: row.fire_instant,
  }));
}

const services = ["server", "server-2", "postgres", "minio", "caddy"] as const;

async function readCgroup(containerId: string) {
  for (const base of [
    `/sys/fs/cgroup/system.slice/docker-${containerId}.scope`,
    `/sys/fs/cgroup/docker/${containerId}`,
  ]) {
    try {
      const cpu = await readFile(join(base, "cpu.stat"), "utf8");
      const memory = Number((await readFile(join(base, "memory.current"), "utf8")).trim());
      const memoryStat = await readFile(join(base, "memory.stat"), "utf8");
      const usage = /^usage_usec (\d+)/mu.exec(cpu)?.[1];
      const anon = /^anon (\d+)/mu.exec(memoryStat)?.[1];
      return {
        cpuSeconds: usage ? Number(usage) / 1e6 : null,
        memoryBytes: Number.isFinite(memory) ? memory : null,
        anonBytes: anon ? Number(anon) : null,
      };
    } catch {
      // Try the next cgroup layout.
    }
  }
  return null;
}

/** Objects and bytes in the bucket as the S3 listing reports them; null when the store cannot answer. */
async function bucketStats(
  evidence: EvidenceReader,
): Promise<{ bytes: number; objects: number } | null> {
  try {
    let bytes = 0;
    let objects = 0;
    for await (const object of evidence.list("")) {
      bytes += object.sizeBytes;
      objects++;
    }
    return { bytes, objects };
  } catch {
    return null;
  }
}

async function containerStates(stack: DistributedBenchStack) {
  const states: Record<string, { restartCount: number; startedAt: string; running: boolean }> = {};
  for (const service of services) {
    const id = await stack.containerId(service);
    if (!id) continue;
    const out = await exec("docker", [
      "inspect",
      "--format",
      "{{.RestartCount}}|{{.State.StartedAt}}|{{.State.Running}}",
      id,
    ]).then(
      (result) => result.stdout.trim(),
      () => "",
    );
    const [restartCount, startedAt, running] = out.split("|");
    if (restartCount !== undefined)
      states[service] = {
        restartCount: Number(restartCount),
        startedAt: startedAt ?? "",
        running: running === "true",
      };
  }
  return states;
}

async function sampleResources(
  observer: Observer,
  atSeconds: number,
  runsCompleted: number,
  withBucket: boolean,
): Promise<ResourcePoint> {
  const containers: Record<string, ResourcePoint["containers"][string]> = {};
  for (const service of services) {
    const id = await observer.stack.containerId(service);
    const usage = id ? await readCgroup(id) : null;
    containers[service] = usage ?? { cpuSeconds: null, memoryBytes: null, anonBytes: null };
  }
  const size = await observer.stack
    .sql<{ bytes: string | number }>("SELECT pg_database_size('testmaster') AS bytes")
    .then(
      (rows) => numeric(Number(rows[0]?.bytes)),
      () => null,
    );
  const bucket = withBucket ? await bucketStats(observer.stack.evidence) : null;
  return {
    atSeconds,
    containers,
    postgresBytes: size,
    bucketBytes: bucket?.bytes ?? null,
    bucketObjects: bucket?.objects ?? null,
    runsCompleted,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Phases                                                                                         */
/* -------------------------------------------------------------------------------------------- */

interface Context extends Observer {
  readonly options: CapacityOptions;
  readonly target: Target;
  readonly workers: RemoteWorker[];
  readonly runners: BenchPrincipal[];
  scheduleId: string | null;
  /** The slow fixture of the partition case once it started; its hits belong to the execution bound. */
  slowFixture: Fixture | null;
}

/** Requests every fixture of the run has answered or is serving. */
const targetHits = (context: Context): number =>
  context.fixture.hits() + (context.slowFixture?.hits() ?? 0);

async function principalsFor(context: Context, count: number): Promise<BenchPrincipal[]> {
  while (context.runners.length < count)
    context.runners.push(await context.stack.principals.addRunner());
  return context.runners.slice(0, count);
}

const jsonBody = (result: HttpResult, what: string): unknown => {
  if (result.status >= 300) throw new Error(`${what} failed: ${result.status} ${result.body}`);
  return parseBody(result);
};

async function createTarget(
  stack: DistributedBenchStack,
  fixtureUrl: string,
  name: string,
): Promise<Target> {
  const session = stack.principals.ownerSession;
  const project = jsonAt(
    jsonBody(await session("POST", "/v1/projects", { name }), "project"),
    "data",
    "id",
  );
  const environment = jsonAt(
    jsonBody(
      await session("POST", `/v1/projects/${project}/environments`, {
        name: "loopback fixture",
        baseUrl: fixtureUrl,
        networkProfile: "local-loopback",
      }),
      "environment",
    ),
    "data",
    "id",
  );
  const test = jsonAt(
    jsonBody(
      await session("POST", `/v1/projects/${project}/tests`, {
        plan: planFor(`${name} health`),
        origin: "manual",
      }),
      "test",
    ),
    "data",
    "id",
  );
  if (typeof project !== "string" || typeof environment !== "string" || typeof test !== "string")
    throw new Error("Project, environment or test creation returned no id");
  return { projectId: project, environmentId: environment, testId: test };
}

/** Per-operation measurement through the public address: ops/s and percentiles with n. */
async function measureOperation(
  label: string,
  concurrency: number,
  iterations: number,
  call: () => Promise<HttpResult>,
) {
  const loop = await closedLoop({ concurrency, iterations, maxMs: 120_000 }, async () => {
    try {
      const response = await call();
      return [
        { label, ms: response.ms, ok: response.status === 200, status: response.status },
      ] satisfies Sample[];
    } catch {
      return [{ label, ms: 0, ok: false, status: "error" as const }] satisfies Sample[];
    }
  });
  const ok = loop.samples.filter((sample) => sample.ok);
  const statusCounts: Record<string, number> = {};
  for (const sample of loop.samples)
    statusCounts[String(sample.status)] = (statusCounts[String(sample.status)] ?? 0) + 1;
  return {
    operation: label,
    concurrency,
    requests: loop.samples.length,
    errors: loop.samples.length - ok.length,
    statusCounts,
    truncatedByTime: loop.truncated,
    wallSeconds: rounded(loop.wallMs / 1000),
    opsPerSecond: loop.wallMs > 0 ? rounded((ok.length * 1000) / loop.wallMs) : null,
    latency: summarizePercentiles(ok.map((sample) => sample.ms)),
  };
}

async function phaseThroughput(context: Context, referenceRunId: string) {
  const { options, stack } = context;
  const token = stack.owner.token;
  // Each principal may admit about one Run per second, so the pool grows with the highest level.
  const principals = await principalsFor(
    context,
    Math.max(4, Math.max(...options.concurrency) * 2),
  );
  const levels = [];
  for (const concurrency of options.concurrency) {
    const driver = new RunDriver(stack, principals, context.target);
    const hitsBefore = context.fixture.hits();
    const startMs = Date.now();
    await driver.run(concurrency, () => false, options.runsPerLevel);
    const endMs = Math.max(
      startMs + 1,
      ...driver.records.map((record) => record.completedAtMs ?? startMs),
    );
    const rows = await settle(context, startMs - 1000, 120_000);
    const mine = new Set(driver.records.map((record) => record.runId));
    const own = rows.filter((row) => mine.has(row.runId));
    const audit = auditRuns(own);
    const timings = await fetchTimings(context, startMs - 1000);
    const completed = driver.completed;
    levels.push({
      concurrency,
      window: windowOf(startMs, endMs),
      runs: {
        requested: options.runsPerLevel,
        admitted: driver.records.length,
        completed,
        byOutcome: audit.byOutcome,
        unresolved: audit.unresolved.length,
      },
      runsPerMinute: runsPerMinute(completed, endMs - startMs),
      admission: summarizePercentiles(driver.records.map((record) => record.admissionMs)),
      admissionAccounting: summarizeAdmissions(driver.admissions),
      clientObservedAdmittedToCompleted: summarizePercentiles(
        driver.records.flatMap((record) =>
          record.completedAtMs === null ? [] : [record.completedAtMs - record.admittedAtMs],
        ),
      ),
      decomposition: decomposeRuns(wallTimes(own), timings, context.fixture.meanServiceMs()),
      targetRequests: context.fixture.hits() - hitsBefore,
      pollErrors: driver.pollErrors,
      auditViolations: audit.violations,
    });
  }
  // API operations through Caddy: the controllers' own request path, with the workers idle.
  const operations = [];
  const probes: [string, () => Promise<HttpResult>][] = [
    ["health_live", () => stack.client.call("GET", "/v1/health/live", { token: null })],
    [
      "project_detail",
      () => stack.client.call("GET", `/v1/projects/${context.target.projectId}`, { token }),
    ],
    ["run_detail", () => stack.client.call("GET", `/v1/runs/${referenceRunId}`, { token })],
    [
      "run_bundle_manifest",
      () => stack.client.call("GET", `/v1/runs/${referenceRunId}/bundle`, { token }),
    ],
    ["list_runs_first_page", () => stack.client.call("GET", "/v1/runs?limit=50", { token })],
  ];
  for (const concurrency of [1, 4, 8])
    for (const [label, call] of probes) {
      const startMs = Date.now();
      const result = await measureOperation(label, concurrency, options.apiIterations, call);
      operations.push({ ...result, window: windowOf(startMs, Date.now()) });
    }
  return { levels, apiOperations: operations };
}

async function phaseSoak(context: Context): Promise<SoakResult> {
  const { options, stack } = context;
  const principals = await principalsFor(context, Math.max(4, options.soakConcurrency * 2));
  const driver = new RunDriver(stack, principals, context.target);
  const soakMs = options.soakMinutes * 60_000;
  const startMs = Date.now();
  const hitsBefore = context.fixture.hits();
  const statesBefore = await containerStates(stack);
  const points: ResourcePoint[] = [await sampleResources(context, 0, 0, true)];
  let sampling = true;
  const sampler = (async () => {
    let tick = 0;
    while (sampling) {
      await sleep(options.sampleSeconds * 1000);
      if (!sampling) break;
      tick++;
      points.push(
        await sampleResources(
          context,
          (Date.now() - startMs) / 1000,
          driver.completed,
          tick % 4 === 0,
        ),
      );
    }
  })();
  await driver.run(options.soakConcurrency, () => Date.now() - startMs >= soakMs);
  sampling = false;
  await sampler;
  const endMs = Date.now();
  points.push(await sampleResources(context, (endMs - startMs) / 1000, driver.completed, true));
  const statesAfter = await containerStates(stack);
  const rows = await settle(context, startMs - 1000, 300_000);
  const mine = new Set(driver.records.map((record) => record.runId));
  const own = rows.filter((row) => mine.has(row.runId));
  const audit = auditRuns(own);
  const everything = auditRuns(rows);
  const timings = await fetchTimings(context, startMs - 1000);
  const evidence = context.evidenceLayoutVerified
    ? await auditEvidence(context.stack.evidence, context.stack.workspaceId, own)
    : null;
  const restarts = Object.entries(statesAfter).flatMap(([service, after]) => {
    const before = statesBefore[service];
    return before &&
      (after.restartCount !== before.restartCount || after.startedAt !== before.startedAt)
      ? [service]
      : [];
  });
  // Nothing is faulted during the soak, so even the designed storage_unavailable refusal is an error.
  const soakTally = summarizeAdmissions(driver.admissions);
  const apiErrors =
    soakTally.crashes +
    soakTally.storageUnavailable +
    Object.values(driver.pollErrors).reduce((sum, count) => sum + count, 0);
  const passedRuns = audit.byOutcome.passed ?? 0;
  const nonPassed = audit.runs - audit.unresolved.length - passedRuns;
  const judgement = judgeSoak({
    requestedSeconds: options.soakMinutes * 60,
    actualSeconds: (endMs - startMs) / 1000,
    runs: driver.completed,
    nonPassedRuns: nonPassed,
    unresolvedRuns: audit.unresolved.length,
    apiErrors,
    violations:
      everything.violations.length +
      (evidence ? evidence.missing.length + evidence.unreadable.length : 0) +
      gateFailedPasses(own).length,
    containerRestarts: restarts.length,
  });
  const walls = wallTimes(own);
  const firings = context.scheduleId ? await scheduleFirings(context, context.scheduleId) : [];
  const resources = summarizeResources(points);
  return {
    window: windowOf(startMs, endMs),
    concurrency: options.soakConcurrency,
    slotsAvailable: options.workers * options.slots,
    runs: {
      admitted: driver.records.length,
      completed: driver.completed,
      byOutcome: audit.byOutcome,
      retried: audit.retriedRuns,
      unresolved: audit.unresolved.length,
    },
    runsPerMinute: runsPerMinute(driver.completed, endMs - startMs),
    admission: summarizePercentiles(driver.records.map((record) => record.admissionMs)),
    admissionAccounting: summarizeAdmissions(driver.admissions),
    decomposition: decomposeRuns(walls, timings, context.fixture.meanServiceMs()),
    errors: {
      apiErrors,
      pollErrors: driver.pollErrors,
      pollFailures: driver.pollFailures,
      designedRetryable: {
        admissions: soakTally.retryableReasons,
        polls: driver.pollRetryable,
      },
      nonPassedRuns: nonPassed,
      auditViolations: everything.violations,
      passedRunsWithoutEvidence: evidence?.missing ?? null,
      passedRunsWithFailedGate: gateFailedPasses(own).map((row) => row.runId),
      evidenceChecked: evidence?.checked ?? null,
      evidenceUnreadable: evidence?.unreadable ?? null,
      scheduleFirings: firings.length,
      duplicateScheduleFirings: duplicateFirings(firings),
    },
    containerRestarts: restarts,
    targetRequests: context.fixture.hits() - hitsBefore,
    sampleIntervalSeconds: options.sampleSeconds,
    resourceSamples: points,
    drift: resources,
    verdict: judgement.verdict,
    verdictReason: judgement.reason,
  };
}

/** One chaos case as recorded: its invariants and the verdict they give, plus the case's own facts. */
interface ChaosResult {
  readonly case: string;
  readonly checks: Check[];
  readonly verdict: Verdict;
  readonly verdictReason: string;
  readonly [key: string]: unknown;
}

interface SoakResult {
  readonly window: { readonly seconds: number | null; readonly [key: string]: unknown };
  readonly concurrency: number;
  readonly slotsAvailable: number;
  readonly runs: { readonly completed: number; readonly [key: string]: unknown };
  readonly admission: Percentiles;
  readonly decomposition: RunDecomposition;
  readonly verdict: Verdict;
  readonly verdictReason: string;
  readonly [key: string]: unknown;
}

interface BackpressureResult {
  readonly queueBound: unknown;
  readonly verdict: Verdict;
  readonly verdictReason: string;
  readonly [key: string]: unknown;
}

interface ChaosOutcome {
  /** Where a failed evidence gate is expected (a storage outage); absent when none is. */
  readonly outageWindow?: OutageWindow;
  readonly checks: Check[];
  readonly facts: Record<string, unknown>;
}

/**
 * Common frame of a chaos case: load runs throughout, a prober watches the public address, the
 * fault is induced after a baseline, load continues after recovery, then every Run of the window is
 * audited once all are terminal (or the settle time passes, which is itself a finding).
 */
async function chaosCase(
  context: Context,
  name: string,
  induce: (frame: {
    driver: RunDriver;
    probe: () => ProbeSample[];
    startMs: number;
  }) => Promise<ChaosOutcome & { inducedAtMs: number }>,
): Promise<ChaosResult> {
  const { options, stack } = context;
  const principals = await principalsFor(context, Math.max(4, options.chaosConcurrency * 2));
  const driver = new RunDriver(stack, principals, context.target);
  const startMs = Date.now();
  const hitsBefore = targetHits(context);
  let stop = false;
  const samples: ProbeSample[] = [];
  let probing = true;
  const prober = (async () => {
    while (probing) {
      const [live, read] = await Promise.all([
        stack.client.call("GET", "/v1/health/live", { token: null }).then(
          (result) => result.status === 200,
          () => false,
        ),
        stack.client
          .call("GET", `/v1/projects/${context.target.projectId}`, { token: stack.owner.token })
          .then(
            (result) => result.status === 200,
            () => false,
          ),
      ]);
      samples.push({ atMs: Date.now(), ok: live && read });
      await sleep(250);
    }
  })();
  const load = driver.run(options.chaosConcurrency, () => stop);
  await sleep(options.chaosBaselineSeconds * 1000);
  let outcome: (ChaosOutcome & { inducedAtMs: number }) | null = null;
  let failure: unknown = null;
  try {
    outcome = await induce({ driver, probe: () => samples, startMs });
    await sleep(options.chaosPostSeconds * 1000);
  } catch (error) {
    failure = error;
    // Leave the stack whole for the next phase whatever step of the fault failed.
    for (const worker of context.workers) worker.process.child.kill("SIGCONT");
    await stack
      .compose("up", "-d", "--wait", "minio", "server", "server-2", "caddy")
      .catch(() => undefined);
  }
  stop = true;
  await load;
  probing = false;
  await prober;
  const rows = await settle(context, startMs - 1000, 300_000);
  const audit = auditRuns(rows);
  const attemptsStarted = rows.filter((row) => row.attemptId !== null).length;
  const bound = executionBound(targetHits(context) - hitsBefore, attemptsStarted);
  const evidence = context.evidenceLayoutVerified
    ? await auditEvidence(context.stack.evidence, context.stack.workspaceId, rows)
    : null;
  const firings = context.scheduleId ? await scheduleFirings(context, context.scheduleId) : [];
  const outage = outageSummary(samples, outcome?.inducedAtMs ?? startMs);
  const admissionTally = summarizeAdmissions(driver.admissions);
  const unexpected =
    admissionTally.crashes +
    Object.entries(driver.pollErrors).reduce(
      (sum, [status, count]) =>
        status === "transport_error" || Number(status) >= 500 ? sum + count : sum,
      0,
    );
  const checks: Check[] = [
    ...(failure
      ? [
          {
            name: "fault_induced",
            ok: false,
            detail: failure instanceof Error ? failure.message : String(failure),
          },
        ]
      : (outcome?.checks ?? [])),
    {
      name: "runs_truthful",
      ok: audit.violations.length === 0,
      detail: audit.violations.length
        ? audit.violations.map((v) => `${v.runId} ${v.rule}`).join(", ")
        : `${audit.runs} Run(s) audited, 0 violations`,
    },
    {
      name: "runs_resolved",
      ok: audit.unresolved.length === 0,
      detail: `${audit.unresolved.length} Run(s) not terminal after settling`,
    },
    {
      name: "no_duplicate_execution",
      ok: bound.ok,
      detail: `${bound.targetRequests} target request(s) for ${bound.attemptsStarted} Attempt(s)`,
    },
    {
      name: "no_duplicate_schedule_firing",
      ok: duplicateFirings(firings) === 0,
      detail: `${duplicateFirings(firings)} duplicate(s) among ${firings.length} firing(s)`,
    },
    {
      name: "passed_runs_have_evidence",
      ok: evidence
        ? evidence.missing.length > 0
          ? false
          : evidence.unreadable.length > 0
            ? null
            : true
        : null,
      detail: evidence
        ? `${evidence.missing.length} of ${evidence.checked} passed Run(s) without a manifest in the bucket${evidence.unreadable.length ? `, ${evidence.unreadable.length} could not be looked up (store error)` : ""}`
        : "the object layout probe failed at warm-up, so the bucket cannot be checked",
    },
    judgeGateFailedPasses(rows, outcome?.outageWindow ?? null),
    {
      name: "load_continued",
      ok: driver.completed > 0,
      detail: `${driver.completed} Run(s) completed during the case`,
    },
    {
      name: "no_unexpected_server_errors",
      ok: unexpected === 0,
      detail: `${admissionTally.crashes} admission(s) ended in an unexpected 5xx or no answer, ${unexpected - admissionTally.crashes} poll(s) did; ${admissionTally.storageUnavailable} storage_unavailable and ${admissionTally.retryableRefusals + Object.values(driver.pollRetryable).reduce((sum, count) => sum + count, 0)} other retryable server refusal(s) are designed and not counted`,
    },
  ];
  const judgement = judgeChecks(checks);
  return {
    case: name,
    window: windowOf(startMs, Date.now()),
    concurrency: options.chaosConcurrency,
    runs: {
      admitted: driver.records.length,
      completed: driver.completed,
      audited: audit.runs,
      byOutcome: audit.byOutcome,
      retried: audit.retriedRuns,
    },
    client: {
      admissionAccounting: summarizeAdmissions(driver.admissions),
      unexpectedAnswers: unexpectedAnswers(driver.admissions),
      pollErrors: driver.pollErrors,
      pollFailures: driver.pollFailures,
      designedRetryable: {
        admissions: admissionTally.retryableReasons,
        polls: driver.pollRetryable,
      },
      availability: outage,
    },
    ...(outcome?.facts ?? {}),
    evidence: evidence
      ? {
          checked: evidence.checked,
          unreadable: evidence.unreadable,
          gateFailedPasses: gateFailedPasses(rows).map((row) => ({
            runId: row.runId,
            attemptEndedAt: row.endedAt,
            gate: row.runGate,
          })),
          // Where each missing Run's Attempt ended relative to the fault, to place it before, in or
          // after the outage window.
          missing: evidence.missing.map((entry) => ({
            ...entry,
            attemptEndedMsAfterInduced: entry.attemptEndedAt
              ? Date.parse(entry.attemptEndedAt) - (outcome?.inducedAtMs ?? startMs)
              : null,
          })),
        }
      : null,
    checks,
    verdict: judgement.verdict,
    verdictReason: judgement.reason,
  };
}

async function activeRemoteAttempts(context: Context) {
  return context.stack.sql<{
    attempt_id: string;
    run_id: string;
    worker_id: string;
    controller_id: string;
  }>(
    `SELECT attempt_id, run_id, worker_id, controller_id FROM remote_attempts WHERE state='active'`,
  );
}

async function chaosKillController(context: Context) {
  const { stack, options } = context;
  return chaosCase(context, "controller_kill", async () => {
    const live = await stack.liveControllers();
    const active = await activeRemoteAttempts(context);
    const readLeases = () =>
      stack.sql<{ name: string; holder: string; fence: number }>(
        "SELECT name, holder, fence FROM controller_leases ORDER BY name",
      );
    const holdersOf = (rows: readonly { holder: string }[]) => {
      const counts = new Map<string, number>();
      for (const row of rows) counts.set(row.holder, (counts.get(row.holder) ?? 0) + 1);
      return counts;
    };
    // The victim is the live controller holding the most elected leases (scheduler, lease reconciler,
    // ...): its death is the only one whose lease move can be observed. A remote Attempt's relay
    // is not a lease, so Attempts on the victim are recorded but do not choose it.
    let leases = await readLeases();
    for (
      let waited = 0;
      waited < 30_000 && !live.some((controller) => holdersOf(leases).has(controller.id));
      waited += 1000
    ) {
      await sleep(1000);
      leases = await readLeases();
    }
    const leaseCounts = holdersOf(leases);
    const byLeases = [...live].sort(
      (a, b) => (leaseCounts.get(b.id) ?? 0) - (leaseCounts.get(a.id) ?? 0),
    )[0];
    const victimController = byLeases && leaseCounts.has(byLeases.id) ? byLeases : live[0];
    if (!victimController) throw new Error("No live controller to kill");
    const victim: ControllerName = victimController.name;
    const survivor = controllerNames.find((name) => name !== victim) ?? "server";
    const heldByVictim = leases.filter((lease) => lease.holder === victimController.id);
    const attemptsOnVictim = active.filter((row) => row.controller_id === victimController.id);
    // The compose file restarts a killed container (`unless-stopped`); the policy is switched off for
    // the victim so it stays down for the whole hold, and restored once it is started again.
    const victimContainer = await stack.containerId(victim);
    if (!victimContainer) throw new Error(`No running container for ${victim}`);
    await exec("docker", ["update", "--restart=no", victimContainer]);
    const killedAt = Date.now();
    // SIGKILL: no graceful release; only the lease term frees what the victim held.
    await stack.compose("kill", victim);
    let leasesMovedMs: number | null = heldByVictim.length ? null : 0;
    while (leasesMovedMs === null && Date.now() - killedAt < 150_000) {
      await sleep(1000);
      const now = await stack.sql<{ name: string; holder: string; fence: number }>(
        "SELECT name, holder, fence FROM controller_leases ORDER BY name",
      );
      const moved = heldByVictim.every((old) => {
        const current = now.find((lease) => lease.name === old.name);
        return (
          current !== undefined &&
          current.holder !== victimController.id &&
          Number(current.fence) > Number(old.fence)
        );
      });
      if (moved) leasesMovedMs = Date.now() - killedAt;
    }
    const downFor = options.killDownSeconds * 1000 - (Date.now() - killedAt);
    if (downFor > 0) await sleep(downFor);
    const restartedAt = Date.now();
    await stack.compose("up", "-d", "--wait", victim);
    await exec("docker", ["update", "--restart=unless-stopped", victimContainer]);
    let reregisteredMs: number | null = null;
    let newId: string | null = null;
    while (Date.now() - restartedAt < 120_000) {
      const now = await stack.liveControllers();
      const back = now.find((controller) => controller.name === victim);
      if (back && back.id !== victimController.id && now.length === controllerNames.length) {
        reregisteredMs = Date.now() - restartedAt;
        newId = back.id;
        break;
      }
      await sleep(1000);
    }
    const checks: Check[] = [
      {
        name: "leases_moved_with_higher_fence",
        ok: heldByVictim.length === 0 ? null : leasesMovedMs !== null,
        detail: heldByVictim.length
          ? leasesMovedMs === null
            ? `leases ${heldByVictim.map((lease) => lease.name).join(", ")} did not move within 150 s`
            : `leases ${heldByVictim.map((lease) => lease.name).join(", ")} moved to ${survivor} in ${leasesMovedMs} ms`
          : "the killed controller held no lease, so a lease move could not be observed",
      },
      {
        name: "controller_reregistered",
        ok: reregisteredMs !== null,
        detail:
          reregisteredMs === null
            ? "the restarted controller did not register within 120 s"
            : `registered as ${newId} after ${reregisteredMs} ms`,
      },
    ];
    return {
      inducedAtMs: killedAt,
      checks,
      facts: {
        fault: {
          induced: `docker compose kill ${victim} (SIGKILL), held down ${options.killDownSeconds} s, then docker compose up -d --wait ${victim}`,
          victim,
          victimControllerId: victimController.id,
          survivor,
          chosenBecause: heldByVictim.length
            ? `held the most elected leases (${heldByVictim.length})`
            : "no controller held a lease within 30 s; first live controller",
          leasesHeldByVictim: heldByVictim,
          remoteAttemptsOnVictim: attemptsOnVictim.map((row) => ({
            attemptId: row.attempt_id,
            runId: row.run_id,
            workerId: row.worker_id,
          })),
        },
        recovery: { leasesMovedMs, controllerReregisteredMs: reregisteredMs },
      },
    };
  });
}

async function chaosRestartMinio(context: Context) {
  const { stack, options } = context;
  return chaosCase(context, "minio_restart", async ({ driver }) => {
    const before = await bucketStats(stack.evidence);
    const stoppedAt = Date.now();
    await stack.compose("stop", "minio");
    const readinessDuringOutage: (number | string)[] = [];
    for (let waited = 0; waited < options.minioOutageSeconds * 1000; waited += 5000) {
      await sleep(Math.min(5000, options.minioOutageSeconds * 1000 - waited));
      readinessDuringOutage.push(
        await stack.client.call("GET", "/v1/health/ready", { token: stack.owner.token }).then(
          (result) => result.status,
          () => "transport_error",
        ),
      );
    }
    const startedAt = Date.now();
    await stack.compose("up", "-d", "--wait", "minio");
    const healthyAt = Date.now();
    const firstPassed = await (async () => {
      for (let waited = 0; waited < options.chaosPostSeconds * 1000; waited += 1000) {
        const found = driver.records.find(
          (record) =>
            record.outcome === "passed" &&
            record.completedAtMs !== null &&
            record.completedAtMs > healthyAt,
        );
        if (found?.completedAtMs) return found.completedAtMs - startedAt;
        await sleep(1000);
      }
      return null;
    })();
    const after = await bucketStats(stack.evidence);
    const storageRefusals = summarizeAdmissions(driver.admissions).storageUnavailable;
    const acceptedAfter = driver.records.some((record) => record.admittedAtMs > healthyAt);
    const checks: Check[] = [
      {
        name: "service_recovered",
        ok: firstPassed !== null,
        detail:
          firstPassed === null
            ? `no Run passed within ${options.chaosPostSeconds} s of MinIO being healthy again`
            : `first passed Run completed ${firstPassed} ms after MinIO was started`,
      },
      {
        name: "stored_objects_survived",
        ok: before && after ? after.objects >= before.objects : null,
        detail:
          before && after
            ? `${before.objects} object(s) before, ${after.objects} after`
            : "the bucket listing failed",
      },
      {
        name: "admission_refused_by_design_while_down",
        ok: storageRefusals > 0 ? true : null,
        detail:
          storageRefusals > 0
            ? `${storageRefusals} admission(s) answered UNAVAILABLE/storage_unavailable while the bucket was down`
            : "no admission was refused with storage_unavailable, so the designed refusal was not observed",
      },
      {
        name: "admission_accepted_after_recovery",
        ok: acceptedAfter,
        detail: acceptedAfter
          ? "a Run was admitted after MinIO was healthy again"
          : `no admission was accepted within ${options.chaosPostSeconds} s of MinIO being healthy again`,
      },
    ];
    return {
      inducedAtMs: stoppedAt,
      // Runs finishing between the stop and the moment the bucket answered cannot publish evidence.
      outageWindow: { fromMs: stoppedAt, toMs: healthyAt + 2000 },
      checks,
      facts: {
        fault: {
          induced: `docker compose stop minio, held ${options.minioOutageSeconds} s, then docker compose up -d --wait minio`,
          outageSeconds: options.minioOutageSeconds,
          stoppedAt: iso(stoppedAt),
          startedAt: iso(startedAt),
          healthyAt: iso(healthyAt),
          readinessStatusDuringOutage: readinessDuringOutage,
          storageUnavailableRefusals: storageRefusals,
          objectsBefore: before?.objects ?? null,
          objectsAfter: after?.objects ?? null,
        },
        recovery: {
          minioHealthyAfterMs: healthyAt - startedAt,
          firstPassedRunAfterStartMs: firstPassed,
        },
      },
    };
  });
}

interface FrozenRow {
  attempt_id: string;
  run_id: string;
  state: string;
  lease_expires_at: string | null;
  job_fence: number;
  attempt_fence: number;
}

async function chaosPartitionWorker(context: Context) {
  const { stack, options } = context;
  const startedMs = Date.now();
  let frozen: FrozenAttempt[] = [];
  let resumedAtMs = 0;
  const result = await chaosCase(context, "worker_partition", async () => {
    const mine = new Map(context.workers.map((worker) => [worker.workerId, worker]));
    // Runs of a slow target keep an Attempt in flight for longer than the poll below needs to find
    // it, so the freeze meets leased Attempts instead of racing the fast load Runs to their end.
    const slowFixture = await startFixture(options.partitionTargetDelayMs);
    context.slowFixture = slowFixture;
    const slowTarget = await createTarget(stack, slowFixture.url, "Capacity partition");
    const [slowPrincipal] = await principalsFor(context, 1);
    if (!slowPrincipal) throw new Error("No principal for the partition case");
    const slowRuns = new Set<string>();
    for (let index = 0; index < options.workers * options.slots; index++) {
      const admitted = await admitOnce(stack, slowPrincipal, slowTarget, randomUUID());
      if (admitted.runId) slowRuns.add(admitted.runId);
    }
    let victim: RemoteWorker | null = null;
    for (let waited = 0; waited < 90_000 && !victim; waited += 1000) {
      const active = (await activeRemoteAttempts(context)).filter(
        (row) => mine.has(row.worker_id) && slowRuns.has(row.run_id),
      );
      const first = active[0];
      if (first) victim = mine.get(first.worker_id) ?? null;
      else await sleep(1000);
    }
    const chosen = victim ?? context.workers[0];
    if (!chosen) throw new Error("No remote worker to partition");
    const frozenAt = Date.now();
    chosen.process.child.kill("SIGSTOP");
    // Read after the freeze: an Attempt that finished between choosing the worker and the signal
    // is no longer leased and is not a frozen Attempt, and nothing renews a lease from here on.
    const held = await stack.sql<FrozenRow>(
      `SELECT r.attempt_id, r.run_id, j.state, j.lease_expires_at, j.fence AS job_fence, a.fence AS attempt_fence
       FROM remote_attempts r
       JOIN attempts a ON a.workspace_id=r.workspace_id AND a.id=r.attempt_id
       JOIN job_leases j ON j.workspace_id=a.workspace_id AND j.id=a.job_id
       WHERE r.state='active' AND r.worker_id=${safeLiteral(chosen.workerId)}`,
    );
    const stillLeased = held.filter(
      (row) =>
        row.state === "leased" &&
        row.lease_expires_at !== null &&
        Number(row.job_fence) === Number(row.attempt_fence),
    );
    frozen = stillLeased.map((row) => ({
      attemptId: row.attempt_id,
      runId: row.run_id,
      leaseExpiresAtMs: Date.parse(String(row.lease_expires_at)),
    }));
    let offlineAfterMs: number | null = null;
    while (Date.now() - frozenAt < options.partitionSeconds * 1000) {
      await sleep(2000);
      if (offlineAfterMs === null) {
        const rows = await stack.sql<{ state: string }>(
          `SELECT state FROM workers WHERE workspace_id=${safeLiteral(stack.workspaceId)} AND id=${safeLiteral(chosen.workerId)}`,
        );
        if (rows[0] && rows[0].state !== "ready") offlineAfterMs = Date.now() - frozenAt;
      }
    }
    resumedAtMs = Date.now();
    chosen.process.child.kill("SIGCONT");
    let readyAgainMs: number | null = null;
    while (readyAgainMs === null && Date.now() - resumedAtMs < 120_000) {
      await sleep(2000);
      const rows = await stack.sql<{ state: string; last_heartbeat_at: string | null }>(
        `SELECT state, last_heartbeat_at FROM workers WHERE workspace_id=${safeLiteral(stack.workspaceId)} AND id=${safeLiteral(chosen.workerId)}`,
      );
      const row = rows[0];
      if (
        row?.state === "ready" &&
        row.last_heartbeat_at &&
        Date.parse(row.last_heartbeat_at) > resumedAtMs
      )
        readyAgainMs = Date.now() - resumedAtMs;
    }
    return {
      inducedAtMs: frozenAt,
      // Whether each frozen lease lapsed and moved is judged from the settled rows, below.
      checks: [
        {
          name: "attempt_in_flight_at_freeze",
          ok: frozen.length > 0 ? true : null,
          detail: frozen.length
            ? `${frozen.length} Attempt(s) still leased to the frozen worker right after SIGSTOP`
            : `no Attempt was leased to the frozen worker at the freeze (${held.length} active remote row(s) had already finished)`,
        },
        {
          name: "worker_returned",
          ok: readyAgainMs !== null,
          detail:
            readyAgainMs === null
              ? "the resumed worker did not heartbeat within 120 s"
              : `heartbeating again ${readyAgainMs} ms after SIGCONT`,
        },
      ],
      facts: {
        fault: {
          induced: `SIGSTOP of the remote worker process for ${options.partitionSeconds} s, then SIGCONT; the frozen worker sends no heartbeat and no call, as with a total network loss, while its sandbox container is not stopped`,
          worker: chosen.name,
          workerId: chosen.workerId,
          leaseTtlMs: remoteLeaseTtlMs,
          leaseReconcilerIntervalMs,
          frozenAttempts: frozen.map((attempt) => ({
            ...attempt,
            leaseExpiresAt: iso(attempt.leaseExpiresAtMs),
            lapsedByResume: attempt.leaseExpiresAtMs <= resumedAtMs,
          })),
          activeRemoteRowsAtFreeze: held.length,
          workerLeftReadyAfterMs: offlineAfterMs,
        },
        recovery: { workerHeartbeatingAgainMs: readyAgainMs },
      },
    };
  });
  // The case settled every Run before it returned, so nothing needs the slow target any more.
  await context.slowFixture?.close();
  const rows = await fetchAudit(context, startedMs - 1000, Date.now() + 1000);
  const checks = [...result.checks, judgeFrozenAttempts(frozen, resumedAtMs, rows)];
  const judged = judgeChecks(checks);
  return { ...result, checks, verdict: judged.verdict, verdictReason: judged.reason };
}

async function phaseBackpressure(context: Context): Promise<BackpressureResult> {
  const { stack, options } = context;
  const principals = await principalsFor(context, options.backpressurePrincipals);
  // Stop the workers so nothing drains the queue, then watch admission refuse for lack of a worker.
  for (const worker of context.workers) await stack.stopWorker(worker);
  const stoppedAt = Date.now();
  const noWorker: AdmissionSample[] = [];
  let refusedWithoutWorkerAfterMs: number | null = null;
  const probePrincipal = principals[0];
  if (!probePrincipal) throw new Error("No principal for the backpressure phase");
  while (Date.now() - stoppedAt < 120_000 && refusedWithoutWorkerAfterMs === null) {
    const probe = await admitOnce(stack, probePrincipal, context.target, randomUUID());
    noWorker.push(probe.sample);
    if (probe.sample.outcome === "no_live_worker")
      refusedWithoutWorkerAfterMs = Date.now() - stoppedAt;
    else await sleep(3000);
  }
  // A stand-in presence heartbeat keeps one worker row `ready`, as a pool whose slots are all busy
  // would, so admission is accepted and the queue can fill to its bound.
  const heartbeat = () =>
    stack
      .execSql(
        `UPDATE workers SET state='ready', last_heartbeat_at='${iso(Date.now())}' WHERE workspace_id=${safeLiteral(stack.workspaceId)}`,
      )
      .catch(() => undefined);
  await heartbeat();
  const timer = setInterval(() => void heartbeat(), 5000);
  const samples: AdmissionSample[] = [];
  const reads: number[] = [];
  let readErrors = 0;
  const readRetryable: Record<string, number> = {};
  const startMs = Date.now();
  const timeline: { seconds: number; accepted: number; refused: number; crashes: number }[] = [];
  let overflows = 0;
  let rotation = 0;
  const done = () =>
    overflows >= 30 ||
    Date.now() - startMs >= options.backpressureMaxSeconds * 1000 ||
    samples.length >= 6000;
  let reading = true;
  const reader = (async () => {
    while (reading) {
      const response = await stack.client
        .call("GET", `/v1/projects/${context.target.projectId}`, { token: stack.owner.token })
        .catch(() => null);
      const designed =
        response && response.status >= 500 ? retryableReason(parseBody(response)) : null;
      if (response?.status === 200) reads.push(response.ms);
      else if (designed !== null) readRetryable[designed] = (readRetryable[designed] ?? 0) + 1;
      else readErrors++;
      await sleep(250);
    }
  })();
  const checkpoint = setInterval(() => {
    const tally = summarizeAdmissions(samples);
    timeline.push({
      seconds: rounded((Date.now() - startMs) / 1000) ?? 0,
      accepted: tally.byOutcome.accepted,
      refused: tally.refusals,
      crashes: tally.crashes,
    });
  }, 10_000);
  const bursters = Array.from({ length: Math.min(32, principals.length) }, async () => {
    while (!done()) {
      const principal = principals[rotation++ % principals.length];
      if (!principal) return;
      const result = await admitOnce(stack, principal, context.target, randomUUID());
      samples.push(result.sample);
      if (result.sample.outcome === "queue_overflow") overflows++;
      // A refused client honours Retry-After at most one second: the tool must keep pressing.
      if (result.sample.outcome !== "accepted") await sleep(200);
    }
  });
  await Promise.all(bursters);
  clearInterval(timer);
  clearInterval(checkpoint);
  reading = false;
  await reader;
  const endMs = Date.now();
  const tally = summarizeAdmissions(samples);
  const queued = await stack.sql<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM job_leases WHERE workspace_id=${safeLiteral(stack.workspaceId)} AND queue='local' AND state='queued'`,
  );
  const live = await stack.liveControllers();
  const health = await Promise.all(
    [1, 2, 3].map(() =>
      stack.client.call("GET", "/v1/health/live", { token: null }).then(
        (result) => result.status,
        () => 0,
      ),
    ),
  );
  const states = await containerStates(stack);
  const controllersLive =
    live.length === controllerNames.length &&
    health.every((status) => status === 200) &&
    ["server", "server-2"].every((name) => states[name]?.running === true);
  const judgement = judgeBackpressure(tally, controllersLive);
  const unexpected = unexpectedAnswers(samples);
  // The log lines of the proxy and both controllers that look like errors, kept only when an
  // answer was unexpected: they say whether the 5xx came from the API or from the proxy in front.
  const serverLogs: Record<string, string[]> = {};
  if (unexpected.length)
    for (const service of ["caddy", "server", "server-2"])
      serverLogs[service] = errorLogLines(await stack.logs(service).catch(() => ""));
  return {
    window: windowOf(startMs, endMs),
    method:
      "Workers stopped; a stand-in heartbeat keeps one worker row ready so admission is accepted; 32 closed-loop admissions across runner principals press the queue until 30 queue_overflow refusals, the time cap or 6000 requests",
    admissionWithoutLiveWorker: {
      refusedAfterMs: refusedWithoutWorkerAfterMs,
      accounting: summarizeAdmissions(noWorker),
    },
    admissions: tally,
    unexpectedAnswers: unexpected,
    serverLogs,
    queueBound: {
      limitReported: tally.queueLimitReported,
      maxQueuedReported: tally.maxQueuedReported,
      queuedInDatabaseAtEnd: Number(queued[0]?.n ?? 0),
      reached: tally.byOutcome.queue_overflow > 0,
    },
    readsDuringBurst: {
      latency: summarizePercentiles(reads),
      errors: readErrors,
      retryableRefusals: readRetryable,
    },
    timeline,
    controllersLiveAfter: controllersLive,
    healthLiveAfter: health,
    verdict: judgement.verdict,
    verdictReason: judgement.reason,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Orchestration                                                                                  */
/* -------------------------------------------------------------------------------------------- */

async function containerImages(stack: DistributedBenchStack) {
  const out: Record<string, { image: string; imageId: string }> = {};
  for (const service of services) {
    const id = await stack.containerId(service);
    if (!id) continue;
    const text = await exec("docker", [
      "inspect",
      "--format",
      "{{.Config.Image}}|{{.Image}}",
      id,
    ]).then(
      (result) => result.stdout.trim(),
      () => "",
    );
    const [image, imageId] = text.split("|");
    if (image && imageId) out[service] = { image, imageId };
  }
  return out;
}

/** Where a run stopped: the phase that threw and why, kept in the result instead of the run. */
export interface PhaseFailure {
  readonly phase: string;
  readonly error: string;
}

/** Keeps the thrown message and stack, which is what tells a lapsed session from a server fault afterwards. */
export function describeFailure(phase: string, error: unknown): PhaseFailure {
  return {
    phase,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  };
}

/**
 * Status and reason of a phase that produced no result. The phase that threw is `failed`; every
 * later phase is `not run` and names the failure, so a partial file never reads as a clean skip.
 */
export function absentPhase(
  failure: PhaseFailure | null,
  phase: string,
  fallback: string,
): { status: "failed" | "not run"; reason: string } {
  if (!failure) return { status: "not run", reason: fallback };
  const firstLine = failure.error.split("\n")[0] ?? failure.error;
  return failure.phase === phase
    ? { status: "failed", reason: `The ${phase} phase failed: ${firstLine}` }
    : {
        status: "not run",
        reason: `Not run: the ${failure.phase} phase failed first: ${firstLine}`,
      };
}

function nfrVerdicts(soak: SoakResult | null, soakMissing: string) {
  const none = (id: string, item: string, target: string, reason: string) => ({
    id,
    item,
    target,
    measured: null,
    verdict: "not measured" as Verdict,
    reason,
  });
  if (!soak) {
    const reason = `${soakMissing} These targets are measured from the soak window.`;
    return [
      none("NFR-006/admission-latency", "Admission latency", "p95 < 2 s", reason),
      none("NFR-006/queue-start-lag", "Queue start lag", "p95 < 60 s with slots available", reason),
      none("NFR-006/orchestration-overhead", "Orchestration overhead", "p95 <= 2 s", reason),
      none(
        "NFR-006/artifact-publication",
        "Artifact publication",
        "p95 < 30 s up to 64 MiB",
        reason,
      ),
    ];
  }
  const admission = judgeP95(soak.admission, 2000);
  const queue = judgeP95(soak.decomposition.queue, 60_000);
  const overhead = judgeP95(soak.decomposition.orchestrationOverhead, 2000);
  const collection = judgeP95(soak.decomposition.collection, 30_000);
  return [
    {
      id: "NFR-006/admission-latency",
      item: "Admission latency (POST /v1/runs through Caddy, 2 controllers)",
      target: "p95 < 2 s (specs/08-operations.md 9.2)",
      measured: {
        n: soak.admission.n,
        p95Ms: soak.admission.p95,
        windowSeconds: soak.window.seconds,
      },
      verdict: admission.verdict,
      reason: admission.reason,
    },
    {
      id: "NFR-006/queue-start-lag",
      item: "Queue start lag",
      target: "p95 < 60 s with slots available (specs/08-operations.md 9.2)",
      measured: {
        n: soak.decomposition.queue.n,
        p95Ms: soak.decomposition.queue.p95,
        slotsAvailable: soak.slotsAvailable,
        concurrency: soak.concurrency,
      },
      verdict: queue.verdict,
      reason: `${queue.reason} Measured with ${soak.concurrency} Run(s) in flight on ${soak.slotsAvailable} slots.`,
    },
    {
      id: "NFR-006/orchestration-overhead",
      item: "Orchestration overhead (wall - queue - preparation - execution; includes evidence collection)",
      target: "p95 <= 2 s (specs/10-validation.md 9)",
      measured: {
        n: soak.decomposition.orchestrationOverhead.n,
        p95Ms: soak.decomposition.orchestrationOverhead.p95,
      },
      verdict: overhead.verdict,
      reason: overhead.reason,
    },
    {
      id: "NFR-006/artifact-publication",
      item: "Artifact publication (evidence collection, small artifacts)",
      target: "p95 < 30 s up to 64 MiB (specs/08-operations.md 9.2)",
      measured: { n: soak.decomposition.collection.n, p95Ms: soak.decomposition.collection.p95 },
      // The target is about artifacts up to 64 MiB; these are a few KiB, so a pass proves nothing about it.
      verdict: (collection.verdict === "not met" ? "not met" : "not measured") as Verdict,
      reason:
        collection.verdict === "not met"
          ? collection.reason
          : "Only artifacts of a few KiB were published; the 64 MiB bound of the target was not exercised.",
    },
  ];
}

export async function runCapacity(options: CapacityOptions): Promise<Record<string, unknown>> {
  const startedAt = new Date();
  const commit = sourceCommit();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const fixture = await startFixture(options.targetDelayMs);
  const loadStart = os.loadavg();
  const stack = await startDistributedBenchStack({ root, workDirectory: options.workDirectory });
  const workers: RemoteWorker[] = [];
  let keepStack = false;
  // The first failure stops the run but not the report: a run of an hour is never lost to one phase.
  const state: { failure: PhaseFailure | null } = { failure: null };
  const ready: {
    context: Context | null;
    referenceRunId: string;
    hardware: Record<string, unknown> | null;
  } = { context: null, referenceRunId: "", hardware: null };
  const guarded = async <T>(phase: string, run: () => Promise<T>): Promise<T | null> => {
    if (state.failure) return null;
    try {
      return await run();
    } catch (error) {
      state.failure = describeFailure(phase, error);
      console.error(`[capacity] ${phase} failed: ${state.failure.error}`);
      return null;
    }
  };
  const need = (): Context => {
    if (!ready.context) throw new Error("setup did not complete");
    return ready.context;
  };
  try {
    await guarded("setup", async () => {
      for (let index = 1; index <= options.workers; index++)
        workers.push(await stack.startWorker(`cap-w${index}`, options.slots));
      const target = await createTarget(stack, fixture.url, "Capacity");
      const context: Context = {
        stack,
        fixture,
        evidenceLayoutVerified: false,
        options,
        target,
        workers,
        runners: [],
        scheduleId: null,
        slowFixture: null,
      };

      // Warm-up and calibration: one Run must pass and leave its manifest where the audit looks for it.
      const [warmPrincipal] = await principalsFor(context, 1);
      if (!warmPrincipal) throw new Error("No warm-up principal");
      const warm = new RunDriver(stack, [warmPrincipal], target);
      await warm.run(1, () => false, 2);
      const warmRuns = warm.records.filter((record) => record.outcome === "passed");
      const referenceRunId = warmRuns[0]?.runId;
      if (!referenceRunId)
        throw new Error(
          `Warm-up Runs did not pass (outcomes: ${warm.records.map((record) => record.outcome).join(", ")}); worker log: ${workers[0]?.process.stderr().slice(-2000)}`,
        );
      const warmRows = await fetchAudit(context, Date.now() - 600_000, Date.now() + 1000);
      context.evidenceLayoutVerified =
        (
          await auditEvidence(
            stack.evidence,
            stack.workspaceId,
            warmRows.filter((row) => row.runId === referenceRunId),
          )
        ).missing.length === 0;

      // A schedule that fires every minute through the soak and the chaos cases, so a duplicate or a
      // lost firing under a fault shows up in `schedule_firings`.
      if (options.phases.includes("soak") || options.phases.includes("chaos")) {
        const scheduled = await createTarget(stack, fixture.url, "Capacity schedule");
        const session = stack.principals.ownerSession;
        const suite = jsonAt(
          jsonBody(
            await session("POST", "/v1/suites", {
              name: `capacity-suite-${randomUUID().slice(0, 8)}`,
              selection: {
                kind: "dynamic",
                projects: [
                  { projectId: scheduled.projectId, environmentId: scheduled.environmentId },
                ],
              },
            }),
            "suite",
          ),
          "data",
          "id",
        );
        const schedule = jsonAt(
          jsonBody(
            await session("POST", "/v1/schedules", {
              name: `capacity-every-minute-${randomUUID().slice(0, 8)}`,
              selection: { kind: "suite", suiteId: suite },
              trigger: {
                kind: "interval",
                everySeconds: 60,
                anchor: new Date(Date.now() + 5000).toISOString(),
              },
            }),
            "schedule",
          ),
          "data",
          "id",
        );
        context.scheduleId = typeof schedule === "string" ? schedule : null;
      }
      ready.referenceRunId = referenceRunId;
      ready.context = context;
    });

    ready.hardware = await guarded("hardware", async () => ({
      ...(await hardwareFacts(options.workDirectory, commit)),
      disk: await diskFacts(options.workDirectory),
      images: {
        running: await containerImages(stack),
        referenced: await imageFacts(["testmaster-runner:local", "testmaster-server:local"]),
      },
      loadAverageAtStart: loadStart.map((value) => rounded(value)),
    }));

    const phases: Record<string, unknown> = {};
    const skipped = (name: PhaseName) => ({
      status: "not run",
      reason: `--phases did not include ${name}`,
    });
    const absent = (key: string) => absentPhase(state.failure, key, "The phase did not run.");
    const throughput = options.phases.includes("throughput")
      ? await guarded("throughput", () => phaseThroughput(need(), ready.referenceRunId))
      : null;
    phases.throughput = options.phases.includes("throughput")
      ? (throughput ?? absent("throughput"))
      : skipped("throughput");
    let soak: SoakResult | null = null;
    if (options.phases.includes("soak")) {
      soak = await guarded("soak", () => phaseSoak(need()));
      phases.soak = soak ?? absent("soak");
    } else phases.soak = skipped("soak");
    const chaos: ChaosResult[] = [];
    if (options.phases.includes("chaos")) {
      const cases: [string, (context: Context) => Promise<ChaosResult>][] = [
        ["controller_kill", chaosKillController],
        ["minio_restart", chaosRestartMinio],
        ["worker_partition", chaosPartitionWorker],
      ];
      for (const [name, run] of cases) {
        if (!options.chaosCases.includes(name as (typeof chaosCaseNames)[number])) continue;
        const found = await guarded(`chaos/${name}`, () => run(need()));
        if (found) chaos.push(found);
      }
      phases.chaos = {
        cases: chaos,
        ...(state.failure?.phase.startsWith("chaos/") ? { failed: state.failure } : {}),
      };
    } else phases.chaos = skipped("chaos");
    // Backpressure goes last: it leaves the queue full and the workers stopped.
    let backpressure: BackpressureResult | null = null;
    if (options.phases.includes("backpressure")) {
      backpressure = await guarded("backpressure", () => phaseBackpressure(need()));
      phases.backpressure = backpressure ?? absent("backpressure");
    } else phases.backpressure = skipped("backpressure");
    const failure = state.failure;

    const verdicts = [
      ...nfrVerdicts(soak, absentPhase(failure, "soak", "The soak phase did not run.").reason),
      {
        id: "M5-08/soak",
        item: `Soak of ${options.soakMinutes} min at ${options.soakConcurrency} Runs in flight`,
        target: "no error, no invented result, no restart; drift reported",
        measured: soak ? { runs: soak.runs.completed, windowSeconds: soak.window.seconds } : null,
        verdict: soak?.verdict ?? ("not measured" as Verdict),
        reason:
          soak?.verdictReason ?? absentPhase(failure, "soak", "The soak phase did not run.").reason,
      },
      ...chaosCaseNames.map((name) => {
        const found = chaos.find((entry) => entry.case === name);
        return {
          id: `M5-08/chaos/${name}`,
          item: `Chaos: ${name}`,
          target:
            "no invented result, no duplicate execution or firing, leases move, service recovers",
          measured: null,
          verdict: found?.verdict ?? ("not measured" as Verdict),
          reason:
            found?.verdictReason ??
            absentPhase(
              failure,
              `chaos/${name}`,
              options.phases.includes("chaos")
                ? "--chaos-cases did not include this case."
                : "The chaos phase did not run.",
            ).reason,
        };
      }),
      {
        id: "OPS-034/saturation-backpressure",
        item: "Saturation shows backpressure instead of a crash",
        target:
          "refusals with Retry-After at the queue bound, 0 crashes (specs/08-operations.md OPS-033/034)",
        measured: backpressure?.queueBound ?? null,
        verdict: backpressure?.verdict ?? ("not measured" as Verdict),
        reason:
          backpressure?.verdictReason ??
          absentPhase(failure, "backpressure", "The backpressure phase did not run.").reason,
      },
    ];

    // A failing verdict leaves the project up when asked, so the logs, the database and the bucket
    // can be read before anything is removed.
    keepStack =
      options.keepStackOnFailure &&
      (failure !== null || verdicts.some((entry) => entry.verdict === "not met"));
    const finishedAt = new Date();
    return {
      schemaVersion: "1.0.0",
      tool: "tools/src/benchmark/m5-capacity.ts",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationSeconds: rounded((finishedAt.getTime() - startedAt.getTime()) / 1000),
      complete: failure === null,
      failure,
      options: { ...options, out: undefined, workDirectory: undefined },
      hardware: ready.hardware,
      stack: {
        profile: "distributed",
        compose: "deploy/compose/compose.distributed.yaml",
        keptForForensics: keepStack
          ? {
              project: stack.project,
              directory: stack.directory,
              removalCommand: stack.removalCommand,
            }
          : null,
        controllers: controllerNames.length,
        remoteWorkers: {
          count: options.workers,
          slotsEach: options.slots,
          totalSlots: options.workers * options.slots,
        },
        singlePhysicalHost:
          "Controllers, PostgreSQL, MinIO, Caddy, the remote workers, their sandbox containers, the fixture target and the load generator all share one machine and one Docker daemon; no cross-host network or hardware was measured.",
        clientTransport:
          "HTTPS to Caddy on loopback (tls internal), round robin over both controllers; TLS termination and the proxy hop are included",
        authentication: "bearer API tokens; runner principals admit, the owner reads",
        storage: "MinIO with TLS, bind-mounted local directory, evidence bucket",
        database: "PostgreSQL 17 with TLS, default durability",
        target: {
          kind: "local node:http fixture on 127.0.0.1",
          serviceTimeMsPerRequest: options.targetDelayMs,
          requestsReceived: fixture.hits(),
          note: "The tool has no target option and never sends load to anything but this fixture.",
        },
        observation:
          "State is read with docker compose exec psql and the filesystem, not through the load generator's event loop",
        loadAverageAtEnd: os.loadavg().map((value) => rounded(value)),
      },
      method: {
        load: "closed loop: each in-flight slot admits a Run, waits until it is completed and starts the next; admission retries reuse the idempotency key",
        percentileRule: `p50 and p90 from n >= 1; p95 only from n >= ${minimumSamples(95)}, p99 only from n >= ${minimumSamples(99)}; otherwise null with the reason in "withheld"`,
        runTimeSource:
          "wall time = Run created_at to the last Attempt's ended_at; phases from attempt.timing events (monotonic); client-observed time adds the 500 ms poll interval",
        sizing:
          "requiredSlots ≈ arrivalRate × meanServiceTime / 0.7 is an estimate (OPS-034), not a guarantee",
      },
      phases,
      verdicts,
      isolation: {
        claim: "none",
        statement:
          "No hostile multi-tenant test was run and no isolation promise follows from these numbers. Workspace isolation is an authorization and row-level-security boundary inside one process and one database, and a container is not a hostile multi-tenant boundary on its own: a tenant that can run arbitrary code needs a separate host or VM boundary.",
      },
      notMeasured: [
        "More than one physical host: cross-host latency, clock skew and partial or asymmetric partitions.",
        "Hostile multi-tenant behaviour and cross-tenant fairness under attack.",
        "Artifacts larger than a few KiB (the 64 MiB publication target).",
        "Browser, terminal and Python runners; only the HTTP runner against a fixed-delay target was loaded.",
        "S3 implementations other than the pinned MinIO; AWS S3 behaviour and latency.",
        "Queue start lag with every slot busy (the soak keeps slots available by design).",
        'Any percentile whose n is below the gate (see each "withheld").',
        "Backup, restore and retention under load.",
      ],
      limitations: [
        "One physical host: every component competes for the same CPU, memory, disk and Docker daemon, and the load generator is one of them.",
        "The partition is emulated by freezing the worker process (SIGSTOP), which stops its heartbeats and calls but not its sandbox container; a partial partition is not exercised.",
        "The duplicate-execution check assumes the fixture sees one request per Attempt, as the benchmark plan sends.",
        "Every authenticated request writes an audit row, including the load generator's 500 ms Run polling, so database growth per Run includes that polling.",
        "Drift slopes cover one window and exclude the first 20%; they do not prove the absence of a slower leak.",
        "Admissions are limited by the per-principal (20 burst, 1/s) and per-tenant (200 burst, 20/s) budgets, so sustained admission cannot exceed about 20 per second whatever the controllers could do.",
      ],
    };
  } catch (error) {
    keepStack = options.keepStackOnFailure;
    throw error;
  } finally {
    for (const worker of workers) await stack.stopWorker(worker, "SIGKILL").catch(() => undefined);
    if (keepStack)
      console.error(
        `[capacity] stack ${stack.project} left running in ${stack.directory}; remove it with:\n${stack.removalCommand}`,
      );
    else
      await stack
        .teardown()
        .catch((error) => console.error(`[capacity] teardown failed: ${error}`));
    await fixture.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed === "help") {
      console.log(usage);
    } else {
      const result = await runCapacity(parsed);
      await mkdir(dirname(parsed.out), { recursive: true });
      await writeFile(parsed.out, `${JSON.stringify(result, null, 2)}\n`);
      console.error(`[capacity] wrote ${parsed.out}`);
      if (result.failure) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  }
}
