import {
  type Approval,
  ContractError,
  type EnvironmentRevision,
  type ExecutablePlan,
  type PlanStep,
  type Run,
  type TestCase,
  type TestRevision,
  validate,
} from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import { type EntityDocument, OutboxRepository } from "@testmaster/persistence";
import { authoringTransaction } from "./authoring.js";
import { allEntities, entity, requireEntity, type ServiceContext } from "./context.js";

type Stored<T> = T & EntityDocument;
export interface ApprovalInput {
  actorId?: string;
  reviewerId?: string;
  actionSet: string[];
  revisionHash: string;
  environmentRevisionId: string;
  originSet: string[];
  expiresAt?: string;
  policyHash: string;
}
export type RiskClass = "read" | "write" | "destructive" | "securityProbe";

/** A declaration can increase risk, never downgrade a mutating operation. */
export function planRiskActions(plan: ExecutablePlan): Array<{ stepId: string; risk: RiskClass }> {
  const actions: Array<{ stepId: string; risk: RiskClass }> = [];
  const severity: Record<RiskClass, number> = {
    read: 0,
    write: 1,
    destructive: 2,
    securityProbe: 3,
  };
  const visit = (steps: readonly PlanStep[]): void => {
    for (const step of steps) {
      if (step.operation === "frame") {
        visit(step.input.childSteps);
        continue;
      }
      if (step.kind === "assertion") continue;
      let inferred: RiskClass = "read";
      if (step.operation === "request") {
        if (step.input.method === "DELETE") inferred = "destructive";
        else if (
          !["GET", "HEAD", "OPTIONS"].includes(step.input.method) ||
          step.input.body ||
          step.input.resource
        )
          inferred = "write";
      } else if (!["navigate", "hover", "waitFor", "switchPage"].includes(step.operation)) {
        inferred = "write";
      }
      const meaning = `${step.description} ${JSON.stringify(step.input)}`;
      if (/\b(delete|remove|destroy|purge|erase|reset|terminate|unsubscribe)\b/i.test(meaning))
        inferred = "destructive";
      else if (
        inferred === "read" &&
        /\b(create|update|save|purchase|payment|checkout|send|email|sms|password|auth|logout|charge)\b/i.test(
          meaning,
        )
      )
        inferred = "write";
      if (/\b(fuzz|load[- ]?test|stress|probe|penetration|injection|exploit)\b/i.test(meaning))
        inferred = "securityProbe";
      const declared = step.risk ?? "read";
      actions.push({
        stepId: step.id,
        risk: severity[declared] > severity[inferred] ? declared : inferred,
      });
    }
  };
  visit(plan.steps);
  for (const cleanup of plan.cleanup ?? []) {
    actions.push({
      stepId: `cleanup:${cleanup.resourceRef}`,
      risk: cleanup.input.method === "DELETE" ? "destructive" : "write",
    });
  }
  return actions;
}

export class ApprovalsService {
  constructor(readonly ctx: ServiceContext) {}
  private projectId(environmentRevisionId: string): string {
    requireEntity(this.ctx, "EnvironmentRevision", environmentRevisionId);
    const row = this.ctx.database.get(
      "SELECT e.project_id FROM environment_revisions r JOIN environments e ON e.workspace_id=r.workspace_id AND e.id=r.environment_id WHERE r.workspace_id=? AND r.id=?",
      this.ctx.workspaceId,
      environmentRevisionId,
    );
    if (!row) throw new ContractError("NOT_FOUND", "Approval environment does not exist");
    return String(row.project_id);
  }
  create(input: ApprovalInput): Stored<Approval> {
    this.ctx.authorize("W");
    for (const key of Object.keys(input)) {
      if (
        ![
          "actorId",
          "reviewerId",
          "actionSet",
          "revisionHash",
          "environmentRevisionId",
          "originSet",
          "expiresAt",
          "policyHash",
        ].includes(key)
      )
        throw new ContractError("INVALID_ARGUMENT", "Unknown approval field", { field: key });
    }
    return authoringTransaction(this.ctx, () => {
      const projectId = this.projectId(input.environmentRevisionId);
      this.ctx.authorize("W", projectId);
      const reviewerId = input.reviewerId ?? this.ctx.principalId;
      if (reviewerId !== this.ctx.principalId)
        throw new ContractError(
          "FORBIDDEN",
          "Approval reviewer must be the authenticated principal",
        );
      const reviewer = requireEntity(this.ctx, "Principal", reviewerId);
      if (reviewer.kind !== "human" || reviewer.disabledAt)
        throw new ContractError(
          "FORBIDDEN",
          "Execution approvals require an enabled human reviewer",
        );
      const now = Date.now();
      const expiresAt = input.expiresAt ?? new Date(now + 30 * 60_000).toISOString();
      const deadline = Date.parse(expiresAt);
      if (!Number.isFinite(deadline) || deadline <= now || deadline > now + 30 * 60_000)
        throw new ContractError("INVALID_ARGUMENT", "Approval must expire within 30 minutes");
      const value = entity(this.ctx, "apr", {
        actorId: input.actorId ?? this.ctx.principalId,
        reviewerId,
        actionSet: input.actionSet,
        revisionHash: input.revisionHash,
        environmentRevisionId: input.environmentRevisionId,
        originSet: input.originSet,
        expiresAt,
        revokedAt: null,
        policyHash: input.policyHash,
      }) as Stored<Approval>;
      validate("Approval", value);
      if (
        !value.actionSet.length ||
        new Set(value.actionSet).size !== value.actionSet.length ||
        !value.originSet.length ||
        new Set(value.originSet).size !== value.originSet.length
      )
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Approval action and origin sets must be nonempty and unique",
        );
      for (const origin of value.originSet) {
        let target: URL;
        try {
          target = new URL(origin);
        } catch {
          throw new ContractError(
            "INVALID_ARGUMENT",
            "Approval origin must be an absolute HTTP origin",
          );
        }
        if (!["http:", "https:"].includes(target.protocol) || target.origin !== origin)
          throw new ContractError(
            "INVALID_ARGUMENT",
            "Approval origin must be canonical without path or credentials",
          );
      }
      const revision = (allEntities(this.ctx, "TestRevision") as Stored<TestRevision>[]).find(
        (candidate) => {
          if (candidate.contentHash !== value.revisionHash) return false;
          const owner = requireEntity(this.ctx, "TestCase", candidate.testId);
          return owner.projectId === projectId;
        },
      );
      if (!revision)
        throw new ContractError(
          "NOT_FOUND",
          "Approval revision digest does not belong to this project",
        );
      this.ctx.entities.insert("Approval", value);
      this.audit("approval.created", value.id, null, semanticHash(value));
      return value;
    });
  }
  get(id: string): Stored<Approval> {
    this.ctx.authorize("R");
    const value = requireEntity(this.ctx, "Approval", id) as Stored<Approval>;
    this.ctx.authorize("R", this.projectId(value.environmentRevisionId));
    return value;
  }
  list(): Stored<Approval>[] {
    this.ctx.authorize("R");
    return (allEntities(this.ctx, "Approval") as Stored<Approval>[]).filter((value) => {
      try {
        this.ctx.authorize("R", this.projectId(value.environmentRevisionId));
        return true;
      } catch (error) {
        if (error instanceof ContractError && error.code === "FORBIDDEN") return false;
        throw error;
      }
    });
  }
  revoke(id: string): Stored<Approval> {
    this.ctx.authorize("W");
    return authoringTransaction(this.ctx, () => {
      const value = requireEntity(this.ctx, "Approval", id) as Stored<Approval>;
      this.ctx.authorize("W", this.projectId(value.environmentRevisionId));
      if (value.revokedAt) return value;
      const next = {
        ...value,
        revokedAt: new Date().toISOString(),
        version: (value.version ?? 1) + 1,
      };
      this.ctx.entities.update("Approval", this.ctx.workspaceId, id, value.version ?? 1, next);
      this.audit("approval.revoked", id, semanticHash(value), semanticHash(next));
      new OutboxRepository(this.ctx.database).append(this.ctx.workspaceId, id, "approval.revoked", {
        approvalId: id,
      });
      return next;
    });
  }
  /** Run admission must call this inside its transaction, fixing the exact revision/environment. */
  verify(
    run: Pick<Run, "testId" | "revisionId" | "environmentRevisionId" | "gatePolicy"> & {
      actorId?: string;
    },
    test: TestCase,
    env: EnvironmentRevision,
  ): Stored<Approval> | null {
    this.ctx.authorize("X", test.projectId);
    return authoringTransaction(this.ctx, () => {
      const storedTest = requireEntity(this.ctx, "TestCase", test.id) as Stored<TestCase>;
      if (storedTest.projectId !== test.projectId || run.testId !== test.id)
        throw new ContractError("INVALID_ARGUMENT", "Approval test binding does not match the run");
      const revision = requireEntity(
        this.ctx,
        "TestRevision",
        run.revisionId,
      ) as Stored<TestRevision>;
      const environment = requireEntity(
        this.ctx,
        "EnvironmentRevision",
        run.environmentRevisionId,
      ) as Stored<EnvironmentRevision>;
      if (
        revision.testId !== test.id ||
        environment.id !== env.id ||
        this.projectId(environment.id) !== test.projectId
      )
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Approval revision/environment binding does not match the run",
        );
      if (!revision.plan)
        throw new ContractError(
          "POLICY_DENIED",
          "Imported code requires a separately approved execution policy",
        );
      const actions = planRiskActions(revision.plan).filter((action) => action.risk !== "read");
      if (!environment.production || !actions.length) return null;
      const policy =
        run.gatePolicy && typeof run.gatePolicy === "object" && !Array.isArray(run.gatePolicy)
          ? (run.gatePolicy as Record<string, unknown>)
          : {};
      const policyHash =
        typeof policy.policyHash === "string" ? policy.policyHash : semanticHash(run.gatePolicy);
      const origins = new Set(environment.targetOrigins);
      const visit = (steps: readonly PlanStep[]): void => {
        for (const step of steps) {
          if (step.operation === "frame") visit(step.input.childSteps);
          if (step.operation === "navigate" && /^[a-z][a-z\d+.-]*:/i.test(step.input.path)) {
            let target: URL;
            try {
              target = new URL(step.input.path);
            } catch {
              throw new ContractError("INVALID_ARGUMENT", "Navigation target must be a valid URL");
            }
            if (
              !["http:", "https:"].includes(target.protocol) ||
              target.username ||
              target.password
            )
              throw new ContractError(
                "POLICY_DENIED",
                "Navigation target is not an approved HTTP origin",
              );
            origins.add(target.origin);
          }
        }
      };
      visit(revision.plan.steps);
      const actorId = run.actorId ?? this.ctx.principalId;
      const approval = (allEntities(this.ctx, "Approval") as Stored<Approval>[]).find(
        (candidate) =>
          candidate.actorId === actorId &&
          candidate.revisionHash === revision.contentHash &&
          candidate.environmentRevisionId === environment.id &&
          candidate.policyHash === policyHash &&
          !candidate.revokedAt &&
          Date.parse(candidate.expiresAt) > Date.now() &&
          [...origins].every((origin) => candidate.originSet.includes(origin)) &&
          actions.every(
            (action) =>
              candidate.actionSet.includes(action.risk) ||
              candidate.actionSet.includes(action.stepId),
          ),
      );
      if (!approval)
        throw new ContractError(
          "POLICY_DENIED",
          "Risky production actions require a current bound human approval",
          { reasonCode: "approval_required", actions },
        );
      const reviewer = requireEntity(this.ctx, "Principal", approval.reviewerId);
      if (reviewer.kind !== "human" || reviewer.disabledAt)
        throw new ContractError("POLICY_DENIED", "Approval reviewer is no longer enabled", {
          reasonCode: "approval_required",
        });
      this.audit("approval.verified", approval.id, null, revision.contentHash);
      const consumed = {
        ...approval,
        revokedAt: new Date().toISOString(),
        version: (approval.version ?? 1) + 1,
      };
      this.ctx.entities.update(
        "Approval",
        this.ctx.workspaceId,
        approval.id,
        approval.version ?? 1,
        consumed,
      );
      this.audit("approval.consumed", approval.id, semanticHash(approval), semanticHash(consumed));
      return approval;
    });
  }
  private audit(
    action: string,
    resourceId: string,
    beforeHash: string | null,
    afterHash: string,
  ): void {
    const event = entity(this.ctx, "aud", {
      actor: this.ctx.principalId,
      action,
      resourceId,
      requestId: resourceId,
      beforeHash,
      afterHash,
      timestamp: new Date().toISOString(),
    });
    this.ctx.entities.insert("AuditEvent", event);
  }
}
