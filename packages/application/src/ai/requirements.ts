import { ContractError, type Requirement } from "@testmaster/contracts";
import { canonicalJson, semanticHash } from "@testmaster/domain";
import { AuditRepository, type EntityDocument } from "@testmaster/persistence";
import type { SourceEvidenceRef } from "@testmaster/planner";
import { authoringTransaction } from "../authoring.js";
import { allEntities, entity, requireEntity, type ServiceContext } from "../context.js";
import type { ModelService } from "./model.js";
import { normalizeSources } from "./normalization.js";
import type { SourcesService } from "./sources.js";

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
    const { normalized, modelCallIds } = await normalizeSources(this.model, input, sources);
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
          conflicts.push({
            id: `conflict-${conflicts.length + 1}`,
            requirementIds: [item.id, ...desired.map((value) => value.id)],
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
      return snapshot;
    });
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
