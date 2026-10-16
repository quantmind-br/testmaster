import {
  assertNoNegativeBeforeRender,
  ContractError,
  type ExecutablePlan,
  observesRenderedContent,
  type PlanStep,
  validate,
} from "@testmaster/contracts";
import { canonicalJson, semanticHash } from "@testmaster/domain";
import type { EvidenceCatalog } from "../sources/evidence.js";
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
/** A requirement the model declined because no HTTP or browser plan can observe it. */
export interface UnsupportedRequirement {
  requirementId: string;
  reason: string;
}
export interface ResolvedProposals extends GeneratedProposals {
  unsupported: UnsupportedRequirement[];
}
/** Actions after which a browser plan must observe rendered content: they change what the page shows. */
const stateChangingActions: Record<string, true> = {
  navigate: true,
  click: true,
  press: true,
  select: true,
  check: true,
  uncheck: true,
  drag: true,
  upload: true,
  download: true,
};
function flatSteps(steps: readonly PlanStep[]): PlanStep[] {
  return steps.flatMap((step) =>
    step.operation === "frame" ? [step, ...flatSteps(step.input.childSteps)] : [step],
  );
}
/**
 * A browser plan that changes state (login, navigation, submit) must assert, after its last such
 * action, content the page renders. A URL check and the absence of the earlier elements also hold
 * on a blank page, so a plan made of those alone proves nothing about the rendered result.
 */
function requireBrowserPostCondition(plan: ExecutablePlan): void {
  if (plan.runner !== "playwright") return;
  const steps = flatSteps(plan.steps);
  const last = steps.findLastIndex(
    (step) => step.kind === "action" && Object.hasOwn(stateChangingActions, step.operation),
  );
  if (last < 0) return;
  const observed = steps
    .slice(last + 1)
    .some(
      (step) =>
        step.kind === "assertion" &&
        step.required !== false &&
        observesRenderedContent(step.expectation),
    );
  if (!observed)
    throw new ContractError(
      "INVALID_ARGUMENT",
      "A browser plan that ends after a state-changing action (login, navigation, click, submit) needs a required positive assertion on rendered content after its last such action: visible, textContains, textEquals, valueEquals or countEquals above 0 on a locator for content that exists only when the action worked. A URL check and the absence of earlier elements also hold on a blank page",
      { reasonCode: "browser_postcondition_missing" },
    );
}
export function validateProposalPlan(input: unknown): ExecutablePlan {
  const plan = validate<ExecutablePlan>("ExecutablePlan", input);
  if (plan.runner === "terminal")
    throw new ContractError(
      "CAPABILITY_UNAVAILABLE",
      "Terminal plans cannot be generated, edited or refined as proposals; author them as executable plans",
      { runner: "terminal" },
    );
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
  requireBrowserPostCondition(plan);
  assertNoNegativeBeforeRender(plan);
  return plan;
}
/** A proposal refused on its own merits, located by its position in the model output. */
export interface ProposalRefusal {
  index: number;
  requirementIds: string[];
  /** Stable machine-readable cause; the error carries the human message. */
  reasonCode: string;
  error: ContractError;
  /** Where the refusal applies in the model output, when the cause has locations. */
  pointers?: string[];
}
type RawProposal = Omit<GeneratedProposal, "evidenceRefs"> & { evidenceIds: string[] };
interface RawProposals {
  proposals: RawProposal[];
  unsupported?: UnsupportedRequirement[];
}
const MAX_REFUSAL_ISSUES = 5;
/** One proposal's own validation failure, its issue paths located in the whole output. */
function invalidProposal(
  index: number,
  item: unknown,
  error: ContractError,
): Pick<ProposalRefusal, "requirementIds" | "reasonCode" | "error" | "pointers"> {
  const prefix = `/proposals/${index}`;
  const pointers = error.issues.map(({ path }) =>
    path.startsWith("/proposals/0")
      ? `${prefix}${path.slice("/proposals/0".length)}`
      : `${prefix}/plan${path}`,
  );
  const listed = error.issues
    .slice(0, MAX_REFUSAL_ISSUES)
    .map(({ rule, message }) => `${rule}: ${message}`);
  const more =
    error.issues.length > listed.length ? ` (+${error.issues.length - listed.length} more)` : "";
  const summary = listed.length ? `${listed.join("; ")}${more}` : error.message;
  const refs = (item as { requirementRefs?: unknown } | null)?.requirementRefs;
  return {
    requirementIds: Array.isArray(refs)
      ? refs.filter((ref): ref is string => typeof ref === "string")
      : [],
    reasonCode: "plan_invalid",
    error: new ContractError(
      "INVALID_ARGUMENT",
      `Generated proposal is invalid: ${summary}`,
      error.details,
      error.issues,
    ),
    pointers: pointers.slice(0, MAX_REFUSAL_ISSUES),
  };
}
/**
 * Validates the model output. When it is valid as a whole, every proposal passes. Otherwise each
 * proposal is validated on its own: one that breaks the schema or the plan semantics is refused
 * with its position instead of rejecting the whole output. A failure that no single proposal
 * explains (not a `{proposals: [...]}` object, an invalid `unsupported` list, too many proposals)
 * still throws.
 */
function splitOutput(input: unknown): {
  valid: { index: number; proposal: RawProposal }[];
  refused: ProposalRefusal[];
  unsupported: UnsupportedRequirement[];
} {
  let whole: ContractError;
  try {
    const output = validate<RawProposals>("AIProposalsOutput", input);
    return {
      valid: output.proposals.map((proposal, index) => ({ index, proposal })),
      refused: [],
      unsupported: output.unsupported ?? [],
    };
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    whole = error;
  }
  const items = (input as { proposals?: unknown } | null)?.proposals;
  if (typeof input !== "object" || input === null || !Array.isArray(items)) throw whole;
  const valid: { index: number; proposal: RawProposal }[] = [];
  const refused: ProposalRefusal[] = [];
  items.forEach((item, index) => {
    try {
      const [proposal] = validate<RawProposals>("AIProposalsOutput", {
        proposals: [item],
      }).proposals;
      if (proposal) valid.push({ index, proposal });
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      refused.push({ index, ...invalidProposal(index, item, error) });
    }
  });
  if (!refused.length) throw whole;
  const envelope = validate<RawProposals>("AIProposalsOutput", { ...input, proposals: [] });
  return { valid, refused, unsupported: envelope.unsupported ?? [] };
}
export interface InspectedProposals {
  /** Proposals that passed every check, duplicates dropped, with their output position. */
  accepted: { index: number; proposal: GeneratedProposal }[];
  refused: ProposalRefusal[];
  unsupported: UnsupportedRequirement[];
}
function proposalRefusal(
  proposal: GeneratedProposal,
  allowedRequirements: Set<string>,
  allowedEvidence: Set<string>,
): { reasonCode: string; error: ContractError } | undefined {
  try {
    validateProposalPlan(proposal.plan);
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    const reasonCode = error.details.reasonCode;
    return { reasonCode: typeof reasonCode === "string" ? reasonCode : "plan_invalid", error };
  }
  if (
    proposal.requirementRefs.some((id) => !allowedRequirements.has(id)) ||
    (proposal.plan.requirementRefs ?? []).some((id) => !allowedRequirements.has(id))
  )
    return {
      reasonCode: "requirement_not_selected",
      error: new ContractError("INVALID_ARGUMENT", "Proposal references an unapproved requirement"),
    };
  if (
    !proposal.evidenceRefs.length ||
    proposal.evidenceRefs.some((ref) => !allowedEvidence.has(canonicalJson(ref)))
  )
    return {
      reasonCode: "evidence_not_grounded",
      error: new ContractError("INVALID_ARGUMENT", "Proposal evidence is not grounded"),
    };
  return undefined;
}
/**
 * Validates model proposal output and resolves evidence handles to supplied refs, collecting
 * every proposal that fails on its own instead of stopping at the first. Output-wide defects (a
 * declined requirement that is not selected, declined twice or also proposed, an empty answer)
 * still throw: no proposal can be trusted when they occur.
 */
export function inspectGeneratedProposals(
  input: unknown,
  requirementIds: string[],
  catalog: EvidenceCatalog,
): InspectedProposals {
  const split = splitOutput(input);
  const unsupported = split.unsupported;
  if (!split.valid.length && !split.refused.length && !unsupported.length)
    throw new ContractError(
      "INVALID_ARGUMENT",
      "The model returned neither proposals nor declined requirements",
    );
  const declined = new Set<string>();
  for (const { requirementId } of unsupported) {
    if (!requirementIds.includes(requirementId))
      throw new ContractError("INVALID_ARGUMENT", "A declined requirement is not a selected one", {
        requirementId,
      });
    if (declined.has(requirementId))
      throw new ContractError("INVALID_ARGUMENT", "A requirement is declined more than once", {
        requirementId,
      });
    declined.add(requirementId);
  }
  const proposed = [
    ...split.valid.flatMap(({ proposal }) => proposal.requirementRefs),
    ...split.refused.flatMap((item) => item.requirementIds),
  ];
  const both = proposed.find((id) => declined.has(id));
  if (both)
    throw new ContractError("INVALID_ARGUMENT", "A requirement is both proposed and declined", {
      requirementId: both,
    });
  const allowedRequirements = new Set(requirementIds);
  const allowedEvidence = new Set(catalog.refs.map((ref) => canonicalJson(ref)));
  const hashes = new Set<string>();
  const accepted: InspectedProposals["accepted"] = [];
  const refused: ProposalRefusal[] = [...split.refused];
  split.valid.forEach(({ index, proposal: { evidenceIds, ...rest } }) => {
    const requirementRefs = rest.requirementRefs;
    let evidenceRefs: SourceEvidenceRef[];
    try {
      evidenceRefs = catalog.resolve(evidenceIds, "Proposal evidence is not grounded");
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      refused.push({
        index,
        requirementIds: requirementRefs,
        reasonCode: "evidence_not_grounded",
        error,
      });
      return;
    }
    const proposal: GeneratedProposal = { ...rest, evidenceRefs };
    const refusal = proposalRefusal(proposal, allowedRequirements, allowedEvidence);
    if (refusal) {
      refused.push({ index, requirementIds: requirementRefs, ...refusal });
      return;
    }
    const hash = semanticHash(proposal.plan, "plan");
    if (hashes.has(hash)) return;
    hashes.add(hash);
    accepted.push({ index, proposal });
  });
  refused.sort((a, b) => a.index - b.index);
  return { accepted, refused, unsupported };
}
/**
 * Validates model proposal output and resolves evidence handles to supplied refs. A declined
 * requirement must be a selected one, be declined once and not also be proposed. The first
 * proposal that fails rejects the output.
 */
export function resolveGeneratedProposals(
  input: unknown,
  requirementIds: string[],
  catalog: EvidenceCatalog,
): ResolvedProposals {
  const inspected = inspectGeneratedProposals(input, requirementIds, catalog);
  const [first] = inspected.refused;
  if (first) throw first.error;
  return {
    proposals: inspected.accepted.map(({ proposal }) => proposal),
    unsupported: inspected.unsupported,
  };
}
/** Semantic checks over resolved proposals; duplicate plans are dropped. */
export function validateGeneratedProposals(
  result: GeneratedProposals,
  requirementIds: string[],
  evidence: SourceEvidenceRef[],
): GeneratedProposals {
  const allowedRequirements = new Set(requirementIds);
  const allowedEvidence = new Set(evidence.map((ref) => canonicalJson(ref)));
  const hashes = new Set<string>();
  const proposals = result.proposals.filter((proposal) => {
    const refusal = proposalRefusal(proposal, allowedRequirements, allowedEvidence);
    if (refusal) throw refusal.error;
    const hash = semanticHash(proposal.plan, "plan");
    if (hashes.has(hash)) return false;
    hashes.add(hash);
    return true;
  });
  return { proposals };
}
