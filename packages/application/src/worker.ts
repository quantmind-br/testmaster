import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type CodeReference,
  ContractError,
  defaults,
  type EffectiveConfig,
  type ExecutablePlan,
  type PlanStep,
  type RunnerEvent,
  reasonRegistry,
  type VariableValue,
  validate,
} from "@testmaster/contracts";
import {
  type AttemptObservation,
  canonicalJson,
  canRetry,
  environmentSecretValues,
  evaluateGate,
  reduceOutcome,
  semanticHash,
} from "@testmaster/domain";
import {
  ConfinedRoot,
  collectGarbage,
  EvidenceQuotaError,
  FileEvidenceStore,
  findOrphanStaging,
  verifyBundle,
} from "@testmaster/evidence";
import {
  auxiliaryQueues,
  type EntityDocument,
  ExecutionRepository,
  type Fence,
  LeaseRepository,
  OutboxRepository,
  StaleFenceError,
} from "@testmaster/persistence";
import {
  AttemptExecutor,
  type AttemptRuntimeExecutor,
  ContainerCleanupError,
  type DockerCommand,
  DockerExecutor,
  type ExecutorKind,
  type ImageLock,
  PolicyDenied,
} from "@testmaster/sandbox";
import { AgentModeService } from "./ai/agent-mode.js";
import { CodeImportService } from "./ai/code-import.js";
import { sourceSchemasFor } from "./ai/source-documents.js";
import { auditSecurity } from "./audit.js";
import { type AuthProfilesService, authBlockReasons } from "./auth/index.js";
import { attemptAdditionalOrigins, attemptIgnoredOrigins } from "./authoring.js";
import { erasableCaptureSecretIds } from "./capture-retention.js";
import { runMatrixCell } from "./comparisons.js";
import type { ResolvedConfig } from "./config.js";
import { entity, type RunActor, requireEntity, type ServiceContext } from "./context.js";
import { type ReuseBinding, resolveReuse } from "./dependency-reuse.js";
import { fixtureRevoked, planRunnerPolicy, stageFixtureInputs } from "./input-fixtures.js";
import { memberIntervalReady } from "./member-interval.js";
import { correlationId, OperationalLogger } from "./observability.js";
import { reproduction, verifyAdmission } from "./provenance.js";
import { assertArtifactPublishable } from "./retention.js";
import {
  captureDeclarations,
  cleanupHandleDeclarations,
  type ResolvedDependency,
  type RunsService,
} from "./runs.js";
import type { SecretsService } from "./secrets.js";
import {
  type EvidenceLimits,
  freeDataBytes,
  hasStorageRoom,
  inFlightEvidenceBytes,
  runEvidenceBytes,
  type StorageRoom,
} from "./storage-admission.js";
import { RuntimeTimer } from "./timing.js";
import { UnsafeRuntime } from "./unsafe-runtime.js";
import { fitsCapacity, validateCapacity, type WorkerCapacity } from "./worker-capacity.js";
import {
  localHandshake,
  supportsQueuedRun,
  validateHandshake,
  type WorkerHandshake,
} from "./worker-handshake.js";
import { fairShareCap } from "./worker-pool.js";
import { isWriterContention, retryWriterContention } from "./writer-contention.js";

/**
 * Run jobs only. Diagnosis, healing and delivery work shares `job_leases` but its `resource_id`
 * is a semantic hash, never a Run id; the services that own those queues reconcile them.
 */
const runJobFilter = `queue NOT IN (${auxiliaryQueues.map((queue) => `'${queue}'`).join(",")})`;
/** How often a running worker compares its migrations with the database's (OPS-038). */
const schemaCheckIntervalMs = 2000;
/** How often a running attempt renews its lease; the lease itself is the repository default (30 s). */
const leaseHeartbeatIntervalMs = 10000;

export interface WorkerHost {
  config: ResolvedConfig;
  images(): Promise<ImageLock>;
  seccompPath: string;
  secrets: SecretsService;
  runs: RunsService;
  retention?: { maintenance(): Promise<unknown> };
  analysis?: { settlePending(): Promise<number> };
  healing?: { settlePending(): Promise<number> };
  auth?: () => AuthProfilesService;
  dockerCommand?: DockerCommand;
  docker?: AttemptRuntimeExecutor;
}
/** Maps a revision runner to the sandbox executor kind; the Playwright runner uses the browser envelope. */
export function executorKindOf(runner: unknown): ExecutorKind {
  return runner === "python" || runner === "http" || runner === "terminal" ? runner : "browser";
}
/**
 * The secrets a code test declared, each checked to exist. A secret that is gone throws
 * `missing_secret`, which blocks the Run before any child starts instead of failing an assertion.
 */
export function codeSecretBindings(
  codeRef: CodeReference | undefined,
  secrets: Pick<SecretsService, "get">,
): NonNullable<CodeReference["secretRefs"]> {
  const bindings = codeRef?.secretRefs ?? [];
  for (const { name, secretRef } of bindings) {
    try {
      secrets.get(secretRef);
    } catch (error) {
      if (error instanceof ContractError && error.code === "NOT_FOUND")
        throw new ContractError(
          "PRECONDITION_FAILED",
          `Secret ${JSON.stringify(name)} used by this code test does not exist`,
          { reasonCode: "missing_secret", secretName: name },
        );
      throw error;
    }
  }
  return bindings;
}
export function planSteps(plan: ExecutablePlan): PlanStep[] {
  const output: PlanStep[] = [];
  const visit = (steps: readonly PlanStep[]) => {
    for (const step of steps) {
      output.push(step);
      if (step.operation === "frame") visit(step.input.childSteps);
    }
  };
  visit(plan.steps);
  return output;
}
export class WorkerService {
  readonly owner = `local:${process.pid}`;
  private workerId: string | null = null;
  private drainRequested = false;
  private readonly active = new Map<string, AbortController>();
  private readonly logs: OperationalLogger;
  constructor(
    readonly ctx: ServiceContext,
    readonly host: WorkerHost,
  ) {
    this.logs = new OperationalLogger(
      join(host.config.dataDir, "logs", "worker"),
      host.config.logRetentionDays,
    );
  }
  private dockerExecutor(): DockerExecutor {
    if (this.host.docker instanceof DockerExecutor) return this.host.docker;
    return new DockerExecutor(this.host.dockerCommand);
  }
  status(): EntityDocument[] {
    this.ctx.authorize("R");
    return this.ctx.database
      .all("SELECT id FROM workers WHERE workspace_id=? ORDER BY created_at", this.ctx.workspaceId)
      .map((row) => requireEntity(this.ctx, "Worker", String(row.id)));
  }
  live(): boolean {
    return Boolean(
      this.ctx.database.get(
        "SELECT 1 FROM workers WHERE workspace_id=? AND state='ready' AND last_heartbeat_at>?",
        this.ctx.workspaceId,
        new Date(Date.now() - 30000).toISOString(),
      ),
    );
  }
  drain() {
    this.ctx.authorize("A");
    this.ctx.database.withTx(() =>
      this.ctx.database.run(
        "UPDATE workers SET state='draining' WHERE workspace_id=? AND state='ready'",
        this.ctx.workspaceId,
      ),
    );
    this.drainRequested = true;
    return { requested: true };
  }
  stop() {
    const receipt = this.drain();
    this.ctx.database.withTx(() =>
      new OutboxRepository(this.ctx.database).append(
        this.ctx.workspaceId,
        this.ctx.workspaceId,
        "worker.stop_requested",
        {},
      ),
    );
    return receipt;
  }
  private cancelled(runId: string): boolean {
    return Boolean(
      this.ctx.database.get(
        "SELECT 1 FROM outbox WHERE workspace_id=? AND aggregate_id=? AND type='run.cancel_requested'",
        this.ctx.workspaceId,
        runId,
      ),
    );
  }
  private observations(runId: string, plan: ExecutablePlan | null): AttemptObservation[] {
    const steps = plan ? planSteps(plan) : [];
    return this.ctx.database
      .all(
        "SELECT * FROM attempts WHERE workspace_id=? AND run_id=? ORDER BY number",
        this.ctx.workspaceId,
        runId,
      )
      .map((row) => {
        let malformed = false;
        const events: RunnerEvent[] = [];
        for (const value of this.ctx.database.all(
          "SELECT data_json FROM observations WHERE workspace_id=? AND attempt_id=? ORDER BY seq",
          this.ctx.workspaceId,
          row.id,
        )) {
          try {
            events.push(validate<RunnerEvent>("RunnerEvent", JSON.parse(String(value.data_json))));
          } catch {
            malformed = true;
          }
        }
        const finished = malformed
          ? undefined
          : events.findLast((event) => event.type === "runner.finished");
        const observations: AttemptObservation["steps"][number][] = [];
        for (const event of events) {
          if (event.type !== "step.finished") continue;
          const step = steps.find((value) => value.id === event.payload.stepId);
          observations.push({
            stepId: event.payload.stepId,
            required: step?.required !== false,
            status:
              event.payload.status === "pending" || event.payload.status === "running"
                ? "inconclusive"
                : event.payload.status,
            // A required step whose runner observed a contradicting or timed-out target
            // (registry effect "failed") is a reliable observation (spec 03 outcome table).
            assertion: plan
              ? step?.kind === "assertion" ||
                Boolean(step && "expectation" in step) ||
                (event.payload.status === "failed" &&
                  reasonRegistry[String(event.payload.reasonCode)]?.effect === "failed")
              : event.payload.stepId === "imported-code",
            reliable: event.payload.status === "passed" || event.payload.status === "failed",
            ...(event.payload.reasonCode ? { reasonCode: event.payload.reasonCode } : {}),
          });
        }
        return {
          attemptId: String(row.id),
          number: Number(row.number),
          started:
            malformed ||
            events.some((event) => event.type === "step.started") ||
            Boolean(
              this.ctx.database.get(
                "SELECT 1 FROM outbox WHERE workspace_id=? AND aggregate_id=? AND type='attempt.runner_started' AND json_extract(data_json,'$.attemptId')=?",
                this.ctx.workspaceId,
                runId,
                row.id,
              ),
            ),
          steps: observations,
          reasonCode:
            (malformed ? "insufficient_evidence" : finished?.payload.reasonCode) ??
            (row.outcome === "inconclusive" ? "worker_lost" : "insufficient_evidence"),
          cancelAuthorized: this.cancelled(runId),
          stopConfirmed: row.phase === "completed" && this.cancelled(runId),
          externalEffectUncertain:
            malformed ||
            events.some(
              (event) =>
                event.type === "resource.uncertain" ||
                event.type === "resource.intent" ||
                event.type === "resource.created",
            ),
        };
      });
  }
  private dependencies(run: EntityDocument): ResolvedDependency[] {
    const cell = run.matrixCell as Record<string, unknown>;
    return (cell.dependencyBindings ?? []) as ResolvedDependency[];
  }
  private async dependencyVariables(
    run: EntityDocument,
  ): Promise<Record<string, { value: unknown; sensitive: boolean }>> {
    const variables: Record<string, { value: unknown; sensitive: boolean }> = {};
    const cell = run.matrixCell as Record<string, unknown>;
    for (const binding of this.dependencies(run)) {
      if (binding.reuse) {
        const batch = requireEntity(this.ctx, "BatchRun", String(run.batchId));
        const snapshot = batch.selectionSnapshot as Record<string, unknown>;
        const recorded = (snapshot.reuseBindings ?? []) as ReuseBinding[];
        if (!recorded.some((entry) => semanticHash(entry) === semanticHash(binding.reuse)))
          throw new ContractError(
            "PRECONDITION_FAILED",
            "Fixture reuse has no frozen batch authorization",
            { reasonCode: "upstream_failed" },
          );
        resolveReuse(this.ctx, run, binding, [binding.producerRunId], binding.reuse);
      }
      const producer = this.host.runs.get(binding.producerRunId);
      const producerCell = producer.matrixCell as Record<string, unknown>;
      if (
        producer.phase !== "completed" ||
        producer.outcome !== "passed" ||
        producer.gate !== "passed" ||
        producer.revisionId !== binding.producerRevisionId ||
        producer.environmentRevisionId !== binding.producerEnvironmentRevisionId ||
        producerCell.environmentId !== binding.permittedEnvironment ||
        cell.environmentId !== binding.permittedEnvironment
      )
        throw new ContractError("PRECONDITION_FAILED", "Required producer did not pass", {
          reasonCode: "upstream_failed",
        });
      const records = this.ctx.database.all(
        "SELECT v.data_json,a.id AS attempt_id FROM variables v JOIN attempts a ON a.workspace_id=v.workspace_id AND a.run_id=v.producer_run_id WHERE v.workspace_id=? AND v.producer_run_id=? AND v.name=? AND a.phase='completed' AND a.number=(SELECT MAX(number) FROM attempts WHERE workspace_id=a.workspace_id AND run_id=a.run_id) ORDER BY v.created_at DESC",
        this.ctx.workspaceId,
        producer.id,
        binding.outputName,
      );
      let found = false;
      for (const row of records) {
        const variable = validate<VariableValue>(
          "VariableValue",
          JSON.parse(String(row.data_json)),
        );
        if (
          (variable.batchId !== run.batchId &&
            (!binding.reuse ||
              variable.id !== binding.reuse.variableId ||
              semanticHash(variable) !== binding.reuse.variableHash)) ||
          variable.taint !== (binding.sensitive ? "sensitive" : "public") ||
          variable.type !== binding.type ||
          !variable.createdAt ||
          !Number.isFinite(Date.parse(variable.createdAt)) ||
          Date.now() - Date.parse(variable.createdAt) > binding.maximumAge
        )
          continue;
        if (binding.sensitive) {
          if (!variable.encryptedValueRef) continue;
          const reference = this.host.secrets.get(variable.encryptedValueRef);
          if (
            reference.provider === "ephemeral" ||
            reference.secretVersion !== 1 ||
            !reference.allowedOrigins.includes(String(cell.baseUrl))
          )
            continue;
          const release = await this.host.secrets.release(reference.id);
          const value: unknown = JSON.parse(await release.resolve());
          const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
          if (type !== binding.type) continue;
          variables[binding.consumerInput] = { value, sensitive: true };
          found = true;
          break;
        }
        const events = this.ctx.database.all(
          "SELECT data_json FROM observations WHERE workspace_id=? AND attempt_id=? ORDER BY seq DESC",
          this.ctx.workspaceId,
          row.attempt_id,
        );
        for (const observation of events) {
          let event: RunnerEvent;
          try {
            event = validate<RunnerEvent>("RunnerEvent", JSON.parse(String(observation.data_json)));
          } catch {
            continue;
          }
          if (
            event.type !== "variable.captured" ||
            event.occurredAt !== variable.createdAt ||
            event.payload.name !== binding.outputName ||
            event.payload.sensitive ||
            event.payload.valueType !== binding.type ||
            !event.payload.value ||
            !("literal" in event.payload.value)
          )
            continue;
          const value = event.payload.value.literal;
          const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
          if (type !== binding.type || (typeof value === "number" && !Number.isFinite(value)))
            continue;
          variables[binding.consumerInput] = { value, sensitive: false };
          found = true;
          break;
        }
        if (found) break;
      }
      if (!found)
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Required producer output is absent or stale",
          { reasonCode: "upstream_failed" },
        );
    }
    return variables;
  }
  private async runtimeRoot(): Promise<string> {
    const uid = process.getuid?.();
    if (uid === undefined)
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Runtime directory ownership cannot be established",
      );
    const root = `/tmp/testmaster-runtime-${uid}`;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== uid ||
      (info.mode & 0o077) !== 0
    )
      throw new ContractError("PRECONDITION_FAILED", "Runtime directory is not private and owned");
    return root;
  }
  private async execute(
    fence: Fence & { runId: string; number: number },
    signal?: AbortSignal,
  ): Promise<void> {
    const database = this.ctx.database;
    const execution = new ExecutionRepository(database);
    const leases = new LeaseRepository(database);
    const run = this.host.runs.get(fence.runId);
    const revision = requireEntity(this.ctx, "TestRevision", run.revisionId);
    const env = requireEntity(this.ctx, "EnvironmentRevision", run.environmentRevisionId);
    const plan = revision.plan ? validate<ExecutablePlan>("ExecutablePlan", revision.plan) : null;
    const cell = run.matrixCell as Record<string, unknown>;
    const logs = this.logs;
    const correlation = correlationId(cell.correlationId);
    logs.record({
      component: "worker",
      event: "attempt.started",
      correlationId: correlation,
      runId: run.id,
      attemptId: fence.attemptId,
    });
    const queued = this.host.runs
      .events(run.id)
      .findLast((event) => event.type === "run.timing_queued")?.payload as ConstructorParameters<
      typeof RuntimeTimer
    >[2];
    const timer = new RuntimeTimer(undefined, undefined, fence.number === 1 ? queued : undefined);
    const recordTiming = () => {
      timer.mark("completed");
      database.withTx(() => {
        leases.assertCurrent(fence);
        new OutboxRepository(database).append(this.ctx.workspaceId, run.id, "attempt.timing", {
          attemptId: fence.attemptId,
          timing: timer.snapshot(),
        });
      });
    };
    const limits = cell.limits as Record<string, number>;
    const firstStartedAt = this.ctx.database.get(
      "SELECT started_at FROM attempts WHERE workspace_id=? AND run_id=? ORDER BY number LIMIT 1",
      this.ctx.workspaceId,
      run.id,
    )?.started_at;
    // Time an earlier attempt spent waiting for a model answer is not execution time: a model
    // call is never cut, and its wait must not shorten a later attempt's deadline either.
    const modelWaitMs = this.host.runs
      .events(run.id)
      .filter((event) => event.type === "attempt.model_wait")
      .reduce(
        (total, event) => total + Number((event.payload as { waitMs?: number }).waitMs ?? 0),
        0,
      );
    const elapsedMs =
      typeof firstStartedAt === "string"
        ? Math.max(0, Date.now() - Date.parse(firstStartedAt) - modelWaitMs)
        : 0;
    const executionRemainingMs = Math.max(0, (limits.executionTimeoutMs ?? 1800000) - elapsedMs);
    const attemptDeadlineMs = Math.min(limits.attemptTimeoutMs ?? 300000, executionRemainingMs);
    const effective = validate<EffectiveConfig>("EffectiveConfig", cell.effectiveConfig);
    const config = effective.config;
    const controller = new AbortController();
    this.active.set(run.id, controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted || this.cancelled(run.id)) controller.abort();
    database.withTx(() => {
      leases.assertCurrent(fence);
      new OutboxRepository(database).append(this.ctx.workspaceId, run.id, "attempt.deadline", {
        attemptId: fence.attemptId,
        origin: executionRemainingMs <= (limits.attemptTimeoutMs ?? 300000) ? "run" : "attempt",
        timeoutMs: attemptDeadlineMs,
        deadline: new Date(Date.now() + attemptDeadlineMs).toISOString(),
        finalAction: "stop_new_steps_then_kill_after_grace",
      });
    });
    let heartbeatError: unknown;
    const poll = setInterval(() => {
      if (this.cancelled(run.id)) controller.abort();
    }, 100);
    // Fencing: another worker may reclaim the attempt once its lease expires, so this one must
    // have stopped by then. A contended renewal is tolerated only while the last renewed lease
    // still outlives one more heartbeat interval; anything else, or a lease about to lapse,
    // stops the attempt.
    let leaseExpiresAt = Date.parse(
      String(
        database.get(
          "SELECT lease_expires_at FROM job_leases WHERE workspace_id=? AND id=?",
          fence.workspaceId,
          fence.jobId,
        )?.lease_expires_at,
      ),
    );
    const heartbeat = setInterval(() => {
      try {
        leaseExpiresAt = Date.parse(leases.heartbeat(fence));
      } catch (error) {
        if (isWriterContention(error) && leaseExpiresAt - Date.now() > leaseHeartbeatIntervalMs)
          return;
        heartbeatError = error;
        controller.abort();
      }
    }, leaseHeartbeatIntervalMs);
    const inputDir = join(this.host.config.dataDir, "cache", "attempt-input", fence.attemptId);
    let activeStepId: string | undefined;
    let sealedSnapshot: Record<string, unknown> | undefined;
    const snapshotId = entity(this.ctx, "snp", {}).id;
    const required = plan ? planSteps(plan).filter((step) => step.required !== false) : [];
    const assertions = required
      .filter((step) => step.kind === "assertion" || "expectation" in step)
      .map((step) => step.id);
    const requiredSteps = required.map((step) => step.id);
    if (!plan) {
      assertions.push("imported-code");
      requiredSteps.push("imported-code");
    }
    try {
      let variables: Record<string, { value: unknown; sensitive: boolean }>;
      try {
        variables = await this.dependencyVariables(run);
      } catch (error) {
        if (!(error instanceof ContractError)) throw error;
        recordTiming();
        execution.finalize(
          fence,
          {
            ...run,
            phase: "completed",
            status: "blocked",
            outcome: "blocked",
            gate: "failed",
            cleanupOutcome: "not_required",
            analysisStatus: "not_requested",
            gatePolicy: {
              ...(run.gatePolicy as Record<string, unknown>),
              requiredDependenciesPassed: false,
            },
          },
          "upstream_failed",
        );
        database.withTx(() =>
          new OutboxRepository(database).append(
            this.ctx.workspaceId,
            run.id,
            "run.dependency_blocked",
            { reasonCode: "upstream_failed" },
          ),
        );
        return;
      }
      if (executionRemainingMs === 0) {
        const reduced = reduceOutcome(this.observations(run.id, plan), assertions, requiredSteps);
        execution.finalize(
          fence,
          {
            ...run,
            phase: "completed",
            status: reduced.outcome === "failed" ? "failed" : "inconclusive",
            outcome: reduced.outcome === "failed" ? "failed" : "inconclusive",
            gate: "failed",
          },
          reduced.outcome === "failed" ? reduced.reasonCode : "execution_deadline",
        );
        database.withTx(() =>
          new OutboxRepository(database).append(
            this.ctx.workspaceId,
            run.id,
            "run.deadline_exceeded",
            {
              reasonCode: "execution_deadline",
              origin: "run",
              deadline: new Date(
                Date.parse(String(firstStartedAt)) +
                  modelWaitMs +
                  (limits.executionTimeoutMs ?? 1800000),
              ).toISOString(),
            },
          ),
        );
        return;
      }
      await mkdir(inputDir, { recursive: true, mode: 0o755 });
      const imported = !plan
        ? await new CodeImportService(this.ctx, this.host.config).readBundle(revision.id)
        : null;
      if (imported) {
        if (cell.executor === "process")
          throw new ContractError("POLICY_DENIED", "Imported code requires Docker isolation");
        for (const [path, text] of Object.entries(imported.bundle.files)) {
          const destination = join(inputDir, "code", path);
          await mkdir(join(destination, ".."), { recursive: true, mode: 0o755 });
          await writeFile(destination, text, { mode: 0o644, flag: "wx" });
        }
      }
      execution.progress(fence, "running");
      const currentImages = cell.executor === "process" ? null : await this.host.images();
      const admitted = verifyAdmission(run, revision, env, currentImages, this.ctx);
      const fixtureInputs = await stageFixtureInputs(
        this.ctx,
        this.host.config,
        String(requireEntity(this.ctx, "TestCase", String(run.testId)).projectId),
        plan,
        inputDir,
        admitted.inputFixtureHashes ?? {},
        limits,
      );
      const lock = admitted.images;
      sealedSnapshot = {
        ...admitted,
        inputFixtureHashes: fixtureInputs.inputFixtureHashes,
        provenance: {
          commitSha: admitted.repository?.commitSha ?? null,
          checkoutSha: admitted.repository?.checkoutSha ?? null,
          baseSha: admitted.repository?.baseSha ?? null,
          repositoryId: admitted.repository?.repositoryId ?? null,
          dirtyHash: admitted.repository?.dirtyHash ?? null,
          deploymentId: admitted.repository?.deploymentId ?? null,
          binding: admitted.repository?.binding ?? "unbound",
          ...(admitted.repository?.bindingSource
            ? { bindingSource: admitted.repository.bindingSource }
            : {}),
        },
        runId: run.id,
        revisionId: run.revisionId,
        environmentRevisionId: run.environmentRevisionId,
        effectiveConfig: cell.effectiveConfig,
        // The limits this run applied (the project defaults live in effectiveConfig).
        limits,
        ...(typeof cell.stepTimeoutCapMs === "number"
          ? { stepTimeoutCapMs: cell.stepTimeoutCapMs }
          : {}),
        baseUrl: cell.baseUrl,
        seed: cell.seed,
        sealedAt: new Date().toISOString(),
        originalRunId: cell.originalRunId ?? null,
        correlationId: cell.correlationId ?? null,
        environment: env,
        workerId: this.workerId,
        controllerVersion: "1.0.0",
        hostPlatform: process.platform,
        hostArchitecture: process.arch,
      };
      // Dynamic authentication: bring every attached profile to a usable state before any
      // credential is released; a human step or revoked credential blocks the Run here.
      // Code gets the session only when it asked for it (profileRequest/profilePage); like an HTTP
      // plan it brings its own login, because the code runner has no browser login phase.
      const usesProfile = imported?.bundle.format === "playwright" && !!imported.bundle.profile;
      const authService =
        (env.authProfileRefs as string[]).length > 0 && (plan || usesProfile)
          ? this.host.auth?.()
          : undefined;
      const prepared = authService
        ? await authService.prepare({
            run: {
              id: run.id,
              origin: run.origin,
              requestedBy: String(
                (cell.actor as { principalId?: string } | undefined)?.principalId,
              ),
            },
            attemptId: fence.attemptId,
            environment: {
              id: String(cell.environmentId ?? env.id),
              projectId: String(requireEntity(this.ctx, "TestCase", String(run.testId)).projectId),
              targetOrigins: env.targetOrigins as string[],
              networkProfile: env.networkProfile as "public" | "private" | "local-loopback",
              authProfileRefs: env.authProfileRefs as string[],
            },
            signal: controller.signal,
            deadlineAt: Date.now() + attemptDeadlineMs,
            interactive: ["cli", "api", "mcp"].includes(run.origin) && process.env.CI !== "true",
            runner: plan ? plan.runner : "http",
          })
        : null;
      const secretIds = new Set<string>(prepared?.secretIds);
      const inspect = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        for (const [key, item] of Object.entries(value)) {
          if (key === "secretRef" && typeof item === "string") secretIds.add(item);
          else inspect(item);
        }
      };
      inspect(plan);
      // A code test reads secrets only through its declared bindings.
      const codeSecrets = imported
        ? codeSecretBindings(revision.codeRef as CodeReference | undefined, this.host.secrets)
        : [];
      for (const { secretRef } of codeSecrets) secretIds.add(secretRef);
      const releases = await Promise.all([...secretIds].map((id) => this.host.secrets.release(id)));
      sealedSnapshot.secretRefs = [...secretIds].map((id) => {
        const secret = this.host.secrets.get(id);
        return { id, version: secret.secretVersion, allowedOrigins: secret.allowedOrigins };
      });
      database.withTx(() =>
        new OutboxRepository(database).append(this.ctx.workspaceId, run.id, "run.snapshot_sealed", {
          attemptId: fence.attemptId,
          snapshotId,
          executionSnapshot: sealedSnapshot,
        }),
      );
      const origins = Array.from(
        new Set([...(env.targetOrigins as string[]), new URL(String(cell.baseUrl)).origin]),
      );
      const additionalOrigins = attemptAdditionalOrigins(
        env as { additionalOrigins?: string[] },
        origins,
        Boolean(admitted.profilePolicy.offline),
      );
      const ignoredOrigins = attemptIgnoredOrigins(env as { ignoredOrigins?: string[] }, [
        ...origins,
        ...additionalOrigins,
      ]);
      const agent =
        run.mode === "agent"
          ? new AgentModeService(this.ctx, {
              ...this.host.config,
              effectiveConfig: effective,
              modelProviders: admitted.modelProviders,
              profilePolicy: admitted.profilePolicy,
            }).session(revision.id, origins, controller.signal, run.id)
          : null;
      if (agent && cell.executor === "process")
        throw new ContractError("POLICY_DENIED", "Agent execution requires Docker isolation");
      if (
        imported &&
        lock?.[imported.dependencyLock.image].imageId !== imported.dependencyLock.imageId
      )
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Imported dependency lock image is not current",
        );
      for (const id of secretIds) {
        const secret = this.host.secrets.get(id);
        if (origins.some((origin) => !secret.allowedOrigins.includes(origin)))
          throw new ContractError("POLICY_DENIED", "Secret origin is not authorized", {
            secretRef: id,
          });
      }
      const evidence = new FileEvidenceStore({
        rootDir: this.host.config.dataDir,
        maxObjectBytes: limits.artifactBytes ?? 67108864,
        maxAttemptBytes: limits.attemptArtifactBytes ?? 268435456,
      });
      const docker = this.host.docker ?? this.dockerExecutor();
      const runtime = cell.executor === "process" ? new UnsafeRuntime(this.host.config) : docker;
      const runtimeRoot = await this.runtimeRoot();
      for (const id of Object.keys(fixtureInputs.artifacts)) {
        if (fixtureRevoked(this.ctx, id))
          throw new ContractError(
            "PRECONDITION_FAILED",
            "Fixture input was revoked before dispatch",
            { reasonCode: "security_precondition_failed", artifactRef: id },
          );
      }
      const result = await new AttemptExecutor(evidence, runtime, runtimeRoot).execute(
        {
          workspaceId: this.ctx.workspaceId,
          runId: run.id,
          attemptId: fence.attemptId,
          revisionId: run.revisionId,
          executionSnapshot: JSON.parse(JSON.stringify(sealedSnapshot)),
          reproduction: reproduction(
            admitted,
            typeof cell.originalRunId === "string" ? cell.originalRunId : undefined,
            run.mode === "agent",
          ),
          snapshotId,
          kind: imported?.bundle.format === "pytest" ? "python" : executorKindOf(plan?.runner),
          imageId:
            imported?.dependencyLock.imageId ??
            lock?.["testmaster-runner"].imageId ??
            `sha256:${"0".repeat(64)}`,
          inputDir,
          ...(plan ? { plan } : {}),
          ...(agent
            ? {
                resolveAction: async (stepId: string, observation: unknown) => {
                  const started = performance.now();
                  const answer = await agent.resolveAction(stepId, observation).then(
                    (action) => ({ action }),
                    (error: unknown) => ({ error }),
                  );
                  const waitMs = Math.round(performance.now() - started);
                  // Waits for the writer without a deadline while the attempt runs. Once the attempt
                  // is being stopped only the timing event is lost: the answer the model already
                  // returned is never discarded.
                  try {
                    await retryWriterContention(
                      () =>
                        database.withTx(() =>
                          new OutboxRepository(database).append(
                            this.ctx.workspaceId,
                            run.id,
                            "attempt.model_wait",
                            { attemptId: fence.attemptId, stepId, waitMs },
                          ),
                        ),
                      { signal: controller.signal, inTransaction: () => database.inTransaction },
                    );
                  } catch (error) {
                    if (!(isWriterContention(error) && controller.signal.aborted)) throw error;
                  }
                  if ("error" in answer) throw answer.error;
                  return answer.action;
                },
              }
            : {}),
          networkPolicy: {
            allowedOrigins: [...origins, ...additionalOrigins],
            ...(additionalOrigins.length ? { additionalOrigins } : {}),
            ...(ignoredOrigins.length ? { ignoredOrigins } : {}),
            networkProfile: env.networkProfile as "local-loopback" | "private" | "public",
            baseUrl: String(cell.baseUrl),
          },
          secretRefs: releases,
          ...(env.serverLog
            ? {
                serverLog: {
                  ...(env.serverLog as { kind: "docker"; container: string }),
                  maxBytes: limits.logBytes ?? defaults.logBytes,
                },
                hostSecretValues: environmentSecretValues(),
              }
            : {}),
          runnerInput: {
            ...(agent ? { agent: agent.runnerInput } : {}),
            ...(imported
              ? imported.bundle.format === "pytest"
                ? {
                    files: [imported.bundle.entrypoint],
                    codeRoot: "/run/testmaster/input/code",
                    imageId: imported.dependencyLock.imageId,
                  }
                : {
                    imported: {
                      files: [imported.bundle.entrypoint],
                      ...(codeSecrets.length ? { secrets: codeSecrets } : {}),
                      ...(usesProfile ? { profile: true } : {}),
                    },
                  }
              : {}),
            baseUrl: String(cell.baseUrl),
            ...(prepared?.runnerAuth ? { auth: prepared.runnerAuth } : {}),
            variables,
            artifacts: fixtureInputs.artifacts,
            // Code revisions carry the schemas frozen into their bundle at generation; plans resolve
            // theirs from the cited source revisions.
            schemas: imported?.bundle.schemas ?? sourceSchemasFor(this.ctx, plan),
            bodyBytes: limits.bodyBytes ?? defaults.bodyBytes,
            locale: env.locale,
            timezone: env.timezone,
            browser: config.browser,
            stepTimeoutMs: limits.stepTimeoutMs ?? 30000,
            ...(typeof cell.stepTimeoutCapMs === "number"
              ? { stepTimeoutCapMs: cell.stepTimeoutCapMs }
              : {}),
            timeoutMs: attemptDeadlineMs,
            policy: {
              ...planRunnerPolicy(plan),
              trace: config.artifacts?.trace === "on",
              video: config.artifacts?.video === "on",
              httpBodies: config.artifacts?.httpBodies === "on",
              restrictedRaw:
                config.artifacts?.trace === "on" ||
                config.artifacts?.video === "on" ||
                config.artifacts?.httpBodies === "on",
            },
          },
          attemptTimeoutMs: attemptDeadlineMs,
          ...(prepared ? { onAuthState: prepared.onAuthState } : {}),
          seccompPath: this.host.seccompPath,
          protectCapture: async (capture) => {
            if (!capture.sensitive) return capture;
            if (!capture.value || !("literal" in capture.value))
              throw new ContractError(
                "PRECONDITION_FAILED",
                "Sensitive capture literal is unavailable",
              );
            leases.assertCurrent(fence);
            const protectedValue = await this.host.secrets.protectCapture(
              `capture-${fence.attemptId}-${capture.name}`,
              capture.value.literal,
              origins,
            );
            leases.assertCurrent(fence);
            // A cleanup lookup's handle names the entry it belongs to; keep that producer.
            const { value: _value, ...rest } = capture;
            return { ...rest, sensitive: true, encryptedValueRef: protectedValue.id };
          },
          onEvent: async (event) => {
            if (event.type === "runner.hello")
              database.withTx(() => {
                leases.assertCurrent(fence);
                new OutboxRepository(database).append(
                  this.ctx.workspaceId,
                  run.id,
                  "attempt.runner_started",
                  { attemptId: fence.attemptId },
                );
              });
            if (event.type === "step.started") timer.mark("running");
            if (event.type === "runner.finished") timer.mark("collecting");
            if (event.type === "step.started") activeStepId = event.payload.stepId;
            if (event.type === "variable.captured") {
              // A cleanup lookup names the entry it produces the handle for; every other capture
              // belongs to the step being executed.
              const named = event.payload.stepId;
              const declaration = plan
                ? named === undefined
                  ? captureDeclarations(plan).find(
                      (capture) =>
                        capture.stepId === activeStepId && capture.name === event.payload.name,
                    )
                  : cleanupHandleDeclarations(plan).find(
                      (capture) => capture.stepId === named && capture.name === event.payload.name,
                    )
                : undefined;
              if (!declaration || declaration.valueType !== event.payload.valueType)
                throw new ContractError(
                  "PRECONDITION_FAILED",
                  "Capture does not match its producer step",
                );
              database.withTx(() => {
                leases.assertCurrent(fence);
                const previousRow = database.get(
                  "SELECT data_json FROM variables WHERE workspace_id=? AND producer_run_id=? AND producer_step_id=? AND name=?",
                  this.ctx.workspaceId,
                  run.id,
                  declaration.stepId,
                  event.payload.name,
                );
                const previous = previousRow
                  ? validate<VariableValue>(
                      "VariableValue",
                      JSON.parse(String(previousRow.data_json)),
                    )
                  : null;
                const value = entity(this.ctx, "var", {
                  ...(previous
                    ? { id: previous.id, version: Number(previous.version ?? 1) + 1 }
                    : {}),
                  createdAt: event.occurredAt,
                  batchId: run.batchId,
                  producerRunId: run.id,
                  producerStepId: declaration.stepId,
                  name: event.payload.name,
                  type: event.payload.valueType,
                  encryptedValueRef: event.payload.encryptedValueRef ?? null,
                  taint: event.payload.sensitive ? "sensitive" : "public",
                });
                if (!previous) this.ctx.entities.insert("VariableValue", value);
                else {
                  const changed = database.run(
                    "UPDATE variables SET created_at=?,type=?,encrypted_value_ref=?,taint=?,data_json=?,version=version+1 WHERE workspace_id=? AND id=? AND version=?",
                    String(value.createdAt),
                    String(value.type),
                    typeof value.encryptedValueRef === "string" ? value.encryptedValueRef : null,
                    String(value.taint),
                    canonicalJson(value),
                    this.ctx.workspaceId,
                    previous.id,
                    previous.version ?? 1,
                  );
                  if (!changed.changes) throw new StaleFenceError();
                }
              });
            }
            if (event.type.startsWith("resource.")) {
              const resourceEvent = event as Extract<
                RunnerEvent,
                {
                  type:
                    | "resource.intent"
                    | "resource.created"
                    | "resource.uncertain"
                    | "resource.cleanup";
                }
              >;
              const payload = resourceEvent.payload;
              // A resource a cleanup lookup found belongs to that entry's step, not to the step
              // that was last executed; any other resource belongs to the executing step.
              const resourceStepId =
                payload.stepId !== undefined &&
                plan?.cleanup?.some(
                  (cleanup) => cleanup.find && cleanup.resourceRef === payload.stepId,
                )
                  ? payload.stepId
                  : (activeStepId ?? null);
              database.withTx(() => {
                leases.assertCurrent(fence);
                const previous = this.ctx.entities.get(
                  "ResourceRecord",
                  this.ctx.workspaceId,
                  payload.resourceId,
                );
                const proof =
                  payload.ownerProof &&
                  typeof payload.ownerProof === "object" &&
                  "sha256" in payload.ownerProof &&
                  typeof payload.ownerProof.sha256 === "string"
                    ? { contentHash: payload.ownerProof.sha256 }
                    : null;
                if (!previous) {
                  if (resourceEvent.type !== "resource.intent" || payload.state !== "planned")
                    throw new ContractError("PRECONDITION_FAILED", "Resource intent is missing");
                  this.ctx.entities.insert(
                    "ResourceRecord",
                    entity(this.ctx, "res", {
                      id: payload.resourceId,
                      creatorAttemptId: fence.attemptId,
                      resourceType: payload.resourceType,
                      handleRef: null,
                      cleanupPlan: {
                        stepId: resourceStepId,
                        correlationKey: payload.correlationKey,
                        declaration:
                          plan?.cleanup?.find(
                            (cleanup) => cleanup.resourceRef === resourceStepId,
                          ) ?? null,
                      },
                      state: "planned",
                      ownerProof: null,
                    }),
                  );
                } else {
                  if (previous.creatorAttemptId !== fence.attemptId) throw new StaleFenceError();
                  const transitions: Record<string, readonly string[]> = {
                    planned: ["created", "uncertain"],
                    created: ["cleanup_pending", "orphaned"],
                    uncertain: ["orphaned"],
                    cleanup_pending: ["cleaned", "orphaned"],
                    cleaned: [],
                    orphaned: [],
                  };
                  if (
                    payload.resourceType !== previous.resourceType ||
                    !transitions[String(previous.state)]?.includes(payload.state)
                  )
                    throw new ContractError(
                      "PRECONDITION_FAILED",
                      "Resource state transition is not authorized",
                    );
                  const next = validate<EntityDocument>("ResourceRecord", {
                    ...previous,
                    version: Number(previous.version) + 1,
                    state: payload.state,
                    handleRef: payload.handleRef ?? previous.handleRef,
                    ownerProof: proof ?? previous.ownerProof,
                  });
                  if (payload.state === "created" && (!next.handleRef || !next.ownerProof))
                    throw new ContractError(
                      "PRECONDITION_FAILED",
                      "Resource ownership proof is missing",
                    );
                  const changed = database.run(
                    "UPDATE resources SET state=?,data_json=?,version=version+1 WHERE workspace_id=? AND id=? AND version=? AND creator_attempt_id=?",
                    payload.state,
                    canonicalJson(next),
                    this.ctx.workspaceId,
                    previous.id,
                    previous.version ?? 1,
                    fence.attemptId,
                  );
                  if (!changed.changes) throw new StaleFenceError();
                }
              });
            }
            if (
              !event.type.startsWith("artifact.") &&
              event.type !== "secret.request" &&
              event.type !== "runner.hello"
            )
              execution.observe(fence, {
                id: entity(this.ctx, "evt", {}).id,
                seq: event.seq,
                payload: event,
              });
            if (event.type === "step.finished") {
              const payload = event.payload;
              execution.publish(
                fence,
                "StepResult",
                entity(this.ctx, "stp", {
                  attemptId: fence.attemptId,
                  planStepId: payload.stepId,
                  index: payload.index,
                  ...(payload.title ? { title: payload.title } : {}),
                  status: payload.status,
                  ...(payload.reasonCode ? { reasonCode: payload.reasonCode } : {}),
                  expected: payload.expected ?? null,
                  observed: payload.observed ?? null,
                  error: payload.error ?? null,
                  durationMs: payload.durationMs,
                  evidenceRefs: payload.evidencePaths.map((relativePath) => ({
                    relativePath,
                    snapshotId,
                  })),
                }),
              );
            }
            // Artifact chunks and secret requests are transport, not durable user-visible events.
            if (
              !event.type.startsWith("artifact.") &&
              event.type !== "secret.request" &&
              event.type !== "runner.hello"
            ) {
              database.withTx(() =>
                new OutboxRepository(database).append(this.ctx.workspaceId, run.id, event.type, {
                  attemptId: fence.attemptId,
                  ...event.payload,
                }),
              );
            }
          },
        },
        controller.signal,
      );
      prepared?.finish({ outcome: result.outcome, reasonCode: result.reasonCode });
      const cleanupFailure = result.cleanupFailure;
      if (cleanupFailure) {
        this.quarantineWorker({
          runId: run.id,
          attemptId: fence.attemptId,
          reason:
            cleanupFailure.type === "container"
              ? "container_cleanup_failed"
              : "browser_profile_cleanup_failed",
          containerName: cleanupFailure.containerName ?? `tm-att-${fence.attemptId}`,
          details: cleanupFailure,
        });
      }
      if (heartbeatError) throw heartbeatError;
      execution.progress(fence, "collecting");
      timer.mark("collecting");
      let evidenceComplete = false;
      let unavailableEvidence: {
        relativePath: string;
        kind: string;
        state: string;
        omissionReason?: string;
      }[] = [];
      if (result.bundle) {
        const bundle = await verifyBundle(result.bundle.bundleDir, {
          workspaceId: this.ctx.workspaceId,
          runId: run.id,
          attemptId: fence.attemptId,
          revisionId: run.revisionId,
          snapshotId,
          manifestSha256: result.bundle.manifestSha256,
        });
        database.withTx(() => {
          execution.publish(fence, "Snapshot", {
            id: snapshotId,
            workspaceId: this.ctx.workspaceId,
            runId: run.id,
            attemptId: fence.attemptId,
            revisionId: run.revisionId,
            manifestHash: bundle.meta.manifestHash,
            committedAt: bundle.meta.committedAt,
            redactionPolicyHash: bundle.meta.redactionPolicyHash,
            executionSnapshot: sealedSnapshot,
          });
          for (const entry of bundle.manifest.entries) {
            assertArtifactPublishable(database, this.ctx.workspaceId, entry.artifactId);
            execution.publish(fence, "Artifact", {
              id: entry.artifactId,
              workspaceId: this.ctx.workspaceId,
              runId: run.id,
              attemptId: fence.attemptId,
              revisionId: run.revisionId,
              snapshotId,
              extensions: { "testmaster:correlationId": correlation },
              kind: entry.kind,
              hash: entry.sha256,
              bytes: entry.sizeBytes,
              mime: entry.mimeType,
              storageKey: `runs/${this.ctx.workspaceId}/${run.id}/${fence.attemptId}/${entry.relativePath}`,
              state: entry.state,
              redactionStatus: entry.redactionStatus,
            });
          }
        });
        await rm(join(result.bundle.bundleDir, ".partial"), { force: true });
        unavailableEvidence = bundle.manifest.entries
          .filter((entry) => entry.state !== "available")
          .map((entry) => ({
            relativePath: entry.relativePath,
            kind: entry.kind,
            state: entry.state,
            ...(entry.omissionReason ? { omissionReason: entry.omissionReason } : {}),
          }));
        evidenceComplete = unavailableEvidence.length === 0;
      }
      const attempts = this.observations(run.id, plan);
      const current = attempts.find((attempt) => attempt.attemptId === fence.attemptId);
      if (current) {
        current.reasonCode = result.reasonCode;
        current.stopConfirmed = result.outcome === "cancelled";
        if (
          (result.outcome === "blocked" || result.outcome === "inconclusive") &&
          canRetry(current, limits.maxAttempts ?? 2)
        ) {
          recordTiming();
          leases.release(fence, true);
          return;
        }
      }
      const reduced = reduceOutcome(attempts, assertions, requiredSteps, {
        authorized: this.cancelled(run.id),
        stopConfirmed: result.outcome === "cancelled",
      });
      if (reduced.outcome === "passed" && result.outcome !== "passed") {
        reduced.outcome = result.outcome === "blocked" ? "blocked" : "inconclusive";
        reduced.reasonCode = result.reasonCode;
      }
      const terminal = result.events.findLast((event) => event.type === "runner.finished");
      const cleanupOutcome = cleanupFailure
        ? "failed"
        : (terminal?.payload.cleanupOutcome ?? "not_required");
      const gate = evaluateGate(reduced.outcome, cleanupOutcome, {
        cleanupRequired: Boolean(plan?.cleanup?.length) || Boolean(cleanupFailure),
        requiredEvidenceComplete: evidenceComplete,
        policySatisfied: true,
        requiredDependenciesPassed: true,
      });
      // A pass whose gate failed on evidence must say so; `assertions_satisfied` alone reads as success.
      if (reduced.outcome === "passed" && gate === "failed" && !evidenceComplete)
        reduced.reasonCode = "evidence_incomplete";
      if (agent && result.outcome === "passed") {
        leases.assertCurrent(fence);
        const candidate = agent.candidate(run.id);
        if (candidate)
          database.withTx(() =>
            new OutboxRepository(database).append(
              this.ctx.workspaceId,
              run.id,
              "run.agent_candidate",
              {
                candidateRevisionId: candidate.id,
                verificationRequired: true,
                deterministicAssertions: assertions,
                semanticJudgments: [],
              },
            ),
          );
      }
      recordTiming();
      execution.finalize(
        fence,
        {
          ...run,
          phase: "completed",
          status: reduced.outcome,
          outcome: reduced.outcome,
          gate,
          cleanupOutcome,
          analysisStatus: "not_requested",
        },
        reduced.reasonCode,
      );
      database.withTx(() =>
        new OutboxRepository(database).append(this.ctx.workspaceId, run.id, "run.reduced", {
          ...reduced,
          ...(unavailableEvidence.length ? { unavailableEvidence } : {}),
          isolation: cell.executor === "process" ? "none" : "docker",
        }),
      );
    } catch (error) {
      if (error instanceof StaleFenceError) return;
      try {
        leases.assertCurrent(fence);
        database.withTx(() =>
          this.abandonResources(fence.attemptId, () => leases.assertCurrent(fence)),
        );
        const attempts = this.observations(run.id, plan);
        const reduced = reduceOutcome(attempts, assertions, requiredSteps);
        if (
          ((error instanceof ContractError &&
            typeof error.details.reasonCode === "string" &&
            (error.details.reasonCode === "security_precondition_failed" ||
              authBlockReasons.has(error.details.reasonCode))) ||
            error instanceof PolicyDenied) &&
          reduced.outcome !== "failed"
        ) {
          reduced.outcome = "blocked";
          reduced.reasonCode =
            error instanceof ContractError && typeof error.details.reasonCode === "string"
              ? error.details.reasonCode
              : "security_precondition_failed";
        }
        recordTiming();
        const containerCleanupFailed =
          error instanceof ContainerCleanupError ||
          (error instanceof Error && error.message.includes("container_cleanup_failed"));
        const cleanupOutcome = containerCleanupFailed ? "failed" : "inconclusive";
        if (containerCleanupFailed) {
          const containerName =
            error instanceof ContainerCleanupError
              ? error.containerName
              : `tm-att-${fence.attemptId}`;
          this.quarantineWorker({
            runId: run.id,
            attemptId: fence.attemptId,
            reason: "container_cleanup_failed",
            containerName,
            details: { error: (error as Error).message },
          });
        }
        const errorReason =
          error instanceof PolicyDenied
            ? "security_precondition_failed"
            : error instanceof EvidenceQuotaError
              ? // Collection exceeded the configured artifact limits (spec 11).
                "artifact_limit_exceeded"
              : error instanceof ContractError
                ? (error.details.reasonCode ?? "insufficient_evidence")
                : "insufficient_evidence";
        // A proven verdict keeps its own reason; otherwise the error's registered reason is final.
        // A pass whose gate the error failed never keeps `assertions_satisfied`: that reads as success.
        const finalReason =
          (reduced.outcome === "passed" ||
            reduced.outcome === "blocked" ||
            reduced.outcome === "inconclusive") &&
          typeof errorReason === "string" &&
          Object.hasOwn(reasonRegistry, errorReason)
            ? errorReason
            : reduced.reasonCode;
        execution.finalize(
          fence,
          {
            ...run,
            phase: "completed",
            status: reduced.outcome,
            outcome: reduced.outcome,
            gate: "failed",
            cleanupOutcome,
            analysisStatus: "not_requested",
          },
          finalReason,
        );
        database.withTx(() =>
          new OutboxRepository(database).append(
            this.ctx.workspaceId,
            run.id,
            "run.execution_error",
            {
              reasonCode: errorReason,
              ...(error instanceof ContractError ? { details: error.details } : {}),
              error: error instanceof ContractError ? error.code : "INTERNAL",
              ...(error &&
              typeof error === "object" &&
              "code" in error &&
              typeof error.code === "string" &&
              /^(?:E[A-Z0-9_]+|ERR_SOCKET_BAD_PORT)$/u.test(error.code)
                ? { diagnosticCode: error.code }
                : {}),
              ...(error instanceof ContractError ? { message: error.message } : {}),
            },
          ),
        );
      } catch (stale) {
        if (!(stale instanceof StaleFenceError)) throw stale;
      }
    } finally {
      clearInterval(poll);
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", abort);
      this.active.delete(run.id);
      await this.eraseSettledCaptures();
      await rm(inputDir, { recursive: true, force: true });
      logs.record({
        component: "worker",
        event: "attempt.completed",
        correlationId: correlation,
        runId: run.id,
        attemptId: fence.attemptId,
      });
      await logs.flush();
      if (run.origin === "verification") {
        try {
          await this.host.healing?.settlePending();
        } catch (error) {
          new OutboxRepository(database).append(
            this.ctx.workspaceId,
            run.id,
            "healing.reconciliation_failed",
            {
              error: error instanceof ContractError ? error.code : "INTERNAL",
            },
          );
        }
      }
    }
  }
  async reconcile(options: { dryRun?: boolean } = {}) {
    this.ctx.authorize("A");
    if (options.dryRun) {
      return {
        dryRun: true,
        actor: this.ctx.principalId,
        actions: this.ctx.database.all(
          `SELECT id,resource_id,state,fence FROM job_leases WHERE workspace_id=? AND dispatchable=1 AND ${runJobFilter} AND (state='reconciliation_required' OR (state='leased' AND lease_expires_at<=?))`,
          this.ctx.workspaceId,
          new Date().toISOString(),
        ),
        orphanStaging: await findOrphanStaging(this.host.config.dataDir),
        pendingOutbox: Number(
          this.ctx.database.get(
            "SELECT COUNT(*) AS n FROM outbox WHERE workspace_id=? AND delivery_state='pending' AND dispatchable=1",
            this.ctx.workspaceId,
          )?.n ?? 0,
        ),
        missingArtifactReferences: await this.countMissingArtifactReferences(),
      };
    }
    return this.maintenance();
  }
  private async countMissingArtifactReferences(): Promise<number> {
    const root = new ConfinedRoot(this.host.config.dataDir);
    let missing = 0;
    try {
      for (const row of this.ctx.database.all(
        "SELECT storage_key FROM artifacts WHERE workspace_id=? AND state='available'",
        this.ctx.workspaceId,
      )) {
        try {
          await (await root.openFile(String(row.storage_key))).close();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          missing++;
        }
      }
    } finally {
      root.close();
    }
    return missing;
  }
  private quarantineWorker(info: {
    runId: string;
    attemptId: string;
    reason: string;
    containerName?: string;
    profilePath?: string;
    details?: unknown;
  }): { incidentId: string; quarantinedAt: string } {
    const incidentId = `inc_${randomUUID()}`;
    const quarantinedAt = new Date().toISOString();
    const quarantineRecord = {
      incidentId,
      workspaceId: this.ctx.workspaceId,
      runId: info.runId,
      attemptId: info.attemptId,
      workerId: this.workerId,
      reason: info.reason,
      containerName: info.containerName,
      profilePath: info.profilePath,
      quarantinedAt,
      details: info.details,
    };
    const incidentRecord = {
      id: incidentId,
      workspaceId: this.ctx.workspaceId,
      type: "worker_cleanup_quarantine",
      severity: "high",
      createdAt: quarantinedAt,
      runId: info.runId,
      attemptId: info.attemptId,
      reason: info.reason,
      status: "active",
      details: {
        containerName: info.containerName,
        profilePath: info.profilePath,
        workerId: this.workerId,
        ...(info.details && typeof info.details === "object" ? info.details : {}),
      },
    };
    this.ctx.database.withTx(() => {
      this.ctx.database.run(
        "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        `worker:quarantine:${this.ctx.workspaceId}`,
        canonicalJson(quarantineRecord),
      );
      this.ctx.database.run(
        "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        `incident:${incidentId}`,
        canonicalJson(incidentRecord),
      );
      const outbox = new OutboxRepository(this.ctx.database);
      outbox.append(this.ctx.workspaceId, info.runId, "worker.quarantined", quarantineRecord);
      outbox.append(this.ctx.workspaceId, info.runId, "incident.created", incidentRecord);
    });
    return { incidentId, quarantinedAt };
  }
  isQuarantined(): boolean {
    const row = this.ctx.database.get(
      "SELECT value FROM operational_state WHERE key=?",
      `worker:quarantine:${this.ctx.workspaceId}`,
    );
    return Boolean(row);
  }
  quarantineStatus(): {
    quarantined: boolean;
    record: Record<string, unknown> | null;
    incident: Record<string, unknown> | null;
  } {
    this.ctx.authorize("R");
    const row = this.ctx.database.get(
      "SELECT value FROM operational_state WHERE key=?",
      `worker:quarantine:${this.ctx.workspaceId}`,
    );
    if (!row) return { quarantined: false, record: null, incident: null };
    const parsed = JSON.parse(String(row.value));
    const record = parsed && typeof parsed === "object" ? parsed : {};
    const incidentId =
      "incidentId" in record && typeof record.incidentId === "string" ? record.incidentId : null;
    const incidentRow = incidentId
      ? this.ctx.database.get(
          "SELECT value FROM operational_state WHERE key=?",
          `incident:${incidentId}`,
        )
      : null;
    const incident = incidentRow ? JSON.parse(String(incidentRow.value)) : null;
    return { quarantined: true, record, incident };
  }
  async clearQuarantine(): Promise<{
    cleared: boolean;
    incidentId?: string;
    containerRemoved?: boolean;
    profileRemoved?: boolean;
  }> {
    const key = `worker:quarantine:${this.ctx.workspaceId}`;
    auditSecurity(this.ctx, "worker.quarantine.clear", key, "requested");
    try {
      this.ctx.authorize("A");
    } catch (error) {
      auditSecurity(this.ctx, "worker.quarantine.clear", key, "denied");
      throw error;
    }
    const row = this.ctx.database.get("SELECT value FROM operational_state WHERE key=?", key);
    if (!row) {
      return { cleared: false };
    }
    const originalValue = String(row.value);
    const parsed = JSON.parse(originalValue);
    if (!parsed || typeof parsed !== "object") {
      return { cleared: false };
    }
    const incidentId =
      "incidentId" in parsed && typeof parsed.incidentId === "string"
        ? parsed.incidentId
        : "quarantine";
    const runId = "runId" in parsed && typeof parsed.runId === "string" ? parsed.runId : undefined;
    const containerName =
      "containerName" in parsed && typeof parsed.containerName === "string"
        ? parsed.containerName
        : undefined;
    const profilePath =
      "profilePath" in parsed && typeof parsed.profilePath === "string"
        ? parsed.profilePath
        : undefined;
    const incidentKey = `incident:${incidentId}`;
    let containerRemoved = false;
    let profileRemoved = false;
    const docker = this.dockerExecutor();
    if (containerName) {
      let containerExists = false;
      try {
        containerExists = await docker.exists(containerName);
      } catch {
        containerExists = true;
      }
      if (containerExists) {
        try {
          await docker.remove(containerName);
          containerRemoved = true;
        } catch (error) {
          auditSecurity(this.ctx, "worker.quarantine.clear", incidentId, "denied");
          const errorMsg = error instanceof Error ? error.message : String(error);
          throw new ContractError(
            "PRECONDITION_FAILED",
            `Refusing unsafe quarantine clear: leftover container ${containerName} is still present and could not be cleaned`,
            { containerName, error: errorMsg },
          );
        }
      }
    }
    if (profilePath) {
      try {
        const stats = await lstat(profilePath).catch(() => null);
        if (stats) {
          await rm(profilePath, { recursive: true, force: true });
          profileRemoved = true;
        }
      } catch (error) {
        auditSecurity(this.ctx, "worker.quarantine.clear", incidentId, "denied");
        const errorMsg = error instanceof Error ? error.message : String(error);
        throw new ContractError(
          "PRECONDITION_FAILED",
          `Refusing unsafe quarantine clear: leftover profile directory ${profilePath} is still present and could not be cleaned`,
          { profilePath, error: errorMsg },
        );
      }
    }
    const clearedAt = new Date().toISOString();
    this.ctx.database.withTx(() => {
      const deleted = this.ctx.database.run(
        "DELETE FROM operational_state WHERE key=? AND value=?",
        key,
        originalValue,
      );
      if (deleted.changes !== 1) {
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Quarantine state changed concurrently during clear",
        );
      }
      const incRow = this.ctx.database.get(
        "SELECT value FROM operational_state WHERE key=?",
        incidentKey,
      );
      if (incRow) {
        const incident = JSON.parse(String(incRow.value));
        if (incident && typeof incident === "object") {
          this.ctx.database.run(
            "UPDATE operational_state SET value=? WHERE key=?",
            canonicalJson({ ...incident, status: "cleared", clearedAt }),
            incidentKey,
          );
        }
      }
      const outbox = new OutboxRepository(this.ctx.database);
      outbox.append(this.ctx.workspaceId, runId ?? incidentId, "worker.quarantine_cleared", {
        incidentId,
        clearedAt,
        containerRemoved,
        profileRemoved,
      });
      auditSecurity(this.ctx, "worker.quarantine.clear", incidentId, "allowed");
    });
    return {
      cleared: true,
      incidentId,
      containerRemoved,
      profileRemoved,
    };
  }
  private abandonResources(attemptId: string, assertOwnership: () => void): void {
    assertOwnership();
    const rows = this.ctx.database.all(
      "SELECT data_json FROM resources WHERE workspace_id=? AND creator_attempt_id=? AND state NOT IN ('cleaned','orphaned')",
      this.ctx.workspaceId,
      attemptId,
    );
    for (const row of rows) {
      const resource = validate<EntityDocument>(
        "ResourceRecord",
        JSON.parse(String(row.data_json)),
      );
      const state = resource.state === "planned" ? "uncertain" : "orphaned";
      const attempt = this.ctx.database.get(
        "SELECT run_id FROM attempts WHERE workspace_id=? AND id=?",
        this.ctx.workspaceId,
        attemptId,
      );
      new OutboxRepository(this.ctx.database).append(
        this.ctx.workspaceId,
        String(resource.id),
        "resource.orphaned",
        { resourceId: resource.id, runId: attempt ? String(attempt.run_id) : null, state },
      );
      const next = { ...resource, state, version: Number(resource.version ?? 1) + 1 };
      this.ctx.database.run(
        "UPDATE resources SET state=?,data_json=?,version=version+1 WHERE workspace_id=? AND id=? AND version=?",
        state,
        canonicalJson(next),
        this.ctx.workspaceId,
        resource.id,
        resource.version ?? 1,
      );
    }
  }
  /** Erases sensitive captures that no dependent, reuse window or live resource can need any more. */
  private async eraseSettledCaptures(): Promise<void> {
    for (const secretId of erasableCaptureSecretIds(this.ctx)) {
      try {
        await this.host.secrets.eraseCapture(secretId);
      } catch {
        // The reference stays live; the next maintenance pass retries.
        auditSecurity(this.ctx, "secret.capture.erase", secretId, "denied");
      }
    }
  }
  private async maintenance() {
    const database = this.ctx.database;
    const leases = new LeaseRepository(database);
    const expired = leases.expire();
    await this.eraseSettledCaptures();
    const pending = database.all(
      `SELECT * FROM job_leases WHERE workspace_id=? AND state='reconciliation_required' AND dispatchable=1 AND ${runJobFilter}`,
      this.ctx.workspaceId,
    );
    for (const job of pending) {
      const run = this.host.runs.get(String(job.resource_id));
      const revision = requireEntity(this.ctx, "TestRevision", run.revisionId);
      const plan = revision.plan ? validate<ExecutablePlan>("ExecutablePlan", revision.plan) : null;
      const attempts = this.observations(run.id, plan);
      const last = attempts.at(-1);
      const cell = run.matrixCell as Record<string, unknown>;
      const limits = cell.limits as Record<string, number>;
      if (last && canRetry(last, limits.maxAttempts ?? 2) && !this.cancelled(run.id)) {
        try {
          leases.resume(this.ctx.workspaceId, String(job.id), Number(job.fence));
        } catch (error) {
          if (!(error instanceof StaleFenceError)) throw error;
        }
      } else {
        const required = plan
          ? planSteps(plan).filter((step) => step.required !== false)
          : [{ id: "imported-code", kind: "assertion" }];
        const reduced = reduceOutcome(
          attempts,
          required
            .filter((step) => step.kind === "assertion" || "expectation" in step)
            .map((step) => step.id),
          required.map((step) => step.id),
        );
        if (reduced.outcome === "passed") {
          reduced.outcome = "inconclusive";
          reduced.reasonCode = "worker_lost";
        }
        database.withTx(() => {
          const currentJob = database.get(
            "SELECT state,fence FROM job_leases WHERE workspace_id=? AND id=?",
            this.ctx.workspaceId,
            job.id,
          );
          if (currentJob?.state !== "reconciliation_required" || currentJob.fence !== job.fence)
            return;
          for (const attempt of attempts)
            this.abandonResources(attempt.attemptId, () => {
              const current = database.get(
                "SELECT state,fence FROM job_leases WHERE workspace_id=? AND id=?",
                this.ctx.workspaceId,
                job.id,
              );
              if (current?.state !== "reconciliation_required" || current.fence !== job.fence)
                throw new StaleFenceError();
            });
          const changed = database.run(
            "UPDATE runs SET phase='completed',outcome=?,status=?,gate='failed',cleanup_outcome='inconclusive',version=version+1 WHERE workspace_id=? AND id=? AND phase<>'completed'",
            reduced.outcome,
            reduced.outcome,
            this.ctx.workspaceId,
            run.id,
          );
          if (changed.changes)
            new OutboxRepository(database).append(this.ctx.workspaceId, run.id, "run.completed", {
              ...reduced,
              reasonCode: last?.externalEffectUncertain
                ? "retry_unsafe_external_effect"
                : "worker_lost",
            });
          database.run(
            "UPDATE job_leases SET state='completed' WHERE workspace_id=? AND id=? AND state='reconciliation_required' AND fence=?",
            this.ctx.workspaceId,
            job.id,
            job.fence,
          );
        });
      }
    }
    const reaped = await this.dockerExecutor()
      .reapOrphans(async (attemptId) => {
        const row = database.get(
          "SELECT j.state FROM attempts a JOIN job_leases j ON j.workspace_id=a.workspace_id AND j.id=a.job_id WHERE a.workspace_id=? AND a.id=?",
          this.ctx.workspaceId,
          attemptId,
        );
        return Boolean(row && row.state !== "leased");
      })
      .catch(() => []);
    const orphans = await findOrphanStaging(this.host.config.dataDir).catch(() => []);
    const removed = await collectGarbage(
      this.host.config.dataDir,
      orphans.map((orphan) => ({ relativePath: orphan.relativePath, version: 1 })),
      {
        inspect: async (candidate) => {
          const partial = JSON.parse(
            await readFile(
              join(this.host.config.dataDir, candidate.relativePath, ".partial"),
              "utf8",
            ),
          ) as Record<string, string>;
          const lease = database.get(
            "SELECT j.state FROM attempts a JOIN job_leases j ON j.workspace_id=a.workspace_id AND j.id=a.job_id WHERE a.workspace_id=? AND a.id=?",
            this.ctx.workspaceId,
            partial.attemptId,
          );
          const references = database.get(
            "SELECT COUNT(*) AS n FROM snapshots WHERE workspace_id=? AND attempt_id=?",
            this.ctx.workspaceId,
            partial.attemptId,
          );
          return {
            activeAttempt: lease?.state === "leased",
            validUploadLease: false,
            legalHold: false,
            liveReferences: Number(references?.n ?? 0),
          };
        },
        mark: async () => ({ version: 2 }),
        tombstone: async (candidate) => {
          // Publication is fenced by a live lease; orphan markers have no public snapshot.
          const partial = JSON.parse(
            await readFile(
              join(this.host.config.dataDir, candidate.relativePath, ".partial"),
              "utf8",
            ),
          ) as Record<string, string>;
          const live = database.get(
            "SELECT 1 FROM snapshots WHERE workspace_id=? AND attempt_id=? UNION SELECT 1 FROM attempts a JOIN job_leases j ON j.workspace_id=a.workspace_id AND j.id=a.job_id WHERE a.workspace_id=? AND a.id=? AND j.state='leased'",
            this.ctx.workspaceId,
            partial.attemptId,
            this.ctx.workspaceId,
            partial.attemptId,
          );
          return live ? null : { version: 3 };
        },
        deleted: async () => {},
      },
    );
    await this.host.retention?.maintenance();
    await this.host.analysis?.settlePending();
    try {
      await this.host.healing?.settlePending();
    } catch (error) {
      new OutboxRepository(database).append(
        this.ctx.workspaceId,
        this.ctx.workspaceId,
        "healing.maintenance_failed",
        {
          error: error instanceof ContractError ? error.code : "INTERNAL",
        },
      );
    }
    for (const row of new OutboxRepository(database).pending(this.ctx.workspaceId))
      new OutboxRepository(database).delivered(this.ctx.workspaceId, String(row.id));
    const storage = await statfs(this.host.config.dataDir);
    return {
      expired,
      reaped,
      orphanStaging: orphans.length,
      removed,
      availableBytes: Number(storage.bavail) * Number(storage.bsize),
    };
  }
  /** Free bytes and the worst-case evidence of the runs in progress, read before a claim. */
  private async storageRoom(): Promise<Omit<StorageRoom, "incomingBytes">> {
    return {
      freeBytes: await freeDataBytes(this.host.config.dataDir),
      inFlightBytes: inFlightEvidenceBytes(this.ctx.database),
    };
  }
  private worstCaseEvidence(runId: string): number {
    return runEvidenceBytes(runMatrixCell(this.host.runs.get(runId)).limits as EvidenceLimits);
  }
  /**
   * Suite pacing: a member waits for the interval after its predecessor's start, measured at
   * claim. A cancelled member is eligible so it can finalize without waiting.
   */
  private memberIntervalReady(runId: string): boolean {
    const cell = runMatrixCell(this.host.runs.get(runId));
    const predecessorId = cell.memberPredecessorRunId;
    if (typeof predecessorId !== "string" || this.cancelled(runId)) return true;
    const started = this.ctx.database.get(
      "SELECT started_at FROM attempts WHERE workspace_id=? AND run_id=? ORDER BY number LIMIT 1",
      this.ctx.workspaceId,
      predecessorId,
    )?.started_at;
    return memberIntervalReady({
      intervalMs: typeof cell.memberIntervalMs === "number" ? cell.memberIntervalMs : undefined,
      predecessorStartedAt: typeof started === "string" ? started : null,
      predecessorCompleted: this.host.runs.get(predecessorId).phase === "completed",
      now: Date.now(),
    });
  }
  /**
   * Turns the enrolled placeholder into this process's worker: declared capabilities and image
   * digests replace the empty ones and the worker becomes ready. A revoked worker never starts,
   * and an identity whose process is still alive cannot be taken over.
   */
  private adoptEnrolled(workerId: string, declared: Record<string, unknown>): void {
    this.ctx.database.withTx(() => {
      const current = requireEntity(this.ctx, "Worker", workerId);
      if (current.state === "revoked")
        throw new ContractError("FORBIDDEN", "Worker is revoked", { workerId });
      const heartbeat = current.lastHeartbeatAt ? Date.parse(String(current.lastHeartbeatAt)) : 0;
      if (current.state === "ready" && Date.now() - heartbeat < 30000)
        throw new ContractError("PRECONDITION_FAILED", "Worker identity is already in use", {
          workerId,
        });
      const labels = {
        ...(current.labels as Record<string, string>),
        ...(declared.labels as Record<string, string>),
      };
      this.ctx.entities.update("Worker", this.ctx.workspaceId, workerId, Number(current.version), {
        ...current,
        ...declared,
        labels,
        version: Number(current.version) + 1,
      });
    });
    this.workerId = workerId;
  }
  async run(
    options: {
      signal?: AbortSignal;
      ephemeral?: boolean;
      runIds?: string[];
      capacity?: WorkerCapacity;
      handshake?: WorkerHandshake;
      /** An enrolled worker (REQ-038) this process becomes instead of registering a new row. */
      workerId?: string;
      /** Called once when a contended writer lock has kept one operation waiting past 5 s. */
      onContended?: (elapsedMs: number) => void;
      /** Called once a registered worker is recorded ready and about to claim, with its id. */
      onReady?: (workerId: string) => void;
    } = {},
  ) {
    if (options.ephemeral && options.runIds?.length) {
      for (const id of options.runIds) {
        const run = this.host.runs.get(id);
        const cell = run.matrixCell as Record<string, unknown>;
        if (run.origin === "verification" && typeof cell.healingProposalId === "string") {
          const proposal = requireEntity(this.ctx, "HealingProposal", cell.healingProposalId);
          if (
            proposal.verificationRunId !== id ||
            !["approved", "verified"].includes(String(proposal.status))
          )
            throw new ContractError("FORBIDDEN", "Run is not an approved healing verification");
          const test = requireEntity(this.ctx, "TestCase", run.testId);
          if (proposal.approvalMode === "manual") this.ctx.authorize("W", String(test.projectId));
          else this.ctx.authorize("X", String(test.projectId));
        } else this.ctx.authorize("X");
      }
    } else this.ctx.authorize(options.ephemeral ? "X" : "A");
    this.drainRequested = false;
    const database = this.ctx.database;
    const leases = new LeaseRepository(database);
    const runIds = options.ephemeral
      ? this.host.runs.expandRunIds(options.runIds ?? [])
      : undefined;
    const storage = await statfs(this.host.config.dataDir);
    const capacity = validateCapacity(
      options.capacity ?? {
        cpu: availableParallelism(),
        memoryBytes: totalmem(),
        pids: 1024,
        diskBytes: Number(storage.bavail) * Number(storage.bsize),
        pools: {
          browser: defaults.browserConcurrency,
          http: defaults.httpConcurrency,
          python: defaults.pythonConcurrency,
          // Terminal sessions share the heavyweight envelope class (1 GiB, 256 PIDs) of the browser pool.
          terminal: defaults.browserConcurrency,
        },
      },
    );
    const needsImages =
      !options.ephemeral ||
      (runIds ?? []).some((id) => {
        const run = this.host.runs.get(id);
        return (
          run.phase !== "completed" &&
          (run.matrixCell as Record<string, unknown>).executor !== "process" &&
          !this.dependencies(run).some((binding) => {
            const upstream = this.host.runs.get(binding.producerRunId);
            return upstream.phase === "completed" && upstream.gate !== "passed";
          })
        );
      });
    const lock = needsImages ? await this.host.images() : null;
    const availableHandshake = lock ? localHandshake(lock) : null;
    const handshake = availableHandshake
      ? validateHandshake(options.handshake ?? availableHandshake, availableHandshake)
      : null;
    const kindOf = (id: string): ExecutorKind => {
      const run = this.host.runs.get(id);
      const revision = requireEntity(this.ctx, "TestRevision", run.revisionId);
      const runner = revision.runnerKind ?? (revision.plan as ExecutablePlan | null)?.runner;
      return executorKindOf(runner);
    };
    const tasks = new Set<Promise<void>>();
    // Writer contention is transient and has no total deadline: each operation waits for the writer
    // (full-jitter backoff) until the lock frees or the abort signal ends it. The signal is
    // honored only while nothing is in flight, so a draining worker keeps its tasks.
    const contended = <T>(operation: () => T | Promise<T>): Promise<T> =>
      retryWriterContention(operation, {
        signal: tasks.size === 0 ? options.signal : undefined,
        onContended: options.onContended,
        inTransaction: () => database.inTransaction,
      });
    if (!options.ephemeral && handshake) {
      const declared = {
        identityRef: this.owner,
        capabilities: handshake.runners.map((runner) =>
          runner === "playwright" ? "browser" : runner,
        ),
        imageDigests: handshake.imageDigests,
        labels: {
          pid: String(process.pid),
          architecture: process.arch,
          os: process.platform,
          capacity: JSON.stringify(capacity),
          schemaVersions: JSON.stringify(handshake.schemaVersions),
          runnerVersion: handshake.runnerVersion,
          // The action list outgrew the 200-character label bound; the label carries its size and digest.
          actions: `${handshake.actions.length}:${semanticHash(handshake.actions)}`,
          slots: String(this.host.config.effectiveConfig.config.execution?.concurrency ?? 2),
        },
        state: "ready",
        lastHeartbeatAt: new Date().toISOString(),
      };
      // The id is fixed before the first attempt: a contended transaction never started, so a
      // repeat can neither duplicate the row nor skip it.
      const registered = options.workerId ? null : entity(this.ctx, "wrk", declared);
      await contended(() => {
        if (options.workerId) this.adoptEnrolled(options.workerId, declared);
        else if (registered) this.ctx.entities.insert("Worker", registered);
      });
      this.workerId = options.workerId ?? registered?.id ?? null;
    }
    let lastMaintenance = Date.now();
    let drainStart: number | null = null;
    // A build older than the database must not claim: it stops claiming, lets in-flight work
    // finish under its fenced leases, and ends with `worker_schema_behind` (ADR-015, OPS-038).
    let schemaRefusal: ContractError | null = null;
    let lastSchemaCheck = 0;
    let outcome:
      | { failed: false; value: { workerId: string | null; drained: true } }
      | { failed: true; error: unknown };
    try {
      await contended(() => this.maintenance());
      if (this.workerId) options.onReady?.(this.workerId);
      for (;;) {
        if (this.workerId) {
          // One unit so a contended heartbeat repeats whole; the worker stays ready while it is alive.
          const row = await contended(() => {
            database.withTx(() =>
              database.run(
                "UPDATE workers SET last_heartbeat_at=? WHERE workspace_id=? AND id=?",
                new Date().toISOString(),
                this.ctx.workspaceId,
                this.workerId,
              ),
            );
            return database.get(
              "SELECT state FROM workers WHERE workspace_id=? AND id=?",
              this.ctx.workspaceId,
              this.workerId,
            );
          });
          if (row?.state !== "ready") this.drainRequested = true;
          // Revocation is not a drain: work in flight stops now and its fenced writes are refused.
          if (row?.state === "revoked")
            for (const controller of this.active.values()) controller.abort();
        }
        if (!schemaRefusal && Date.now() - lastSchemaCheck >= schemaCheckIntervalMs) {
          lastSchemaCheck = Date.now();
          const schema = database.schemaCompatibility();
          if (schema.state === "ahead") {
            schemaRefusal = new ContractError(
              "PRECONDITION_FAILED",
              "Worker build is older than the database schema; upgrade this worker",
              { reasonCode: "worker_schema_behind", ...schema },
            );
            this.drainRequested = true;
            if (this.workerId)
              await contended(() =>
                database.withTx(() =>
                  database.run(
                    "UPDATE workers SET state='draining' WHERE workspace_id=? AND id=? AND state='ready'",
                    this.ctx.workspaceId,
                    this.workerId,
                  ),
                ),
              );
          }
        }
        if (options.signal?.aborted) {
          this.drainRequested = true;
          if (options.ephemeral) for (const id of options.runIds ?? []) this.host.runs.cancel(id);
        }
        if (this.drainRequested && drainStart === null) drainStart = performance.now();
        if (drainStart !== null && performance.now() - drainStart > 60000)
          for (const controller of this.active.values()) controller.abort();
        const done =
          options.ephemeral &&
          (options.runIds ?? []).every((id) => this.host.runs.get(id).phase === "completed");
        if ((done || this.drainRequested) && tasks.size === 0) break;
        const queued = database.get(
          "SELECT r.data_json FROM runs r JOIN job_leases j ON j.workspace_id=r.workspace_id AND j.resource_id=r.id WHERE r.workspace_id=? AND j.state='queued' ORDER BY j.available_at,j.id LIMIT 1",
          this.ctx.workspaceId,
        );
        const next = queued
          ? (validate("Run", JSON.parse(String(queued.data_json))) as {
              matrixCell: Record<string, unknown>;
            })
          : null;
        const concurrency = Math.min(
          this.host.config.effectiveConfig.config.execution?.concurrency ?? 2,
          Number(next?.matrixCell.maxConcurrency ?? 2),
        );
        if (this.isQuarantined()) {
          if (Date.now() - lastMaintenance >= defaults.reconcilerIntervalMs) {
            await contended(() => this.maintenance());
            lastMaintenance = Date.now();
          }
          await delay(200);
          continue;
        }
        if (!this.drainRequested && !done && tasks.size < concurrency) {
          // Read before the claim transaction: statfs is asynchronous and the in-flight runs of
          // every workspace are read with the controller scope.
          const room = next ? await this.storageRoom() : null;
          // Selection, actor revocation and the claim repeat as a unit while the writer is contended.
          const fence = await contended(() => {
            const candidates = database
              .all(
                "SELECT r.id FROM runs r JOIN job_leases j ON j.workspace_id=r.workspace_id AND j.resource_id=r.id WHERE r.workspace_id=? AND j.state='queued' ORDER BY j.available_at,j.id",
                this.ctx.workspaceId,
              )
              .map((row) => String(row.id))
              .filter(
                (id) =>
                  (!runIds || runIds.includes(id)) &&
                  (this.cancelled(id) ||
                    typeof runMatrixCell(this.host.runs.get(id)).flakePredecessorRunId !==
                      "string" ||
                    this.host.runs.get(
                      String(runMatrixCell(this.host.runs.get(id)).flakePredecessorRunId),
                    ).phase === "completed") &&
                  (!handshake ||
                    !lock ||
                    supportsQueuedRun(
                      handshake,
                      this.host.runs.get(id),
                      requireEntity(this.ctx, "TestRevision", this.host.runs.get(id).revisionId),
                      lock,
                    )) &&
                  (this.cancelled(id) ||
                    this.dependencies(this.host.runs.get(id)).every(
                      (binding) => this.host.runs.get(binding.producerRunId).phase === "completed",
                    )) &&
                  this.memberIntervalReady(id),
              );
            // A Run whose admitting actor lost execute access ends blocked before any Attempt starts.
            for (const id of [...candidates]) {
              const run = this.host.runs.get(id);
              const actor = runMatrixCell(run).actor as RunActor | undefined;
              if (!actor || this.cancelled(id)) continue;
              const project = requireEntity(this.ctx, "TestCase", run.testId).projectId;
              if (this.ctx.reauthorizeActor(actor, String(project))) continue;
              this.host.runs.blockActorRevoked(id);
              candidates.splice(candidates.indexOf(id), 1);
            }
            // Cross-tenant demand is read before the transaction: a workspace-bound claim cannot see other tenants.
            const maxLeased = candidates.length
              ? fairShareCap({
                  database: database.forWorkspace("*"),
                  workspaceId: this.ctx.workspaceId,
                  now: new Date(),
                })
              : undefined;
            // The transaction makes resource reservation and lease claim indivisible across local owners.
            return database.withTx(() => {
              if (this.isQuarantined()) return null;
              const reserved = database
                .all(
                  `SELECT resource_id FROM job_leases WHERE state='leased' AND dispatchable=1 AND ${runJobFilter}`,
                )
                .map((row) => kindOf(String(row.resource_id)));
              // A run starts only when the free space holds its worst-case evidence next to the
              // runs in progress; otherwise it stays queued, with no deadline, until room returns.
              // A cancelled run still claims, to finalize without writing evidence.
              const eligible = candidates.filter(
                (id) =>
                  fitsCapacity(capacity, reserved, kindOf(id)) &&
                  (room === null ||
                    this.cancelled(id) ||
                    hasStorageRoom({ ...room, incomingBytes: this.worstCaseEvidence(id) })),
              );
              return leases.claim({
                workspaceId: this.ctx.workspaceId,
                owner: this.owner,
                queue: "local",
                runIds: eligible,
                ...(maxLeased !== undefined ? { maxLeased } : {}),
                ...(this.workerId ? { workerId: this.workerId } : {}),
              });
            });
          });
          if (fence) {
            const task = this.execute(
              fence,
              options.ephemeral ? options.signal : undefined,
            ).finally(() => tasks.delete(task));
            tasks.add(task);
          }
        }
        if (Date.now() - lastMaintenance >= defaults.reconcilerIntervalMs) {
          await contended(() => this.maintenance());
          lastMaintenance = Date.now();
        }
        await delay(100);
      }
      await Promise.all(tasks);
      if (schemaRefusal) throw schemaRefusal;
      outcome = { failed: false, value: { workerId: this.workerId, drained: true } };
    } catch (error) {
      // A fatal loop error stops in-flight attempts under their fences instead of leaving them
      // running in a worker that is about to report itself offline.
      outcome = { failed: true, error };
      for (const controller of this.active.values()) controller.abort();
      await Promise.allSettled(tasks);
    }
    let offlineFailure: { error: unknown } | null = null;
    if (this.workerId)
      try {
        await contended(() =>
          database.withTx(() =>
            database.run(
              "UPDATE workers SET state='offline',last_heartbeat_at=? WHERE workspace_id=? AND id=? AND state<>'revoked'",
              new Date().toISOString(),
              this.ctx.workspaceId,
              this.workerId,
            ),
          ),
        );
      } catch (error) {
        offlineFailure = { error };
      }
    // A failed offline mark never replaces the error that ended the loop; after a clean drain it is reported.
    if (outcome.failed) throw outcome.error;
    if (offlineFailure) throw offlineFailure.error;
    return outcome.value;
  }
}
