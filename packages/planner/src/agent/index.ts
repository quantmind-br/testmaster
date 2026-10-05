import { ContractError, type ExecutablePlan, type PlanStep, validate } from "@testmaster/contracts";

export interface BrowserObservation {
  url: string;
  title: string;
  text: string;
  actions: PlanStep[];
}
export function validateObservation(
  value: unknown,
  origins: readonly string[],
): BrowserObservation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractError("INVALID_ARGUMENT", "Invalid browser observation");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !["url", "title", "text", "actions"].includes(key)) ||
    typeof input.url !== "string" ||
    typeof input.title !== "string" ||
    typeof input.text !== "string" ||
    !Array.isArray(input.actions) ||
    input.actions.length > 100 ||
    Buffer.byteLength(JSON.stringify(input)) > 65536
  )
    throw new ContractError("INVALID_ARGUMENT", "Invalid browser observation");
  if (!origins.includes(new URL(input.url).origin))
    throw new ContractError("POLICY_DENIED", "Observation origin is not admitted");
  const actions = input.actions.map((action) => validate<PlanStep>("Step", action));
  for (const action of actions) {
    if (
      action.kind !== "action" ||
      ![
        "navigate",
        "click",
        "fill",
        "press",
        "select",
        "check",
        "uncheck",
        "hover",
        "waitFor",
      ].includes(action.operation)
    )
      throw new ContractError("POLICY_DENIED", "Agent action is not authorized");
    if (
      action.operation === "navigate" &&
      !origins.includes(new URL(action.input.path, input.url).origin)
    )
      throw new ContractError("POLICY_DENIED", "Agent navigation origin is not admitted");
  }
  return { url: input.url, title: input.title, text: input.text, actions };
}
export function selectAction(
  selection: unknown,
  observation: BrowserObservation,
  stepId: string,
): PlanStep | null {
  const selected = validate<{ index: number | null }>("AgentActionSelection", selection);
  if (selected.index === null) return null;
  const action = observation.actions[selected.index];
  if (!action)
    throw new ContractError("INVALID_ARGUMENT", "Model selected a nonexistent observed action");
  return { ...action, id: stepId };
}
export function preserveAssertions(base: ExecutablePlan, candidate: ExecutablePlan): void {
  if (
    JSON.stringify(base.steps.filter((step) => step.kind === "assertion")) !==
    JSON.stringify(candidate.steps.filter((step) => step.kind === "assertion"))
  )
    throw new ContractError("POLICY_DENIED", "Agent cannot change deterministic assertions");
}
