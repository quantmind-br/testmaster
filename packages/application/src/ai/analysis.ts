import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Analysis,
  ContractError,
  type ExecutablePlan,
  type PlanStep,
  type Run,
  reasonRegistry,
  type StepResult,
  validate,
} from "@testmaster/contracts";
import { canonicalJson, scrubEvidenceText, semanticHash } from "@testmaster/domain";
import {
  type AuxiliaryFence,
  type AuxiliaryJob,
  AuxiliaryLeaseRepository,
} from "@testmaster/persistence";
import { assessLocatorEquivalence, type LocatorEvidence } from "@testmaster/planner";
import { type ArtifactsService, isEvidenceUnavailable } from "../artifacts.js";
import { entity, requireEntity, type ServiceContext } from "../context.js";
import type { ModelService } from "./model.js";
import { promptVersions } from "./model.js";

export interface AnalysisInput {
  model?: boolean;
  budget?: { deadlineMs?: number };
}
export type AnalysisStatus = Run["analysisStatus"];
export type AnalysisEvidenceRef = Analysis["facts"][number]["evidenceRefs"][number];
type ModelOutput = {
  failureKind: Analysis["failureKind"];
  hypotheses: { text: string; supports: string[]; contradicts: string[]; confidence: number }[];
  recommendedAction: Analysis["recommendedAction"];
  fixTargetHandle: string | null;
  limitations: string[];
};
type Evidence = {
  ref: AnalysisEvidenceRef;
  value: unknown;
  text: string;
  reason?: string | undefined;
  step?: StepResult;
  planStep?: PlanStep | undefined;
};

function planSteps(plan: ExecutablePlan | null): PlanStep[] {
  const result: PlanStep[] = [];
  const visit = (steps: PlanStep[]) => {
    for (const step of steps) {
      result.push(step);
      if (step.operation === "frame") visit(step.input.childSteps);
    }
  };
  if (plan) visit(plan.steps);
  return result;
}
function authorizedRun(ctx: ServiceContext, runId: string, scope: "R" | "X" = "R"): Run {
  ctx.authorize(scope);
  const run = requireEntity(ctx, "Run", runId) as unknown as Run;
  const test = requireEntity(ctx, "TestCase", run.testId);
  ctx.authorize(scope, String(test.projectId));
  return run;
}

/** Resolve execution references against scoped persisted rows, never a guessed file path. */
export async function resolveAnalysisEvidence(
  ctx: ServiceContext,
  artifacts: ArtifactsService,
  runId: string,
  ref: AnalysisEvidenceRef,
): Promise<unknown> {
  const run = authorizedRun(ctx, runId);
  validate("EvidenceRef", ref);
  if (ref.sourceRevisionId)
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Source references are not execution evidence; resolve them through the authorized CodeSnapshot manifest",
    );
  if (ref.runId && ref.runId !== runId)
    throw new ContractError("INVALID_ARGUMENT", "Evidence belongs to another Run");
  if (ref.attemptId) {
    const attempt = requireEntity(ctx, "Attempt", ref.attemptId);
    if (attempt.runId !== runId)
      throw new ContractError("INVALID_ARGUMENT", "Evidence Attempt belongs to another Run");
  }
  let value: unknown;
  if (ref.stepId) {
    if (!ref.runId || !ref.attemptId)
      throw new ContractError("INVALID_ARGUMENT", "Step evidence requires Run and Attempt binding");
    const rows = ctx.database.all(
      "SELECT data_json FROM steps WHERE workspace_id=? AND attempt_id=? AND (id=? OR plan_step_id=?)",
      ctx.workspaceId,
      ref.attemptId,
      ref.stepId,
      ref.stepId,
    );
    if (rows.length !== 1)
      throw new ContractError("INVALID_ARGUMENT", "Step evidence is missing or ambiguous");
    value = JSON.parse(String(rows[0]!.data_json));
    if (ref.observationSeq !== undefined) {
      const observation = ctx.database.get(
        "SELECT data_json FROM observations WHERE workspace_id=? AND attempt_id=? AND seq=?",
        ctx.workspaceId,
        ref.attemptId,
        ref.observationSeq,
      );
      const payload = observation
        ? (JSON.parse(String(observation.data_json)) as { payload?: { stepId?: string } })
        : null;
      if (payload?.payload?.stepId !== (value as StepResult).planStepId)
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Step and observation compound binding mismatch",
        );
    }
  } else if (ref.observationSeq !== undefined) {
    if (!ref.runId) throw new ContractError("INVALID_ARGUMENT", "Observation requires Run binding");
    const rows = ref.attemptId
      ? ctx.database.all(
          "SELECT o.data_json FROM observations o JOIN attempts a ON a.workspace_id=o.workspace_id AND a.id=o.attempt_id WHERE a.workspace_id=? AND a.run_id=? AND o.seq=? AND a.id=?",
          ctx.workspaceId,
          runId,
          ref.observationSeq,
          ref.attemptId,
        )
      : ctx.database.all(
          "SELECT data_json FROM outbox WHERE workspace_id=? AND aggregate_id=? AND seq=?",
          ctx.workspaceId,
          runId,
          ref.observationSeq,
        );
    if (rows.length !== 1)
      throw new ContractError("INVALID_ARGUMENT", "Observation evidence is missing or ambiguous");
    value = JSON.parse(String(rows[0]!.data_json));
  } else if (ref.artifactId || ref.relativePath || ref.snapshotId) {
    const bundle = await artifacts.get(runId, ref.attemptId ? { attemptId: ref.attemptId } : {});
    if (ref.snapshotId && bundle.manifest.snapshotId !== ref.snapshotId)
      throw new ContractError("INVALID_ARGUMENT", "Evidence snapshot binding mismatch");
    const entry = bundle.manifest.entries.find(
      (item) =>
        (!ref.artifactId || item.artifactId === ref.artifactId) &&
        (!ref.relativePath || item.relativePath === ref.relativePath),
    );
    if (!entry || entry.state !== "available" || entry.redactionStatus === "restrictedRaw")
      throw new ContractError("PRECONDITION_FAILED", "Evidence is unavailable or restricted");
    const artifact = requireEntity(ctx, "Artifact", entry.artifactId);
    if (
      artifact.runId !== runId ||
      artifact.revisionId !== run.revisionId ||
      artifact.state !== "available" ||
      ctx.database.get(
        "SELECT 1 FROM operational_state WHERE key=?",
        `retention:artifact:${ctx.workspaceId}:${entry.artifactId}`,
      )
    )
      throw new ContractError("PRECONDITION_FAILED", "Evidence has expired or been revoked");
    if (ref.contentHash && entry.sha256 !== ref.contentHash)
      throw new ContractError("INVALID_ARGUMENT", "Artifact evidence hash mismatch");
    return artifacts.read(runId, entry.relativePath, {
      attemptId: bundle.manifest.attemptId,
      maxBytes: 262144,
    });
  } else if (ref.runId && !ref.attemptId && !ref.sourceRevisionId) value = run;
  else throw new ContractError("INVALID_ARGUMENT", "Unsupported execution evidence reference");
  if (!ref.contentHash || semanticHash(value) !== ref.contentHash)
    throw new ContractError("INVALID_ARGUMENT", "Execution evidence hash mismatch");
  // Mixed references must satisfy both bindings, rather than silently ignoring the file binding.
  if (ref.snapshotId || ref.artifactId || ref.relativePath)
    await resolveAnalysisEvidence(ctx, artifacts, runId, {
      ...(ref.snapshotId ? { snapshotId: ref.snapshotId } : {}),
      ...(ref.artifactId ? { artifactId: ref.artifactId } : {}),
      ...(ref.relativePath ? { relativePath: ref.relativePath } : {}),
      ...(ref.attemptId ? { runId, attemptId: ref.attemptId } : {}),
    });
  return value;
}

export class AnalysisService {
  readonly jobs: AuxiliaryLeaseRepository;
  constructor(
    readonly ctx: ServiceContext,
    readonly model: ModelService,
    readonly artifacts: ArtifactsService,
  ) {
    this.jobs = new AuxiliaryLeaseRepository(ctx.database);
  }
  get(runId: string): Analysis | null {
    authorizedRun(this.ctx, runId);
    const row = this.ctx.database.get(
      "SELECT data_json FROM analyses WHERE workspace_id=? AND run_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
      this.ctx.workspaceId,
      runId,
    );
    return row ? (JSON.parse(String(row.data_json)) as Analysis) : null;
  }
  analysisStatus(runId: string): AnalysisStatus {
    const analysis = this.get(runId);
    if (
      this.jobs
        .forTarget(this.ctx.workspaceId, "analysis", runId)
        .some((job) => ["queued", "leased", "reconciliation_required"].includes(job.state))
    )
      return "pending";
    return analysis ? (analysis.limitations.length ? "partial" : "complete") : "not_requested";
  }
  private persist(
    fields: Omit<Analysis, "id" | "workspaceId" | "createdAt" | "version" | "extensions">,
    fence?: AuxiliaryFence,
  ): Analysis {
    const result = entity(this.ctx, "ana", fields);
    validate("Analysis", result);
    const apply = () => {
      this.ctx.entities.insert("Analysis", result);
      if (fence) this.jobs.finish(fence, "completed", { analysisId: result.id });
      return result as unknown as Analysis;
    };
    return this.ctx.database.db.isTransaction ? apply() : this.ctx.database.withTx(apply);
  }
  private async collect(run: Run): Promise<{
    evidence: Evidence[];
    snapshotId: Analysis["snapshotId"];
    limitations: string[];
    plan: ExecutablePlan | null;
  }> {
    const revision = requireEntity(this.ctx, "TestRevision", run.revisionId);
    if (revision.testId !== run.testId)
      throw new ContractError("INVALID_ARGUMENT", "Frozen revision binding mismatch");
    const plan = revision.plan as ExecutablePlan | null;
    const steps = planSteps(plan);
    const limitations: string[] = [];
    const evidence: Evidence[] = [];
    let snapshotId: Analysis["snapshotId"] = null;
    for (const row of this.ctx.database.all(
      "SELECT s.data_json FROM steps s JOIN attempts a ON a.workspace_id=s.workspace_id AND a.id=s.attempt_id WHERE a.workspace_id=? AND a.run_id=? ORDER BY a.number,s.step_index",
      this.ctx.workspaceId,
      run.id,
    )) {
      let step: StepResult;
      try {
        step = JSON.parse(String(row.data_json)) as StepResult;
        const {
          workspaceId: _workspaceId,
          createdAt: _createdAt,
          version: _version,
          ...wire
        } = step as StepResult & Record<string, unknown>;
        validate("StepResult", wire);
      } catch (error) {
        if (
          !(error instanceof SyntaxError) &&
          !(error instanceof ContractError && error.code === "INVALID_ARGUMENT")
        )
          throw error;
        limitations.push("Malformed persisted step was excluded.");
        continue;
      }
      const planStep = steps.find((item) => item.id === step.planStepId);
      evidence.push({
        value: step,
        step,
        planStep,
        reason: step.reasonCode,
        ref: {
          runId: run.id,
          attemptId: step.attemptId,
          stepId: step.id,
          contentHash: semanticHash(step),
        },
        text: `Step ${step.planStepId} (${planStep?.operation ?? "unmapped"}) was ${step.status}${step.reasonCode ? `: ${step.reasonCode}` : ""}.`,
      });
    }
    for (const row of this.ctx.database.all(
      "SELECT o.data_json,o.seq,o.attempt_id FROM observations o JOIN attempts a ON a.workspace_id=o.workspace_id AND a.id=o.attempt_id WHERE a.workspace_id=? AND a.run_id=? ORDER BY a.number,o.seq",
      this.ctx.workspaceId,
      run.id,
    )) {
      let value: { type?: string; payload?: { reasonCode?: string } };
      try {
        value = JSON.parse(String(row.data_json));
        validate("RunnerEvent", value);
      } catch (error) {
        if (
          !(error instanceof SyntaxError) &&
          !(error instanceof ContractError && error.code === "INVALID_ARGUMENT")
        )
          throw error;
        limitations.push("Malformed persisted observation was excluded.");
        continue;
      }
      evidence.push({
        value,
        reason: value.payload?.reasonCode,
        ref: {
          runId: run.id,
          attemptId: String(row.attempt_id),
          observationSeq: Number(row.seq),
          contentHash: semanticHash(value),
        },
        text: `Persisted ${value.type} observation${value.payload?.reasonCode ? `: ${value.payload.reasonCode}` : ""}.`,
      });
    }
    for (const row of this.ctx.database.all(
      "SELECT seq,type,data_json FROM outbox WHERE workspace_id=? AND aggregate_id=? AND type IN ('run.execution_error','attempt.worker_lost','run.completed') ORDER BY seq",
      this.ctx.workspaceId,
      run.id,
    )) {
      const value = JSON.parse(String(row.data_json)) as {
        reasonCode?: string;
        diagnosticCode?: string;
      };
      const reason =
        typeof value.reasonCode === "string" && Object.hasOwn(reasonRegistry, value.reasonCode)
          ? value.reasonCode
          : undefined;
      const diagnostic =
        typeof value.diagnosticCode === "string" &&
        ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"].includes(value.diagnosticCode)
          ? value.diagnosticCode
          : null;
      evidence.push({
        value,
        reason: reason ?? (diagnostic ? "network_unreachable" : undefined),
        ref: { runId: run.id, observationSeq: Number(row.seq), contentHash: semanticHash(value) },
        text: `Persisted ${String(row.type)} observation${reason ? `: ${reason}` : diagnostic ? `: ${diagnostic}` : ""}.`,
      });
    }
    try {
      const bundle = await this.artifacts.get(run.id);
      snapshotId = bundle.manifest.snapshotId;
      for (const entry of bundle.manifest.entries) {
        if (entry.state !== "available") {
          limitations.push(`Artifact ${entry.artifactId} is ${entry.state}.`);
          continue;
        }
        if (entry.redactionStatus === "restrictedRaw") {
          limitations.push(`Restricted raw artifact ${entry.artifactId} was not inspected.`);
          continue;
        }
        const stored = requireEntity(this.ctx, "Artifact", entry.artifactId);
        if (
          stored.state !== "available" ||
          this.ctx.database.get(
            "SELECT 1 FROM operational_state WHERE key=?",
            `retention:artifact:${this.ctx.workspaceId}:${entry.artifactId}`,
          )
        ) {
          limitations.push(`Artifact ${entry.artifactId} is expired or revoked.`);
          continue;
        }
        const ref = {
          runId: run.id,
          attemptId: bundle.manifest.attemptId,
          snapshotId,
          artifactId: entry.artifactId,
          relativePath: entry.relativePath,
          ...(entry.sha256 ? { contentHash: entry.sha256 } : {}),
        };
        let value: unknown = { kind: entry.kind, state: entry.state, hash: entry.sha256 };
        if (entry.kind === "locator-evidence" && entry.sizeBytes <= 262144) {
          const page = await this.artifacts.read(run.id, entry.relativePath, {
            attemptId: bundle.manifest.attemptId,
            maxBytes: 262144,
          });
          try {
            value = JSON.parse(Buffer.from(page.bytes).toString("utf8"));
          } catch {
            limitations.push(`Malformed locator evidence ${entry.artifactId} was excluded.`);
            continue;
          }
        }
        evidence.push({
          ref,
          value,
          text: `Verified ${entry.kind} artifact ${entry.artifactId} is available.`,
        });
      }
    } catch (error) {
      if (!isEvidenceUnavailable(error)) throw error;
      limitations.push(
        "Committed evidence bundle is unavailable; diagnosis uses persisted execution records only.",
      );
    }
    if (!plan)
      limitations.push(
        "Frozen revision has no executable plan; business assertion semantics are unavailable.",
      );
    if (!evidence.length)
      limitations.push("No persisted step or observation evidence is available.");
    return { evidence, snapshotId, limitations: [...new Set(limitations)], plan };
  }
  private async factual(run: Run, fence: AuxiliaryFence): Promise<Analysis> {
    const collected = await this.collect(run);
    const { evidence, plan } = collected;
    let failureKind: Analysis["failureKind"] = "unknown";
    let recommendedAction: Analysis["recommendedAction"] = "collect_more_evidence";
    let hypothesis: string | null = null;
    let supports: AnalysisEvidenceRef[] = [];
    const reasons = (codes: string[]) =>
      evidence.filter((item) => item.reason && codes.includes(item.reason));
    if (run.outcome !== "passed") {
      const security = reasons([
        "security_precondition_failed",
        "approval_required",
        "egress_denied",
        "redaction_failed",
      ]);
      const environment = reasons([
        "missing_secret",
        "credential_revoked",
        "manual_auth_required",
        "auth_checkpoint_expired",
        "unsupported_capability",
        "worker_lost",
        "worker_lease_expired",
        "tunnel_lost",
        "storage_unavailable",
        "network_unreachable",
      ]);
      const network = evidence.filter((item) => {
        const error = item.step?.error?.code;
        return (
          error && ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"].includes(error)
        );
      });
      const schema = evidence.find(
        (item) =>
          item.step?.status === "failed" &&
          item.step.reasonCode === "assertion_mismatch" &&
          item.planStep?.kind === "assertion" &&
          item.planStep.expectation.predicate === "jsonSchema" &&
          item.step.observed !== null,
      );
      const business = evidence.find(
        (item) =>
          item.step?.status === "failed" &&
          item.step.reasonCode === "assertion_mismatch" &&
          item.planStep?.kind === "assertion" &&
          item.planStep.required !== false &&
          [
            "jsonEquals",
            "textEquals",
            "textContains",
            "valueEquals",
            "statusIn",
            "headerEquals",
            "downloadMatches",
          ].includes(item.planStep.expectation.predicate) &&
          item.step.observed !== null &&
          item.step.expected !== null &&
          semanticHash(item.step.observed) !== semanticHash(item.step.expected),
      );
      let locatorSupport: AnalysisEvidenceRef[] = [];
      if (!security.length && !environment.length && !network.length && !schema && !business) {
        const failedActions = evidence.filter(
          (item) =>
            item.step?.status === "failed" &&
            item.planStep?.kind === "action" &&
            "locator" in item.planStep.input,
        );
        for (const failed of failedActions) {
          const observed = evidence.filter(
            (item) =>
              (item.value as Partial<LocatorEvidence>)?.schemaVersion === "1.0.0" &&
              (item.value as Partial<LocatorEvidence>)?.stepId === failed.step!.planStepId,
          );
          if (!observed.length) continue;
          const baselines = this.ctx.database.all(
            "SELECT id FROM runs WHERE workspace_id=? AND test_id=? AND revision_id=? AND environment_revision_id=? AND outcome='passed' AND gate='passed' AND id<>? ORDER BY created_at DESC,id DESC LIMIT 20",
            this.ctx.workspaceId,
            run.testId,
            run.revisionId,
            run.environmentRevisionId,
            run.id,
          );
          for (const row of baselines) {
            const baseline = await this.collect(authorizedRun(this.ctx, String(row.id)));
            const records = baseline.evidence.filter(
              (item) => (item.value as Partial<LocatorEvidence>)?.schemaVersion === "1.0.0",
            );
            const failedRecords = observed.map((item) => item.value as LocatorEvidence);
            for (const record of failedRecords)
              for (const control of record.candidates ?? []) {
                if (!control.role || !control.name) continue;
                if (
                  assessLocatorEquivalence(
                    records.map((item) => item.value as LocatorEvidence),
                    failedRecords,
                    failed.step!.planStepId,
                    { by: "role", role: control.role, name: control.name, exact: true },
                  ).equivalent
                ) {
                  locatorSupport = [failed.ref, ...observed.map((item) => item.ref)];
                  break;
                }
              }
            if (locatorSupport.length) break;
          }
          if (locatorSupport.length) break;
        }
      }
      if (security.length) {
        failureKind = "security_policy";
        recommendedAction = "fix_environment";
        hypothesis =
          "Execution was refused by an observed security or evidence-sanitization precondition.";
        supports = security.map((item) => item.ref);
      } else if (environment.length || network.length) {
        failureKind = "environment";
        recommendedAction = "fix_environment";
        hypothesis =
          "Observed credentials, worker, preflight or network conditions prevented reliable execution.";
        supports = [...environment, ...network].map((item) => item.ref);
      } else if (schema) {
        failureKind = "contract_violation";
        recommendedAction = "review_contract";
        hypothesis =
          "An observed response mismatched the approved schema assertion; source-level cause is not established.";
        supports = [schema.ref];
      } else if (business) {
        failureKind = "product_bug";
        recommendedAction = "fix_product";
        hypothesis =
          "A required business assertion observed a value different from its frozen expectation; this is evidence of a product behavior mismatch, not a proven source-level root cause.";
        supports = [business.ref];
      } else if (locatorSupport.length) {
        failureKind = "test_fragility";
        recommendedAction = "fix_test";
        hypothesis =
          "The original locator was absent while exactly one semantically equivalent control from a passing baseline was observed; selector fragility is possible.";
        supports = locatorSupport;
      } else
        collected.limitations.push(
          "Available evidence does not establish a failure cause; timeout or HTTP response alone is not a diagnosis.",
        );
    }
    return this.persist(
      {
        runId: run.id,
        snapshotId: collected.snapshotId,
        parentId: null,
        source: "rules",
        affectedRequirementIds: [...new Set(plan?.requirementRefs ?? [])],
        facts: [
          {
            text: `Run finished with outcome ${run.outcome} and gate ${run.gate}.`,
            evidenceRefs: [{ runId: run.id, contentHash: semanticHash(run) }],
          },
          ...evidence.map((item) => ({ text: item.text, evidenceRefs: [item.ref] })),
        ],
        hypotheses: hypothesis
          ? [
              {
                text: hypothesis,
                supports,
                contradicts: evidence
                  .filter((item) => item.step?.status === "passed")
                  .map((item) => item.ref),
                confidence: 0.5,
                calibrated: false,
              },
            ]
          : [],
        failureKind,
        confidence: hypothesis ? 0.5 : null,
        modelCallId: null,
        limitations: [...new Set(collected.limitations)],
        recommendedAction,
      },
      fence,
    );
  }
  private limited(factual: Analysis, limitation: string, fence?: AuxiliaryFence): Analysis {
    const {
      id: _id,
      workspaceId: _workspace,
      createdAt: _created,
      version: _version,
      extensions: _extensions,
      ...fields
    } = factual;
    return this.persist(
      {
        ...fields,
        parentId: factual.id,
        source: "model",
        modelCallId: null,
        limitations: [...new Set([...factual.limitations, limitation])],
      },
      fence,
    );
  }
  private async enrich(
    run: Run,
    factual: Analysis,
    input: AnalysisInput,
    fence: AuxiliaryFence,
  ): Promise<Analysis> {
    const refs = [
      ...new Map(
        factual.facts.flatMap((fact) => fact.evidenceRefs).map((ref) => [canonicalJson(ref), ref]),
      ).values(),
    ];
    const catalog = new Map(refs.map((ref, index) => [`E${index + 1}`, ref]));
    const resolve = (handles: string[]) =>
      handles.map((handle) => {
        const ref = catalog.get(handle);
        if (!ref)
          throw new ContractError("INVALID_ARGUMENT", "Model cited unknown execution evidence");
        return ref;
      });
    // The prompt includes only fixed summaries and numeric/boolean measurements, never raw captures,
    // arbitrary response strings, traces, DOM, source, request bodies or credentials.
    const measurements: Record<string, unknown>[] = [];
    for (const [handle, ref] of catalog) {
      const value = await resolveAnalysisEvidence(this.ctx, this.artifacts, run.id, ref);
      if (ref.stepId) {
        const step = value as StepResult;
        measurements.push({
          evidenceId: handle,
          stepId: step.planStepId,
          status: step.status,
          reasonCode: step.reasonCode ?? null,
          expected:
            typeof step.expected === "number" || typeof step.expected === "boolean"
              ? step.expected
              : null,
          observed:
            typeof step.observed === "number" || typeof step.observed === "boolean"
              ? step.observed
              : null,
        });
      }
    }
    const projectId = String(requireEntity(this.ctx, "TestCase", run.testId).projectId);
    this.jobs.mark(fence, { paidCallStarted: true, factualAnalysisId: factual.id });
    const result = await this.model.complete<ModelOutput>({
      projectId,
      runId: run.id,
      purpose: "analyze",
      responseSchema: "AIAnalysisOutput",
      ...(input.budget?.deadlineMs !== undefined ? { deadlineMs: input.budget.deadlineMs } : {}),
      dataClasses: ["execution_evidence"],
      inputRefs: refs.map((ref) => semanticHash(ref)),
      data: {
        outcome: run.outcome,
        rulesFailureKind: factual.failureKind,
        facts: factual.facts.map((fact) => ({
          text: scrubEvidenceText(fact.text).text,
          supports: fact.evidenceRefs.map(
            (ref) => `E${refs.findIndex((item) => canonicalJson(item) === canonicalJson(ref)) + 1}`,
          ),
        })),
        measurements,
        limitations: factual.limitations,
      },
      instructions:
        "Analyze sanitized execution evidence only. Cite supplied E handles. Separate hypotheses from observed facts and retain contrary passed-step evidence. HTTP 500 is a response, never locator drift or proof of source root cause. Timeout alone is unknown. A passed Run must have failureKind unknown, no hypotheses and collect_more_evidence. Do not invent source files, evidence, facts or IDs. No source target is provided: fixTargetHandle must be null. Abstain when cause is unsupported.",
    });
    validate("AIAnalysisOutput", result.output);
    const output = result.output;
    if (output.fixTargetHandle !== null)
      throw new ContractError(
        "INVALID_ARGUMENT",
        "No authorized code snapshot fix target was supplied",
      );
    if (
      run.outcome === "passed" &&
      (output.failureKind !== "unknown" ||
        output.hypotheses.length ||
        output.recommendedAction !== "collect_more_evidence")
    )
      throw new ContractError("INVALID_ARGUMENT", "Model invented a failure in a passed Run");
    // A model may refine a rules abstention with cited hypotheses, but never contradict a rules-derived cause.
    if (
      output.failureKind !== "unknown" &&
      factual.failureKind !== "unknown" &&
      output.failureKind !== factual.failureKind
    )
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Model cause contradicts the rules-derived factual cause",
      );
    if (output.failureKind !== "unknown" && !output.hypotheses.length)
      throw new ContractError("INVALID_ARGUMENT", "A model cause requires cited hypotheses");
    const hypotheses = output.hypotheses.map((hypothesis) => {
      if (!hypothesis.supports.length)
        throw new ContractError("INVALID_ARGUMENT", "A model hypothesis requires observed support");
      const supports = resolve(hypothesis.supports);
      const contradicts = resolve(hypothesis.contradicts);
      return {
        text: scrubEvidenceText(hypothesis.text).text,
        supports,
        contradicts: [
          ...new Map(
            [...contradicts, ...factual.hypotheses.flatMap((item) => item.contradicts)].map(
              (ref) => [canonicalJson(ref), ref],
            ),
          ).values(),
        ],
        confidence: hypothesis.confidence,
        calibrated: false,
      };
    });
    const {
      id: _id,
      workspaceId: _ws,
      createdAt: _created,
      version: _version,
      extensions: _extensions,
      ...fields
    } = factual;
    return this.persist(
      {
        ...fields,
        source: "model",
        parentId: factual.id,
        modelCallId: result.modelCallId,
        failureKind: output.failureKind,
        recommendedAction: output.recommendedAction,
        hypotheses,
        confidence: hypotheses.length
          ? Math.max(...hypotheses.map((item) => item.confidence))
          : null,
        limitations: [
          ...new Set([
            ...factual.limitations,
            ...output.limitations.map((value) => scrubEvidenceText(value).text),
          ]),
        ],
      },
      fence,
    );
  }
  private receipt(job: AuxiliaryJob): Analysis | null {
    const id = job.result?.analysisId;
    return typeof id === "string"
      ? (requireEntity(this.ctx, "Analysis", id) as unknown as Analysis)
      : null;
  }
  private async drive(job: AuxiliaryJob, run: Run): Promise<Analysis> {
    if (job.payload.actorId !== this.ctx.principalId)
      throw new ContractError(
        "FORBIDDEN",
        "Analysis job must be dispatched by its authenticated actor",
      );
    authorizedRun(this.ctx, run.id, "X");
    const receipt = this.receipt(job);
    if (receipt) return receipt;
    if (job.state === "cancelled")
      throw new ContractError("PRECONDITION_FAILED", "Analysis job was cancelled", {
        jobId: job.jobId,
      });
    const input = validate<AnalysisInput>("AnalysisInput", job.payload.options);
    const fence = this.jobs.claim({
      workspaceId: this.ctx.workspaceId,
      owner: `analysis-${randomUUID()}`,
      queue: "analysis",
      jobId: job.jobId,
      leaseMs: 240000,
    });
    if (!fence) {
      const deadline = Date.now() + (input.budget?.deadlineMs ?? 180000);
      while (Date.now() < deadline) {
        this.jobs.expire();
        const current = this.jobs.get(this.ctx.workspaceId, job.jobId)!;
        const stored = this.receipt(current);
        if (stored) return stored;
        if (current.state === "cancelled")
          throw new ContractError("PRECONDITION_FAILED", "Analysis job was cancelled", {
            jobId: job.jobId,
          });
        if (current.state === "reconciliation_required") return this.settlePaid(current);
        if (current.state === "queued") return this.drive(current, run);
        await delay(50);
      }
      throw new ContractError("PRECONDITION_FAILED", "Analysis job is still pending", {
        jobId: job.jobId,
      });
    }
    const factualRow = this.ctx.database.get(
      "SELECT data_json FROM analyses WHERE workspace_id=? AND run_id=? AND source='rules' ORDER BY created_at,id LIMIT 1",
      this.ctx.workspaceId,
      run.id,
    );
    let analysis: Analysis;
    try {
      if (input.model) {
        const factual = factualRow ? (JSON.parse(String(factualRow.data_json)) as Analysis) : null;
        if (!factual)
          throw new ContractError(
            "PRECONDITION_FAILED",
            "Factual diagnosis is required before enrichment",
          );
        try {
          analysis = await this.enrich(run, factual, input, fence);
        } catch (error) {
          if (
            error instanceof ContractError &&
            ["FORBIDDEN", "UNAUTHENTICATED"].includes(error.code)
          )
            throw error;
          analysis = this.limited(
            factual,
            // ContractError messages are code-owned rule names, so they identify which
            // validation rejected the output without echoing model or evidence content.
            `Model enrichment abstained: ${error instanceof ContractError ? `${error.code}: ${error.message}` : "provider_or_validation_failure"}.`,
            fence,
          );
        }
      } else analysis = await this.factual(run, fence);
      return analysis;
    } catch (error) {
      const current = this.jobs.get(this.ctx.workspaceId, job.jobId);
      if (current?.progress.paidCallStarted)
        this.jobs.finish(fence, "cancelled", {
          reason: "authorization_or_evidence_failure",
          unknownUsage: true,
        });
      else this.jobs.release(fence, new Date().toISOString());
      throw error;
    }
  }
  async analyze(runId: string, input: AnalysisInput = {}): Promise<Analysis> {
    validate("AnalysisInput", input);
    const run = authorizedRun(this.ctx, runId, "X");
    if (run.phase !== "completed" || run.outcome === null)
      throw new ContractError("PRECONDITION_FAILED", "Only terminal Runs can be analyzed");
    const evidenceHash = semanticHash({
      run,
      steps: this.ctx.database.all(
        "SELECT s.data_json FROM steps s JOIN attempts a ON a.workspace_id=s.workspace_id AND a.id=s.attempt_id WHERE a.workspace_id=? AND a.run_id=? ORDER BY a.number,s.step_index",
        this.ctx.workspaceId,
        runId,
      ),
      observations: this.ctx.database.all(
        "SELECT o.data_json FROM observations o JOIN attempts a ON a.workspace_id=o.workspace_id AND a.id=o.attempt_id WHERE a.workspace_id=? AND a.run_id=? ORDER BY a.number,o.seq",
        this.ctx.workspaceId,
        runId,
      ),
      terminalEvents: this.ctx.database.all(
        "SELECT seq,type,data_json FROM outbox WHERE workspace_id=? AND aggregate_id=? AND type IN ('run.execution_error','attempt.worker_lost','run.completed') ORDER BY seq",
        this.ctx.workspaceId,
        runId,
      ),
      snapshots: this.ctx.database.all(
        "SELECT id,manifest_hash FROM snapshots WHERE workspace_id=? AND run_id=? ORDER BY created_at,id",
        this.ctx.workspaceId,
        runId,
      ),
    });
    const rules = this.jobs.enqueue(this.ctx.workspaceId, "analysis", {
      operation: "factual",
      targetId: runId,
      actorId: this.ctx.principalId,
      evidenceHash,
      configHash: semanticHash({ rules: "analysis-rules-1" }),
      options: {},
    }).job;
    const factual = await this.drive(rules, run);
    if (!input.model) return factual;
    const configHash = semanticHash({
      providers: this.model.config.modelProviders,
      policy: this.model.config.effectiveConfig.policyHash,
      prompt: promptVersions.analyze,
      deadlineMs: input.budget?.deadlineMs ?? 180000,
    });
    const job = this.jobs.enqueue(this.ctx.workspaceId, "analysis", {
      operation: "model",
      targetId: runId,
      actorId: this.ctx.principalId,
      evidenceHash,
      configHash,
      options: input as Record<string, unknown>,
    }).job;
    return this.drive(job, run);
  }
  private settlePaid(job: AuxiliaryJob): Analysis {
    authorizedRun(this.ctx, job.payload.targetId, "X");
    const id = job.progress.factualAnalysisId;
    if (typeof id !== "string")
      throw new ContractError("PRECONDITION_FAILED", "Paid analysis has no factual predecessor");
    return this.ctx.database.withTx(() => {
      const prior = this.receipt(this.jobs.get(this.ctx.workspaceId, job.jobId)!);
      if (prior) return prior;
      const factual = requireEntity(this.ctx, "Analysis", id) as unknown as Analysis;
      const analysis = this.limited(
        factual,
        "Paid analysis completion is uncertain; usage reservation retained and the model call was not reissued.",
      );
      this.jobs.settle(this.ctx.workspaceId, job.jobId, {
        analysisId: analysis.id,
        unknownUsage: true,
      });
      return analysis;
    });
  }
  async settlePending(): Promise<number> {
    this.jobs.expire();
    let settled = 0;
    for (const row of this.ctx.database.all(
      "SELECT id FROM job_leases WHERE workspace_id=? AND queue='analysis' AND state IN ('queued','reconciliation_required') ORDER BY created_at,id",
      this.ctx.workspaceId,
    )) {
      const job = this.jobs.get(this.ctx.workspaceId, String(row.id))!;
      if (job.payload.actorId !== this.ctx.principalId) continue;
      try {
        if (job.state === "reconciliation_required") {
          this.settlePaid(job);
          settled++;
        } else if (job.payload.operation === "factual") {
          await this.drive(job, authorizedRun(this.ctx, job.payload.targetId, "X"));
          settled++;
        } else if (job.payload.operation === "model") {
          authorizedRun(this.ctx, job.payload.targetId, "X");
          const row = this.ctx.database.get(
            "SELECT data_json FROM analyses WHERE workspace_id=? AND run_id=? AND source='rules' ORDER BY created_at,id LIMIT 1",
            this.ctx.workspaceId,
            job.payload.targetId,
          );
          const fence = this.jobs.claim({
            workspaceId: this.ctx.workspaceId,
            owner: `analysis-recovery-${randomUUID()}`,
            queue: "analysis",
            jobId: job.jobId,
          });
          if (row && fence) {
            this.limited(
              JSON.parse(String(row.data_json)) as Analysis,
              "Model enrichment was interrupted before dispatch; recovery abstained without issuing a paid call.",
              fence,
            );
            settled++;
          }
        }
      } catch (error) {
        if (!(error instanceof ContractError) && !isEvidenceUnavailable(error)) throw error;
        // Retained job records authorization/evidence refusal without changing the terminal Run.
      }
    }
    return settled;
  }
}
