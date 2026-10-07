import { randomUUID } from "node:crypto";
import {
  ContractError,
  type ExecutablePlan,
  type HealingProposal,
  type Locator,
  type TestCase,
  type TestRevision,
  validate,
} from "@testmaster/contracts";
import { scrubEvidenceText, semanticHash } from "@testmaster/domain";
import {
  AuxiliaryLeaseRepository,
  type EntityDocument,
  OutboxRepository,
} from "@testmaster/persistence";
import {
  assertionsHash,
  assessLocatorEquivalence,
  type LocatorEvidence,
  waitStateEquivalence,
} from "@testmaster/planner";
import { planRiskActions, type RiskClass } from "../approvals.js";
import type { ArtifactsService } from "../artifacts.js";
import { authoringTransaction, promoteRevisionCas } from "../authoring.js";
import { allEntities, entity, requireEntity, type ServiceContext } from "../context.js";
import type { RunsService } from "../runs.js";
import { type AnalysisService, resolveAnalysisEvidence } from "./analysis.js";
import { applyHealingPatch, type HealingPatch } from "./healing-patch.js";
import type { ModelService } from "./model.js";

export interface HealingInput {
  budget?: { deadlineMs?: number };
}
type Stored = HealingProposal & EntityDocument;
export class HealingService {
  constructor(
    readonly ctx: ServiceContext,
    readonly model: ModelService,
    readonly runs: RunsService,
    readonly artifacts: ArtifactsService,
    readonly analysis: AnalysisService,
  ) {}
  get(proposalId: string): Stored {
    const proposal = requireEntity(this.ctx, "HealingProposal", proposalId) as Stored;
    this.runs.get(proposal.failedRunId);
    return proposal;
  }
  private latest(failedRunId: string): Stored | null {
    return (
      (allEntities(this.ctx, "HealingProposal") as Stored[]).find(
        (proposal) => proposal.failedRunId === failedRunId,
      ) ?? null
    );
  }
  private owner(proposal: Stored) {
    const run = this.runs.get(proposal.failedRunId);
    const test = requireEntity(this.ctx, "TestCase", proposal.testId) as TestCase & EntityDocument;
    return {
      run,
      test,
      environmentId: String((run.matrixCell as Record<string, unknown>).environmentId),
    };
  }
  async propose(failedRunId: string, input: HealingInput = {}): Promise<Stored> {
    validate("HealingInput", input);
    const run = this.runs.get(failedRunId);
    const test = requireEntity(this.ctx, "TestCase", run.testId);
    const projectId = String(test.projectId);
    this.ctx.authorize("W", projectId);
    this.ctx.authorize("X", projectId);
    if (run.phase !== "completed" || run.outcome !== "failed")
      throw new ContractError("PRECONDITION_FAILED", "Healing requires a terminal failed Run", {
        reason: "not_failed",
      });
    const existing = this.latest(failedRunId);
    if (existing) return existing;
    const revision = requireEntity(this.ctx, "TestRevision", run.revisionId) as TestRevision &
      EntityDocument;
    if (!revision.plan)
      throw new ContractError("PRECONDITION_FAILED", "Healing requires a declarative plan", {
        reason: "code_revision",
      });
    const base = validate<ExecutablePlan>("ExecutablePlan", revision.plan);
    const facts = this.analysis.get(failedRunId) ?? (await this.analysis.analyze(failedRunId, {}));
    const jobs = new AuxiliaryLeaseRepository(this.ctx.database);
    const prior = jobs.forTarget(this.ctx.workspaceId, "healing", failedRunId);
    if (prior.some((job) => job.progress.paidCallStarted || job.state !== "queued"))
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Healing request already settled or requires reconciliation",
        { reason: "no_regeneration", jobId: prior[0]?.jobId },
      );
    const { job } = jobs.enqueue(this.ctx.workspaceId, "healing", {
      operation: "propose",
      targetId: failedRunId,
      actorId: this.ctx.principalId,
      evidenceHash: semanticHash({ run: run.id, revision: revision.contentHash, facts }),
      configHash: semanticHash({
        providers: this.model.config.modelProviders.map(({ id, models }) => ({ id, models })),
        policy: this.model.config.effectiveConfig.policyHash,
      }),
      options: input as Record<string, unknown>,
    });
    const fence = jobs.claim({
      workspaceId: this.ctx.workspaceId,
      queue: "healing",
      jobId: job.jobId,
      owner: `healing:${randomUUID()}`,
      leaseMs: 240000,
    });
    if (!fence)
      throw new ContractError("PRECONDITION_FAILED", "Healing request is already running", {
        jobId: job.jobId,
      });
    if (fence.job.payload.actorId !== this.ctx.principalId) {
      jobs.finish(fence, "completed", { refused: true, reason: "actor_changed" });
      throw new ContractError("FORBIDDEN", "Healing job actor does not match authenticated actor");
    }
    const refuse = (reason: string): never => {
      jobs.finish(fence, "completed", { refused: true, reason });
      throw new ContractError("PRECONDITION_FAILED", "Healing abstained", {
        reason,
        jobId: job.jobId,
      });
    };
    if (["product_bug", "contract_violation", "security_policy"].includes(facts.failureKind))
      refuse("semantic_failure");
    const provider = this.model.config.modelProviders.find((value) =>
      this.model.config.profilePolicy.allowedModelProviders.includes(value.id),
    );
    if (!provider || !provider.models.some((value) => value.capabilities.structuredJson))
      refuse("provider_unavailable");
    const consent = await this.model.consent(projectId, provider!.id);
    if (!consent || !consent.dataClasses.includes("execution_evidence")) refuse("consent_required");
    try {
      const refs = facts.facts.flatMap((fact) => fact.evidenceRefs);
      const evidence: { evidenceId: string; ref: (typeof refs)[number] }[] = [];
      for (const ref of refs) {
        await resolveAnalysisEvidence(this.ctx, this.artifacts, failedRunId, ref);
        evidence.push({ evidenceId: `E${evidence.length + 1}`, ref });
      }
      if (!evidence.length) refuse("evidence_unavailable");
      const handles = new Map(evidence.map((item) => [item.evidenceId, item.ref]));
      // Only locator evidence for steps that did not pass can locate the drifted control; the
      // passed steps' candidate lists would push ordinary browser failures past the admitted
      // model input limit before any request is sent.
      const unresolvedSteps = new Set(
        this.runs
          .steps(failedRunId)
          .filter((step) => step.status !== "passed")
          .map((step) => String(step.planStepId)),
      );
      let locatorEvidence: LocatorEvidence[] = [];
      try {
        locatorEvidence = (await this.locatorRecords(failedRunId)).filter((record) =>
          unresolvedSteps.has(record.stepId),
        );
      } catch (error) {
        if (
          !(error instanceof ContractError) ||
          !["NOT_FOUND", "PRECONDITION_FAILED"].includes(error.code)
        )
          throw error;
      }
      const modelPlan = structuredClone(base);
      const steps = [...modelPlan.steps];
      for (let index = 0; index < steps.length; index++) {
        const step = steps[index]!;
        if (step.operation === "frame") steps.push(...step.input.childSteps);
        if (step.operation === "fill") step.input.value = { literal: "[REDACTED]" };
        if (step.operation === "request") {
          if (step.input.body) delete step.input.body;
          if (step.input.headers) delete step.input.headers;
          if (step.input.query) delete step.input.query;
        }
      }
      const secretValues = Object.entries(process.env)
        .filter(([name]) => /secret|token|password|credential|api_key/i.test(name))
        .flatMap(([, value]) => (value ? [value] : []));
      this.ctx.authorize("X", projectId);
      jobs.mark(fence, { paidCallStarted: true });
      const result = await this.model.complete<HealingPatch>({
        projectId,
        runId: failedRunId,
        purpose: "heal",
        responseSchema: "HealingPatch",
        data: JSON.parse(
          scrubEvidenceText(
            JSON.stringify({
              plan: modelPlan,
              locatorEvidence,
              // Evidence references (content hashes) stay local; the model cites handles only.
              facts: facts.facts.map((fact) => ({
                text: fact.text,
                evidenceHandles: fact.evidenceRefs.map(
                  (ref) =>
                    evidence.find((item) => semanticHash(item.ref) === semanticHash(ref))!
                      .evidenceId,
                ),
              })),
            }),
            secretValues,
          ).text,
        ),
        instructions:
          "Return replacement patches on existing action input fields only. Preserve every business assertion, response predicate, setup, cleanup, dependency, capture, risk, and time ceiling. Never change product code. Cite only supplied E evidence handles. Do not embed credentials: authentication edits use existing authorized secretRef values. Abstain if a semantic defect cannot be repaired without changing its oracle.",
        dataClasses: ["execution_evidence"],
        inputRefs: refs.map((ref) => semanticHash(ref)),
        ...input.budget,
      });
      const applied = applyHealingPatch(base, result.output);
      const evidenceRefs = applied.patch.evidenceHandles.map((handle) => {
        const ref = handles.get(handle);
        if (!ref)
          throw new ContractError("INVALID_ARGUMENT", "Healing cites unknown evidence handle", {
            handle,
          });
        return ref;
      });
      this.checkSecrets(base, applied.patch, run.environmentRevisionId);
      const assessment = await this.assessPolicy(run.id, base, applied.patch, applied.manualOnly);
      const proposal = authoringTransaction(this.ctx, () => {
        const raced = this.latest(failedRunId);
        if (raced) return raced;
        const owner = requireEntity(this.ctx, "TestCase", run.testId);
        if (owner.activeRevisionId !== run.revisionId)
          throw new ContractError("REVISION_CONFLICT", "Healing base is no longer active");
        const proposalId = entity(this.ctx, "hea", {}).id;
        const ordinal = Number(
          this.ctx.database.get(
            "SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM test_revisions WHERE workspace_id=? AND test_id=?",
            this.ctx.workspaceId,
            run.testId,
          )?.n,
        );
        const candidate = entity(this.ctx, "rev", {
          testId: run.testId,
          ordinal,
          contentHash: semanticHash(applied.plan, "plan"),
          plan: applied.plan,
          codeArtifactId: null,
          runnerKind: applied.plan.runner,
          author: this.ctx.principalId,
          parentId: revision.id,
          origin: "healed",
          extensions: {
            "testmaster:healingProposalId": proposalId,
            "testmaster:verificationRequired": true,
          },
        });
        this.ctx.entities.insert("TestRevision", candidate);
        const severity: RiskClass[] = ["read", "write", "destructive", "securityProbe"];
        const risk = planRiskActions(applied.plan).reduce<RiskClass>(
          (current, action) =>
            severity.indexOf(action.risk) > severity.indexOf(current) ? action.risk : current,
          "read",
        );
        const value = entity(this.ctx, "hea", {
          failedRunId,
          testId: run.testId,
          analysisId: facts.id,
          baseRevisionId: revision.id,
          candidateRevisionId: candidate.id,
          diff: scrubEvidenceText(applied.patch.explanation).text,
          changes: applied.patch.changes,
          evidenceRefs,
          preservedAssertionsHash: assertionsHash(base),
          risk,
          status: "proposed",
          approvalMode: null,
          reviewerId: null,
          policyHash: null,
          verificationRunId: null,
          modelCallId: result.modelCallId,
          limitations: assessment.reasons,
        }) as Stored;
        value.id = proposalId;
        validate("HealingProposal", value);
        this.ctx.entities.insert("HealingProposal", value);
        new OutboxRepository(this.ctx.database).append(
          this.ctx.workspaceId,
          value.id,
          "healing.proposed",
          { failedRunId, candidateRevisionId: candidate.id },
        );
        jobs.finish(fence, "completed", { proposalId: value.id });
        return value;
      });
      if (assessment.equivalent) {
        try {
          return await this.approvePolicy(proposal.id);
        } catch (error) {
          if (
            !(error instanceof ContractError) ||
            !["POLICY_DENIED", "PRECONDITION_FAILED", "REVISION_CONFLICT"].includes(error.code)
          )
            throw error;
          return this.get(proposal.id);
        }
      }
      return proposal;
    } catch (error) {
      const current = jobs.get(this.ctx.workspaceId, job.jobId);
      if (current?.state === "leased")
        jobs.finish(fence, "completed", {
          refused: true,
          reason: error instanceof ContractError ? error.code : "model_failure",
        });
      throw error instanceof ContractError &&
        [
          "FORBIDDEN",
          "REVISION_CONFLICT",
          "POLICY_DENIED",
          "INVALID_ARGUMENT",
          "PRECONDITION_FAILED",
        ].includes(error.code)
        ? error
        : new ContractError(
            "PRECONDITION_FAILED",
            "Healing model request did not produce an admissible candidate",
            { reason: "model_failure", jobId: job.jobId },
          );
    }
  }
  private checkSecrets(
    base: ExecutablePlan,
    patch: HealingPatch,
    environmentRevisionId: string,
  ): void {
    const env = requireEntity(this.ctx, "EnvironmentRevision", environmentRevisionId);
    const visit = (value: unknown, key = "") => {
      if (!value || typeof value !== "object") return;
      const object = value as Record<string, unknown>;
      if (
        object.name &&
        typeof object.name === "object" &&
        "literal" in object.name &&
        typeof object.name.literal === "string" &&
        /authorization|cookie|password|credential|api[-_]?key|token/i.test(object.name.literal) &&
        object.value &&
        typeof object.value === "object" &&
        "literal" in object.value
      )
        throw new ContractError(
          "POLICY_DENIED",
          "Authentication fields cannot carry inline credentials",
        );
      if (
        Object.hasOwn(object, "literal") &&
        /authorization|cookie|password|credential|api[-_]?key|token/i.test(key)
      )
        throw new ContractError(
          "POLICY_DENIED",
          "Authentication healing requires an existing secret reference",
        );
      if (typeof object.secretRef === "string") {
        const id = object.secretRef;
        const secret = requireEntity(this.ctx, "SecretReference", id);
        if (
          secret.revokedAt ||
          !(env.targetOrigins as string[]).every((origin) =>
            (secret.allowedOrigins as string[]).includes(origin),
          )
        )
          throw new ContractError(
            "POLICY_DENIED",
            "Healing secret is not authorized for the frozen origin",
          );
      }
      for (const [name, child] of Object.entries(object))
        visit(child, key ? `${key}.${name}` : name);
    };
    for (const change of patch.changes) {
      const steps = [...base.steps];
      for (let index = 0; index < steps.length; index++) {
        const step = steps[index]!;
        if (step.operation === "frame") steps.push(...step.input.childSteps);
      }
      const step = steps.find((step) => step.id === change.stepId)!;
      const authInput =
        step.operation === "fill" &&
        /password|credential|token|api[-_]?key/i.test(JSON.stringify(step.input.locator));
      visit(change.value, authInput ? "credential" : change.path);
    }
  }
  private async locatorRecords(runId: string): Promise<LocatorEvidence[]> {
    const bundle = await this.artifacts.get(runId);
    const records: LocatorEvidence[] = [];
    for (const entry of bundle.manifest.entries.filter(
      (entry) => entry.kind === "locator-evidence" && entry.state === "available",
    )) {
      const page = await this.artifacts.read(runId, entry.relativePath, { maxBytes: 262144 });
      if (page.nextOffset !== null)
        throw new ContractError("PRECONDITION_FAILED", "Locator evidence exceeds bounded size");
      records.push(JSON.parse(Buffer.from(page.bytes).toString("utf8")) as LocatorEvidence);
    }
    return records;
  }
  private async assessPolicy(
    runId: string,
    base: ExecutablePlan,
    patch: HealingPatch,
    manualOnly: boolean,
  ) {
    const reasons: string[] = [];
    const run = this.runs.get(runId),
      cell = run.matrixCell as Record<string, unknown>;
    const environment = requireEntity(this.ctx, "EnvironmentRevision", run.environmentRevisionId);
    const policy = this.model.config.effectiveConfig;
    const test = requireEntity(this.ctx, "TestCase", run.testId);
    const project = requireEntity(this.ctx, "Project", String(test.projectId));
    const extensions = project.extensions as Record<string, unknown> | undefined;
    if (extensions?.["testmaster:healingPolicy"] !== "apply")
      reasons.push("Project policy has not explicitly authorized automatic healing");
    if (manualOnly) reasons.push("Business input changes require manual review");
    if (environment.production) reasons.push("Production healing requires manual review");
    if (
      policy.config.healing?.mode !== "apply" ||
      (cell.effectiveConfig as typeof policy).config.healing?.mode !== "apply" ||
      (run.gatePolicy as Record<string, unknown>).policyHash !== policy.policyHash ||
      cell.healingPolicy !== "apply"
    )
      reasons.push("Policy application is not explicitly enabled and frozen");
    if (reasons.length) return { equivalent: false, reasons };
    const baseline = this.runs
      .list()
      .filter((candidate) => {
        const baselineCell = candidate.matrixCell as Record<string, unknown>;
        const baselinePolicy = candidate.gatePolicy as Record<string, unknown>;
        const baselineSnapshot = baselineCell.admissionSnapshot as Record<string, unknown>;
        const failedSnapshot = cell.admissionSnapshot as Record<string, unknown>;
        const comparable = (snapshot: Record<string, unknown>) => {
          const { inputHash: _inputHash, ...identity } = snapshot;
          return semanticHash(identity);
        };
        return (
          candidate.id !== runId &&
          candidate.testId === run.testId &&
          candidate.revisionId === run.revisionId &&
          candidate.environmentRevisionId === run.environmentRevisionId &&
          candidate.outcome === "passed" &&
          candidate.gate === "passed" &&
          baselineCell.baseUrl === cell.baseUrl &&
          baselinePolicy.policyHash === policy.policyHash &&
          comparable(baselineSnapshot) === comparable(failedSnapshot)
        );
      })
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (!baseline)
      return {
        equivalent: false,
        reasons: ["No comparable passing locator baseline; manual review required"],
      };
    try {
      const before = await this.locatorRecords(baseline.id),
        failed = await this.locatorRecords(runId);
      for (const change of patch.changes) {
        const steps = [...base.steps];
        for (let index = 0; index < steps.length; index++) {
          const step = steps[index]!;
          if (step.operation === "frame") steps.push(...step.input.childSteps);
        }
        if (steps.find((step) => step.id === change.stepId)?.operation === "frame") {
          reasons.push("Frame child-origin identity proof is unavailable; manual review required");
          continue;
        }
        if (["/input/source", "/input/destination"].includes(change.path)) {
          reasons.push(
            "Drag endpoint equivalence requires independently bound endpoint evidence; manual review required",
          );
          continue;
        }
        const assessment =
          change.path === "/input/state"
            ? waitStateEquivalence(
                before,
                failed,
                change.stepId,
                change.value as "attached" | "visible" | "hidden" | "detached",
              )
            : assessLocatorEquivalence(before, failed, change.stepId, change.value as Locator);
        if (!assessment.equivalent) reasons.push(...assessment.reasons);
      }
    } catch (error) {
      if (error instanceof ContractError && ["FORBIDDEN", "UNAUTHENTICATED"].includes(error.code))
        throw error;
      reasons.push("Locator equivalence evidence unavailable; manual review required");
    }
    return { equivalent: !reasons.length, reasons };
  }
  async approve(proposalId: string, expectedVersion: number): Promise<Stored> {
    const proposal = this.get(proposalId),
      { test, environmentId } = this.owner(proposal);
    this.ctx.authorizeNamed("approve", "HealingProposal", String(test.projectId), environmentId);
    return this.approveBound(proposal, expectedVersion, "manual");
  }
  private async approvePolicy(proposalId: string): Promise<Stored> {
    const proposal = this.get(proposalId),
      { test } = this.owner(proposal);
    this.ctx.authorize("X", test.projectId);
    return this.approveBound(proposal, Number(proposal.version), "policy");
  }
  private async approveBound(
    proposal: Stored,
    expectedVersion: number,
    mode: "manual" | "policy",
  ): Promise<Stored> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw new ContractError("INVALID_ARGUMENT", "Expected version is required");
    if (proposal.status === "verified") return proposal;
    if (proposal.status === "approved") {
      if (!proposal.verificationRunId) await this.runs.admitHealingVerification(proposal.id);
      return this.get(proposal.id);
    }
    if (proposal.status !== "proposed" || proposal.verificationRunId)
      throw new ContractError("PRECONDITION_FAILED", "Healing cannot start another verification");
    authoringTransaction(this.ctx, () => {
      const current = this.get(proposal.id),
        { run, test } = this.owner(current);
      if (current.version !== expectedVersion || test.activeRevisionId !== current.baseRevisionId)
        throw new ContractError("REVISION_CONFLICT", "Healing proposal or base changed");
      if (
        (run.gatePolicy as Record<string, unknown>).policyHash !==
        this.model.config.effectiveConfig.policyHash
      )
        throw new ContractError("REVISION_CONFLICT", "Healing policy changed");
      const candidate = requireEntity(
        this.ctx,
        "TestRevision",
        current.candidateRevisionId,
      ) as TestRevision & EntityDocument;
      if (!candidate.plan || assertionsHash(candidate.plan) !== current.preservedAssertionsHash)
        throw new ContractError("POLICY_DENIED", "Candidate assertions changed");
      const base = requireEntity(this.ctx, "TestRevision", current.baseRevisionId) as TestRevision &
        EntityDocument;
      if (!base.plan)
        throw new ContractError("PRECONDITION_FAILED", "Healing base has no declarative plan");
      const rebuilt = applyHealingPatch(base.plan, {
        changes: current.changes,
        evidenceHandles: ["E1"],
        explanation: current.diff,
      });
      if (semanticHash(rebuilt.plan, "plan") !== candidate.contentHash)
        throw new ContractError(
          "POLICY_DENIED",
          "Candidate does not match the authorized replacement patch",
        );
      this.checkSecrets(base.plan, rebuilt.patch, run.environmentRevisionId);
      this.ctx.entities.update(
        "HealingProposal",
        this.ctx.workspaceId,
        current.id,
        Number(current.version),
        {
          ...current,
          status: "approved",
          approvalMode: mode,
          reviewerId: mode === "manual" ? this.ctx.principalId : null,
          policyHash: this.model.config.effectiveConfig.policyHash,
          version: Number(current.version) + 1,
          extensions: { ...current.extensions, "testmaster:approvalActorId": this.ctx.principalId },
        },
      );
    });
    try {
      await this.runs.admitHealingVerification(proposal.id);
    } catch (error) {
      const current = this.get(proposal.id);
      if (!current.verificationRunId)
        this.ctx.entities.update(
          "HealingProposal",
          this.ctx.workspaceId,
          current.id,
          Number(current.version),
          {
            ...current,
            status: "proposed",
            limitations: [...current.limitations, "Verification admission refused"],
            version: Number(current.version) + 1,
          },
        );
      throw error;
    }
    return this.get(proposal.id);
  }
  reject(proposalId: string, reason: string): Stored {
    validate("HealingRejectInput", { reason });
    return authoringTransaction(this.ctx, () => {
      const current = this.get(proposalId),
        { test, environmentId } = this.owner(current);
      this.ctx.authorizeNamed("approve", "HealingProposal", test.projectId, environmentId);
      if (current.status === "rejected") return current;
      if (current.status !== "proposed")
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Only a reviewable proposal can be rejected",
        );
      const next = {
        ...current,
        status: "rejected" as const,
        limitations: [...current.limitations, scrubEvidenceText(reason).text],
        version: Number(current.version) + 1,
      };
      this.ctx.entities.update(
        "HealingProposal",
        this.ctx.workspaceId,
        current.id,
        Number(current.version),
        next,
      );
      return next;
    });
  }
  reconcile(verificationRunId: string): Stored {
    const verification = this.runs.get(verificationRunId);
    const proposal = (allEntities(this.ctx, "HealingProposal") as Stored[]).find(
      (item) => item.verificationRunId === verificationRunId,
    );
    if (!proposal) throw new ContractError("NOT_FOUND", "Run is not a bound healing verification");
    const { test: authorizedTest, environmentId } = this.owner(proposal);
    if (proposal.approvalMode === "manual")
      this.ctx.authorizeNamed(
        "approve",
        "HealingProposal",
        authorizedTest.projectId,
        environmentId,
      );
    else this.ctx.authorize("X", authorizedTest.projectId);
    if (
      proposal.status === "verified" ||
      proposal.status === "rejected" ||
      proposal.status === "proposed"
    )
      return proposal;
    if (verification.phase !== "completed") return proposal;
    const result = authoringTransaction(this.ctx, () => {
      const current = this.get(proposal.id),
        { test, run } = this.owner(current);
      if (current.status !== "approved") return current;
      if (
        verification.revisionId !== current.candidateRevisionId ||
        verification.environmentRevisionId !== run.environmentRevisionId ||
        verification.origin !== "verification" ||
        verification.mode !== "replay"
      )
        throw new ContractError("POLICY_DENIED", "Verification binding does not match proposal");
      if (verification.outcome !== "passed" || verification.gate !== "passed") {
        const next = {
          ...current,
          status: "proposed" as const,
          limitations: [
            ...current.limitations,
            `Verification did not pass: ${verification.outcome}/${verification.gate}`,
          ],
          version: Number(current.version) + 1,
        };
        this.ctx.entities.update(
          "HealingProposal",
          this.ctx.workspaceId,
          current.id,
          Number(current.version),
          next,
        );
        return next;
      }
      if (test.activeRevisionId !== current.baseRevisionId) {
        const next = {
          ...current,
          status: "proposed" as const,
          limitations: [...current.limitations, "REVISION_CONFLICT: active revision changed"],
          version: Number(current.version) + 1,
        };
        this.ctx.entities.update(
          "HealingProposal",
          this.ctx.workspaceId,
          current.id,
          Number(current.version),
          next,
        );
        return next;
      }
      const candidate = requireEntity(
        this.ctx,
        "TestRevision",
        current.candidateRevisionId,
      ) as TestRevision & EntityDocument;
      promoteRevisionCas(this.ctx, candidate, test, Number(test.version));
      const next = {
        ...current,
        status: "verified" as const,
        version: Number(current.version) + 1,
      };
      this.ctx.entities.update(
        "HealingProposal",
        this.ctx.workspaceId,
        current.id,
        Number(current.version),
        next,
      );
      new OutboxRepository(this.ctx.database).append(
        this.ctx.workspaceId,
        current.id,
        "healing.verified",
        { failedRunId: current.failedRunId, verificationRunId, healed: true },
      );
      return next;
    });
    if (result.limitations.some((limitation) => limitation.startsWith("REVISION_CONFLICT:")))
      throw new ContractError(
        "REVISION_CONFLICT",
        "Active revision changed; healing remains reviewable",
        { proposalId: result.id },
      );
    return result;
  }
  /** Deterministic restart reconciliation; paid proposal calls are never reissued. */
  async settlePending(): Promise<number> {
    let settled = 0;
    const jobs = new AuxiliaryLeaseRepository(this.ctx.database);
    jobs.expire();
    for (const row of this.ctx.database.all(
      "SELECT id FROM job_leases WHERE workspace_id=? AND queue='healing' AND state='reconciliation_required'",
      this.ctx.workspaceId,
    )) {
      const job = jobs.get(this.ctx.workspaceId, String(row.id));
      if (!job) continue;
      const proposal = this.latest(job.payload.targetId);
      jobs.settle(
        this.ctx.workspaceId,
        job.jobId,
        proposal
          ? { proposalId: proposal.id }
          : {
              refused: true,
              reason: "paid_call_completion_unknown",
              usage: "unknown",
              reservationRetained: true,
            },
      );
      settled++;
    }
    for (const proposal of allEntities(this.ctx, "HealingProposal") as Stored[]) {
      if (proposal.status !== "approved") continue;
      try {
        if (!proposal.verificationRunId) await this.runs.admitHealingVerification(proposal.id);
        const current = this.get(proposal.id);
        if (
          current.verificationRunId &&
          this.reconcile(current.verificationRunId).status !== "approved"
        )
          settled++;
      } catch (error) {
        if (
          !(error instanceof ContractError) ||
          !["REVISION_CONFLICT", "FORBIDDEN", "POLICY_DENIED", "PRECONDITION_FAILED"].includes(
            error.code,
          )
        )
          throw error;
      }
    }
    return settled;
  }
}
