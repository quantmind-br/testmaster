import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  ContractError,
  defaults,
  type EffectiveConfig,
  type ExecutablePlan,
  type PlanStep,
  type RunnerEvent,
  type VariableValue,
  validate,
} from "@testmaster/contracts";
import {
  type AttemptObservation,
  canonicalJson,
  canRetry,
  evaluateGate,
  reduceOutcome,
} from "@testmaster/domain";
import {
  collectGarbage,
  FileEvidenceStore,
  findOrphanStaging,
  verifyBundle,
} from "@testmaster/evidence";
import {
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
import { auditSecurity } from "./audit.js";
import type { ResolvedConfig } from "./config.js";
import { entity, requireEntity, type ServiceContext } from "./context.js";
import { correlationId, OperationalLogger } from "./observability.js";
import { reproduction, verifyAdmission } from "./provenance.js";
import { captureDeclarations, type ResolvedDependency, type RunsService } from "./runs.js";
import type { SecretsService } from "./secrets.js";
import { RuntimeTimer } from "./timing.js";
import { UnsafeRuntime } from "./unsafe-runtime.js";
import { fitsCapacity, validateCapacity, type WorkerCapacity } from "./worker-capacity.js";
import {
  localHandshake,
  supportsQueuedRun,
  validateHandshake,
  type WorkerHandshake,
} from "./worker-handshake.js";

export interface WorkerHost {
  config: ResolvedConfig;
  images(): Promise<ImageLock>;
  seccompPath: string;
  secrets: SecretsService;
  runs: RunsService;
  retention?: { maintenance(): Promise<unknown> };
  dockerCommand?: DockerCommand;
  docker?: AttemptRuntimeExecutor;
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
            assertion: plan
              ? step?.kind === "assertion" || Boolean(step && "expectation" in step)
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
          variable.batchId !== run.batchId ||
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
    const elapsedMs =
      typeof firstStartedAt === "string" ? Math.max(0, Date.now() - Date.parse(firstStartedAt)) : 0;
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
    const heartbeat = setInterval(() => {
      try {
        leases.heartbeat(fence);
      } catch (error) {
        heartbeatError = error;
        controller.abort();
      }
    }, 10000);
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
        execution.finalize(fence, {
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
        });
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
        execution.finalize(fence, {
          ...run,
          phase: "completed",
          status: reduced.outcome === "failed" ? "failed" : "inconclusive",
          outcome: reduced.outcome === "failed" ? "failed" : "inconclusive",
          gate: "failed",
        });
        database.withTx(() =>
          new OutboxRepository(database).append(
            this.ctx.workspaceId,
            run.id,
            "run.deadline_exceeded",
            {
              reasonCode: "execution_deadline",
              origin: "run",
              deadline: new Date(
                Date.parse(String(firstStartedAt)) + (limits.executionTimeoutMs ?? 1800000),
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
      const lock = admitted.images;
      sealedSnapshot = {
        ...admitted,
        runId: run.id,
        revisionId: run.revisionId,
        environmentRevisionId: run.environmentRevisionId,
        effectiveConfig: cell.effectiveConfig,
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
      const secretIds = new Set<string>();
      const inspect = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        for (const [key, item] of Object.entries(value)) {
          if (key === "secretRef" && typeof item === "string") secretIds.add(item);
          else inspect(item);
        }
      };
      inspect(plan);
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
          kind:
            imported?.bundle.format === "pytest"
              ? "python"
              : plan?.runner === "http"
                ? "http"
                : "browser",
          imageId:
            imported?.dependencyLock.imageId ??
            lock?.["testmaster-runner"].imageId ??
            `sha256:${"0".repeat(64)}`,
          inputDir,
          ...(plan ? { plan } : {}),
          ...(agent ? { resolveAction: agent.resolveAction } : {}),
          networkPolicy: {
            allowedOrigins: origins,
            networkProfile: env.networkProfile as "local-loopback" | "private" | "public",
            baseUrl: String(cell.baseUrl),
          },
          secretRefs: releases,
          runnerInput: {
            ...(agent ? { agent: agent.runnerInput } : {}),
            ...(imported
              ? imported.bundle.format === "pytest"
                ? {
                    files: [imported.bundle.entrypoint],
                    codeRoot: "/run/testmaster/input/code",
                    imageId: imported.dependencyLock.imageId,
                  }
                : { imported: { files: [imported.bundle.entrypoint] } }
              : {}),
            baseUrl: String(cell.baseUrl),
            variables,
            locale: env.locale,
            timezone: env.timezone,
            browser: config.browser,
            stepTimeoutMs: limits.stepTimeoutMs ?? 30000,
            timeoutMs: attemptDeadlineMs,
            policy: {
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
            return {
              name: capture.name,
              valueType: capture.valueType,
              sensitive: true,
              encryptedValueRef: protectedValue.id,
            };
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
              const declaration = (plan ? captureDeclarations(plan) : []).find(
                (capture) => capture.stepId === activeStepId && capture.name === event.payload.name,
              );
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
                        stepId: activeStepId ?? null,
                        correlationKey: payload.correlationKey,
                        declaration:
                          plan?.cleanup?.find((cleanup) => cleanup.resourceRef === activeStepId) ??
                          null,
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
          for (const entry of bundle.manifest.entries)
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
        });
        await rm(join(result.bundle.bundleDir, ".partial"), { force: true });
        evidenceComplete = !bundle.manifest.entries.some((entry) => entry.state !== "available");
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
      execution.finalize(fence, {
        ...run,
        phase: "completed",
        status: reduced.outcome,
        outcome: reduced.outcome,
        gate,
        cleanupOutcome,
        analysisStatus: "not_requested",
      });
      database.withTx(() =>
        new OutboxRepository(database).append(this.ctx.workspaceId, run.id, "run.reduced", {
          ...reduced,
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
            error.details.reasonCode === "security_precondition_failed") ||
            error instanceof PolicyDenied) &&
          reduced.outcome !== "failed"
        ) {
          reduced.outcome = "blocked";
          reduced.reasonCode = "security_precondition_failed";
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
        execution.finalize(fence, {
          ...run,
          phase: "completed",
          status: reduced.outcome,
          outcome: reduced.outcome,
          gate: "failed",
          cleanupOutcome,
          analysisStatus: "not_requested",
        });
        database.withTx(() =>
          new OutboxRepository(database).append(
            this.ctx.workspaceId,
            run.id,
            "run.execution_error",
            {
              reasonCode:
                error instanceof PolicyDenied
                  ? "security_precondition_failed"
                  : error instanceof ContractError
                    ? (error.details.reasonCode ?? "insufficient_evidence")
                    : "insufficient_evidence",
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
      await rm(inputDir, { recursive: true, force: true });
      logs.record({
        component: "worker",
        event: "attempt.completed",
        correlationId: correlation,
        runId: run.id,
        attemptId: fence.attemptId,
      });
      await logs.flush();
    }
  }
  async reconcile(options: { dryRun?: boolean } = {}) {
    this.ctx.authorize("A");
    if (options.dryRun) {
      return {
        dryRun: true,
        actor: this.ctx.principalId,
        actions: this.ctx.database.all(
          "SELECT id,resource_id,state,fence FROM job_leases WHERE workspace_id=? AND dispatchable=1 AND (state='reconciliation_required' OR (state='leased' AND lease_expires_at<=?))",
          this.ctx.workspaceId,
          new Date().toISOString(),
        ),
        orphanStaging: await findOrphanStaging(this.host.config.dataDir),
      };
    }
    return this.maintenance();
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
  private async maintenance() {
    const database = this.ctx.database;
    const leases = new LeaseRepository(database);
    const expired = leases.expire();
    const pending = database.all(
      "SELECT * FROM job_leases WHERE workspace_id=? AND state='reconciliation_required' AND dispatchable=1",
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
  async run(
    options: {
      signal?: AbortSignal;
      ephemeral?: boolean;
      runIds?: string[];
      capacity?: WorkerCapacity;
      handshake?: WorkerHandshake;
    } = {},
  ) {
    this.ctx.authorize(options.ephemeral ? "X" : "A");
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
      return runner === "python" ? "python" : runner === "http" ? "http" : "browser";
    };
    if (!options.ephemeral && handshake) {
      const worker = entity(this.ctx, "wrk", {
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
          actions: JSON.stringify(handshake.actions),
        },
        state: "ready",
        lastHeartbeatAt: new Date().toISOString(),
      });
      this.ctx.entities.insert("Worker", worker);
      this.workerId = worker.id;
    }
    await this.maintenance();
    let lastMaintenance = Date.now();
    let drainStart: number | null = null;
    const tasks = new Set<Promise<void>>();
    try {
      for (;;) {
        if (this.workerId) {
          database.withTx(() =>
            database.run(
              "UPDATE workers SET last_heartbeat_at=? WHERE workspace_id=? AND id=?",
              new Date().toISOString(),
              this.ctx.workspaceId,
              this.workerId,
            ),
          );
          const row = database.get(
            "SELECT state FROM workers WHERE workspace_id=? AND id=?",
            this.ctx.workspaceId,
            this.workerId,
          );
          if (row?.state !== "ready") this.drainRequested = true;
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
          if (Date.now() - lastMaintenance >= 30000) {
            await this.maintenance();
            lastMaintenance = Date.now();
          }
          await delay(200);
          continue;
        }
        if (!this.drainRequested && !done && tasks.size < concurrency) {
          const candidates = database
            .all(
              "SELECT r.id FROM runs r JOIN job_leases j ON j.workspace_id=r.workspace_id AND j.resource_id=r.id WHERE r.workspace_id=? AND j.state='queued' ORDER BY j.available_at,j.id",
              this.ctx.workspaceId,
            )
            .map((row) => String(row.id))
            .filter(
              (id) =>
                (!runIds || runIds.includes(id)) &&
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
                  )),
            );
          // The transaction makes resource reservation and lease claim indivisible across local owners.
          const fence = database.withTx(() => {
            if (this.isQuarantined()) return null;
            const reserved = database
              .all("SELECT resource_id FROM job_leases WHERE state='leased' AND dispatchable=1")
              .map((row) => kindOf(String(row.resource_id)));
            const eligible = candidates.filter((id) =>
              fitsCapacity(capacity, reserved, kindOf(id)),
            );
            return leases.claim({
              workspaceId: this.ctx.workspaceId,
              owner: this.owner,
              queue: "local",
              runIds: eligible,
              ...(this.workerId ? { workerId: this.workerId } : {}),
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
        if (Date.now() - lastMaintenance >= 30000) {
          await this.maintenance();
          lastMaintenance = Date.now();
        }
        await delay(100);
      }
      await Promise.all(tasks);
      return { workerId: this.workerId, drained: true };
    } finally {
      if (this.workerId)
        database.withTx(() =>
          database.run(
            "UPDATE workers SET state='offline',last_heartbeat_at=? WHERE workspace_id=? AND id=?",
            new Date().toISOString(),
            this.ctx.workspaceId,
            this.workerId,
          ),
        );
    }
  }
}
