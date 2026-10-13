/**
 * Dashboard view model for VAL-007. The four metric families answer different questions and are
 * never merged into one headline: first-attempt, terminal, conditional and end-to-end. Every rate
 * keeps its numerator, denominator and definition, and an unavailable rate says why instead of
 * showing zero.
 */
export interface RateMetric {
  readonly numerator: number;
  readonly denominator: number | null;
  readonly denominatorState: "known" | "unknown";
  readonly state: "available" | "notApplicable" | "insufficientData";
  readonly value: number | null;
  readonly definition: string;
  readonly scope: string;
}
export interface MetricsPayload {
  readonly considered: number;
  readonly truncated: boolean;
  readonly window: { readonly since: string; readonly until: string };
  readonly metrics: {
    readonly counts: Readonly<Record<string, number>>;
    readonly rates: Readonly<Record<string, RateMetric>>;
    readonly exclusions: Readonly<Record<string, number>>;
    readonly blockedReasons: Readonly<Record<string, number>>;
    readonly retryPolicy: string;
  };
  readonly quarantined: readonly {
    readonly testId: string;
    readonly owner: string;
    readonly reason: string;
    readonly expiresAt: string;
    readonly active: boolean;
    readonly runsInWindow: number;
    readonly failedRunsInWindow: number;
  }[];
  readonly limitations: readonly string[];
}

export type MetricFamily = "first-attempt" | "terminal" | "conditional" | "end-to-end";
export interface MetricFamilyView {
  readonly family: MetricFamily;
  readonly title: string;
  readonly question: string;
  readonly rows: readonly MetricRow[];
}
export interface MetricRow {
  readonly key: string;
  readonly label: string;
  readonly display: string;
  readonly fraction: string;
  readonly definition: string;
  readonly available: boolean;
}

const families: readonly {
  family: MetricFamily;
  title: string;
  question: string;
  rates: readonly [key: string, label: string][];
}[] = [
  {
    family: "first-attempt",
    title: "First attempt",
    question: "How often does the first Attempt pass, without retries or healing?",
    rates: [["strictPassRate", "Strict first-attempt pass rate"]],
  },
  {
    family: "terminal",
    title: "Terminal",
    question: "What is the final outcome of every selected Run?",
    rates: [
      ["terminalPassRate", "Terminal pass rate"],
      ["selectionCompletionRate", "Selection completion rate"],
      ["blockedRate", "Blocked rate"],
      ["inconclusiveRate", "Inconclusive rate"],
    ],
  },
  {
    family: "conditional",
    title: "Conditional",
    question: "Rates that only exist for a subset of Runs; the denominator says which.",
    rates: [
      ["firstAttemptFailureRate", "First-attempt failure rate (passed or failed only)"],
      ["diagnosticRetryPassRate", "Passed on diagnostic retry"],
      ["retryRecoveryRate", "Recovered after infrastructure retry"],
    ],
  },
  {
    family: "end-to-end",
    title: "End to end",
    question: "Did the whole gate pass, including cleanup, evidence and policy?",
    rates: [
      ["gatePassRate", "Gate pass rate"],
      ["artifactCompletenessRate", "Artifact completeness"],
      ["staleEvidenceRate", "Stale evidence"],
    ],
  },
];

export function formatPercent(value: number): string {
  const percent = value * 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

export function describeRate(metric: RateMetric | undefined): {
  display: string;
  fraction: string;
  available: boolean;
} {
  if (!metric) return { display: "Not reported", fraction: "—", available: false };
  const fraction =
    metric.denominator === null
      ? `${metric.numerator} of unknown`
      : `${metric.numerator} of ${metric.denominator}`;
  if (metric.state === "available" && metric.value !== null)
    return { display: formatPercent(metric.value), fraction, available: true };
  return {
    display: metric.state === "notApplicable" ? "Not applicable (no Runs)" : "Insufficient data",
    fraction,
    available: false,
  };
}

export function describeMetricFamilies(payload: MetricsPayload): MetricFamilyView[] {
  return families.map((family) => ({
    family: family.family,
    title: family.title,
    question: family.question,
    rows: family.rates.map(([key, label]) => {
      const metric = payload.metrics.rates[key];
      return {
        key,
        label,
        ...describeRate(metric),
        definition: metric?.definition ?? "This server did not report the metric.",
      };
    }),
  }));
}

export interface ExclusionRow {
  readonly key: string;
  readonly label: string;
  readonly count: number;
}
const exclusionLabels: Readonly<Record<string, string>> = {
  firstAttemptNonPassOrFail:
    "First attempt neither passed nor failed (blocked, cancelled, inconclusive)",
  expandedDependencies: "Dependency Runs added to satisfy producers (outside the denominator)",
  authorizedExcluded: "Excluded by selection policy (for example quarantine)",
  duplicateSelections: "Duplicate selections merged",
};

/** Every exclusion the server reports, including zeros, so an absent exclusion is a stated fact. */
export function describeExclusions(payload: MetricsPayload): ExclusionRow[] {
  return Object.entries(payload.metrics.exclusions).map(([key, count]) => ({
    key,
    label: exclusionLabels[key] ?? key,
    count,
  }));
}
