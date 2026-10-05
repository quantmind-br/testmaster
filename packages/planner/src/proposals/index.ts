import { ContractError, type ExecutablePlan, validate } from "@testmaster/contracts";
import { canonicalJson, semanticHash } from "@testmaster/domain";
import type { SourceEvidenceRef } from "../sources/types.js";
export interface GeneratedProposal {
  plan: ExecutablePlan;
  requirementRefs: string[];
  evidenceRefs: SourceEvidenceRef[];
  warnings: string[];
}
export interface GeneratedProposals {
  proposals: GeneratedProposal[];
}
export function validateProposalPlan(input: unknown): ExecutablePlan {
  const plan = validate<ExecutablePlan>("ExecutablePlan", input);
  const assertions = plan.steps.filter(
    (step) => step.kind === "assertion" && step.required !== false,
  );
  if (!assertions.length)
    throw new ContractError("INVALID_ARGUMENT", "A proposal requires a business assertion");
  const meaningful = assertions.some((step) => {
    if (step.kind !== "assertion") return false;
    const expectation = step.expectation;
    if (!expectation) return false;
    if (expectation.predicate === "statusIn" && expectation.values.length > 10) return false;
    if (
      expectation.predicate === "textContains" &&
      "literal" in expectation.value &&
      expectation.value.literal === ""
    )
      return false;
    if (/"(?:selector|value)":"(?:body|html|\*)"/.test(canonicalJson(step))) return false;
    return true;
  });
  if (!meaningful)
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Trivial assertions cannot establish requirement coverage",
    );
  return plan;
}
export function validateGeneratedProposals(
  input: unknown,
  requirementIds: string[],
  evidence: SourceEvidenceRef[],
): GeneratedProposals {
  const result = validate<GeneratedProposals>("AIProposalsOutput", input);
  const allowedRequirements = new Set(requirementIds);
  const allowedEvidence = new Set(evidence.map((ref) => canonicalJson(ref)));
  const hashes = new Set<string>();
  const proposals = result.proposals.filter((proposal) => {
    validateProposalPlan(proposal.plan);
    if (
      proposal.requirementRefs.some((id) => !allowedRequirements.has(id)) ||
      (proposal.plan.requirementRefs ?? []).some((id) => !allowedRequirements.has(id))
    )
      throw new ContractError("INVALID_ARGUMENT", "Proposal references an unapproved requirement");
    if (proposal.evidenceRefs.some((ref) => !allowedEvidence.has(canonicalJson(ref))))
      throw new ContractError("INVALID_ARGUMENT", "Proposal evidence is not grounded");
    const hash = semanticHash(proposal.plan, "plan");
    if (hashes.has(hash)) return false;
    hashes.add(hash);
    return true;
  });
  return { proposals };
}
