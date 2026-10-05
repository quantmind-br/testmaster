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
