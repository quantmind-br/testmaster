import type { Proposal, ProposalBatch, Requirement } from "@testmaster/contracts";
import { canonicalJson, semanticHash } from "@testmaster/domain";
import type { EntityDocument } from "@testmaster/persistence";
import { allEntities, type ServiceContext } from "../context.js";
import { appendRequirementLog, type RequirementLogInput } from "./requirement-log.js";
import { requirementKey, storedRequirementSnapshot } from "./requirements.js";

/** The receipt lists at most this many requirements and batches; `count` fields hold the totals. */
export const MAX_REPORTED_RESETS = 50;

/**
 * A requirement whose cited evidence changed: its version moved and its approval, if any, was
 * cleared. `approvalCleared` is false for a requirement that was not approved.
 */
// Type aliases, not interfaces, so the report is assignable to JSON-valued receipts.
export type RequirementReset = {
  requirementId: string;
  requirementKey: string | null;
  reason: "cited_evidence_changed";
  /** The source revision whose content no longer holds what the requirement cited. */
  sourceRevisionId: string;
  approvalCleared: boolean;
};
export type RequirementResetReport = {
  count: number;
  requirements: RequirementReset[];
  staleProposalBatchCount: number;
  staleProposalBatchIds: string[];
};
/**
 * A new revision of a source. A requirement cites chunks of earlier revisions (by revision id and
 * chunk content hash); it is affected only when a cited chunk is absent from the new revision.
 */
export interface SourceRevisionChange {
  revisionId: string;
  /** Every earlier revision of the same source. */
  replacedRevisionIds: ReadonlySet<string>;
  /** Content hash of every chunk of the new revision. */
  chunkHashes: ReadonlySet<string>;
}

function citesChangedEvidence(requirement: Requirement, change: SourceRevisionChange): boolean {
  return requirement.sourceRefs.some(
    (ref) =>
      ref.sourceRevisionId !== undefined &&
      change.replacedRevisionIds.has(ref.sourceRevisionId) &&
      (ref.contentHash === undefined || !change.chunkHashes.has(ref.contentHash)),
  );
}
function citedRequirementIds(proposal: Proposal): string[] {
  return [
    ...proposal.requirementRefs,
    ...(proposal.plan.kind === "executable" ? proposal.plan.requirementRefs : []),
  ];
}

/**
 * Supersedes the authoring descendants of one source revision, never immutable revisions or
 * admitted Runs. Only requirements that cite evidence the new revision no longer holds are reset:
 * they lose their approval and take a new version. Every other requirement keeps its version and
 * approval. The snapshot version and fingerprint move, and a proposed batch becomes stale, only
 * when something was reset; a batch goes stale when one of its still-proposed proposals cites a
 * reset requirement. Returns null when nothing was reset.
 *
 * Code analysis never calls this: a requirement cites source revisions only (the normalizer
 * offers nothing else), so a change in the code snapshot, the detector, the runtime, the prompt
 * or the requested model cannot change what any requirement cites.
 */
export function resetRequirementsForSourceRevision(
  ctx: ServiceContext,
  projectId: string,
  change: SourceRevisionChange,
): RequirementResetReport | null {
  const snapshot = storedRequirementSnapshot(ctx, projectId);
  if (!snapshot) return null;
  const reason = `source:${change.revisionId}`;
  const resets: RequirementReset[] = [];
  const log: RequirementLogInput[] = [];
  for (const requirement of snapshot.requirements) {
    if (!citesChangedEvidence(requirement, change)) continue;
    const current = ctx.entities.get("Requirement", ctx.workspaceId, requirement.id);
    if (!current) continue;
    const next = { ...current, approval: null, version: Number(current.version) + 1 };
    ctx.entities.update("Requirement", ctx.workspaceId, current.id, Number(current.version), next, {
      projectId,
    });
    const approvalCleared = Boolean(requirement.approval);
    const key = requirementKey(current as unknown as Requirement);
    resets.push({
      requirementId: requirement.id,
      requirementKey: key === requirement.id ? null : key,
      reason: "cited_evidence_changed",
      sourceRevisionId: change.revisionId,
      approvalCleared,
    });
    if (approvalCleared)
      log.push({
        kind: "approval_reset",
        requirementId: requirement.id,
        requirementKey: key === requirement.id ? null : key,
        note: reason,
      });
    requirement.approval = null;
    requirement.version = next.version;
  }
  if (!resets.length) return null;
  appendRequirementLog(ctx, projectId, log);
  snapshot.version++;
  snapshot.fingerprint = semanticHash({
    previous: snapshot.fingerprint,
    reason,
    version: snapshot.version,
  });
  ctx.database.run(
    "UPDATE operational_state SET value=? WHERE key=?",
    canonicalJson(snapshot),
    `requirements:${ctx.workspaceId}:${projectId}`,
  );
  const resetIds = new Set(resets.map((item) => item.requirementId));
  const proposals = allEntities(ctx, "Proposal") as Proposal[];
  const staleBatchIds: string[] = [];
  for (const batch of allEntities(ctx, "ProposalBatch") as (ProposalBatch & EntityDocument)[]) {
    if (batch.projectId !== projectId || batch.state !== "proposed") continue;
    const citesReset = proposals.some(
      (proposal) =>
        proposal.batchId === batch.id &&
        proposal.state === "proposed" &&
        citedRequirementIds(proposal).some((id) => resetIds.has(id)),
    );
    if (!citesReset) continue;
    ctx.entities.update("ProposalBatch", ctx.workspaceId, batch.id, Number(batch.version), {
      ...batch,
      state: "stale",
      extensions: {
        ...((batch.extensions as Record<string, unknown>) ?? {}),
        "testmaster:invalidatedBy": reason,
      },
    });
    staleBatchIds.push(batch.id);
  }
  return {
    count: resets.length,
    requirements: resets.slice(0, MAX_REPORTED_RESETS),
    staleProposalBatchCount: staleBatchIds.length,
    staleProposalBatchIds: staleBatchIds.slice(0, MAX_REPORTED_RESETS),
  };
}
