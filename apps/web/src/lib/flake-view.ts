/**
 * Flaky-study wording (UX-037). The portal never calls a test "stable" from a small sample:
 * zero failures in n valid Runs still leaves a 95% upper bound, and that bound is printed beside
 * the verdict. The wording is keyed by the server's classification, not recomputed.
 */
export interface FlakeCounts {
  readonly nPlanned: number;
  readonly nPass: number;
  readonly nFail: number;
  readonly nBlocked: number;
  readonly nCancelled: number;
  readonly nInconclusive: number;
  readonly nValid: number;
  readonly nInFlight: number;
}
export interface FlakeReport {
  readonly batchId: string;
  readonly testId: string;
  readonly revisionId: string;
  readonly environmentRevisionId: string;
  readonly counts: FlakeCounts;
  readonly failureRate: number | null;
  readonly wilson95: { readonly low: number; readonly high: number } | null;
  readonly zeroFailureUpper95: number | null;
  readonly classification:
    | "insufficient_data"
    | "passing_observed"
    | "deterministic_failure"
    | "suspected_flaky"
    | "confirmed_flaky"
    | "unstable_infrastructure";
  readonly runIds: readonly string[];
  readonly failureCauses: readonly unknown[];
  readonly limitations: readonly string[];
  readonly incompatible: readonly unknown[];
}

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

const labels: Readonly<Record<FlakeReport["classification"], string>> = {
  insufficient_data: "Not enough data",
  passing_observed: "No failure observed",
  deterministic_failure: "Fails every time",
  suspected_flaky: "Suspected flaky",
  confirmed_flaky: "Confirmed flaky",
  unstable_infrastructure: "Unstable infrastructure",
};

export interface FlakeSummary {
  readonly label: string;
  readonly tone: "neutral" | "warning" | "danger" | "success";
  readonly explanation: string;
  readonly interval: string;
}

export function describeFlake(report: FlakeReport): FlakeSummary {
  const { counts } = report;
  const sample = `${counts.nPass} passed and ${counts.nFail} failed out of ${counts.nValid} valid Runs (${counts.nPlanned} planned, ${counts.nInFlight} still running)`;
  const interval = report.wilson95
    ? `95% interval for the failure rate: ${percent(report.wilson95.low)} to ${percent(report.wilson95.high)}.`
    : "No interval yet: no valid Run has finished.";
  const bound =
    report.zeroFailureUpper95 !== null
      ? ` With no failure observed, the true failure rate could still be as high as ${percent(report.zeroFailureUpper95)} (95% upper bound).`
      : "";
  const explanations: Record<FlakeReport["classification"], string> = {
    insufficient_data: `${sample}. Too few valid Runs to say anything about flakiness.${bound}`,
    passing_observed: `${sample}. This is an observation, not proof of stability.${bound}`,
    deterministic_failure: `${sample}. Every valid Run failed, which points to a defect rather than flakiness.`,
    suspected_flaky: `${sample}. Mixed results suggest flakiness, but the sample is too small to confirm it.`,
    confirmed_flaky: `${sample}. Mixed results in enough valid Runs to treat the test as flaky.`,
    unstable_infrastructure: `${sample}. Too many Runs were blocked or inconclusive to judge the test itself.`,
  };
  const tones: Record<FlakeReport["classification"], FlakeSummary["tone"]> = {
    insufficient_data: "neutral",
    passing_observed: "success",
    deterministic_failure: "danger",
    suspected_flaky: "warning",
    confirmed_flaky: "danger",
    unstable_infrastructure: "warning",
  };
  return {
    label: labels[report.classification],
    tone: tones[report.classification],
    explanation: explanations[report.classification],
    interval,
  };
}
