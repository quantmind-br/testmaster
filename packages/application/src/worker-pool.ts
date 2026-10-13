import { randomUUID } from "node:crypto";
import {
  ContractError,
  WORKER_ENROLLMENT_DEFAULT_TTL_SECONDS,
  WORKER_HEARTBEAT_TIMEOUT_MS,
  type WorkerEnrollment,
  type WorkerEnrollmentInput,
} from "@testmaster/contracts";
import {
  AuditRepository,
  type EntityDocument,
  LeaseRepository,
  OutboxRepository,
  type PersistenceDatabase,
} from "@testmaster/persistence";
import { auditSecurity } from "./audit.js";
import { entity, requireEntity, type ServiceContext } from "./context.js";
import { sha256Hex } from "./passwords.js";
import { insertToken, revokeTokenRow, tokenKind } from "./tokens.js";

/** A tenant that has waited this long for a slot is allowed one more concurrent job (aging). */
export const fairShareAgingMs = 60_000;
const defaultSlotsPerWorker = 2;

export interface FairShareInput {
  database: PersistenceDatabase;
  workspaceId: string;
  now: Date;
  queue?: string;
}

/**
 * OPS-033 fair share on one host: while another tenant has claimable work, a tenant may hold at
 * most its share of the ready workers' slots, plus one extra slot per `fairShareAgingMs` it has
 * waited (bounded by the slot count). With no competing demand the cap is lifted, so the pool
 * never idles because of fairness. Returns `undefined` for "no cap". Reads every tenant, so the
 * database must be a controller-scope view and the call must be outside a transaction.
 */
export function fairShareCap(input: FairShareInput): number | undefined {
  const queue = input.queue ?? "local";
  const at = input.now.toISOString();
  const tenants = input.database.all(
    "SELECT workspace_id, SUM(CASE WHEN state='leased' THEN 1 ELSE 0 END) AS leased, SUM(CASE WHEN state='queued' AND dispatchable=1 AND available_at<=? THEN 1 ELSE 0 END) AS queued, MIN(CASE WHEN state='queued' AND dispatchable=1 AND available_at<=? THEN available_at END) AS oldest FROM job_leases WHERE queue=? AND state IN ('leased','queued') GROUP BY workspace_id",
    at,
    at,
    queue,
  );
  const mine = tenants.find((row) => row.workspace_id === input.workspaceId);
  const competing = tenants.some(
    (row) => row.workspace_id !== input.workspaceId && Number(row.queued) > 0,
  );
  if (!competing || !mine || Number(mine.queued) === 0) return undefined;
  const slots = readySlots(input.database, input.now);
  const active = tenants.filter((row) => Number(row.queued) > 0 || Number(row.leased) > 0).length;
  const waited = mine.oldest
    ? Math.max(0, input.now.getTime() - Date.parse(String(mine.oldest)))
    : 0;
  const aging = Math.min(slots, Math.floor(waited / fairShareAgingMs));
  return Math.max(1, Math.ceil(slots / Math.max(1, active)) + aging);
}

/** Concurrent executions the fresh, ready workers declared; a worker without a declaration counts as two. */
function readySlots(database: PersistenceDatabase, now: Date): number {
  const fresh = new Date(now.getTime() - WORKER_HEARTBEAT_TIMEOUT_MS).toISOString();
  const workers = database.all(
    "SELECT data_json FROM workers WHERE state='ready' AND last_heartbeat_at>?",
    fresh,
  );
  let total = 0;
  for (const worker of workers) {
    let declared = defaultSlotsPerWorker;
    try {
      const labels: unknown = JSON.parse(String(worker.data_json)).labels;
      const slots = Number((labels as Record<string, unknown> | undefined)?.slots);
      if (Number.isInteger(slots) && slots > 0) declared = slots;
    } catch {
      // A malformed document keeps the default.
    }
    total += declared;
  }
  return Math.max(1, total);
}

/** The worker pool of one workspace: enrollment, drain, revoke and liveness (REQ-038, M4-08). */
export class WorkerPoolService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly options: { now?: () => Date } = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  list(): EntityDocument[] {
    this.ctx.authorize("A");
    return this.ctx.database
      .all(
        "SELECT id FROM workers WHERE workspace_id=? ORDER BY created_at DESC,id DESC",
        this.ctx.workspaceId,
      )
      .map((row) => requireEntity(this.ctx, "Worker", String(row.id)));
  }

  get(id: string): EntityDocument {
    this.ctx.authorize("A");
    return requireEntity(this.ctx, "Worker", id);
  }

  /**
   * Creates the worker in `enrolling` state and a one-use token the worker presents when it
   * starts. The token is returned once and only its hash is stored.
   */
  createEnrollment(input: WorkerEnrollmentInput): WorkerEnrollment {
    this.ctx.authorize("A");
    const ttl = input.expiresInSeconds ?? WORKER_ENROLLMENT_DEFAULT_TTL_SECONDS;
    const tokenExpiresAt = new Date(this.now().getTime() + ttl * 1000).toISOString();
    const create = () => {
      const { token, id: tokenId } = insertToken(this.ctx.database, {
        workspaceId: this.ctx.workspaceId,
        principalId: this.ctx.principalId,
        kind: "worker",
        name: `worker:${input.name}`.slice(0, 200),
        scopes: [],
        grants: [],
        expiresAt: tokenExpiresAt,
      });
      const worker = entity(this.ctx, "wrk", {
        identityRef: `pending:${tokenId}`,
        capabilities: [],
        imageDigests: [],
        labels: { ...(input.labels ?? {}), name: input.name, enrollmentTokenId: tokenId },
        state: "enrolling",
        lastHeartbeatAt: null,
      });
      this.ctx.entities.insert("Worker", worker);
      auditSecurity(this.ctx, "worker.enrollment_created", worker.id, "allowed");
      return { worker, enrollmentToken: token, tokenExpiresAt } as WorkerEnrollment;
    };
    return this.ctx.database.inTransaction ? create() : this.ctx.database.withTx(create);
  }

  /**
   * Presents an enrollment token (controller scope: the workspace is only known from the token).
   * An unused, unexpired token enrolls its worker exactly once. Presenting it again resumes the
   * same identity until the worker is revoked, so a restarted process keeps its worker row.
   */
  enroll(token: string): { workspaceId: string; workerId: string; resumed: boolean } {
    const invalid = () =>
      new ContractError("UNAUTHENTICATED", "Enrollment token is invalid or expired");
    if (tokenKind(token) !== "worker") throw invalid();
    const database = this.ctx.database;
    const row = database.get(
      "SELECT workspace_id,id,expires_at,revoked_at FROM server_tokens WHERE token_hash=?",
      sha256Hex(token),
    );
    if (!row) throw invalid();
    const workspaceId = String(row.workspace_id);
    const worker = database.get(
      "SELECT id,state FROM workers WHERE workspace_id=? AND json_extract(data_json,'$.labels.enrollmentTokenId')=?",
      workspaceId,
      String(row.id),
    );
    if (!worker || worker.state === "revoked") throw invalid();
    const workerId = String(worker.id);
    const enroll = () => {
      if (row.revoked_at === null || row.revoked_at === undefined) {
        if (Date.parse(String(row.expires_at)) <= this.now().getTime()) throw invalid();
        if (!revokeTokenRow(database, workspaceId, String(row.id))) throw invalid();
        new AuditRepository(database).append({
          workspaceId,
          actor: `worker:${workerId}`,
          action: "worker.enroll",
          resourceId: workerId,
          requestId: randomUUID(),
          timestamp: this.now().toISOString(),
          beforeHash: null,
          afterHash: null,
        });
        return false;
      }
      return true;
    };
    const resumed = database.inTransaction ? enroll() : database.withTx(enroll);
    return { workspaceId, workerId, resumed };
  }

  /** Stops new claims; the worker finishes what it holds and goes offline. */
  drain(id: string): EntityDocument {
    this.ctx.authorize("A");
    const worker = requireEntity(this.ctx, "Worker", id);
    if (worker.state === "revoked")
      throw new ContractError("PRECONDITION_FAILED", "Worker is revoked", { id });
    this.ctx.database.withTx(() => {
      this.ctx.database.run(
        "UPDATE workers SET state='draining',version=version+1 WHERE workspace_id=? AND id=? AND state IN ('ready','enrolling')",
        this.ctx.workspaceId,
        id,
      );
      auditSecurity(this.ctx, "worker.drain", id, "allowed");
    });
    return requireEntity(this.ctx, "Worker", id);
  }

  /** Revocation is final: the worker claims nothing more and every lease it holds is fenced. */
  revoke(id: string): EntityDocument {
    this.ctx.authorize("A");
    const worker = requireEntity(this.ctx, "Worker", id);
    const labels = worker.labels as Record<string, string>;
    this.ctx.database.withTx(() => {
      this.ctx.database.run(
        "UPDATE workers SET state='revoked',version=version+1 WHERE workspace_id=? AND id=?",
        this.ctx.workspaceId,
        id,
      );
      if (labels.enrollmentTokenId)
        revokeTokenRow(this.ctx.database, this.ctx.workspaceId, labels.enrollmentTokenId);
      const fenced = new LeaseRepository(this.ctx.database).fenceWorker(
        this.ctx.workspaceId,
        id,
        this.now().toISOString(),
      );
      new OutboxRepository(this.ctx.database).append(this.ctx.workspaceId, id, "worker.revoked", {
        workerId: id,
        fencedJobs: fenced.length,
      });
      auditSecurity(this.ctx, "worker.revoke", id, "allowed");
    });
    return requireEntity(this.ctx, "Worker", id);
  }

  /** Marks ready workers whose heartbeat stopped as offline and announces each loss once. */
  sweepOffline(): string[] {
    const cutoff = new Date(this.now().getTime() - WORKER_HEARTBEAT_TIMEOUT_MS).toISOString();
    return this.ctx.database.withTx(() => {
      const stale = this.ctx.database.all(
        "SELECT id,version FROM workers WHERE workspace_id=? AND state='ready' AND (last_heartbeat_at IS NULL OR last_heartbeat_at<=?)",
        this.ctx.workspaceId,
        cutoff,
      );
      const lost: string[] = [];
      for (const row of stale) {
        const changed = this.ctx.database.run(
          "UPDATE workers SET state='offline',version=version+1 WHERE workspace_id=? AND id=? AND state='ready' AND version=?",
          this.ctx.workspaceId,
          row.id,
          Number(row.version),
        );
        if (Number(changed.changes) !== 1) continue;
        lost.push(String(row.id));
        new OutboxRepository(this.ctx.database).append(
          this.ctx.workspaceId,
          String(row.id),
          "worker.offline",
          { workerId: String(row.id) },
        );
      }
      return lost;
    });
  }
}
