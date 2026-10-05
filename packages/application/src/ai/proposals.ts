import {
  ContractError,
  type ExecutablePlan,
  type Proposal,
  type ProposalBatch,
  type Requirement,
  type TestCase,
  type TestRevision,
} from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import {
  AuditRepository,
  type EntityDocument,
  IdempotencyRepository,
} from "@testmaster/persistence";
import {
  type GeneratedProposals,
  type SourceEvidenceRef,
  validateGeneratedProposals,
  validateProposalPlan,
} from "@testmaster/planner";
import { authoringTransaction } from "../authoring.js";
import { allEntities, entity, requireEntity, type ServiceContext } from "../context.js";
import type { ModelService } from "./model.js";
import type { RequirementsService } from "./requirements.js";

type StoredProposal = Proposal & EntityDocument;
type StoredBatch = ProposalBatch & EntityDocument;
export interface ProposalReceipt {
  accepted: string[];
  retained: string[];
  rejected: string[];
}
export class ProposalsService {
  constructor(
    readonly ctx: ServiceContext,
    readonly model: ModelService,
    readonly requirements: RequirementsService,
  ) {}
  async generate(input: {
    projectId: string;
    sourceSnapshotId?: string;
    type?: "frontend" | "backend";
    requirementIds?: string[];
    provider?: string;
    model?: string;
    signal?: AbortSignal;
    idempotencyKey?: string;
    budget?: { maxOutputTokens?: number; deadlineMs?: number };
  }): Promise<StoredBatch> {
    this.ctx.authorize("W", input.projectId);
    if (
      input.budget &&
      Object.keys(input.budget).some((key) => !["maxOutputTokens", "deadlineMs"].includes(key))
    )
      throw new ContractError("INVALID_ARGUMENT", "Unsupported generation budget key");
    if (input.idempotencyKey) {
      const { signal: _signal, idempotencyKey: _key, ...body } = input;
      const actorScope = `${this.ctx.principalId}:${input.projectId}`;
      const receipt = this.ctx.database.get(
        "SELECT expires_at FROM idempotency_receipts WHERE workspace_id=? AND actor_scope=? AND operation='proposal.generate' AND key=?",
        this.ctx.workspaceId,
        actorScope,
        input.idempotencyKey,
      );
      if (receipt && String(receipt.expires_at) > new Date().toISOString())
        return new IdempotencyRepository(this.ctx.database).execute<StoredBatch>(
          {
            workspaceId: this.ctx.workspaceId,
            actorScope,
            operation: "proposal.generate",
            key: input.idempotencyKey,
            body,
          },
          () => {
            throw new ContractError(
              "PRECONDITION_FAILED",
              "Generation receipt expired during retry",
            );
          },
        ).receipt;
    }
    const snapshot = this.requirements.snapshot(input.projectId);
    if (input.sourceSnapshotId && input.sourceSnapshotId !== snapshot.fingerprint)
      throw new ContractError("PRECONDITION_FAILED", "Requirement snapshot fingerprint changed");
    const requirements = snapshot.requirements.filter(
      (item) => !input.requirementIds || input.requirementIds.includes(item.id),
    );
    if (
      !requirements.length ||
      input.requirementIds?.some((id) => !requirements.some((requirement) => requirement.id === id))
    )
      throw new ContractError("INVALID_ARGUMENT", "Select known approved requirements");
    for (const requirement of requirements) this.requireApproved(requirement, snapshot.conflicts);
    const evidence = requirements.flatMap((item) => item.sourceRefs) as SourceEvidenceRef[];
    const output = await this.model.complete<GeneratedProposals>({
      projectId: input.projectId,
      purpose: "plan",
      responseSchema: "AIProposalsOutput",
      data: { requirements, type: input.type ?? "backend", sourceSnapshotId: snapshot.fingerprint },
      instructions:
        "Return exactly one independent executable proposal per supplied requirement, not an intent. Copy requirement IDs and evidence refs exactly. Use deterministic business assertions deriving expected values only from approved requirements. Include an assertion that would fail if the required feature were broken; body/html visibility and broad all-status checks are trivial and rejected. HTTP paths are relative pathSegments of literal values; frontend locators use testId/role/label. Do not invent absolute destinations or secret values.",
      sourceRevisionIds: [...new Set(evidence.map((ref) => ref.sourceRevisionId))],
      dataClasses: ["requirements"],
      ...input.budget,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const generated = validateGeneratedProposals(
      output.output,
      requirements.map((item) => item.id),
      evidence,
    );
    if (
      generated.proposals.length !== requirements.length ||
      requirements.some(
        (requirement) =>
          generated.proposals.filter((proposal) =>
            proposal.requirementRefs.includes(requirement.id),
          ).length !== 1,
      )
    )
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Generation must cover each selected requirement exactly once",
      );
    const commit = () => {
      if (this.requirements.snapshot(input.projectId).fingerprint !== snapshot.fingerprint)
        throw new ContractError("REVISION_CONFLICT", "Requirements changed during generation", {
          diff: { before: snapshot, current: this.requirements.snapshot(input.projectId) },
        });
      const batch = entity(this.ctx, "pbt", {
        projectId: input.projectId,
        sourceSnapshotId: snapshot.fingerprint,
        state: "proposed",
        extensions: {
          "testmaster:requirementVersion": snapshot.version,
          "testmaster:modelCallId": output.modelCallId,
        },
      }) as StoredBatch;
      this.ctx.entities.insert("ProposalBatch", batch);
      for (const item of generated.proposals) {
        const proposal = entity(this.ctx, "pro", {
          batchId: batch.id,
          ...item,
          state: "proposed",
          validation: "valid",
        }) as StoredProposal;
        this.ctx.entities.insert("Proposal", proposal);
      }
      this.audit("proposals.generated", batch.id, null, batch);
      return batch;
    };
    if (input.idempotencyKey) {
      const { signal: _signal, idempotencyKey: _key, ...body } = input;
      return new IdempotencyRepository(this.ctx.database).execute(
        {
          workspaceId: this.ctx.workspaceId,
          actorScope: `${this.ctx.principalId}:${input.projectId}`,
          operation: "proposal.generate",
          key: input.idempotencyKey,
          body,
        },
        commit,
      ).receipt;
    }
    return authoringTransaction(this.ctx, commit);
  }
  private requireApproved(
    requirement: Requirement,
    conflicts: { requirementIds: string[]; resolution: { selectedRequirementId: string } | null }[],
  ): void {
    if (!requirement.approval)
      throw new ContractError("PRECONDITION_FAILED", "Requirements need explicit approval", {
        requirementId: requirement.id,
      });
    const approval = requireEntity(this.ctx, "Approval", requirement.approval);
    if (approval.revokedAt || Date.parse(String(approval.expiresAt)) <= Date.now())
      throw new ContractError("PRECONDITION_FAILED", "Requirement approval is no longer valid");
    if (
      conflicts.some(
        (conflict) =>
          conflict.requirementIds.includes(requirement.id) &&
          conflict.resolution?.selectedRequirementId !== requirement.id,
      )
    )
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Requirement is unresolved or superseded by conflict adjudication",
      );
  }
  list(projectId: string): StoredBatch[] {
    this.ctx.authorize("R", projectId);
    return (allEntities(this.ctx, "ProposalBatch") as StoredBatch[]).filter(
      (item) => item.projectId === projectId,
    );
  }
  get(id: string): StoredBatch {
    const batch = requireEntity(this.ctx, "ProposalBatch", id) as StoredBatch;
    this.ctx.authorize("R", batch.projectId);
    return batch;
  }
  detail(id: string): { batch: StoredBatch; proposals: StoredProposal[] } {
    const batch = this.get(id);
    return {
      batch,
      proposals: (allEntities(this.ctx, "Proposal") as StoredProposal[]).filter(
        (item) => item.batchId === id,
      ),
    };
  }
  edit(id: string, plan: ExecutablePlan, expectedVersion: number): StoredProposal {
    validateProposalPlan(plan);
    return authoringTransaction(this.ctx, () => {
      const current = requireEntity(this.ctx, "Proposal", id) as StoredProposal;
      const batch = this.get(current.batchId);
      this.ctx.authorize("W", batch.projectId);
      if (current.version !== expectedVersion)
        throw new ContractError("REVISION_CONFLICT", "Proposal changed", {
          diff: {
            expectedVersion,
            currentVersion: current.version,
            submitted: plan,
            current: current.plan,
          },
        });
      if (current.state !== "proposed")
        throw new ContractError("PRECONDITION_FAILED", "Only retained proposals may be edited");
      validateGeneratedProposals(
        {
          proposals: [
            {
              plan,
              requirementRefs: current.requirementRefs,
              evidenceRefs: current.evidenceRefs,
              warnings: current.warnings,
            },
          ],
        },
        current.requirementRefs,
        current.evidenceRefs as SourceEvidenceRef[],
      );
      const next = { ...current, plan, version: expectedVersion + 1 };
      this.ctx.entities.update("Proposal", this.ctx.workspaceId, id, expectedVersion, next);
      this.ctx.entities.update(
        "ProposalBatch",
        this.ctx.workspaceId,
        batch.id,
        batch.version ?? 1,
        { ...batch, version: (batch.version ?? 1) + 1 },
      );
      this.audit("proposal.edited", id, current, next);
      return next;
    });
  }
  accept(
    id: string,
    input: { proposalIds: string[]; expectedVersion: number; idempotencyKey: string },
  ): ProposalReceipt {
    return this.review(id, {
      acceptIds: input.proposalIds,
      rejectIds: [],
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
    });
  }
  reject(
    id: string,
    input: { proposalIds: string[]; expectedVersion: number; idempotencyKey?: string },
  ): ProposalReceipt {
    return this.review(id, {
      acceptIds: [],
      rejectIds: input.proposalIds,
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
    });
  }
  review(
    id: string,
    input: {
      acceptIds: string[];
      rejectIds: string[];
      expectedVersion: number;
      idempotencyKey: string;
    },
  ): ProposalReceipt {
    const batch = this.get(id);
    this.ctx.authorize("W", batch.projectId);
    if (!input.acceptIds.length && !input.rejectIds.length)
      throw new ContractError("INVALID_ARGUMENT", "A nonempty proposal subset is required");
    if (
      new Set([...input.acceptIds, ...input.rejectIds]).size !==
      input.acceptIds.length + input.rejectIds.length
    )
      throw new ContractError("INVALID_ARGUMENT", "Duplicate or overlapping proposal IDs");
    return new IdempotencyRepository(this.ctx.database).execute(
      {
        workspaceId: this.ctx.workspaceId,
        actorScope: `${this.ctx.principalId}:${batch.projectId}`,
        operation: `proposal.review:${id}`,
        key: input.idempotencyKey,
        body: input,
      },
      () => {
        const { batch: current, proposals } = this.detail(id);
        if (current.version !== input.expectedVersion)
          throw new ContractError("REVISION_CONFLICT", "Proposal batch changed", {
            diff: {
              expectedVersion: input.expectedVersion,
              currentVersion: current.version,
              proposals,
            },
          });
        if (
          [...input.acceptIds, ...input.rejectIds].some(
            (proposalId) =>
              !proposals.some(
                (proposal) => proposal.id === proposalId && proposal.state === "proposed",
              ),
          )
        )
          throw new ContractError("INVALID_ARGUMENT", "Unknown or already decided proposal");
        const accepted: string[] = [];
        const rejected: string[] = [];
        for (const proposal of proposals) {
          if (input.acceptIds.includes(proposal.id)) {
            if (proposal.validation !== "valid" || proposal.plan.kind !== "executable")
              throw new ContractError("INVALID_ARGUMENT", "Invalid proposal cannot enter a suite");
            validateProposalPlan(proposal.plan);
            const snapshot = this.requirements.snapshot(current.projectId);
            if (snapshot.fingerprint !== current.sourceSnapshotId)
              throw new ContractError(
                "PRECONDITION_FAILED",
                "Proposal source requirements are stale",
              );
            for (const requirementId of proposal.requirementRefs)
              this.requireApproved(this.requirements.get(requirementId), snapshot.conflicts);
            const test = entity(this.ctx, "tst", {
              projectId: current.projectId,
              name: proposal.plan.name,
              activeRevisionId: null,
              tags: proposal.plan.tags ?? [],
              priority: proposal.plan.priority ?? "normal",
              archivedAt: null,
            }) as TestCase & EntityDocument;
            this.ctx.entities.insert("TestCase", test);
            const revision = entity(this.ctx, "rev", {
              testId: test.id,
              ordinal: 1,
              contentHash: semanticHash(proposal.plan, "plan"),
              plan: proposal.plan,
              codeArtifactId: null,
              runnerKind: proposal.plan.runner,
              author: this.ctx.principalId,
              parentId: null,
              origin: "generated",
              extensions: { "testmaster:proposalId": proposal.id, "testmaster:batchId": id },
            }) as TestRevision & EntityDocument;
            this.ctx.entities.insert("TestRevision", revision);
            this.ctx.entities.update("TestCase", this.ctx.workspaceId, test.id, 1, {
              ...test,
              activeRevisionId: revision.id,
              version: 2,
            });
            this.ctx.entities.update(
              "Proposal",
              this.ctx.workspaceId,
              proposal.id,
              proposal.version ?? 1,
              {
                ...proposal,
                state: "accepted",
                extensions: {
                  ...proposal.extensions,
                  "testmaster:candidateRevisionId": revision.id,
                  "testmaster:testId": test.id,
                },
              },
            );
            accepted.push(test.id);
          } else if (input.rejectIds.includes(proposal.id)) {
            this.ctx.entities.update(
              "Proposal",
              this.ctx.workspaceId,
              proposal.id,
              proposal.version ?? 1,
              { ...proposal, state: "rejected" },
            );
            rejected.push(proposal.id);
          }
        }
        const retained = proposals
          .filter(
            (proposal) =>
              proposal.state === "proposed" &&
              !input.acceptIds.includes(proposal.id) &&
              !input.rejectIds.includes(proposal.id),
          )
          .map((proposal) => proposal.id);
        this.ctx.entities.update("ProposalBatch", this.ctx.workspaceId, id, current.version, {
          ...current,
          state: retained.length
            ? "proposed"
            : accepted.length || proposals.some((proposal) => proposal.state === "accepted")
              ? "accepted"
              : "rejected",
          version: current.version + 1,
        });
        const receipt = { accepted, retained, rejected };
        this.audit("proposals.reviewed", id, current, receipt);
        return receipt;
      },
    ).receipt;
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
