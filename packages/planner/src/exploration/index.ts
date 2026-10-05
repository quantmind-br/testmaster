import { ContractError, type ExecutablePlan, validate } from "@testmaster/contracts";
export interface ExplorationBudget {
  steps: number;
  timeMs: number;
  modelCalls: number;
}
export function explorationPlan(path: string, budget: ExplorationBudget): ExecutablePlan {
  if (
    !Number.isInteger(budget.steps) ||
    budget.steps < 1 ||
    budget.steps > 100 ||
    !Number.isInteger(budget.modelCalls) ||
    budget.modelCalls < 1 ||
    budget.modelCalls > budget.steps ||
    !Number.isInteger(budget.timeMs) ||
    budget.timeMs < 1000 ||
    budget.timeMs > 300000
  )
    throw new ContractError("INVALID_ARGUMENT", "Exploration budget exceeds its fixed envelope");
  return validate<ExecutablePlan>("ExecutablePlan", {
    schemaVersion: "1.0.0",
    kind: "executable",
    name: "Authorized browser exploration",
    type: "frontend",
    runner: "playwright",
    requirementRefs: [],
    steps: [
      {
        id: "seed",
        description: "Open admitted seed",
        kind: "action",
        operation: "navigate",
        input: { path },
      },
      ...Array.from({ length: Math.min(budget.steps, budget.modelCalls) }, (_, index) => ({
        id: `explore-${index}`,
        description: "Follow a grounded admitted link",
        kind: "action",
        operation: "navigate",
        input: { path },
      })),
      {
        id: "observed",
        description: "Browser remains observable",
        kind: "assertion",
        operation: "assert",
        input: { locator: { by: "css", value: "body" } },
        expectation: { predicate: "visible" },
      },
    ],
  });
}
