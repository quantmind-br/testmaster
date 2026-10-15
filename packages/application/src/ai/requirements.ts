import { ContractError, type Requirement, type RequirementReview } from "@testmaster/contracts";
import { canonicalJson, semanticHash } from "@testmaster/domain";
import { AuditRepository, type EntityDocument } from "@testmaster/persistence";
import type { SourceEvidenceRef } from "@testmaster/planner";
import { authoringTransaction } from "../authoring.js";
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
/** Stable identity of a requirement across normalizations: the model-assigned key, else its ID. */
export function requirementKey(value: Requirement): string {
  return String(value.extensions?.["testmaster:key"] ?? value.id);
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
          { diff: { before, current } },
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
  private project(value: Requirement): string {
    return String(value.extensions?.["testmaster:projectId"] ?? "");
  }
  private mutate(
    id: string,
    expectedVersion: number,
    action: (current: StoredRequirement) => StoredRequirement,
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
      snapshot.fingerprint = semanticHash(snapshot.requirements);
      this.save(projectId, snapshot);
      this.audit("requirement.updated", id, current, next);
      const textBefore = describeRequirement(current);
      const textAfter = describeRequirement(next);
      const identity = { requirementId: id, requirementKey: requirementKey(current) };
      appendRequirementLog(this.ctx, projectId, [
        ...(textBefore === textAfter
          ? []
          : [{ kind: "edited", before: textBefore, after: textAfter, ...identity } as const]),
        ...(current.approval && !next.approval
          ? [{ kind: "approval_reset", note: "Edited after approval", ...identity } as const]
          : []),
        ...(!current.approval && next.approval
          ? [{ kind: "approved", note: next.approval, ...identity } as const]
          : []),
      ]);
      return next;
    });
  }
  update(
    id: string,
    patch: { text?: string; acceptanceCriteria?: string[] },
    expectedVersion: number,
  ): StoredRequirement {
    if (Object.keys(patch).some((key) => !["text", "acceptanceCriteria"].includes(key)))
      throw new ContractError("INVALID_ARGUMENT", "Unknown requirement patch field");
    return this.mutate(id, expectedVersion, (current) => ({
      ...current,
      ...patch,
      approval: null,
      version: expectedVersion + 1,
    }));
  }
  apply(
    projectId: string,
    requirements: Requirement[],
    expectedVersion: number,
  ): RequirementSnapshot {
    this.ctx.authorize("W", projectId);
    return authoringTransaction(this.ctx, () => {
      const snapshot = this.snapshot(projectId);
      if (snapshot.version !== expectedVersion)
        throw new ContractError("REVISION_CONFLICT", "Requirement snapshot changed", {
          diff: { current: snapshot, submitted: requirements },
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
        this.update(
          current.id,
          { text: submitted.text, acceptanceCriteria: submitted.acceptanceCriteria },
          current.version ?? 1,
        );
      }
      return this.snapshot(projectId);
    });
  }
  approve(id: string, expectedVersion: number): StoredRequirement {
    return this.mutate(id, expectedVersion, (current) => {
      const projectId = this.project(current);
      const snapshot = this.snapshot(projectId);
      if (
        snapshot.conflicts.some(
          (conflict) => conflict.requirementIds.includes(id) && !conflict.resolution,
        )
      )
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Adjudicate requirement conflicts before approval",
        );
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
      return { ...current, approval: approval.id, version: expectedVersion + 1 };
    });
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
          diff: { current: snapshot },
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
