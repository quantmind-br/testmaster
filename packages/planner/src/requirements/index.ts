import { ContractError, validate } from "@testmaster/contracts";
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

function resolveConflicts(
  conflicts: Cited<RequirementConflict>[],
  catalog: EvidenceCatalog,
): RequirementConflict[] {
  return conflicts.map(({ evidenceIds, ...conflict }) => ({
    ...conflict,
    sourceRefs: catalog.resolve(evidenceIds, ungroundedConflict),
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
  return {
    requirements: output.requirements.map(({ evidenceIds, ...requirement }) => ({
      ...requirement,
      sourceRefs: catalog.resolve(evidenceIds, ungroundedRequirement),
    })),
    conflicts: resolveConflicts(output.conflicts, catalog),
    openQuestions: output.openQuestions,
  };
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
  return {
    conflicts: resolveConflicts(output.conflicts, catalog),
    openQuestions: output.openQuestions,
  };
}
/** Semantic checks over resolved requirements; every ref must be supplied evidence. */
export function validateNormalization(
  result: NormalizedRequirements,
  evidence: SourceEvidenceRef[],
): NormalizedRequirements {
  const allowed = new Set(evidence.map((ref) => canonicalJson(ref)));
  const keys = new Set<string>();
  for (const requirement of result.requirements) {
    if (keys.has(requirement.key))
      throw new ContractError("INVALID_ARGUMENT", "Duplicate normalized requirement key");
    keys.add(requirement.key);
    if (
      requirement.originKind === "inferred" &&
      (requirement.confidence === null || !requirement.reason.trim())
    )
      throw new ContractError("INVALID_ARGUMENT", "Inference requires confidence and reason");
    if (
      !requirement.sourceRefs.length ||
      requirement.sourceRefs.some((ref) => !allowed.has(canonicalJson(ref)))
    )
      throw new ContractError("INVALID_ARGUMENT", ungroundedRequirement);
  }
  for (const conflict of result.conflicts) {
    if (conflict.keys.some((key) => !keys.has(key)))
      throw new ContractError("INVALID_ARGUMENT", "Conflict references an unknown requirement");
    for (const ref of conflict.sourceRefs)
      if (!allowed.has(canonicalJson(ref)))
        throw new ContractError("INVALID_ARGUMENT", ungroundedConflict);
    if (new Set(conflict.sourceRefs.map((ref) => ref.sourceRevisionId)).size < 2)
      throw new ContractError("INVALID_ARGUMENT", "Conflict must preserve both source revisions");
  }
  return result;
}
