import { describe, expect, it } from "vitest";
import {
  type AcceptanceInput,
  type AnalysisRecord,
  decideAcceptance,
  describeAvailability,
  describeConclusion,
  describeConfidence,
  describeDecision,
  describeEvidenceRef,
  describeHealingStatus,
  describeHypothesis,
  describeLifecycle,
  describeMutationFailure,
  describeRisk,
  validateRejectionReason,
} from "./healing-view";

const ref = { runId: "run_1", stepId: "s1" };

function analysis(overrides: Partial<AnalysisRecord> = {}): AnalysisRecord {
  return {
    id: "ana_1",
    runId: "run_1",
    source: "rules",
    failureKind: "product_bug",
    confidence: 0.7,
    modelCallId: null,
    limitations: [],
    recommendedAction: "fix_product",
    hypotheses: [],
    facts: [],
    ...overrides,
  };
}

const acceptable: AcceptanceInput = {
  status: "proposed",
  assertionsIntact: true,
  changeCount: 1,
  verificationRunId: null,
  activeRevisionId: "rev_base",
  baseRevisionId: "rev_base",
  canApprove: true,
};

describe("analysis wording", () => {
  it("UX-033 a missing, pending or unavailable analysis never reads as a finished one", () => {
    expect(describeAvailability("not_requested", false)).toMatchObject({
      kind: "none",
      title: "No analysis yet",
    });
    expect(describeAvailability("pending", false).kind).toBe("pending");
    expect(describeAvailability("unavailable", false)).toMatchObject({ kind: "unavailable" });
    expect(describeAvailability("unavailable", false).message).toContain(
      "No root cause is asserted",
    );
    expect(describeAvailability("partial", true).kind).toBe("partial");
    // Negative control: only a found, complete analysis is presented as complete.
    expect(describeAvailability("complete", true).kind).toBe("complete");
    expect(describeAvailability("complete", false).kind).toBe("none");
  });

  it("UX-033 confidence always carries its calibration status", () => {
    expect(describeConfidence(0.66, false)).toMatchObject({ label: "66%" });
    expect(describeConfidence(0.66, false).caveat).toContain("Not calibrated");
    expect(describeConfidence(0.66, null).caveat).toContain("Not calibrated");
    expect(describeConfidence(0.66, true).caveat).toBe("Calibrated against measured outcomes.");
    expect(describeConfidence(null, null).label).toBe("Not reported");
    expect(describeConfidence(7, true).label).toBe("100%");
  });

  it("UX-033 a supported cause without cited evidence is labelled a suggestion, never confirmed", () => {
    const supported = analysis({
      diagnosis: {
        observation: null,
        chain: [],
        alternatives: [],
        conclusion: { status: "cause_supported", text: "The API returned 500" },
        nextSteps: [],
        evidenceGaps: [],
        healing: { advice: "not_indicated", reason: "n/a" },
      },
    });
    const bare = describeConclusion(supported);
    expect(bare.label).toBe("Suggestion — no cited evidence");
    expect(bare.tone).not.toBe("success");
    const cited = describeConclusion({
      ...supported,
      facts: [{ text: "500", evidenceRefs: [ref] }],
    });
    expect(cited.label).toBe("Cause supported by cited evidence");
    expect(cited.tone).toBe("success");
    for (const label of [bare.label, cited.label])
      expect(label.toLowerCase()).not.toContain("confirmed");
  });

  it("UX-033 partially supported and unknown conclusions stay visibly qualified", () => {
    const base = analysis({ facts: [{ text: "x", evidenceRefs: [ref] }] });
    const make = (status: "cause_partially_supported" | "cause_unknown" | "no_failure") =>
      describeConclusion({
        ...base,
        diagnosis: {
          observation: null,
          chain: [],
          alternatives: [],
          conclusion: { status, text: "text" },
          nextSteps: [],
          evidenceGaps: [],
          healing: { advice: "not_indicated", reason: "n/a" },
        },
      });
    expect(make("cause_partially_supported")).toMatchObject({
      label: "Suspected cause — partially supported",
      tone: "warning",
    });
    expect(make("cause_unknown")).toMatchObject({ label: "Cause unknown", tone: "warning" });
    expect(make("no_failure").label).toBe("No failure to explain");
    expect(describeConclusion(base).label).toBe("Suggestion");
  });

  it("UX-033 a hypothesis states how many cited items support and contradict it", () => {
    const supported = describeHypothesis({
      text: "h",
      supports: [ref],
      contradicts: [ref, { runId: "run_2" }],
      confidence: 0.4,
      calibrated: false,
      support: "supported",
    });
    expect(supported.label).toBe("Supported");
    expect(supported.text).toContain("1 cited item support it.");
    expect(supported.text).toContain("2 cited items contradict it.");
    // Negative control: no cited support is a suggestion, whatever the model claimed.
    const unsupported = describeHypothesis({
      text: "h",
      supports: [],
      contradicts: [],
      confidence: 0.99,
      calibrated: true,
      support: "supported",
    });
    expect(unsupported.label).toBe("Suggestion — no cited evidence");
    expect(
      describeHypothesis({
        ...{ text: "h", supports: [ref], contradicts: [], confidence: 0.5, calibrated: false },
      }).label,
    ).toBe("Unclassified");
  });

  it("UX-033 evidence references name what they point at", () => {
    expect(
      describeEvidenceRef({ artifactId: "art_1", stepId: "s2", observationSeq: 3 }, "run_9"),
    ).toBe("artifact art_1 · run run_9 · step s2 · observation #3");
    expect(describeEvidenceRef({ jsonPointer: "" })).toBe("at /");
    expect(describeEvidenceRef({ snapshotId: "snp_1" })).toBe("snapshot snp_1");
  });
});

describe("healing review wording", () => {
  it("UX-039 every status has text and a shape, and an unknown status is never success", () => {
    for (const status of ["proposed", "approved", "rejected", "verified"]) {
      const described = describeHealingStatus(status);
      expect(described.label).not.toBe("");
      expect(described.shape).toBeTruthy();
    }
    expect(describeHealingStatus("approved").label).toContain("verification pending");
    expect(describeHealingStatus("verified")).toMatchObject({ tone: "success", shape: "check" });
    expect(describeHealingStatus("mystery")).toMatchObject({ tone: "neutral", shape: "question" });
  });

  it("UX-039 risk and automation decisions are spelled out", () => {
    expect(describeRisk("read").label).toBe("Read-only");
    expect(describeRisk("destructive").tone).toBe("danger");
    expect(describeRisk("securityProbe").label).toBe("Security probe");
    expect(describeRisk("???").tone).toBe("warning");
    expect(describeDecision("manual_review_required").text).toContain("must accept or reject");
    expect(describeDecision("applied_by_policy").label).toBe("Applied by policy");
    expect(describeDecision("not_eligible").label).toContain("Not eligible");
  });

  it("UX-039 UX-040 acceptance is allowed only for a reviewable proposal with intact assertions", () => {
    expect(decideAcceptance(acceptable)).toEqual({ allowed: true, reasons: [] });
    const blocked = decideAcceptance({ ...acceptable, assertionsIntact: false });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reasons.join(" ")).toContain("Healing never changes assertions");
    // Unknown is not intact.
    expect(decideAcceptance({ ...acceptable, assertionsIntact: null }).allowed).toBe(false);
  });

  it("UX-039 acceptance names every reason it is blocked", () => {
    expect(decideAcceptance({ ...acceptable, status: "approved" }).reasons[0]).toContain(
      "already approved",
    );
    expect(decideAcceptance({ ...acceptable, status: "rejected" }).allowed).toBe(false);
    expect(decideAcceptance({ ...acceptable, changeCount: 0 }).reasons[0]).toContain("no changes");
    expect(decideAcceptance({ ...acceptable, verificationRunId: "run_v" }).reasons[0]).toContain(
      "run_v",
    );
    expect(decideAcceptance({ ...acceptable, activeRevisionId: "rev_other" }).reasons[0]).toContain(
      "no longer the base",
    );
    expect(decideAcceptance({ ...acceptable, canApprove: false }).reasons[0]).toContain(
      "Your role cannot approve",
    );
    // An unknown permission does not block: the server decides and its refusal is shown.
    expect(decideAcceptance({ ...acceptable, canApprove: null }).allowed).toBe(true);
    const many = decideAcceptance({
      ...acceptable,
      assertionsIntact: false,
      canApprove: false,
      changeCount: 0,
    });
    expect(many.reasons).toHaveLength(3);
  });

  it("UX-040 never says healed while the verification Run is queued or running", () => {
    const proposal = {
      status: "approved" as const,
      failedRunId: "run_f",
      candidateRevisionId: "rev_c",
      verificationRunId: "run_v",
    };
    const queued = describeLifecycle(proposal, { runId: "run_v", outcome: null, phase: "queued" });
    expect(queued.healed).toBe(false);
    expect(queued.headline).toContain("Not healed yet");
    expect(queued.headline).not.toMatch(/healed(?! yet)/);
    expect(queued.steps.find((step) => step.key === "verification")?.state).toBe("pending");
    expect(queued.steps.find((step) => step.key === "failed-run")?.detail).toContain(
      "stays failed",
    );

    const passedButNotReconciled = describeLifecycle(proposal, {
      runId: "run_v",
      outcome: "passed",
    });
    expect(passedButNotReconciled.healed).toBe(false);

    // Positive control: only a verified proposal whose new Run passed is verified.
    const verified = describeLifecycle(
      { ...proposal, status: "verified" },
      { runId: "run_v", outcome: "passed" },
    );
    expect(verified.healed).toBe(true);
    expect(verified.headline).toContain("original Run still shows its failure");
  });

  it("UX-040 a failed verification is not promoted and a proposal without one says none exists", () => {
    const failed = describeLifecycle(
      {
        status: "proposed",
        failedRunId: "run_f",
        candidateRevisionId: "rev_c",
        verificationRunId: "run_v",
      },
      { runId: "run_v", outcome: "failed" },
    );
    expect(failed.healed).toBe(false);
    expect(failed.headline).toContain("not promoted");
    const fresh = describeLifecycle(
      {
        status: "proposed",
        failedRunId: "run_f",
        candidateRevisionId: "rev_c",
        verificationRunId: null,
      },
      null,
    );
    expect(fresh.headline).toContain("nothing has been applied");
    expect(fresh.steps.find((step) => step.key === "verification")?.state).toBe("not-started");
    const rejected = describeLifecycle(
      {
        status: "rejected",
        failedRunId: "run_f",
        candidateRevisionId: "rev_c",
        verificationRunId: null,
      },
      null,
    );
    expect(rejected.headline).toContain("rejected");
  });

  it("UX-039 a rejection needs a bounded reason", () => {
    expect(validateRejectionReason("")).toContain("Enter the reason");
    expect(validateRejectionReason("   ")).toContain("Enter the reason");
    expect(validateRejectionReason("x".repeat(8001))).toContain("under 8000");
    expect(validateRejectionReason("Selector points at the wrong button")).toBeNull();
  });

  it("UX-039 a version conflict is recoverable and says nothing was applied", () => {
    const conflict = describeMutationFailure("REVISION_CONFLICT", "accept", "stale");
    expect(conflict.kind).toBe("conflict");
    expect(conflict.message).toContain("Nothing was applied");
    expect(conflict.message).toContain("Reload");
    expect(describeMutationFailure("FORBIDDEN", "accept", "no").kind).toBe("forbidden");
    expect(
      describeMutationFailure(
        "PRECONDITION_FAILED",
        "reject",
        "Only a reviewable proposal can be rejected",
      ).message,
    ).toContain("Only a reviewable proposal can be rejected");
    expect(
      describeMutationFailure("POLICY_DENIED", "accept", "Candidate assertions changed").kind,
    ).toBe("policy");
    expect(describeMutationFailure("NETWORK", "accept", "").message).toBe(
      "The request failed. Try again.",
    );
  });
});
