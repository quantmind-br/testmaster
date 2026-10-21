import { lstat, mkdir, readFile, rm, statfs } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ContractError, defaults, type ExecutablePlan, validate } from "@testmaster/contracts";
import {
  type AttemptObservation,
  canonicalJson,
  canRetry,
  reduceOutcome,
  semanticHash,
} from "@testmaster/domain";
import { ConfinedRoot, collectGarbage, findOrphanStaging } from "@testmaster/evidence";
import {
  auxiliaryQueues,
  type EntityDocument,
  type Fence,
  LeaseRepository,
  OutboxRepository,
  StaleFenceError,
} from "@testmaster/persistence";
import {
  AttemptExecutor,
  type AttemptRuntimeExecutor,
  type DockerCommand,
  DockerExecutor,
  type ExecutorKind,
  type ImageLock,
} from "@testmaster/sandbox";
import {
  type AttemptDispatch,
  AttemptSession,
  abandonAttemptResources,
  attemptObservations,
  eraseSettledCaptures,
  executorKindOf,
  planSteps,
  runCancelRequested,
  runDependencies,
} from "./attempt-session.js";
import { auditSecurity } from "./audit.js";
import type { AuthProfilesService } from "./auth/index.js";
import { runMatrixCell } from "./comparisons.js";
import type { ResolvedConfig } from "./config.js";
import { entity, type RunActor, requireEntity, type ServiceContext } from "./context.js";
import { memberIntervalReady } from "./member-interval.js";
import { OperationalLogger } from "./observability.js";
import type { ResolvedDependency, RunsService } from "./runs.js";
import type { SecretsService } from "./secrets.js";
import {
  type EvidenceLimits,
  freeDataBytes,
  hasStorageRoom,
  inFlightEvidenceBytes,
  runEvidenceBytes,
  type StorageRoom,
} from "./storage-admission.js";
import { UnsafeRuntime } from "./unsafe-runtime.js";
import { fitsCapacity, validateCapacity, type WorkerCapacity } from "./worker-capacity.js";
import {
  localHandshake,
  selectsWorker,
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
  /** The pinned image lock without inspecting this host's Docker, for remote workers (ADR-030). */
  lockedImages?: () => Promise<ImageLock>;
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
    return runCancelRequested(this.ctx, runId);
  }
  private observations(runId: string, plan: ExecutablePlan | null): AttemptObservation[] {
    return attemptObservations(this.ctx, runId, plan);
  }
  private dependencies(run: EntityDocument): ResolvedDependency[] {
    return runDependencies(run);
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
  /**
   * Runs one claimed Attempt in this process: the AttemptSession writes everything under the
   * fence, and the worker only renews the lease, watches for a cancel and runs the sandbox.
   */
  private async execute(
    fence: Fence & { runId: string; number: number },
    signal?: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController();
    const session = AttemptSession.open(this.ctx, this.host, fence, {
      workerId: this.workerId,
      signal: controller.signal,
    });
    const logs = this.logs;
    logs.record({
      component: "worker",
      event: "attempt.started",
      correlationId: session.correlationId,
      runId: session.runId,
      attemptId: fence.attemptId,
    });
    this.active.set(session.runId, controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted || session.cancelled()) controller.abort();
    let heartbeatError: unknown;
    const poll = setInterval(() => {
      if (session.cancelled()) controller.abort();
    }, 100);
    // Fencing: another worker may reclaim the attempt once its lease expires, so this one must
    // have stopped by then. A contended renewal is tolerated only while the last renewed lease
    // still outlives one more heartbeat interval; anything else, or a lease about to lapse,
    // stops the attempt.
    let leaseExpiresAt = session.leaseExpiresAt();
    const heartbeat = setInterval(() => {
      try {
        leaseExpiresAt = session.heartbeat();
      } catch (error) {
        if (isWriterContention(error) && leaseExpiresAt - Date.now() > leaseHeartbeatIntervalMs)
          return;
        heartbeatError = error;
        controller.abort();
      }
    }, leaseHeartbeatIntervalMs);
    const inputDir = join(this.host.config.dataDir, "cache", "attempt-input", fence.attemptId);
    try {
      const dispatch = await session.prepare(inputDir);
      if (!dispatch) return;
      const { executor, ...input } = dispatch;
      const docker = this.host.docker ?? this.dockerExecutor();
      const runtime = executor === "process" ? new UnsafeRuntime(this.host.config) : docker;
      const runtimeRoot = await this.runtimeRoot();
      const result = await new AttemptExecutor(session.evidence(), runtime, runtimeRoot).execute(
        { ...input, ...session.bindings(), seccompPath: this.host.seccompPath },
        controller.signal,
      );
      await session.finalize(result, heartbeatError);
    } catch (error) {
      await session.fail(error);
    } finally {
      clearInterval(poll);
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", abort);
      this.active.delete(session.runId);
      await rm(inputDir, { recursive: true, force: true });
      logs.record({
        component: "worker",
        event: "attempt.completed",
        correlationId: session.correlationId,
        runId: session.runId,
        attemptId: fence.attemptId,
      });
      await logs.flush();
      await session.close();
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
    abandonAttemptResources(this.ctx, attemptId, assertOwnership);
  }
  private eraseSettledCaptures(): Promise<void> {
    return eraseSettledCaptures(this.ctx, this.host.secrets);
  }
  /**
   * Expires overdue leases and settles the Runs they leave: a retry-safe Run is requeued, any other
   * completes. Every write is fenced, so the API process may run it for remote workers (ADR-030).
   */
  settleLeases(): string[] {
    const database = this.ctx.database;
    const leases = new LeaseRepository(database);
    const expired = leases.expire();
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
    return expired;
  }
  private async maintenance() {
    const database = this.ctx.database;
    const expired = this.settleLeases();
    await this.eraseSettledCaptures();
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
  /** The sandbox executor kind of a Run, from its test revision's runner. */
  private runKind(runId: string): ExecutorKind {
    const run = this.host.runs.get(runId);
    const revision = requireEntity(this.ctx, "TestRevision", run.revisionId);
    return executorKindOf(revision.runnerKind ?? (revision.plan as ExecutablePlan | null)?.runner);
  }
  /**
   * Selects and claims the next Run a worker may run (OPS-008, OPS-032, OPS-033): queued order,
   * flake and dependency predecessors settled, suite pacing, the handshake's capabilities, the
   * environment's worker selector (ADR-030), the admitting actor still allowed, the tenant's
   * fair share, then capacity and storage inside the claim transaction. Synchronous, so a
   * caller repeats it whole while the writer is contended. Shared by the local loop and the
   * remote protocol.
   */
  claimNext(input: {
    owner: string;
    workerId: string | null;
    /** The worker's labels; null for a worker without a row, which no selector matches. */
    labels: Readonly<Record<string, unknown>> | null;
    handshake: WorkerHandshake | null;
    lock: ImageLock | null;
    runIds?: readonly string[];
    capacity: WorkerCapacity;
    /** Executor kinds whose capacity is already taken, read inside the claim transaction. */
    reserved: () => ExecutorKind[];
    /** Whether the Run's worst-case evidence fits next to the work in progress. */
    storage: (runId: string) => boolean;
  }): (Fence & { runId: string; expiresAt: string; number: number }) | null {
    const database = this.ctx.database;
    const { handshake, lock, runIds } = input;
    const candidates = database
      .all(
        "SELECT r.id FROM runs r JOIN job_leases j ON j.workspace_id=r.workspace_id AND j.resource_id=r.id WHERE r.workspace_id=? AND j.state='queued' ORDER BY j.available_at,j.id",
        this.ctx.workspaceId,
      )
      .map((row) => String(row.id))
      .filter((id) => {
        if (runIds && !runIds.includes(id)) return false;
        const run = this.host.runs.get(id);
        const cancelled = this.cancelled(id);
        const predecessor = runMatrixCell(run).flakePredecessorRunId;
        return (
          (cancelled ||
            typeof predecessor !== "string" ||
            this.host.runs.get(predecessor).phase === "completed") &&
          (!handshake ||
            !lock ||
            supportsQueuedRun(
              handshake,
              run,
              requireEntity(this.ctx, "TestRevision", run.revisionId),
              lock,
            )) &&
          selectsWorker(
            requireEntity(this.ctx, "EnvironmentRevision", run.environmentRevisionId),
            input.labels,
          ) &&
          (cancelled ||
            this.dependencies(run).every(
              (binding) => this.host.runs.get(binding.producerRunId).phase === "completed",
            )) &&
          this.memberIntervalReady(id)
        );
      });
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
    // The transaction makes resource reservation and lease claim indivisible across owners.
    return database.withTx(() => {
      if (this.isQuarantined()) return null;
      const reserved = input.reserved();
      // A cancelled run still claims, to finalize without writing evidence.
      const eligible = candidates.filter(
        (id) =>
          fitsCapacity(input.capacity, reserved, this.runKind(id)) &&
          (this.cancelled(id) || input.storage(id)),
      );
      return new LeaseRepository(database).claim({
        workspaceId: this.ctx.workspaceId,
        owner: input.owner,
        queue: "local",
        runIds: eligible,
        ...(maxLeased !== undefined ? { maxLeased } : {}),
        ...(input.workerId ? { workerId: input.workerId } : {}),
      });
    });
  }
  /**
   * Claims the next Run for a remote worker (ADR-030) and opens the Attempt's controller session:
   * the snapshot is sealed and the input files are written under `inputDir` for the worker to
   * fetch. The image lock is read without this host's Docker; the worker runs only images its own
   * daemon verified. Returns null when nothing is claimable, or when the claimed Run was settled
   * while it was prepared (a blocked dependency, a spent deadline or a refused preparation).
   */
  async claimForRemote(input: {
    workerId: string;
    labels: Readonly<Record<string, unknown>>;
    handshake: WorkerHandshake;
    capacity: WorkerCapacity;
    /** Executor kinds of the Attempts the worker already runs, in every workspace. */
    reserved: readonly ExecutorKind[];
    /** Worst-case evidence of those Attempts, held on the worker's disk until it is uploaded. */
    inFlightBytes: number;
  }): Promise<{
    session: AttemptSession;
    controller: AbortController;
    dispatch: AttemptDispatch;
    inputDir: string;
    expiresAt: string;
  } | null> {
    const images = this.host.lockedImages ?? this.host.images;
    const lock = await images();
    const handshake = validateHandshake(input.handshake, localHandshake(lock));
    const capacity = validateCapacity(input.capacity);
    const room = await this.storageRoom();
    const database = this.ctx.database;
    const fence = await retryWriterContention(
      () =>
        this.claimNext({
          owner: `remote:${input.workerId}`,
          workerId: input.workerId,
          labels: input.labels,
          handshake,
          lock,
          capacity,
          reserved: () => [...input.reserved],
          // The evidence lands on this server and, until it is uploaded, on the worker's disk.
          storage: (id) => {
            const incomingBytes = this.worstCaseEvidence(id);
            return (
              hasStorageRoom({ ...room, incomingBytes }) &&
              hasStorageRoom({
                freeBytes: capacity.diskBytes,
                inFlightBytes: input.inFlightBytes,
                incomingBytes,
              })
            );
          },
        }),
      { inTransaction: () => database.inTransaction },
    );
    if (!fence) return null;
    const controller = new AbortController();
    const session = AttemptSession.open(this.ctx, { ...this.host, images }, fence, {
      workerId: input.workerId,
      signal: controller.signal,
    });
    const inputDir = join(this.host.config.dataDir, "cache", "remote-input", fence.attemptId);
    let dispatch: AttemptDispatch | null = null;
    try {
      dispatch = await session.prepare(inputDir);
    } catch (error) {
      await session.fail(error);
    }
    if (!dispatch) {
      await rm(inputDir, { recursive: true, force: true });
      await session.close();
      return null;
    }
    return { session, controller, dispatch, inputDir, expiresAt: fence.expiresAt };
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
      /**
       * The caller's explicit stop of a long-lived worker, such as a second interruption. A drain
       * has no deadline: attempts in flight finish under their own limits, and a model answer is
       * never cut. Aborting this signal stops them now instead; each one ends as an interrupted
       * attempt under its fence. The attempts of an ephemeral worker already stop at `signal`.
       */
      force?: AbortSignal;
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
        if (options.force?.aborted) this.drainRequested = true;
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
          const fence = await contended(() =>
            this.claimNext({
              owner: this.owner,
              workerId: this.workerId,
              labels: this.workerId
                ? (requireEntity(this.ctx, "Worker", this.workerId).labels as Record<
                    string,
                    unknown
                  >)
                : null,
              handshake,
              lock,
              ...(runIds ? { runIds } : {}),
              capacity,
              // Local owners on this host share its capacity; remote workers bring their own.
              reserved: () =>
                database
                  .all(
                    `SELECT resource_id FROM job_leases WHERE state='leased' AND dispatchable=1 AND ${runJobFilter} AND lease_owner NOT LIKE 'remote:%'`,
                  )
                  .map((row) => this.runKind(String(row.resource_id))),
              // A run starts only when the free space holds its worst-case evidence next to the
              // runs in progress; otherwise it stays queued, with no deadline, until room returns.
              storage: (id) =>
                room === null ||
                hasStorageRoom({ ...room, incomingBytes: this.worstCaseEvidence(id) }),
            }),
          );
          if (fence) {
            const task = this.execute(
              fence,
              options.ephemeral ? options.signal : options.force,
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
