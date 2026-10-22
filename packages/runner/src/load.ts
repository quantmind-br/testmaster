import os from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { LoadProbe } from "@testmaster/contracts";
import { minimumSamples, percentile, roundMillis } from "@testmaster/domain";
import {
  type OpenProbeStep,
  type PreparedRequest,
  type ProbeResponse,
  ProbeSteps,
  ProbeTransport,
  type ProbeTransportOptions,
  refusedProbe,
  resolveCredentials,
} from "./probe-support.js";
import { abortVerdict, type RunnerResult, type Runtime, RuntimeError } from "./runtime.js";

/** Span of the rolling window the stop conditions are judged on. */
const WINDOW_MS = 5000;
/** How often the rolling window is judged. */
const EVALUATION_MS = 1000;
const SUMMARY_PATH = "load/summary.json";

export interface LoadOptions extends ProbeTransportOptions {
  /** Monotonic milliseconds; replaceable so the schedule can be driven by a test clock. */
  now?: () => number;
  /** Resolves after `ms` or when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Replaces the network send; the request is still resolved against the target first. */
  send?: (prepared: PreparedRequest, signal: AbortSignal) => Promise<ProbeResponse>;
}

type StopName = "maxErrorRate" | "maxP95Ms";
interface StopCondition {
  name: StopName;
  observed: number;
  limit: number;
  atSeconds: number;
}
interface Measure {
  valueMs: number | null;
  n: number;
}
interface StageRecord {
  index: number;
  durationSeconds: number;
  targetRps: number;
  sent: number;
  achievedRps: number;
}

/**
 * Settled requests in completion order. A transport failure has no latency; any response does, and
 * a status of 400 or more is also an error.
 */
class Completions {
  private readonly at: number[] = [];
  private readonly latency: number[] = [];
  private readonly failed: boolean[] = [];
  private windowStart = 0;
  private errorCount = 0;
  record(at: number, latencyMs: number | null, error: boolean): void {
    this.at.push(at);
    this.latency.push(latencyMs ?? Number.NaN);
    this.failed.push(error);
    if (error) this.errorCount += 1;
  }
  get count(): number {
    return this.at.length;
  }
  get errors(): number {
    return this.errorCount;
  }
  /** Samples settled within the last `WINDOW_MS`: how many, how many failed, their latencies. */
  window(now: number): { count: number; errors: number; latencies: number[] } {
    while (this.windowStart < this.at.length && (this.at[this.windowStart] ?? 0) < now - WINDOW_MS)
      this.windowStart += 1;
    let errors = 0;
    const latencies: number[] = [];
    for (let index = this.windowStart; index < this.at.length; index++) {
      if (this.failed[index]) errors += 1;
      const value = this.latency[index] ?? Number.NaN;
      if (!Number.isNaN(value)) latencies.push(value);
    }
    return { count: this.at.length - this.windowStart, errors, latencies };
  }
  latencies(): number[] {
    return this.latency.filter((value) => !Number.isNaN(value));
  }
}

/** A percentile is a measurement only with enough samples behind it. */
function measure(values: readonly number[], q: number): Measure {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    valueMs: sorted.length >= minimumSamples(q) ? roundMillis(percentile(sorted, q)) : null,
    n: sorted.length,
  };
}
const roundRate = (value: number): number => Math.round(value * 1e6) / 1e6;

/**
 * The stop condition a set of samples violates, if any. The error rate is judged first; the p95 is
 * judged only when enough latencies stand behind it.
 */
function violated(
  probe: LoadProbe,
  count: number,
  errors: number,
  latencies: readonly number[],
  atSeconds: number,
): StopCondition | null {
  const errorRate = count === 0 ? 0 : errors / count;
  if (errorRate > probe.stopConditions.maxErrorRate)
    return {
      name: "maxErrorRate",
      observed: roundRate(errorRate),
      limit: probe.stopConditions.maxErrorRate,
      atSeconds,
    };
  const p95 = measure(latencies, 95).valueMs;
  if (p95 !== null && p95 > probe.stopConditions.maxP95Ms)
    return { name: "maxP95Ms", observed: p95, limit: probe.stopConditions.maxP95Ms, atSeconds };
  return null;
}

/**
 * Open-loop load test (REQ-049): request i of a stage is due at `stageStart + i / targetRps`
 * whether or not earlier requests have returned, so a slow target is measured instead of slowing
 * the schedule. A due request that finds `maxConcurrency` requests in flight is counted as
 * saturated and not sent. The budget bounds the traffic sent to the target; a stop condition ends
 * the test early and fails it.
 */
export async function runLoad(runtime: Runtime, options: LoadOptions = {}): Promise<RunnerResult> {
  const probe = runtime.input.probe;
  if (probe?.kind !== "load")
    throw new RuntimeError("security_precondition_failed", "Load probe is missing");
  const now = options.now ?? (() => performance.now());
  const sleep =
    options.sleep ??
    ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }).then(() => undefined));
  const steps = new ProbeSteps(runtime);
  const transport = new ProbeTransport(runtime, {
    ...(options.dispatcher === undefined ? {} : { dispatcher: options.dispatcher }),
    connections: probe.maxConcurrency,
  });
  try {
    let prepared: PreparedRequest;
    try {
      prepared = transport.prepare(
        probe.request,
        await resolveCredentials(runtime, probe.request.credentials),
      );
    } catch (error) {
      if (error instanceof RuntimeError) return await refusedProbe(runtime, steps, "load", error);
      throw error;
    }
    const send = options.send ?? ((request, signal) => transport.send(request, signal));
    const signal = runtime.signal;
    const completions = new Completions();
    const lags: number[] = [];
    const stages: StageRecord[] = [];
    const pending = new Set<Promise<void>>();
    let inFlight = 0;
    let sent = 0;
    let saturated = 0;
    let budgetExhausted: "maxRequests" | "maxDurationSeconds" | null = null;
    let stop: StopCondition | null = null;
    // The rolling window ended the test: the stage then running is the one that failed.
    let stoppedEarly = false;

    const dispatch = (due: number): void => {
      inFlight += 1;
      sent += 1;
      lags.push(Math.max(0, now() - due));
      const task = send(prepared, signal)
        .then(
          (response) => completions.record(now(), response.latencyMs, response.status >= 400),
          () => completions.record(now(), null, true),
        )
        .finally(() => {
          inFlight -= 1;
          pending.delete(task);
        });
      pending.add(task);
    };

    const testStart = now();
    const budgetEnd = testStart + probe.budget.maxDurationSeconds * 1000;
    let nextEvaluation = testStart + EVALUATION_MS;
    let open: OpenProbeStep | undefined;
    for (const [position, stage] of probe.stages.entries()) {
      if (stop || budgetExhausted || signal.aborted) break;
      open = await steps.start(`load:stage-${position + 1}`);
      const stageStart = now();
      const stageEnd = stageStart + stage.durationSeconds * 1000;
      const total = stage.durationSeconds * stage.targetRps;
      const dueAt = (index: number): number => stageStart + (index * 1000) / stage.targetRps;
      let scheduled = 0;
      let stageSent = 0;
      while (!stop && !budgetExhausted && !signal.aborted) {
        const t = now();
        if (t >= nextEvaluation) {
          while (nextEvaluation <= t) nextEvaluation += EVALUATION_MS;
          const window = completions.window(t);
          if (window.count >= minimumSamples(95))
            stop = violated(
              probe,
              window.count,
              window.errors,
              window.latencies,
              roundMillis((t - testStart) / 1000) ?? 0,
            );
          if (stop) {
            stoppedEarly = true;
            break;
          }
        }
        if (scheduled >= total && t >= stageEnd) break;
        if (t >= budgetEnd) {
          budgetExhausted = "maxDurationSeconds";
          break;
        }
        while (scheduled < total && dueAt(scheduled) <= t) {
          const due = dueAt(scheduled);
          scheduled += 1;
          if (inFlight >= probe.maxConcurrency) {
            saturated += 1;
            continue;
          }
          dispatch(due);
          stageSent += 1;
          if (sent >= probe.budget.maxRequests) {
            budgetExhausted = "maxRequests";
            break;
          }
        }
        if (budgetExhausted) break;
        const nextWake = Math.min(
          scheduled < total ? dueAt(scheduled) : stageEnd,
          nextEvaluation,
          budgetEnd,
        );
        await sleep(Math.max(0, nextWake - t), signal).catch(() => undefined);
      }
      const elapsedSeconds = (now() - stageStart) / 1000;
      stages.push({
        index: position + 1,
        durationSeconds: stage.durationSeconds,
        targetRps: stage.targetRps,
        sent: stageSent,
        achievedRps: elapsedSeconds > 0 ? (roundMillis(stageSent / elapsedSeconds) ?? 0) : 0,
      });
      const endsTest =
        stoppedEarly ||
        budgetExhausted !== null ||
        signal.aborted ||
        position === probe.stages.length - 1;
      if (endsTest) break;
      await steps.finish(open, { status: "passed" });
      open = undefined;
    }

    // In-flight requests are never cut short by a stop condition or the end of the test.
    await Promise.allSettled([...pending]);
    const aborted = abortVerdict(signal);
    const endedAt = now();
    const latencies = completions.latencies();
    if (!stop && !aborted)
      stop = violated(
        probe,
        completions.count,
        completions.errors,
        latencies,
        roundMillis((endedAt - testStart) / 1000) ?? 0,
      );
    const errorRate = completions.count === 0 ? 0 : completions.errors / completions.count;
    const summary = {
      target: {
        count: completions.count,
        errors: completions.errors,
        errorRate: roundRate(errorRate),
        saturated,
        p50: measure(latencies, 50),
        p95: measure(latencies, 95),
        p99: measure(latencies, 99),
      },
      platform: { schedulerLagMs: { p95: measure(lags, 95) } },
      hardware: {
        cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        totalMemoryBytes: os.totalmem(),
      },
      dataset: {
        method: probe.request.method,
        path: probe.request.path,
        bodyBytes: prepared.body?.byteLength ?? 0,
      },
      stages,
      stopCondition: stop,
      budgetExhausted,
    };

    if (aborted) {
      if (open)
        await steps.finish(open, { status: aborted.outcome, reasonCode: aborted.reasonCode });
      await steps.finish(await steps.start("load"), {
        status: aborted.outcome,
        reasonCode: aborted.reasonCode,
      });
      return aborted;
    }
    await runtime.artifact(
      SUMMARY_PATH,
      "load-summary",
      "application/json",
      Buffer.from(JSON.stringify(summary, null, 2)),
    );
    const evidencePaths = [SUMMARY_PATH];
    if (stop) {
      const failure = {
        status: "failed" as const,
        reasonCode: "assertion_mismatch",
        error: {
          code: "stop_condition",
          message: `${stop.name} ${stop.observed} exceeds the limit ${stop.limit} after ${stop.atSeconds} s`,
        },
        expected: { [stop.name]: stop.limit },
        observed: { [stop.name]: stop.observed },
        evidencePaths,
      };
      // A final-window violation judges the whole test; its stages ran to their end.
      if (open)
        await steps.finish(open, stoppedEarly ? failure : { status: "passed", evidencePaths });
      await steps.finish(await steps.start("load"), failure);
      return { outcome: "failed", reasonCode: "assertion_mismatch" };
    }
    if (open) await steps.finish(open, { status: "passed", evidencePaths });
    if (summary.target.p95.valueMs === null) {
      const inconclusive = {
        status: "inconclusive" as const,
        reasonCode: "insufficient_evidence",
        error: {
          code: "insufficient_samples",
          message: `${summary.target.p95.n} latency samples are fewer than the ${minimumSamples(95)} a p95 needs`,
        },
        evidencePaths,
      };
      await steps.finish(await steps.start("load"), inconclusive);
      return { outcome: "inconclusive", reasonCode: "insufficient_evidence" };
    }
    await steps.finish(await steps.start("load"), { status: "passed", evidencePaths });
    return { outcome: "passed", reasonCode: "assertions_satisfied" };
  } finally {
    await transport.close();
  }
}
