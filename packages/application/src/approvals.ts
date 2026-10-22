import {
  type Approval,
  type ApprovalPolicy,
  type ApprovalPolicyInput,
  ContractError,
  type EnvironmentRevision,
  type ExecutablePlan,
  type PlanStep,
  type Project,
  type Run,
  type TestCase,
  type TestRevision,
  validate,
} from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import { type EntityDocument, OutboxRepository } from "@testmaster/persistence";
import { authoringTransaction } from "./authoring.js";
import type { ResolvedConfig } from "./config.js";
import { allEntities, entity, requireEntity, type ServiceContext } from "./context.js";
import { probeStepId } from "./runner-kinds.js";

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
  reason: string;
  /** The resolved Run limits a refusal named; binds the approval to exactly those limits. */
  limits?: Record<string, unknown>;
}
export type RiskClass = "read" | "write" | "destructive" | "securityProbe";

export interface RiskAction {
  stepId: string;
  risk: RiskClass;
  /** Short, machine-friendly and human-readable reason for `risk` (for example `text mentions "probe"`). */
  basis: string;
}

/** A declaration can increase risk, never downgrade a mutating operation. */
export function planRiskActions(plan: ExecutablePlan): RiskAction[] {
  const actions: RiskAction[] = [];
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
      let basis = `read-only operation "${step.operation}"`;
      if (step.operation === "request") {
        const { method } = step.input;
        if (method === "DELETE") {
          inferred = "destructive";
          basis = "HTTP method DELETE";
        } else if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
          inferred = "write";
          basis = `HTTP method ${method}`;
        } else if (step.input.body) {
          inferred = "write";
          basis = "request with body";
        } else if (step.input.resource) {
          inferred = "write";
          basis = "request with resource";
        } else basis = `read-only HTTP method ${method}`;
      } else if (!["navigate", "hover", "waitFor", "switchPage"].includes(step.operation)) {
        inferred = "write";
        basis = `operation "${step.operation}"`;
      }
      const meaning = `${step.description} ${JSON.stringify(step.input)}`;
      const destructive =
        /\b(delete|remove|destroy|purge|erase|reset|terminate|unsubscribe)\b/i.exec(meaning);
      const mutating =
        inferred === "read"
          ? /\b(create|update|save|purchase|payment|checkout|send|email|sms|password|auth|logout|charge)\b/i.exec(
              meaning,
            )
          : null;
      // The basis names what set the class: a word that only repeats it (DELETE) does not replace it.
      if (destructive && inferred !== "destructive") {
        inferred = "destructive";
        basis = `text mentions "${destructive[0].toLowerCase()}"`;
      } else if (mutating) {
        inferred = "write";
        basis = `text mentions "${mutating[0].toLowerCase()}"`;
      }
      const probe = /\b(fuzz|load[- ]?test|stress|probe|penetration|injection|exploit)\b/i.exec(
        meaning,
      );
      if (probe) {
        inferred = "securityProbe";
        basis = `text mentions "${probe[0].toLowerCase()}"`;
      }
      const declared = step.risk ?? "read";
      actions.push(
        severity[declared] > severity[inferred]
          ? { stepId: step.id, risk: declared, basis: `declared risk "${declared}"` }
          : { stepId: step.id, risk: inferred, basis },
      );
    }
  };
  visit(plan.steps);
  for (const cleanup of plan.cleanup ?? []) {
    const destructive = cleanup.input.method === "DELETE";
    actions.push({
      stepId: `cleanup:${cleanup.resourceRef}`,
      risk: destructive ? "destructive" : "write",
      basis: `cleanup HTTP method ${cleanup.input.method}`,
    });
    // The lookup lists items before anything is deleted: a read that the preview must still show.
    if (cleanup.find)
      actions.push({
        stepId: `cleanup-find:${cleanup.resourceRef}`,
        risk: "read",
        basis: `cleanup lookup HTTP method ${cleanup.find.lookup.method}`,
      });
  }
  return actions;
}

const approvalPolicyExtension = "testmaster:approvalPolicy";

export class ApprovalsService {
  constructor(
    readonly ctx: ServiceContext,
    readonly config?: ResolvedConfig,
  ) {}
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
  /** The project's approval policy; a project without one needs one approver and no separation. */
  private policyFor(projectId: string): ApprovalPolicy {
    const project = requireEntity(this.ctx, "Project", projectId);
    const stored = (project.extensions as Record<string, unknown> | undefined)?.[
      approvalPolicyExtension
    ] as
      | {
          requiredApprovers: 1 | 2;
          separationOfDuties: boolean;
          updatedAt: string;
          updatedBy: string;
        }
      | undefined;
    return {
      projectId,
      requiredApprovers: stored?.requiredApprovers ?? 1,
      separationOfDuties: stored?.separationOfDuties ?? false,
      version: Number(project.version ?? 1),
      updatedAt: stored?.updatedAt ?? null,
      updatedBy: stored?.updatedBy ?? null,
    };
  }
  policy(projectId: string): ApprovalPolicy {
    this.ctx.authorize("R", projectId);
    return this.policyFor(projectId);
  }
  /** Administrators set how many independent reviewers must approve and whether requesters are excluded. */
  setPolicy(
    projectId: string,
    input: ApprovalPolicyInput,
    expectedVersion: number,
  ): ApprovalPolicy {
    this.ctx.authorize("A", projectId);
    if (![1, 2].includes(input.requiredApprovers) || typeof input.separationOfDuties !== "boolean")
      throw new ContractError("INVALID_ARGUMENT", "Approval policy needs 1 or 2 approvers");
    if (input.requiredApprovers === 2 && !input.separationOfDuties)
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Two independent approvers require separation of duties",
        { field: "separationOfDuties" },
      );
    return authoringTransaction(this.ctx, () => {
      const current = requireEntity(this.ctx, "Project", projectId) as Stored<Project>;
      if (current.version !== expectedVersion)
        throw new ContractError("REVISION_CONFLICT", "Entity version changed", {
          currentVersion: current.version,
        });
      const before = this.policyFor(projectId);
      const next = {
        ...current,
        extensions: {
          ...current.extensions,
          [approvalPolicyExtension]: {
            requiredApprovers: input.requiredApprovers,
            separationOfDuties: input.separationOfDuties,
            updatedAt: new Date().toISOString(),
            updatedBy: this.ctx.principalId,
          },
        },
        version: expectedVersion + 1,
      };
      validate("Project", next);
      this.ctx.entities.update("Project", this.ctx.workspaceId, projectId, expectedVersion, next);
      this.audit("approval.policy.set", projectId, semanticHash(before), semanticHash(input));
      return this.policyFor(projectId);
    });
  }
  /**
   * Picks the approvals that satisfy the project's policy: one per distinct reviewer, never
   * the requester when separation of duties applies. Throws `approval_required` when too few.
   */
  private independentApprovals(
    candidates: Stored<Approval>[],
    requesterId: string,
    policy: ApprovalPolicy,
    check: (candidate: Stored<Approval>) => void,
    refusal: () => never = () => {
      throw new ContractError("POLICY_DENIED", "Approval policy is not satisfied", {
        reasonCode: "approval_required",
        requiredApprovers: policy.requiredApprovers,
        separationOfDuties: policy.separationOfDuties,
      });
    },
  ): Stored<Approval>[] {
    const chosen: Stored<Approval>[] = [];
    const reviewers: Record<string, true> = {};
    for (const candidate of candidates) {
      if (chosen.length >= policy.requiredApprovers) break;
      if (reviewers[candidate.reviewerId]) continue;
      if (policy.separationOfDuties && candidate.reviewerId === requesterId) continue;
      check(candidate);
      reviewers[candidate.reviewerId] = true;
      chosen.push(candidate);
    }
    if (chosen.length < policy.requiredApprovers) return refusal();
    return chosen;
  }
  private executionBinding(
    revision: Stored<TestRevision>,
    environment: Stored<EnvironmentRevision>,
    limits?: unknown,
  ) {
    const references = new Set<string>();
    const collect = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "secretRef" && typeof child === "string") references.add(child);
        else collect(child);
      }
    };
    collect(revision.plan);
    collect(revision.probe);
    collect(environment.variables);
    const authProfiles = environment.authProfileRefs.map((id) =>
      requireEntity(this.ctx, "AuthProfile", id),
    );
    for (const profile of authProfiles)
      for (const id of profile.secretRefs as string[]) references.add(id);
    const credentials = [...references].sort().map((id) => {
      const secret = requireEntity(this.ctx, "SecretReference", id);
      // A managed credential is rewritten by token refresh; approving it binds the slot (id and
      // origins), never its current version, so refreshing does not void an approval.
      if (secret.managedBy) return { id, managed: true, allowedOrigins: secret.allowedOrigins };
      return {
        id,
        secretVersion: secret.secretVersion,
        allowedOrigins: secret.allowedOrigins,
        revokedAt: secret.revokedAt ?? null,
        metadataHash: semanticHash(secret),
      };
    });
    const effectiveLimits = { ...this.config?.effectiveConfig.config.execution } as Record<
      string,
      unknown
    >;
    delete effectiveLimits.executor;
    delete effectiveLimits.mode;
    delete effectiveLimits.concurrency;
    for (const [key, value] of Object.entries(this.config?.profilePolicy.limits ?? {}))
      if (typeof value === "number" && typeof effectiveLimits[key] === "number")
        effectiveLimits[key] = Math.min(value, effectiveLimits[key] as number);
    return {
      candidateDigest: revision.contentHash,
      environmentId: environment.id,
      origins: [...environment.targetOrigins].sort(),
      credentials,
      privilegeHash: semanticHash(authProfiles),
      limits: limits ?? effectiveLimits,
    };
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
          "reason",
          "limits",
        ].includes(key)
      )
        throw new ContractError("INVALID_ARGUMENT", "Unknown approval field", { field: key });
    }
    if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 200)
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Approval requires a reason of 1 to 200 characters",
        { field: "reason" },
      );
    // The CLI and MCP pass `limits` through as copied; only the schema says what a limit may be.
    validate("ApprovalInput", input);
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
      if (reviewer.disabledAt)
        throw new ContractError("FORBIDDEN", "Execution approvals require an enabled reviewer");
      const policy = this.policyFor(projectId);
      if (policy.separationOfDuties && (input.actorId ?? this.ctx.principalId) === reviewerId)
        throw new ContractError(
          "FORBIDDEN",
          "Separation of duties: the requester cannot approve their own execution",
          { reason: "separation_of_duties" },
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
        reason: input.reason,
      }) as Stored<Approval>;
      validate("Approval", value);
      if (
        policy.requiredApprovers > 1 &&
        (allEntities(this.ctx, "Approval") as Stored<Approval>[]).some(
          (existing) =>
            existing.reviewerId === reviewerId &&
            existing.actorId === value.actorId &&
            existing.revisionHash === value.revisionHash &&
            existing.environmentRevisionId === value.environmentRevisionId &&
            existing.policyHash === value.policyHash &&
            !existing.revokedAt &&
            Date.parse(existing.expiresAt) > now,
        )
      )
        throw new ContractError(
          "FORBIDDEN",
          "Each independent approver may approve a binding once",
          { reason: "duplicate_approver" },
        );
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
      let resourceDigestValid = false;
      let bindingRevision = revision;
      let bindingLimits: unknown = input.limits;
      if (value.actionSet.length === 1 && value.actionSet[0]?.startsWith("cleanup:")) {
        const resourceId = value.actionSet[0].slice("cleanup:".length);
        const resource = requireEntity(this.ctx, "ResourceRecord", resourceId);
        const attempt = requireEntity(this.ctx, "Attempt", String(resource.creatorAttemptId));
        const run = requireEntity(this.ctx, "Run", String(attempt.runId));
        const test = requireEntity(this.ctx, "TestCase", String(run.testId));
        this.ctx.authorize("W", String(test.projectId));
        const env = requireEntity(
          this.ctx,
          "EnvironmentRevision",
          String(run.environmentRevisionId),
        );
        const cell = run.matrixCell as Record<string, unknown>;
        bindingRevision = requireEntity(
          this.ctx,
          "TestRevision",
          String(run.revisionId),
        ) as Stored<TestRevision>;
        bindingLimits = cell.limits;
        const cleanup = resource.cleanupPlan as { declaration?: unknown };
        const digest = semanticHash({
          resourceId,
          creatorAttemptId: resource.creatorAttemptId,
          ownerProof: resource.ownerProof,
          cleanup: cleanup.declaration,
          environmentRevisionId: env.id,
          networkPolicy: {
            allowedOrigins: env.targetOrigins,
            baseUrl: cell.baseUrl,
            networkProfile: env.networkProfile,
          },
        });
        resourceDigestValid =
          test.projectId === projectId &&
          env.id === value.environmentRevisionId &&
          digest === value.revisionHash;
      }
      if (!revision && !resourceDigestValid)
        throw new ContractError("NOT_FOUND", "Approval digest does not belong to this project");
      this.ctx.entities.insert("Approval", value);
      if (bindingRevision) {
        const environment = requireEntity(
          this.ctx,
          "EnvironmentRevision",
          input.environmentRevisionId,
        ) as Stored<EnvironmentRevision>;
        this.ctx.database.run(
          "INSERT INTO operational_state(key,value) VALUES(?,?)",
          `approval:binding:${this.ctx.workspaceId}:${value.id}`,
          JSON.stringify(this.executionBinding(bindingRevision, environment, bindingLimits)),
        );
      }
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
      id?: string;
      actorId?: string;
      origin?: Run["origin"];
      matrixCell?: Run["matrixCell"];
    },
    test: TestCase,
    env: EnvironmentRevision,
    cleanup?: {
      approvalId?: string;
      resourceId: string;
      digest: string;
      origins: string[];
      policyHash: string;
    },
  ): Stored<Approval> | null {
    const cell =
      run.matrixCell && typeof run.matrixCell === "object"
        ? (run.matrixCell as Record<string, unknown>)
        : {};
    const healing =
      run.origin === "verification" && typeof cell.healingProposalId === "string"
        ? requireEntity(this.ctx, "HealingProposal", cell.healingProposalId)
        : null;
    if (healing) {
      const failed = requireEntity(this.ctx, "Run", String(healing.failedRunId));
      const policy = run.gatePolicy as Record<string, unknown>;
      if (
        healing.status !== "approved" ||
        healing.testId !== run.testId ||
        healing.candidateRevisionId !== run.revisionId ||
        failed.environmentRevisionId !== env.id ||
        healing.policyHash !== policy.policyHash
      )
        throw new ContractError("POLICY_DENIED", "Healing verification binding changed");
      if (healing.approvalMode === "policy") {
        if (env.production || healing.reviewerId !== null)
          throw new ContractError("POLICY_DENIED", "Policy verification is not authorized");
        this.ctx.authorize("X", test.projectId);
      } else {
        if (healing.reviewerId !== this.ctx.principalId)
          throw new ContractError("FORBIDDEN", "Verification reviewer does not match actor");
        this.ctx.authorize("W", test.projectId);
      }
    } else this.ctx.authorize("X", test.projectId);
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
      if (cleanup) {
        const approval = cleanup.approvalId
          ? (requireEntity(this.ctx, "Approval", cleanup.approvalId) as Stored<Approval>)
          : null;
        const bindsCleanup = (candidate: Stored<Approval>): boolean =>
          candidate.actorId === this.ctx.principalId &&
          candidate.revisionHash === cleanup.digest &&
          candidate.environmentRevisionId === environment.id &&
          candidate.policyHash === cleanup.policyHash &&
          candidate.actionSet.includes(`cleanup:${cleanup.resourceId}`) &&
          !candidate.revokedAt &&
          Date.parse(candidate.expiresAt) > Date.now() &&
          cleanup.origins.every((origin) => candidate.originSet.includes(origin));
        if (!approval || !bindsCleanup(approval))
          throw new ContractError(
            "POLICY_DENIED",
            "Manual compensation requires resource-bound approval",
            { reasonCode: "approval_required" },
          );
        const approvalPolicy = this.policyFor(test.projectId);
        // The named approval first, then any other independent reviewer who bound the same cleanup.
        const chosen = this.independentApprovals(
          [
            approval,
            ...(allEntities(this.ctx, "Approval") as Stored<Approval>[]).filter(
              (candidate) => candidate.id !== approval.id && bindsCleanup(candidate),
            ),
          ],
          approval.actorId,
          approvalPolicy,
          (candidate) => {
            const binding = this.ctx.database.get(
              "SELECT value FROM operational_state WHERE key=?",
              `approval:binding:${this.ctx.workspaceId}:${candidate.id}`,
            );
            if (
              !binding ||
              semanticHash(JSON.parse(String(binding.value))) !==
                semanticHash(
                  this.executionBinding(
                    revision,
                    environment,
                    (run.matrixCell as Record<string, unknown> | undefined)?.limits,
                  ),
                )
            )
              throw new ContractError(
                "PRECONDITION_FAILED",
                "Cleanup approval execution binding changed",
                { reasonCode: "binding_mismatch" },
              );
            const reviewer = requireEntity(this.ctx, "Principal", candidate.reviewerId);
            if (reviewer.disabledAt)
              throw new ContractError("POLICY_DENIED", "Approval reviewer is no longer enabled");
          },
        );
        for (const used of chosen) {
          const consumed = {
            ...used,
            revokedAt: new Date().toISOString(),
            version: Number(used.version) + 1,
          };
          this.ctx.entities.update(
            "Approval",
            this.ctx.workspaceId,
            used.id,
            Number(used.version),
            consumed,
          );
          this.audit("approval.consumed", used.id, semanticHash(used), semanticHash(consumed));
        }
        return approval;
      }
      // A Run through a tunnel reaches a developer's machine: it needs a bound approval naming
      // the tunnel even outside production (ADR-031, SEC-039).
      const tunnelAction = typeof cell.tunnelId === "string" ? `tunnel:${cell.tunnelId}` : null;
      if (!revision.plan && !revision.probe && !tunnelAction) {
        const policy = run.gatePolicy as Record<string, unknown>;
        if (!environment.production && revision.codeRef && policy.executor === "docker")
          return null;
        throw new ContractError(
          "POLICY_DENIED",
          "Production or unsafe code execution requires a separately approved policy",
        );
      }
      const risky = revision.plan
        ? planRiskActions(revision.plan).filter((action) => action.risk !== "read")
        : [];
      // Outside production only the tunnel needs approving; risky actions are allowed there. A
      // probe sends generated traffic, so it needs a bound approval in every environment, consumed
      // by one Run (ADR-033, SEC-039).
      const actions: RiskAction[] = [
        ...(environment.production ? risky : []),
        ...(revision.probe
          ? [
              {
                stepId: probeStepId(revision),
                risk: "securityProbe" as const,
                basis: `${probeStepId(revision)} probe`,
              },
            ]
          : []),
      ];
      if (!tunnelAction && !actions.length) return null;
      const policy =
        run.gatePolicy && typeof run.gatePolicy === "object" && !Array.isArray(run.gatePolicy)
          ? (run.gatePolicy as Record<string, unknown>)
          : {};
      const policyHash =
        typeof policy.policyHash === "string" ? policy.policyHash : semanticHash(run.gatePolicy);
      // The approval names every origin the Run reaches, including a target override (VAL-043).
      const origins = new Set(environment.targetOrigins);
      if (typeof cell?.baseUrl === "string") origins.add(new URL(cell.baseUrl).origin);
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
      if (revision.plan) visit(revision.plan.steps);
      const actorId = run.actorId ?? this.ctx.principalId;
      const approvalPolicy = this.policyFor(test.projectId);
      const tunnelNamed = (candidate: Stored<Approval>) =>
        !tunnelAction || candidate.actionSet.includes(tunnelAction);
      const chosen = this.independentApprovals(
        (allEntities(this.ctx, "Approval") as Stored<Approval>[]).filter(
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
            ) &&
            tunnelNamed(candidate),
        ),
        actorId,
        approvalPolicy,
        (approval) => {
          const reviewer = requireEntity(this.ctx, "Principal", approval.reviewerId);
          if (reviewer.disabledAt)
            throw new ContractError("POLICY_DENIED", "Approval reviewer is no longer enabled", {
              reasonCode: "approval_required",
            });
          const binding = this.ctx.database.get(
            "SELECT value FROM operational_state WHERE key=?",
            `approval:binding:${this.ctx.workspaceId}:${approval.id}`,
          );
          if (
            !binding ||
            semanticHash(JSON.parse(String(binding.value))) !==
              semanticHash(this.executionBinding(revision, environment, cell?.limits))
          )
            throw new ContractError("PRECONDITION_FAILED", "Approval execution binding changed", {
              reasonCode: "binding_mismatch",
            });
        },
        () => {
          throw new ContractError(
            "POLICY_DENIED",
            !actions.length
              ? "A Run through a tunnel requires a current bound approval naming the tunnel"
              : revision.probe && !environment.production
                ? `A ${probeStepId(revision)} probe requires a current bound securityProbe approval`
                : approvalPolicy.requiredApprovers > 1
                  ? "Risky production actions require current bound approvals from independent reviewers"
                  : "Risky production actions require a current bound approval",
            {
              reasonCode: "approval_required",
              actions,
              requiredApprovers: approvalPolicy.requiredApprovers,
              separationOfDuties: approvalPolicy.separationOfDuties,
              // Everything `approval create` needs to bind an approval to this exact action.
              binding: {
                revisionHash: revision.contentHash,
                environmentRevisionId: environment.id,
                originSet: [...origins].sort(),
                actionSet: [
                  ...new Set([
                    ...actions.map((action) => action.risk),
                    ...(tunnelAction ? [tunnelAction] : []),
                  ]),
                ].sort(),
                policyHash,
                actorId,
                ...(cell?.limits === undefined ? {} : { limits: cell.limits }),
              },
            },
          );
        },
      );
      for (const approval of chosen) {
        this.audit("approval.verified", approval.id, null, revision.contentHash, run.id);
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
        this.audit(
          "approval.consumed",
          approval.id,
          semanticHash(approval),
          semanticHash(consumed),
          run.id,
        );
      }
      return chosen[0] as Stored<Approval>;
    });
  }
  private audit(
    action: string,
    resourceId: string,
    beforeHash: string | null,
    afterHash: string,
    requestId = resourceId,
  ): void {
    const event = entity(this.ctx, "aud", {
      actor: this.ctx.principalId,
      action,
      resourceId,
      requestId,
      beforeHash,
      afterHash,
      timestamp: new Date().toISOString(),
    });
    this.ctx.entities.insert("AuditEvent", event);
  }
}
