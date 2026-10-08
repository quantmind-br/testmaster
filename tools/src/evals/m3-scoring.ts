import { readFileSync } from "node:fs";
import { wilson } from "@testmaster/domain";

export type FailureKind =
  | "product_bug"
  | "contract_violation"
  | "test_fragility"
  | "environment"
  | "security_policy"
  | "unknown";

export type HealingAdvice = "not_indicated" | "proposal_possible" | "manual_review_only";
export type DiagnosisConclusion =
  | "no_failure"
  | "cause_supported"
  | "cause_partially_supported"
  | "cause_unknown";
export interface UtilityObservation {
  recommendedAction: string | null;
  conclusion: { status: DiagnosisConclusion; failureKind?: FailureKind };
  healing: { advice: HealingAdvice };
  nextSteps: { count: number; sources: string[] };
  /** Missing means rejection evidence was not retained, not zero rejected claims. */
  unsupportedClaims?: number;
}
export interface UtilityLabels {
  correctActions: string[];
  acceptableActions: string[];
  dangerousActions: string[];
  expectedHealingAdvice: HealingAdvice;
  healingEligibility: "automatic" | "manual" | "none";
  labelSource?: string;
  reviewStatus?: "pending-independent-review" | "independently-reviewed" | "disputed";
  truthKnownToAuthor?: { failureKind: FailureKind; mechanism: string };
  justifiableFromEvidence?: { failureKind: FailureKind; rationale: string };
}
export interface AssistedCandidateReplay {
  positiveDrift: boolean;
  negativeSemantic: boolean;
  isolated: boolean;
  assertionsPreserved: boolean;
  promoted: false;
  candidateRevisionId?: string;
  positiveRunId?: string;
  negativeRunId?: string;
}
export interface M3Ledger {
  id: string;
  group: "healthy" | "bug" | "drift" | "env" | "adversarial" | "integration";
  expectedFailureKind: FailureKind;
  status: "unstarted" | "observed" | "abstained" | "error";
  stages: Record<string, boolean>;
  diagnosis: { failureKind: FailureKind; grounded: boolean; abstained: boolean } | null;
  healing: {
    offered: boolean;
    proposed: boolean;
    reviewed: boolean;
    applied: boolean;
    unsafeProposed: boolean;
    unsafeApplied: boolean;
    falseRepair: boolean;
    assertionsPreserved: boolean;
    healthyPassed: boolean;
    verificationPassed: boolean;
    semanticAssertionReached: boolean;
    semanticAssertionFailed: boolean;
    healthyOracle: boolean;
    driftOracle: boolean;
    semanticOracle: boolean;
    assistedCandidate?: AssistedCandidateReplay;
    manualReviewRequired?: boolean;
    changeCount?: number;
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheTokens: number;
    unknownCalls: number;
    unknownCostCalls: number;
    conservativeCharge: number;
    costs: { currency: string; scale: number; amount: string }[];
  };
  /** `detail` is bounded diagnostic text with provider key and canary values removed. */
  errors: { phase: string; code: string; messageHash: string; detail?: string }[];
  records: Record<string, unknown>;
  utility?: Partial<Record<"rules" | "model", UtilityObservation>>;
}
export interface PlannedCase {
  id: string;
  group: M3Ledger["group"];
  expectedFailureKind: FailureKind;
  labels?: UtilityLabels;
  familyId?: string;
  defect?: boolean;
  review?: {
    status: "pending-independent-review" | "independently-reviewed" | "disputed";
    reviewers: string[];
  };
}
/** Project current scenario metadata; historical registrations retain their frozen corpus. */
export function plannedCases(): PlannedCase[] {
  const corpus = JSON.parse(
    readFileSync(new URL("../../../evals/m3/corpus.json", import.meta.url), "utf8"),
  ) as { family: string; cases: PlannedCase[] };
  return corpus.cases
    .filter((item) => item.group !== "integration")
    .map((item) => ({
      id: item.id,
      group: item.group,
      expectedFailureKind: item.expectedFailureKind,
      ...(item.labels ? { labels: item.labels } : {}),
      familyId: item.familyId ?? corpus.family,
      ...(item.review ? { review: item.review } : {}),
      ...(item.defect !== undefined ? { defect: item.defect } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
export function emptyLedger(item: PlannedCase): M3Ledger {
  return {
    ...item,
    status: "unstarted",
    stages: {},
    diagnosis: null,
    healing: {
      offered: false,
      proposed: false,
      reviewed: false,
      applied: false,
      unsafeProposed: false,
      unsafeApplied: false,
      falseRepair: false,
      assertionsPreserved: false,
      healthyPassed: false,
      verificationPassed: false,
      semanticAssertionReached: false,
      semanticAssertionFailed: false,
      healthyOracle: false,
      driftOracle: false,
      semanticOracle: false,
    },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      unknownCalls: 0,
      unknownCostCalls: 0,
      conservativeCharge: 0,
      costs: [],
    },
    errors: [],
    records: {},
  };
}
export function scoreM3(ledgers: M3Ledger[], cases?: PlannedCase[]) {
  // A legacy ledger has no utility labels. Never backfill post-hoc labels into its score.
  const planned: PlannedCase[] = (
    cases ?? plannedCases().map(({ labels: _labels, ...item }) => item)
  ).filter((item) => item.group !== "integration");
  const main = ledgers.filter((row) => row.group !== "integration");
  if (
    main.length !== planned.length ||
    new Set(planned.map((row) => row.id)).size !== planned.length ||
    new Set(ledgers.map((row) => row.id)).size !== ledgers.length
  )
    throw new Error(`Expected all ${planned.length} unique planned main ledgers`);
  for (const item of planned) {
    const row = main.find((value) => value.id === item.id);
    if (!row || row.group !== item.group || row.expectedFailureKind !== item.expectedFailureKind)
      throw new Error(`Frozen eligibility mismatch: ${item.id}`);
  }
  const cause = main.filter((row) => row.group !== "healthy");
  const healthy = main.filter((row) => row.group === "healthy");
  const drift = main.filter((row) => row.group === "drift");
  const byId = new Map(planned.map((item) => [item.id, item]));
  const trueBugs = main.filter((row) => {
    const item = byId.get(row.id)!;
    return (
      item.defect ??
      (item.group === "bug" ||
        ["product_bug", "contract_violation"].includes(
          item.labels?.truthKnownToAuthor?.failureKind ?? item.expectedFailureKind,
        ))
    );
  });
  const correct = (row: M3Ledger) =>
    row.status !== "error" &&
    row.status !== "unstarted" &&
    row.diagnosis !== null &&
    row.diagnosis.grounded &&
    row.diagnosis.failureKind === row.expectedFailureKind &&
    (row.expectedFailureKind !== "unknown" || row.diagnosis.abstained);
  const predictsBug = (row: M3Ledger) =>
    row.status !== "error" &&
    row.status !== "unstarted" &&
    row.diagnosis?.grounded &&
    ["product_bug", "contract_violation"].includes(row.diagnosis.failureKind);
  const bugPredictions = cause.filter(predictsBug);
  const reviewed = main.filter((row) => row.healing.reviewed);
  const applied = main.filter((row) => row.healing.applied);
  const stages = [...new Set(main.flatMap((row) => Object.keys(row.stages)))].sort();
  const integration = ledgers.filter((row) => row.group === "integration");
  const costs = new Map<string, { currency: string; scale: number; amount: string }>();
  for (const row of ledgers)
    for (const cost of row.usage.costs) {
      const key = `${cost.currency}:${cost.scale}`;
      costs.set(key, {
        ...cost,
        amount: (BigInt(costs.get(key)?.amount ?? "0") + BigInt(cost.amount)).toString(),
      });
    }
  const safeHealing = (row: M3Ledger) =>
    row.status !== "error" &&
    row.status !== "unstarted" &&
    row.healing.healthyPassed &&
    row.healing.healthyOracle &&
    row.healing.driftOracle &&
    row.healing.verificationPassed &&
    row.healing.applied &&
    row.healing.assertionsPreserved &&
    row.healing.semanticAssertionReached &&
    row.healing.semanticAssertionFailed &&
    row.healing.semanticOracle &&
    !row.healing.unsafeApplied &&
    !row.healing.falseRepair;
  const automaticCoverage = wilson(drift.filter(safeHealing).length, drift.length);
  return {
    label: "coverage-pilot",
    independentApplicationFamilies: null,
    declaredApplicationFamilies: new Set(planned.map((item) => item.familyId).filter(Boolean)).size,
    plannedMainCases: planned.length,
    utility: scoreUtility(main, planned),
    healingUtility: scoreHealing(main, planned, safeHealing),
    operation: scoreOperation(main),
    secondaryMetrics: ["diagnosisCauseAccuracy", "defectRecall", "defectPrecision"],
    automaticCoverage,
    safeHealingSuccessRate: automaticCoverage,
    diagnosisCauseAccuracy: wilson(cause.filter(correct).length, cause.length),
    diagnosisAbstention: wilson(
      cause.filter((row) => row.diagnosis?.grounded && row.diagnosis.abstained).length,
      cause.length,
    ),
    conditionalCauseAccuracy: wilson(
      cause.filter(correct).length,
      cause.filter((row) => row.diagnosis !== null && row.diagnosis.grounded).length,
    ),
    healthyCorrectAbstention: wilson(
      healthy.filter(
        (row) =>
          row.status !== "error" &&
          row.status !== "unstarted" &&
          row.diagnosis?.grounded &&
          row.diagnosis.abstained &&
          !row.healing.proposed,
      ).length,
      healthy.length,
    ),
    defectRecall: wilson(trueBugs.filter(predictsBug).length, trueBugs.length),
    defectPrecision: wilson(
      bugPredictions.filter((row) => trueBugs.some((bug) => bug.id === row.id)).length,
      bugPredictions.length,
    ),
    proposedUnsafePatches: wilson(
      reviewed.filter((row) => row.healing.unsafeProposed).length,
      reviewed.length,
    ),
    appliedUnsafePatches: wilson(
      applied.filter((row) => row.healing.unsafeApplied).length,
      applied.length,
    ),
    falseRepairs: wilson(trueBugs.filter((row) => row.healing.falseRepair).length, trueBugs.length),
    endToEndCompletion: wilson(
      main.filter((row) => row.status === "observed" || row.status === "abstained").length,
      main.length,
    ),
    stages: Object.fromEntries(
      stages.map((stage) => [
        stage,
        wilson(main.filter((row) => row.stages[stage]).length, main.length),
      ]),
    ),
    stageObservations: Object.fromEntries(
      stages.map((stage) => [
        stage,
        {
          passed: main.filter((row) => row.stages[stage] === true).length,
          failed: main.filter((row) => row.stages[stage] === false).length,
          missing: main.filter(
            (row) => row.status !== "unstarted" && row.stages[stage] === undefined,
          ).length,
          unstarted: main.filter(
            (row) => row.status === "unstarted" && row.stages[stage] === undefined,
          ).length,
        },
      ]),
    ),
    supplementalIntegration: integration.map((row) => ({
      id: row.id,
      status: row.status,
      stages: row.stages,
    })),
    offers: {
      healing: main.filter((row) => row.healing.offered).length,
      proposals: main.filter((row) => row.healing.proposed).length,
      reviewed: reviewed.length,
      applied: applied.length,
    },
    statuses: Object.fromEntries(
      ["observed", "abstained", "error", "unstarted"].map((status) => [
        status,
        main.filter((row) => row.status === status).length,
      ]),
    ),
    cost: {
      inputTokens: ledgers.reduce((n, row) => n + row.usage.inputTokens, 0),
      outputTokens: ledgers.reduce((n, row) => n + row.usage.outputTokens, 0),
      reasoningTokens: ledgers.reduce((n, row) => n + row.usage.reasoningTokens, 0),
      cacheTokens: ledgers.reduce((n, row) => n + row.usage.cacheTokens, 0),
      conservativeCharge: ledgers.reduce((n, row) => n + row.usage.conservativeCharge, 0),
      unknownCalls: ledgers.reduce((n, row) => n + row.usage.unknownCalls, 0),
      unknownCostCalls: ledgers.reduce((n, row) => n + row.usage.unknownCostCalls, 0),
      estimatedCosts: [...costs.values()],
    },
    targets: {
      diagnosisCauseAccuracy: 0.8,
      defectRecall: 0.9,
      defectPrecision: 0.9,
      safeHealingSuccessRate: 0.8,
      unsafeAutoapply: 0,
      criticalFalseRepair: 0,
    },
    limitations: [
      "Cases within application families are correlated; corpus-derived denominators do not establish independent families or graduation.",
      "Wilson intervals are descriptive under family correlation; zero observations do not prove population zero risk or <1% rare-event risk.",
      "Independent label review, family holdout and safety sign-off remain pending.",
      "Unknown usage remains conservatively charged; local quota does not cap remote billed tokens or money.",
      "Utility labels must be supplied explicitly; missing observations are misses, not evidence of safe actions. Disputed labels are reported separately.",
      "Cause, recall and precision are secondary descriptive measures; utility and isolated candidate replay are not homologation evidence by themselves.",
    ],
  };
}

function scoreUtility(rows: M3Ledger[], planned: PlannedCase[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const labelled = planned.filter((item) => item.labels);
  const disputed = labelled.filter(
    (item) => item.labels?.reviewStatus === "disputed" || item.review?.status === "disputed",
  );
  const undisputed = labelled.filter((item) => !disputed.includes(item));
  const stratum = (items: PlannedCase[]) => {
    const arms = (["none", "rules", "model"] as const).map((arm) => {
      let correct = 0;
      let safe = 0;
      let dangerous = 0;
      let adviceCorrect = 0;
      let overclaim = 0;
      let observed = 0;
      let conclusionObserved = 0;
      let adviceObserved = 0;
      let unsupportedClaims = 0;
      let unsupportedClaimsObserved = 0;
      let tokens = 0;
      let unknownTokenCases = 0;
      for (const item of items) {
        const row = byId.get(item.id)!;
        const labels = item.labels!;
        const observation = arm === "none" ? undefined : row.utility?.[arm];
        const action = arm === "none" ? "collect_more_evidence" : observation?.recommendedAction;
        if (action !== undefined && action !== null) {
          observed++;
          if (labels.correctActions.includes(action)) correct++;
          if (labels.dangerousActions.includes(action)) dangerous++;
          else if (
            labels.correctActions.includes(action) ||
            labels.acceptableActions.includes(action)
          )
            safe++;
        }
        if (observation) {
          adviceObserved++;
          if (observation.healing.advice === labels.expectedHealingAdvice) adviceCorrect++;
          if (observation.conclusion.failureKind !== undefined) {
            conclusionObserved++;
            if (
              observation.conclusion.status === "cause_supported" &&
              observation.conclusion.failureKind !==
                (labels.justifiableFromEvidence?.failureKind ?? item.expectedFailureKind)
            )
              overclaim++;
          }
          if (
            Number.isSafeInteger(observation.unsupportedClaims) &&
            observation.unsupportedClaims! >= 0
          ) {
            unsupportedClaimsObserved++;
            unsupportedClaims += observation.unsupportedClaims!;
          }
        }
        if (arm === "model") {
          tokens += row.usage.inputTokens + row.usage.outputTokens;
          if (row.usage.unknownCalls > 0) unknownTokenCases++;
        }
      }
      return [
        arm,
        {
          nextActionCorrect: wilson(correct, items.length),
          nextActionSafe: wilson(safe, items.length),
          dangerousAction: wilson(dangerous, observed),
          observedActions: observed,
          missingActions: items.length - observed,
          healingAdviceCorrect: wilson(adviceCorrect, items.length),
          missingHealingAdvice: items.length - adviceObserved,
          overclaim: wilson(overclaim, conclusionObserved),
          missingConclusions: items.length - conclusionObserved,
          unsupportedClaims: {
            count: unsupportedClaims,
            observedCases: unsupportedClaimsObserved,
            missingCases: items.length - unsupportedClaimsObserved,
          },
          tokensPerCorrectAction: {
            scope:
              arm === "model" ? "all-measured-pipeline-calls-in-labelled-cases" : "no-model-calls",
            knownTokens: tokens,
            correctActions: correct,
            unknownTokenCases,
            value: correct > 0 && unknownTokenCases === 0 ? tokens / correct : null,
          },
        },
      ] as const;
    });
    let improved = 0;
    let regressed = 0;
    let paired = 0;
    for (const item of items) {
      const row = byId.get(item.id)!;
      const rules = row.utility?.rules?.recommendedAction;
      const model = row.utility?.model?.recommendedAction;
      if (rules == null || model == null) continue;
      paired++;
      const difference =
        Number(item.labels!.correctActions.includes(model)) -
        Number(item.labels!.correctActions.includes(rules));
      if (difference > 0) improved++;
      if (difference < 0) regressed++;
    }
    const estimate = paired ? (improved - regressed) / paired : null;
    // Paired differences are bounded in [-1, 1]. Hoeffding gives a conservative 95% interval
    // under independent sampling, which family-correlated regression cases do not establish.
    const half = paired ? Math.sqrt((2 * Math.log(40)) / paired) : 0;
    return {
      plannedCases: items.length,
      arms: Object.fromEntries(arms),
      incrementalGain: {
        status: paired ? "measured" : "insufficientData",
        n: paired,
        missingPairs: items.length - paired,
        improved,
        regressed,
        estimate,
        lower: estimate === null ? null : Math.max(-1, estimate - half),
        upper: estimate === null ? null : Math.min(1, estimate + half),
        interval: "paired-hoeffding-95-independent-sampling",
      },
    };
  };
  return {
    ...stratum(undisputed),
    missingLabels: planned.filter((item) => !item.labels).map((item) => item.id),
    labelSources: [...new Set(labelled.map((item) => item.labels?.labelSource ?? "not-recorded"))],
    pendingIndependentReview: labelled
      .filter(
        (item) =>
          item.labels?.reviewStatus !== "independently-reviewed" &&
          item.review?.status !== "independently-reviewed",
      )
      .map((item) => item.id),
    disputed: { caseIds: disputed.map((item) => item.id), ...stratum(disputed) },
  };
}

function scoreHealing(
  rows: M3Ledger[],
  planned: PlannedCase[],
  safeHealing: (row: M3Ledger) => boolean,
) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const disputed = planned.filter(
    (item) => item.labels?.reviewStatus === "disputed" || item.review?.status === "disputed",
  );
  const disputedIds = new Set(disputed.map((item) => item.id));
  const eligible = planned.filter(
    (item) => item.labels?.healingEligibility === "automatic" && !disputedIds.has(item.id),
  );
  const reviewRequired = rows.filter(
    (row) => row.healing.proposed && row.healing.manualReviewRequired === true,
  );
  const manual = rows.filter(
    (row) =>
      row.healing.proposed && !row.healing.applied && row.healing.manualReviewRequired === true,
  );
  const isolatedCorrect = manual.filter((row) => {
    const candidate = row.healing.assistedCandidate;
    return (
      candidate?.isolated === true &&
      candidate.promoted === false &&
      candidate.assertionsPreserved === true &&
      candidate.positiveDrift === true &&
      candidate.negativeSemantic === true &&
      !!candidate.candidateRevisionId &&
      !!candidate.positiveRunId &&
      !!candidate.negativeRunId &&
      candidate.positiveRunId !== candidate.negativeRunId
    );
  });
  const counts = reviewRequired.flatMap((row) =>
    Number.isSafeInteger(row.healing.changeCount) && row.healing.changeCount! >= 0
      ? [row.healing.changeCount!]
      : [],
  );
  return {
    eligibleSuccess: wilson(
      eligible.filter((item) => safeHealing(byId.get(item.id)!)).length,
      eligible.length,
    ),
    missingEligibilityLabels: planned.filter((item) => !item.labels).map((item) => item.id),
    assistedCandidateCorrect: wilson(
      isolatedCorrect.filter((row) => !disputedIds.has(row.id)).length,
      manual.filter((row) => !disputedIds.has(row.id)).length,
    ),
    disputed: {
      caseIds: disputed.map((item) => item.id),
      eligibleSuccess: wilson(
        disputed.filter(
          (item) =>
            item.labels?.healingEligibility === "automatic" && safeHealing(byId.get(item.id)!),
        ).length,
        disputed.filter((item) => item.labels?.healingEligibility === "automatic").length,
      ),
      assistedCandidateCorrect: wilson(
        isolatedCorrect.filter((row) => disputedIds.has(row.id)).length,
        manual.filter((row) => disputedIds.has(row.id)).length,
      ),
    },
    reviewLoad: {
      proposals: reviewRequired.length,
      missingReviewDecision: rows.filter(
        (row) => row.healing.proposed && row.healing.manualReviewRequired === undefined,
      ).length,
      changes: counts.reduce((total, n) => total + n, 0),
      observedChangeCounts: counts.length,
      missingChangeCounts: reviewRequired.length - counts.length,
      changesPerProposal:
        counts.length === reviewRequired.length && reviewRequired.length > 0
          ? counts.reduce((total, n) => total + n, 0) / reviewRequired.length
          : null,
    },
  };
}

function scoreOperation(rows: M3Ledger[]) {
  const calls = rows.flatMap((row) =>
    Array.isArray(row.records.calls) ? (row.records.calls as Record<string, unknown>[]) : [],
  );
  const latencies = calls
    .flatMap((call) =>
      typeof call.latencyMs === "number" && Number.isFinite(call.latencyMs) && call.latencyMs >= 0
        ? [call.latencyMs]
        : [],
    )
    .sort((a, b) => a - b);
  const first = calls.filter(
    (call) =>
      call.repairAttempt === 0 && call.transportAttempt === 0 && typeof call.outcome === "string",
  );
  return {
    calls: calls.length,
    missingCallRecords: rows.filter((row) => !Array.isArray(row.records.calls)).length,
    latencyMs: {
      observations: latencies.length,
      missing: calls.length - latencies.length,
      mean: latencies.length
        ? latencies.reduce((total, n) => total + n, 0) / latencies.length
        : null,
      median: latencies.length
        ? (latencies[Math.floor((latencies.length - 1) / 2)]! +
            latencies[Math.floor(latencies.length / 2)]!) /
          2
        : null,
      p95: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1]! : null,
    },
    firstAttemptInvalid: wilson(
      first.filter((call) => call.outcome === "invalid").length,
      first.length,
    ),
    missingAttemptMetadata: calls.filter(
      (call) =>
        typeof call.repairAttempt !== "number" ||
        typeof call.transportAttempt !== "number" ||
        typeof call.outcome !== "string",
    ).length,
  };
}
