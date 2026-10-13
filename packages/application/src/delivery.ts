import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ContractError, type Delivery, validate } from "@testmaster/contracts";
import { canonicalJson, semanticHash } from "@testmaster/domain";
import {
  AuxiliaryLeaseRepository,
  type EntityDocument,
  OutboxRepository,
} from "@testmaster/persistence";
import { auditSecurity } from "./audit.js";
import type { CiResult } from "./ci.js";
import { allEntities, entity, requireEntity, type ServiceContext } from "./context.js";

export const checkNames = ["TestMaster / result", "TestMaster / required-gate"] as const;
export type CheckName = (typeof checkNames)[number];
export function checkConclusion(
  result: CiResult,
  name: CheckName,
): "success" | "failure" | "neutral" | "cancelled" | null {
  if (result.gate === "pending") return name === "TestMaster / result" ? null : "failure";
  if (
    result.kind === "batch" &&
    result.gate === "passed" &&
    result.provenance.binding === "verified" &&
    (result.provenance.targetBinding === "local-checkout" ||
      result.provenance.targetBinding === "github-deployment")
  )
    return "success";
  if (name === "TestMaster / required-gate") return "failure";
  if (
    result.kind === "empty" &&
    result.gate === "not_applicable" &&
    result.selection.emptyReason?.trim()
  )
    return "neutral";
  if (result.counts && result.counts.cancelled > 0) return "cancelled";
  return "failure";
}
export function validatePublication(result: CiResult, repository: string, sha: string): void {
  validate("CiResult", result);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[0-9a-f]{40}$/.test(sha))
    throw new ContractError("INVALID_ARGUMENT", "Repository or publication SHA is invalid");
  if (result.provenance.assessedSha !== sha)
    throw new ContractError("POLICY_DENIED", "Publication SHA does not match frozen assessed SHA");
  if (!result.reportHash)
    throw new ContractError("PRECONDITION_FAILED", "Publication requires a captured report hash");
}
export interface CheckPayload {
  name: CheckName;
  head_sha: string;
  external_id: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral" | "cancelled" | "action_required";
  output: { title: string; summary: string };
  /** Authenticated portal page for this result (OPS-037); never a signed or public link. */
  details_url?: string;
}
function payload(result: CiResult, sha: string, name: CheckName): CheckPayload {
  const conclusion = checkConclusion(result, name);
  return {
    name,
    head_sha: sha,
    external_id: semanticHash({ sha, reportHash: result.reportHash, name }),
    status: conclusion === null ? "in_progress" : "completed",
    ...(conclusion === null ? {} : { conclusion }),
    output: {
      title: `TestMaster gate: ${result.gate}`,
      summary: `Gate: ${result.gate}\nBinding: ${result.provenance.binding}\nReport hash: ${result.reportHash}\nRequested tests: ${result.selection.requested}\nPassed: ${result.counts?.passed ?? 0}; failed: ${result.counts?.failed ?? 0}; blocked: ${result.counts?.blocked ?? 0}; cancelled: ${result.counts?.cancelled ?? 0}; inconclusive: ${result.counts?.inconclusive ?? 0}.`,
    },
  };
}
export class CheckHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
    /** 429, or 403 with an exhausted primary/secondary rate limit; distinguishes throttling from a revoked permission. */
    readonly rateLimited: boolean = status === 429,
  ) {
    super(`GitHub Checks HTTP ${status}`);
  }
}
/** Retry policy of one delivery cycle (OPS-011): exponential equal-jitter backoff, bounded by 10 attempts or 24 h. */
export const deliveryRetryPolicy = {
  baseMs: 1000,
  maxMs: 300_000,
  maxAttempts: 10,
  windowMs: 86_400_000,
} as const;
/** attempt = failed delivery attempts so far (1-based). Equal jitter: result in [ceiling/2, ceiling]; random() returns [0,1]. */
export function deliveryBackoffMs(attempt: number, random: () => number = Math.random): number {
  if (!Number.isInteger(attempt) || attempt < 1)
    throw new ContractError("INVALID_ARGUMENT", "Delivery attempt must be a positive integer");
  const ceiling = Math.min(
    deliveryRetryPolicy.maxMs,
    deliveryRetryPolicy.baseMs * 2 ** (attempt - 1),
  );
  return Math.round(ceiling * (0.5 + random() / 2));
}
export interface ChecksClientOptions {
  apiUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source for the delivery-level reschedule; defaults to Math.random. */
  random?: () => number;
}
export class ChecksClient {
  private readonly apiUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(
    readonly token: string,
    options: ChecksClientOptions = {},
  ) {
    if (!token)
      throw new ContractError("UNAUTHENTICATED", "A minimal GitHub Checks token is required");
    this.apiUrl = options.apiUrl ?? "https://api.github.com";
    this.sleep = options.sleep ?? delay;
  }
  async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const backoff = method === "POST" ? [] : [1000, 5000, 30000];
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(`${this.apiUrl}${path}`, {
          method,
          redirect: "error",
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30000),
        });
      } catch (error) {
        if (attempt >= backoff.length) throw error;
        await this.sleep(backoff[attempt]!);
        continue;
      }
      if (response.ok) return response.status === 204 ? null : response.json();
      const retryHeader = response.headers.get("retry-after");
      const seconds = retryHeader === null ? NaN : Number(retryHeader);
      const parsedDate = retryHeader === null ? NaN : Date.parse(retryHeader);
      const retryMs = Number.isFinite(seconds)
        ? seconds * 1000
        : Number.isFinite(parsedDate)
          ? parsedDate - Date.now()
          : null;
      const bounded = retryMs === null ? null : Math.max(0, Math.min(30000, retryMs));
      await response.body?.cancel();
      if ((response.status === 429 || response.status >= 500) && attempt < backoff.length) {
        await this.sleep(Math.max(backoff[attempt]!, bounded ?? 0));
        continue;
      }
      throw new CheckHttpError(
        response.status,
        bounded,
        response.status === 429 ||
          (response.status === 403 &&
            (response.headers.get("x-ratelimit-remaining") === "0" || retryHeader !== null)),
      );
    }
  }
  async publish(
    repository: string,
    input: CheckPayload,
    _remoteId?: string | null,
  ): Promise<string> {
    const backoff = [1000, 5000, 30000];
    for (let attempt = 0; ; attempt++) {
      // Reconcile before EVERY create, including after a lost response or retryable POST.
      let existing: string | null = null;
      for (let page = 1; ; page++) {
        const response = await this.request(
          `/repos/${repository}/commits/${input.head_sha}/check-runs?check_name=${encodeURIComponent(input.name)}&filter=all&per_page=100&page=${page}`,
        );
        if (
          !response ||
          typeof response !== "object" ||
          !("check_runs" in response) ||
          !Array.isArray(response.check_runs)
        )
          throw new ContractError("UNAVAILABLE", "GitHub check list is invalid");
        for (const item of response.check_runs) {
          if (
            item &&
            typeof item === "object" &&
            "external_id" in item &&
            "head_sha" in item &&
            "name" in item &&
            "id" in item &&
            item.external_id === input.external_id &&
            item.head_sha === input.head_sha &&
            item.name === input.name &&
            (typeof item.id === "number" || typeof item.id === "string")
          )
            existing = String(item.id);
        }
        if (existing || response.check_runs.length < 100) break;
        if (page >= 100)
          throw new ContractError(
            "PRECONDITION_FAILED",
            "Check reconciliation exceeded bounded inventory",
          );
      }
      try {
        const response = await this.request(
          `/repos/${repository}/check-runs${existing ? `/${existing}` : ""}`,
          existing ? "PATCH" : "POST",
          input,
        );
        if (
          !response ||
          typeof response !== "object" ||
          !("id" in response) ||
          (typeof response.id !== "number" && typeof response.id !== "string")
        )
          throw new ContractError("UNAVAILABLE", "GitHub check response is invalid");
        return String(response.id);
      } catch (error) {
        if (
          existing ||
          attempt >= backoff.length ||
          error instanceof ContractError ||
          (error instanceof CheckHttpError && error.status !== 429 && error.status < 500)
        )
          throw error;
        await this.sleep(
          Math.max(
            backoff[attempt]!,
            error instanceof CheckHttpError ? (error.retryAfterMs ?? 0) : 0,
          ),
        );
      }
    }
  }
}
export class DeliveryService {
  constructor(readonly ctx: ServiceContext) {}
  async publish(
    result: CiResult,
    repository: string,
    sha: string,
    token: string,
    options: ChecksClientOptions = {},
  ): Promise<Delivery[]> {
    this.ctx.authorize("W");
    validatePublication(result, repository, sha);
    const client = new ChecksClient(token, options);
    const deliveries: Delivery[] = [];
    for (const name of checkNames) {
      const body = payload(result, sha, name);
      const hash = semanticHash(body);
      let row = this.ctx.database.withTx(() => {
        const existing = allEntities(this.ctx, "Delivery").find(
          (item) =>
            item.destinationRef === repository &&
            item.subjectSha === sha &&
            item.reportHash === result.reportHash &&
            item.checkName === name,
        );
        if (existing) {
          if (existing.payloadHash !== hash)
            throw new ContractError("REVISION_CONFLICT", "Frozen delivery payload differs");
          return existing;
        }
        const event = new OutboxRepository(this.ctx.database).append(
          this.ctx.workspaceId,
          result.batchId ?? this.ctx.workspaceId,
          "delivery.requested",
          { repository, sha, reportHash: result.reportHash, checkName: name, payloadHash: hash },
        );
        // Publisher uses a clean database, so an imported batch ID must not forge a foreign key.
        const batchId =
          result.batchId && this.ctx.entities.get("BatchRun", this.ctx.workspaceId, result.batchId)
            ? result.batchId
            : null;
        const value = entity(this.ctx, "dlv", {
          eventId: event.id,
          destinationRef: repository,
          payloadHash: hash,
          reportHash: result.reportHash,
          batchId,
          checkName: name,
          subjectSha: sha,
          attempts: 0,
          nextAttemptAt: null,
          state: "pending",
          checkStatus: body.status,
          conclusion: body.conclusion ?? null,
          externalId: null,
          lastError: null,
        });
        this.ctx.entities.insert("Delivery", value);
        this.ctx.database.run(
          "INSERT INTO operational_state(key,value) VALUES(?,?)",
          `delivery:payload:${this.ctx.workspaceId}:${value.id}`,
          canonicalJson(body),
        );
        this.ctx.database.run(
          "INSERT INTO operational_state(key,value) VALUES(?,?)",
          this.windowKey(value.id),
          value.createdAt as string,
        );
        new AuxiliaryLeaseRepository(this.ctx.database).enqueue(this.ctx.workspaceId, "delivery", {
          targetId: value.id,
          actorId: this.ctx.principalId,
          operation: "github.check",
          evidenceHash: result.reportHash!,
          configHash: semanticHash({ repository, sha, name }),
          options: { repository, sha, payloadHash: hash },
        });
        return value;
      });
      if (row.state !== "pending") {
        deliveries.push(validate<Delivery>("Delivery", row));
        continue;
      }
      const leases = new AuxiliaryLeaseRepository(this.ctx.database);
      leases.expire();
      const job = leases.forTarget(this.ctx.workspaceId, "delivery", row.id)[0];
      const fence = job
        ? leases.claim({
            workspaceId: this.ctx.workspaceId,
            queue: "delivery",
            owner: `delivery-${randomUUID()}`,
            jobId: job.jobId,
            leaseMs: 900000,
          })
        : null;
      if (!fence) {
        deliveries.push(validate<Delivery>("Delivery", row));
        continue;
      }
      try {
        if (fence.job.payload.actorId !== this.ctx.principalId)
          throw new ContractError("FORBIDDEN", "Delivery actor differs");
        this.ctx.authorize("W");
        const remoteId = await client.publish(
          repository,
          body,
          typeof row.externalId === "string" ? row.externalId : null,
        );
        row = this.update(row, {
          externalId: remoteId,
          state: "delivered",
          attempts: Number(row.attempts) + 1,
          lastError: null,
          nextAttemptAt: null,
        });
        leases.finish(fence, "completed", { deliveryId: row.id, remoteId });
      } catch (error) {
        const authDenied = error instanceof CheckHttpError && [401, 403].includes(error.status);
        const attempts = Number(row.attempts) + 1;
        const exhausted =
          attempts >= deliveryRetryPolicy.maxAttempts ||
          Date.now() >= Date.parse(this.windowStart(row)) + deliveryRetryPolicy.windowMs;
        const dead = authDenied || exhausted;
        const retryMs = Math.max(
          deliveryBackoffMs(attempts, options.random ?? Math.random),
          error instanceof CheckHttpError ? (error.retryAfterMs ?? 0) : 0,
        );
        const retryAt = new Date(Date.now() + retryMs).toISOString();
        row = this.update(row, {
          attempts,
          state: dead ? "dead_letter" : "pending",
          lastError: error instanceof CheckHttpError ? error.message : "Check publication failed",
          nextAttemptAt: dead ? null : retryAt,
        });
        if (dead)
          leases.finish(fence, "completed", {
            deliveryId: row.id,
            state: "dead_letter",
            reason: authDenied ? "authorization_refused" : "attempts_exhausted",
          });
        else leases.release(fence, retryAt);
      }
      deliveries.push(validate<Delivery>("Delivery", row));
    }
    return deliveries;
  }
  /** Read-only inventory of deliveries, optionally filtered by state (dead letters included). */
  list(filter: { state?: Delivery["state"] } = {}): Delivery[] {
    this.ctx.authorize("R");
    return allEntities(this.ctx, "Delivery")
      .filter((item) => !filter.state || item.state === filter.state)
      .map((item) => validate<Delivery>("Delivery", item));
  }
  /**
   * Reopens one dead-lettered delivery for a new retry cycle. Needs write authority, is audited
   * and only re-arms the delivery job: the local Run and its verdict are never touched.
   */
  requeue(id: string): Delivery {
    this.ctx.authorize("W");
    return this.ctx.database.withTx(() => {
      const row = requireEntity(this.ctx, "Delivery", id);
      if (row.state !== "dead_letter")
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Only dead-lettered deliveries can be requeued",
        );
      auditSecurity(this.ctx, "delivery.requeue", id, "requested");
      const leases = new AuxiliaryLeaseRepository(this.ctx.database);
      const job = leases.forTarget(this.ctx.workspaceId, "delivery", id)[0];
      if (!job) throw new ContractError("PRECONDITION_FAILED", "Delivery job is missing");
      const now = new Date().toISOString();
      leases.requeueDeadLetter(this.ctx.workspaceId, job.jobId, now);
      this.ctx.database.run(
        "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        this.windowKey(id),
        now,
      );
      const next = this.update(row, { state: "pending", attempts: 0, nextAttemptAt: null });
      auditSecurity(this.ctx, "delivery.requeue", id, "allowed");
      return validate<Delivery>("Delivery", next);
    });
  }
  private windowKey(id: string): string {
    return `delivery:window:${this.ctx.workspaceId}:${id}`;
  }
  /** Start of the 24 h retry window: creation time, or the last requeue. */
  private windowStart(row: EntityDocument): string {
    const stored = this.ctx.database.get(
      "SELECT value FROM operational_state WHERE key=?",
      this.windowKey(row.id),
    );
    return stored ? String(stored.value) : String(row.createdAt);
  }
  private update(current: EntityDocument, fields: Record<string, unknown>): EntityDocument {
    const next = { ...current, ...fields, version: Number(current.version) + 1 };
    this.ctx.entities.update(
      "Delivery",
      this.ctx.workspaceId,
      current.id,
      Number(current.version),
      next,
    );
    return requireEntity(this.ctx, "Delivery", current.id);
  }
}
