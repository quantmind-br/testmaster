import type { Run } from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import { describe, expect, it } from "vitest";
import { comparisonPage, logicalRunKey, runComparability, runMatrixCell } from "./comparisons.js";

function run(): Run {
  return {
    testId: "same-test",
    revisionId: "same-revision",
    environmentRevisionId: "same-environment",
    outcome: "passed",
    matrixCell: {
      environmentId: "logical-environment",
      seed: 0,
      admissionSnapshot: {
        requiredCapabilities: ["http"],
        sourceRevisions: [],
        seed: 0,
        runnerImageDigest: "sha256:fixture",
        repository: { commitSha: "a".repeat(40), checkoutSha: "a".repeat(40), binding: "verified" },
        runtimeIdentity: { nodeVersion: "v24.0.0", imageId: "sha256:fixture" },
      },
    },
  } as unknown as Run;
}
describe("history comparison boundaries", () => {
  it("does not confuse outcome differences with identity changes", () => {
    const left = run();
    const right = run();
    right.outcome = "failed";
    expect(runComparability(left, right).comparability).toBe("comparable");
    right.revisionId = "changed-revision";
    expect(runComparability(left, right)).toMatchObject({
      comparability: "partially_comparable",
      reasons: ["revision-changed"],
    });
    right.testId = "different-test";
    expect(runComparability(left, right).comparability).toBe("incomparable");
    right.testId = left.testId;
    right.revisionId = left.revisionId;
    delete runMatrixCell(right).admissionSnapshot;
    expect(runComparability(left, right).comparability).toBe("partially_comparable");
  });
  it("binds cursors to both immutable comparison inputs and validates limits", () => {
    const identity = semanticHash({ left: "run-a", right: "run-b" });
    const result = {
      comparability: "comparable" as const,
      reasons: [],
      differences: Array.from({ length: 101 }, (_, i) => ({
        field: `step-${i}`,
        left: i,
        right: i + 1,
      })),
    };
    const first = comparisonPage(identity, result);
    expect(first.differences).toHaveLength(50);
    const second = comparisonPage(identity, result, { cursor: first.nextCursor! });
    expect(second.differences[0]!.field).toBe("step-50");
    expect(() =>
      comparisonPage(semanticHash({ left: "run-a", right: "run-c" }), result, {
        cursor: first.nextCursor!,
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => comparisonPage(identity, result, { limit: 101 })).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
  });
  it("excludes outcome and correlation noise from logical keys but retains repetitions", () => {
    const left = run();
    const right = run();
    right.outcome = "failed";
    runMatrixCell(right).correlationId = "different";
    expect(logicalRunKey(left)).toBe(logicalRunKey(right));
    runMatrixCell(right).repetitionIndex = 1;
    expect(logicalRunKey(left)).not.toBe(logicalRunKey(right));
  });
});
