import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  ContractError,
  defaults,
  type EntityPrefix,
  type ExecutablePlan,
  entityPrefixes,
  type JsonValue,
  uuidPattern,
  validate,
} from "@testmaster/contracts";
import canonicalize from "canonicalize";
import { v7 } from "uuid";
export interface IdGenerator {
  next(prefix: EntityPrefix): string;
}
export const uuidV7IdGenerator: IdGenerator = {
  next(prefix) {
    if (!entityPrefixes.includes(prefix))
      throw new ContractError("INVALID_ARGUMENT", "Invalid entity prefix");
    return `${prefix}_${v7()}`;
  },
};
export function assertEntityId(value: string, prefix?: EntityPrefix): void {
  const match = new RegExp(`^(${entityPrefixes.join("|")})_${uuidPattern}$`).exec(value);
  if (!match || (prefix && match[1] !== prefix))
    throw new ContractError("INVALID_ARGUMENT", "Invalid entity ID", { prefix });
}
export interface Clock {
  utcNow(): string;
  monotonicMs(): number;
}
export const systemClock: Clock = {
  utcNow: () => new Date().toISOString(),
  monotonicMs: () => performance.now(),
};
export function elapsedMs(clock: Clock, start: number): number {
  const elapsed = clock.monotonicMs() - start;
  if (elapsed < 0 || !Number.isFinite(elapsed)) throw new Error("Monotonic clock regressed");
  return elapsed;
}
export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function materializePlanDefaults(plan: ExecutablePlan): ExecutablePlan {
  validate("ExecutablePlan", plan);
  const materialized = structuredClone(plan);
  const fill = (steps: ExecutablePlan["steps"]): void => {
    for (const step of steps) {
      step.required ??= true;
      step.timeoutMs ??= defaults.stepTimeoutMs;
      if (step.operation === "frame") fill(step.input.childSteps);
    }
  };
  fill(materialized.steps);
  materialized.dependsOn ??= [];
  materialized.cleanup ??= [];
  materialized.tags ??= [];
  materialized.priority ??= "normal";
  return materialized;
}
export function canonicalJson(value: unknown): string {
  const json = canonicalize(value);
  if (json === undefined)
    throw new ContractError("INVALID_ARGUMENT", "Value is not canonical JSON");
  return json;
}
export function semanticHash(value: unknown, kind: "plan" | "config" | "json" = "json"): string {
  let normalized = value;
  if (kind === "plan") {
    const plan = validate<ExecutablePlan>("ExecutablePlan", value);
    normalized = materializePlanDefaults(plan);
  }
  if (kind === "config") {
    const config = validate<JsonValue>("ProjectConfig", value);
    const cloned = structuredClone(config) as Record<string, unknown>;
    const execution = (cloned.execution ?? {}) as Record<string, unknown>;
    cloned.execution = {
      executor: "docker",
      mode: "replay",
      concurrency: 2,
      executionTimeoutMs: defaults.executionTimeoutMs,
      attemptTimeoutMs: defaults.attemptTimeoutMs,
      stepTimeoutMs: defaults.stepTimeoutMs,
      maxAttempts: defaults.maxAttempts,
      ...execution,
    };
    const telemetry = (cloned.telemetry ?? {}) as Record<string, unknown>;
    const healing = (cloned.healing ?? {}) as Record<string, unknown>;
    const artifacts = (cloned.artifacts ?? {}) as Record<string, unknown>;
    cloned.telemetry = { enabled: false, ...telemetry };
    cloned.healing = { mode: "off", ...healing };
    cloned.artifacts = { trace: "off", video: "off", retentionDays: 30, ...artifacts };
    normalized = cloned;
  }
  return sha256(canonicalJson(normalized));
}
export interface Proportion {
  status: "measured" | "insufficientData";
  successes: number;
  n: number;
  estimate: number | null;
  lower: number | null;
  upper: number | null;
}
export function wilson(successes: number, n: number): Proportion {
  if (
    !Number.isSafeInteger(n) ||
    !Number.isSafeInteger(successes) ||
    n < 0 ||
    successes < 0 ||
    successes > n
  )
    throw new RangeError("Expected integer counts with 0 <= successes <= n");
  if (!n)
    return { status: "insufficientData", successes, n, estimate: null, lower: null, upper: null };
  const z = 1.96;
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return {
    status: "measured",
    successes,
    n,
    estimate: p,
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
  };
}
export interface FlakeCounts {
  nPlanned: number;
  nPass: number;
  nFail: number;
  nBlocked: number;
  nCancelled: number;
  nInconclusive: number;
}
export function flakeStatistics(counts: FlakeCounts) {
  for (const value of Object.values(counts))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError("Expected nonnegative integer counts");
  const observed =
    counts.nPass + counts.nFail + counts.nBlocked + counts.nCancelled + counts.nInconclusive;
  if (observed > counts.nPlanned) throw new RangeError("Observed counts exceed planned samples");
  const nValid = counts.nPass + counts.nFail;
  const interval = wilson(counts.nFail, nValid);
  const classification =
    nValid < 2
      ? ("insufficient_data" as const)
      : counts.nPass && counts.nFail
        ? ("suspected_flaky" as const)
        : counts.nFail
          ? ("deterministic_failure" as const)
          : ("passing_observed" as const);
  return {
    counts: { ...counts, nValid, nInFlight: counts.nPlanned - observed },
    failureRate: interval.estimate,
    wilson95: nValid ? { low: interval.lower!, high: interval.upper! } : null,
    zeroFailureUpper95: nValid && counts.nFail === 0 ? 1 - 0.05 ** (1 / nValid) : null,
    classification,
    limitations: [
      ...(nValid < 2 ? ["Insufficient valid samples for classification"] : []),
      ...(observed > nValid
        ? ["Failure estimate is conditional on valid pass/fail observations"]
        : []),
      "Sample independence requires separate evidence; repeated observations can be correlated",
      ...(classification === "suspected_flaky"
        ? ["Independent intermittent-cause evidence is required for confirmed flakiness"]
        : []),
    ],
  };
}
