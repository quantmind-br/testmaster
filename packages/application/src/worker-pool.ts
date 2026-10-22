import { randomUUID } from "node:crypto";
import {
  ContractError,
  WORKER_CREDENTIAL_TTL_SECONDS,
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
  StaleFenceError,
} from "@testmaster/persistence";
import { auditAs, auditSecurity } from "./audit.js";
import { entity, requireEntity, type ServiceContext } from "./context.js";
import { sha256Hex } from "./passwords.js";
import { insertToken, revokeTokenRow, tokenKind } from "./tokens.js";

/** A tenant that has waited this long for a slot is allowed one more concurrent job (aging). */
export const fairShareAgingMs = 60_000;
const defaultSlotsPerWorker = 2;

/** Joins the surrounding transaction (idempotent HTTP handlers run inside one) or opens its own. */
function inTx<T>(database: PersistenceDatabase, action: () => T): T {
  return database.inTransaction ? action() : database.withTx(action);
}

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

/**
 * Concurrent executions the fresh, ready workers declared; a worker without a declaration counts
 * as two. A shared pool worker has a row in each workspace it serves and counts once (ADR-030).
 */
function readySlots(database: PersistenceDatabase, now: Date): number {
  const fresh = new Date(now.getTime() - WORKER_HEARTBEAT_TIMEOUT_MS).toISOString();
  const workers = database.all(
    "SELECT id,data_json FROM workers WHERE state='ready' AND last_heartbeat_at>?",
    fresh,
  );
  const declaredById = new Map<string, number>();
  for (const worker of workers) {
    let declared = defaultSlotsPerWorker;
    try {
      const labels: unknown = JSON.parse(String(worker.data_json)).labels;
      const slots = Number((labels as Record<string, unknown> | undefined)?.slots);
      if (Number.isInteger(slots) && slots > 0) declared = slots;
    } catch {
      // A malformed document keeps the default.
    }
    const id = String(worker.id);
    declaredById.set(id, Math.max(declaredById.get(id) ?? 0, declared));
  }
  let total = 0;
  for (const declared of declaredById.values()) total += declared;
  return Math.max(1, total);
}

/** Label that marks the operator's shared pool worker, which claims for every workspace. */
export const SHARED_WORKER_LABEL = "sharedPool";

/** The worker a remote `tm_wrk_` credential belongs to (ADR-030). */
export interface RemoteWorkerCaller {
  /** The workspace that holds the worker's own row and credential. */
  workspaceId: string;
  workerId: string;
  shared: boolean;
}

interface CredentialOwner {
  workspaceId: string;
  tokenId: string;
  workerId: string;
  enrolled: boolean;
  shared: boolean;
  /** The Ed25519 key a remote worker bound at enrollment (ADR-031), null before. */
  publicKey: string | null;
}
/** Body of a worker heartbeat (catalog `HeartbeatInput`). */
export interface WorkerHeartbeat {
  leaseId: string;
  state: "ready" | "draining" | "offline";
  version: number;
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
   * starts. The token is returned once and only its hash is stored. A `shared` worker is the
   * server operator's pool worker: it claims for every workspace (ADR-030).
   */
  createEnrollment(
    input: WorkerEnrollmentInput,
    options: { shared?: boolean } = {},
  ): WorkerEnrollment {
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
        labels: {
          ...(input.labels ?? {}),
          name: input.name,
          enrollmentTokenId: tokenId,
          ...(options.shared ? { [SHARED_WORKER_LABEL]: "true" } : {}),
        },
        state: "enrolling",
        lastHeartbeatAt: null,
      });
      this.ctx.entities.insert("Worker", worker);
      auditSecurity(this.ctx, "worker.enrollment_created", worker.id, "allowed");
      return { worker, enrollmentToken: token, tokenExpiresAt } as WorkerEnrollment;
    };
    return this.ctx.database.inTransaction ? create() : this.ctx.database.withTx(create);
  }

  private workerDocument(workspaceId: string, id: string): EntityDocument {
    const found = this.ctx.entities.get("Worker", workspaceId, id);
    if (!found) throw new ContractError("NOT_FOUND", "Worker does not exist", { id });
    return found;
  }

  /** The worker a `tm_wrk_` credential belongs to, or null when the token is unknown, expired or revoked. */
  private credentialOwner(token: string): CredentialOwner | null {
    if (tokenKind(token) !== "worker") return null;
    const database = this.ctx.database;
    const row = database.get(
      "SELECT workspace_id,id,expires_at,revoked_at FROM server_tokens WHERE token_hash=?",
      sha256Hex(token),
    );
    if (!row || row.revoked_at) return null;
    const workspaceId = String(row.workspace_id);
    const worker = database.get(
      "SELECT id,state,data_json FROM workers WHERE workspace_id=? AND json_extract(data_json,'$.labels.enrollmentTokenId')=?",
      workspaceId,
      String(row.id),
    );
    if (!worker || worker.state === "revoked") return null;
    if (Date.parse(String(row.expires_at)) <= this.now().getTime()) return null;
    const document: { labels?: Record<string, unknown> } = JSON.parse(String(worker.data_json));
    const publicKey = document.labels?.publicKey;
    return {
      workspaceId,
      tokenId: String(row.id),
      workerId: String(worker.id),
      enrolled: typeof document.labels?.enrolledAt === "string",
      shared: document.labels?.[SHARED_WORKER_LABEL] === "true",
      publicKey: typeof publicKey === "string" ? publicKey : null,
    };
  }

  /**
   * The enrolled remote worker `workerId` and the key it bound, to verify a signed call
   * (ADR-031); null when the worker is unknown, revoked, not enrolled, holds no key, or its
   * credential expired or was revoked. A shared worker's own row is the one its token belongs to.
   */
  remoteKey(workerId: string): { caller: RemoteWorkerCaller; publicKey: string } | null {
    const database = this.ctx.database;
    for (const row of database.all(
      "SELECT workspace_id,state,data_json FROM workers WHERE id=?",
      workerId,
    )) {
      const document: { labels?: Record<string, unknown> } = JSON.parse(String(row.data_json));
      const labels = document.labels ?? {};
      if (typeof labels.enrollmentTokenId !== "string") continue;
      const token = database.get(
        "SELECT expires_at,revoked_at FROM server_tokens WHERE workspace_id=? AND id=?",
        row.workspace_id,
        labels.enrollmentTokenId,
      );
      if (!token) continue;
      if (
        token.revoked_at ||
        row.state === "revoked" ||
        Date.parse(String(token.expires_at)) <= this.now().getTime() ||
        typeof labels.enrolledAt !== "string" ||
        typeof labels.publicKey !== "string"
      )
        return null;
      return {
        caller: {
          workspaceId: String(row.workspace_id),
          workerId,
          shared: labels[SHARED_WORKER_LABEL] === "true",
        },
        publicKey: labels.publicKey,
      };
    }
    return null;
  }

  /**
   * Presents an enrollment token (controller scope: the workspace is only known from the token).
   * An unused, unexpired token enrolls its worker exactly once and from then on is that worker's
   * credential (`WORKER_CREDENTIAL_TTL_SECONDS`). Presenting it again resumes the same identity
   * until the worker is revoked, so a restarted process keeps its worker row. A remote worker
   * presents `publicKey`: the first enrollment that carries one binds it, and from then on the
   * credential enrolls only with that key, so a copied token without the private key is useless
   * (ADR-031).
   */
  enroll(
    token: string,
    publicKey?: string,
  ): { workspaceId: string; workerId: string; resumed: boolean; shared: boolean } {
    const owner = this.credentialOwner(token);
    if (!owner)
      throw new ContractError("UNAUTHENTICATED", "Enrollment token is invalid or expired");
    const { workspaceId, workerId, tokenId, shared } = owner;
    if (publicKey !== undefined && owner.publicKey !== null && owner.publicKey !== publicKey) {
      auditAs(
        { database: this.ctx.database, workspaceId, actor: `worker:${workerId}` },
        "worker.key_mismatch",
        workerId,
        "denied",
      );
      throw new ContractError("UNAUTHENTICATED", "The worker credential is bound to another key");
    }
    const bind = publicKey !== undefined && owner.publicKey === null;
    if (owner.enrolled && !bind) return { workspaceId, workerId, resumed: true, shared };
    const enroll = () => {
      const at = this.now();
      if (!owner.enrolled)
        this.ctx.database.run(
          "UPDATE server_tokens SET expires_at=? WHERE workspace_id=? AND id=? AND revoked_at IS NULL",
          new Date(at.getTime() + WORKER_CREDENTIAL_TTL_SECONDS * 1000).toISOString(),
          workspaceId,
          tokenId,
        );
      const current = this.workerDocument(workspaceId, workerId);
      const labels = current.labels as Record<string, string>;
      this.ctx.entities.update("Worker", workspaceId, workerId, Number(current.version), {
        ...current,
        labels: {
          ...labels,
          ...(owner.enrolled ? {} : { enrolledAt: at.toISOString() }),
          ...(bind ? { publicKey } : {}),
        },
      });
      new AuditRepository(this.ctx.database).append({
        workspaceId,
        actor: `worker:${workerId}`,
        action: owner.enrolled ? "worker.key_bound" : "worker.enroll",
        resourceId: workerId,
        requestId: randomUUID(),
        timestamp: at.toISOString(),
        beforeHash: null,
        afterHash: null,
      });
    };
    if (this.ctx.database.inTransaction) enroll();
    else this.ctx.database.withTx(enroll);
    return { workspaceId, workerId, resumed: owner.enrolled, shared };
  }

  /**
   * Heartbeat over HTTP (REQ-038): authenticated by the worker credential and scoped to that
   * worker. Renews the named lease if this worker still holds it, applies a requested state change
   * (an administrator's drain always wins) and answers the worker document with its version.
   */
  heartbeat(token: string, workerId: string, input: WorkerHeartbeat): EntityDocument {
    const owner = this.credentialOwner(token);
    if (!owner?.enrolled || owner.workerId !== workerId)
      throw new ContractError("UNAUTHENTICATED", "A valid worker credential is required");
    const { workspaceId } = owner;
    const database = this.ctx.database;
    const at = this.now().toISOString();
    inTx(database, () => {
      const worker = database.get(
        "SELECT state,version FROM workers WHERE workspace_id=? AND id=?",
        workspaceId,
        workerId,
      );
      if (!worker || worker.state === "revoked")
        throw new ContractError("UNAUTHENTICATED", "A valid worker credential is required");
      if (Number(worker.version) !== input.version)
        throw new ContractError("REVISION_CONFLICT", "Worker version changed", {
          current: Number(worker.version),
        });
      const held = database.get(
        "SELECT j.fence,j.lease_owner,a.id AS attempt_id FROM job_leases j JOIN attempts a ON a.workspace_id=j.workspace_id AND a.job_id=j.id AND a.fence=j.fence WHERE j.workspace_id=? AND j.id=? AND j.state='leased' AND a.worker_id=?",
        workspaceId,
        input.leaseId,
        workerId,
      );
      if (!held)
        throw new ContractError("PRECONDITION_FAILED", "The worker does not hold this lease", {
          reasonCode: "lease_lost",
          leaseId: input.leaseId,
        });
      try {
        new LeaseRepository(database).heartbeat(
          {
            workspaceId,
            jobId: input.leaseId,
            owner: String(held.lease_owner),
            fence: Number(held.fence),
            attemptId: String(held.attempt_id),
          },
          undefined,
          at,
        );
      } catch (error) {
        // An expired lease was already reclaimable: the worker must stop, not retry.
        if (error instanceof StaleFenceError)
          throw new ContractError("PRECONDITION_FAILED", "The worker does not hold this lease", {
            reasonCode: "lease_lost",
            leaseId: input.leaseId,
          });
        throw error;
      }
      // Draining is an administrator's decision: a worker reporting ready never undoes it.
      const next =
        worker.state === "draining" && input.state === "ready" ? "draining" : input.state;
      database.run(
        "UPDATE workers SET last_heartbeat_at=?,state=?,version=version+(CASE WHEN state=? THEN 0 ELSE 1 END) WHERE workspace_id=? AND id=?",
        at,
        next,
        next,
        workspaceId,
        workerId,
      );
    });
    return this.workerDocument(workspaceId, workerId);
  }

  /** Stops new claims; the worker finishes what it holds and goes offline. */
  drain(id: string): EntityDocument {
    this.ctx.authorize("A");
    const worker = requireEntity(this.ctx, "Worker", id);
    if (worker.state === "revoked")
      throw new ContractError("PRECONDITION_FAILED", "Worker is revoked", { id });
    inTx(this.ctx.database, () => {
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
    inTx(this.ctx.database, () => {
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
    // A shared pool worker revoked where it was enrolled loses every workspace it served
    // (ADR-030); its leases there are fenced exactly as here.
    const home =
      labels[SHARED_WORKER_LABEL] === "true" &&
      labels.enrollmentTokenId &&
      this.ctx.database.get(
        "SELECT 1 FROM server_tokens WHERE workspace_id=? AND id=?",
        this.ctx.workspaceId,
        labels.enrollmentTokenId,
      );
    if (home) {
      const controller = this.ctx.database.forWorkspace("*");
      inTx(controller, () => {
        for (const row of controller.all(
          "SELECT workspace_id FROM workers WHERE id=? AND workspace_id<>? AND state<>'revoked'",
          id,
          this.ctx.workspaceId,
        )) {
          const workspaceId = String(row.workspace_id);
          controller.run(
            "UPDATE workers SET state='revoked',version=version+1 WHERE workspace_id=? AND id=?",
            workspaceId,
            id,
          );
          const fenced = new LeaseRepository(controller).fenceWorker(
            workspaceId,
            id,
            this.now().toISOString(),
          );
          new OutboxRepository(controller).append(workspaceId, id, "worker.revoked", {
            workerId: id,
            fencedJobs: fenced.length,
          });
        }
      });
    }
    return requireEntity(this.ctx, "Worker", id);
  }

  /** Marks ready workers whose heartbeat stopped as offline and announces each loss once. */
  sweepOffline(): string[] {
    const cutoff = new Date(this.now().getTime() - WORKER_HEARTBEAT_TIMEOUT_MS).toISOString();
    return inTx(this.ctx.database, () => {
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
