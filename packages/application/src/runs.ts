import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  type BatchReceipt,
  type BatchRequest,
  ContractError,
  type DependencyBinding,
  type ExecutablePlan,
  type PlanStep,
  type Run,
  type RunReceipt,
  type RunRequest,
  validate,
} from "@testmaster/contracts";
import {
  aggregateBatch,
  type BatchMember,
  type DagNode,
  resolveDagClosure,
  semanticHash,
} from "@testmaster/domain";
import {
  type EntityDocument,
  IdempotencyRepository,
  LeaseRepository,
  OutboxRepository,
} from "@testmaster/persistence";
import type { ImageLock } from "@testmaster/sandbox";
import type { ResolvedConfig } from "./config.js";
import { allEntities, entity, requireEntity, type ServiceContext } from "./context.js";
import {
  type AdmissionSnapshot,
  admissionInputHash,
  admissionSnapshot,
  verifyAdmission,
} from "./provenance.js";
import { clockDomain, timingBoundary } from "./timing.js";

export interface AdmissionOptions {
  wait?: boolean;
  idempotencyKey?: string;
  unsafeLocal?: boolean;
}
export interface RunHost {
  config: ResolvedConfig;
  preflight(unsafeLocal?: boolean, executor?: string): Promise<void>;
  admittedImages(): ImageLock | null;
  verifyEvidence(id: string): Promise<void>;
  liveWorker(): boolean;
  verifyApproval(run: EntityDocument, test: EntityDocument, env: EntityDocument): void;
}
export type OwnedReceipt = RunReceipt & { ownership: "worker" | "ephemeral" };
export type ResolvedDependency = DependencyBinding & {
  producerRunId: string;
  producerRevisionId: string;
  producerEnvironmentRevisionId: string;
};
export function captureDeclarations(plan: ExecutablePlan) {
  const captures: { stepId: string; name: string; valueType: string; sensitive: boolean }[] = [];
  const visit = (steps: readonly PlanStep[]) => {
    for (const step of steps) {
      if (step.operation === "frame") visit(step.input.childSteps);
      if (step.operation === "request")
        for (const capture of step.input.capture ?? [])
          captures.push({ ...capture, stepId: step.id });
      if (step.operation === "request" && step.input.resource)
        captures.push({ stepId: step.id, name: "handle", valueType: "string", sensitive: true });
    }
  };
  visit(plan.steps);
  return captures;
}
export class RunsService {
  constructor(
    readonly ctx: ServiceContext,
    readonly host: RunHost,
  ) {}
  get(id: string): Run & EntityDocument {
    this.ctx.authorize("R");
    const run = requireEntity(this.ctx, "Run", id);
    const test = requireEntity(this.ctx, "TestCase", String(run.testId));
    this.ctx.authorize("R", String(test.projectId));
    return run as Run & EntityDocument;
  }
  list(): (Run & EntityDocument)[] {
    this.ctx.authorize("R");
    return allEntities(this.ctx, "Run").filter((run) => {
      try {
        this.get(run.id);
        return true;
      } catch {
        return false;
      }
    }) as (Run & EntityDocument)[];
  }
  events(id: string, afterSeq = -1): Record<string, unknown>[] {
    this.get(id);
    return this.ctx.database
      .all(
        "SELECT id,seq,type,created_at AS occurredAt,data_json AS payload FROM outbox WHERE workspace_id=? AND aggregate_id=? AND seq>? ORDER BY seq",
        this.ctx.workspaceId,
        id,
        afterSeq,
      )
      .map((row) => ({ ...row, payload: JSON.parse(String(row.payload)) }));
  }
  steps(id: string, attemptId?: string): EntityDocument[] {
    this.get(id);
    return this.ctx.database
      .all(
        "SELECT s.data_json FROM steps s JOIN attempts a ON a.workspace_id=s.workspace_id AND a.id=s.attempt_id WHERE a.workspace_id=? AND a.run_id=? AND (? IS NULL OR a.id=?) ORDER BY a.number,s.step_index",
        this.ctx.workspaceId,
        id,
        attemptId ?? null,
        attemptId ?? null,
      )
      .map((row) => JSON.parse(String(row.data_json)) as EntityDocument);
  }
  prepare(request: RunRequest, batchId: string | null = null): EntityDocument {
    validate("RunRequest", request);
    this.ctx.authorize("X");
    if (request.mode && !["replay", "agent"].includes(request.mode))
      throw new ContractError("INVALID_ARGUMENT", "Invalid execution mode");
    const test = requireEntity(this.ctx, "TestCase", request.testId);
    this.ctx.authorize("X", String(test.projectId));
    if (test.archivedAt) throw new ContractError("PRECONDITION_FAILED", "Test is archived");
    const revision = requireEntity(
      this.ctx,
      "TestRevision",
      request.revisionId ?? String(test.activeRevisionId),
    );
    if (revision.testId !== test.id || (!revision.plan && !revision.codeRef))
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Revision does not belong to test or has no executable plan",
      );
    if (request.mode === "agent") {
      const proposalId = (revision.extensions as Record<string, unknown> | undefined)?.[
        "testmaster:proposalId"
      ];
      const proposal =
        typeof proposalId === "string" ? requireEntity(this.ctx, "Proposal", proposalId) : null;
      if (revision.origin !== "generated" || proposal?.state !== "accepted" || !revision.plan)
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Agent mode requires an accepted generated proposal",
        );
      this.ctx.authorize("W", String(test.projectId));
    }
    const environment = requireEntity(this.ctx, "Environment", request.environmentId);
    if (environment.projectId !== test.projectId || environment.archivedAt)
      throw new ContractError("PRECONDITION_FAILED", "Environment is not active in this project");
    const env = requireEntity(
      this.ctx,
      "EnvironmentRevision",
      String(environment.activeRevisionId),
    );
    const config = this.host.config.effectiveConfig.config;
    if (
      config.artifacts?.trace === "on" ||
      config.artifacts?.video === "on" ||
      config.artifacts?.httpBodies === "on"
    ) {
      if (!this.ctx.authorizeRaw)
        throw new ContractError("FORBIDDEN", "Raw capture authorization is unavailable");
      this.ctx.authorizeRaw(String(test.projectId), environment.id);
      if (env.production) {
        const approval = allEntities(this.ctx, "Approval").some(
          (value) =>
            value.actorId === this.ctx.principalId &&
            !value.revokedAt &&
            Date.parse(String(value.expiresAt)) > Date.now() &&
            value.environmentRevisionId === env.id &&
            value.revisionHash === revision.contentHash &&
            value.policyHash === this.host.config.effectiveConfig.policyHash &&
            (value.actionSet as string[]).includes("artifacts:raw") &&
            semanticHash(value.originSet) === semanticHash(env.targetOrigins),
        );
        if (!approval)
          throw new ContractError(
            "POLICY_DENIED",
            "Production raw capture requires a matching current approval",
          );
      }
    }
    if (config.browser?.name !== "chromium" && config.browser?.name !== undefined)
      throw new ContractError("CAPABILITY_UNAVAILABLE", "Configured browser is unavailable", {
        capability: config.browser.name,
        milestone: "M5",
      });
    const limits = { ...config.execution, ...request.limits };
    delete limits.executor;
    delete limits.mode;
    delete limits.concurrency;
    validate("ExecutionLimits", limits);
    for (const [field, value] of Object.entries(this.host.config.profilePolicy.limits)) {
      const key = field as keyof typeof limits;
      if (typeof value === "number" && typeof limits[key] === "number")
        Object.assign(limits, { [field]: Math.min(limits[key] as number, value) });
    }
    const originalUrl = (env.targetOrigins as string[])[0];
    const targetUrl = request.extensions?.["testmaster:targetUrl"];
    const baseUrl = typeof targetUrl === "string" ? new URL(targetUrl).origin : originalUrl;
    if (this.host.config.profilePolicy.offline && env.networkProfile !== "local-loopback")
      throw new ContractError(
        "POLICY_DENIED",
        "Offline execution allows authorized local targets only",
      );
    if (baseUrl !== originalUrl && (env.authProfileRefs as string[]).length)
      throw new ContractError(
        "POLICY_DENIED",
        "Destination override cannot forward authentication to another origin",
      );
    const inspectSecrets = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [name, child] of Object.entries(value)) {
        if (name === "secretRef" && typeof child === "string") {
          const secret = requireEntity(this.ctx, "SecretReference", child);
          const allowedOrigins = secret.allowedOrigins as string[];
          if (secret.revokedAt || !baseUrl || !allowedOrigins.includes(baseUrl))
            throw new ContractError("POLICY_DENIED", "Secret origin is not authorized", {
              secretRef: child,
            });
        } else inspectSecrets(child);
      }
    };
    inspectSecrets(revision.plan);
    const executor =
      request.extensions?.["testmaster:executor"] ?? config.execution?.executor ?? "docker";
    const maxConcurrency =
      request.extensions?.["testmaster:maxConcurrency"] ?? config.execution?.concurrency ?? 2;
    const ownership = this.host.liveWorker() ? "worker" : "ephemeral";
    const provenance = admissionSnapshot(
      this.ctx,
      revision,
      env,
      this.host.config,
      executor === "process" ? null : this.host.admittedImages(),
      request.seed ?? 0,
    );
    const run = entity(this.ctx, "run", {
      testId: test.id,
      revisionId: revision.id,
      environmentRevisionId: env.id,
      batchId,
      matrixCell: {
        correlationId: this.ctx.correlationId ?? randomUUID(),
        environmentId: environment.id,
        environmentName: environment.name,
        planHash: revision.contentHash,
        baseUrl,
        effectiveConfig: structuredClone(this.host.config.effectiveConfig),
        limits,
        seed: request.seed ?? 0,
        ownership,
        maxConcurrency,
        executor,
        admissionSnapshot: provenance,
        admissionSnapshotHash: semanticHash(provenance),
      },
      mode: request.mode ?? "replay",
      phase: "queued",
      status: "queued",
      outcome: null,
      origin: request.origin ?? "cli",
      gatePolicy: {
        cleanupRequired: false,
        requiredEvidenceComplete: true,
        policySatisfied: true,
        requiredDependenciesPassed: true,
        policyHash: this.host.config.effectiveConfig.policyHash,
        ownership,
        executor,
      },
      gate: "pending",
      cleanupOutcome: "not_required",
      analysisStatus: "not_requested",
    });
    this.host.verifyApproval(run, test, env);
    return run;
  }
  prepareClosure(selection: readonly RunRequest[], batchId: string) {
    const prepared = new Map<string, EntityDocument>();
    const requests = new Map<string, RunRequest>();
    const nodes = new Map<string, DagNode>();
    const keyOf = (request: RunRequest, run: EntityDocument) =>
      semanticHash({
        ...request,
        revisionId: run.revisionId,
        environmentRevisionId: run.environmentRevisionId,
      });
    const add = (request: RunRequest): string => {
      const candidate = this.prepare(request, batchId);
      const key = keyOf(request, candidate);
      if (!prepared.has(key)) {
        prepared.set(key, candidate);
        requests.set(key, request);
      }
      return key;
    };
    const requestedKeys = selection.map(add);
    const visit = (key: string): void => {
      if (nodes.has(key)) return;
      const run = prepared.get(key)!;
      const request = requests.get(key)!;
      const revision = requireEntity(this.ctx, "TestRevision", String(run.revisionId));
      const plan = revision.plan ? validate<ExecutablePlan>("ExecutablePlan", revision.plan) : null;
      const dependencies: DagNode["dependencies"][number][] = [];
      nodes.set(key, {
        id: key,
        outputs: plan ? captureDeclarations(plan).map((capture) => capture.name) : [],
        dependencies,
      });
      const bindings: ResolvedDependency[] = [];
      for (const binding of plan?.dependsOn ?? []) {
        if (!binding.required) continue;
        if (binding.permittedEnvironment !== request.environmentId)
          throw new ContractError(
            "PRECONDITION_FAILED",
            "Dependency environment is not permitted",
            { reasonCode: "upstream_failed" },
          );
        const matches = [...prepared.entries()].filter(([, producer]) => {
          const cell = producer.matrixCell as Record<string, unknown>;
          const expectedCell = binding.producerCell as Record<string, unknown> | undefined;
          return (
            producer.testId === binding.producerTestId &&
            (!binding.producerRevisionId || producer.revisionId === binding.producerRevisionId) &&
            cell.environmentId === binding.permittedEnvironment &&
            (!expectedCell ||
              Object.entries(expectedCell).every(
                ([field, value]) => semanticHash(cell[field] ?? null) === semanticHash(value),
              ))
          );
        });
        if (matches.length > 1)
          throw new ContractError("PRECONDITION_FAILED", "Ambiguous producer", {
            reasonCode: "ambiguous_producer",
          });
        const producerKey =
          matches[0]?.[0] ??
          add({
            ...request,
            testId: binding.producerTestId,
            ...(binding.producerRevisionId ? { revisionId: binding.producerRevisionId } : {}),
            environmentId: binding.permittedEnvironment,
          });
        const producer = prepared.get(producerKey)!;
        const producerCell = producer.matrixCell as Record<string, unknown>;
        const expectedCell = binding.producerCell as Record<string, unknown> | undefined;
        if (
          expectedCell &&
          !Object.entries(expectedCell).every(
            ([field, value]) => semanticHash(producerCell[field] ?? null) === semanticHash(value),
          )
        )
          throw new ContractError("PRECONDITION_FAILED", "Producer cell does not match", {
            reasonCode: "upstream_failed",
          });
        const producerPlan = validate<ExecutablePlan>(
          "ExecutablePlan",
          requireEntity(this.ctx, "TestRevision", String(producer.revisionId)).plan,
        );
        const captures = captureDeclarations(producerPlan).filter(
          (capture) => capture.name === binding.outputName,
        );
        if (captures.length > 1)
          throw new ContractError("PRECONDITION_FAILED", "Ambiguous producer output", {
            reasonCode: "ambiguous_producer",
          });
        if (
          captures[0] &&
          (captures[0].sensitive !== binding.sensitive || captures[0].valueType !== binding.type)
        )
          throw new ContractError(
            "PRECONDITION_FAILED",
            "Dependency type or taint is incompatible",
            { reasonCode: "security_precondition_failed" },
          );
        dependencies.push({
          producerId: producerKey,
          outputName: binding.outputName,
          required: true,
        });
        bindings.push({
          ...binding,
          producerRunId: producer.id,
          producerRevisionId: String(producer.revisionId),
          producerEnvironmentRevisionId: String(producer.environmentRevisionId),
        });
        visit(producerKey);
      }
      const cell = run.matrixCell as Record<string, unknown>;
      cell.dependencyBindings = bindings;
    };
    requestedKeys.forEach(visit);
    const ordered = resolveDagClosure([...nodes.values()], requestedKeys).map(
      (node) => prepared.get(node.id)!,
    );
    const requestedIds = new Set(requestedKeys.map((key) => prepared.get(key)!.id));
    return { ordered, requestedIds };
  }
  expandRunIds(ids: readonly string[]): string[] {
    const expanded = new Set<string>();
    const visit = (id: string) => {
      if (expanded.has(id)) return;
      expanded.add(id);
      const run = this.get(id);
      for (const binding of ((run.matrixCell as Record<string, unknown>).dependencyBindings ??
        []) as ResolvedDependency[])
        visit(binding.producerRunId);
    };
    ids.forEach(visit);
    return [...expanded];
  }
  insert(run: EntityDocument, key: string, securityFailure?: ContractError): OwnedReceipt {
    if (securityFailure) {
      run = {
        ...run,
        phase: "completed",
        status: "blocked",
        outcome: "blocked",
        gate: "failed",
        gatePolicy: { ...(run.gatePolicy as Record<string, unknown>), policySatisfied: false },
      };
    }
    const cell = run.matrixCell as Record<string, unknown>;
    const provenance = cell.admissionSnapshot as AdmissionSnapshot;
    provenance.inputHash = admissionInputHash(cell);
    cell.admissionSnapshotHash = semanticHash(provenance);
    this.ctx.entities.insert("Run", run);
    new OutboxRepository(this.ctx.database).append(
      this.ctx.workspaceId,
      run.id,
      "run.timing_queued",
      { clockDomain, boundary: timingBoundary("queued") },
    );
    if (!securityFailure)
      new LeaseRepository(this.ctx.database).enqueue(this.ctx.workspaceId, run.id, "local");
    new OutboxRepository(this.ctx.database).append(
      this.ctx.workspaceId,
      run.id,
      "run.accepted",
      run,
    );
    if (securityFailure)
      new OutboxRepository(this.ctx.database).append(
        this.ctx.workspaceId,
        run.id,
        "run.completed",
        {
          outcome: "blocked",
          reasonCode: "security_precondition_failed",
          control: securityFailure.details.control ?? "enforcement",
        },
      );
    const receipt: OwnedReceipt = {
      ...validate<RunReceipt>("RunReceipt", {
        runId: run.id,
        status: run.status,
        revisionId: run.revisionId,
        environmentRevisionId: run.environmentRevisionId,
        acceptedAt: run.createdAt,
        links: {
          self: `/v1/runs/${run.id}`,
          events: `/v1/runs/${run.id}/events`,
          bundle: `/v1/runs/${run.id}/bundle`,
        },
        idempotencyKey: key,
      }),
      ownership: (run.gatePolicy as { ownership: "worker" | "ephemeral" }).ownership,
    };
    new OutboxRepository(this.ctx.database).append(
      this.ctx.workspaceId,
      run.id,
      "run.receipt",
      receipt,
    );
    return receipt;
  }
  async admit(request: RunRequest, options: AdmissionOptions = {}): Promise<OwnedReceipt> {
    this.ctx.authorize("X");
    if (!options.wait && !this.host.liveWorker())
      throw new ContractError(
        "PRECONDITION_FAILED",
        "No live worker; start a worker or use --wait",
        { nextActions: ["worker start", "--wait"] },
      );
    let securityFailure: ContractError | undefined;
    try {
      await this.host.preflight(
        options.unsafeLocal,
        String(
          request.extensions?.["testmaster:executor"] ??
            this.host.config.effectiveConfig.config.execution?.executor ??
            "docker",
        ),
      );
    } catch (error) {
      if (
        !(error instanceof ContractError) ||
        error.details.reasonCode !== "security_precondition_failed"
      )
        throw error;
      securityFailure = error;
    }
    const key = options.idempotencyKey ?? randomUUID();
    return new IdempotencyRepository(this.ctx.database).execute(
      {
        workspaceId: this.ctx.workspaceId,
        actorScope: this.ctx.principalId,
        operation: "run.admit",
        key,
        body: request,
      },
      () => {
        const revision = requireEntity(
          this.ctx,
          "TestRevision",
          request.revisionId ??
            String(requireEntity(this.ctx, "TestCase", request.testId).activeRevisionId),
        );
        const plan = revision.plan
          ? validate<ExecutablePlan>("ExecutablePlan", revision.plan)
          : null;
        if (!(plan?.dependsOn ?? []).some((binding) => binding.required))
          return this.insert(this.prepare(request), key, securityFailure);
        const receipt = new BatchesService(this.ctx, this).insertPrepared(
          { selection: [request] },
          // Dependency admissions remain subject to the same enforcement prerequisite.
          key,
          securityFailure,
        );
        const requested = receipt.memberRuns[0]!;
        const run = this.get(requested.runId);
        const gatePolicy = run.gatePolicy as { ownership: "worker" | "ephemeral" };
        return { ...requested, ownership: gatePolicy.ownership };
      },
    ).receipt;
  }
  cancel(id: string): { runId: string; result: "requested" | "already_terminal"; status: string } {
    const run = this.get(id);
    const test = requireEntity(this.ctx, "TestCase", run.testId);
    this.ctx.authorize("X", String(test.projectId));
    const cancel = () => {
      const current = this.get(id);
      if (current.phase === "completed")
        return { runId: id, result: "already_terminal" as const, status: current.status };
      const previous = this.ctx.database.get(
        "SELECT 1 FROM outbox WHERE workspace_id=? AND aggregate_id=? AND type='run.cancel_requested'",
        this.ctx.workspaceId,
        id,
      );
      if (!previous) {
        new OutboxRepository(this.ctx.database).append(
          this.ctx.workspaceId,
          id,
          "run.cancel_requested",
          {
            requestedBy: this.ctx.principalId,
            cancelRequestedAt: new Date().toISOString(),
            reasonCode: "user_cancelled",
          },
        );
        if (current.phase === "queued") {
          const next = {
            ...current,
            phase: "completed",
            status: "cancelled",
            outcome: "cancelled",
            gate: "failed",
          };
          this.ctx.database.run(
            "UPDATE runs SET phase='completed',status='cancelled',outcome='cancelled',gate='failed',data_json=?,version=version+1 WHERE workspace_id=? AND id=? AND phase='queued'",
            JSON.stringify(next),
            this.ctx.workspaceId,
            id,
          );
          this.ctx.database.run(
            "UPDATE job_leases SET state='completed' WHERE workspace_id=? AND resource_id=? AND state='queued'",
            this.ctx.workspaceId,
            id,
          );
          new OutboxRepository(this.ctx.database).append(
            this.ctx.workspaceId,
            id,
            "run.completed",
            { outcome: "cancelled", reasonCode: "user_cancelled" },
          );
        }
      }
      return { runId: id, result: "requested" as const, status: this.get(id).status };
    };
    return this.ctx.database.db.isTransaction ? cancel() : this.ctx.database.withTx(cancel);
  }
  async rerun(
    id: string,
    options: AdmissionOptions & { revisionId?: string; environmentId?: string } = {},
  ): Promise<OwnedReceipt> {
    const run = this.get(id);
    const cell = run.matrixCell as Record<string, unknown>;
    if (options.revisionId || options.environmentId)
      return this.admit(
        {
          testId: run.testId,
          revisionId: options.revisionId ?? run.revisionId,
          environmentId: options.environmentId ?? String(cell.environmentId),
          mode: "replay",
          seed: Number(cell.seed),
        },
        options,
      );
    if (!options.wait && !this.host.liveWorker())
      throw new ContractError("PRECONDITION_FAILED", "No live worker; use --wait");
    await this.host.preflight(options.unsafeLocal, String(cell.executor));
    const revision = requireEntity(this.ctx, "TestRevision", run.revisionId);
    const environment = requireEntity(this.ctx, "EnvironmentRevision", run.environmentRevisionId);
    const selectedEnvironment = requireEntity(this.ctx, "Environment", String(cell.environmentId));
    if (selectedEnvironment.archivedAt)
      throw new ContractError("PRECONDITION_FAILED", "Original environment is unavailable", {
        reasonCode: "security_precondition_failed",
        incompatibility: "environment_unavailable",
      });
    verifyAdmission(
      run,
      revision,
      environment,
      cell.executor === "process" ? null : this.host.admittedImages(),
      this.ctx,
    );
    try {
      await this.host.verifyEvidence(id);
    } catch {
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Original execution evidence cannot be verified",
        { reasonCode: "security_precondition_failed", incompatibility: "evidence_hash_mismatch" },
      );
    }
    const test = requireEntity(this.ctx, "TestCase", run.testId);
    this.ctx.authorize("X", String(test.projectId));
    const key = options.idempotencyKey ?? randomUUID();
    return new IdempotencyRepository(this.ctx.database).execute(
      {
        workspaceId: this.ctx.workspaceId,
        actorScope: this.ctx.principalId,
        operation: "run.rerun",
        key,
        body: { originalRunId: id },
      },
      () => {
        const ownership = this.host.liveWorker() ? "worker" : "ephemeral";
        const candidate = entity(this.ctx, "run", {
          testId: run.testId,
          revisionId: run.revisionId,
          environmentRevisionId: run.environmentRevisionId,
          batchId: null,
          matrixCell: { ...structuredClone(cell), ownership, originalRunId: id },
          mode: "replay",
          phase: "queued",
          status: "queued",
          outcome: null,
          origin: "cli",
          gatePolicy: { ...structuredClone(run.gatePolicy as Record<string, unknown>), ownership },
          gate: "pending",
          cleanupOutcome: "not_required",
          analysisStatus: "not_requested",
        });
        this.host.verifyApproval(candidate, test, environment);
        return this.insert(candidate, key);
      },
    ).receipt;
  }
  async wait(
    id: string,
    options: { timeoutMs?: number; signal?: AbortSignal; cancelOnInterrupt?: boolean } = {},
  ): Promise<Run & EntityDocument> {
    const deadline = performance.now() + (options.timeoutMs ?? 1800000);
    for (;;) {
      const run = this.get(id);
      if (run.phase === "completed") return run;
      if (options.signal?.aborted) {
        if (options.cancelOnInterrupt) this.cancel(id);
        throw (
          options.signal.reason ??
          new ContractError("PRECONDITION_FAILED", "Wait interrupted", { runId: id })
        );
      }
      if (performance.now() >= deadline)
        throw new ContractError("PRECONDITION_FAILED", "Wait deadline exceeded", {
          runId: id,
          waitTimeout: true,
        });
      await delay(100);
    }
  }
}
export class BatchesService {
  constructor(
    readonly ctx: ServiceContext,
    readonly runs: RunsService,
  ) {}
  get(id: string): EntityDocument {
    this.ctx.authorize("R");
    const batch = requireEntity(this.ctx, "BatchRun", id);
    const rejected = batch.rejectedMembers as { memberKey: string; reasonCode: string }[];
    const selection = batch.selectionSnapshot as Record<string, unknown>;
    const members: BatchMember[] = (batch.memberRuns as string[]).map((runId) => {
      const run = this.runs.get(runId);
      return {
        key: runId,
        runId,
        requested: ((selection.requestedRunIds ?? batch.memberRuns) as string[]).includes(runId),
        required: true,
        dependency: !((selection.requestedRunIds ?? batch.memberRuns) as string[]).includes(runId),
        outcome: run.outcome,
        gate: run.gate,
      };
    });
    members.push(
      ...rejected.map((member) => ({
        key: member.memberKey,
        runId: null,
        requested: true,
        required: true,
        dependency: false,
        outcome: null,
        gate: "failed" as const,
        reasonCode: member.reasonCode,
      })),
    );
    const aggregate = aggregateBatch(members, Boolean(selection.allowEmpty));
    return {
      ...batch,
      rejections: selection.rejections ?? [],
      aggregate: {
        counts: aggregate.counts,
        gate: aggregate.gate,
        expanded: aggregate.expanded,
        allMembers: aggregate.allMembers,
      },
    };
  }
  async admit(request: BatchRequest, options: AdmissionOptions = {}): Promise<BatchReceipt> {
    validate("BatchRequest", request);
    this.ctx.authorize("X");
    if (!request.selection.length && !request.allowEmpty)
      throw new ContractError("INVALID_ARGUMENT", "Empty selection");
    if (!options.wait && !this.runs.host.liveWorker())
      throw new ContractError("PRECONDITION_FAILED", "No live worker; use --wait", {
        nextActions: ["worker start", "--wait"],
      });
    let securityFailure: ContractError | undefined;
    for (const member of request.selection) {
      try {
        await this.runs.host.preflight(
          options.unsafeLocal,
          String(
            member.extensions?.["testmaster:executor"] ??
              this.runs.host.config.effectiveConfig.config.execution?.executor ??
              "docker",
          ),
        );
      } catch (error) {
        if (
          !(error instanceof ContractError) ||
          error.details.reasonCode !== "security_precondition_failed"
        )
          throw error;
        securityFailure = error;
      }
    }
    const key = options.idempotencyKey ?? randomUUID();
    return new IdempotencyRepository(this.ctx.database).execute(
      {
        workspaceId: this.ctx.workspaceId,
        actorScope: this.ctx.principalId,
        operation: "batch.admit",
        key,
        body: request,
      },
      () => this.insertPrepared(request, key, securityFailure),
    ).receipt;
  }
  insertPrepared(
    request: BatchRequest,
    key: string,
    securityFailure?: ContractError,
  ): BatchReceipt {
    const batchId = entity(this.ctx, "bat", {}).id;
    const rejected: { memberKey: string; reasonCode: "upstream_failed" }[] = [];
    const rejections: {
      memberKey: string;
      code: string;
      message: string;
      details: Record<string, unknown>;
    }[] = [];
    const uniqueSelection = [
      ...new Map(request.selection.map((member) => [semanticHash(member), member])).values(),
    ];
    let selection = uniqueSelection;
    if (request.partialDispatch) {
      selection = uniqueSelection.filter((member, index) => {
        try {
          this.runs.prepareClosure([member], batchId);
          return true;
        } catch (error) {
          if (
            error instanceof ContractError &&
            ["FORBIDDEN", "UNAUTHENTICATED", "POLICY_DENIED"].includes(error.code)
          )
            throw error;
          const memberKey = `${index}:${member.testId}`;
          rejected.push({ memberKey, reasonCode: "upstream_failed" });
          rejections.push({
            memberKey,
            code: error instanceof ContractError ? error.code : "INTERNAL",
            message: error instanceof ContractError ? error.message : "Member admission failed",
            details: error instanceof ContractError ? error.details : {},
          });
          return false;
        }
      });
    }
    const { ordered, requestedIds } = this.runs.prepareClosure(selection, batchId);
    const counts = {
      passed: 0,
      failed: 0,
      blocked: 0,
      cancelled: 0,
      inconclusive: 0,
      inFlight: requestedIds.size,
    };
    const gate = rejected.length ? "failed" : ordered.length ? "pending" : "not_applicable";
    this.ctx.entities.insert("BatchRun", {
      id: batchId,
      workspaceId: this.ctx.workspaceId,
      createdAt: new Date().toISOString(),
      version: 1,
      selectionSnapshot: {
        ...request,
        duplicates: request.selection.length - requestedIds.size - rejected.length,
        hash: semanticHash(request),
        rejections,
        requestedRunIds: [...requestedIds],
      },
      requestedCount: requestedIds.size + rejected.length,
      memberRuns: ordered.map((run) => run.id),
      rejectedMembers: rejected,
      commit: null,
      aggregate: { counts, gate },
    });
    const receipts = ordered.map((run) => {
      const { ownership: _ownership, ...receipt } = this.runs.insert(run, key, securityFailure);
      return receipt;
    });
    const memberRuns = receipts.filter((receipt) => requestedIds.has(receipt.runId));
    const expanded = receipts.filter((receipt) => !requestedIds.has(receipt.runId));
    new OutboxRepository(this.ctx.database).append(
      this.ctx.workspaceId,
      batchId,
      "batch.accepted",
      { memberRuns, expanded, rejected },
    );
    return validate<BatchReceipt>("BatchReceipt", {
      batchId,
      requested: requestedIds.size + rejected.length,
      accepted: requestedIds.size,
      notDispatched: rejected,
      memberRuns,
      expanded,
      allMembers: ordered.map((run) => run.id),
      counts,
      gate,
    });
  }
}
