import { ContractError } from "@testmaster/contracts";
export type RunPhase =
  | "queued"
  | "preparing"
  | "running"
  | "collecting"
  | "analyzing"
  | "completed";
export type RunOutcome = "passed" | "failed" | "blocked" | "cancelled" | "inconclusive";
export type CleanupOutcome = "not_required" | "pending" | "passed" | "failed" | "inconclusive";
export type Gate = "pending" | "passed" | "failed" | "not_applicable";
export interface StepObservation {
  stepId: string;
  required: boolean;
  status: "passed" | "failed" | "blocked" | "cancelled" | "skipped" | "not_run" | "inconclusive";
  assertion: boolean;
  reliable: boolean;
  reasonCode?: string;
}
export interface AttemptObservation {
  attemptId: string;
  number: number;
  started: boolean;
  steps: readonly StepObservation[];
  reasonCode?: string;
  blockedBeforeStart?: boolean;
  cancelAuthorized?: boolean;
  stopConfirmed?: boolean;
  externalEffectUncertain?: boolean;
}
export interface GatePolicy {
  cleanupRequired: boolean;
  requiredEvidenceComplete: boolean;
  policySatisfied: boolean;
  requiredDependenciesPassed: boolean;
}
export interface RunState {
  phase: RunPhase;
  outcome: RunOutcome | null;
  status: Exclude<RunPhase, "completed"> | RunOutcome;
  gate: Gate;
  cleanupOutcome: CleanupOutcome;
  reasonCode: string | null;
  passedOnRetry: boolean;
  firstAttemptOutcome: RunOutcome | null;
  attempts: readonly AttemptObservation[];
  eventIds: readonly string[];
}
export type RunAction =
  | { eventId: string; type: "phase"; phase: Exclude<RunPhase, "completed"> }
  | { eventId: string; type: "attempt"; attempt: AttemptObservation }
  | {
      eventId: string;
      type: "finalize";
      requiredAssertionIds: readonly string[];
      requiredStepIds: readonly string[];
      cleanupOutcome: CleanupOutcome;
      policy: GatePolicy;
    }
  | {
      eventId: string;
      type: "cancel";
      authorized: boolean;
      stopConfirmed: boolean;
      requiredAssertionIds: readonly string[];
      requiredStepIds: readonly string[];
      cleanupOutcome: CleanupOutcome;
      policy: GatePolicy;
    };
const phases: Record<RunPhase, number> = {
  queued: 0,
  preparing: 1,
  running: 2,
  collecting: 3,
  analyzing: 4,
  completed: 5,
};
export function initialRunState(): RunState {
  return {
    phase: "queued",
    outcome: null,
    status: "queued",
    gate: "pending",
    cleanupOutcome: "not_required",
    reasonCode: null,
    passedOnRetry: false,
    firstAttemptOutcome: null,
    attempts: [],
    eventIds: [],
  };
}
export function evaluateGate(
  outcome: RunOutcome | null,
  cleanup: CleanupOutcome,
  policy: GatePolicy,
): Gate {
  if (outcome === null) return "pending";
  if (
    outcome !== "passed" ||
    !policy.requiredEvidenceComplete ||
    !policy.policySatisfied ||
    !policy.requiredDependenciesPassed ||
    (policy.cleanupRequired && cleanup !== "passed")
  )
    return "failed";
  return "passed";
}
export interface ReducedOutcome {
  outcome: RunOutcome;
  reasonCode: string;
  passedOnRetry: boolean;
  firstAttemptOutcome: RunOutcome | null;
}
export function reduceOutcome(
  attempts: readonly AttemptObservation[],
  requiredAssertionIds: readonly string[],
  requiredStepIds: readonly string[],
  cancel?: { authorized: boolean; stopConfirmed: boolean },
): ReducedOutcome {
  if (requiredAssertionIds.length === 0)
    throw new ContractError("INVALID_ARGUMENT", "Run requires an assertion");
  const ordered = [...attempts].sort((left, right) => left.number - right.number);
  const failure = ordered
    .flatMap((attempt) => attempt.steps)
    .find((step) => step.required && step.assertion && step.reliable && step.status === "failed");
  const complete = (attempt: AttemptObservation): boolean =>
    requiredAssertionIds.every((id) =>
      attempt.steps.some(
        (step) =>
          step.stepId === id &&
          step.assertion &&
          step.required &&
          step.reliable &&
          step.status === "passed",
      ),
    ) &&
    requiredStepIds.every((id) =>
      attempt.steps.some((step) => step.stepId === id && step.status === "passed"),
    );
  const first = ordered[0];
  let firstAttemptOutcome: RunOutcome | null = null;
  if (first) {
    if (
      first.steps.some(
        (step) => step.required && step.assertion && step.reliable && step.status === "failed",
      )
    )
      firstAttemptOutcome = "failed";
    else if (complete(first)) firstAttemptOutcome = "passed";
    else if (first.cancelAuthorized && first.stopConfirmed) firstAttemptOutcome = "cancelled";
    else firstAttemptOutcome = first.started ? "inconclusive" : "blocked";
  }
  const passedOnRetry = Boolean(
    failure &&
      ordered.some((attempt) => attempt.number > (first?.number ?? 0) && complete(attempt)),
  );
  if (failure)
    return {
      outcome: "failed",
      reasonCode:
        failure.reasonCode === "assertion_timeout" ? "assertion_timeout" : "assertion_mismatch",
      passedOnRetry,
      firstAttemptOutcome,
    };
  if (
    (cancel?.authorized && cancel.stopConfirmed) ||
    ordered.some((attempt) => attempt.cancelAuthorized && attempt.stopConfirmed)
  )
    return {
      outcome: "cancelled",
      reasonCode: "user_cancelled",
      passedOnRetry: false,
      firstAttemptOutcome,
    };
  if (ordered.some(complete))
    return {
      outcome: "passed",
      reasonCode: "assertions_satisfied",
      passedOnRetry: false,
      firstAttemptOutcome,
    };
  if (!ordered.some((attempt) => attempt.started))
    return {
      outcome: "blocked",
      reasonCode: ordered.at(-1)?.reasonCode ?? "security_precondition_failed",
      passedOnRetry: false,
      firstAttemptOutcome,
    };
  return {
    outcome: "inconclusive",
    reasonCode: ordered.at(-1)?.reasonCode ?? "insufficient_evidence",
    passedOnRetry: false,
    firstAttemptOutcome,
  };
}
export function reduceRun(state: RunState, action: RunAction): RunState {
  if (state.phase === "completed" || state.eventIds.includes(action.eventId)) return state;
  const eventIds = [...state.eventIds, action.eventId];
  if (action.type === "phase") {
    if (phases[action.phase] < phases[state.phase]) return { ...state, eventIds };
    return { ...state, phase: action.phase, status: action.phase, eventIds };
  }
  if (action.type === "attempt") {
    const previous = state.attempts.find(
      (attempt) => attempt.attemptId === action.attempt.attemptId,
    );
    const retainedSteps =
      previous?.steps.filter(
        (step) =>
          !action.attempt.steps.some((next) => next.stepId === step.stepId) ||
          (step.assertion && step.required && step.reliable && step.status === "failed"),
      ) ?? [];
    const merged: AttemptObservation = {
      ...action.attempt,
      started: Boolean(previous?.started || action.attempt.started),
      externalEffectUncertain: Boolean(
        previous?.externalEffectUncertain || action.attempt.externalEffectUncertain,
      ),
      steps: [...retainedSteps, ...action.attempt.steps],
    };
    const attempts = [
      ...state.attempts.filter((attempt) => attempt.attemptId !== action.attempt.attemptId),
      merged,
    ];
    return { ...state, attempts, eventIds };
  }
  if (action.type === "cancel" && !action.authorized)
    throw new ContractError("FORBIDDEN", "Cancellation is not authorized");
  if (action.type === "cancel" && !action.stopConfirmed) return { ...state, eventIds };
  const reduced = reduceOutcome(
    state.attempts,
    action.requiredAssertionIds,
    action.requiredStepIds,
    action.type === "cancel"
      ? { authorized: action.authorized, stopConfirmed: action.stopConfirmed }
      : undefined,
  );
  return {
    ...state,
    ...reduced,
    phase: "completed",
    status: reduced.outcome,
    cleanupOutcome: action.cleanupOutcome,
    gate: evaluateGate(reduced.outcome, action.cleanupOutcome, action.policy),
    eventIds,
  };
}
export function cancelReceipt(
  state: RunState,
  authorized: boolean,
): { result: "requested" | "already_terminal" | "rejected"; status: RunState["status"] } {
  return {
    result:
      state.phase === "completed" ? "already_terminal" : authorized ? "requested" : "rejected",
    status: state.status,
  };
}
export function canRetry(attempt: AttemptObservation, maxAttempts: number): boolean {
  return (
    attempt.number < maxAttempts &&
    ![
      "security_precondition_failed",
      "approval_required",
      "egress_denied",
      "missing_secret",
      "credential_revoked",
      "retry_unsafe_external_effect",
    ].includes(attempt.reasonCode ?? "") &&
    !attempt.externalEffectUncertain &&
    !attempt.steps.some((step) => step.assertion || step.status === "passed") &&
    !attempt.cancelAuthorized
  );
}
