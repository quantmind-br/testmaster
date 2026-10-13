import type { ExecutablePlan, PlanStep } from "@testmaster/contracts";
import { canonicalJson } from "@testmaster/domain";

/** Keys that tune how a step runs without changing what it asserts (UX-024 "operational adjustment"). */
const operationalKeys = new Set([
  "description",
  "timeoutMs",
  "deadlineMs",
  "maximumAge",
  "readiness",
  "risk",
]);
const operationalPlanFields = new Set(["tags", "priority"]);

/** Every step, including the children of frames, in document order. */
export function flattenSteps(steps: readonly PlanStep[]): PlanStep[] {
  return steps.flatMap((step) =>
    step.operation === "frame" ? [step, ...flattenSteps(step.input.childSteps)] : [step],
  );
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "id" && !operationalKeys.has(key))
        .map(([key, child]) => [key, strip(child)]),
    );
  return value;
}

/** What a step does, ignoring identity and operational tuning; two steps with equal signatures are the same action. */
export function stepSignature(step: PlanStep): string {
  return canonicalJson(strip(step));
}

/** Deep differences as JSON pointers; arrays compare by index. */
export function diffPaths(before: unknown, after: unknown, path = ""): string[] {
  if (before === undefined || after === undefined) return before === after ? [] : [path];
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    return Array.from({ length }, (_, index) =>
      diffPaths(before[index], after[index], `${path}/${index}`),
    ).flat();
  }
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])]
      .sort()
      .flatMap((key) =>
        diffPaths(
          left[key],
          right[key],
          `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        ),
      );
  }
  return [path];
}

function isOperationalPath(path: string): boolean {
  const segments = path.split("/").slice(1);
  // Tags and priority live at the top of the plan; a "tags" key deeper down is content.
  if (operationalPlanFields.has(segments[0] ?? "")) return true;
  return operationalKeys.has(segments.at(-1) ?? "");
}

export interface PlanDifference {
  /** Anything that changes what is exercised or asserted. */
  intent: string[];
  /** Timeouts, deadlines, descriptions, tags and priority. */
  operational: string[];
  assertions: { added: string[]; removed: string[]; changed: string[] };
}

/** Step ids of assertions that were added, removed or altered between two plans. */
function assertionChanges(
  before: ExecutablePlan,
  after: ExecutablePlan,
): PlanDifference["assertions"] {
  const index = (plan: ExecutablePlan) =>
    new Map(
      flattenSteps(plan.steps)
        .filter((step) => step.kind === "assertion")
        .map((step) => [step.id, stepSignature(step)] as const),
    );
  const left = index(before);
  const right = index(after);
  return {
    added: [...right.keys()].filter((id) => !left.has(id)),
    removed: [...left.keys()].filter((id) => !right.has(id)),
    changed: [...right.keys()].filter((id) => left.has(id) && left.get(id) !== right.get(id)),
  };
}

export function comparePlans(before: ExecutablePlan, after: ExecutablePlan): PlanDifference {
  const paths = diffPaths(before, after);
  const assertions = assertionChanges(before, after);
  // `required` is not operational: an assertion that became optional no longer protects anything.
  for (const path of paths) {
    const match = /^\/steps\/(\d+)\/required$/.exec(path);
    const step = match ? after.steps[Number(match[1])] : undefined;
    if (step?.kind === "assertion" && !assertions.changed.includes(step.id))
      assertions.changed.push(step.id);
  }
  return {
    intent: paths.filter((path) => !isOperationalPath(path)),
    operational: paths.filter(isOperationalPath),
    assertions,
  };
}

export interface Similarity {
  score: number;
  exactDuplicate: boolean;
}

/** Share of identical step signatures; exact duplicates also share runner, type and a requirement. */
export function planSimilarity(
  left: { plan: ExecutablePlan; requirements: readonly string[] },
  right: { plan: ExecutablePlan; requirements: readonly string[] },
): Similarity {
  const a = flattenSteps(left.plan.steps).map(stepSignature);
  const b = flattenSteps(right.plan.steps).map(stepSignature);
  const pool = new Map<string, number>();
  for (const signature of b) pool.set(signature, (pool.get(signature) ?? 0) + 1);
  let shared = 0;
  for (const signature of a) {
    const remaining = pool.get(signature) ?? 0;
    if (remaining > 0) {
      shared++;
      pool.set(signature, remaining - 1);
    }
  }
  const score = a.length || b.length ? shared / Math.max(a.length, b.length) : 0;
  const sameContent =
    a.length === b.length &&
    a.every((signature, index) => signature === b[index]) &&
    left.plan.runner === right.plan.runner &&
    left.plan.type === right.plan.type;
  const overlap = left.requirements.some((id) => right.requirements.includes(id));
  return { score: Math.round(score * 1000) / 1000, exactDuplicate: sameContent && overlap };
}

/** A bounded duration range with the reason it is only an estimate (spec 3.2: cost range and reason). */
export function estimateDuration(plan: ExecutablePlan): {
  unit: "seconds";
  min: number;
  max: number;
  reason: string;
} {
  const steps = flattenSteps(plan.steps);
  let maximum = 0;
  for (const step of steps) {
    const input = step.input as { deadlineMs?: number };
    maximum += (step.timeoutMs ?? input.deadlineMs ?? 30000) / 1000;
  }
  return {
    unit: "seconds",
    min: Math.round(steps.length * 0.2 * 10) / 10,
    max: Math.round(maximum * 10) / 10,
    reason: `Lower bound assumes 0.2 s per step; upper bound is the sum of ${steps.length} step timeouts. It is not a measurement.`,
  };
}
