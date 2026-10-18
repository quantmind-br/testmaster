import {
  ContractError,
  type ExecutablePlan,
  type PlanStep,
  Step,
  validate,
} from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import { preserveAssertions } from "@testmaster/planner";

export interface HealingPatch {
  changes: Array<{ stepId: string; path: string; value: unknown }>;
  evidenceHandles: string[];
  explanation: string;
}

export interface HealingReplacement {
  path: string;
  valueShape: unknown;
  manualOnly: boolean;
}

const locatorFields: Record<string, true> = { locator: true, source: true, destination: true };
/** True when a locator (or a container/frame in its scope chain) selects by position with `nth`. */
function selectsByNth(locator: unknown): boolean {
  if (!locator || typeof locator !== "object") return false;
  if ("nth" in locator) return true;
  return (
    ("container" in locator && selectsByNth(locator.container)) ||
    ("frame" in locator && selectsByNth(locator.frame))
  );
}
/** The value a step holds at a JSON pointer, or undefined when absent. */
function valueAt(step: PlanStep, path: string): unknown {
  let current: unknown = step;
  for (const part of path.slice(1).split("/")) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) return undefined;
    current = Reflect.get(current, part);
  }
  return current;
}
/** The same present-field contract drives generation and replacement admission. */
export function healingReplacements(step: PlanStep): HealingReplacement[] {
  if (step.kind !== "action") return [];
  const replacements: HealingReplacement[] = [];
  const variants = Step.anyOf as Array<{
    properties: {
      operation: { const: string };
      input: {
        properties?: Record<string, unknown>;
        anyOf?: Array<{ properties: Record<string, unknown> }>;
      };
    };
  }>;
  const inputSchema = variants.find(
    (variant) => variant.properties.operation.const === step.operation,
  )!.properties.input;
  const properties =
    inputSchema.properties ??
    inputSchema.anyOf!.find(
      (variant) => "locator" in variant.properties === "locator" in step.input,
    )!.properties;
  const add = (field: string, manualOnly = false) => {
    if (Object.hasOwn(step.input, field))
      replacements.push({ path: `/input/${field}`, valueShape: properties[field], manualOnly });
  };
  add("locator");
  if (step.operation === "download") {
    const trigger = properties.trigger as {
      properties: { input: { properties: Record<string, unknown> } };
    };
    replacements.push({
      path: "/input/trigger/input/locator",
      valueShape: trigger.properties.input.properties.locator,
      manualOnly: false,
    });
  }
  if (step.operation === "drag") {
    add("source", true);
    add("destination", true);
  }
  if (step.operation === "waitFor" && "locator" in step.input) add("state");
  if (step.operation === "fill") add("value", true);
  if (step.operation === "select") add("values", true);
  if (step.operation === "navigate") add("path", true);
  if (step.operation === "request")
    for (const field of ["pathSegments", "query", "headers", "body"]) add(field, true);
  return replacements;
}
/** A replacement only: no structural edits or addition of absent optional fields. */
export function applyHealingPatch(
  base: ExecutablePlan,
  input: unknown,
): {
  plan: ExecutablePlan;
  patch: HealingPatch;
  manualOnly: boolean;
} {
  const patch = validate<HealingPatch>("HealingPatch", input);
  const index = (plan: ExecutablePlan) => {
    const steps = new Map<string, PlanStep>();
    const visit = (items: readonly PlanStep[]) => {
      for (const step of items) {
        if (steps.has(step.id))
          throw new ContractError("INVALID_ARGUMENT", "Healing requires globally unique step IDs", {
            stepId: step.id,
          });
        steps.set(step.id, step);
        if (step.operation === "frame") visit(step.input.childSteps);
      }
    };
    visit(plan.steps);
    return steps;
  };
  const candidate = structuredClone(base);
  const originalSteps = index(base);
  const candidateSteps = index(candidate);
  let manualOnly = false;
  const seen = new Map<string, string[]>();
  const replace = (step: PlanStep, path: string, value: unknown) => {
    const parts = path.slice(1).split("/");
    let parent = step as unknown as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(parent, part) || !parent[part] || typeof parent[part] !== "object")
        throw new ContractError("POLICY_DENIED", "Healing cannot add absent fields", { path });
      parent = parent[part] as Record<string, unknown>;
    }
    const key = parts.at(-1)!;
    if (!Object.hasOwn(parent, key))
      throw new ContractError("POLICY_DENIED", "Healing cannot add absent fields", { path });
    parent[key] = structuredClone(value);
  };
  for (const change of patch.changes) {
    const step = originalSteps.get(change.stepId);
    if (!step || step.kind !== "action")
      throw new ContractError("POLICY_DENIED", "Healing may only replace existing action inputs");
    const paths = seen.get(step.id) ?? [];
    if (
      paths.some(
        (path) =>
          path === change.path ||
          path.startsWith(`${change.path}/`) ||
          change.path.startsWith(`${path}/`),
      )
    )
      throw new ContractError("INVALID_ARGUMENT", "Duplicate or overlapping healing paths");
    paths.push(change.path);
    seen.set(step.id, paths);
    const replacement = healingReplacements(step).find((entry) => entry.path === change.path);
    if (!replacement)
      throw new ContractError("POLICY_DENIED", "Healing patch path is not authorized", {
        stepId: step.id,
        path: change.path,
      });
    // A position is only ever chosen by a person: the index silently retargets when the list changes.
    if (
      Object.hasOwn(locatorFields, change.path.split("/").at(-1) ?? "") &&
      (selectsByNth(valueAt(step, change.path)) || selectsByNth(change.value))
    )
      throw new ContractError(
        "POLICY_DENIED",
        "Healing never produces or replaces a locator that selects by nth",
        { stepId: step.id, path: change.path },
      );
    manualOnly ||= replacement.manualOnly;
    replace(candidateSteps.get(step.id)!, change.path, change.value);
  }
  const plan = validate<ExecutablePlan>("ExecutablePlan", candidate);
  preserveAssertions(base, plan);
  // Mask precisely the replacements on BOTH sides. Every other field remains sealed.
  const maskedBase = structuredClone(base);
  const maskedCandidate = structuredClone(plan);
  const left = index(maskedBase),
    right = index(maskedCandidate);
  for (const change of patch.changes) {
    replace(left.get(change.stepId)!, change.path, null);
    replace(right.get(change.stepId)!, change.path, null);
  }
  if (semanticHash(maskedBase) !== semanticHash(maskedCandidate))
    throw new ContractError("POLICY_DENIED", "Healing changed protected plan content");
  return { plan, patch, manualOnly };
}
