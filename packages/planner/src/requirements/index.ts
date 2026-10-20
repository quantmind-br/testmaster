import { ContractError, type ValidationIssue, validate } from "@testmaster/contracts";
import { canonicalJson } from "@testmaster/domain";
import type { EvidenceCatalog } from "../sources/evidence.js";
import type { SourceEvidenceRef } from "../sources/types.js";

export interface NormalizedRequirement {
  key: string;
  text: string;
  acceptanceCriteria: string[];
  sourceRefs: SourceEvidenceRef[];
  originKind: "explicit" | "user_spec" | "inferred" | "observed";
  confidence: number | null;
  reason: string;
}
export interface RequirementConflict {
  keys: string[];
  reason: string;
  sourceRefs: SourceEvidenceRef[];
}
export interface NormalizedRequirements {
  requirements: NormalizedRequirement[];
  conflicts: RequirementConflict[];
  openQuestions: string[];
}
type Cited<T> = Omit<T, "sourceRefs"> & { evidenceIds: string[] };
const ungroundedRequirement = "Requirement references evidence outside supplied sources";
const ungroundedConflict = "Conflict evidence is not grounded";

/**
 * Resolves handles at `path`; unknown handles add their issues instead of stopping the walk. Only
 * the catalog's grounding refusal, which always carries its issues, is collected.
 */
function resolveCollecting(
  catalog: EvidenceCatalog,
  handles: string[],
  message: string,
  path: string,
  issues: ValidationIssue[],
): SourceEvidenceRef[] {
  try {
    return catalog.resolve(handles, message, path);
  } catch (error) {
    if (!(error instanceof ContractError) || !error.issues.length) throw error;
    issues.push(...error.issues);
    return [];
  }
}
function refuseCollected(issues: ValidationIssue[]): ContractError {
  return new ContractError("INVALID_ARGUMENT", issues[0]?.message ?? "", {}, issues);
}
function resolveConflicts(
  conflicts: Cited<RequirementConflict>[],
  catalog: EvidenceCatalog,
  issues: ValidationIssue[],
): RequirementConflict[] {
  return conflicts.map(({ evidenceIds, ...conflict }, index) => ({
    ...conflict,
    sourceRefs: resolveCollecting(
      catalog,
      evidenceIds,
      ungroundedConflict,
      `/conflicts/${index}/evidenceIds`,
      issues,
    ),
  }));
}
/** Validates model extraction output and resolves its evidence handles to supplied refs. */
export function resolveNormalizationOutput(
  value: unknown,
  catalog: EvidenceCatalog,
): NormalizedRequirements {
  const output = validate<{
    requirements: Cited<NormalizedRequirement>[];
    conflicts: Cited<RequirementConflict>[];
    openQuestions: string[];
  }>("AIRequirementsOutput", value);
  const issues: ValidationIssue[] = [];
  const requirements = output.requirements.map(({ evidenceIds, ...requirement }, index) => ({
    ...requirement,
    sourceRefs: resolveCollecting(
      catalog,
      evidenceIds,
      ungroundedRequirement,
      `/requirements/${index}/evidenceIds`,
      issues,
    ),
  }));
  const conflicts = resolveConflicts(output.conflicts, catalog, issues);
  if (issues.length) throw refuseCollected(issues);
  return { requirements, conflicts, openQuestions: output.openQuestions };
}
/** Validates model reconciliation output and resolves its evidence handles to supplied refs. */
export function resolveConflictOutput(
  value: unknown,
  catalog: EvidenceCatalog,
): Pick<NormalizedRequirements, "conflicts" | "openQuestions"> {
  const output = validate<{
    conflicts: Cited<RequirementConflict>[];
    openQuestions: string[];
  }>("AIRequirementConflictsOutput", value);
  const issues: ValidationIssue[] = [];
  const conflicts = resolveConflicts(output.conflicts, catalog, issues);
  if (issues.length) throw refuseCollected(issues);
  return { conflicts, openQuestions: output.openQuestions };
}
/** Semantic checks over resolved requirements; every ref must be supplied evidence. */
export function validateNormalization(
  result: NormalizedRequirements,
  evidence: SourceEvidenceRef[],
): NormalizedRequirements {
  const allowed = new Set(evidence.map((ref) => canonicalJson(ref)));
  const keys = new Set<string>();
  const issues: ValidationIssue[] = [];
  for (const [index, requirement] of result.requirements.entries()) {
    if (keys.has(requirement.key))
      issues.push({
        path: `/requirements/${index}/key`,
        rule: "requirementKey",
        message: "Duplicate normalized requirement key",
      });
    keys.add(requirement.key);
    if (
      requirement.originKind === "inferred" &&
      (requirement.confidence === null || !requirement.reason.trim())
    )
      issues.push({
        path: `/requirements/${index}`,
        rule: "inferenceBasis",
        message: "Inference requires confidence and reason",
      });
    if (
      !requirement.sourceRefs.length ||
      requirement.sourceRefs.some((ref) => !allowed.has(canonicalJson(ref)))
    )
      issues.push({
        path: `/requirements/${index}/evidenceIds`,
        rule: "evidenceGrounding",
        message: ungroundedRequirement,
      });
  }
  for (const [index, conflict] of result.conflicts.entries()) {
    if (conflict.keys.some((key) => !keys.has(key)))
      issues.push({
        path: `/conflicts/${index}/keys`,
        rule: "conflictKeys",
        message: "Conflict references an unknown requirement",
      });
    if (conflict.sourceRefs.some((ref) => !allowed.has(canonicalJson(ref))))
      issues.push({
        path: `/conflicts/${index}/evidenceIds`,
        rule: "evidenceGrounding",
        message: ungroundedConflict,
      });
    if (new Set(conflict.sourceRefs.map((ref) => ref.sourceRevisionId)).size < 2)
      issues.push({
        path: `/conflicts/${index}/evidenceIds`,
        rule: "conflictRevisions",
        message: "Conflict must preserve both source revisions",
      });
  }
  if (issues.length) throw refuseCollected(issues);
  return result;
}
