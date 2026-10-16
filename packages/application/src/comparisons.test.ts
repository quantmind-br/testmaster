import type { Run } from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import { describe, expect, it } from "vitest";
import {
  ComparisonsService,
  comparisonPage,
  crossRunnerDifferences,
  logicalRunKey,
  metadataDifferences,
  runComparability,
  runMatrixCell,
} from "./comparisons.js";

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
  it("reports changed environment and generation model as discriminated reasons without changing outcome identity", () => {
    const left = run();
    const right = run();
    right.environmentRevisionId = "changed-environment";
    expect(runComparability(left, right)).toMatchObject({
      comparability: "partially_comparable",
      reasons: ["environment-changed"],
    });
    const modelLeft = run();
    const modelRight = run();
    (runMatrixCell(modelLeft).admissionSnapshot as Record<string, unknown>).generationModel =
      "model-a";
    (runMatrixCell(modelRight).admissionSnapshot as Record<string, unknown>).generationModel =
      "model-b";
    expect(runComparability(modelLeft, modelRight).comparability).toBe("partially_comparable");
    expect(runComparability(modelLeft, modelRight).reasons).toEqual(["generationModel-changed"]);
    (runMatrixCell(modelRight).admissionSnapshot as Record<string, unknown>).generationModel =
      "model-a";
    expect(runComparability(modelLeft, modelRight).reasons).toEqual([]);
  });
  it("reports a changed step as a difference while outcome changes never alter comparability", () => {
    expect(
      metadataDifferences({ steps: [{ status: "passed" }] }, { steps: [{ status: "failed" }] }),
    ).toEqual([{ field: "steps", left: [{ status: "passed" }], right: [{ status: "failed" }] }]);
    expect(
      metadataDifferences({ steps: [{ status: "passed" }] }, { steps: [{ status: "passed" }] }),
    ).toEqual([]);
    expect(metadataDifferences({ outcome: "passed" }, { outcome: "failed" })).toHaveLength(1);
    const left = run();
    const right = run();
    right.outcome = "failed";
    expect(runComparability(left, right)).toMatchObject({
      comparability: "comparable",
      reasons: [],
    });
  });
});

describe("comparing a plan Run with an imported-code Run of one test", () => {
  const step = (planStepId: string, index: number, fields: Record<string, unknown>) => ({
    id: `stp_${index}`,
    attemptId: "att_1",
    planStepId,
    index,
    expected: null,
    observed: null,
    error: null,
    ...fields,
  });
  const statusPlan = {
    steps: [
      { id: "request", kind: "action", operation: "request", input: {} },
      {
        id: "status",
        kind: "assertion",
        operation: "assert",
        expectation: { predicate: "statusIn" },
      },
    ],
  };
  function service() {
    const runs: Record<string, Run> = {
      "run-plan": {
        ...run(),
        id: "run-plan",
        revisionId: "rev-plan",
        phase: "completed",
        outcome: "passed",
        gate: "passed",
        cleanupOutcome: "passed",
      } as unknown as Run,
      "run-code": {
        ...run(),
        id: "run-code",
        revisionId: "rev-code",
        phase: "completed",
        outcome: "failed",
        gate: "failed",
        cleanupOutcome: "passed",
      } as unknown as Run,
    };
    runMatrixCell(runs["run-code"]!).admissionSnapshot = {
      ...(runMatrixCell(runs["run-code"]!).admissionSnapshot as object),
      requiredCapabilities: ["playwright"],
    } as never;
    const revisions: Record<string, unknown> = {
      "rev-plan": { plan: statusPlan, runnerKind: "http", origin: "manual" },
      "rev-code": { plan: null, runnerKind: "playwright", origin: "generated" },
    };
    const steps: Record<string, unknown[]> = {
      "run-plan": [
        step("request", 0, { status: "passed" }),
        step("status", 1, { status: "passed", expected: [200], observed: 200 }),
      ],
      "run-code": [
        // Playwright repeats the failure on the test around the failing expect, without details.
        step("imported-test-0", 0, { status: "failed" }),
        step("imported-step-1", 1, {
          status: "failed",
          reasonCode: "assertion_mismatch",
          expected: 200,
          observed: 401,
          error: { code: "assertion_mismatch", message: "Expected: 200\nReceived: 401" },
        }),
        step("imported-code", 1000000, { status: "failed" }),
      ],
    };
    const ctx = {
      workspaceId: "ws",
      entities: {
        get: (_kind: string, _workspace: string, id: string) => revisions[id],
        page: () => ({ items: [], next: null }),
      },
      database: { get: () => undefined },
    };
    const runService = {
      get: (id: string) => runs[id],
      steps: (id: string) => steps[id],
    };
    return new ComparisonsService(ctx as never, runService as never, {} as never);
  }
  it("compares the verdicts, the failing step and the HTTP statuses, and states why the steps cannot be diffed", () => {
    const result = service().runs("run-plan", "run-code");
    expect(result.comparability).toBe("incomparable");
    expect(result.reasons).toEqual(
      expect.arrayContaining(["different-runner", "step-diff-unavailable"]),
    );
    const field = (name: string) => result.differences.find((item) => item.field === name);
    expect(field("outcome")).toMatchObject({ left: "passed", right: "failed" });
    expect(field("gate")).toMatchObject({ left: "passed", right: "failed" });
    expect(field("failingStep")).toMatchObject({
      left: null,
      right: {
        stepId: "imported-step-1",
        reasonCode: "assertion_mismatch",
        expected: 200,
        observed: 401,
        error: expect.stringContaining("Received: 401"),
      },
    });
    expect(field("statusCodes")).toMatchObject({
      left: [{ stepId: "status", expected: [200], observed: 200 }],
      right: [{ stepId: "imported-step-1", expected: [200], observed: 401 }],
    });
    expect(field("stepComparison")).toMatchObject({
      left: { runner: "http", stepCount: 2, byStatus: { passed: 2 } },
      right: {
        runner: "playwright",
        stepCount: 3,
        byStatus: { failed: 3 },
        stepSource: expect.stringContaining("name no plan step"),
      },
    });
    expect(result.differences[0]?.field).toBe("stepComparison");
  });
  it("pairs only the steps both sides name by the same id", () => {
    const side = (stepKind: "plan" | "code", steps: Record<string, unknown>[]) => ({
      runner: "x",
      stepKind,
      statusAssertionIds: null,
      steps,
    });
    const differences = crossRunnerDifferences(
      side("plan", [step("login", 0, { status: "passed" }), step("only-left", 1, {})]),
      side("code", [step("login", 0, { status: "failed" }), step("only-right", 1, {})]),
    );
    const paired = differences.find((item) => item.field === "pairedSteps");
    expect(paired).toMatchObject({
      left: [{ stepId: "login", status: "passed" }],
      right: [{ stepId: "login", status: "failed" }],
    });
  });
});
