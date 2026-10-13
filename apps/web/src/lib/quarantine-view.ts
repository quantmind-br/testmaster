/**
 * Quarantine view model (UX-038). A quarantine is an auditable decision with an owner, a reason, an
 * expiry and an explicit effect on the gate. It never changes a Run that already failed: the
 * failure stays in history and in every metric denominator. The effect text comes from what the
 * selection preview reports for the test, not from the record alone.
 */
export interface QuarantineRecord {
  readonly id: string;
  readonly testId: string;
  readonly owner: string;
  readonly reason: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly version: number;
}

export interface QuarantineMetric {
  readonly testId: string;
  readonly runsInWindow: number;
  readonly failedRunsInWindow: number;
}

export type QuarantineState = "active" | "expired";

export interface QuarantineRow extends QuarantineRecord {
  readonly state: QuarantineState;
  /** Null when the metrics window could not be loaded: unknown is not zero. */
  readonly runsInWindow: number | null;
  readonly failedRunsInWindow: number | null;
}

export const historyNotice =
  "Quarantine never changes a failed Run. Failures of quarantined tests stay in Run history and in every metric denominator; quarantine only removes the test from default selections, which reduces coverage.";

/** Active while the expiry is still in the future, the same rule the server applies. */
export function quarantineState(expiresAt: string, now: Date): QuarantineState {
  return Date.parse(expiresAt) > now.getTime() ? "active" : "expired";
}

export function buildQuarantineRows(
  records: readonly QuarantineRecord[],
  metrics: readonly QuarantineMetric[] | null,
  now: Date,
): QuarantineRow[] {
  return records.map((record) => {
    const metric = metrics?.find((candidate) => candidate.testId === record.testId);
    return {
      ...record,
      state: quarantineState(record.expiresAt, now),
      runsInWindow: metric?.runsInWindow ?? null,
      failedRunsInWindow: metric?.failedRunsInWindow ?? null,
    };
  });
}

export interface SelectionSide {
  readonly requested: readonly { readonly testId: string }[];
  readonly excluded: readonly { readonly testId: string; readonly reason: string }[];
}

export interface GateEffect {
  readonly kind: "excluded" | "expired" | "unconfirmed";
  readonly text: string;
}

/**
 * What an active quarantine does, confirmed against two previews of the same selection: the
 * default policy must exclude the test as "quarantined" and the strict policy must keep it
 * selected. Anything else is reported as unconfirmed instead of being assumed.
 */
export function gateEffect(
  row: Pick<QuarantineRow, "testId" | "state">,
  previews: { readonly exclude: SelectionSide; readonly strict: SelectionSide } | null,
): GateEffect {
  if (row.state === "expired")
    return {
      kind: "expired",
      text: "Expired: no longer excluded. The test is selected and gated like any other test.",
    };
  if (!previews)
    return {
      kind: "unconfirmed",
      text: "Gate effect could not be confirmed: the selection preview is unavailable.",
    };
  const excluded = previews.exclude.excluded.some(
    (item) => item.testId === row.testId && item.reason === "quarantined",
  );
  const stillSelectedWhenStrict = previews.strict.requested.some(
    (item) => item.testId === row.testId,
  );
  if (excluded && stillSelectedWhenStrict)
    return {
      kind: "excluded",
      text: "Excluded from selection with reason quarantined. Under the strict policy the test is still selected and a failure blocks the gate.",
    };
  if (excluded)
    return {
      kind: "unconfirmed",
      text: "Excluded from selection with reason quarantined, but the strict policy preview did not select it, so its effect on a strict gate is unconfirmed.",
    };
  return {
    kind: "unconfirmed",
    text: "The selection preview did not report this quarantine, so its effect on the gate is unconfirmed.",
  };
}

/** Tests excluded by active quarantines: the coverage the default selection no longer has. */
export function reducedCoverage(rows: readonly QuarantineRow[]): string {
  const active = rows.filter((row) => row.state === "active").length;
  if (active === 0) return "No active quarantine: default selections cover every test.";
  return `Coverage is reduced: ${active} test${active === 1 ? " is" : "s are"} excluded from default selections while quarantined.`;
}

export interface QuarantineForm {
  readonly testId: string;
  readonly reason: string;
  /** `datetime-local` value, interpreted in the browser's time zone. */
  readonly expiresAtLocal: string;
}

export interface QuarantineIssue {
  readonly field: "testId" | "reason" | "expiresAt";
  readonly message: string;
}

/** Date parsed from a `datetime-local` value, or null when it is empty or not a real date. */
export function parseLocalExpiry(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function validateQuarantine(form: QuarantineForm, now: Date): QuarantineIssue[] {
  const issues: QuarantineIssue[] = [];
  if (form.testId.trim() === "") issues.push({ field: "testId", message: "Choose a test." });
  if (form.reason.trim() === "")
    issues.push({ field: "reason", message: "Enter the reason for the quarantine." });
  else if (form.reason.length > 2000)
    issues.push({ field: "reason", message: "The reason must be 2000 characters or fewer." });
  if (form.expiresAtLocal.trim() === "")
    issues.push({ field: "expiresAt", message: "Enter an expiry date and time." });
  else {
    const expiry = parseLocalExpiry(form.expiresAtLocal);
    if (!expiry)
      issues.push({ field: "expiresAt", message: "Enter the expiry as a valid date and time." });
    else if (expiry.getTime() <= now.getTime())
      issues.push({ field: "expiresAt", message: "The expiry must be in the future." });
  }
  return issues;
}

export interface QuarantineBody {
  readonly reason: string;
  readonly expiresAt: string;
  readonly expectedVersion?: number;
}

/** `PUT /tests/{id}/quarantine` body; an existing quarantine is edited with its version. */
export function quarantineBody(
  form: QuarantineForm,
  existingVersion: number | null,
): QuarantineBody {
  const expiry = parseLocalExpiry(form.expiresAtLocal);
  if (!expiry) throw new Error("Expiry is not a valid date");
  return {
    reason: form.reason.trim(),
    expiresAt: expiry.toISOString(),
    ...(existingVersion === null ? {} : { expectedVersion: existingVersion }),
  };
}

/** `datetime-local` value for an ISO instant, in the browser's time zone. */
export function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export type Selectedness = "selected" | "excluded" | "unknown";

/** Whether the default policy currently selects the test, read from the exclude-policy preview. */
export function currentSelection(testId: string, exclude: SelectionSide | null): Selectedness {
  if (!exclude) return "unknown";
  if (exclude.excluded.some((item) => item.testId === testId && item.reason === "quarantined"))
    return "excluded";
  return exclude.requested.some((item) => item.testId === testId) ? "selected" : "unknown";
}

export type QuarantineChange = "quarantine" | "edit" | "remove";

export interface ChangeEffect {
  readonly before: string;
  readonly after: string;
}

const beforeText: Readonly<Record<Selectedness, string>> = {
  selected: "Selected by default: its Runs count toward the gate.",
  excluded: "Excluded from selection with reason quarantined.",
  unknown: "The selection preview could not confirm how the test is selected today.",
};

/** What a change does to the gate, stated before the user confirms it. */
export function describeChange(
  change: QuarantineChange,
  before: Selectedness,
  expiresAt: string | null,
): ChangeEffect {
  const until = expiresAt ? ` until ${expiresAt}` : "";
  if (change === "remove")
    return {
      before: beforeText[before],
      after:
        "Selected by default again: its Runs count toward the gate and a failure blocks it. Earlier failures stay in history and metrics.",
    };
  return {
    before: beforeText[before],
    after: `Excluded from selection with reason quarantined${until}. Under the strict policy it is still selected and a failure blocks the gate. Failed Runs stay in history and metrics.`,
  };
}
