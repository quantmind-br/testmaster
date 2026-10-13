import type {
  AttemptRecord,
  RunEventEnvelope,
  RunPhase,
  RunRecord,
  StepRecord,
  StepStatus,
  Verdict,
} from "./run-types";

/**
 * Live Run state, reduced from the server's event stream and corrected by snapshots.
 *
 * Invariants (UX-026, UX-027, UX-028, J05):
 *  - applying the same event twice, or events out of order, yields the same state;
 *  - the phase never moves backwards and a terminal result is never replaced or reopened;
 *  - a cancellation request is recorded apart from the terminal result and never becomes one;
 *  - every duration derives from server timestamps, never from the browser clock.
 */
export const phaseOrder: readonly RunPhase[] = [
  "queued",
  "preparing",
  "running",
  "collecting",
  "analyzing",
  "completed",
];
const rank = (phase: RunPhase): number => phaseOrder.indexOf(phase);

export interface TimelineStep {
  readonly attemptId: string;
  readonly stepId: string;
  readonly index: number;
  readonly status: StepStatus;
  readonly reasonCode: string | null;
  readonly durationMs: number | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly evidencePaths: readonly string[];
}

export interface TimelineAttempt {
  readonly id: string;
  readonly number: number | null;
  readonly claimedAt: string | null;
  readonly sealedAt: string | null;
  readonly runnerStartedAt: string | null;
  readonly collectedAt: string | null;
  readonly leaseExpired: { readonly at: string; readonly reasonCode: string } | null;
}

export interface TimelineTerminal {
  readonly outcome: Verdict | null;
  readonly at: string | null;
  readonly reasonCode: string | null;
}

export interface TimelineState {
  readonly runId: string;
  readonly applied: ReadonlySet<number>;
  readonly maxSeq: number;
  readonly phase: RunPhase;
  readonly acceptedAt: string | null;
  readonly phaseAt: Readonly<Partial<Record<RunPhase, string>>>;
  readonly attempts: Readonly<Record<string, TimelineAttempt>>;
  readonly steps: Readonly<Record<string, TimelineStep>>;
  readonly cancel: {
    readonly requestedAt: string | null;
    readonly requestedBy: string | null;
    readonly reasonCode: string | null;
  } | null;
  readonly terminal: TimelineTerminal | null;
  readonly reduced: {
    readonly firstAttemptOutcome: Verdict | null;
    readonly passedOnRetry: boolean;
  } | null;
  readonly lastEventAt: string | null;
}

export function initialTimeline(runId: string): TimelineState {
  return {
    runId,
    applied: new Set(),
    maxSeq: -1,
    phase: "queued",
    acceptedAt: null,
    phaseAt: {},
    attempts: {},
    steps: {},
    cancel: null,
    terminal: null,
    reduced: null,
    lastEventAt: null,
  };
}

const isPhase = (value: unknown): value is RunPhase =>
  typeof value === "string" && phaseOrder.includes(value as RunPhase);
const isVerdict = (value: unknown): value is Verdict =>
  value === "passed" ||
  value === "failed" ||
  value === "blocked" ||
  value === "cancelled" ||
  value === "inconclusive";
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

const stepKey = (attemptId: string, stepId: string) => `${attemptId}/${stepId}`;
const finalStatuses: readonly StepStatus[] = [
  "passed",
  "failed",
  "blocked",
  "cancelled",
  "skipped",
  "not_run",
  "inconclusive",
];
const isFinalStep = (status: StepStatus) => finalStatuses.includes(status);

function withPhase(state: TimelineState, phase: RunPhase, at: string | null): TimelineState {
  // A terminal Run keeps its phase; a late or replayed phase change never moves it back.
  if (state.terminal || rank(phase) <= rank(state.phase)) {
    if (at && !state.phaseAt[phase] && rank(phase) <= rank(state.phase))
      return { ...state, phaseAt: { ...state.phaseAt, [phase]: at } };
    return state;
  }
  return {
    ...state,
    phase,
    phaseAt: at && !state.phaseAt[phase] ? { ...state.phaseAt, [phase]: at } : state.phaseAt,
  };
}

function attemptOf(state: TimelineState, id: string): TimelineAttempt {
  return (
    state.attempts[id] ?? {
      id,
      number: null,
      claimedAt: null,
      sealedAt: null,
      runnerStartedAt: null,
      collectedAt: null,
      leaseExpired: null,
    }
  );
}

function withAttempt(
  state: TimelineState,
  id: string,
  patch: Partial<TimelineAttempt>,
): TimelineState {
  const current = attemptOf(state, id);
  // Merge without erasing what an earlier event already established.
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) if (value !== null) merged[key] = value;
  return { ...state, attempts: { ...state.attempts, [id]: merged as unknown as TimelineAttempt } };
}

function mergeStep(
  state: TimelineState,
  attemptId: string,
  stepId: string,
  patch: Partial<TimelineStep> & { index: number },
): TimelineState {
  const key = stepKey(attemptId, stepId);
  const current = state.steps[key];
  // A finished step is never reopened by a late or replayed `step.started`.
  if (current && isFinalStep(current.status) && patch.status === "running") return state;
  const next: TimelineStep = {
    attemptId,
    stepId,
    index: patch.index,
    status: patch.status ?? current?.status ?? "running",
    reasonCode: patch.reasonCode ?? current?.reasonCode ?? null,
    durationMs: patch.durationMs ?? current?.durationMs ?? null,
    startedAt: patch.startedAt ?? current?.startedAt ?? null,
    finishedAt: patch.finishedAt ?? current?.finishedAt ?? null,
    evidencePaths: patch.evidencePaths ?? current?.evidencePaths ?? [],
  };
  return { ...state, steps: { ...state.steps, [key]: next } };
}

/** Applies one stream event. Pure: never mutates `state`, never throws on an unknown type. */
export function applyEvent(state: TimelineState, event: RunEventEnvelope): TimelineState {
  if (state.applied.has(event.seq)) return state;
  const applied = new Set(state.applied).add(event.seq);
  let next: TimelineState = {
    ...state,
    applied,
    maxSeq: Math.max(state.maxSeq, event.seq),
    lastEventAt:
      event.occurredAt && (!state.lastEventAt || event.occurredAt > state.lastEventAt)
        ? event.occurredAt
        : state.lastEventAt,
  };
  const at = event.occurredAt ?? null;
  const payload = record(event.payload);
  const attemptId = event.attemptId ?? text(payload.attemptId);
  switch (event.type) {
    case "run.accepted":
      next = { ...next, acceptedAt: next.acceptedAt ?? at };
      break;
    case "attempt.claimed": {
      const id = text(payload.attemptId) ?? attemptId;
      if (id)
        next = withAttempt(next, id, {
          claimedAt: at,
          number: typeof payload.number === "number" ? payload.number : null,
        });
      next = withPhase(next, "preparing", at);
      break;
    }
    case "run.phase_changed":
      if (isPhase(payload.phase)) next = withPhase(next, payload.phase, at);
      if (isPhase(payload.phase) && attemptId && payload.phase === "collecting")
        next = withAttempt(next, attemptId, { collectedAt: at });
      break;
    case "run.snapshot_sealed":
      if (attemptId) next = withAttempt(next, attemptId, { sealedAt: at });
      break;
    case "attempt.runner_started":
      if (attemptId) next = withAttempt(next, attemptId, { runnerStartedAt: at });
      next = withPhase(next, "running", at);
      break;
    case "step.started": {
      const stepId = text(payload.stepId);
      if (attemptId && stepId)
        next = mergeStep(next, attemptId, stepId, {
          index: typeof payload.index === "number" ? payload.index : 0,
          status: "running",
          startedAt: at,
        });
      next = withPhase(next, "running", at);
      break;
    }
    case "step.finished": {
      const stepId = text(payload.stepId);
      const status = text(payload.status) as StepStatus | null;
      if (attemptId && stepId && status)
        next = mergeStep(next, attemptId, stepId, {
          index: typeof payload.index === "number" ? payload.index : 0,
          status,
          reasonCode: text(payload.reasonCode),
          durationMs: typeof payload.durationMs === "number" ? payload.durationMs : null,
          finishedAt: at,
          evidencePaths: Array.isArray(payload.evidencePaths)
            ? payload.evidencePaths.filter((item): item is string => typeof item === "string")
            : [],
        });
      next = withPhase(next, "running", at);
      break;
    }
    case "cleanup.finished":
      if (attemptId) next = withAttempt(next, attemptId, { collectedAt: at });
      break;
    case "attempt.lease_expired":
      next = withAttempt(next, attemptId ?? text(payload.jobId) ?? "unknown", {
        leaseExpired: { at: at ?? "", reasonCode: text(payload.reasonCode) ?? "worker_lost" },
      });
      break;
    case "run.cancel_requested":
      next = {
        ...next,
        cancel: next.cancel ?? {
          requestedAt: text(payload.cancelRequestedAt) ?? at,
          requestedBy: text(payload.requestedBy),
          reasonCode: text(payload.reasonCode),
        },
      };
      break;
    case "run.reduced":
      next = {
        ...next,
        reduced: {
          firstAttemptOutcome: isVerdict(payload.firstAttemptOutcome)
            ? payload.firstAttemptOutcome
            : null,
          passedOnRetry: payload.passedOnRetry === true,
        },
      };
      break;
    case "run.completed": {
      // The first terminal result is final: replays, duplicates and later events cannot replace it.
      if (next.terminal) break;
      const outcome = isVerdict(payload.outcome) ? payload.outcome : null;
      next = {
        ...next,
        phase: "completed",
        phaseAt: at && !next.phaseAt.completed ? { ...next.phaseAt, completed: at } : next.phaseAt,
        terminal: { outcome, at, reasonCode: text(payload.reasonCode) },
      };
      break;
    }
    default:
      break;
  }
  return next;
}

/**
 * Folds authoritative state into the timeline after a gap, an expired cursor or a reconnect. A
 * snapshot older than what events already showed never moves the Run backwards.
 */
export function applySnapshot(
  state: TimelineState,
  snapshot: {
    run: RunRecord;
    steps: readonly StepRecord[];
    attempts: readonly AttemptRecord[];
  },
): TimelineState {
  let next = state;
  if (rank(snapshot.run.phase) > rank(next.phase) && !next.terminal)
    next = { ...next, phase: snapshot.run.phase };
  if (snapshot.run.phase === "completed" && snapshot.run.outcome && !next.terminal)
    next = {
      ...next,
      phase: "completed",
      terminal: {
        outcome: snapshot.run.outcome,
        at: next.phaseAt.completed ?? null,
        reasonCode: snapshot.run.reasonCode ?? null,
      },
    };
  for (const attempt of snapshot.attempts)
    next = withAttempt(next, attempt.id, {
      number: attempt.number,
      claimedAt: attempt.startedAt,
    });
  for (const step of snapshot.steps)
    next = mergeStep(next, step.attemptId, step.planStepId, {
      index: step.index,
      status: step.status,
      reasonCode: step.reasonCode ?? null,
      durationMs: step.durationMs,
      evidencePaths: step.evidenceRefs.map((ref) => ref.relativePath),
    });
  return next;
}

export type StageKey = "request" | "dispatch" | "readiness" | "steps" | "collection" | "terminal";
export interface Stage {
  readonly key: StageKey;
  readonly label: string;
  readonly state: "done" | "active" | "pending";
  readonly at: string | null;
  /** Server-time duration from the previous stage; null when a timestamp is missing or inverted. */
  readonly durationMs: number | null;
  readonly detail: string;
}

/** Elapsed milliseconds between two server timestamps; null unless both exist and are ordered. */
export function serverDuration(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

export function orderedSteps(state: TimelineState): TimelineStep[] {
  return Object.values(state.steps).sort(
    (a, b) =>
      (state.attempts[a.attemptId]?.number ?? 0) - (state.attempts[b.attemptId]?.number ?? 0) ||
      a.index - b.index,
  );
}

export function describeStages(state: TimelineState): Stage[] {
  const attempts = Object.values(state.attempts);
  const claimedAt = attempts.map((a) => a.claimedAt).find(Boolean) ?? null;
  const sealedAt = attempts.map((a) => a.sealedAt ?? a.runnerStartedAt).find(Boolean) ?? null;
  const steps = orderedSteps(state);
  const finishedSteps = steps.filter((step) => isFinalStep(step.status));
  const collectedAt =
    state.phaseAt.collecting ?? attempts.map((a) => a.collectedAt).find(Boolean) ?? null;
  const reached = (phase: RunPhase) => rank(state.phase) >= rank(phase);
  const status = (done: boolean, active: boolean): { state: "done" | "active" | "pending" } => ({
    state: done ? "done" : active ? "active" : "pending",
  });
  const stages: Omit<Stage, "durationMs">[] = [
    {
      key: "request",
      label: "Request received",
      ...status(state.acceptedAt !== null || reached("preparing"), true),
      at: state.acceptedAt,
      detail: "The Run was admitted and queued.",
    },
    {
      key: "dispatch",
      label: "Dispatched to a worker",
      ...status(claimedAt !== null || reached("preparing"), state.phase === "queued"),
      at: claimedAt,
      detail: claimedAt ? "A worker claimed the Run." : "Waiting for a worker to claim the Run.",
    },
    {
      key: "readiness",
      label: "Runtime ready",
      ...status(sealedAt !== null || reached("running"), state.phase === "preparing"),
      at: sealedAt ?? state.phaseAt.running ?? null,
      detail: "Environment, evidence snapshot and runner are prepared.",
    },
    {
      key: "steps",
      label: "Steps",
      ...status(reached("collecting"), state.phase === "running"),
      at: state.phaseAt.running ?? steps[0]?.startedAt ?? null,
      detail:
        steps.length === 0
          ? "No step has reported yet."
          : `${finishedSteps.length} of ${steps.length} reported steps finished.`,
    },
    {
      key: "collection",
      label: "Evidence collected",
      ...status(reached("analyzing") || collectedAt !== null, state.phase === "collecting"),
      at: collectedAt,
      detail: "Artifacts are sealed into the evidence bundle and verified.",
    },
    {
      key: "terminal",
      label: "Result",
      ...status(state.terminal !== null, false),
      at: state.terminal?.at ?? null,
      detail: state.terminal
        ? `Finished as ${state.terminal.outcome ?? "unknown"}.`
        : "No terminal result yet.",
    },
  ];
  let previous: string | null = null;
  return stages.map((stage) => {
    const durationMs = stage.state === "pending" ? null : serverDuration(previous, stage.at);
    if (stage.at) previous = stage.at;
    return { ...stage, durationMs };
  });
}

/** What the page says about cancellation, kept apart from the Run's terminal outcome. */
export function describeCancellation(
  state: TimelineState,
): { readonly requested: boolean; readonly message: string } | null {
  if (!state.cancel) return null;
  if (!state.terminal)
    return {
      requested: true,
      message: "Cancellation requested. The Run has not stopped yet; wait for the terminal result.",
    };
  if (state.terminal.outcome === "cancelled")
    return { requested: true, message: "Cancellation was requested and the Run is cancelled." };
  return {
    requested: true,
    message: `Cancellation was requested, but the Run finished as ${state.terminal.outcome ?? "unknown"}. The proven result stands.`,
  };
}
