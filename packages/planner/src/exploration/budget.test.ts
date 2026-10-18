import { ContractError } from "@testmaster/contracts";
import { expect, it } from "vitest";
import { explorationPlan } from "./index.js";

const valid = { steps: 10, timeMs: 60000 };

function refusal(budget: { steps: number; timeMs: number }): ContractError {
  try {
    explorationPlan("/", budget);
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw error;
  }
  throw new Error("Expected the budget to be refused");
}

it("exploration budget refusal names the offending field and the envelope", () => {
  expect(() => explorationPlan("/", valid)).not.toThrow();
  for (const [budget, field] of [
    [{ ...valid, steps: 101 }, "steps"],
    [{ ...valid, timeMs: 999 }, "timeMs"],
    [{ ...valid, timeMs: 300001 }, "timeMs"],
  ] as const) {
    const error = refusal(budget);
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(error.details).toMatchObject({
      field,
      envelope: { steps: "1..100", timeMs: "1000..300000" },
    });
    expect(error.message).toContain(`budget.${field}`);
  }
});
