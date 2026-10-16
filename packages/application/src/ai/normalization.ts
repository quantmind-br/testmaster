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

export interface NormalizeProgress {
  completed: number;
  total: number;
  message: string;
}

const MAX_BATCH_BYTES = 6000;
const MAX_BATCH_CHUNKS = 6;
/** Markdown block kinds: a heading opens a section that the blocks after it complete. */
const MARKDOWN_KINDS: Record<string, true> = {
  heading: true,
  paragraph: true,
  listItem: true,
  table: true,
  code: true,
};

/**
 * Chunks that must reach the model together: a Markdown heading with the paragraphs, list items
 * and tables up to the next heading of the same revision, a heading that has no content of its
 * own (a group title) staying with the heading under it. Cut apart, the acceptance criteria of
 * a requirement reach the model without the statement they belong to, and each one comes back as
 * a requirement of its own. Any other chunk (an OpenAPI operation, a PDF page, a text line)
 * stands alone.
 */
function sectionsOf(chunks: SourceChunk[]): SourceChunk[][] {
  const sections: SourceChunk[][] = [];
  for (const chunk of chunks) {
    const open = sections.at(-1);
    const first = open?.[0];
    if (
      open &&
      first &&
      MARKDOWN_KINDS[chunk.kind] &&
      MARKDOWN_KINDS[first.kind] &&
      first.evidenceRef.sourceRevisionId === chunk.evidenceRef.sourceRevisionId &&
      (chunk.kind !== "heading" || open.every((member) => member.kind === "heading"))
    )
      open.push(chunk);
    else sections.push([chunk]);
  }
  return sections;
}

/**
 * Model batches of at most MAX_BATCH_BYTES and MAX_BATCH_CHUNKS, cut between sections. A section
 * that alone exceeds MAX_BATCH_BYTES is the only case split inside, at the byte limit.
 */
export function batchChunks(chunks: SourceChunk[]): SourceChunk[][] {
  const batches: SourceChunk[][] = [];
  let current: SourceChunk[] = [];
  let bytes = 0;
  const flush = () => {
    if (current.length) batches.push(current);
    current = [];
    bytes = 0;
  };
  for (const section of sectionsOf(chunks)) {
    const sizes = section.map((chunk) => Buffer.byteLength(canonicalJson(chunk)));
    const total = sizes.reduce((sum, size) => sum + size, 0);
    if (total > MAX_BATCH_BYTES) {
      flush();
      for (const [index, chunk] of section.entries()) {
        if (current.length && bytes + (sizes[index] ?? 0) > MAX_BATCH_BYTES) flush();
        current.push(chunk);
        bytes += sizes[index] ?? 0;
      }
      flush();
      continue;
    }
    const full =
      bytes + total > MAX_BATCH_BYTES || current.length + section.length > MAX_BATCH_CHUNKS;
    if (current.length && full) flush();
    current.push(...section);
    bytes += total;
  }
  flush();
  return batches;
}

/** Bounded extraction, with prior statements available for cross-source conflict detection. */
export async function normalizeSources(
  model: ModelService,
  input: Omit<ModelInput, "purpose" | "responseSchema" | "data">,
  sources: SourceParseResult[],
  /** Synchronous; a throwing callback aborts normalization. */
  onProgress?: (progress: NormalizeProgress) => void,
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
  /** The cross-source reconciliation request for the requirements extracted so far. */
  const reconciliationRequest = (
    requirements: NormalizedRequirements["requirements"],
  ): ModelInput => ({
    ...input,
    purpose: "normalize",
    responseSchema: "AIRequirementConflictsOutput",
    inputRefs: requirements.map((requirement) => requirement.key),
    data: {
      requirements: citedRequirements(requirements),
      sourceChunks: chunks.map(cited),
    },
    instructions:
      "Compare the normalized statements AND original source chunks from different source revisions for incompatible acceptance criteria. Inspect every concrete status code, error condition, field name, authorization rule, and numeric constraint for the same operation/condition across sources. A source mentioning a deliberate conflict is not a resolution; preserve the disagreement. Link disagreements to the existing requirement keys that cover each side and cite the evidenceId values of the chunks stating each side, from at least two different sourceRevisionId values; never invent evidenceIds. Do not invent, rewrite or discard requirements. Disagreement remains unresolved for human adjudication. Return concise reasons and complete JSON. If extraction omitted either conflicting statement, describe the omitted statement and its evidenceId in openQuestions; do not claim no conflict.",
  });
  const batches = batchChunks(chunks);
  // The reconciliation sends every source chunk. Refuse before the first paid batch when those
  // chunks alone cannot fit the model's declared context (the extracted requirements, unknown
  // until the batches ran, only add to it).
  if (sources.length > 1) model.assertFitsContext(reconciliationRequest([]));
  // One unit per model batch plus one for cross-source reconciliation.
  const total = batches.length + (sources.length > 1 ? 1 : 0);
  onProgress?.({ completed: 0, total, message: `Normalizing ${batches.length} source batch(es)` });
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
        "Extract concise explicit product requirements and acceptance criteria from the current chunks only, not titles, headings, administrative commands or review instructions. A requirement describes observable behavior of the product under test. Statements about how the tests themselves are written, run, configured or given credentials (test tooling, secrets handling, environments, the verification scope itself) are not requirements: omit them, and record one in openQuestions only when it is an ambiguous statement about the product. Emit one requirement per requirement the source states: a stated behavior together with ALL of its acceptance criteria. When the source lays requirements out as sections (a heading chunk naming a requirement or carrying a REQ-style id, then its statement and its acceptance criteria as paragraph and listItem chunks), every such section is exactly ONE requirement: text is the statement, and each criterion listed under it (a listItem, a checklist or an 'Acceptance criteria' line) is one entry of that requirement's acceptanceCriteria, never a requirement of its own. Never emit both a summary requirement and separate requirements for the criteria of the same section, and never restate one behavior in several requirements. Split a section only when the source itself states distinct behaviors with their own acceptance criteria; merge nothing the source states separately. At most 12 requirements. Each text/reason/criterion must be concise (under 200 characters). Cite evidence only by the evidenceId values of the chunks that state it (for example E3); never invent evidenceIds, never repeat source text or schemas. Requirement keys must start with batchKeyPrefix. Prior requirements are context only: do not re-emit them. A conflict MUST cite evidenceIds from at least two DIFFERENT sourceRevisionId values. If only one source revision is available, return conflicts: [] and record ambiguity in openQuestions instead. Mentioning another document inside a chunk does not provide evidence for that other revision. Preserve contradictory current/prior statements as separate requirements and conflicts referencing both existing and new keys with their actual evidenceIds from different revisions. Never approve anything. Inference requires confidence and reason. Return complete JSON without commentary.",
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
    onProgress?.({
      completed: index + 1,
      total,
      message: `Normalized batch ${index + 1} of ${batches.length}`,
    });
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
    const reconciliation = await model.complete<unknown>(
      reconciliationRequest(merged.requirements),
    );
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
    onProgress?.({ completed: total, total, message: "Reconciled conflicts across sources" });
  }
  return { normalized: validateNormalization(merged, evidence), modelCallIds: callIds };
}
