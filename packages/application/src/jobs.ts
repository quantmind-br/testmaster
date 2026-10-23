import { setTimeout as delay } from "node:timers/promises";
import { ContractError } from "@testmaster/contracts";
import {
  type AuxiliaryJob,
  AuxiliaryLeaseRepository,
  type AuxiliaryQueue,
} from "@testmaster/persistence";
import type { DiscoveryService } from "./ai/discovery.js";
import type { ExploreService } from "./ai/explore.js";
import { auditedOperation } from "./audit.js";
import { requireEntity, type ServiceContext } from "./context.js";

/** `job_` ids are auxiliary model jobs; `dsc_` ids are discovery and exploration jobs. */
export type JobKind = AuxiliaryQueue | "discovery" | "exploration";

export interface JobView {
  id: string;
  kind: JobKind;
  /**
   * An auxiliary job is `queued`, `leased`, `completed`, `cancelled` or `reconciliation_required`;
   * a discovery or exploration job reports its phase (`queued`, `exploring`, `completed`, ...).
   */
  state: string;
  /** The job reached an end: `completed`, `cancelled` or `failed`. */
  settled: boolean;
  /**
   * A paid model call started and its holder stopped: the job will not progress by waiting; the
   * operation that owns it records the outcome without a new call.
   */
  needsSettlement: boolean;
  /** The stored outcome of an auxiliary job once it ended; for a `dsc_` job, the job itself. */
  result: unknown;
  /** What the job works on and how far it got. */
  detail: Record<string, unknown>;
}

export interface JobCancelReceipt {
  jobId: string;
  reason: string;
  /** False when the job had already ended, so nothing was asked of it. */
  requested: boolean;
  /**
   * The job as it is now. A request is not a stop: an exploration unwinds after it is asked to,
   * so confirm with `get` that its state is `cancelled`.
   */
  job: JobView;
}

const POLL_MS = 100;
const ENDED_PHASES = ["completed", "failed", "cancelled"];
const NOT_A_JOB =
  "No job has this id; job ids start with job_ (analysis, healing, normalization, delivery) or dsc_ (discovery, exploration). A batch is followed with `run wait` and `report export`";

/**
 * Read, wait for and cancel the durable jobs behind the model operations. It adds no work of its
 * own: it reads what `AnalysisService`, `HealingService`, normalization, `DiscoveryService` and
 * `ExploreService` store, and never starts a model call or sets a deadline on one.
 */
export class JobsService {
  private readonly leases: AuxiliaryLeaseRepository;
  constructor(
    private readonly ctx: ServiceContext,
    private readonly explore: ExploreService,
    private readonly discovery: DiscoveryService,
  ) {
    this.leases = new AuxiliaryLeaseRepository(ctx.database);
  }

  get(id: string): JobView {
    if (id.startsWith("job_")) return this.auxiliary(id);
    if (id.startsWith("dsc_")) return this.phased(id);
    throw new ContractError("NOT_FOUND", NOT_A_JOB, { id });
  }

  /**
   * Blocks until the job ends or needs settlement. There is no deadline: a model call has none,
   * and only `signal` (the caller detaching) stops the wait, which never cancels the job.
   */
  async wait(id: string, signal?: AbortSignal): Promise<JobView> {
    for (;;) {
      const view = this.get(id);
      if (view.settled || view.needsSettlement) return view;
      if (signal?.aborted)
        throw (
          signal.reason ?? new ContractError("PRECONDITION_FAILED", "Job wait detached", { id })
        );
      await delay(POLL_MS, undefined, signal ? { signal } : undefined).catch(() => undefined);
    }
  }

  /**
   * Asks a job to stop. An auxiliary job nobody holds is cancelled at once; one a process holds is
   * refused, because its model call stops only through its own caller's cancellation (Ctrl-C, a
   * client disconnect, an MCP request cancel) and may already be billed. An exploration records the
   * request in its row and the controller that runs it stops it within a second, whichever process
   * received the request.
   */
  async cancel(id: string, reason: string): Promise<JobCancelReceipt> {
    if (!reason.trim() || reason.length > 2000)
      throw new ContractError(
        "INVALID_ARGUMENT",
        "A cancellation reason of 1-2000 characters is required",
        { field: "reason" },
      );
    const before = this.get(id);
    if (before.settled) return { jobId: id, reason, requested: false, job: before };
    return auditedOperation(this.ctx, "job.cancel", id, async () => {
      this.authorizeCancel(id);
      if (before.kind === "exploration") {
        this.explore.cancel(id);
      } else if (before.kind === "discovery") this.discovery.cancel(id);
      else this.cancelAuxiliary(before, id, reason);
      return { jobId: id, reason, requested: true, job: this.get(id) };
    });
  }

  private cancelAuxiliary(before: JobView, id: string, reason: string): void {
    if (before.needsSettlement)
      throw new ContractError(
        "PRECONDITION_FAILED",
        "A paid model call started and its outcome is not settled yet; the job cannot be cancelled",
        { jobId: id, state: before.state },
      );
    const cancelled = this.leases.cancelQueued(this.ctx.workspaceId, id, {
      reason: "cancel_requested",
      cancelReason: reason,
    });
    if (!cancelled)
      throw new ContractError(
        "PRECONDITION_FAILED",
        "A process holds this job, and its model call stops only through its own caller's cancellation; wait for it with `job wait`",
        { jobId: id, state: this.get(id).state },
      );
  }

  private auxiliary(id: string): JobView {
    this.ctx.authorize("R");
    const job = this.leases.get(this.ctx.workspaceId, id);
    if (!job) throw new ContractError("NOT_FOUND", "Job does not exist", { id });
    const projectId = this.projectOf(job);
    if (projectId) this.ctx.authorize("R", projectId);
    return {
      id,
      kind: job.queue,
      state: job.state,
      settled: job.state === "completed" || job.state === "cancelled",
      needsSettlement: job.state === "reconciliation_required",
      result: job.result,
      detail: {
        operation: job.payload.operation,
        targetId: job.payload.targetId,
        attempts: job.attempts,
        progress: job.progress,
      },
    };
  }

  private phased(id: string): JobView {
    this.ctx.authorize("R");
    const raw = requireEntity(this.ctx, "DiscoveryJob", id);
    const exploring =
      "testmaster:environmentRevisionId" in (raw.extensions as Record<string, unknown>);
    // Each service authorizes the read against the project its job belongs to.
    const job = exploring ? this.explore.get(id) : this.discovery.get(id).job;
    const phase = String(job.phase);
    const settled = ENDED_PHASES.includes(phase);
    return {
      id,
      kind: exploring ? "exploration" : "discovery",
      state: phase,
      settled,
      needsSettlement: false,
      result: settled ? job : null,
      detail: { job },
    };
  }

  private authorizeCancel(id: string): void {
    this.ctx.authorize("X");
    const job = this.leases.get(this.ctx.workspaceId, id);
    const projectId = job ? this.projectOf(job) : undefined;
    if (projectId) this.ctx.authorize("X", projectId);
  }

  /** The project an auxiliary job works for; delivery jobs belong to no single project. */
  private projectOf(job: AuxiliaryJob): string | undefined {
    if (job.queue === "normalization") return job.payload.targetId;
    if (job.queue !== "analysis" && job.queue !== "healing") return undefined;
    const run = this.ctx.entities.get("Run", this.ctx.workspaceId, job.payload.targetId);
    const test = run
      ? this.ctx.entities.get("TestCase", this.ctx.workspaceId, String(run.testId))
      : undefined;
    return test ? String(test.projectId) : undefined;
  }
}
