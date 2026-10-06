import type { SQLInputValue } from "node:sqlite";
import { ContractError, type EntityPrefix, type Run, validate } from "@testmaster/contracts";
import { canonicalJson, semanticHash, uuidV7IdGenerator } from "@testmaster/domain";
import type { PersistenceDatabase } from "./database.js";
import { columnName, type EntityKind, immutableKinds, tableCatalog } from "./schema.js";

export interface Fence {
  workspaceId: string;
  jobId: string;
  owner: string;
  fence: number;
  attemptId: string;
}
export class StaleFenceError extends Error {
  constructor() {
    super("Lease owner, generation or deadline is stale");
  }
}
export interface PageCursor {
  createdAt: string;
  id: string;
  cutoff: string;
}
export interface EntityDocument {
  id: string;
  workspaceId: string;
  createdAt?: string;
  version?: number;
  [key: string]: unknown;
}
export class EntityRepository {
  constructor(readonly database: PersistenceDatabase) {}
  insert(
    kind: EntityKind,
    value: EntityDocument,
    relations: Record<string, SQLInputValue> = {},
  ): void {
    if (!this.database.db.isTransaction) {
      this.database.withTx(() => this.insert(kind, value, relations));
      return;
    }
    const { table, fields } = tableCatalog[kind];
    const wire: Record<string, unknown> = { ...value };
    if (kind === "StepResult") {
      delete wire.workspaceId;
      delete wire.createdAt;
      delete wire.version;
    }
    validate(kind, wire);
    const values: Record<string, SQLInputValue> = {
      workspace_id: value.workspaceId,
      id: value.id,
      created_at: value.createdAt ?? new Date().toISOString(),
      version: value.version ?? 1,
      data_json: canonicalJson(value),
    };
    for (const field of fields) {
      const raw = relations[field] ?? value[field] ?? null;
      values[columnName(field)] = typeof raw === "boolean" ? Number(raw) : (raw as SQLInputValue);
    }
    this.database.run(
      `INSERT INTO ${table} (${Object.keys(values).join(",")}) VALUES (${Object.keys(values)
        .map(() => "?")
        .join(",")})`,
      ...Object.values(values),
    );
    if (kind === "Artifact" && ["available", "partial"].includes(String(value.state))) {
      this.database.run(
        "INSERT INTO blob_reference_counts(workspace_id,storage_key,references_count,checked_at) VALUES(?,?,1,?) ON CONFLICT(workspace_id,storage_key) DO UPDATE SET references_count=references_count+1,checked_at=excluded.checked_at",
        value.workspaceId,
        value.storageKey,
        new Date().toISOString(),
      );
    }
  }
  /** Reads the constrained projection over the stored wire document after execution updates. */
  private decode<T extends EntityDocument>(kind: EntityKind, row: Record<string, unknown>): T {
    const value = JSON.parse(String(row.data_json)) as Record<string, unknown>;
    for (const field of tableCatalog[kind].fields) {
      const column = columnName(field);
      if (column in row && field in value)
        value[field] = field === "production" ? Boolean(row[column]) : row[column];
    }
    value.version = Number(row.version);
    value.createdAt = String(row.created_at);
    return value as T;
  }
  get<T extends EntityDocument = EntityDocument>(
    kind: EntityKind,
    workspaceId: string,
    id: string,
  ): T | null {
    const row = this.database.get(
      `SELECT * FROM ${tableCatalog[kind].table} WHERE workspace_id=? AND id=?`,
      workspaceId,
      id,
    );
    return row ? this.decode<T>(kind, row) : null;
  }
  page<T extends EntityDocument = EntityDocument>(
    kind: EntityKind,
    workspaceId: string,
    options: { limit?: number; cursor?: PageCursor; cutoff?: string } = {},
  ): { items: T[]; next: PageCursor | null } {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ContractError("INVALID_ARGUMENT", "Page size must be 1–100");
    const cutoff = options.cursor?.cutoff ?? options.cutoff ?? new Date().toISOString();
    const cursor = options.cursor;
    const rows = this.database.all(
      `SELECT * FROM ${tableCatalog[kind].table} WHERE workspace_id=? AND created_at<=? ${cursor ? "AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`,
      workspaceId,
      cutoff,
      ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []),
      limit + 1,
    );
    const more = rows.length > limit;
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return {
      items: selected.map((row) => this.decode<T>(kind, row)),
      next:
        more && last ? { createdAt: String(last.created_at), id: String(last.id), cutoff } : null,
    };
  }
  update(
    kind: EntityKind,
    workspaceId: string,
    id: string,
    expectedVersion: number,
    next: EntityDocument,
    relations: Record<string, SQLInputValue> = {},
  ): void {
    if (!this.database.db.isTransaction) {
      this.database.withTx(() =>
        this.update(kind, workspaceId, id, expectedVersion, next, relations),
      );
      return;
    }
    if (
      immutableKinds[kind] ||
      kind === "Run" ||
      kind === "Attempt" ||
      kind === "StepResult" ||
      kind === "Artifact" ||
      kind === "ResourceRecord" ||
      kind === "VariableValue"
    )
      throw new ContractError("POLICY_DENIED", "Entity requires immutable or fenced mutation");
    validate(kind, next);
    if (next.id !== id || next.workspaceId !== workspaceId)
      throw new ContractError("INVALID_ARGUMENT", "Identity cannot change");
    const fields = tableCatalog[kind].fields;
    const values = fields.map((field) => {
      const raw = relations[field] ?? next[field] ?? null;
      return typeof raw === "boolean" ? Number(raw) : (raw as SQLInputValue);
    });
    const result = this.database.run(
      `UPDATE ${tableCatalog[kind].table} SET ${fields.map((field) => `${columnName(field)}=?`).join(",")},data_json=?,version=version+1 WHERE workspace_id=? AND id=? AND version=?`,
      ...values,
      canonicalJson({ ...next, version: expectedVersion + 1 }),
      workspaceId,
      id,
      expectedVersion,
    );
    if (!result.changes) throw new ContractError("REVISION_CONFLICT", "Entity version changed");
  }
}
export class OutboxRepository {
  constructor(readonly database: PersistenceDatabase) {}
  append(
    workspaceId: string,
    aggregateId: string,
    type: string,
    payload: unknown,
  ): { id: string; seq: number } {
    if (!this.database.db.isTransaction)
      throw new Error("Outbox append requires a state transaction");
    const correlatedRun = this.database.get(
      "SELECT data_json FROM runs WHERE workspace_id=? AND id=? UNION SELECT r.data_json FROM runs r JOIN job_leases j ON j.workspace_id=r.workspace_id AND j.resource_id=r.id WHERE j.workspace_id=? AND j.id=? LIMIT 1",
      workspaceId,
      aggregateId,
      workspaceId,
      aggregateId,
    );
    const correlated = correlatedRun
      ? validate<Run>("Run", JSON.parse(String(correlatedRun.data_json)))
      : undefined;
    const cell = correlated?.matrixCell;
    const correlation =
      cell &&
      typeof cell === "object" &&
      !Array.isArray(cell) &&
      typeof cell.correlationId === "string"
        ? cell.correlationId
        : undefined;
    const correlatedPayload =
      correlation && payload && typeof payload === "object" && !Array.isArray(payload)
        ? { ...payload, correlationId: correlation }
        : payload;
    const seq = Number(
      this.database.get(
        "SELECT COALESCE(MAX(seq),-1)+1 AS seq FROM outbox WHERE workspace_id=? AND aggregate_id=?",
        workspaceId,
        aggregateId,
      )?.seq,
    );
    const id = uuidV7IdGenerator.next("evt");
    this.database.run(
      "INSERT INTO outbox(workspace_id,id,created_at,aggregate_id,seq,type,payload_ref,data_json) VALUES(?,?,?,?,?,?,?,?)",
      workspaceId,
      id,
      new Date().toISOString(),
      aggregateId,
      seq,
      type,
      id,
      canonicalJson(correlatedPayload),
    );
    return { id, seq };
  }
  pending(workspaceId: string, limit = 100): Record<string, unknown>[] {
    if (limit < 1 || limit > 100)
      throw new ContractError("INVALID_ARGUMENT", "Outbox limit must be 1–100");
    return this.database.all(
      "SELECT * FROM outbox WHERE workspace_id=? AND delivery_state='pending' AND dispatchable=1 ORDER BY created_at,id LIMIT ?",
      workspaceId,
      limit,
    );
  }
  delivered(workspaceId: string, id: string): void {
    this.database.withTx(() => {
      this.database.run(
        "UPDATE outbox SET delivery_state='delivered' WHERE workspace_id=? AND id=? AND dispatchable=1",
        workspaceId,
        id,
      );
    });
  }
}
export class IdempotencyRepository {
  constructor(readonly database: PersistenceDatabase) {}
  execute<T>(
    request: {
      workspaceId: string;
      actorScope: string;
      operation: string;
      key: string;
      body: unknown;
    },
    action: () => T,
  ): { replayed: boolean; receipt: T } {
    if (request.key.length < 16 || request.key.length > 128)
      throw new ContractError("INVALID_ARGUMENT", "Idempotency key must have 16–128 characters");
    const hash = semanticHash(request.body);
    return this.database.withTx(() => {
      const now = new Date().toISOString();
      const row = this.database.get(
        "SELECT request_hash,response_json,expires_at FROM idempotency_receipts WHERE workspace_id=? AND actor_scope=? AND operation=? AND key=?",
        request.workspaceId,
        request.actorScope,
        request.operation,
        request.key,
      );
      if (row && String(row.expires_at) > now) {
        if (row.request_hash !== hash)
          throw new ContractError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key has a different request body",
          );
        return { replayed: true, receipt: JSON.parse(String(row.response_json)) as T };
      }
      if (row)
        this.database.run(
          "DELETE FROM idempotency_receipts WHERE workspace_id=? AND actor_scope=? AND operation=? AND key=?",
          request.workspaceId,
          request.actorScope,
          request.operation,
          request.key,
        );
      const receipt = action();
      this.database.run(
        "INSERT INTO idempotency_receipts(workspace_id,id,created_at,actor_scope,operation,key,request_hash,response_json,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
        request.workspaceId,
        uuidV7IdGenerator.next("idr"),
        now,
        request.actorScope,
        request.operation,
        request.key,
        hash,
        canonicalJson(receipt),
        new Date(Date.parse(now) + 7 * 86400000).toISOString(),
      );
      return { replayed: false, receipt };
    });
  }
}
export class LeaseRepository {
  constructor(
    readonly database: PersistenceDatabase,
    readonly outbox = new OutboxRepository(database),
  ) {}
  enqueue(
    workspaceId: string,
    runId: string,
    queue: string,
    availableAt = new Date().toISOString(),
    priority = 0,
  ): string {
    if (!this.database.db.isTransaction) throw new Error("Enqueue requires admission transaction");
    const id = uuidV7IdGenerator.next("job");
    this.database.run(
      "INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,available_at,priority) VALUES(?,?,?,?,?,?,?)",
      workspaceId,
      id,
      new Date().toISOString(),
      queue,
      runId,
      availableAt,
      priority,
    );
    return id;
  }
  claim(request: {
    workspaceId: string;
    owner: string;
    queue: string;
    workerId?: string;
    leaseMs?: number;
    seed?: number;
    now?: string;
    runIds?: readonly string[];
  }): (Fence & { runId: string; expiresAt: string; number: number }) | null {
    const claim = () => {
      if (
        this.database.get("SELECT value FROM operational_state WHERE key='admission'")?.value !==
        "enabled"
      )
        return null;
      const now = request.now ?? new Date().toISOString();
      const expiresAt = new Date(Date.parse(now) + (request.leaseMs ?? 30000)).toISOString();
      if (request.runIds?.length === 0) return null;
      const runFilter = request.runIds
        ? ` AND j.resource_id IN (${request.runIds.map(() => "?").join(",")})`
        : "";
      const job = this.database.get(
        `SELECT j.* FROM job_leases j JOIN runs r ON r.workspace_id=j.workspace_id AND r.id=j.resource_id WHERE j.workspace_id=? AND j.queue=? AND j.dispatchable=1 AND j.state='queued' AND j.available_at<=? AND r.phase<>'completed'${runFilter} ORDER BY j.priority DESC,j.available_at,j.id LIMIT 1`,
        request.workspaceId,
        request.queue,
        now,
        ...(request.runIds ?? []),
      );
      if (!job) return null;
      const fence = Number(job.fence) + 1;
      const number = Number(job.attempts) + 1;
      const attemptId = uuidV7IdGenerator.next("att");
      const jobId = String(job.id);
      const runId = String(job.resource_id);
      this.database.run(
        "UPDATE job_leases SET state='leased',lease_owner=?,lease_expires_at=?,fence=?,attempts=? WHERE workspace_id=? AND id=? AND state='queued'",
        request.owner,
        expiresAt,
        fence,
        number,
        request.workspaceId,
        jobId,
      );
      const document = {
        id: attemptId,
        workspaceId: request.workspaceId,
        runId,
        number,
        workerId: request.workerId ?? null,
        seed: request.seed ?? 0,
        phase: "preparing",
        startedAt: now,
        endedAt: null,
        outcome: null,
      };
      new EntityRepository(this.database).insert("Attempt", document, {
        jobId,
        fence,
        leaseOwner: request.owner,
      });
      this.outbox.append(request.workspaceId, runId, "attempt.claimed", { attemptId, number });
      return {
        workspaceId: request.workspaceId,
        jobId,
        owner: request.owner,
        fence,
        attemptId,
        runId,
        expiresAt,
        number,
      };
    };
    return this.database.db.isTransaction ? claim() : this.database.withTx(claim);
  }
  assertCurrent(fence: Fence, now = new Date().toISOString()): void {
    const current = this.database.get(
      "SELECT 1 AS valid FROM job_leases j JOIN attempts a ON a.workspace_id=j.workspace_id AND a.job_id=j.id AND a.fence=j.fence WHERE j.workspace_id=? AND j.id=? AND j.lease_owner=? AND j.fence=? AND j.state='leased' AND j.dispatchable=1 AND j.lease_expires_at>? AND a.id=?",
      fence.workspaceId,
      fence.jobId,
      fence.owner,
      fence.fence,
      now,
      fence.attemptId,
    );
    if (!current) throw new StaleFenceError();
  }
  heartbeat(fence: Fence, leaseMs = 30000, now = new Date().toISOString()): string {
    return this.database.withTx(() => {
      this.assertCurrent(fence, now);
      const expires = new Date(Date.parse(now) + leaseMs).toISOString();
      this.database.run(
        "UPDATE job_leases SET lease_expires_at=? WHERE workspace_id=? AND id=?",
        expires,
        fence.workspaceId,
        fence.jobId,
      );
      return expires;
    });
  }
  release(fence: Fence, retry: boolean, now = new Date().toISOString()): void {
    this.database.withTx(() => {
      this.assertCurrent(fence, now);
      this.database.run(
        "UPDATE job_leases SET state=?,lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=? AND id=?",
        retry ? "queued" : "completed",
        fence.workspaceId,
        fence.jobId,
      );
      this.database.run(
        "UPDATE attempts SET phase='completed',outcome='inconclusive',ended_at=? WHERE workspace_id=? AND id=?",
        now,
        fence.workspaceId,
        fence.attemptId,
      );
      this.outbox.append(fence.workspaceId, fence.jobId, "lease.released", { retry });
    });
  }
  expire(now = new Date().toISOString()): string[] {
    return this.database.withTx(() => {
      const expired = this.database.all(
        `SELECT workspace_id,id,fence,resource_id FROM job_leases WHERE state='leased' AND lease_expires_at<=? AND queue NOT IN (${auxiliaryQueueSql})`,
        now,
      );
      for (const row of expired) {
        this.database.run(
          "UPDATE job_leases SET state='reconciliation_required',lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=? AND id=? AND fence=?",
          row.workspace_id,
          row.id,
          row.fence,
        );
        this.database.run(
          "UPDATE attempts SET phase='completed',outcome='inconclusive',ended_at=? WHERE workspace_id=? AND job_id=? AND fence=?",
          now,
          row.workspace_id,
          row.id,
          row.fence,
        );
        this.outbox.append(
          String(row.workspace_id),
          String(row.resource_id),
          "attempt.lease_expired",
          { jobId: row.id, reasonCode: "worker_lost" },
        );
      }
      return expired.map((row) => String(row.id));
    });
  }
  resume(workspaceId: string, jobId: string, expectedFence: number): void {
    this.database.withTx(() => {
      const changed = this.database.run(
        `UPDATE job_leases SET state='queued',dispatchable=1 WHERE workspace_id=? AND id=? AND fence=? AND state='reconciliation_required' AND queue NOT IN (${auxiliaryQueueSql})`,
        workspaceId,
        jobId,
        expectedFence,
      );
      if (!changed.changes) throw new StaleFenceError();
    });
  }
}
export const auxiliaryQueues = ["analysis", "healing", "delivery"] as const;
export type AuxiliaryQueue = (typeof auxiliaryQueues)[number];
const auxiliaryQueueSql = auxiliaryQueues.map((queue) => `'${queue}'`).join(",");
/** Validated, authorization-relevant job input; the actor is rechecked before dispatch. */
export interface AuxiliaryPayload {
  operation: string;
  targetId: string;
  actorId: string;
  evidenceHash: string;
  configHash: string;
  options: Record<string, unknown>;
}
export interface AuxiliaryJob {
  workspaceId: string;
  jobId: string;
  queue: AuxiliaryQueue;
  resourceId: string;
  state: "queued" | "leased" | "completed" | "cancelled" | "reconciliation_required";
  fence: number;
  attempts: number;
  availableAt: string;
  payload: AuxiliaryPayload;
  /** Durable progress markers (for example, a paid model call that has started). */
  progress: Record<string, unknown>;
  result: Record<string, unknown> | null;
}
export interface AuxiliaryFence {
  workspaceId: string;
  jobId: string;
  owner: string;
  fence: number;
}
/**
 * Non-run work (diagnosis, healing, check delivery) over `job_leases`. Never joins Runs, never
 * creates Attempts and never reopens terminal state. A lease lost after a paid call started is
 * settled, not requeued, so recovery cannot silently reissue the call.
 */
export class AuxiliaryLeaseRepository {
  constructor(readonly database: PersistenceDatabase) {}
  static resourceId(queue: AuxiliaryQueue, payload: AuxiliaryPayload): string {
    return semanticHash({
      queue,
      targetId: payload.targetId,
      evidenceHash: payload.evidenceHash,
      operation: payload.operation,
      configHash: payload.configHash,
    });
  }
  private validate(queue: string, payload: AuxiliaryPayload): asserts queue is AuxiliaryQueue {
    if (!(auxiliaryQueues as readonly string[]).includes(queue))
      throw new ContractError("INVALID_ARGUMENT", "Queue is not an auxiliary queue", { queue });
    const text = (value: unknown, max = 200) =>
      typeof value === "string" && value.length > 0 && value.length <= max;
    if (
      !payload ||
      !text(payload.operation) ||
      !text(payload.targetId) ||
      !text(payload.actorId) ||
      !/^[0-9a-f]{64}$/.test(String(payload.evidenceHash)) ||
      !/^[0-9a-f]{64}$/.test(String(payload.configHash)) ||
      !payload.options ||
      typeof payload.options !== "object" ||
      Array.isArray(payload.options) ||
      Object.keys(payload).some(
        (key) =>
          !["operation", "targetId", "actorId", "evidenceHash", "configHash", "options"].includes(
            key,
          ),
      )
    )
      throw new ContractError("INVALID_ARGUMENT", "Auxiliary job payload is invalid", { queue });
  }
  private decode(row: Record<string, unknown>): AuxiliaryJob {
    const data = JSON.parse(String(row.data_json)) as {
      payload: AuxiliaryPayload;
      progress?: Record<string, unknown>;
      result?: Record<string, unknown> | null;
    };
    return {
      workspaceId: String(row.workspace_id),
      jobId: String(row.id),
      queue: String(row.queue) as AuxiliaryQueue,
      resourceId: String(row.resource_id),
      state: String(row.state) as AuxiliaryJob["state"],
      fence: Number(row.fence),
      attempts: Number(row.attempts),
      availableAt: String(row.available_at),
      payload: data.payload,
      progress: data.progress ?? {},
      result: data.result ?? null,
    };
  }
  /** Idempotent by semantic resource identity; an identical request returns the stored job. */
  enqueue(
    workspaceId: string,
    queue: AuxiliaryQueue,
    payload: AuxiliaryPayload,
    availableAt = new Date().toISOString(),
  ): { job: AuxiliaryJob; created: boolean } {
    this.validate(queue, payload);
    const resourceId = AuxiliaryLeaseRepository.resourceId(queue, payload);
    const run = () => {
      const existing = this.find(workspaceId, queue, resourceId);
      if (existing) return { job: existing, created: false };
      const id = uuidV7IdGenerator.next("job");
      this.database.run(
        "INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,available_at,priority,data_json) VALUES(?,?,?,?,?,?,0,?)",
        workspaceId,
        id,
        new Date().toISOString(),
        queue,
        resourceId,
        availableAt,
        canonicalJson({ payload, progress: {}, result: null }),
      );
      return { job: this.get(workspaceId, id) as AuxiliaryJob, created: true };
    };
    return this.database.db.isTransaction ? run() : this.database.withTx(run);
  }
  get(workspaceId: string, jobId: string): AuxiliaryJob | null {
    const row = this.database.get(
      `SELECT * FROM job_leases WHERE workspace_id=? AND id=? AND queue IN (${auxiliaryQueueSql})`,
      workspaceId,
      jobId,
    );
    return row ? this.decode(row) : null;
  }
  find(workspaceId: string, queue: AuxiliaryQueue, resourceId: string): AuxiliaryJob | null {
    const row = this.database.get(
      "SELECT * FROM job_leases WHERE workspace_id=? AND queue=? AND resource_id=?",
      workspaceId,
      queue,
      resourceId,
    );
    return row ? this.decode(row) : null;
  }
  /** Jobs of one queue whose payload targets `targetId`, newest first. */
  forTarget(workspaceId: string, queue: AuxiliaryQueue, targetId: string): AuxiliaryJob[] {
    return this.database
      .all(
        "SELECT * FROM job_leases WHERE workspace_id=? AND queue=? AND json_extract(data_json,'$.payload.targetId')=? ORDER BY created_at DESC,id DESC",
        workspaceId,
        queue,
        targetId,
      )
      .map((row) => this.decode(row));
  }
  claim(request: {
    workspaceId: string;
    owner: string;
    queue: AuxiliaryQueue;
    jobId?: string;
    leaseMs?: number;
    now?: string;
  }): (AuxiliaryFence & { job: AuxiliaryJob }) | null {
    if (!(auxiliaryQueues as readonly string[]).includes(request.queue))
      throw new ContractError("INVALID_ARGUMENT", "Queue is not an auxiliary queue");
    return this.database.withTx(() => {
      const now = request.now ?? new Date().toISOString();
      const row = this.database.get(
        `SELECT * FROM job_leases WHERE workspace_id=? AND queue=? AND state='queued' AND dispatchable=1 AND available_at<=?${request.jobId ? " AND id=?" : ""} ORDER BY priority DESC,available_at,id LIMIT 1`,
        request.workspaceId,
        request.queue,
        now,
        ...(request.jobId ? [request.jobId] : []),
      );
      if (!row) return null;
      const fence = Number(row.fence) + 1;
      const changed = this.database.run(
        "UPDATE job_leases SET state='leased',lease_owner=?,lease_expires_at=?,fence=?,attempts=attempts+1 WHERE workspace_id=? AND id=? AND state='queued' AND fence=?",
        request.owner,
        new Date(Date.parse(now) + (request.leaseMs ?? 60000)).toISOString(),
        fence,
        request.workspaceId,
        row.id,
        row.fence,
      );
      if (!changed.changes) return null;
      const job = this.get(request.workspaceId, String(row.id)) as AuxiliaryJob;
      return {
        workspaceId: request.workspaceId,
        jobId: job.jobId,
        owner: request.owner,
        fence,
        job,
      };
    });
  }
  private assertCurrent(fence: AuxiliaryFence, now = new Date().toISOString()): AuxiliaryJob {
    const row = this.database.get(
      `SELECT * FROM job_leases WHERE workspace_id=? AND id=? AND lease_owner=? AND fence=? AND state='leased' AND lease_expires_at>? AND queue IN (${auxiliaryQueueSql})`,
      fence.workspaceId,
      fence.jobId,
      fence.owner,
      fence.fence,
      now,
    );
    if (!row) throw new StaleFenceError();
    return this.decode(row);
  }
  heartbeat(fence: AuxiliaryFence, leaseMs = 60000, now = new Date().toISOString()): string {
    return this.database.withTx(() => {
      this.assertCurrent(fence, now);
      const expires = new Date(Date.parse(now) + leaseMs).toISOString();
      this.database.run(
        "UPDATE job_leases SET lease_expires_at=? WHERE workspace_id=? AND id=? AND fence=?",
        expires,
        fence.workspaceId,
        fence.jobId,
        fence.fence,
      );
      return expires;
    });
  }
  /** Durably records progress before an irreversible effect (for example a paid model call). */
  mark(fence: AuxiliaryFence, progress: Record<string, unknown>): void {
    const apply = () => {
      const job = this.assertCurrent(fence);
      this.database.run(
        "UPDATE job_leases SET data_json=? WHERE workspace_id=? AND id=? AND fence=?",
        canonicalJson({ payload: job.payload, progress: { ...job.progress, ...progress }, result: null }),
        fence.workspaceId,
        fence.jobId,
        fence.fence,
      );
    };
    if (this.database.db.isTransaction) apply();
    else this.database.withTx(apply);
  }
  finish(
    fence: AuxiliaryFence,
    state: "completed" | "cancelled",
    result: Record<string, unknown>,
  ): void {
    const apply = () => {
      const job = this.assertCurrent(fence);
      this.database.run(
        "UPDATE job_leases SET state=?,lease_owner=NULL,lease_expires_at=NULL,data_json=? WHERE workspace_id=? AND id=? AND fence=?",
        state,
        canonicalJson({ payload: job.payload, progress: job.progress, result }),
        fence.workspaceId,
        fence.jobId,
        fence.fence,
      );
    };
    if (this.database.db.isTransaction) apply();
    else this.database.withTx(apply);
  }
  /** Retries deterministic work only; a job whose paid effect started stays settled-required. */
  release(fence: AuxiliaryFence, retryAt: string): void {
    this.database.withTx(() => {
      const job = this.assertCurrent(fence);
      if (job.progress.paidCallStarted)
        throw new ContractError("PRECONDITION_FAILED", "Paid call outcome must be settled");
      this.database.run(
        "UPDATE job_leases SET state='queued',lease_owner=NULL,lease_expires_at=NULL,available_at=? WHERE workspace_id=? AND id=? AND fence=?",
        retryAt,
        fence.workspaceId,
        fence.jobId,
        fence.fence,
      );
    });
  }
  /**
   * Expired auxiliary leases: deterministic work returns to the queue; work that had started a
   * paid call moves to `reconciliation_required` and must be settled without a new call.
   */
  expire(now = new Date().toISOString()): { requeued: string[]; settlementRequired: string[] } {
    return this.database.withTx(() => {
      const requeued: string[] = [];
      const settlementRequired: string[] = [];
      for (const row of this.database.all(
        `SELECT * FROM job_leases WHERE state='leased' AND lease_expires_at<=? AND queue IN (${auxiliaryQueueSql})`,
        now,
      )) {
        const job = this.decode(row);
        const paid = Boolean(job.progress.paidCallStarted);
        this.database.run(
          "UPDATE job_leases SET state=?,lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=? AND id=? AND fence=?",
          paid ? "reconciliation_required" : "queued",
          job.workspaceId,
          job.jobId,
          job.fence,
        );
        (paid ? settlementRequired : requeued).push(job.jobId);
      }
      return { requeued, settlementRequired };
    });
  }
  /** Settles a `reconciliation_required` job with a recorded result; never reissues the call. */
  settle(workspaceId: string, jobId: string, result: Record<string, unknown>): AuxiliaryJob {
    return this.database.withTx(() => {
      const job = this.get(workspaceId, jobId);
      if (!job || job.state !== "reconciliation_required")
        throw new ContractError("PRECONDITION_FAILED", "Job does not require settlement");
      this.database.run(
        "UPDATE job_leases SET state='completed',data_json=? WHERE workspace_id=? AND id=? AND state='reconciliation_required'",
        canonicalJson({ payload: job.payload, progress: job.progress, result }),
        workspaceId,
        jobId,
      );
      return this.get(workspaceId, jobId) as AuxiliaryJob;
    });
  }
}
export class ExecutionRepository {
  readonly leases: LeaseRepository;
  readonly outbox: OutboxRepository;
  constructor(readonly database: PersistenceDatabase) {
    this.outbox = new OutboxRepository(database);
    this.leases = new LeaseRepository(database, this.outbox);
  }
  progress(fence: Fence, phase: "preparing" | "running" | "collecting" | "analyzing"): void {
    this.database.withTx(() => {
      this.leases.assertCurrent(fence);
      const attempt = this.database.get(
        "SELECT run_id FROM attempts WHERE workspace_id=? AND id=?",
        fence.workspaceId,
        fence.attemptId,
      );
      if (!attempt) throw new StaleFenceError();
      this.database.run(
        "UPDATE attempts SET phase=? WHERE workspace_id=? AND id=? AND phase<>'completed'",
        phase,
        fence.workspaceId,
        fence.attemptId,
      );
      this.database.run(
        "UPDATE runs SET phase=?,status=? WHERE workspace_id=? AND id=? AND phase<>'completed' AND instr('queued preparing running collecting analyzing completed',phase)<=instr('queued preparing running collecting analyzing completed',?)",
        phase,
        phase,
        fence.workspaceId,
        attempt.run_id,
        phase,
      );
      this.outbox.append(fence.workspaceId, String(attempt.run_id), "run.phase_changed", {
        phase,
        attemptId: fence.attemptId,
      });
    });
  }
  observe(fence: Fence, event: { id: string; seq: number; payload: unknown }): boolean {
    return this.database.withTx(() => {
      this.leases.assertCurrent(fence);
      const previous = this.database.get(
        "SELECT data_json FROM observations WHERE workspace_id=? AND event_id=?",
        fence.workspaceId,
        event.id,
      );
      if (previous) {
        if (String(previous.data_json) !== canonicalJson(event.payload))
          throw new ContractError("IDEMPOTENCY_CONFLICT", "Observation event ID changed content");
        return false;
      }
      this.database.run(
        "INSERT INTO observations(workspace_id,id,created_at,attempt_id,event_id,seq,fence,data_json) VALUES(?,?,?,?,?,?,?,?)",
        fence.workspaceId,
        event.id,
        new Date().toISOString(),
        fence.attemptId,
        event.id,
        event.seq,
        fence.fence,
        canonicalJson(event.payload),
      );
      return true;
    });
  }
  publish(
    fence: Fence,
    kind: "StepResult" | "ResourceRecord" | "VariableValue" | "Artifact" | "Snapshot",
    value: EntityDocument,
  ): void {
    const publish = () => {
      this.leases.assertCurrent(fence);
      if (value.workspaceId !== fence.workspaceId) throw new StaleFenceError();
      const attempt = this.database.get(
        "SELECT run_id FROM attempts WHERE workspace_id=? AND id=?",
        fence.workspaceId,
        fence.attemptId,
      );
      if (!attempt) throw new StaleFenceError();
      if (
        ("attemptId" in value && value.attemptId !== fence.attemptId) ||
        ("creatorAttemptId" in value && value.creatorAttemptId !== fence.attemptId) ||
        ("producerRunId" in value && value.producerRunId !== attempt.run_id)
      )
        throw new StaleFenceError();
      new EntityRepository(this.database).insert(kind, value);
    };
    if (this.database.db.isTransaction) publish();
    else this.database.withTx(publish);
  }
  finalize(fence: Fence, next: EntityDocument): boolean {
    return this.database.withTx(() => {
      this.leases.assertCurrent(fence);
      validate("Run", next);
      if (next.phase !== "completed" || next.workspaceId !== fence.workspaceId)
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Finalization requires a completed matching Run",
        );
      const attempt = this.database.get(
        "SELECT run_id FROM attempts WHERE workspace_id=? AND id=?",
        fence.workspaceId,
        fence.attemptId,
      );
      if (attempt?.run_id !== next.id) throw new StaleFenceError();
      const changed = this.database.run(
        "UPDATE runs SET phase='completed',outcome=?,status=?,gate=?,cleanup_outcome=?,analysis_status=?,data_json=?,version=version+1 WHERE workspace_id=? AND id=? AND phase<>'completed'",
        next.outcome,
        next.status,
        next.gate,
        next.cleanupOutcome,
        next.analysisStatus,
        canonicalJson(next),
        fence.workspaceId,
        next.id,
      );
      if (!changed.changes) return false;
      this.database.run(
        "UPDATE attempts SET phase='completed',outcome=?,ended_at=? WHERE workspace_id=? AND id=?",
        next.outcome,
        new Date().toISOString(),
        fence.workspaceId,
        fence.attemptId,
      );
      this.database.run(
        "UPDATE job_leases SET state='completed',lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=? AND id=?",
        fence.workspaceId,
        fence.jobId,
      );
      this.outbox.append(fence.workspaceId, next.id, "run.completed", next);
      return true;
    });
  }
}
export class AuditRepository {
  constructor(readonly database: PersistenceDatabase) {}
  append(value: Omit<EntityDocument, "id"> & { workspaceId: string }): string {
    const id = uuidV7IdGenerator.next("aud" as EntityPrefix);
    const document = { ...value, id };
    if (this.database.db.isTransaction)
      new EntityRepository(this.database).insert("AuditEvent", document);
    else
      this.database.withTx(() =>
        new EntityRepository(this.database).insert("AuditEvent", document),
      );
    return id;
  }
}
