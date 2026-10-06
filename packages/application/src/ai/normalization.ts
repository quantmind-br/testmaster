import { canonicalJson, semanticHash } from "@testmaster/domain";
import {
  EvidenceCatalog,
  type NormalizedRequirements,
  resolveConflictOutput,
  resolveNormalizationOutput,
  type SourceChunk,
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
  const chunks = sources.flatMap((source) => source.chunks);
  const catalog = new EvidenceCatalog(chunks.map((chunk) => chunk.evidenceRef));
  const evidence = catalog.refs;
  // Models see opaque handles, never hashes/locators they could alter while copying.
  const cited = (chunk: SourceChunk) => ({
    evidenceId: catalog.handle(chunk.evidenceRef),
    sourceRevisionId: chunk.evidenceRef.sourceRevisionId,
    ...(chunk.evidenceRef.relativePath ? { relativePath: chunk.evidenceRef.relativePath } : {}),
    kind: chunk.kind,
    ...(chunk.lineStart !== undefined ? { lineStart: chunk.lineStart } : {}),
    ...(chunk.lineEnd !== undefined ? { lineEnd: chunk.lineEnd } : {}),
    text: chunk.text,
  });
  const citedRequirements = (requirements: NormalizedRequirements["requirements"]) =>
    requirements.map(({ sourceRefs, ...requirement }) => ({
      ...requirement,
      evidenceIds: catalog.handles(sourceRefs),
    }));
  const batches: SourceChunk[][] = [];
  let current: SourceChunk[] = [];
  let bytes = 0;
  for (const chunk of chunks) {
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
  for (const [index, batch] of batches.entries()) {
    const result = await model.complete<unknown>({
      ...input,
      purpose: "normalize",
      responseSchema: "AIRequirementsOutput",
      inputRefs: batch.map((chunk) => chunk.id),
      data: {
        chunks: batch.map(cited),
        priorRequirements: citedRequirements(merged.requirements),
        batchKeyPrefix: `batch-${index + 1}-`,
      },
      instructions:
        "Extract concise explicit product requirements and acceptance criteria from the current chunks only, not titles, headings, administrative commands or review instructions. Emit one requirement per distinct requirement statement in the source; never split one requirement into several or merge independent ones. At most 12 requirements. Each text/reason/criterion must be concise (under 200 characters). Cite evidence only by the evidenceId values of the chunks that state it (for example E3); never invent evidenceIds, never repeat source text or schemas. Requirement keys must start with batchKeyPrefix. Prior requirements are context only: do not re-emit them. A conflict MUST cite evidenceIds from at least two DIFFERENT sourceRevisionId values. If only one source revision is available, return conflicts: [] and record ambiguity in openQuestions instead. Mentioning another document inside a chunk does not provide evidence for that other revision. Preserve contradictory current/prior statements as separate requirements and conflicts referencing both existing and new keys with their actual evidenceIds from different revisions. Never approve anything. Inference requires confidence and reason. Return complete JSON without commentary.",
    });
    callIds.push(result.modelCallId);
    const output = resolveNormalizationOutput(result.output, catalog);
    // Semantic validation includes prior keys used in conflicts.
    const combined = validateNormalization(
      {
        requirements: [...merged.requirements, ...output.requirements],
        conflicts: [...merged.conflicts, ...output.conflicts],
        openQuestions: [...new Set([...merged.openQuestions, ...output.openQuestions])],
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
    const reconciliation = await model.complete<unknown>({
      ...input,
      purpose: "normalize",
      responseSchema: "AIRequirementConflictsOutput",
      inputRefs: merged.requirements.map((requirement) => requirement.key),
      data: {
        requirements: citedRequirements(merged.requirements),
        sourceChunks: chunks.map(cited),
      },
      instructions:
        "Compare the normalized statements AND original source chunks from different source revisions for incompatible acceptance criteria. Inspect every concrete status code, error condition, field name, authorization rule, and numeric constraint for the same operation/condition across sources. A source mentioning a deliberate conflict is not a resolution; preserve the disagreement. Link disagreements to the existing requirement keys that cover each side and cite the evidenceId values of the chunks stating each side, from at least two different sourceRevisionId values; never invent evidenceIds. Do not invent, rewrite or discard requirements. Disagreement remains unresolved for human adjudication. Return concise reasons and complete JSON. If extraction omitted either conflicting statement, describe the omitted statement and its evidenceId in openQuestions; do not claim no conflict.",
    });
    callIds.push(reconciliation.modelCallId);
    const output = resolveConflictOutput(reconciliation.output, catalog);
    merged.conflicts = [
      ...new Map(
        [...merged.conflicts, ...output.conflicts].map((conflict) => [
          canonicalJson([...conflict.keys].sort()),
          conflict,
        ]),
      ).values(),
    ];
    merged.openQuestions = [...new Set([...merged.openQuestions, ...output.openQuestions])];
  }
  return { normalized: validateNormalization(merged, evidence), modelCallIds: callIds };
}
