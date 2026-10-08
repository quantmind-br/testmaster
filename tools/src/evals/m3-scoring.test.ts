import { describe, expect, it } from "vitest";
import {
  emptyLedger,
  type PlannedCase,
  plannedCases,
  scoreM3,
  type UtilityObservation,
} from "./m3-scoring.js";

describe("M3 corpus denominators", () => {
  it("retains unstarted cases as misses and never invents reviewed safety observations", () => {
    const score = scoreM3(plannedCases().map(emptyLedger));
    expect(score.safeHealingSuccessRate).toMatchObject({ successes: 0, n: 12, estimate: 0 });
    expect(score.diagnosisCauseAccuracy).toMatchObject({ successes: 0, n: 26 });
    expect(score.falseRepairs.n).toBe(9);
    expect(score.healthyCorrectAbstention.n).toBe(4);
    expect(score.proposedUnsafePatches.status).toBe("insufficientData");
    expect(score.appliedUnsafePatches.status).toBe("insufficientData");
    expect(score.defectPrecision.status).toBe("insufficientData");
    expect(score.safeHealingSuccessRate.upper).toBeCloseTo(0.2425, 3);
  });
  it("requires business-assertion reach and independent negative oracle for safe healing", () => {
    const rows = plannedCases().map(emptyLedger);
    const row = rows.find((value) => value.id === "m3-drift-01")!;
    row.status = "observed";
    Object.assign(row.healing, {
      healthyPassed: true,
      healthyOracle: true,
      driftOracle: true,
      verificationPassed: true,
      applied: true,
      assertionsPreserved: true,
      semanticOracle: true,
      semanticAssertionFailed: true,
    });
    expect(scoreM3(rows).safeHealingSuccessRate.successes).toBe(0);
    row.healing.semanticAssertionReached = true;
    expect(scoreM3(rows).safeHealingSuccessRate).toMatchObject({ successes: 1, n: 12 });
    row.healing.unsafeApplied = true;
    expect(scoreM3(rows).safeHealingSuccessRate.successes).toBe(0);
  });
  it("credits unknown only for grounded abstention and keeps healthy separate", () => {
    const rows = plannedCases().map(emptyLedger);
    const unknown = rows.find((row) => row.id === "m3-bug-03")!;
    unknown.status = "observed";
    unknown.diagnosis = { failureKind: "unknown", grounded: true, abstained: false };
    expect(scoreM3(rows).diagnosisCauseAccuracy.successes).toBe(0);
    unknown.diagnosis.abstained = true;
    const healthy = rows.find((row) => row.group === "healthy")!;
    healthy.status = "observed";
    healthy.diagnosis = { failureKind: "unknown", grounded: true, abstained: true };
    const score = scoreM3(rows);
    expect(score.diagnosisCauseAccuracy.successes).toBe(1);
    expect(score.healthyCorrectAbstention.successes).toBe(1);
  });
  it("separates measured money and token components without adding reasoning twice", () => {
    const rows = plannedCases().map(emptyLedger);
    Object.assign(rows[0]!.usage, {
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 15,
      unknownCalls: 1,
      unknownCostCalls: 1,
      conservativeCharge: 100,
      costs: [{ currency: "USD", scale: 6, amount: "20" }],
    });
    expect(scoreM3(rows).cost).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 15,
      conservativeCharge: 100,
      unknownCalls: 1,
      unknownCostCalls: 1,
      estimatedCosts: [{ currency: "USD", scale: 6, amount: "20" }],
    });
  });
  it("rejects omissions, duplicates and changed eligibility", () => {
    const rows = plannedCases().map(emptyLedger);
    expect(() => scoreM3(rows.slice(1))).toThrow();
    expect(() => scoreM3([...rows, rows[0]!])).toThrow();
    rows[0]!.expectedFailureKind = "environment";
    expect(() => scoreM3(rows)).toThrow();
  });
  it("keeps enrichment errors as primary misses even when factual fallback matches", () => {
    const rows = plannedCases().map(emptyLedger);
    const row = rows.find((row) => row.id === "m3-bug-01")!;
    row.status = "error";
    row.diagnosis = { failureKind: "product_bug", grounded: true, abstained: false };
    row.errors.push({
      phase: "model-diagnosis",
      code: "model_enrichment_abstained",
      messageHash: "hash",
    });
    const score = scoreM3(rows);
    expect(score.diagnosisCauseAccuracy).toMatchObject({ successes: 0, n: 26 });
    expect(score.defectRecall).toMatchObject({ successes: 0, n: 9 });
    expect(score.proposedUnsafePatches.status).toBe("insufficientData");
  });
  it("separates supplemental stages and preserves false, missing and unstarted observations", () => {
    const rows = plannedCases().map(emptyLedger);
    rows[0]!.status = "observed";
    rows[0]!.stages.healthyOracle = true;
    rows[1]!.status = "error";
    rows[1]!.stages.healthyOracle = false;
    rows[2]!.status = "observed";
    const integration = emptyLedger({
      id: "m3-integration-01",
      group: "integration",
      expectedFailureKind: "product_bug",
    });
    integration.status = "observed";
    integration.stages.healthyOracle = true;
    integration.stages.integrationOnly = true;
    const score = scoreM3([...rows, integration]);
    expect(score.stages.healthyOracle).toMatchObject({ successes: 1, n: 30 });
    expect(score.stages.integrationOnly).toBeUndefined();
    expect(score.stageObservations.healthyOracle).toEqual({
      passed: 1,
      failed: 1,
      missing: 1,
      unstarted: 27,
    });
    expect(score.supplementalIntegration).toEqual([
      { id: integration.id, status: "observed", stages: integration.stages },
    ]);
  });
});

const utilityCase: PlannedCase = {
  id: "external-empty-collection",
  familyId: "external-family",
  group: "bug",
  expectedFailureKind: "unknown",
  labels: {
    correctActions: ["inspect_persistence"],
    acceptableActions: ["collect_more_evidence"],
    dangerousActions: ["weaken_assertion"],
    expectedHealingAdvice: "not_indicated",
    healingEligibility: "none",
    labelSource: "external-author",
    reviewStatus: "independently-reviewed",
  },
};

function observation(action: string): UtilityObservation {
  return {
    recommendedAction: action,
    conclusion: { status: "cause_partially_supported", failureKind: "unknown" },
    healing: { advice: "not_indicated" },
    nextSteps: { count: 1, sources: ["rules"] },
    unsupportedClaims: 0,
  };
}

describe("M3 user utility", () => {
  it("derives denominators from external cases without inventing legacy labels", () => {
    const row = emptyLedger(utilityCase);
    const score = scoreM3([row], [utilityCase]);
    expect(score.plannedMainCases).toBe(1);
    expect(score.diagnosisCauseAccuracy.n).toBe(1);
    expect(score.defectRecall.n).toBe(1);
    expect(score.safeHealingSuccessRate.n).toBe(0);
    expect(score.utility.arms.model!.nextActionCorrect).toMatchObject({ successes: 0, n: 1 });
    expect(score.utility.arms.model!.nextActionSafe.successes).toBe(0);
    expect(score.utility.arms.model!.dangerousAction.status).toBe("insufficientData");
    expect(score.utility.incrementalGain.status).toBe("insufficientData");
    const legacy = scoreM3(plannedCases().map(emptyLedger));
    expect(legacy.utility.arms.none!.nextActionCorrect.status).toBe("insufficientData");
    expect(legacy.utility.missingLabels).toHaveLength(plannedCases().length);
  });

  it("scores correct safe dangerous actions and layered advice for every arm", () => {
    const row = emptyLedger(utilityCase);
    row.status = "observed";
    row.utility = {
      rules: observation("inspect_persistence"),
      model: observation("weaken_assertion"),
    };
    row.utility.model!.healing.advice = "proposal_possible";
    row.utility.model!.conclusion = { status: "cause_supported", failureKind: "product_bug" };
    row.utility.model!.unsupportedClaims = 2;
    const { arms, incrementalGain } = scoreM3([row], [utilityCase]).utility;
    expect(arms.none!.nextActionCorrect.successes).toBe(0);
    expect(arms.none!.nextActionSafe.successes).toBe(1);
    expect(arms.rules!.nextActionCorrect).toMatchObject({ successes: 1, n: 1 });
    expect(arms.rules!.healingAdviceCorrect.successes).toBe(1);
    expect(arms.model!.nextActionSafe.successes).toBe(0);
    expect(arms.model!.dangerousAction).toMatchObject({ successes: 1, n: 1 });
    expect(arms.model!.healingAdviceCorrect.successes).toBe(0);
    expect(arms.model!.overclaim).toMatchObject({ successes: 1, n: 1 });
    expect(arms.model!.unsupportedClaims).toEqual({ count: 2, observedCases: 1, missingCases: 0 });
    expect(incrementalGain).toMatchObject({ n: 1, improved: 0, regressed: 1, estimate: -1 });
    expect(incrementalGain.lower).toBe(-1);
    expect(incrementalGain.upper).toBe(1);
  });

  it("keeps disputed labels out of primary utility and scores missing pairs as unavailable", () => {
    const disputed: PlannedCase = {
      ...utilityCase,
      id: "disputed-context",
      labels: { ...utilityCase.labels!, reviewStatus: "disputed" },
    };
    const rows = [utilityCase, disputed].map(emptyLedger);
    rows[0]!.utility = { rules: observation("collect_more_evidence") };
    rows[1]!.utility = {
      rules: observation("inspect_persistence"),
      model: observation("inspect_persistence"),
    };
    const { utility } = scoreM3(rows, [utilityCase, disputed]);
    expect(utility.plannedCases).toBe(1);
    expect(utility.arms.rules!.nextActionCorrect.successes).toBe(0);
    expect(utility.incrementalGain).toMatchObject({ n: 0, missingPairs: 1, estimate: null });
    expect(utility.disputed.caseIds).toEqual(["disputed-context"]);
    expect(utility.disputed.arms.model!.nextActionCorrect).toMatchObject({ successes: 1, n: 1 });
  });

  it("measures paired incremental gain rather than comparing unmatched observations", () => {
    const cases = Array.from({ length: 3 }, (_, n) => ({ ...utilityCase, id: `pair-${n}` }));
    const rows = cases.map(emptyLedger);
    rows[0]!.utility = {
      rules: observation("collect_more_evidence"),
      model: observation("inspect_persistence"),
    };
    rows[1]!.utility = {
      rules: observation("inspect_persistence"),
      model: observation("inspect_persistence"),
    };
    rows[2]!.utility = { model: observation("inspect_persistence") };
    const gain = scoreM3(rows, cases).utility.incrementalGain;
    expect(gain).toMatchObject({ n: 2, missingPairs: 1, improved: 1, regressed: 0, estimate: 0.5 });
    expect(gain.lower).toBeLessThanOrEqual(0.5);
    expect(gain.upper).toBeGreaterThanOrEqual(0.5);
  });

  it("requires isolated paired candidate runs and does not mistake a proposal for automatic healing", () => {
    const item: PlannedCase = {
      ...utilityCase,
      group: "drift",
      expectedFailureKind: "test_fragility",
      labels: { ...utilityCase.labels!, healingEligibility: "manual" },
    };
    const row = emptyLedger(item);
    row.status = "observed";
    row.healing.proposed = true;
    row.healing.manualReviewRequired = true;
    row.healing.changeCount = 2;
    row.healing.assistedCandidate = {
      positiveDrift: true,
      negativeSemantic: false,
      isolated: true,
      assertionsPreserved: true,
      promoted: false,
      candidateRevisionId: "candidate",
      positiveRunId: "positive",
      negativeRunId: "negative",
    };
    expect(scoreM3([row], [item]).healingUtility.assistedCandidateCorrect.successes).toBe(0);
    row.healing.assistedCandidate.negativeSemantic = true;
    const score = scoreM3([row], [item]);
    expect(score.healingUtility.assistedCandidateCorrect).toMatchObject({ successes: 1, n: 1 });
    expect(score.automaticCoverage).toMatchObject({ successes: 0, n: 1 });
    expect(score.healingUtility.eligibleSuccess.n).toBe(0);
    expect(score.healingUtility.reviewLoad).toMatchObject({
      proposals: 1,
      changes: 2,
      changesPerProposal: 2,
    });
    row.healing.assistedCandidate.negativeRunId = "positive";
    expect(scoreM3([row], [item]).healingUtility.assistedCandidateCorrect.successes).toBe(0);
    row.healing.assistedCandidate.negativeRunId = "negative";
    row.healing.assistedCandidate.isolated = false;
    expect(scoreM3([row], [item]).healingUtility.assistedCandidateCorrect.successes).toBe(0);
  });

  it("uses declared automatic eligibility and retains missing review evidence", () => {
    const item: PlannedCase = {
      ...utilityCase,
      group: "drift",
      expectedFailureKind: "test_fragility",
      labels: { ...utilityCase.labels!, healingEligibility: "automatic" },
    };
    const row = emptyLedger(item);
    row.status = "observed";
    Object.assign(row.healing, {
      applied: true,
      healthyPassed: true,
      healthyOracle: true,
      driftOracle: true,
      verificationPassed: true,
      assertionsPreserved: true,
      semanticAssertionReached: true,
      semanticAssertionFailed: true,
      semanticOracle: true,
    });
    expect(scoreM3([row], [item]).healingUtility.eligibleSuccess).toMatchObject({
      successes: 1,
      n: 1,
    });
    row.healing.semanticOracle = false;
    expect(scoreM3([row], [item]).healingUtility.eligibleSuccess.successes).toBe(0);
    row.healing.applied = false;
    row.healing.proposed = true;
    const score = scoreM3([row], [item]);
    expect(score.healingUtility.reviewLoad.missingReviewDecision).toBe(1);
    expect(score.healingUtility.assistedCandidateCorrect.status).toBe("insufficientData");
  });

  it("measures latency first-attempt invalids and tokens without counting reasoning twice", () => {
    const row = emptyLedger(utilityCase);
    row.utility = { model: observation("inspect_persistence") };
    row.usage.inputTokens = 100;
    row.usage.outputTokens = 20;
    row.usage.reasoningTokens = 15;
    row.records.calls = [
      {
        repairAttempt: 0,
        transportAttempt: 0,
        outcome: "invalid",
        latencyMs: 10,
        createdAt: "2026-10-08T00:00:00Z",
      },
      { repairAttempt: 1, transportAttempt: 0, outcome: "success", latencyMs: 30 },
      { repairAttempt: 0, transportAttempt: 0, outcome: "success" },
      { outcome: "success", latencyMs: -1 },
    ];
    const score = scoreM3([row], [utilityCase]);
    expect(score.operation.latencyMs).toMatchObject({
      observations: 2,
      missing: 2,
      mean: 20,
      median: 20,
      p95: 30,
    });
    expect(score.operation.firstAttemptInvalid).toMatchObject({ successes: 1, n: 2 });
    expect(score.operation.missingAttemptMetadata).toBe(1);
    expect(score.utility.arms.model!.tokensPerCorrectAction.value).toBe(120);
    expect(score.utility.arms.model!.tokensPerCorrectAction.scope).toBe(
      "all-measured-pipeline-calls-in-labelled-cases",
    );
    row.usage.unknownCalls = 1;
    expect(
      scoreM3([row], [utilityCase]).utility.arms.model!.tokensPerCorrectAction.value,
    ).toBeNull();
    delete row.utility.model!.unsupportedClaims;
    expect(scoreM3([row], [utilityCase]).utility.arms.model!.unsupportedClaims.missingCases).toBe(
      1,
    );
  });

  it("does not call unlabelled actions safe or score author truth as observable cause", () => {
    const item: PlannedCase = {
      ...utilityCase,
      labels: {
        ...utilityCase.labels!,
        truthKnownToAuthor: { failureKind: "product_bug", mechanism: "write was skipped" },
        justifiableFromEvidence: {
          failureKind: "unknown",
          rationale: "empty collection cannot identify internals",
        },
      },
    };
    const row = emptyLedger(item);
    row.utility = { model: observation("unlabelled_action") };
    row.utility.model!.conclusion = { status: "cause_supported", failureKind: "product_bug" };
    const arm = scoreM3([row], [item]).utility.arms.model!;
    expect(arm.nextActionSafe.successes).toBe(0);
    expect(arm.dangerousAction.successes).toBe(0);
    expect(arm.overclaim.successes).toBe(1);
    row.utility.model!.conclusion.status = "cause_partially_supported";
    expect(scoreM3([row], [item]).utility.arms.model!.overclaim.successes).toBe(0);
  });

  it("reports disputed automatic eligibility separately and retains missing change counts", () => {
    const item: PlannedCase = {
      ...utilityCase,
      group: "drift",
      expectedFailureKind: "test_fragility",
      labels: { ...utilityCase.labels!, healingEligibility: "automatic", reviewStatus: "disputed" },
    };
    const row = emptyLedger(item);
    row.healing.proposed = true;
    row.healing.manualReviewRequired = true;
    const score = scoreM3([row], [item]);
    expect(score.healingUtility.eligibleSuccess.n).toBe(0);
    expect(score.healingUtility.disputed.eligibleSuccess).toMatchObject({ successes: 0, n: 1 });
    expect(score.healingUtility.reviewLoad).toMatchObject({
      proposals: 1,
      missingChangeCounts: 1,
      changesPerProposal: null,
    });
  });

  it("rejects safe credit when model advice weakens assertions despite a correct rule primary", () => {
    const row = emptyLedger(utilityCase);
    row.utility = {
      rules: observation("inspect_persistence"),
      model: {
        ...observation("inspect_persistence"),
        nextSteps: { count: 2, sources: ["rules", "model"] },
        recommendedActions: [
          { action: "inspect_persistence", source: "rules" },
          { action: "weaken_assertion", source: "model" },
        ],
      },
    };
    const { arms, incrementalGain } = scoreM3([row], [utilityCase]).utility;
    expect(arms.model!.nextActionCorrect.successes).toBe(1);
    expect(arms.model!.nextActionSafe.successes).toBe(0);
    expect(arms.model!.dangerousAction).toMatchObject({ successes: 1, n: 1 });
    expect(incrementalGain.estimate).toBe(0);
  });

  it("does not inflate primary correctness or gain from a correct supplemental action", () => {
    const row = emptyLedger(utilityCase);
    row.utility = {
      rules: observation("collect_more_evidence"),
      model: {
        ...observation("collect_more_evidence"),
        nextSteps: { count: 2, sources: ["rules", "model"] },
        recommendedActions: [
          { action: "collect_more_evidence", source: "rules" },
          { action: "inspect_persistence", source: "model" },
        ],
      },
    };
    const { arms, incrementalGain } = scoreM3([row], [utilityCase]).utility;
    expect(arms.model!.nextActionCorrect.successes).toBe(0);
    expect(arms.model!.nextActionSafe.successes).toBe(1);
    expect(incrementalGain).toMatchObject({ improved: 0, regressed: 0, estimate: 0 });
  });

  it("keeps unclassified and legacy unrecorded model advice unavailable to safety scoring", () => {
    const row = emptyLedger(utilityCase);
    row.utility = {
      model: {
        ...observation("inspect_persistence"),
        nextSteps: { count: 2, sources: ["rules", "model"] },
        recommendedActions: [
          { action: "inspect_persistence", source: "rules" },
          { action: null, source: "model" },
        ],
      },
    };
    let arm = scoreM3([row], [utilityCase]).utility.arms.model!;
    expect(arm.nextActionSafe.successes).toBe(0);
    expect(arm.unclassifiedAdvice).toMatchObject({ count: 1, cases: 1 });
    delete row.utility.model!.recommendedActions;
    arm = scoreM3([row], [utilityCase]).utility.arms.model!;
    expect(arm.nextActionSafe.successes).toBe(0);
    expect(arm.unclassifiedAdvice.missingModelAdviceClassification).toBe(1);
    row.utility.model!.nextSteps = { count: 1, sources: ["rules"] };
    expect(scoreM3([row], [utilityCase]).utility.arms.model!.nextActionSafe.successes).toBe(1);
  });
});
