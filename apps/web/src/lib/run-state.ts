import type { Shape, Tone } from "../components/status";

/**
 * A Run result keeps seven independent facts. The portal shows each under its own label and never
 * folds them into one "verdict" alias: `phase` (how far execution got), `outcome` (what the
 * assertions concluded), `status` (the wire alias of phase-or-outcome), `cleanupOutcome`, `gate`,
 * the validity of the evidence and the analysis status (a hypothesis, never a verdict).
 */
export interface RunStateInput {
  readonly phase?: string | null;
  readonly outcome?: string | null;
  readonly status?: string | null;
  readonly cleanupOutcome?: string | null;
  readonly gate?: string | null;
  readonly analysisStatus?: string | null;
  /** `valid | stale | partial | missing`; absent means the caller has no evidence verdict. */
  readonly evidenceValidity?: string | null;
  readonly reasonCode?: string | null;
}

export type RunDimensionKey =
  | "phase"
  | "outcome"
  | "status"
  | "cleanupOutcome"
  | "gate"
  | "evidenceValidity"
  | "analysisStatus";

export interface RunDimension {
  readonly key: RunDimensionKey;
  readonly label: string;
  /** Text shown to the reader. Always text; the shape is a second cue, colour a third. */
  readonly display: string;
  readonly raw: string | null;
  readonly tone: Tone;
  readonly shape: Shape;
  /** Set when the value is absent or not part of the contract. */
  readonly known: boolean;
}

export interface RunStateView {
  readonly dimensions: readonly RunDimension[];
  /** Contradictions between dimensions; shown, never hidden. */
  readonly inconsistencies: readonly string[];
  /** True only when execution completed, the assertions passed, cleanup did not fail and the gate agrees. */
  readonly approved: boolean;
}

type Entry = { display: string; tone: Tone; shape: Shape };

const phases: Record<string, Entry> = {
  queued: { display: "Queued", tone: "neutral", shape: "clock" },
  preparing: { display: "Preparing", tone: "info", shape: "spinner" },
  running: { display: "Running", tone: "info", shape: "spinner" },
  collecting: { display: "Collecting evidence", tone: "info", shape: "spinner" },
  analyzing: { display: "Analyzing", tone: "info", shape: "spinner" },
  completed: { display: "Completed", tone: "neutral", shape: "check" },
};
const outcomes: Record<string, Entry> = {
  passed: { display: "Passed", tone: "success", shape: "check" },
  failed: { display: "Failed", tone: "danger", shape: "cross" },
  blocked: { display: "Blocked", tone: "warning", shape: "stop" },
  cancelled: { display: "Cancelled", tone: "neutral", shape: "slash" },
  inconclusive: { display: "Inconclusive", tone: "warning", shape: "question" },
};
const cleanups: Record<string, Entry> = {
  not_required: { display: "Not required", tone: "neutral", shape: "info" },
  pending: { display: "Pending", tone: "neutral", shape: "clock" },
  passed: { display: "Passed", tone: "success", shape: "check" },
  failed: { display: "Failed", tone: "danger", shape: "cross" },
  inconclusive: { display: "Inconclusive", tone: "warning", shape: "question" },
};
const analyses: Record<string, Entry> = {
  not_requested: { display: "Not requested", tone: "neutral", shape: "info" },
  pending: { display: "Pending", tone: "neutral", shape: "clock" },
  complete: { display: "Complete (hypothesis)", tone: "info", shape: "info" },
  partial: { display: "Partial (hypothesis)", tone: "warning", shape: "warn" },
  unavailable: { display: "Unavailable", tone: "warning", shape: "question" },
};
const evidence: Record<string, Entry> = {
  valid: { display: "Valid", tone: "success", shape: "check" },
  stale: { display: "Stale", tone: "warning", shape: "warn" },
  partial: { display: "Partial", tone: "warning", shape: "warn" },
  missing: { display: "Missing", tone: "danger", shape: "cross" },
};

const notReported: Entry = { display: "Not reported", tone: "neutral", shape: "question" };

function pick(
  key: RunDimensionKey,
  label: string,
  raw: string | null | undefined,
  table: Record<string, Entry>,
): RunDimension {
  if (raw === null || raw === undefined || raw === "")
    return { key, label, raw: null, known: false, ...notReported };
  const found = table[raw];
  if (found) return { key, label, raw, known: true, ...found };
  // A value outside the contract is shown verbatim and neutral: never as zero, never as success.
  return {
    key,
    label,
    raw,
    known: false,
    display: `Unknown (${raw.slice(0, 40)})`,
    tone: "neutral",
    shape: "question",
  };
}

/** Pure projection of a Run result onto labelled, honest dimensions. */
export function describeRunState(input: RunStateInput): RunStateView {
  const inconsistencies: string[] = [];
  const completed = input.phase === "completed";
  const cleanupFailed = input.cleanupOutcome === "failed";
  const cleanupSettled =
    input.cleanupOutcome === "passed" || input.cleanupOutcome === "not_required";

  let outcome = pick("outcome", "Outcome", input.outcome, outcomes);
  if (input.outcome === null || input.outcome === undefined) {
    outcome = {
      ...outcome,
      display: completed ? "No outcome recorded" : "No outcome yet",
      shape: completed ? "question" : "clock",
    };
    if (completed) inconsistencies.push("The run completed but reported no outcome.");
  } else if (input.outcome === "passed" && !completed) {
    // Execution without evidence of completion is never presented as passed.
    outcome = { ...outcome, display: "Unconfirmed", tone: "warning", shape: "question" };
    inconsistencies.push("An outcome of passed was reported before the run completed.");
  }

  let gate = pick("gate", "Gate", input.gate, {
    pending: { display: "Pending", tone: "neutral", shape: "clock" },
    passed: { display: "Approved", tone: "success", shape: "check" },
    failed: { display: "Not approved", tone: "danger", shape: "cross" },
    not_applicable: { display: "Not applicable", tone: "neutral", shape: "info" },
  });
  const gatePassedWithBlockers =
    input.gate === "passed" &&
    (!completed || input.outcome !== "passed" || cleanupFailed || !cleanupSettled);
  if (gatePassedWithBlockers) {
    gate = { ...gate, display: "Not approved", tone: "danger", shape: "cross" };
    inconsistencies.push(
      cleanupFailed
        ? "The assertions passed but required cleanup failed, so the gate is not approved."
        : "The gate was reported approved without a completed, passed run and settled cleanup.",
    );
  }
  if (input.gate === "passed" && input.outcome === "failed")
    inconsistencies.push("The gate was reported approved for a failed run.");

  const status = pick("status", "Status", input.status, { ...phases, ...outcomes });
  const dimensions: RunDimension[] = [
    pick("phase", "Phase", input.phase, phases),
    outcome,
    status,
    pick("cleanupOutcome", "Cleanup", input.cleanupOutcome, cleanups),
    gate,
    pick("evidenceValidity", "Evidence", input.evidenceValidity, evidence),
    pick("analysisStatus", "Analysis", input.analysisStatus, analyses),
  ];
  const approved =
    completed &&
    input.outcome === "passed" &&
    cleanupSettled &&
    input.gate === "passed" &&
    inconsistencies.length === 0;
  return { dimensions, inconsistencies, approved };
}
