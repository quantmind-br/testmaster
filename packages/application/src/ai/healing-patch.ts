import { ContractError, type ExecutablePlan, type PlanStep, validate } from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import { preserveAssertions } from "@testmaster/planner";

export interface HealingPatch {
  changes: Array<{ stepId: string; path: string; value: unknown }>;
  evidenceHandles: string[];
  explanation: string;
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
    const locator = change.path === "/input/locator" && "locator" in step.input;
    const drag =
      step.operation === "drag" && ["/input/source", "/input/destination"].includes(change.path);
    const download =
      step.operation === "download" && change.path === "/input/trigger/input/locator";
    const wait =
      step.operation === "waitFor" && "locator" in step.input && change.path === "/input/state";
    const manual =
      (step.operation === "fill" && change.path === "/input/value") ||
      (step.operation === "select" && change.path === "/input/values") ||
      (step.operation === "navigate" && change.path === "/input/path") ||
      (step.operation === "request" &&
        ["/input/pathSegments", "/input/query", "/input/headers", "/input/body"].includes(
          change.path,
        ));
    if (!locator && !drag && !download && !wait && !manual)
      throw new ContractError("POLICY_DENIED", "Healing patch path is not authorized", {
        stepId: step.id,
        path: change.path,
      });
    manualOnly ||= manual;
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
