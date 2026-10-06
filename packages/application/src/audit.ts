import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { ContractError, validate } from "@testmaster/contracts";
import { canonicalJson, sha256 } from "@testmaster/domain";
import { AuditRepository, type EntityDocument } from "@testmaster/persistence";
import type { ServiceContext } from "./context.js";

/** Outcomes are explicit in action suffixes; only hashes, never request payloads, are stored. */
export function auditSecurity(
  ctx: ServiceContext,
  action: string,
  resourceId: string,
  outcome: "allowed" | "denied" | "requested",
  requestId: string = ctx.correlationId ?? randomUUID(),
): void {
  new AuditRepository(ctx.database).append({
    workspaceId: ctx.workspaceId,
    actor: ctx.principalId || "unauthenticated:local",
    action: `${action}.${outcome}`,
    resourceId,
    requestId,
    timestamp: new Date().toISOString(),
    beforeHash: null,
    afterHash: null,
  });
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
