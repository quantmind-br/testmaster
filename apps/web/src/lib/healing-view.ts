import type { Shape, Tone } from "../components/status";
import type { RunRecord } from "./run-types";

/**
 * View models for the analysis panel and the healing review. Everything here is wording and
 * gating, never data fetching: the server owns the facts, this module decides how cautiously they
 * are phrased. A suspected cause is never worded as confirmed, and "healed" appears only when a
 * verification Run that was not the failed one passed.
 */

export interface EvidenceRefRecord {
  readonly artifactId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly stepId?: string;
  readonly observationSeq?: number;
  readonly relativePath?: string;
  readonly jsonPointer?: string;
  readonly snapshotId?: string;
  readonly sourceRevisionId?: string;
  readonly codeSnapshotId?: string;
  readonly offset?: number;
  readonly length?: number;
  readonly page?: number;
  readonly contentHash?: string;
}

export type FailureKind =
  | "product_bug"
  | "test_fragility"
  | "environment"
  | "contract_violation"
  | "security_policy"
  | "unknown";
export type RecommendedAction =
  | "fix_product"
  | "fix_test"
  | "fix_environment"
  | "review_contract"
  | "collect_more_evidence";
export type ConclusionStatus =
  | "no_failure"
  | "cause_supported"
  | "cause_partially_supported"
  | "cause_unknown";
export type HealingAdvice = "not_indicated" | "proposal_possible" | "manual_review_only";

export interface AnalysisHypothesis {
  readonly text: string;
  readonly supports: readonly EvidenceRefRecord[];
  readonly contradicts: readonly EvidenceRefRecord[];
  readonly confidence: number;
  readonly calibrated: boolean;
  readonly support?: "supported" | "partially_supported";
}

export interface AnalysisDiagnosis {
  readonly observation: {
    readonly stepId: string | null;
    readonly operation: string | null;
    readonly summary: string;
    readonly expected: string | null;
    readonly observed: string | null;
    readonly absence: string | null;
    readonly evidenceRefs: readonly EvidenceRefRecord[];
  } | null;
  readonly chain: readonly {
    readonly stepId: string;
    readonly operation: string;
    readonly status: string;
    readonly summary: string;
    readonly verifies: string | null;
    readonly baseline: "same" | "different" | "unavailable";
    readonly evidenceRefs: readonly EvidenceRefRecord[];
  }[];
  readonly alternatives: readonly {
    readonly text: string;
    readonly failureKind: FailureKind;
    readonly evidenceRefs: readonly EvidenceRefRecord[];
  }[];
  readonly conclusion: { readonly status: ConclusionStatus; readonly text: string };
  readonly nextSteps: readonly {
    readonly text: string;
    readonly source: "rules" | "model";
    readonly evidenceRefs: readonly EvidenceRefRecord[];
  }[];
  readonly evidenceGaps: readonly string[];
  readonly healing: { readonly advice: HealingAdvice; readonly reason: string };
}

export interface AnalysisRecord {
  readonly id: string;
  readonly runId: string;
  readonly source: "rules" | "model";
  readonly failureKind: FailureKind;
  readonly confidence: number | null;
  readonly modelCallId: string | null;
  readonly limitations: readonly string[];
  readonly recommendedAction: RecommendedAction;
  readonly hypotheses: readonly AnalysisHypothesis[];
  readonly facts: readonly {
    readonly text: string;
    readonly evidenceRefs: readonly EvidenceRefRecord[];
  }[];
  readonly diagnosis?: AnalysisDiagnosis;
  readonly createdAt?: string;
}

export type HealingStatus = "proposed" | "approved" | "rejected" | "verified";
export type Risk = "read" | "write" | "destructive" | "securityProbe";
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface HealingProposalRecord {
  readonly id: string;
  readonly version?: number;
  readonly createdAt?: string;
  readonly failedRunId: string;
  readonly testId: string;
  readonly analysisId: string | null;
  readonly baseRevisionId: string;
  readonly candidateRevisionId: string;
  readonly diff: string;
  readonly changes: readonly {
    readonly stepId: string;
    readonly path: string;
    readonly value: JsonValue;
  }[];
  readonly evidenceRefs: readonly EvidenceRefRecord[];
  readonly preservedAssertionsHash: string;
  readonly risk: Risk;
  readonly status: HealingStatus;
  readonly approvalMode: "manual" | "policy" | null;
  readonly reviewerId: string | null;
  readonly verificationRunId: string | null;
  readonly modelCallId: string | null;
  readonly limitations: readonly string[];
}

export interface HealingReviewRecord {
  readonly changes: readonly {
    readonly stepId: string;
    readonly path: string;
    readonly before: JsonValue;
    readonly after: JsonValue;
  }[];
  readonly identity: readonly {
    readonly stepId: string;
    readonly previous: JsonValue;
    readonly candidates: readonly {
      readonly role: string | null;
      readonly name: string | null;
      readonly tag: string | null;
      readonly type: string | null;
      readonly label: string | null;
      readonly form: string | null;
      readonly matched: boolean;
      readonly visible: boolean;
    }[];
    readonly equivalence: {
      readonly equivalent: boolean;
      readonly reasons: readonly string[];
    } | null;
  }[];
  readonly automation: {
    readonly decision: "applied_by_policy" | "manual_review_required" | "not_eligible";
    readonly reasons: readonly string[];
  };
  readonly preservedAssertions: {
    readonly hash: string;
    readonly intact: boolean;
    readonly stepIds: readonly string[];
  };
  readonly risk: Risk;
  readonly verification: {
    readonly runId: string;
    readonly outcome: string | null;
    readonly gate: string;
  } | null;
  readonly approval: {
    readonly expectedVersion: number;
    readonly proposalId: string;
    readonly candidateRevisionId: string;
  };
  readonly evidenceRefs: readonly EvidenceRefRecord[];
  readonly limitations: readonly string[];
}

export interface Described {
  readonly label: string;
  readonly tone: Tone;
  readonly shape: Shape;
}

export interface DescribedWithText extends Described {
  readonly text: string;
}

/* -------------------------------------------------------------------------- analysis */

export const failureKindLabels: Readonly<Record<FailureKind, string>> = {
  product_bug: "Product bug",
  test_fragility: "Test fragility",
  environment: "Environment problem",
  contract_violation: "Contract violation",
  security_policy: "Security policy",
  unknown: "Unknown",
};

export const recommendedActionLabels: Readonly<Record<RecommendedAction, string>> = {
  fix_product: "Fix the product",
  fix_test: "Fix the test",
  fix_environment: "Fix the environment",
  review_contract: "Review the contract",
  collect_more_evidence: "Collect more evidence",
};

export type AnalysisAvailabilityKind = "none" | "pending" | "unavailable" | "partial" | "complete";

export interface AnalysisAvailability {
  readonly kind: AnalysisAvailabilityKind;
  readonly title: string;
  readonly message: string;
}

/**
 * Whether an analysis exists is decided by the Run's `analysisStatus` and by whether the
 * analysis resource was found. A missing analysis is never rendered as "no problem found".
 */
export function describeAvailability(
  status: RunRecord["analysisStatus"],
  analysisFound: boolean,
): AnalysisAvailability {
  if (status === "pending")
    return {
      kind: "pending",
      title: "Analysis in progress",
      message: "The analysis has not finished. No cause is asserted until it does.",
    };
  if (status === "unavailable")
    return {
      kind: "unavailable",
      title: "Analysis unavailable",
      message:
        "The analysis could not be produced. No root cause is asserted; read the evidence directly.",
    };
  if (!analysisFound)
    return {
      kind: "none",
      title: "No analysis yet",
      message:
        "No analysis has been requested for this Run. Nothing here says what caused the result.",
    };
  if (status === "partial")
    return {
      kind: "partial",
      title: "Partial analysis",
      message:
        "Some evidence was unavailable, so this analysis is incomplete. Read the limitations below.",
    };
  return {
    kind: "complete",
    title: "Analysis",
    message: "Every statement below cites recorded evidence or says that it has none.",
  };
}

export function describeSource(source: AnalysisRecord["source"]): DescribedWithText {
  return source === "rules"
    ? {
        label: "Rules",
        tone: "info",
        shape: "info",
        text: "Deterministic rules over recorded evidence. No model was used.",
      }
    : {
        label: "Model",
        tone: "warning",
        shape: "warn",
        text: "A model proposed this reading of the evidence. Treat it as a suggestion and check the cited evidence.",
      };
}

export function percent(value: number): string {
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

/** Confidence is shown only with its calibration status; an uncalibrated number is a heuristic. */
export function describeConfidence(
  value: number | null,
  calibrated: boolean | null,
): { readonly label: string; readonly caveat: string } {
  if (value === null)
    return { label: "Not reported", caveat: "No confidence was reported for this analysis." };
  if (calibrated === true)
    return {
      label: percent(value),
      caveat: "Calibrated against measured outcomes.",
    };
  return {
    label: percent(value),
    caveat:
      "Not calibrated: this is a heuristic score, not a probability that the statement is right.",
  };
}

/** An analysis-level number is calibrated only when it has hypotheses and all of them are. */
export function analysisCalibrated(analysis: AnalysisRecord): boolean | null {
  if (analysis.hypotheses.length === 0) return null;
  return analysis.hypotheses.every((hypothesis) => hypothesis.calibrated);
}

/** Cited evidence anywhere in the analysis; zero means every statement is only a suggestion. */
export function citedEvidenceCount(analysis: AnalysisRecord): number {
  const diagnosis = analysis.diagnosis;
  return (
    analysis.facts.reduce((sum, fact) => sum + fact.evidenceRefs.length, 0) +
    analysis.hypotheses.reduce((sum, item) => sum + item.supports.length, 0) +
    (diagnosis
      ? diagnosis.chain.reduce((sum, link) => sum + link.evidenceRefs.length, 0) +
        (diagnosis.observation?.evidenceRefs.length ?? 0)
      : 0)
  );
}

/**
 * The headline conclusion. "Supported" is the strongest wording available: even a supported
 * cause is a reading of evidence, not a verdict, and without any cited evidence it is a mere
 * suggestion.
 */
export function describeConclusion(analysis: AnalysisRecord): DescribedWithText {
  const conclusion = analysis.diagnosis?.conclusion;
  if (!conclusion)
    return {
      label: "Suggestion",
      tone: "neutral",
      shape: "question",
      text: "This record has no stated conclusion. Treat every line as a suggestion.",
    };
  if (conclusion.status === "no_failure")
    return { label: "No failure to explain", tone: "info", shape: "info", text: conclusion.text };
  if (conclusion.status === "cause_unknown")
    return { label: "Cause unknown", tone: "warning", shape: "question", text: conclusion.text };
  if (citedEvidenceCount(analysis) === 0)
    return {
      label: "Suggestion — no cited evidence",
      tone: "warning",
      shape: "question",
      text: conclusion.text,
    };
  if (conclusion.status === "cause_partially_supported")
    return {
      label: "Suspected cause — partially supported",
      tone: "warning",
      shape: "warn",
      text: conclusion.text,
    };
  return {
    label: "Cause supported by cited evidence",
    tone: "success",
    shape: "check",
    text: conclusion.text,
  };
}

/** One line per hypothesis: how well the cited evidence backs it, with the contradictions. */
export function describeHypothesis(hypothesis: AnalysisHypothesis): DescribedWithText {
  const contradictions =
    hypothesis.contradicts.length > 0
      ? ` ${hypothesis.contradicts.length} cited item${hypothesis.contradicts.length === 1 ? "" : "s"} contradict it.`
      : "";
  if (hypothesis.supports.length === 0)
    return {
      label: "Suggestion — no cited evidence",
      tone: "warning",
      shape: "question",
      text: `Nothing recorded supports this hypothesis.${contradictions}`,
    };
  const supports = `${hypothesis.supports.length} cited item${hypothesis.supports.length === 1 ? "" : "s"} support it.`;
  if (hypothesis.support === "supported")
    return {
      label: "Supported",
      tone: "success",
      shape: "check",
      text: `${supports}${contradictions}`,
    };
  return {
    label: hypothesis.support === "partially_supported" ? "Partially supported" : "Unclassified",
    tone: "warning",
    shape: "warn",
    text: `${supports}${contradictions}`,
  };
}

export function describeHealingAdvice(advice: HealingAdvice): string {
  const labels: Record<HealingAdvice, string> = {
    not_indicated: "Healing is not indicated for this failure.",
    proposal_possible: "A healing proposal is possible; it would still need human review.",
    manual_review_only: "Only a manual review can change this test; healing will not.",
  };
  return labels[advice];
}

export function describeBaseline(baseline: "same" | "different" | "unavailable"): string {
  const labels = {
    same: "same as the passing baseline",
    different: "differs from the passing baseline",
    unavailable: "no passing baseline to compare",
  } as const;
  return labels[baseline];
}

/** Compact text for an evidence reference; the page links the Run when one is present. */
export function describeEvidenceRef(ref: EvidenceRefRecord, fallbackRunId?: string): string {
  const parts: string[] = [];
  const runId = ref.runId ?? fallbackRunId;
  if (ref.artifactId) parts.push(`artifact ${ref.artifactId}`);
  if (runId) parts.push(`run ${runId}`);
  if (ref.attemptId) parts.push(`attempt ${ref.attemptId}`);
  if (ref.stepId) parts.push(`step ${ref.stepId}`);
  if (ref.observationSeq !== undefined) parts.push(`observation #${ref.observationSeq}`);
  if (ref.relativePath) parts.push(ref.relativePath);
  if (ref.jsonPointer !== undefined)
    parts.push(`at ${ref.jsonPointer === "" ? "/" : ref.jsonPointer}`);
  if (ref.page !== undefined) parts.push(`page ${ref.page}`);
  if (ref.offset !== undefined)
    parts.push(`bytes ${ref.offset}${ref.length === undefined ? "" : `+${ref.length}`}`);
  if (parts.length === 0) {
    const other = ref.snapshotId ?? ref.sourceRevisionId ?? ref.codeSnapshotId;
    parts.push(other ? `snapshot ${other}` : "recorded evidence");
  }
  return parts.join(" · ");
}

/* -------------------------------------------------------------------------- healing */

export function describeHealingStatus(status: string): DescribedWithText {
  switch (status) {
    case "proposed":
      return {
        label: "Proposed",
        tone: "info",
        shape: "clock",
        text: "Waiting for a human decision. Nothing has been changed.",
      };
    case "approved":
      return {
        label: "Approved — verification pending",
        tone: "warning",
        shape: "clock",
        text: "Approved by a human. The candidate is not promoted until a new verification Run passes.",
      };
    case "rejected":
      return {
        label: "Rejected",
        tone: "neutral",
        shape: "slash",
        text: "Rejected by a human. The test keeps its current revision.",
      };
    case "verified":
      return {
        label: "Verified",
        tone: "success",
        shape: "check",
        text: "A new verification Run passed on the candidate revision.",
      };
    default:
      return {
        label: status === "" ? "Unknown" : status,
        tone: "neutral",
        shape: "question",
        text: "This status is not recognized by this version of the portal.",
      };
  }
}

export function describeRisk(risk: string): DescribedWithText {
  switch (risk) {
    case "read":
      return {
        label: "Read-only",
        tone: "success",
        shape: "check",
        text: "The candidate only reads from the system under test.",
      };
    case "write":
      return {
        label: "Writes data",
        tone: "warning",
        shape: "warn",
        text: "The candidate creates or changes data in the system under test.",
      };
    case "destructive":
      return {
        label: "Destructive",
        tone: "danger",
        shape: "stop",
        text: "The candidate can delete or irreversibly change data.",
      };
    case "securityProbe":
      return {
        label: "Security probe",
        tone: "danger",
        shape: "stop",
        text: "The candidate probes security controls and needs explicit scope.",
      };
    default:
      return {
        label: "Unknown risk",
        tone: "warning",
        shape: "question",
        text: "The risk class is not recognized; treat it as high.",
      };
  }
}

export function describeDecision(
  decision: HealingReviewRecord["automation"]["decision"],
): DescribedWithText {
  switch (decision) {
    case "applied_by_policy":
      return {
        label: "Applied by policy",
        tone: "info",
        shape: "info",
        text: "An authorized project policy allowed this adjustment. It still produced a new revision and a new verification Run.",
      };
    case "manual_review_required":
      return {
        label: "Manual review required",
        tone: "warning",
        shape: "lock",
        text: "Policy did not allow automatic application. A human must accept or reject it.",
      };
    default:
      return {
        label: "Not eligible for automatic application",
        tone: "neutral",
        shape: "lock",
        text: "This proposal is not, or is no longer, eligible for automatic application.",
      };
  }
}

export interface AcceptanceInput {
  readonly status: HealingStatus | string;
  /** `null` while the review has not loaded: unknown is never treated as intact. */
  readonly assertionsIntact: boolean | null;
  readonly changeCount: number;
  readonly verificationRunId: string | null;
  /** The test's currently active revision, when it could be read. */
  readonly activeRevisionId: string | null;
  readonly baseRevisionId: string;
  /** From `GET /me`: `null` while unknown, so an unknown permission never hides a real denial. */
  readonly canApprove: boolean | null;
}

export interface Acceptance {
  readonly allowed: boolean;
  /** Why the action is unavailable, shown next to the disabled button. */
  readonly reasons: readonly string[];
}

/** Accept is only possible for a reviewable proposal whose assertions are provably intact. */
export function decideAcceptance(input: AcceptanceInput): Acceptance {
  const reasons: string[] = [];
  if (input.status !== "proposed")
    reasons.push(
      `This proposal is already ${describeHealingStatus(input.status).label.toLowerCase()}.`,
    );
  if (input.assertionsIntact === null)
    reasons.push(
      "The assertion check is not available, so acceptance stays disabled until the review loads.",
    );
  else if (!input.assertionsIntact)
    reasons.push(
      "The preserved assertions are not intact. Healing never changes assertions, so this candidate cannot be accepted; edit the test and approve it through the normal revision flow.",
    );
  if (input.changeCount === 0) reasons.push("The proposal contains no changes to accept.");
  if (input.status === "proposed" && input.verificationRunId !== null)
    reasons.push(
      `Verification Run ${input.verificationRunId} already ran for this proposal without verifying it. Accepting again would not start another verification.`,
    );
  if (input.activeRevisionId !== null && input.activeRevisionId !== input.baseRevisionId)
    reasons.push(
      "The test's active revision is no longer the base of this proposal. Review a new proposal against the current revision.",
    );
  if (input.canApprove === false)
    reasons.push(
      "Your role cannot approve healing proposals. Approval needs a human member with write permission.",
    );
  return { allowed: reasons.length === 0, reasons };
}

export type ChainState = "done" | "pending" | "failed" | "not-started";

export interface LifecycleStep {
  readonly key: "failed-run" | "proposal" | "revision" | "verification";
  readonly label: string;
  readonly detail: string;
  readonly state: ChainState;
}

export interface Lifecycle {
  readonly steps: readonly LifecycleStep[];
  /** The only sentence about the outcome; "healed" appears only after a passing new Run. */
  readonly headline: string;
  readonly healed: boolean;
}

/**
 * Failed Run → proposal → candidate revision → verification Run. The original failure is never
 * rewritten, and a verification that is queued or running says so instead of "healed".
 */
export function describeLifecycle(
  proposal: Pick<
    HealingProposalRecord,
    "status" | "failedRunId" | "candidateRevisionId" | "verificationRunId"
  >,
  verification: {
    readonly runId: string;
    readonly outcome: string | null;
    readonly phase?: string;
  } | null,
): Lifecycle {
  const verificationDone = verification !== null && verification.outcome !== null;
  const passed = verification?.outcome === "passed";
  const healed = proposal.status === "verified" && passed;
  let verificationStep: LifecycleStep;
  if (!proposal.verificationRunId)
    verificationStep = {
      key: "verification",
      label: "Verification Run",
      detail:
        proposal.status === "rejected"
          ? "None: the proposal was rejected."
          : "None yet. Accepting starts a new Run on the candidate revision.",
      state: "not-started",
    };
  else if (!verificationDone)
    verificationStep = {
      key: "verification",
      label: "Verification Run",
      detail: `Run ${proposal.verificationRunId} has not finished${verification?.phase ? ` (${verification.phase})` : ""}. Its result is not known.`,
      state: "pending",
    };
  else
    verificationStep = {
      key: "verification",
      label: "Verification Run",
      detail: `Run ${proposal.verificationRunId} finished ${verification?.outcome ?? "without a verdict"}.`,
      state: passed ? "done" : "failed",
    };
  const steps: LifecycleStep[] = [
    {
      key: "failed-run",
      label: "Failed Run",
      detail: `Run ${proposal.failedRunId} stays failed; it is never rewritten.`,
      state: "failed",
    },
    {
      key: "proposal",
      label: "Proposal",
      detail: describeHealingStatus(proposal.status).text,
      state:
        proposal.status === "proposed"
          ? "pending"
          : proposal.status === "rejected"
            ? "failed"
            : "done",
    },
    {
      key: "revision",
      label: "Candidate revision",
      detail:
        proposal.status === "proposed"
          ? `Revision ${proposal.candidateRevisionId} exists as a candidate and is not active.`
          : proposal.status === "rejected"
            ? `Revision ${proposal.candidateRevisionId} was not promoted.`
            : proposal.status === "verified"
              ? `Revision ${proposal.candidateRevisionId} is promoted after verification.`
              : `Revision ${proposal.candidateRevisionId} is not active until verification passes.`,
      state:
        proposal.status === "verified"
          ? "done"
          : proposal.status === "rejected"
            ? "failed"
            : "pending",
    },
    verificationStep,
  ];
  let headline: string;
  if (healed)
    headline = `Verified: Run ${proposal.verificationRunId} passed on the candidate revision. The original Run still shows its failure.`;
  else if (proposal.status === "rejected")
    headline = "Not healed. The proposal was rejected and the test is unchanged.";
  else if (proposal.verificationRunId && !verificationDone)
    headline =
      "Not healed yet. A verification Run is queued or running; only its result can verify this proposal.";
  else if (proposal.verificationRunId && verificationDone)
    headline = `Not verified. Verification Run ${proposal.verificationRunId} finished ${verification?.outcome ?? "without a verdict"}, so the candidate is not promoted.`;
  else headline = "Not healed. The original Run stays failed and nothing has been applied.";
  return { steps, headline, healed };
}

/** Pretty JSON so a changed value diffs line by line; strings stay readable. */
export function formatChangeValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "null";
}

/** The reason is required and bounded by the contract (1–8000 characters after trimming). */
export const maxRejectionReason = 8000;
export function validateRejectionReason(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed === "") return "Enter the reason for rejecting this proposal.";
  if (trimmed.length > maxRejectionReason)
    return `Keep the reason under ${maxRejectionReason} characters.`;
  return null;
}

export interface MutationFailure {
  readonly kind: "conflict" | "forbidden" | "precondition" | "policy" | "other";
  readonly title: string;
  readonly message: string;
}

/** Maps an API error code onto a recoverable, human sentence. A conflict never overwrites. */
export function describeMutationFailure(
  code: string,
  action: "accept" | "reject",
  serverMessage: string,
): MutationFailure {
  const verb = action === "accept" ? "accepting" : "rejecting";
  switch (code) {
    case "REVISION_CONFLICT":
      return {
        kind: "conflict",
        title: "This proposal changed while you were reviewing it",
        message: `Someone else changed the proposal, its test or the policy. Nothing was applied by ${verb} it. Reload to review the current state.`,
      };
    case "FORBIDDEN":
      return {
        kind: "forbidden",
        title: "You are not allowed to decide this proposal",
        message:
          "Approving or rejecting healing proposals needs a human member with write permission and a healing approval grant. Ask a workspace admin for access.",
      };
    case "PRECONDITION_FAILED":
      return {
        kind: "precondition",
        title: `This proposal can no longer be ${action === "accept" ? "accepted" : "rejected"}`,
        message: `${serverMessage} Reload to see its current status.`,
      };
    case "POLICY_DENIED":
      return {
        kind: "policy",
        title: "Policy refused this proposal",
        message: `${serverMessage} The candidate was not applied.`,
      };
    default:
      return {
        kind: "other",
        title: `The ${action} request failed`,
        message: serverMessage === "" ? "The request failed. Try again." : serverMessage,
      };
  }
}
