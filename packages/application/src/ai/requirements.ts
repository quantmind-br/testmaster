import { ContractError, type Requirement, type RequirementReview } from "@testmaster/contracts";
import { canonicalJson, semanticHash } from "@testmaster/domain";
import { AuditRepository, type EntityDocument } from "@testmaster/persistence";
import type { SourceEvidenceRef } from "@testmaster/planner";
import { authoringTransaction, decisionReason } from "../authoring.js";
import { allEntities, entity, requireEntity, type ServiceContext } from "../context.js";
import type { ModelService } from "./model.js";
import { type NormalizeProgress, normalizeSources } from "./normalization.js";
import {
  appendRequirementLog,
  describeRequirement,
  type RequirementLogInput,
  readRequirementLog,
  revisionIdsOf,
} from "./requirement-log.js";
import type { RevisionLocation, SourcesService } from "./sources.js";

const MAX_ORIGINS = 50;
const MAX_EXCERPT = 600;
const MAX_CHANGES = 100;

export interface Conflict {
  id: string;
  requirementIds: string[];
  reason: string;
  sourceRefs: SourceEvidenceRef[];
  resolution: { selectedRequirementId: string; reason: string; actorId: string } | null;
}
export interface RequirementSnapshot {
  requirements: Requirement[];
  conflicts: Conflict[];
  openQuestions: string[];
  version: number;
  fingerprint: string;
}
type StoredRequirement = Requirement & EntityDocument;
/** A reviewer's final decision that a requirement is out of scope (kept in the entity extensions). */
export interface RequirementRejection {
  reason: string;
  actorId: string;
  rejectedAt: string;
}
const REJECTION_EXTENSION = "testmaster:rejection";
/** The rejection a reviewer recorded, or null while the requirement is pending or approved. */
export function requirementRejection(value: Requirement): RequirementRejection | null {
  const stored = value.extensions?.[REJECTION_EXTENSION];
  return stored && typeof stored === "object" && !Array.isArray(stored)
    ? (stored as unknown as RequirementRejection)
    : null;
}
const DECISION_EXTENSION = "testmaster:decision";
/**
 * The reason a reviewer gave when approving or editing a requirement, with the reviewer and time
 * (kept in the entity extensions, never in the audit trail). The latest approval or edit replaces it.
 */
// A type alias (not an interface) so it is assignable to the JSON-valued extensions map.
export type RequirementDecision = {
  action: "approved" | "edited";
  reason: string;
  actorId: string;
  decidedAt: string;
};
/** The reason recorded with the latest approval or edit, or null when that decision gave none. */
export function requirementDecision(value: Requirement): RequirementDecision | null {
  const stored = value.extensions?.[DECISION_EXTENSION];
  return stored && typeof stored === "object" && !Array.isArray(stored)
    ? (stored as unknown as RequirementDecision)
    : null;
}
/** The extensions with the decision replaced (or removed when the new decision gave no reason). */
function withDecision(
  extensions: Requirement["extensions"],
  decision: RequirementDecision | null,
): NonNullable<Requirement["extensions"]> {
  if (!decision && !extensions?.[DECISION_EXTENSION]) return extensions ?? {};
  const kept = Object.entries(extensions ?? {}).filter(([key]) => key !== DECISION_EXTENSION);
  return Object.fromEntries(decision ? [...kept, [DECISION_EXTENSION, { ...decision }]] : kept);
}
const MAX_REJECTION_REASON = 2000;
/** Refuses a decision on a requirement a reviewer already rejected. */
export function refuseRejected(value: Requirement, action: string): void {
  const rejection = requirementRejection(value);
  if (rejection)
    throw new ContractError(
      "PRECONDITION_FAILED",
      `Requirement was rejected (${rejection.reason}) and cannot be ${action}; a rejection is final, normalize the sources again to propose it anew`,
      { reasonCode: "requirement_rejected", requirementId: value.id },
    );
}
/** The part of a requirement conflict that decides whether its requirements may be approved and planned. */
export interface ConflictDecision {
  id: string;
  requirementIds: string[];
  resolution: { selectedRequirementId: string } | null;
}
/** The decided conflict that selected another requirement over this one: the requirement is superseded. */
export function supersedingConflict(
  requirementId: string,
  conflicts: readonly ConflictDecision[],
): ConflictDecision | undefined {
  return conflicts.find(
    (conflict) =>
      conflict.requirementIds.includes(requirementId) &&
      conflict.resolution !== null &&
      conflict.resolution.selectedRequirementId !== requirementId,
  );
}
/** Where a requirement stands: decided by a reviewer, superseded by a conflict decision, or still waiting. */
export type RequirementStatus = "pending" | "approved" | "rejected" | "superseded";
/**
 * One state derived from the fields that hold the decisions (the rejection extension, the approval
 * and the conflict resolutions); nothing is stored. A rejection is final and a superseded
 * requirement is never planned, so both outrank an approval the requirement still carries.
 */
export function requirementStatus(
  value: Requirement,
  conflicts: readonly ConflictDecision[],
): RequirementStatus {
  if (requirementRejection(value)) return "rejected";
  if (supersedingConflict(value.id, conflicts)) return "superseded";
  return value.approval ? "approved" : "pending";
}
/** A requirement as the MCP surface shows it: the stored fields and its derived status. */
export function withRequirementStatus(
  value: Requirement,
  conflicts: readonly ConflictDecision[],
): Requirement & { status: RequirementStatus } {
  return { ...value, status: requirementStatus(value, conflicts) };
}
/** `requirementStatus` plus the edit a reviewer recorded: an edited requirement waits for a new approval. */
export type RequirementReviewState = RequirementStatus | "edited";
export function requirementReviewState(
  value: Requirement,
  conflicts: readonly ConflictDecision[],
): RequirementReviewState {
  const status = requirementStatus(value, conflicts);
  return status === "pending" && requirementDecision(value)?.action === "edited"
    ? "edited"
    : status;
}
/** The stored requirement snapshot of a project; null when its sources were never normalized. No authorization. */
export function storedRequirementSnapshot(
  ctx: ServiceContext,
  projectId: string,
): RequirementSnapshot | null {
  const row = ctx.database.get(
    "SELECT value FROM operational_state WHERE key=?",
    `requirements:${ctx.workspaceId}:${projectId}`,
  );
  return row ? (JSON.parse(String(row.value)) as RequirementSnapshot) : null;
}
/** What a snapshot conflict reports about the snapshot another writer changed: identity and size, never the requirements. */
export function snapshotDigest(snapshot: RequirementSnapshot): {
  version: number;
  fingerprint: string;
  requirementCount: number;
  conflictCount: number;
} {
  return {
    version: snapshot.version,
    fingerprint: snapshot.fingerprint,
    requirementCount: snapshot.requirements.length,
    conflictCount: snapshot.conflicts.length,
  };
}
/**
 * Refuses a decision on a requirement whose conflict is not decided yet, or that a decided conflict
 * superseded: the requirement a conflict decision did not select is never approved nor planned.
 */
export function refuseConflicted(
  requirementId: string,
  conflicts: readonly ConflictDecision[],
  action: string,
): void {
  const undecided = conflicts.find(
    (conflict) => conflict.requirementIds.includes(requirementId) && !conflict.resolution,
  );
  if (undecided)
    throw new ContractError(
      "PRECONDITION_FAILED",
      `Requirement ${requirementId} is in conflict ${undecided.id}, which is not decided yet: adjudicate it before the requirement can be ${action}`,
      { reasonCode: "requirement_conflict_unresolved", requirementId, conflictId: undecided.id },
    );
  const superseding = supersedingConflict(requirementId, conflicts);
  if (superseding)
    throw new ContractError(
      "PRECONDITION_FAILED",
      `Requirement ${requirementId} was superseded when conflict ${superseding.id} was decided for ${superseding.resolution?.selectedRequirementId}; it cannot be ${action}`,
      {
        reasonCode: "requirement_superseded",
        requirementId,
        conflictId: superseding.id,
        selectedRequirementId: superseding.resolution?.selectedRequirementId,
      },
    );
}
/** Stable identity of a requirement across normalizations: the model-assigned key, else its ID. */
export function requirementKey(value: Requirement): string {
  return String(value.extensions?.["testmaster:key"] ?? value.id);
}
/**
 * What a proposal depends on in a requirement: its statement, acceptance criteria and evidence.
 * Approval is left out because accepting a proposal checks it on its own.
 */
export function requirementContentHash(value: Requirement): string {
  return semanticHash({
    text: value.text,
    acceptanceCriteria: value.acceptanceCriteria,
    sourceRefs: value.sourceRefs,
  });
}
/** The content hash of each requirement, recorded on a proposal batch to tell later which ones changed. */
export function requirementContentHashes(
  requirements: readonly Requirement[],
): Record<string, string> {
  return Object.fromEntries(requirements.map((item) => [item.id, requirementContentHash(item)]));
}
export class RequirementsService {
  constructor(
    readonly ctx: ServiceContext,
    readonly model: ModelService,
    readonly sources: SourcesService,
  ) {}
  private key(projectId: string) {
    return `requirements:${this.ctx.workspaceId}:${projectId}`;
  }
  snapshot(projectId: string): RequirementSnapshot {
    this.ctx.authorize("R", projectId);
    const row = this.ctx.database.get(
      "SELECT value FROM operational_state WHERE key=?",
      this.key(projectId),
    );
    return row
      ? (JSON.parse(String(row.value)) as RequirementSnapshot)
      : { requirements: [], conflicts: [], openQuestions: [], version: 0, fingerprint: "" };
  }
  private save(projectId: string, snapshot: RequirementSnapshot): void {
    this.ctx.database.run(
      "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      this.key(projectId),
      canonicalJson(snapshot),
    );
  }
  async normalize(input: {
    projectId: string;
    sourceRevisionIds: string[];
    provider?: string;
    model?: string;
    signal?: AbortSignal;
    /** Synchronous; called with completed 0..total as model batches finish. */
    onProgress?: (progress: NormalizeProgress) => void;
  }): Promise<RequirementSnapshot> {
    this.ctx.authorize("W", input.projectId);
    if (!input.sourceRevisionIds.length)
      throw new ContractError("INVALID_ARGUMENT", "Source revisions are required");
    const sources = input.sourceRevisionIds.map((id) => {
      if (this.sources.revisionProject(id) !== input.projectId)
        throw new ContractError("FORBIDDEN", "Source revision belongs to another project");
      return this.sources.revision(id);
    });
    if (sources.some((source) => !["ready", "partial"].includes(source.revision.status)))
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Sources requiring input cannot be normalized",
      );
    const before = this.snapshot(input.projectId);
    const codeRevisionIds = new Set(
      input.sourceRevisionIds.filter((id) =>
        ["code", "code-summary"].includes(this.sources.revisionRole(id)),
      ),
    );
    const { onProgress, ...modelInput } = input;
    const { normalized, modelCallIds } = await normalizeSources(
      this.model,
      modelInput,
      sources,
      onProgress,
    );
    return authoringTransaction(this.ctx, () => {
      const current = this.snapshot(input.projectId);
      if (current.version !== before.version)
        throw new ContractError(
          "REVISION_CONFLICT",
          "Requirement base changed during normalization",
          { diff: { before: snapshotDigest(before), current: snapshotDigest(current) } },
        );
      const byKey: Record<string, string> = {};
      const requirements = normalized.requirements.map((item) => {
        const codeOnly =
          item.sourceRefs.length > 0 &&
          item.sourceRefs.every((ref) => codeRevisionIds.has(ref.sourceRevisionId));
        const value = entity(this.ctx, "req", {
          text: item.text,
          acceptanceCriteria: item.acceptanceCriteria,
          sourceRefs: item.sourceRefs,
          originKind: codeOnly ? "inferred" : item.originKind,
          confidence: codeOnly ? (item.confidence ?? 0.5) : item.confidence,
          approval: null,
          extensions: {
            "testmaster:projectId": input.projectId,
            "testmaster:key": item.key,
            "testmaster:reason": codeOnly
              ? (item.reason ?? "Inferred from implementation, not an authoritative oracle")
              : item.reason,
          },
        }) as StoredRequirement;
        this.ctx.entities.insert("Requirement", value, { projectId: input.projectId });
        byKey[item.key] = value.id;
        return value;
      });
      const conflicts = normalized.conflicts.map((conflict, index) => ({
        id: `conflict-${index + 1}`,
        requirementIds: conflict.keys.map((key) => byKey[key] as string),
        reason: conflict.reason,
        sourceRefs: conflict.sourceRefs,
        resolution: null,
      }));
      const inferred = requirements.filter((item) => item.originKind === "inferred");
      const desired = requirements.filter(
        (item) => item.originKind === "explicit" || item.originKind === "user_spec",
      );
      for (const item of inferred) {
        if (
          desired.length &&
          !conflicts.some((conflict) => conflict.requirementIds.includes(item.id))
        )
          // Only the inference is blocked until a reviewer adjudicates it; desired contract
          // statements stay approvable and are attached as reconciliation evidence. Listing them
          // as members let one inference block (or, once adjudicated, supersede) the whole PRD.
          conflicts.push({
            id: `conflict-${conflicts.length + 1}`,
            requirementIds: [item.id],
            reason:
              "Implementation inference requires reconciliation with the desired contract before use as an oracle",
            sourceRefs: [
              ...item.sourceRefs,
              ...desired.flatMap((value) => value.sourceRefs),
            ] as SourceEvidenceRef[],
            resolution: null,
          });
      }
      const snapshot = {
        requirements,
        conflicts,
        openQuestions: normalized.openQuestions,
        version: current.version + 1,
        fingerprint: semanticHash({
          sources: sources.map((source) => source.revision),
          modelCallIds,
        }),
      };
      this.save(input.projectId, snapshot);
      this.audit("requirements.normalized", input.projectId, before, snapshot);
      const previousByKey = new Map(
        current.requirements.map((item) => [requirementKey(item), item]),
      );
      const nextKeys = new Set(requirements.map((item) => requirementKey(item)));
      appendRequirementLog(this.ctx, input.projectId, [
        {
          kind: "normalized",
          note: `${requirements.length} requirement(s) from ${input.sourceRevisionIds.length} source revision(s)`,
          sourceRevisionIds: input.sourceRevisionIds,
        },
        ...requirements.flatMap((item): RequirementLogInput[] => {
          const previous = previousByKey.get(requirementKey(item));
          const after = describeRequirement(item);
          const common = {
            requirementId: item.id,
            requirementKey: requirementKey(item),
            sourceRevisionIds: revisionIdsOf(item.sourceRefs),
          };
          if (!previous) return [{ kind: "requirement_added", after, ...common }];
          const before = describeRequirement(previous);
          return before === after
            ? []
            : [{ kind: "interpretation_changed", before, after, ...common }];
        }),
        ...current.requirements
          .filter((item) => !nextKeys.has(requirementKey(item)))
          .map(
            (item): RequirementLogInput => ({
              kind: "requirement_removed",
              requirementId: item.id,
              requirementKey: requirementKey(item),
              before: describeRequirement(item),
            }),
          ),
      ]);
      return snapshot;
    });
  }
  list(projectId: string): Requirement[] {
    return this.snapshot(projectId).requirements;
  }
  get(id: string): StoredRequirement {
    const value = requireEntity(this.ctx, "Requirement", id) as StoredRequirement;
    this.ctx.authorize("R", this.project(value));
    return value;
  }
  /** A requirement of this project with its derived status; the project's conflicts decide whether it is superseded. */
  withStatus(value: Requirement): Requirement & { status: RequirementStatus } {
    return withRequirementStatus(value, this.snapshot(this.project(value)).conflicts);
  }
  private project(value: Requirement): string {
    return String(value.extensions?.["testmaster:projectId"] ?? "");
  }
  private mutate(
    id: string,
    expectedVersion: number,
    action: (current: StoredRequirement) => StoredRequirement,
    /** `keep`: the change leaves the set of plannable requirements as the fingerprint describes it. */
    fingerprint: "recompute" | "keep" = "recompute",
  ): StoredRequirement {
    return authoringTransaction(this.ctx, () => {
      const current = this.get(id);
      const projectId = this.project(current);
      this.ctx.authorize("W", projectId);
      if (current.version !== expectedVersion)
        throw new ContractError("REVISION_CONFLICT", "Requirement changed", { diff: { current } });
      const next = action(current);
      this.ctx.entities.update("Requirement", this.ctx.workspaceId, id, expectedVersion, next, {
        projectId,
      });
      const snapshot = this.snapshot(projectId);
      snapshot.requirements = snapshot.requirements.map((item) => (item.id === id ? next : item));
      snapshot.version += 1;
      if (fingerprint === "recompute")
        // A rejected requirement is never planned: it takes no part in what the snapshot describes.
        snapshot.fingerprint = semanticHash(
          snapshot.requirements.filter((item) => !requirementRejection(item)),
        );
      this.save(projectId, snapshot);
      this.audit("requirement.updated", id, current, next);
      const textBefore = describeRequirement(current);
      const textAfter = describeRequirement(next);
      const identity = { requirementId: id, requirementKey: requirementKey(current) };
      const rejection = requirementRejection(next);
      appendRequirementLog(this.ctx, projectId, [
        ...(textBefore === textAfter
          ? []
          : [{ kind: "edited", before: textBefore, after: textAfter, ...identity } as const]),
        ...(current.approval && !next.approval
          ? [
              {
                kind: "approval_reset",
                note: rejection ? "Rejected after approval" : "Edited after approval",
                ...identity,
              } as const,
            ]
          : []),
        ...(!current.approval && next.approval
          ? [{ kind: "approved", note: next.approval, ...identity } as const]
          : []),
        ...(rejection && !requirementRejection(current)
          ? [{ kind: "rejected", note: rejection.reason, ...identity } as const]
          : []),
      ]);
      return next;
    });
  }
  /** The record of an approval or edit that gave a reason; null when it gave none. */
  private decision(
    action: RequirementDecision["action"],
    reason: string | null,
  ): RequirementDecision | null {
    return reason
      ? { action, reason, actorId: this.ctx.principalId, decidedAt: new Date().toISOString() }
      : null;
  }
  update(
    id: string,
    patch: { text?: string; acceptanceCriteria?: string[] },
    expectedVersion: number,
    reason?: string,
  ): StoredRequirement {
    if (Object.keys(patch).some((key) => !["text", "acceptanceCriteria"].includes(key)))
      throw new ContractError("INVALID_ARGUMENT", "Unknown requirement patch field");
    const text = decisionReason(reason);
    return this.mutate(id, expectedVersion, (current) => {
      refuseRejected(current, "edited");
      return {
        ...current,
        ...patch,
        approval: null,
        extensions: withDecision(current.extensions, this.decision("edited", text)),
        version: expectedVersion + 1,
      };
    });
  }
  apply(
    projectId: string,
    requirements: Requirement[],
    expectedVersion: number,
    reason?: string,
  ): RequirementSnapshot {
    this.ctx.authorize("W", projectId);
    return authoringTransaction(this.ctx, () => {
      const snapshot = this.snapshot(projectId);
      if (snapshot.version !== expectedVersion)
        throw new ContractError("REVISION_CONFLICT", "Requirement snapshot changed", {
          diff: { expectedVersion, current: snapshotDigest(snapshot) },
        });
      if (new Set(requirements.map((item) => item.id)).size !== requirements.length)
        throw new ContractError("INVALID_ARGUMENT", "Duplicate requirement IDs");
      for (const submitted of requirements) {
        const current = snapshot.requirements.find((item) => item.id === submitted.id);
        if (
          !current ||
          submitted.approval !== current.approval ||
          submitted.originKind !== current.originKind ||
          canonicalJson(submitted.sourceRefs) !== canonicalJson(current.sourceRefs)
        )
          throw new ContractError(
            "POLICY_DENIED",
            "Reviewed edits cannot forge approvals, origin or evidence",
          );
        // A rejected requirement returned unchanged (a snapshot read and sent back) is not an edit.
        if (
          requirementRejection(current) &&
          submitted.text === current.text &&
          canonicalJson(submitted.acceptanceCriteria) === canonicalJson(current.acceptanceCriteria)
        )
          continue;
        this.update(
          current.id,
          { text: submitted.text, acceptanceCriteria: submitted.acceptanceCriteria },
          current.version ?? 1,
          reason,
        );
      }
      return this.snapshot(projectId);
    });
  }
  approve(id: string, expectedVersion: number, reason?: string): StoredRequirement {
    const text = decisionReason(reason);
    return this.mutate(id, expectedVersion, (current) => {
      refuseRejected(current, "approved");
      const projectId = this.project(current);
      const snapshot = this.snapshot(projectId);
      refuseConflicted(id, snapshot.conflicts, "approved");
      const environment = allEntities(this.ctx, "Environment").find(
        (item) => item.projectId === projectId,
      );
      if (!environment)
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Requirement approval requires a project environment",
        );
      const approval = entity(this.ctx, "apr", {
        actorId: this.ctx.principalId,
        reviewerId: this.ctx.principalId,
        actionSet: ["requirement.approve"],
        revisionHash: semanticHash(current),
        environmentRevisionId: environment.activeRevisionId,
        originSet: [],
        expiresAt: "9999-12-31T23:59:59.000Z",
        revokedAt: null,
        policyHash: this.model.config.effectiveConfig.policyHash,
        reason: `Approve requirement ${id}`,
      });
      this.ctx.entities.insert("Approval", approval);
      this.audit("requirement.approved", id, current, approval);
      return {
        ...current,
        approval: approval.id,
        extensions: withDecision(current.extensions, this.decision("approved", text)),
        version: expectedVersion + 1,
      };
    });
  }
  /**
   * Records that a requirement is out of scope. The reason is mandatory. A rejected requirement is
   * not pending, is never planned, and is final: it can be neither approved nor edited, so the only
   * way to propose the statement again is to normalize the sources again. Rejecting changes the
   * snapshot version but not its fingerprint, so approved snapshots and the proposal batches built
   * from them stay valid; a batch that cites the rejected requirement is refused at acceptance.
   */
  reject(id: string, reason: string, expectedVersion: number): StoredRequirement {
    const text = reason.trim();
    if (!text || text.length > MAX_REJECTION_REASON)
      throw new ContractError(
        "INVALID_ARGUMENT",
        `A rejection needs a reason of 1 to ${MAX_REJECTION_REASON} characters`,
      );
    return this.mutate(
      id,
      expectedVersion,
      (current) => {
        if (requirementRejection(current))
          throw new ContractError("PRECONDITION_FAILED", "Requirement is already rejected", {
            reasonCode: "requirement_rejected",
            requirementId: id,
          });
        const rejection: RequirementRejection = {
          reason: text,
          actorId: this.ctx.principalId,
          rejectedAt: new Date().toISOString(),
        };
        this.audit("requirement.rejected", id, current, rejection);
        return {
          ...current,
          approval: null,
          extensions: withDecision(
            { ...current.extensions, [REJECTION_EXTENSION]: { ...rejection } },
            null,
          ),
          version: expectedVersion + 1,
        };
      },
      "keep",
    );
  }
  adjudicate(
    projectId: string,
    input: {
      conflictId: string;
      selectedRequirementId: string;
      reason: string;
      expectedVersion: number;
    },
  ): RequirementSnapshot {
    this.ctx.authorize("W", projectId);
    return authoringTransaction(this.ctx, () => {
      const snapshot = this.snapshot(projectId);
      if (snapshot.version !== input.expectedVersion)
        throw new ContractError("REVISION_CONFLICT", "Requirement snapshot changed", {
          diff: { expectedVersion: input.expectedVersion, current: snapshotDigest(snapshot) },
        });
      const conflict = snapshot.conflicts.find((item) => item.id === input.conflictId);
      if (!conflict?.requirementIds.includes(input.selectedRequirementId) || !input.reason.trim())
        throw new ContractError(
          "INVALID_ARGUMENT",
          "A grounded conflict decision and reason are required",
        );
      conflict.resolution = {
        selectedRequirementId: input.selectedRequirementId,
        reason: input.reason,
        actorId: this.ctx.principalId,
      };
      snapshot.version += 1;
      this.save(projectId, snapshot);
      this.audit("requirement.adjudicated", projectId, null, conflict);
      appendRequirementLog(this.ctx, projectId, [
        {
          kind: "conflict_decided",
          requirementId: input.selectedRequirementId,
          note: `${conflict.id}: ${input.reason}`,
          sourceRevisionIds: revisionIdsOf(conflict.sourceRefs),
        },
      ]);
      return snapshot;
    });
  }
  /** The normalized PRD for review: each statement with the spans it came from, and what changed. */
  review(projectId: string): RequirementReview {
    const snapshot = this.snapshot(projectId);
    const located = new Map<string, RevisionLocation | null>();
    const originsOf = (
      refs: Requirement["sourceRefs"],
    ): RequirementReview["conflicts"][number]["origins"] =>
      refs.slice(0, MAX_ORIGINS).flatMap((ref) => {
        if (!ref.sourceRevisionId) return [];
        if (!located.has(ref.sourceRevisionId))
          located.set(ref.sourceRevisionId, this.sources.locate(ref.sourceRevisionId, projectId));
        const where = located.get(ref.sourceRevisionId) ?? null;
        const chunk = where?.chunks.find((value) => value.contentHash === ref.contentHash);
        return [
          {
            sourceRevisionId: ref.sourceRevisionId,
            sourceId: where?.sourceId ?? null,
            sourceName: where?.sourceName ?? null,
            revisionOrdinal: where?.ordinal ?? null,
            current: where?.current ?? false,
            revisionHash: where?.revisionHash ?? null,
            spanHash: ref.contentHash ?? null,
            ref: {
              ...(ref.relativePath ? { relativePath: ref.relativePath } : {}),
              ...(ref.offset !== undefined ? { offset: ref.offset } : {}),
              ...(ref.length !== undefined ? { length: ref.length } : {}),
              ...(ref.page !== undefined ? { page: ref.page } : {}),
              ...(ref.jsonPointer ? { jsonPointer: ref.jsonPointer } : {}),
            },
            excerpt: chunk ? chunk.text.slice(0, MAX_EXCERPT) : null,
          },
        ];
      });
    return {
      id: projectId,
      projectId,
      version: snapshot.version,
      fingerprint: snapshot.fingerprint,
      requirements: snapshot.requirements.map((item) => {
        const origins = originsOf(item.sourceRefs);
        const key = item.extensions?.["testmaster:key"];
        const reason = item.extensions?.["testmaster:reason"];
        return {
          id: item.id,
          version: Number(item.version ?? 1),
          key: typeof key === "string" ? key : null,
          text: item.text,
          acceptanceCriteria: item.acceptanceCriteria,
          originKind: item.originKind,
          confidence: item.confidence,
          approval: item.approval,
          reason: typeof reason === "string" ? reason : null,
          rejection: requirementRejection(item),
          decision: requirementDecision(item),
          origins,
          conflictIds: snapshot.conflicts
            .filter((conflict) => conflict.requirementIds.includes(item.id))
            .map((conflict) => conflict.id),
          supersededOrigin: origins.some((origin) => !origin.current),
        };
      }),
      conflicts: snapshot.conflicts.map((conflict) => ({
        id: conflict.id,
        reason: conflict.reason,
        requirementIds: conflict.requirementIds,
        origins: originsOf(conflict.sourceRefs),
        resolution: conflict.resolution,
      })),
      openQuestions: snapshot.openQuestions,
      changes: readRequirementLog(this.ctx, projectId).slice(-MAX_CHANGES).reverse(),
    };
  }
  private audit(action: string, resourceId: string, before: unknown, after: unknown): void {
    new AuditRepository(this.ctx.database).append({
      workspaceId: this.ctx.workspaceId,
      actor: this.ctx.principalId,
      action,
      resourceId,
      requestId: crypto.randomUUID(),
      beforeHash: before ? semanticHash(before) : null,
      afterHash: semanticHash(after),
      timestamp: new Date().toISOString(),
    });
  }
}
