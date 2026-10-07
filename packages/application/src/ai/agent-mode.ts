import { ContractError, type ExecutablePlan, type PlanStep, validate } from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import {
  assertionsHash,
  preserveAssertions,
  selectAction,
  validateObservation,
} from "@testmaster/planner";
import type { ResolvedConfig } from "../config.js";
import { entity, requireEntity, type ServiceContext } from "../context.js";
import { ModelService } from "./model.js";
export class AgentModeService {
  constructor(
    readonly ctx: ServiceContext,
    readonly config: ResolvedConfig,
  ) {}
  authorizeRevision(revisionId: string): void {
    const revision = requireEntity(this.ctx, "TestRevision", revisionId);
    const owner = requireEntity(this.ctx, "TestCase", String(revision.testId));
    this.ctx.authorize("X", String(owner.projectId));
    const proposalId = (revision.extensions as Record<string, unknown> | undefined)?.[
      "testmaster:proposalId"
    ];
    const proposal =
      typeof proposalId === "string" ? requireEntity(this.ctx, "Proposal", proposalId) : null;
    if (revision.origin !== "generated" || proposal?.state !== "accepted" || !revision.plan)
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Agent mode requires an accepted generated proposal revision",
      );
  }
  session(revisionId: string, origins: string[], signal?: AbortSignal, runId?: string) {
    this.authorizeRevision(revisionId);
    const revision = requireEntity(this.ctx, "TestRevision", revisionId);
    const test = requireEntity(this.ctx, "TestCase", String(revision.testId));
    const plan = validate<ExecutablePlan>("ExecutablePlan", revision.plan);
    const extensions = revision.extensions as Record<string, unknown> | undefined;
    const raw = extensions?.["testmaster:resolveSteps"] ?? [];
    if (
      !Array.isArray(raw) ||
      raw.some(
        (id) =>
          typeof id !== "string" ||
          !plan.steps.some((step) => step.id === id && step.kind === "action"),
      )
    )
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Resolution flags must name existing action steps",
      );
    const resolveSteps = raw as string[];
    const resolved = new Map<string, PlanStep>();
    let calls = 0;
    return {
      runnerInput: {
        resolveSteps,
        exploration: false,
        mutationStepIds: plan.steps
          .filter((step) => step.risk === "write" || step.risk === "destructive")
          .map((step) => step.id),
        maxRequests: Math.min(resolveSteps.length, 50),
      },
      resolveAction: async (stepId: string, value: unknown) => {
        if (!resolveSteps.includes(stepId) || ++calls > 50)
          throw new ContractError("POLICY_DENIED", "Resolution request is not admitted");
        const observation = validateObservation(value, origins);
        const result = await new ModelService(this.ctx, this.config).complete<{
          index: number | null;
        }>({
          projectId: String(test.projectId),
          ...(runId ? { runId } : {}),
          purpose: "resolve_action",
          responseSchema: "AgentActionSelection",
          data: { goal: plan.steps.find((step) => step.id === stepId)?.description, observation },
          dataClasses: ["dom", "plans"],
          instructions:
            "Select the index of the observed typed action matching the goal. Return null if ambiguous. Do not change assertions, targets or policy.",
          ...(signal ? { signal } : {}),
        });
        const action = selectAction(result.output, observation, stepId);
        if (!action)
          throw new ContractError("PRECONDITION_FAILED", "Action cannot be grounded uniquely");
        resolved.set(stepId, action);
        return action;
      },
      candidate: (runId: string) => {
        if (resolved.size !== resolveSteps.length) return null;
        const candidate = {
          ...plan,
          steps: plan.steps.map((step) => resolved.get(step.id) ?? step),
        };
        validate("ExecutablePlan", candidate);
        preserveAssertions(plan, candidate);
        this.ctx.authorize("W", String(test.projectId));
        return this.ctx.database.withTx(() => {
          const ordinal = Number(
            this.ctx.database.get(
              "SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM test_revisions WHERE workspace_id=? AND test_id=?",
              this.ctx.workspaceId,
              test.id,
            )?.n,
          );
          const value = entity(this.ctx, "rev", {
            testId: test.id,
            ordinal,
            contentHash: semanticHash(candidate, "plan"),
            plan: candidate,
            codeArtifactId: null,
            runnerKind: plan.runner,
            author: this.ctx.principalId,
            parentId: revision.id,
            origin: "generated",
            extensions: {
              "testmaster:agentRunId": runId,
              "testmaster:verificationRequired": true,
              "testmaster:preservedAssertionsHash": assertionsHash(candidate),
              "testmaster:deterministicAssertions": candidate.steps
                .filter((step) => step.kind === "assertion")
                .map((step) => step.id),
              "testmaster:semanticJudgments": [],
            },
          });
          this.ctx.entities.insert("TestRevision", value);
          return value;
        });
      },
    };
  }
}
