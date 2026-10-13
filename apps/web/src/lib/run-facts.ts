import type { StreamEvent } from "../api/sse";
import { buildDataFlow, type PlanLike } from "./data-flow";
import type { TimelineState } from "./run-timeline";
import { describeCancellation, orderedSteps } from "./run-timeline";
import type {
  AttemptRecord,
  CancelReceipt,
  RunEventEnvelope,
  RunPhase,
  RunRecord,
  StepRecord,
  StepStatus,
  Verdict,
} from "./run-types";
import type { CurrentContext } from "./stale-evidence";

/**
 * What the Run page states about a Run (UX-026 to UX-029). The label never says "Passed" unless
 * the Run is completed, its outcome is passed and neither cleanup nor the gate failed; anything
 * else is spelled out. Nothing here reads the browser clock.
 */
export const phaseLabels: Readonly<Record<RunPhase, string>> = {
  queued: "Queued",
  preparing: "Preparing the runtime",
  running: "Running steps",
  collecting: "Collecting evidence",
  analyzing: "Analyzing",
  completed: "Completed",
};

const verdictLabels: Readonly<Record<Verdict, string>> = {
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
  cancelled: "Cancelled",
  inconclusive: "Inconclusive",
};

export interface RetryFacts {
  readonly firstAttemptOutcome: Verdict | null;
  readonly passedOnRetry: boolean;
  /** Attempts that recovered from an infrastructure failure, which is not flakiness evidence. */
  readonly infrastructureRecoveries: readonly number[];
}

export interface RunFacts {
  readonly label: string;
  /** Key for `StatusBadge`; qualified passes use `degraded` so they never look like a clean pass. */
  readonly status: string;
  /** True only for a clean pass: completed, passed, cleanup and gate not failed or pending. */
  readonly passed: boolean;
  readonly notes: readonly string[];
}

export function humanizeCode(code: string): string {
  return code.replace(/[_-]+/g, " ").trim();
}

/** Attempts keep their own number; sorting never merges or renumbers them. */
export function sortAttempts(attempts: readonly AttemptRecord[]): AttemptRecord[] {
  return [...attempts].sort((a, b) => a.number - b.number);
}

export function deriveRetryFacts(
  attempts: readonly AttemptRecord[],
  reduced: TimelineState["reduced"] = null,
): RetryFacts {
  const ordered = sortAttempts(attempts);
  const first = ordered[0];
  const passedLater = ordered.some(
    (attempt) =>
      attempt.number > (first?.number ?? 0) &&
      attempt.outcome === "passed" &&
      ordered.some((earlier) => earlier.number < attempt.number && earlier.outcome === "failed"),
  );
  return {
    firstAttemptOutcome: reduced?.firstAttemptOutcome ?? first?.outcome ?? null,
    passedOnRetry: reduced?.passedOnRetry === true || passedLater,
    infrastructureRecoveries: ordered
      .filter((attempt) => attempt.retry?.category === "infrastructure")
      .map((attempt) => attempt.number),
  };
}

export function describeRunFacts(run: RunRecord | null, retry: RetryFacts | null): RunFacts {
  if (run === null)
    return { label: "Not loaded", status: "pending", passed: false, notes: ["No Run data yet."] };
  if (run.phase !== "completed")
    return {
      label: "In progress",
      status: "running",
      passed: false,
      notes: [`The Run is ${phaseLabels[run.phase].toLowerCase()}; no result yet.`],
    };
  const notes: string[] = [];
  if (run.outcome === null)
    return {
      label: "Finished without a verdict",
      status: "inconclusive",
      passed: false,
      notes: ["The Run completed but recorded no outcome."],
    };
  const qualifiers: string[] = [];
  if (run.cleanupOutcome === "failed") qualifiers.push("cleanup failed");
  else if (run.cleanupOutcome === "inconclusive") qualifiers.push("cleanup inconclusive");
  else if (run.cleanupOutcome === "pending") qualifiers.push("cleanup pending");
  if (run.gate === "failed") qualifiers.push("gate failed");
  else if (run.gate === "pending") qualifiers.push("gate pending");
  if (retry?.passedOnRetry)
    notes.push(
      `A later attempt passed after a failed attempt (first attempt: ${retry.firstAttemptOutcome ?? "unknown"}). That is a diagnostic retry, not proof the test is stable; no repeat sample was taken.`,
    );
  if (retry && retry.infrastructureRecoveries.length > 0)
    notes.push(
      `Attempt ${retry.infrastructureRecoveries.join(", ")} recovered from an infrastructure failure. That is not confirmed flakiness.`,
    );
  if (run.outcome !== "passed") {
    if (run.cleanupOutcome === "failed") notes.push("Cleanup failed.");
    if (run.gate === "failed") notes.push("The gate failed.");
    return {
      label: verdictLabels[run.outcome],
      status: run.outcome,
      passed: false,
      notes,
    };
  }
  if (qualifiers.length === 0)
    return {
      label: retry?.passedOnRetry ? "Passed on retry" : "Passed",
      status: "passed",
      passed: true,
      notes,
    };
  const hasCleanup = qualifiers.some((qualifier) => qualifier.startsWith("cleanup"));
  return {
    label: `Passed, ${hasCleanup ? "but " : ""}${qualifiers.join(" and ")}`,
    status: "degraded",
    passed: false,
    notes,
  };
}

/** Polite announcement for a phase change; the terminal result replaces the phase wording. */
export function announcementFor(timeline: TimelineState): string {
  if (timeline.terminal) return `Run finished as ${timeline.terminal.outcome ?? "no verdict"}.`;
  return `Run is now ${phaseLabels[timeline.phase].toLowerCase()}.`;
}

export interface CancelControl {
  readonly enabled: boolean;
  /** Why the button is disabled; shown as text next to it, not only as a tooltip. */
  readonly reason: string | null;
  /** The request/terminal wording, kept apart from the Run's result. */
  readonly notice: string | null;
}

export function describeCancelControl(
  run: Pick<RunRecord, "phase" | "outcome"> | null,
  timeline: TimelineState,
  receipt: CancelReceipt | null,
): CancelControl {
  const fromTimeline = describeCancellation(timeline)?.message ?? null;
  const requested = timeline.cancel !== null || receipt?.result === "requested";
  let notice = fromTimeline;
  if (notice === null && receipt) {
    if (receipt.result === "requested")
      notice = "Cancellation requested. The Run has not stopped yet; wait for the terminal result.";
    else if (receipt.result === "already_terminal")
      notice =
        "The Run had already finished, so nothing was cancelled. The recorded result stands.";
    else notice = "The server rejected the cancellation request. The Run continues.";
  }
  const finished = timeline.terminal !== null || run?.phase === "completed";
  if (finished) {
    const outcome = timeline.terminal?.outcome ?? run?.outcome ?? null;
    return {
      enabled: false,
      reason: `The Run already finished${outcome ? ` as ${outcome}` : ""}; there is nothing to cancel.`,
      notice,
    };
  }
  if (run === null) return { enabled: false, reason: "The Run has not loaded yet.", notice };
  if (requested) return { enabled: false, reason: "Cancellation was already requested.", notice };
  return { enabled: true, reason: null, notice };
}

export function describeAttempt(
  attempt: AttemptRecord,
  attempts: readonly AttemptRecord[],
): {
  readonly title: string;
  readonly policy: string;
  readonly origin: string;
  readonly result: string;
} {
  const previous = attempt.retry
    ? attempts.find((candidate) => candidate.id === attempt.retry?.previousAttemptId)
    : undefined;
  const previousName = previous ? `attempt ${previous.number}` : "the previous attempt";
  let origin = "Initial attempt.";
  if (attempt.retry) {
    const reason = attempt.retry.reasonCode ? ` (${humanizeCode(attempt.retry.reasonCode)})` : "";
    origin =
      attempt.retry.category === "diagnostic"
        ? `Diagnostic retry after ${previousName} ${attempt.retry.previousOutcome ?? "ended without a verdict"}${reason}.`
        : `Infrastructure retry after ${previousName} ${
            attempt.retry.previousOutcome
              ? `ended ${attempt.retry.previousOutcome}`
              : "ended without a verdict"
          }${reason}. Not a flakiness finding.`;
  }
  return {
    title: `Attempt ${attempt.number}`,
    policy: `Attempt ${attempt.number} of at most ${attempt.policy.maxAttempts}`,
    origin,
    result: attempt.outcome
      ? verdictLabels[attempt.outcome]
      : attempt.phase === "completed"
        ? "No verdict"
        : "In progress",
  };
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** Server timestamps are shown in UTC so two viewers read the same instant. */
export function formatServerTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  return `${new Date(time).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** Expected/observed values render as text; strings stay verbatim, structures are indented JSON. */
export function formatStructured(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

/** Stream events carry the envelope fields the reducer reads; anything else is ignored there. */
export function toRunEvent(event: StreamEvent): RunEventEnvelope {
  return {
    seq: event.seq,
    type: event.type,
    attemptId: typeof event.attemptId === "string" ? event.attemptId : null,
    ...(typeof event.eventId === "string" ? { eventId: event.eventId } : {}),
    ...(typeof event.occurredAt === "string" ? { occurredAt: event.occurredAt } : {}),
    ...(event.payload === undefined ? {} : { payload: event.payload }),
  };
}

export function isTerminalEvent(event: StreamEvent): boolean {
  return event.type === "run.completed";
}

export interface StepRow {
  readonly key: string;
  readonly attemptId: string;
  readonly stepId: string;
  readonly index: number;
  readonly status: StepStatus;
  readonly reasonCode: string | null;
  readonly durationMs: number | null;
  readonly expected: unknown;
  readonly observed: unknown;
  readonly error: StepRecord["error"];
  readonly evidencePaths: readonly string[];
}

export interface StepGroup {
  readonly attemptId: string;
  /** `null` for steps whose Attempt is not (yet) in the Attempt list. */
  readonly attempt: AttemptRecord | null;
  readonly rows: readonly StepRow[];
}

/**
 * Steps per Attempt, in Attempt order, so a retry's steps never mix with the first attempt's. The
 * timeline supplies live status (it already folds the snapshot in and never reopens a finished
 * step); the fetched records add expected/observed values and the error.
 */
export function buildStepGroups(
  timeline: TimelineState,
  records: readonly StepRecord[],
  attempts: readonly AttemptRecord[],
): StepGroup[] {
  const byKey = new Map(
    records.map((record) => [`${record.attemptId}/${record.planStepId}`, record]),
  );
  const rows = orderedSteps(timeline).map((step): StepRow => {
    const record = byKey.get(`${step.attemptId}/${step.stepId}`);
    return {
      key: `${step.attemptId}/${step.stepId}`,
      attemptId: step.attemptId,
      stepId: step.stepId,
      index: step.index,
      status: step.status,
      reasonCode: step.reasonCode ?? record?.reasonCode ?? null,
      durationMs: step.durationMs ?? record?.durationMs ?? null,
      expected: record?.expected ?? null,
      observed: record?.observed ?? null,
      error: record?.error ?? null,
      evidencePaths:
        step.evidencePaths.length > 0
          ? step.evidencePaths
          : (record?.evidenceRefs.map((ref) => ref.relativePath) ?? []),
    };
  });
  const ordered = sortAttempts(attempts);
  const groups: StepGroup[] = ordered.map((attempt) => ({
    attemptId: attempt.id,
    attempt,
    rows: rows.filter((row) => row.attemptId === attempt.id).sort((a, b) => a.index - b.index),
  }));
  const known = new Set(ordered.map((attempt) => attempt.id));
  for (const attemptId of new Set(rows.map((row) => row.attemptId)))
    if (!known.has(attemptId))
      groups.push({
        attemptId,
        attempt: null,
        rows: rows.filter((row) => row.attemptId === attemptId).sort((a, b) => a.index - b.index),
      });
  return groups;
}

/**
 * Plan steps that capture a sensitive value (REQ-053). Their expected and observed data are
 * withheld on the Run page, so a captured token never reaches the screen through the step table.
 */
export function sensitiveStepIds(plan: PlanLike): ReadonlySet<string> {
  return new Set(
    buildDataFlow(plan)
      .nodes.filter((node) => node.kind === "step" && node.sensitive)
      .map((node) => node.id),
  );
}

/**
 * Current revisions for the freshness check. A lookup that failed is left out so the dimension
 * reads "unknown" and is never mistaken for "current".
 */
export function buildCurrentContext(
  test: { readonly activeRevisionId: string | null } | null,
  environment: { readonly activeRevisionId: string } | null,
): CurrentContext {
  return {
    ...(test ? { testRevisionId: test.activeRevisionId } : {}),
    ...(environment ? { environmentRevisionId: environment.activeRevisionId } : {}),
  };
}
