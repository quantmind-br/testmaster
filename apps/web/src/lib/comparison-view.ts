import { comparabilityText, groupDifferences } from "./matrix";

/**
 * View model for Run and batch comparisons (UX-035). The server decides comparability; the portal
 * words it, groups the differences by the part of the Run they describe, and never turns a
 * difference into a regression: a difference only says the two sides are not identical.
 */
export type Comparability = "comparable" | "partially_comparable" | "incomparable";
export interface ComparisonDifference {
  readonly field: string;
  readonly left: unknown;
  readonly right: unknown;
}
export interface ComparisonResult {
  readonly comparability: Comparability;
  readonly reasons: readonly string[];
  readonly differences: readonly ComparisonDifference[];
  readonly nextCursor: string | null;
  readonly comparisonIdentity: string;
}

const categoryLabels: Readonly<Record<string, string>> = {
  revision: "Test revision and plan",
  environment: "Environment and runtime",
  outcome: "Verdict and gate",
  steps: "Steps",
  evidence: "Artifacts and evidence",
  timing: "Timing",
  membership: "Cases present on one side only",
  counts: "Selection and counts",
  other: "Other",
};

const runFieldCategory: Readonly<Record<string, string>> = {
  testId: "revision",
  revisionId: "revision",
  runner: "revision",
  revisionOrigin: "revision",
  generationModelCallId: "revision",
  baselines: "revision",
  environmentRevisionId: "environment",
  admission: "environment",
  outcome: "outcome",
  gate: "outcome",
  cleanupOutcome: "outcome",
  steps: "steps",
  stepComparison: "steps",
  failingStep: "steps",
  statusCodes: "steps",
  pairedSteps: "steps",
  artifacts: "evidence",
  durations: "timing",
  requested: "membership",
  requestedCount: "counts",
  rejectedMembers: "counts",
  expandedCount: "counts",
  quarantineExclusions: "counts",
};

const fieldLabels: Readonly<Record<string, string>> = {
  testId: "Test",
  revisionId: "Revision",
  runner: "Runner",
  revisionOrigin: "Revision origin",
  generationModelCallId: "Generation model call",
  baselines: "Visual baselines",
  environmentRevisionId: "Environment revision",
  admission: "Admission snapshot",
  outcome: "Outcome",
  gate: "Gate",
  cleanupOutcome: "Cleanup outcome",
  steps: "Steps",
  stepComparison: "Steps on each side",
  failingStep: "Failing step",
  statusCodes: "HTTP statuses compared",
  pairedSteps: "Steps with the same id",
  artifacts: "Artifacts",
  durations: "Attempt durations",
  requested: "Requested directly",
  requestedCount: "Requested members",
  rejectedMembers: "Members not dispatched",
  expandedCount: "Members added by dependency expansion",
  quarantineExclusions: "Quarantine exclusions",
};

const reasonText: Readonly<Record<string, string>> = {
  "different-logical-test-or-runner": "The two sides run a different test or a different runner.",
  "different-runner": "The two sides use different runners.",
  "step-diff-unavailable":
    "The steps cannot be compared one by one: a plan step and an imported-code step share no identity.",
  "revision-changed": "The test revision differs.",
  "environment-changed": "The environment revision differs.",
  "execution-config-changed": "The execution configuration or limits differ.",
  "admission-provenance-unavailable": "One side has no recorded admission provenance.",
  "source-binding-unavailable": "The source revision is not verified for one or both sides.",
  "repository-provenance-changed": "The repository provenance differs.",
  "runtime-identity-unavailable": "The runner or browser version was not measured for one side.",
  "ambiguous-logical-member-key":
    "Several Runs share one logical case, so the cases cannot be paired.",
  "member-added-or-removed":
    "A case exists on only one side. A case that was not run is not a pass.",
};

function words(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
    .toLowerCase();
}

export function describeReason(code: string): string {
  const known = reasonText[code];
  if (known) return known;
  if (code.endsWith("-changed")) {
    const label = words(code.slice(0, -"-changed".length));
    return `${label.charAt(0).toUpperCase()}${label.slice(1)} differs.`;
  }
  return words(code).replace(/^./, (first) => first.toUpperCase());
}

const caseField = /^(?:sha256:)?([0-9a-f]{16,64})-(.+)$/;

interface FieldInfo {
  readonly category: string;
  readonly label: string;
}

/** Where a field belongs and what to call it, including the per-case fields of a batch comparison. */
function classify(field: string): FieldInfo {
  const known = runFieldCategory[field];
  if (known) return { category: known, label: fieldLabels[field] ?? field };
  const member = /^(member|ambiguous)-(?:sha256:)?([0-9a-f]{8})/.exec(field);
  if (member)
    return {
      category: "membership",
      label:
        member[1] === "member"
          ? `Case ${member[2]}…: present on one side only`
          : `Case ${member[2]}…: several Runs share this case`,
    };
  const inner = caseField.exec(field);
  if (inner?.[1] && inner[2]) {
    const info = classify(inner[2]);
    return { category: info.category, label: `Case ${inner[1].slice(0, 8)}…: ${info.label}` };
  }
  return { category: "other", label: field };
}

export interface ComparisonRow {
  /** Human label of the field. */
  readonly field: string;
  /** The server's field name, used to classify its values. */
  readonly key: string;
  readonly left: unknown;
  readonly right: unknown;
}
export interface ComparisonGroup {
  readonly id: string;
  readonly label: string;
  readonly rows: readonly ComparisonRow[];
}

/** Groups loaded differences with the matrix library, keyed by category and labelled for people. */
export function groupComparison(
  differences: readonly ComparisonDifference[],
  options: { readonly hideVerdicts?: boolean } = {},
): ComparisonGroup[] {
  const prefixed = differences.flatMap((difference) => {
    const info = classify(difference.field);
    if (options.hideVerdicts && info.category === "outcome") return [];
    return [{ ...difference, field: `${info.category}.${difference.field}` }];
  });
  return groupDifferences(prefixed).map((group) => ({
    id: group.group,
    label: categoryLabels[group.group] ?? categoryLabels.other ?? group.group,
    rows: group.items.map((item) => {
      const key = item.field.slice(group.group.length + 1);
      return { field: classify(key).label, key, left: item.left, right: item.right };
    }),
  }));
}

export interface ComparisonSummary {
  readonly label: string;
  readonly tone: "success" | "warning" | "danger";
  readonly explanation: string;
  /** False when the verdicts of the two sides must not be read as a change in behavior. */
  readonly meaningful: boolean;
  readonly hiddenVerdictRows: number;
  readonly notice: string;
}

const summaryLabels: Readonly<
  Record<Comparability, { label: string; tone: "success" | "warning" | "danger" }>
> = {
  comparable: { label: "Comparable", tone: "success" },
  partially_comparable: { label: "Partially comparable", tone: "warning" },
  incomparable: { label: "Not comparable", tone: "danger" },
};

export function describeComparison(result: ComparisonResult): ComparisonSummary {
  const summary = summaryLabels[result.comparability];
  const meaningful = result.comparability !== "incomparable";
  const hiddenVerdictRows = meaningful
    ? 0
    : result.differences.filter((difference) => classify(difference.field).category === "outcome")
        .length;
  return {
    label: summary.label,
    tone: summary.tone,
    explanation: comparabilityText[result.comparability] ?? "",
    meaningful,
    hiddenVerdictRows,
    notice: meaningful
      ? "A difference only says the two sides are not identical. It is not a regression until you have read why they differ."
      : "These sides are not comparable, so their verdicts are unrelated. The remaining differences are listed for diagnosis only and say nothing about a change in behavior.",
  };
}

export interface DisplayValue {
  readonly text: string;
  /** True when the side has nothing to show for this field (null), as opposed to an empty value. */
  readonly absent: boolean;
}

/** Null on a per-case row means the case does not exist on that side, never a pass. */
export function displayValue(field: string, value: unknown): DisplayValue {
  if (value === null || value === undefined)
    return {
      text: classify(field).category === "membership" ? "Not present: not run" : "None",
      absent: true,
    };
  if (typeof value === "string") return { text: value, absent: false };
  if (typeof value === "number" || typeof value === "boolean")
    return { text: String(value), absent: false };
  return { text: JSON.stringify(value, null, 2), absent: false };
}

const runId = /^run_[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Only a value that is exactly a Run ID becomes a link; everything else stays text. */
export function asRunId(value: unknown): string | null {
  return typeof value === "string" && runId.test(value) ? value : null;
}
