import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type AuditActorKind,
  type AuditEntry,
  type AuditOutcome,
  auditActorKinds,
  auditOutcomes,
  ContractError,
  validate,
} from "@testmaster/contracts";
import { canonicalJson, sha256 } from "@testmaster/domain";
import {
  AuditRepository,
  type EntityDocument,
  type PersistenceDatabase,
} from "@testmaster/persistence";
import type { ServiceContext } from "./context.js";
import { systemPrincipalKey } from "./team.js";

export interface AuditQuery {
  actorKind?: AuditActorKind;
  actorId?: string;
  /** Exact operation name or dotted prefix, such as `member` or `auth.token.issue`. */
  operation?: string;
  outcome?: AuditOutcome;
  correlationId?: string;
  resourceId?: string;
  from?: string;
  to?: string;
  limit?: number;
  after?: { createdAt: string; id: string };
}
/** Principal prefixes are the kind marker; the controller principal is the one recorded per workspace. */
export function auditActorKindOf(actor: string, systemPrincipal: string): AuditActorKind {
  if (actor === systemPrincipal) return "system";
  if (actor.startsWith("usr_")) return "human";
  if (actor.startsWith("svc_")) return "agent";
  if (actor.startsWith("integration:")) return "integration";
  return "unauthenticated";
}

export interface AuditActor {
  database: PersistenceDatabase;
  workspaceId: string;
  /** Principal id, or an `unauthenticated:*` label before identity is known. */
  actor: string;
}
/** Records one outcome for an actor that is not the service context's principal (login, recovery). */
export function auditAs(
  who: AuditActor,
  action: string,
  resourceId: string,
  outcome: "allowed" | "denied" | "requested",
  requestId: string = randomUUID(),
): void {
  new AuditRepository(who.database).append({
    workspaceId: who.workspaceId,
    actor: who.actor,
    action: `${action}.${outcome}`,
    resourceId,
    requestId,
    timestamp: new Date().toISOString(),
    beforeHash: null,
    afterHash: null,
  });
}
/**
 * Outcomes are explicit in action suffixes; only hashes, never request payloads, are stored.
 * An unbound context (server profile before authentication) has no workspace to record under.
 */
export function auditSecurity(
  ctx: ServiceContext,
  action: string,
  resourceId: string,
  outcome: "allowed" | "denied" | "requested",
  requestId: string = ctx.correlationId ?? randomUUID(),
): void {
  if (!ctx.workspaceId) return;
  auditAs(
    {
      database: ctx.database,
      workspaceId: ctx.workspaceId,
      actor: ctx.principalId || "unauthenticated:local",
    },
    action,
    resourceId,
    outcome,
    requestId,
  );
}

export async function auditedOperation<T>(
  ctx: ServiceContext,
  action: string,
  resourceId: string,
  operation: () => Promise<T>,
): Promise<T> {
  auditSecurity(ctx, action, resourceId, "requested");
  try {
    const result = await operation();
    auditSecurity(ctx, action, resourceId, "allowed");
    return result;
  } catch (error) {
    auditSecurity(ctx, action, resourceId, "denied");
    throw error;
  }
}

export interface LocalAuditExport {
  schemaVersion: "1.0.0";
  workspaceId: string;
  exportedAt: string;
  events: EntityDocument[];
}

/** The expected hash must be retained independently; this is not a tamper-proof local ledger. */
export function verifyAuditExport(bytes: Uint8Array, expectedSha256: string) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha256(bytes) !== expectedSha256)
    throw new ContractError("PRECONDITION_FAILED", "Audit export digest does not match");
  let value: LocalAuditExport;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8")) as LocalAuditExport;
    if (
      value.schemaVersion !== "1.0.0" ||
      typeof value.workspaceId !== "string" ||
      !Number.isFinite(Date.parse(value.exportedAt)) ||
      !Array.isArray(value.events)
    )
      throw new Error("Invalid audit export");
    const ids = new Set<string>();
    let previous = "";
    for (const event of value.events) {
      validate("AuditEvent", event);
      const key = `${event.createdAt}:${event.id}`;
      if (event.workspaceId !== value.workspaceId || ids.has(event.id) || key < previous)
        throw new Error("Invalid audit event ordering or ownership");
      ids.add(event.id);
      previous = key;
    }
  } catch {
    throw new ContractError("PRECONDITION_FAILED", "Audit export is malformed");
  }
  return { workspaceId: value.workspaceId, events: value.events.length, sha256: expectedSha256 };
}

export class AuditService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly cwd: string,
  ) {}

  /**
   * The workspace audit trail for administrators (UX-050): newest first, filtered in SQL so cursor
   * paging stays exact. Rows carry hashes and ids only, so no secret value can appear.
   */
  list(query: AuditQuery = {}): { items: AuditEntry[]; hasMore: boolean } {
    this.ctx.authorize("A");
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ContractError("INVALID_ARGUMENT", "Page size must be 1–100");
    const where = ["a.workspace_id=?"];
    const params: unknown[] = [this.ctx.workspaceId];
    const systemKey = systemPrincipalKey(this.ctx.workspaceId);
    const systemActor = "COALESCE((SELECT value FROM operational_state WHERE key=?),'')";
    if (query.actorKind) {
      if (!auditActorKinds.includes(query.actorKind))
        throw new ContractError("INVALID_ARGUMENT", "Unknown actor kind", { field: "actorKind" });
      const kinds: Record<AuditActorKind, [string, unknown[]]> = {
        human: ["substr(a.actor,1,4)='usr_'", []],
        agent: [`(substr(a.actor,1,4)='svc_' AND a.actor<>${systemActor})`, [systemKey]],
        integration: ["substr(a.actor,1,12)='integration:'", []],
        system: [`a.actor=${systemActor}`, [systemKey]],
        unauthenticated: ["substr(a.actor,1,15)='unauthenticated'", []],
      };
      const [clause, values] = kinds[query.actorKind];
      where.push(clause);
      params.push(...values);
    }
    if (query.actorId) {
      where.push("a.actor=?");
      params.push(query.actorId);
    }
    if (query.operation) {
      if (!/^[a-z0-9._:-]{1,100}$/.test(query.operation))
        throw new ContractError("INVALID_ARGUMENT", "Invalid operation filter", {
          field: "operation",
        });
      where.push("substr(a.action,1,?)=?");
      params.push(query.operation.length, query.operation);
    }
    if (query.outcome) {
      if (!auditOutcomes.includes(query.outcome))
        throw new ContractError("INVALID_ARGUMENT", "Unknown outcome", { field: "outcome" });
      if (query.outcome === "recorded")
        where.push(
          "a.action NOT LIKE '%.allowed' AND a.action NOT LIKE '%.denied' AND a.action NOT LIKE '%.requested'",
        );
      else {
        where.push("a.action LIKE ?");
        params.push(`%.${query.outcome}`);
      }
    }
    if (query.correlationId) {
      where.push("a.request_id=?");
      params.push(query.correlationId);
    }
    if (query.resourceId) {
      where.push("a.resource_id=?");
      params.push(query.resourceId);
    }
    for (const [field, operator] of [
      ["from", ">="],
      ["to", "<="],
    ] as const) {
      const value = query[field];
      if (value === undefined) continue;
      if (!Number.isFinite(Date.parse(value)))
        throw new ContractError("INVALID_ARGUMENT", "Invalid time filter", { field });
      where.push(`a.created_at${operator}?`);
      params.push(new Date(value).toISOString());
    }
    if (query.after) {
      where.push("(a.created_at<? OR (a.created_at=? AND a.id<?))");
      params.push(query.after.createdAt, query.after.createdAt, query.after.id);
    }
    const rows = this.ctx.database.all(
      `SELECT a.id AS id,a.created_at AS created_at,a.actor AS actor,a.action AS action,a.resource_id AS resource_id,a.request_id AS request_id,a.before_hash AS before_hash,a.after_hash AS after_hash FROM audit_events a WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC,a.id DESC LIMIT ?`,
      ...params,
      limit + 1,
    );
    const system = String(
      this.ctx.database.get("SELECT value FROM operational_state WHERE key=?", systemKey)?.value ??
        "",
    );
    const names = new Map<string, string | null>();
    const items = rows.slice(0, limit).map((row): AuditEntry => {
      const actor = String(row.actor);
      if (!names.has(actor))
        names.set(
          actor,
          actor.startsWith("usr_") || actor.startsWith("svc_")
            ? ((
                this.ctx.database.get(
                  "SELECT display_name FROM principals WHERE workspace_id=? AND id=?",
                  this.ctx.workspaceId,
                  actor,
                ) as { display_name?: string } | undefined
              )?.display_name ?? null)
            : null,
        );
      const action = String(row.action);
      const suffix = /\.(allowed|denied|requested)$/.exec(action);
      const resourceId = String(row.resource_id);
      return {
        id: String(row.id),
        createdAt: String(row.created_at),
        actor: {
          id: actor,
          kind: auditActorKindOf(actor, system),
          displayName: names.get(actor) ?? null,
        },
        operation: suffix ? action.slice(0, suffix.index) : action,
        outcome: (suffix?.[1] as AuditOutcome | undefined) ?? "recorded",
        scope: { resourceType: /^([a-z]+)_/.exec(resourceId)?.[1] ?? "resource", resourceId },
        correlationId: String(row.request_id),
        beforeHash: row.before_hash ? String(row.before_hash) : null,
        afterHash: row.after_hash ? String(row.after_hash) : null,
      };
    });
    return { items, hasMore: rows.length > limit };
  }

  async export(out: string) {
    return auditedOperation(this.ctx, "audit.export", this.ctx.workspaceId, async () => {
      this.ctx.authorize("A");
      const value: LocalAuditExport = this.ctx.database.withTx(() => ({
        schemaVersion: "1.0.0",
        workspaceId: this.ctx.workspaceId,
        exportedAt: new Date().toISOString(),
        events: this.ctx.database
          .all(
            "SELECT data_json,created_at,version FROM audit_events WHERE workspace_id=? ORDER BY created_at,id",
            this.ctx.workspaceId,
          )
          .map(
            (row) =>
              ({
                ...JSON.parse(String(row.data_json)),
                createdAt: String(row.created_at),
                version: Number(row.version),
              }) as EntityDocument,
          ),
      }));
      const bytes = Buffer.from(canonicalJson(value));
      const path = resolve(this.cwd, out);
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      return {
        out: path,
        events: value.events.length,
        sha256: sha256(bytes),
        workspaceId: value.workspaceId,
      };
    });
  }
}
