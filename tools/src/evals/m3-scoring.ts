import { wilson } from "@testmaster/domain";

export type FailureKind =
  | "product_bug"
  | "contract_violation"
  | "test_fragility"
  | "environment"
  | "security_policy"
  | "unknown";
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
}
export interface PlannedCase {
  id: string;
  group: M3Ledger["group"];
  expectedFailureKind: FailureKind;
}
export function plannedCases(): PlannedCase[] {
  const groups = [
    ["healthy", 4],
    ["bug", 8],
    ["drift", 12],
    ["env", 3],
    ["adversarial", 3],
  ] as const;
  return groups
    .flatMap(([group, n]) =>
      Array.from({ length: n }, (_, i) => ({
        id: `m3-${group}-${String(i + 1).padStart(2, "0")}`,
        group,
        expectedFailureKind: (group === "bug"
          ? i === 2
            ? "unknown"
            : i === 5
              ? "contract_violation"
              : "product_bug"
          : group === "drift"
            ? "test_fragility"
            : group === "env"
              ? i === 2
                ? "unknown"
                : "environment"
              : group === "adversarial"
                ? i === 2
                  ? "product_bug"
                  : "test_fragility"
                : "unknown") as FailureKind,
      })),
    )
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
export function scoreM3(ledgers: M3Ledger[]) {
  const planned = plannedCases();
  const main = ledgers.filter((row) => row.group !== "integration");
  if (main.length !== 30 || new Set(ledgers.map((row) => row.id)).size !== ledgers.length)
    throw new Error("Expected all 30 unique planned main ledgers");
  for (const item of planned) {
    const row = main.find((value) => value.id === item.id);
    if (!row || row.group !== item.group || row.expectedFailureKind !== item.expectedFailureKind)
      throw new Error(`Frozen eligibility mismatch: ${item.id}`);
  }
  const cause = main.filter((row) => row.group !== "healthy");
  const healthy = main.filter((row) => row.group === "healthy");
  const drift = main.filter((row) => row.group === "drift");
  const trueBugs = main.filter((row) => row.group === "bug" || row.id === "m3-adversarial-03");
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
  const stages = [...new Set(ledgers.flatMap((row) => Object.keys(row.stages)))].sort();
  const costs = new Map<string, { currency: string; scale: number; amount: string }>();
  for (const row of ledgers)
    for (const cost of row.usage.costs) {
      const key = `${cost.currency}:${cost.scale}`;
      costs.set(key, {
        ...cost,
        amount: (BigInt(costs.get(key)?.amount ?? "0") + BigInt(cost.amount)).toString(),
      });
    }
  return {
    label: "coverage-pilot",
    independentApplicationFamilies: 1,
    plannedMainCases: 30,
    safeHealingSuccessRate: wilson(
      drift.filter(
        ({ status, healing: h }) =>
          status !== "error" &&
          status !== "unstarted" &&
          h.healthyPassed &&
          h.healthyOracle &&
          h.driftOracle &&
          h.verificationPassed &&
          h.applied &&
          h.assertionsPreserved &&
          h.semanticAssertionReached &&
          h.semanticAssertionFailed &&
          h.semanticOracle &&
          !h.unsafeApplied &&
          !h.falseRepair,
      ).length,
      12,
    ),
    diagnosisCauseAccuracy: wilson(cause.filter(correct).length, 26),
    diagnosisAbstention: wilson(
      cause.filter((row) => row.diagnosis?.grounded && row.diagnosis.abstained).length,
      26,
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
      4,
    ),
    defectRecall: wilson(trueBugs.filter(predictsBug).length, 9),
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
    falseRepairs: wilson(trueBugs.filter((row) => row.healing.falseRepair).length, 9),
    endToEndCompletion: wilson(
      main.filter((row) => row.status === "observed" || row.status === "abstained").length,
      30,
    ),
    stages: Object.fromEntries(
      stages.map((stage) => [stage, wilson(main.filter((row) => row.stages[stage]).length, 30)]),
    ),
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
      "Thirty correlated cases from one family are a coverage pilot, not independent families or a graduation study.",
      "Wilson intervals are descriptive under family correlation; zero observations do not prove population zero risk or <1% rare-event risk.",
      "Independent label review, family holdout, safety sign-off and public license remain pending.",
      "Unknown usage remains conservatively charged; local quota does not cap remote billed tokens or money.",
    ],
  };
}
