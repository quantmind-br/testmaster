import { ContractError, type ExecutablePlan, validate } from "@testmaster/contracts";
export interface ExplorationBudget {
  steps: number;
  timeMs: number;
  modelCalls: number;
}
const envelope = { steps: "1..100", modelCalls: "1..steps", timeMs: "1000..300000" } as const;
function refuse(field: keyof typeof envelope, rule: string): never {
  throw new ContractError(
    "INVALID_ARGUMENT",
    `Exploration budget.${field} must be ${rule} (envelope: steps ${envelope.steps}, modelCalls ${envelope.modelCalls}, timeMs ${envelope.timeMs})`,
    { field, envelope },
  );
}
export function explorationPlan(path: string, budget: ExplorationBudget): ExecutablePlan {
  if (!Number.isInteger(budget.steps) || budget.steps < 1 || budget.steps > 100)
    refuse("steps", "an integer in 1..100");
  if (
    !Number.isInteger(budget.modelCalls) ||
    budget.modelCalls < 1 ||
    budget.modelCalls > budget.steps
  )
    refuse("modelCalls", "an integer in 1..steps");
  if (!Number.isInteger(budget.timeMs) || budget.timeMs < 1000 || budget.timeMs > 300000)
    refuse("timeMs", "an integer in 1000..300000 milliseconds");
  return validate<ExecutablePlan>("ExecutablePlan", {
    schemaVersion: "1.0.0",
    kind: "executable",
    name: "Authorized browser exploration",
    type: "frontend",
    runner: "playwright",
    requirementRefs: [],
    // A plan needs one required assertion (contracts validation), so the closing `observed` step
    // stays, but it only confirms the page is still rendered. It is NOT the exploration verdict:
    // an exploration that observed nothing to act on never reaches it, because the runner ends that
    // run inconclusive (insufficient_evidence) at the first observation and skips this step.
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
        description: "Final page is still rendered",
        kind: "assertion",
        operation: "assert",
        input: { locator: { by: "css", value: "body" } },
        expectation: { predicate: "visible" },
      },
    ],
  });
}
