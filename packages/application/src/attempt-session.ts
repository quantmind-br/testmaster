import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  EvidenceQuotaError,
  type EvidenceStore,
  FileEvidenceStore,
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
  type AttemptInput,
  type AttemptResult,
  ContainerCleanupError,
  type ExecutorKind,
  type ImageLock,
  PolicyDenied,
  type SecretRelease,
} from "@testmaster/sandbox";
import { AgentModeService } from "./ai/agent-mode.js";
import { CodeImportService } from "./ai/code-import.js";
import { sourceSchemasFor } from "./ai/source-documents.js";
import { auditSecurity } from "./audit.js";
import { type AuthProfilesService, authBlockReasons, type PreparedAuth } from "./auth/index.js";
import { attemptAdditionalOrigins, attemptIgnoredOrigins } from "./authoring.js";
import { erasableCaptureSecretIds } from "./capture-retention.js";
import type { ResolvedConfig } from "./config.js";
import { entity, requireEntity, type ServiceContext } from "./context.js";
import { type ReuseBinding, resolveReuse } from "./dependency-reuse.js";
import { fixtureRevoked, planRunnerPolicy, stageFixtureInputs } from "./input-fixtures.js";
import { correlationId } from "./observability.js";
import { reproduction, verifyAdmission } from "./provenance.js";
import { assertArtifactPublishable } from "./retention.js";
import {
  captureDeclarations,
  cleanupHandleDeclarations,
  type ResolvedDependency,
  type RunsService,
} from "./runs.js";
import type { SecretsService } from "./secrets.js";
import { RuntimeTimer } from "./timing.js";
import { type TunnelDispatch, tunnelDispatch } from "./tunnels.js";
import { isWriterContention, retryWriterContention } from "./writer-contention.js";

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
/** True once a cancel was requested for the Run; the request is an outbox record, never undone. */
export function runCancelRequested(ctx: ServiceContext, runId: string): boolean {
  return runCancelReason(ctx, runId) !== null;
}
/** The reason of the Run's cancel request (`user_cancelled`, `tunnel_lost`), null when none. */
export function runCancelReason(ctx: ServiceContext, runId: string): string | null {
  const row = ctx.database.get(
    "SELECT json_extract(data_json,'$.reasonCode') AS reason FROM outbox WHERE workspace_id=? AND aggregate_id=? AND type='run.cancel_requested'",
    ctx.workspaceId,
    runId,
  );
  if (!row) return null;
  return typeof row.reason === "string" ? row.reason : "user_cancelled";
}
/** The producers a Run consumes, frozen into its matrix cell at admission. */
export function runDependencies(run: EntityDocument): ResolvedDependency[] {
  const cell = run.matrixCell as Record<string, unknown>;
  return (cell.dependencyBindings ?? []) as ResolvedDependency[];
}
/** What every Attempt of a Run observed, read back from its accepted events for the reducer. */
export function attemptObservations(
  ctx: ServiceContext,
  runId: string,
  plan: ExecutablePlan | null,
): AttemptObservation[] {
  const steps = plan ? planSteps(plan) : [];
  const cancelReason = runCancelReason(ctx, runId);
  return ctx.database
    .all(
      "SELECT * FROM attempts WHERE workspace_id=? AND run_id=? ORDER BY number",
      ctx.workspaceId,
      runId,
    )
    .map((row) => {
      let malformed = false;
      const events: RunnerEvent[] = [];
      for (const value of ctx.database.all(
        "SELECT data_json FROM observations WHERE workspace_id=? AND attempt_id=? ORDER BY seq",
        ctx.workspaceId,
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
            ctx.database.get(
              "SELECT 1 FROM outbox WHERE workspace_id=? AND aggregate_id=? AND type='attempt.runner_started' AND json_extract(data_json,'$.attemptId')=?",
              ctx.workspaceId,
              runId,
              row.id,
            ),
          ),
        steps: observations,
        reasonCode:
          (malformed ? "insufficient_evidence" : finished?.payload.reasonCode) ??
          (row.outcome === "inconclusive" ? "worker_lost" : "insufficient_evidence"),
        cancelAuthorized: cancelReason !== null,
        ...(cancelReason ? { cancelReasonCode: cancelReason } : {}),
        stopConfirmed: row.phase === "completed" && cancelReason !== null,
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
/**
 * Marks the live resources an Attempt created as abandoned: a planned one becomes `uncertain`, any
 * other `orphaned`. `assertOwnership` runs first so only the fence holder or the reconciler does it.
 */
export function abandonAttemptResources(
  ctx: ServiceContext,
  attemptId: string,
  assertOwnership: () => void,
): void {
  assertOwnership();
  const rows = ctx.database.all(
    "SELECT data_json FROM resources WHERE workspace_id=? AND creator_attempt_id=? AND state NOT IN ('cleaned','orphaned')",
    ctx.workspaceId,
    attemptId,
  );
  for (const row of rows) {
    const resource = validate<EntityDocument>("ResourceRecord", JSON.parse(String(row.data_json)));
    const state = resource.state === "planned" ? "uncertain" : "orphaned";
    const attempt = ctx.database.get(
      "SELECT run_id FROM attempts WHERE workspace_id=? AND id=?",
      ctx.workspaceId,
      attemptId,
    );
    new OutboxRepository(ctx.database).append(
      ctx.workspaceId,
      String(resource.id),
      "resource.orphaned",
      { resourceId: resource.id, runId: attempt ? String(attempt.run_id) : null, state },
    );
    const next = { ...resource, state, version: Number(resource.version ?? 1) + 1 };
    ctx.database.run(
      "UPDATE resources SET state=?,data_json=?,version=version+1 WHERE workspace_id=? AND id=? AND version=?",
      state,
      canonicalJson(next),
      ctx.workspaceId,
      resource.id,
      resource.version ?? 1,
    );
  }
}
/** Erases sensitive captures that no dependent, reuse window or live resource can need any more. */
export async function eraseSettledCaptures(
  ctx: ServiceContext,
  secrets: Pick<SecretsService, "eraseCapture">,
): Promise<void> {
  for (const secretId of erasableCaptureSecretIds(ctx)) {
    try {
      await secrets.eraseCapture(secretId);
    } catch {
      // The reference stays live; the next maintenance pass retries.
      auditSecurity(ctx, "secret.capture.erase", secretId, "denied");
    }
  }
}

/** The controller collaborators an Attempt needs; the local worker's host provides them in process. */
export interface AttemptSessionHost {
  config: ResolvedConfig;
  images(): Promise<ImageLock>;
  secrets: SecretsService;
  runs: RunsService;
  healing?: { settlePending(): Promise<number> };
  auth?: () => AuthProfilesService;
}
export interface AttemptSessionOptions {
  /** The worker holding the lease; frozen into the snapshot and named by a quarantine. */
  workerId: string | null;
  /** Ends the controller's own waits for this Attempt: a login phase or a model answer. */
  signal: AbortSignal;
}
/**
 * What a worker needs to start the sandbox for one Attempt. The secrets are references only: their
 * values are released one at a time through the session, under the fence that is current then.
 */
export type AttemptDispatch = Omit<
  AttemptInput,
  | "seccompPath"
  | "secretRefs"
  | "protectCapture"
  | "onEvent"
  | "onAuthState"
  | "resolveAction"
  | "dial"
> & {
  secretRefs: { secretRef: string; secretVersion: number }[];
  /** The isolation the Run was admitted with; `process` is the explicit unsafe executor. */
  executor: "docker" | "process";
  /** The tunnel a remote worker dials the Run's loopback target through (ADR-031). */
  tunnel?: TunnelDispatch;
};
/** The session callbacks a sandbox `AttemptExecutor` running in the controller's process uses. */
export type AttemptBindings = Required<
  Pick<AttemptInput, "secretRefs" | "protectCapture" | "onEvent">
> &
  Pick<AttemptInput, "onAuthState" | "resolveAction">;

/**
 * The controller side of one claimed Attempt and the only writer of its execution: it seals the
 * ExecutionSnapshot, accepts runner events in sequence, stages the Attempt's evidence, releases
 * secrets and finalizes the Run with its outbox records, every write under the lease fence
 * (OPS-008). A worker only runs the sandbox; the local worker calls the session in process.
 */
export class AttemptSession {
  readonly runId: string;
  readonly attemptId: string;
  /** Correlates the worker's operational log lines with the Run. */
  readonly correlationId: string;
  private readonly database;
  private readonly execution;
  private readonly leases;
  private readonly run: ReturnType<RunsService["get"]>;
  private readonly revision: EntityDocument;
  private readonly env: EntityDocument;
  private readonly plan: ExecutablePlan | null;
  private readonly cell: Record<string, unknown>;
  private readonly limits: Record<string, number>;
  private readonly timer: RuntimeTimer;
  private readonly firstStartedAt: unknown;
  private readonly modelWaitMs: number;
  private readonly executionRemainingMs: number;
  private readonly attemptDeadlineMs: number;
  private readonly snapshotId: string;
  private readonly assertions: string[];
  private readonly requiredSteps: string[];
  private sealedSnapshot: Record<string, unknown> | undefined;
  private origins: string[] = [];
  private prepared: PreparedAuth | null = null;
  private agent: ReturnType<AgentModeService["session"]> | null = null;
  private releases: SecretRelease[] = [];
  private activeStepId: string | undefined;
  private store: FileEvidenceStore | undefined;
  /** The hash of each accepted event, indexed by its sequence. */
  private readonly accepted: string[] = [];

  private constructor(
    readonly ctx: ServiceContext,
    readonly host: AttemptSessionHost,
    readonly fence: Fence & { runId: string; number: number },
    private readonly options: AttemptSessionOptions,
  ) {
    this.database = ctx.database;
    this.execution = new ExecutionRepository(ctx.database);
    this.leases = new LeaseRepository(ctx.database);
    this.run = host.runs.get(fence.runId);
    this.runId = this.run.id;
    this.attemptId = fence.attemptId;
    this.revision = requireEntity(ctx, "TestRevision", this.run.revisionId);
    this.env = requireEntity(ctx, "EnvironmentRevision", this.run.environmentRevisionId);
    this.plan = this.revision.plan
      ? validate<ExecutablePlan>("ExecutablePlan", this.revision.plan)
      : null;
    this.cell = this.run.matrixCell as Record<string, unknown>;
    this.correlationId = correlationId(this.cell.correlationId);
    const queued = host.runs
      .events(this.run.id)
      .findLast((event) => event.type === "run.timing_queued")?.payload as ConstructorParameters<
      typeof RuntimeTimer
    >[2];
    this.timer = new RuntimeTimer(undefined, undefined, fence.number === 1 ? queued : undefined);
    this.limits = this.cell.limits as Record<string, number>;
    this.firstStartedAt = ctx.database.get(
      "SELECT started_at FROM attempts WHERE workspace_id=? AND run_id=? ORDER BY number LIMIT 1",
      ctx.workspaceId,
      this.run.id,
    )?.started_at;
    // Time an earlier attempt spent waiting for a model answer is not execution time: a model
    // call is never cut, and its wait must not shorten a later attempt's deadline either.
    this.modelWaitMs = host.runs
      .events(this.run.id)
      .filter((event) => event.type === "attempt.model_wait")
      .reduce(
        (total, event) => total + Number((event.payload as { waitMs?: number }).waitMs ?? 0),
        0,
      );
    const elapsedMs =
      typeof this.firstStartedAt === "string"
        ? Math.max(0, Date.now() - Date.parse(this.firstStartedAt) - this.modelWaitMs)
        : 0;
    this.executionRemainingMs = Math.max(
      0,
      (this.limits.executionTimeoutMs ?? 1800000) - elapsedMs,
    );
    this.attemptDeadlineMs = Math.min(
      this.limits.attemptTimeoutMs ?? 300000,
      this.executionRemainingMs,
    );
    this.snapshotId = entity(ctx, "snp", {}).id;
    const required = this.plan
      ? planSteps(this.plan).filter((step) => step.required !== false)
      : [];
    this.assertions = required
      .filter((step) => step.kind === "assertion" || "expectation" in step)
      .map((step) => step.id);
    this.requiredSteps = required.map((step) => step.id);
    if (!this.plan) {
      this.assertions.push("imported-code");
      this.requiredSteps.push("imported-code");
    }
  }

  /**
   * Opens the session of a claimed Attempt and records its deadline. A fence that is no longer
   * current throws `StaleFenceError` before anything is written.
   */
  static open(
    ctx: ServiceContext,
    host: AttemptSessionHost,
    fence: Fence & { runId: string; number: number },
    options: AttemptSessionOptions,
  ): AttemptSession {
    const session = new AttemptSession(ctx, host, fence, options);
    session.recordDeadline();
    return session;
  }

  private recordDeadline(): void {
    this.database.withTx(() => {
      this.leases.assertCurrent(this.fence);
      new OutboxRepository(this.database).append(
        this.ctx.workspaceId,
        this.run.id,
        "attempt.deadline",
        {
          attemptId: this.fence.attemptId,
          origin:
            this.executionRemainingMs <= (this.limits.attemptTimeoutMs ?? 300000)
              ? "run"
              : "attempt",
          timeoutMs: this.attemptDeadlineMs,
          deadline: new Date(Date.now() + this.attemptDeadlineMs).toISOString(),
          finalAction: "stop_new_steps_then_kill_after_grace",
        },
      );
    });
  }

  /** True once a cancel was requested for the Run. */
  cancelled(): boolean {
    return runCancelRequested(this.ctx, this.run.id);
  }
  /** When the lease currently expires, in epoch milliseconds. */
  leaseExpiresAt(): number {
    return Date.parse(
      String(
        this.database.get(
          "SELECT lease_expires_at FROM job_leases WHERE workspace_id=? AND id=?",
          this.fence.workspaceId,
          this.fence.jobId,
        )?.lease_expires_at,
      ),
    );
  }
  /** Renews the lease under its fence and returns the new expiry in epoch milliseconds. */
  heartbeat(): number {
    return Date.parse(this.leases.heartbeat(this.fence));
  }
  /** Throws `StaleFenceError` once this Attempt's fence is no longer current or its lease lapsed. */
  assertCurrent(): void {
    this.leases.assertCurrent(this.fence);
  }
  /** The Attempt's evidence limits: the largest object and the whole Attempt, in bytes. */
  evidenceLimits(): { objectBytes: number; attemptBytes: number } {
    return {
      objectBytes: this.limits.artifactBytes ?? 67108864,
      attemptBytes: this.limits.attemptArtifactBytes ?? 268435456,
    };
  }

  private recordTiming(): void {
    this.timer.mark("completed");
    this.database.withTx(() => {
      this.leases.assertCurrent(this.fence);
      new OutboxRepository(this.database).append(
        this.ctx.workspaceId,
        this.run.id,
        "attempt.timing",
        { attemptId: this.fence.attemptId, timing: this.timer.snapshot() },
      );
    });
  }

  private async dependencyVariables(): Promise<
    Record<string, { value: unknown; sensitive: boolean }>
  > {
    const run = this.run;
    const variables: Record<string, { value: unknown; sensitive: boolean }> = {};
    const cell = this.cell;
    for (const binding of runDependencies(run)) {
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
      const records = this.database.all(
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
        const events = this.database.all(
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

  /**
   * Readies the Attempt for dispatch: resolves its dependencies, stages its inputs into
   * `inputDir`, verifies admission, prepares authentication, releases the secrets it names and
   * seals the ExecutionSnapshot. Returns null when the Run was settled instead (a blocked
   * dependency or a spent execution deadline); a refusal throws for `fail` to record.
   */
  async prepare(inputDir: string): Promise<AttemptDispatch | null> {
    const database = this.database;
    const execution = this.execution;
    const run = this.run;
    const revision = this.revision;
    const env = this.env;
    const plan = this.plan;
    const cell = this.cell;
    const limits = this.limits;
    let variables: Record<string, { value: unknown; sensitive: boolean }>;
    try {
      variables = await this.dependencyVariables();
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      this.recordTiming();
      execution.finalize(
        this.fence,
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
      return null;
    }
    if (this.executionRemainingMs === 0) {
      const reduced = reduceOutcome(
        attemptObservations(this.ctx, run.id, plan),
        this.assertions,
        this.requiredSteps,
      );
      execution.finalize(
        this.fence,
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
              Date.parse(String(this.firstStartedAt)) +
                this.modelWaitMs +
                (limits.executionTimeoutMs ?? 1800000),
            ).toISOString(),
          },
        ),
      );
      return null;
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
    execution.progress(this.fence, "running");
    const currentImages = cell.executor === "process" ? null : await this.host.images();
    const admitted = verifyAdmission(run, revision, env, currentImages, this.ctx);
    const projectId = String(requireEntity(this.ctx, "TestCase", String(run.testId)).projectId);
    const fixtureInputs = await stageFixtureInputs(
      this.ctx,
      this.host.config,
      projectId,
      plan,
      inputDir,
      admitted.inputFixtureHashes ?? {},
      limits,
    );
    const lock = admitted.images;
    const sealedSnapshot: Record<string, unknown> = {
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
      workerId: this.options.workerId,
      controllerVersion: "1.0.0",
      hostPlatform: process.platform,
      hostArchitecture: process.arch,
    };
    this.sealedSnapshot = sealedSnapshot;
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
            requestedBy: String((cell.actor as { principalId?: string } | undefined)?.principalId),
          },
          attemptId: this.fence.attemptId,
          environment: {
            id: String(cell.environmentId ?? env.id),
            projectId,
            targetOrigins: env.targetOrigins as string[],
            networkProfile: env.networkProfile as "public" | "private" | "local-loopback",
            authProfileRefs: env.authProfileRefs as string[],
          },
          signal: this.options.signal,
          deadlineAt: Date.now() + this.attemptDeadlineMs,
          interactive: ["cli", "api", "mcp"].includes(run.origin) && process.env.CI !== "true",
          runner: plan ? plan.runner : "http",
        })
      : null;
    this.prepared = prepared;
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
    this.releases = await Promise.all([...secretIds].map((id) => this.host.secrets.release(id)));
    sealedSnapshot.secretRefs = [...secretIds].map((id) => {
      const secret = this.host.secrets.get(id);
      return { id, version: secret.secretVersion, allowedOrigins: secret.allowedOrigins };
    });
    database.withTx(() =>
      new OutboxRepository(database).append(this.ctx.workspaceId, run.id, "run.snapshot_sealed", {
        attemptId: this.fence.attemptId,
        snapshotId: this.snapshotId,
        executionSnapshot: sealedSnapshot,
      }),
    );
    const origins = Array.from(
      new Set([...(env.targetOrigins as string[]), new URL(String(cell.baseUrl)).origin]),
    );
    this.origins = origins;
    const additionalOrigins = attemptAdditionalOrigins(
      env as { additionalOrigins?: string[] },
      origins,
      Boolean(admitted.profilePolicy.offline),
    );
    const ignoredOrigins = attemptIgnoredOrigins(env as { ignoredOrigins?: string[] }, [
      ...origins,
      ...additionalOrigins,
    ]);
    const effective = validate<EffectiveConfig>("EffectiveConfig", cell.effectiveConfig);
    const config = effective.config;
    const agent =
      run.mode === "agent"
        ? new AgentModeService(this.ctx, {
            ...this.host.config,
            effectiveConfig: effective,
            modelProviders: admitted.modelProviders,
            profilePolicy: admitted.profilePolicy,
          }).session(revision.id, origins, this.options.signal, run.id)
        : null;
    this.agent = agent;
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
    for (const id of Object.keys(fixtureInputs.artifacts)) {
      if (fixtureRevoked(this.ctx, id))
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Fixture input was revoked before dispatch",
          { reasonCode: "security_precondition_failed", artifactRef: id },
        );
    }
    return {
      workspaceId: this.ctx.workspaceId,
      runId: run.id,
      attemptId: this.fence.attemptId,
      revisionId: run.revisionId,
      executionSnapshot: JSON.parse(JSON.stringify(sealedSnapshot)),
      reproduction: reproduction(
        admitted,
        typeof cell.originalRunId === "string" ? cell.originalRunId : undefined,
        run.mode === "agent",
      ),
      snapshotId: this.snapshotId,
      kind: imported?.bundle.format === "pytest" ? "python" : executorKindOf(plan?.runner),
      imageId:
        imported?.dependencyLock.imageId ??
        lock?.["testmaster-runner"].imageId ??
        `sha256:${"0".repeat(64)}`,
      inputDir,
      ...(plan ? { plan } : {}),
      networkPolicy: {
        allowedOrigins: [...origins, ...additionalOrigins],
        ...(additionalOrigins.length ? { additionalOrigins } : {}),
        ...(ignoredOrigins.length ? { ignoredOrigins } : {}),
        networkProfile: env.networkProfile as "local-loopback" | "private" | "public",
        baseUrl: String(cell.baseUrl),
      },
      secretRefs: this.releases.map(({ secretRef, secretVersion }) => ({
        secretRef,
        secretVersion,
      })),
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
        timeoutMs: this.attemptDeadlineMs,
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
      attemptTimeoutMs: this.attemptDeadlineMs,
      executor: cell.executor === "process" ? "process" : "docker",
      // A tunnel that is no longer active refuses the dispatch with `tunnel_lost` (ADR-031).
      ...(typeof cell.tunnelId === "string"
        ? { tunnel: tunnelDispatch(this.ctx, cell.tunnelId) }
        : {}),
    };
  }

  /**
   * The Attempt's evidence store: artifacts are staged per Attempt, held to the Run's object and
   * Attempt limits, and become a sealed bundle that `finalize` verifies before publication.
   */
  evidence(): EvidenceStore {
    this.store ??= new FileEvidenceStore({
      rootDir: this.host.config.dataDir,
      maxObjectBytes: this.limits.artifactBytes ?? 67108864,
      maxAttemptBytes: this.limits.attemptArtifactBytes ?? 268435456,
    });
    return this.store;
  }

  /**
   * Releases the value of a secret the sealed snapshot names, only while this Attempt's fence is
   * current; a value resolved after the lease moved on is discarded.
   */
  async resolveSecret(secretRef: string, secretVersion: number): Promise<string> {
    const release = this.releases.find(
      (candidate) => candidate.secretRef === secretRef && candidate.secretVersion === secretVersion,
    );
    if (!release)
      throw new ContractError(
        "POLICY_DENIED",
        "Secret is not part of the sealed execution snapshot",
        { secretRef },
      );
    this.leases.assertCurrent(this.fence);
    const value = await release.resolve();
    this.leases.assertCurrent(this.fence);
    return value;
  }

  /** Stores a sensitive capture as an encrypted secret reference bound to the Attempt's origins. */
  async protectCapture(
    capture: Extract<RunnerEvent, { type: "variable.captured" }>["payload"],
  ): Promise<Extract<RunnerEvent, { type: "variable.captured" }>["payload"]> {
    if (!capture.sensitive) return capture;
    if (!capture.value || !("literal" in capture.value))
      throw new ContractError("PRECONDITION_FAILED", "Sensitive capture literal is unavailable");
    this.leases.assertCurrent(this.fence);
    const protectedValue = await this.host.secrets.protectCapture(
      `capture-${this.fence.attemptId}-${capture.name}`,
      capture.value.literal,
      this.origins,
    );
    this.leases.assertCurrent(this.fence);
    // A cleanup lookup's handle names the entry it belongs to; keep that producer.
    const { value: _value, ...rest } = capture;
    return { ...rest, sensitive: true, encryptedValueRef: protectedValue.id };
  }

  /** Asks the agent for the next action of an agent-mode step; the wait is never cut. */
  async resolveAction(stepId: string, observation: unknown): Promise<PlanStep | null> {
    const agent = this.agent;
    if (!agent) throw new ContractError("PRECONDITION_FAILED", "The Attempt is not in agent mode");
    const database = this.database;
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
              this.run.id,
              "attempt.model_wait",
              { attemptId: this.fence.attemptId, stepId, waitMs },
            ),
          ),
        { signal: this.options.signal, inTransaction: () => database.inTransaction },
      );
    } catch (error) {
      if (!(isWriterContention(error) && this.options.signal.aborted)) throw error;
    }
    if ("error" in answer) throw answer.error;
    return answer.action;
  }

  /**
   * Accepts the runner event at `sequence`, the session's own count of accepted events from 0,
   * and records it under the fence. A repeat of an accepted event is a no-op so a sender may
   * retry; another event under an accepted sequence is an IDEMPOTENCY_CONFLICT, and a sequence
   * past the next one leaves a gap and is refused without effect.
   */
  async acceptEvent(sequence: number, event: RunnerEvent): Promise<void> {
    if (!Number.isSafeInteger(sequence) || sequence < 0)
      throw new ContractError("INVALID_ARGUMENT", "Event sequence must be a non-negative integer", {
        sequence,
      });
    this.leases.assertCurrent(this.fence);
    const hash = semanticHash(event);
    if (sequence < this.accepted.length) {
      if (this.accepted[sequence] !== hash)
        throw new ContractError(
          "IDEMPOTENCY_CONFLICT",
          "Another event was already accepted at this sequence",
          { sequence },
        );
      return;
    }
    if (sequence > this.accepted.length)
      throw new ContractError("PRECONDITION_FAILED", "Event sequence leaves a gap", {
        sequence,
        expectedSequence: this.accepted.length,
      });
    this.record(event);
    this.accepted.push(hash);
  }

  private record(event: RunnerEvent): void {
    const database = this.database;
    const execution = this.execution;
    const fence = this.fence;
    const plan = this.plan;
    const run = this.run;
    if (event.type === "runner.hello")
      database.withTx(() => {
        this.leases.assertCurrent(fence);
        new OutboxRepository(database).append(
          this.ctx.workspaceId,
          run.id,
          "attempt.runner_started",
          { attemptId: fence.attemptId },
        );
      });
    if (event.type === "step.started") this.timer.mark("running");
    if (event.type === "runner.finished") this.timer.mark("collecting");
    if (event.type === "step.started") this.activeStepId = event.payload.stepId;
    if (event.type === "variable.captured") {
      // A cleanup lookup names the entry it produces the handle for; every other capture
      // belongs to the step being executed.
      const named = event.payload.stepId;
      const declaration = plan
        ? named === undefined
          ? captureDeclarations(plan).find(
              (capture) =>
                capture.stepId === this.activeStepId && capture.name === event.payload.name,
            )
          : cleanupHandleDeclarations(plan).find(
              (capture) => capture.stepId === named && capture.name === event.payload.name,
            )
        : undefined;
      if (!declaration || declaration.valueType !== event.payload.valueType)
        throw new ContractError("PRECONDITION_FAILED", "Capture does not match its producer step");
      database.withTx(() => {
        this.leases.assertCurrent(fence);
        const previousRow = database.get(
          "SELECT data_json FROM variables WHERE workspace_id=? AND producer_run_id=? AND producer_step_id=? AND name=?",
          this.ctx.workspaceId,
          run.id,
          declaration.stepId,
          event.payload.name,
        );
        const previous = previousRow
          ? validate<VariableValue>("VariableValue", JSON.parse(String(previousRow.data_json)))
          : null;
        const value = entity(this.ctx, "var", {
          ...(previous ? { id: previous.id, version: Number(previous.version ?? 1) + 1 } : {}),
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
    if (event.type.startsWith("resource.")) this.recordResource(event);
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
            snapshotId: this.snapshotId,
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
  }

  private recordResource(event: RunnerEvent): void {
    const database = this.database;
    const fence = this.fence;
    const plan = this.plan;
    const resourceEvent = event as Extract<
      RunnerEvent,
      {
        type: "resource.intent" | "resource.created" | "resource.uncertain" | "resource.cleanup";
      }
    >;
    const payload = resourceEvent.payload;
    // A resource a cleanup lookup found belongs to that entry's step, not to the step
    // that was last executed; any other resource belongs to the executing step.
    const resourceStepId =
      payload.stepId !== undefined &&
      plan?.cleanup?.some((cleanup) => cleanup.find && cleanup.resourceRef === payload.stepId)
        ? payload.stepId
        : (this.activeStepId ?? null);
    database.withTx(() => {
      this.leases.assertCurrent(fence);
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
                plan?.cleanup?.find((cleanup) => cleanup.resourceRef === resourceStepId) ?? null,
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
          throw new ContractError("PRECONDITION_FAILED", "Resource ownership proof is missing");
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

  /**
   * The session's callbacks for a sandbox executor in this process. Events are numbered in the
   * order they are accepted, so a refused event leaves its number to the next one, as before.
   * The secrets are the releases `prepare` made under the fence; an in-process executor resolves
   * them directly, while a worker in another process goes through `resolveSecret`.
   */
  bindings(): AttemptBindings {
    let sequence = 0;
    const prepared = this.prepared;
    return {
      secretRefs: this.releases,
      protectCapture: (capture) => this.protectCapture(capture),
      onEvent: async (event) => {
        await this.acceptEvent(sequence, event);
        sequence++;
      },
      ...(prepared ? { onAuthState: prepared.onAuthState } : {}),
      ...(this.agent
        ? {
            resolveAction: (stepId: string, observation: unknown) =>
              this.resolveAction(stepId, observation),
          }
        : {}),
    };
  }

  /**
   * Settles the Attempt from the sandbox result: verifies and publishes its sealed bundle, retries
   * an inconclusive Attempt that may still be retried, or reduces and completes the Run with its
   * gate. `leaseError` is a lease renewal the worker saw fail; it ends the Attempt as an error.
   */
  async finalize(result: AttemptResult, leaseError?: unknown): Promise<void> {
    const database = this.database;
    const execution = this.execution;
    const fence = this.fence;
    const run = this.run;
    const plan = this.plan;
    const cell = this.cell;
    const limits = this.limits;
    this.prepared?.finish({ outcome: result.outcome, reasonCode: result.reasonCode });
    const cleanupFailure = result.cleanupFailure;
    if (cleanupFailure) {
      this.quarantineWorker({
        reason:
          cleanupFailure.type === "container"
            ? "container_cleanup_failed"
            : "browser_profile_cleanup_failed",
        containerName: cleanupFailure.containerName ?? `tm-att-${fence.attemptId}`,
        details: cleanupFailure,
      });
    }
    if (leaseError) throw leaseError;
    execution.progress(fence, "collecting");
    this.timer.mark("collecting");
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
        snapshotId: this.snapshotId,
        manifestSha256: result.bundle.manifestSha256,
      });
      database.withTx(() => {
        execution.publish(fence, "Snapshot", {
          id: this.snapshotId,
          workspaceId: this.ctx.workspaceId,
          runId: run.id,
          attemptId: fence.attemptId,
          revisionId: run.revisionId,
          manifestHash: bundle.meta.manifestHash,
          committedAt: bundle.meta.committedAt,
          redactionPolicyHash: bundle.meta.redactionPolicyHash,
          executionSnapshot: this.sealedSnapshot,
        });
        for (const entry of bundle.manifest.entries) {
          assertArtifactPublishable(database, this.ctx.workspaceId, entry.artifactId);
          execution.publish(fence, "Artifact", {
            id: entry.artifactId,
            workspaceId: this.ctx.workspaceId,
            runId: run.id,
            attemptId: fence.attemptId,
            revisionId: run.revisionId,
            snapshotId: this.snapshotId,
            extensions: { "testmaster:correlationId": this.correlationId },
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
    const attempts = attemptObservations(this.ctx, run.id, plan);
    const current = attempts.find((attempt) => attempt.attemptId === fence.attemptId);
    // A tunnel that ended cut the Attempt's transport before the worker heard of the cancel: the
    // Attempt settling afterwards is its confirmed stop (ADR-031, spec 11 `tunnel_lost`).
    const stopConfirmed =
      result.outcome === "cancelled" || runCancelReason(this.ctx, run.id) === "tunnel_lost";
    if (current) {
      current.reasonCode = result.reasonCode;
      current.stopConfirmed = stopConfirmed;
      if (
        (result.outcome === "blocked" || result.outcome === "inconclusive") &&
        canRetry(current, limits.maxAttempts ?? 2)
      ) {
        this.recordTiming();
        this.leases.release(fence, true);
        return;
      }
    }
    const reduced = reduceOutcome(attempts, this.assertions, this.requiredSteps, {
      authorized: this.cancelled(),
      stopConfirmed,
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
    if (this.agent && result.outcome === "passed") {
      this.leases.assertCurrent(fence);
      const candidate = this.agent.candidate(run.id);
      if (candidate)
        database.withTx(() =>
          new OutboxRepository(database).append(
            this.ctx.workspaceId,
            run.id,
            "run.agent_candidate",
            {
              candidateRevisionId: candidate.id,
              verificationRequired: true,
              deterministicAssertions: this.assertions,
              semanticJudgments: [],
            },
          ),
        );
    }
    this.recordTiming();
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
  }

  /**
   * Ends the Attempt on an error under its fence: abandons its live resources and completes the
   * Run with the error's registered reason. A fence already lost leaves the Run to the reconciler.
   */
  async fail(error: unknown): Promise<void> {
    if (error instanceof StaleFenceError) return;
    const database = this.database;
    const fence = this.fence;
    const run = this.run;
    try {
      this.leases.assertCurrent(fence);
      database.withTx(() =>
        abandonAttemptResources(this.ctx, fence.attemptId, () => this.leases.assertCurrent(fence)),
      );
      const attempts = attemptObservations(this.ctx, run.id, this.plan);
      const reduced = reduceOutcome(attempts, this.assertions, this.requiredSteps);
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
      this.recordTiming();
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
      this.execution.finalize(
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
        new OutboxRepository(database).append(this.ctx.workspaceId, run.id, "run.execution_error", {
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
        }),
      );
    } catch (stale) {
      if (!(stale instanceof StaleFenceError)) throw stale;
    }
  }

  /**
   * Releases what the Attempt held on the controller: erases settled sensitive captures and, for a
   * healing verification, settles the proposal it verified.
   */
  async close(): Promise<void> {
    await eraseSettledCaptures(this.ctx, this.host.secrets);
    if (this.run.origin === "verification") {
      try {
        await this.host.healing?.settlePending();
      } catch (error) {
        new OutboxRepository(this.database).append(
          this.ctx.workspaceId,
          this.run.id,
          "healing.reconciliation_failed",
          { error: error instanceof ContractError ? error.code : "INTERNAL" },
        );
      }
    }
  }

  private quarantineWorker(info: {
    reason: string;
    containerName?: string;
    details?: unknown;
  }): void {
    const workerId = this.options.workerId;
    const incidentId = `inc_${randomUUID()}`;
    const quarantinedAt = new Date().toISOString();
    const quarantineRecord = {
      incidentId,
      workspaceId: this.ctx.workspaceId,
      runId: this.run.id,
      attemptId: this.fence.attemptId,
      workerId,
      reason: info.reason,
      containerName: info.containerName,
      profilePath: undefined,
      quarantinedAt,
      details: info.details,
    };
    const incidentRecord = {
      id: incidentId,
      workspaceId: this.ctx.workspaceId,
      type: "worker_cleanup_quarantine",
      severity: "high",
      createdAt: quarantinedAt,
      runId: this.run.id,
      attemptId: this.fence.attemptId,
      reason: info.reason,
      status: "active",
      details: {
        containerName: info.containerName,
        profilePath: undefined,
        workerId,
        ...(info.details && typeof info.details === "object" ? info.details : {}),
      },
    };
    this.database.withTx(() => {
      this.database.run(
        "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        `worker:quarantine:${this.ctx.workspaceId}`,
        canonicalJson(quarantineRecord),
      );
      this.database.run(
        "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        `incident:${incidentId}`,
        canonicalJson(incidentRecord),
      );
      const outbox = new OutboxRepository(this.database);
      outbox.append(this.ctx.workspaceId, this.run.id, "worker.quarantined", quarantineRecord);
      outbox.append(this.ctx.workspaceId, this.run.id, "incident.created", incidentRecord);
    });
  }
}
