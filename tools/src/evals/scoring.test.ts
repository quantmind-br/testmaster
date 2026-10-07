import { wilson } from "@testmaster/domain";
import { describe, expect, it } from "vitest";
import { classifyExclusion, scoreTrial, summarize, type TrialScoreInput } from "./scoring.js";

function trial(): TrialScoreInput {
  return {
    trialId: "trial-1",
    caseId: "case-1",
    split: "holdout",
    category: "health",
    oracle: { healthyConfirmed: true, defectConfirmed: true },
    errors: [],
    generatedProposals: 1,
    validProposals: 1,
    pairs: [
      {
        healthy: {
          testId: "test-1",
          revisionId: "revision-1",
          runId: "healthy-run",
          outcome: "passed",
          gate: "passed",
          requiredAssertionFailed: false,
        },
        mutant: {
          testId: "test-1",
          revisionId: "revision-1",
          runId: "mutant-run",
          outcome: "failed",
          gate: "failed",
          requiredAssertionFailed: true,
        },
      },
    ],
  };
}
describe("Wilson proportions", () => {
  it("matches published binomial examples and boundaries", () => {
    const half = wilson(5, 10);
    expect(half.lower).toBeCloseTo(0.2365896, 6);
    expect(half.upper).toBeCloseTo(0.7634104, 6);
    expect(wilson(0, 10).lower).toBe(0);
    expect(wilson(0, 10).upper).toBeCloseTo(0.2775402, 6);
    expect(wilson(10, 10).lower).toBeCloseTo(0.7224598, 6);
    expect(wilson(10, 10).upper).toBe(1);
    expect(wilson(0, 0)).toMatchObject({
      status: "insufficientData",
      estimate: null,
      lower: null,
      upper: null,
    });
  });
  it("refuses impossible or fractional denominators", () => {
    for (const [successes, n] of [
      [-1, 2],
      [3, 2],
      [0, -1],
      [0.5, 1],
      [1, Number.NaN],
    ])
      expect(() => wilson(successes as number, n as number)).toThrow(RangeError);
  });
});
describe("independent mutant scoring", () => {
  it("credits only paired identical revisions with independent confirmed ground truth", () => {
    expect(scoreTrial(trial()).detected).toBe(true);
    const input = trial();
    input.oracle.defectConfirmed = false;
    expect(scoreTrial(input).detected).toBe(false);
    input.oracle.defectConfirmed = true;
    const pair = input.pairs[0];
    if (!pair) throw new Error("Missing test pair");
    pair.mutant.revisionId = "edited-revision";
    expect(scoreTrial(input).detected).toBe(false);
    pair.mutant.revisionId = "revision-1";
    pair.mutant.requiredAssertionFailed = false;
    expect(scoreTrial(input).detected).toBe(false);
    pair.mutant.requiredAssertionFailed = true;
    pair.healthy.gate = "failed";
    expect(scoreTrial(input).detected).toBe(false);
  });
  it("does not credit timeouts, missing runs, failed baseline or no tests", () => {
    for (const outcome of ["blocked", "cancelled", "inconclusive", "passed", null]) {
      const input = trial();
      const pair = input.pairs[0];
      if (!pair) throw new Error("Missing test pair");
      pair.mutant.outcome = outcome;
      expect(scoreTrial(input).detected).toBe(false);
    }
    const input = trial();
    input.pairs = [];
    expect(scoreTrial(input).detected).toBe(false);
  });
  it("retains infrastructure and invalid-output misses in the planned denominator", () => {
    const excluded = trial();
    excluded.trialId = "trial-2";
    excluded.caseId = "case-2";
    excluded.errors.push({
      phase: "replay",
      code: "sandbox_unavailable",
      message: "Daemon unavailable",
      evidence: { reasonCode: "sandbox_unavailable" },
      exclusion: "sandbox_unavailable",
    });
    const invalid = trial();
    invalid.trialId = "trial-3";
    invalid.caseId = "case-3";
    invalid.pairs = [];
    invalid.errors.push({
      phase: "plan",
      code: "invalid_model_output",
      message: "Invalid after repair",
      evidence: { code: "INVALID_ARGUMENT" },
      exclusion: null,
    });
    const report = summarize([trial(), excluded, invalid]);
    expect(report.primary).toMatchObject({ successes: 1, n: 3 });
    expect(report.conditional).toMatchObject({ successes: 1, n: 2 });
    expect(report.label).toBe("experimental");
    expect(report.errors).toHaveLength(2);
    expect(report.exclusions).toHaveLength(1);
  });
  it("requires evidence for exclusions and refuses ad hoc exclusions", () => {
    expect(classifyExclusion("provider_timeout", { code: "UPSTREAM_TIMEOUT" })).toBe(
      "provider_timeout",
    );
    expect(classifyExclusion("provider_timeout", null)).toBeNull();
    for (const code of [
      "healthy_assertion_failure",
      "invalid_proposal",
      "policy_denial",
      "INTERNAL",
      "generated_action_failure",
    ])
      expect(classifyExclusion(code, { code })).toBeNull();
  });
  it("reports empty secondary denominators and refuses duplicate case inflation", () => {
    expect(summarize([]).primary.status).toBe("insufficientData");
    expect(() => summarize([trial(), trial()])).toThrow("Duplicate");
    const input = trial();
    input.pairs = [];
    input.generatedProposals = 0;
    input.validProposals = 0;
    expect(summarize([input]).proposalValidity.status).toBe("insufficientData");
    expect(summarize([input]).healthyFalseFailure.status).toBe("insufficientData");
  });
});
