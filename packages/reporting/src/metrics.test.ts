import type { Attempt } from "@testmaster/contracts";
import { validate } from "@testmaster/contracts";
import { expect, it } from "vitest";
import type { ReportRun, ReportSnapshot } from "./index.js";
import { coverageMetrics, executionMetrics, ratioMetric } from "./metrics.js";

function run(
  id: string,
  outcome: "passed" | "failed" | "blocked",
  first = outcome,
  retried = false,
): ReportRun {
  return {
    evidenceState: "committed",
    run: { id, mode: "replay", matrixCell: {} },
    result: {
      phase: "completed",
      outcome,
      gate: outcome === "passed" ? "passed" : "failed",
      firstAttemptOutcome: first,
      passedOnRetry: retried && first === "failed",
    },
    steps: outcome === "blocked" ? [] : [{ status: outcome }],
    attempts: [
      { number: 1, outcome: first },
      ...(retried ? [{ number: 2, outcome: "passed" }] : []),
    ] as Attempt[],
    manifest: { entries: [] },
  } as unknown as ReportRun;
}
function snapshot(runs: ReportRun[], requested = runs.length): ReportSnapshot {
  return {
    runs,
    selection: { requested, notDispatched: [], excluded: [], allowEmpty: true },
    completeness: { state: "complete", reasons: [] },
  } as unknown as ReportSnapshot;
}
it("keeps all five coverage denominators independent and unknown distinct from empty", () => {
  const metrics = coverageMetrics({
    requirement: {
      covered: ["req1", "req1", "req2"],
      declared: ["req1", "req2", "req3", "req4"],
      scope: "declared",
    },
    route: { covered: ["/a"], declared: null, scope: "partial exploration" },
    operation: {
      covered: ["GET /a 200 application/json"],
      declared: ["GET /a 200 application/json", "GET /a 401 application/json"],
      scope: "OpenAPI",
    },
    code: { covered: [], declared: null, scope: "uninstrumented" },
    execution: { covered: [], declared: [], scope: "empty" },
  });
  validate("CoverageMetrics", metrics);
  expect(metrics.requirement).toMatchObject({ numerator: 2, denominator: 4, value: 0.5 });
  expect(metrics.operation).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
  expect(metrics.route).toMatchObject({
    numerator: 1,
    denominator: null,
    value: null,
    state: "insufficientData",
  });
  expect(metrics.code.denominatorState).toBe("unknown");
  expect(metrics.execution).toMatchObject({ denominator: 0, value: null, state: "notApplicable" });
  expect(ratioMetric(0, null, "unknown", "test").value).toBeNull();
});
it("all-blocked and empty selections never invent completion or conditional pass", () => {
  const blocked = executionMetrics(snapshot([run("one", "blocked"), run("two", "blocked")]));
  expect(blocked.rates.selectionCompletionRate).toMatchObject({
    numerator: 0,
    denominator: 2,
    value: 0,
  });
  expect(blocked.rates.blockedRate?.value).toBe(1);
  expect(blocked.rates.firstAttemptFailureRate).toMatchObject({
    denominator: 0,
    value: null,
    state: "notApplicable",
  });
  expect(blocked.exclusions.firstAttemptNonPassOrFail).toBe(2);
  const empty = executionMetrics(snapshot([]));
  expect(empty.rates.terminalPassRate).toMatchObject({
    denominator: 0,
    state: "notApplicable",
    value: null,
  });
});
it("internal retries and expanded dependencies do not improve strict pass denominator", () => {
  const recovered = run("infra", "passed", "blocked", true),
    diagnostic = run("assertion", "failed", "failed", true),
    dependency = run("producer", "passed");
  const input = snapshot([recovered, diagnostic, dependency], 2);
  input.selection.requestedRunIds = ["infra", "assertion"];
  input.selection.duplicates = 2;
  input.selection.excluded = [{ memberKey: "excluded", reasonCode: "authorized" }];
  const metrics = executionMetrics(input);
  validate("ExecutionMetrics", metrics);
  expect(metrics.counts).toMatchObject({
    requested: 2,
    expanded: 1,
    attempts: 4,
    retried: 2,
    duplicates: 2,
    excluded: 1,
    failed: 1,
    passed: 1,
  });
  expect(metrics.rates.strictPassRate).toMatchObject({ numerator: 0, denominator: 2 });
  expect(metrics.rates.terminalPassRate).toMatchObject({ numerator: 1, denominator: 2 });
  expect(metrics.rates.retryRecoveryRate).toMatchObject({ numerator: 1, denominator: 1 });
  expect(metrics.rates.diagnosticRetryPassRate).toMatchObject({ numerator: 1, denominator: 1 });
  expect(metrics.rates.firstAttemptFailureRate).toMatchObject({ numerator: 1, denominator: 1 });
});
