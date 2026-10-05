import { ContractError, validate } from "@testmaster/contracts";
import { canonicalJson } from "@testmaster/domain";
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
export function validateNormalization(
  value: unknown,
  evidence: SourceEvidenceRef[],
): NormalizedRequirements {
  const result = validate<NormalizedRequirements>("AIRequirementsOutput", value);
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
    for (const ref of requirement.sourceRefs)
      if (!allowed.has(canonicalJson(ref)))
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Requirement references evidence outside supplied sources",
        );
  }
  for (const conflict of result.conflicts) {
    if (conflict.keys.some((key) => !keys.has(key)))
      throw new ContractError("INVALID_ARGUMENT", "Conflict references an unknown requirement");
    for (const ref of conflict.sourceRefs)
      if (!allowed.has(canonicalJson(ref)))
        throw new ContractError("INVALID_ARGUMENT", "Conflict evidence is not grounded");
    if (new Set(conflict.sourceRefs.map((ref) => ref.sourceRevisionId)).size < 2)
      throw new ContractError("INVALID_ARGUMENT", "Conflict must preserve both source revisions");
  }
  return result;
}
