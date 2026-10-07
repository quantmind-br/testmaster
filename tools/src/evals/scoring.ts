import { wilson } from "@testmaster/domain";
export const exclusionCodes = [
  "oracle_error",
  "oracle_mismatch",
  "sandbox_unavailable",
  "worker_lost",
  "provider_transport",
  "provider_timeout",
  "budget_exhausted",
  "wall_time_exhausted",
  "missing_key",
  "not_started",
] as const;
export type Exclusion = (typeof exclusionCodes)[number];
export interface TrialError {
  phase: string;
  code: string;
  message: string;
  evidence: unknown;
  exclusion: Exclusion | null;
}
export function classifyExclusion(code: string, evidence: unknown): Exclusion | null {
  if (evidence === undefined || evidence === null) return null;
  return exclusionCodes.find((candidate) => candidate === code) ?? null;
}
export interface Replay {
  testId: string;
  revisionId: string;
  runId: string | null;
  outcome: string | null;
  gate: string | null;
  requiredAssertionFailed: boolean;
}
export interface Pair {
  healthy: Replay;
  mutant: Replay;
}
export interface TrialScoreInput {
  trialId: string;
  caseId: string;
  split: "development" | "holdout";
  category: string;
  oracle: { healthyConfirmed: boolean; defectConfirmed: boolean };
  pairs: Pair[];
  errors: TrialError[];
  generatedProposals: number;
  validProposals: number;
}
export function scoreTrial(trial: TrialScoreInput) {
  const exclusions = [
    ...new Set(
      trial.errors.flatMap((error) =>
        error.exclusion && classifyExclusion(error.exclusion, error.evidence)
          ? [error.exclusion]
          : [],
      ),
    ),
  ];
  const oracleConfirmed = trial.oracle.healthyConfirmed && trial.oracle.defectConfirmed;
  const sensitivePairs = trial.pairs.filter(
    ({ healthy, mutant }) =>
      healthy.testId === mutant.testId &&
      healthy.revisionId === mutant.revisionId &&
      healthy.runId !== null &&
      mutant.runId !== null &&
      healthy.outcome === "passed" &&
      healthy.gate === "passed" &&
      mutant.outcome === "failed" &&
      mutant.requiredAssertionFailed,
  );
  return {
    trialId: trial.trialId,
    caseId: trial.caseId,
    detected: oracleConfirmed && exclusions.length === 0 && sensitivePairs.length > 0,
    conditionalEligible: oracleConfirmed && exclusions.length === 0,
    exclusions,
    sensitiveRevisionIds:
      oracleConfirmed && !exclusions.length
        ? sensitivePairs.map((pair) => pair.healthy.revisionId)
        : [],
    healthyValid: trial.pairs.filter((pair) =>
      ["passed", "failed"].includes(pair.healthy.outcome ?? ""),
    ).length,
    healthyFailed: trial.pairs.filter((pair) => pair.healthy.outcome === "failed").length,
    healthyUnavailable: trial.pairs.filter(
      (pair) => !["passed", "failed"].includes(pair.healthy.outcome ?? ""),
    ).length,
  };
}
export function summarize(trials: TrialScoreInput[]) {
  if (
    new Set(trials.map((trial) => trial.trialId)).size !== trials.length ||
    new Set(trials.map((trial) => trial.caseId)).size !== trials.length
  )
    throw new Error("Duplicate trial/case would inflate the preregistered denominator");
  const scores = trials.map(scoreTrial);
  const count = (subset: typeof scores) =>
    wilson(subset.filter((score) => score.detected).length, subset.length);
  return {
    label: "experimental" as const,
    nPlanned: trials.length,
    independentFamilies: 1,
    primary: count(scores),
    conditional: count(scores.filter((score) => score.conditionalEligible)),
    healthyFalseFailure: wilson(
      scores.reduce((n, score) => n + score.healthyFailed, 0),
      scores.reduce((n, score) => n + score.healthyValid, 0),
    ),
    healthyUnavailable: scores.reduce((n, score) => n + score.healthyUnavailable, 0),
    proposalValidity: wilson(
      trials.reduce((n, trial) => n + trial.validProposals, 0),
      trials.reduce((n, trial) => n + trial.generatedProposals, 0),
    ),
    strata: Object.fromEntries(
      [...new Set(trials.flatMap((trial) => [trial.split, trial.category]))].map((stratum) => [
        stratum,
        count(
          scores.filter(
            (_score, i) => trials[i]?.split === stratum || trials[i]?.category === stratum,
          ),
        ),
      ]),
    ),
    exclusions: scores.filter((score) => score.exclusions.length),
    errors: trials.flatMap((trial) =>
      trial.errors.map((error) => ({ trialId: trial.trialId, ...error })),
    ),
    scores,
  };
}
