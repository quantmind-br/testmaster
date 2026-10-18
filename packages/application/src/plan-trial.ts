import {
  ContractError,
  type ExecutablePlan,
  type PlanTrialReceipt,
  type Proposal,
  type ProposalBatch,
  type StepResult,
  validate,
} from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import type { EntityDocument } from "@testmaster/persistence";
import { validateProposalPlan } from "@testmaster/planner";
import type { ProposalsService } from "./ai/proposals.js";
import { allEntities, entity, requireEntity, type ServiceContext } from "./context.js";
import { runVerdict } from "./run-verdict.js";
import type { OwnedReceipt, RunsService } from "./runs.js";
import { TRIAL_EXTENSION, trialMarker } from "./trial-tests.js";

type StoredProposal = Proposal & EntityDocument;
type Trial = PlanTrialReceipt["trials"][number];

/** The trials a `plan trial` admitted: one run per tried proposal, the others with their reason. */
export interface PlanTrialAdmission {
  batchId: string;
  batchVersion: number;
  environmentId: string;
  items: {
    proposalId: string;
    proposalVersion: number;
    planName: string;
    run?: OwnedReceipt;
    reason?: string;
  }[];
}

/**
 * Replays the plans of proposals that are still `proposed` against an environment before anyone
 * accepts them, so a wrong pointer or value shows as a failed step instead of a false failure
 * found after acceptance. No model is called and no proposal or batch changes: each plan runs
 * from a hidden trial test (`testmaster:trial`, archived, no active revision) reused per proposal,
 * with one revision per plan content.
 */
export class PlanTrialService {
  constructor(
    readonly ctx: ServiceContext,
    private readonly proposals: ProposalsService,
    private readonly runs: RunsService,
  ) {}
  async admit(
    batchId: string,
    input: { environmentId: string; proposalIds?: readonly string[] },
  ): Promise<PlanTrialAdmission> {
    this.ctx.authorize("X");
    const { batch, proposals } = this.proposals.detail(batchId) as {
      batch: ProposalBatch & EntityDocument;
      proposals: StoredProposal[];
    };
    this.ctx.authorize("X", batch.projectId);
    const environment = requireEntity(this.ctx, "Environment", input.environmentId);
    if (environment.projectId !== batch.projectId || environment.archivedAt)
      throw new ContractError("PRECONDITION_FAILED", "Environment is not active in this project", {
        environmentId: input.environmentId,
      });
    const unknown = (input.proposalIds ?? []).filter(
      (id) => !proposals.some((proposal) => proposal.id === id),
    );
    if (unknown.length)
      throw new ContractError("INVALID_ARGUMENT", "Proposals are not in this batch", {
        proposalIds: unknown,
      });
    const selected = input.proposalIds?.length
      ? proposals.filter((proposal) => input.proposalIds?.includes(proposal.id))
      : proposals;
    const items: PlanTrialAdmission["items"] = [];
    for (const proposal of selected) {
      const item = {
        proposalId: proposal.id,
        proposalVersion: proposal.version ?? 1,
        planName: proposal.plan.name,
      };
      const refusal = untriable(proposal);
      if (refusal) {
        items.push({ ...item, reason: refusal });
        continue;
      }
      try {
        const { testId, revisionId } = this.trialRevision(batch, proposal);
        const run = await this.runs.admitTrial({
          testId,
          revisionId,
          environmentId: input.environmentId,
        });
        items.push({ ...item, run });
      } catch (error) {
        if (!(error instanceof ContractError)) throw error;
        items.push({ ...item, reason: `Admission refused: ${error.code} ${error.message}` });
      }
    }
    return {
      batchId: batch.id,
      batchVersion: Number(batch.version),
      environmentId: input.environmentId,
      items,
    };
  }
  /** The receipt once the admitted runs completed: outcome and the steps that did not pass. */
  receipt(admission: PlanTrialAdmission): PlanTrialReceipt {
    const trials = admission.items.map((item): Trial => {
      const base = {
        proposalId: item.proposalId,
        proposalVersion: item.proposalVersion,
        planName: item.planName,
      };
      if (!item.run)
        return { ...base, tried: false, reason: item.reason ?? "Not tried", failedSteps: [] };
      const run = this.runs.get(item.run.runId);
      const verdict = runVerdict(run, this.runs.events(run.id));
      return {
        ...base,
        tried: true,
        runId: run.id,
        outcome: run.outcome ?? null,
        gate: run.gate,
        cleanupOutcome: run.cleanupOutcome,
        ...(verdict.reasonCode ? { reasonCode: verdict.reasonCode } : {}),
        failedSteps: this.failedSteps(run.id),
      };
    });
    return validate<PlanTrialReceipt>("PlanTrialReceipt", {
      batchId: admission.batchId,
      batchVersion: admission.batchVersion,
      environmentId: admission.environmentId,
      trials,
    });
  }
  private failedSteps(runId: string): Trial["failedSteps"] {
    // Step results are schema-validated when the worker stores them.
    const steps = this.runs.steps(runId) as unknown as StepResult[];
    const lastAttempt = steps.at(-1)?.attemptId;
    return steps
      .filter((step) => step.attemptId === lastAttempt && step.status !== "passed")
      .map((step) => ({
        stepId: step.planStepId,
        status: step.status,
        ...(step.reasonCode ? { reasonCode: step.reasonCode } : {}),
        ...(step.error?.message ? { message: step.error.message } : {}),
        expected: step.expected,
        observed: step.observed,
      }));
  }
  /**
   * The hidden test of the proposal and its revision holding exactly this plan: both are reused
   * when the same plan is tried again, and an edited plan becomes the next revision.
   */
  private trialRevision(
    batch: ProposalBatch & EntityDocument,
    proposal: StoredProposal,
  ): { testId: string; revisionId: string } {
    const plan = proposal.plan as ExecutablePlan;
    const contentHash = semanticHash(plan, "plan");
    const marker = { batchId: batch.id, proposalId: proposal.id };
    return this.ctx.database.withTx(() => {
      let test = allEntities(this.ctx, "TestCase").find(
        (item) =>
          item.projectId === batch.projectId && trialMarker(item)?.proposalId === proposal.id,
      );
      if (!test) {
        test = entity(this.ctx, "tst", {
          projectId: batch.projectId,
          name: plan.name,
          activeRevisionId: null,
          tags: [],
          priority: "normal",
          archivedAt: new Date().toISOString(),
          extensions: { [TRIAL_EXTENSION]: marker },
        });
        this.ctx.entities.insert("TestCase", test);
      }
      const revisions = allEntities(this.ctx, "TestRevision").filter(
        (item) => item.testId === test.id,
      );
      const same = revisions.find((item) => item.contentHash === contentHash);
      if (same) return { testId: test.id, revisionId: same.id };
      const revision = entity(this.ctx, "rev", {
        testId: test.id,
        ordinal: revisions.length + 1,
        contentHash,
        plan,
        codeArtifactId: null,
        runnerKind: plan.runner,
        author: this.ctx.principalId,
        parentId: null,
        origin: "generated",
        extensions: { [TRIAL_EXTENSION]: marker },
      });
      this.ctx.entities.insert("TestRevision", revision);
      return { testId: test.id, revisionId: revision.id };
    });
  }
}

/** Why a proposal cannot be tried, or null when its plan can run as is. */
function untriable(proposal: StoredProposal): string | null {
  if (proposal.state !== "proposed") return `The proposal is ${proposal.state}, not proposed`;
  if (proposal.validation !== undefined && proposal.validation !== "valid")
    return `The proposal is ${proposal.validation}`;
  if (proposal.plan.kind !== "executable")
    return "The proposal holds an intent plan, which has no executable steps";
  try {
    validateProposalPlan(proposal.plan);
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    return `The plan is invalid: ${error.message}`;
  }
  if ((proposal.plan.dependsOn ?? []).some((binding) => binding.required))
    return "The plan depends on values another test captures; accept it with its producers and run them together";
  return null;
}
