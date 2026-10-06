import { canonicalJson, semanticHash } from "@testmaster/domain";
import {
  type NormalizedRequirements,
  type SourceParseResult,
  validateNormalization,
} from "@testmaster/planner";
import type { ModelInput, ModelService } from "./model.js";

/** Bounded extraction, with prior statements available for cross-source conflict detection. */
export async function normalizeSources(
  model: ModelService,
  input: Omit<ModelInput, "purpose" | "responseSchema" | "data">,
  sources: SourceParseResult[],
) {
  const evidence = sources.flatMap((source) => source.chunks.map((chunk) => chunk.evidenceRef));
  const batches: SourceParseResult["chunks"][] = [];
  let current: SourceParseResult["chunks"] = [];
  let bytes = 0;
  for (const chunk of sources.flatMap((source) => source.chunks)) {
    const size = Buffer.byteLength(canonicalJson(chunk));
    if (current.length && (bytes + size > 6000 || current.length >= 6)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(chunk);
    bytes += size;
  }
  if (current.length) batches.push(current);
  const merged: NormalizedRequirements = { requirements: [], conflicts: [], openQuestions: [] };
  const callIds: string[] = [];
  for (const [index, chunks] of batches.entries()) {
    const result = await model.complete<NormalizedRequirements>({
      ...input,
      purpose: "normalize",
      responseSchema: "AIRequirementsOutput",
      inputRefs: chunks.map((chunk) => chunk.id),
      data: {
        chunks,
        priorRequirements: merged.requirements,
        batchKeyPrefix: `batch-${index + 1}-`,
      },
      instructions:
        "Extract concise explicit product requirements and acceptance criteria from the current chunks only, not administrative commands or review instructions. At most 12 requirements; combine related criteria instead of repeating requirements. Each text/reason/criterion must be concise (under 200 characters). Use supplied evidence refs exactly, never repeat source text or schemas. Requirement keys must start with batchKeyPrefix. Prior requirements are context only: do not re-emit them. A conflict MUST reference at least two DIFFERENT sourceRevisionId values. If only one source revision is available, return conflicts: [] and record ambiguity in openQuestions instead. Mentioning another document inside a chunk does not provide evidence for that other revision. Preserve contradictory current/prior statements as separate requirements and conflicts referencing both existing and new keys with their actual evidence refs from different revisions. Never approve anything. Inference requires confidence and reason. Return complete JSON without commentary.",
    });
    callIds.push(result.modelCallId);
    // The schema validates the response; semantic validation includes prior keys used in conflicts.
    const combined = validateNormalization(
      {
        requirements: [...merged.requirements, ...result.output.requirements],
        conflicts: [...merged.conflicts, ...result.output.conflicts],
        openQuestions: [...new Set([...merged.openQuestions, ...result.output.openQuestions])],
      },
      evidence,
    );
    Object.assign(merged, combined);
  }
  // Exact duplicates are merged without collapsing contradictory statements or dropping citations.
  const aliases = new Map<string, string>();
  const byText = new Map<string, NormalizedRequirements["requirements"][number]>();
  for (const requirement of merged.requirements) {
    const signature = semanticHash({
      text: requirement.text,
      acceptanceCriteria: requirement.acceptanceCriteria,
      originKind: requirement.originKind,
    });
    const prior = byText.get(signature);
    if (!prior) byText.set(signature, requirement);
    else {
      aliases.set(requirement.key, prior.key);
      prior.sourceRefs = [
        ...new Map(
          [...prior.sourceRefs, ...requirement.sourceRefs].map((ref) => [canonicalJson(ref), ref]),
        ).values(),
      ];
    }
  }
  merged.requirements = [...byText.values()];
  merged.conflicts = merged.conflicts
    .map((conflict) => ({
      ...conflict,
      keys: [...new Set(conflict.keys.map((key) => aliases.get(key) ?? key))],
    }))
    .filter((conflict) => conflict.keys.length >= 2);
  if (sources.length > 1) {
    const reconciliation = await model.complete<
      Pick<NormalizedRequirements, "conflicts" | "openQuestions">
    >({
      ...input,
      purpose: "normalize",
      responseSchema: "AIRequirementConflictsOutput",
      inputRefs: merged.requirements.map((requirement) => requirement.key),
      data: {
        requirements: merged.requirements,
        sourceChunks: sources.flatMap((source) =>
          source.chunks.map((chunk) => ({ text: chunk.text, evidenceRef: chunk.evidenceRef })),
        ),
      },
      instructions:
        "Compare the normalized statements AND original source chunks from different source revisions for incompatible acceptance criteria. Inspect every concrete status code, error condition, field name, authorization rule, and numeric constraint for the same operation/condition across sources. A source mentioning a deliberate conflict is not a resolution; preserve the disagreement. Link disagreements to the existing requirement keys that cover each side and their exact sourceRefs from at least two different sourceRevisionId values. Do not invent, rewrite or discard requirements. Disagreement remains unresolved for human adjudication. Return concise reasons and complete JSON. If extraction omitted either conflicting statement, describe the omitted statement and exact evidence location in openQuestions; do not claim no conflict.",
    });
    callIds.push(reconciliation.modelCallId);
    merged.conflicts = [
      ...new Map(
        [...merged.conflicts, ...reconciliation.output.conflicts].map((conflict) => [
          canonicalJson([...conflict.keys].sort()),
          conflict,
        ]),
      ).values(),
    ];
    merged.openQuestions = [
      ...new Set([...merged.openQuestions, ...reconciliation.output.openQuestions]),
    ];
  }
  return { normalized: validateNormalization(merged, evidence), modelCallIds: callIds };
}
