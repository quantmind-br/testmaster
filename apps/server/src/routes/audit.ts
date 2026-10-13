import type { AuditQuery } from "@testmaster/application";
import { type AuditActorKind, type AuditOutcome, ContractError } from "@testmaster/contracts";
import type { RouteContext, RouteModule } from "./types.js";

const filters = [
  "actorKind",
  "actorId",
  "operation",
  "outcome",
  "correlationId",
  "resourceId",
  "from",
  "to",
] as const;

/** Audit trail with SQL-level cursor paging, and the per-project approval policy (SEC-039). */
function auditEvents({ service, identity, query, cursors }: RouteContext) {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ContractError("INVALID_ARGUMENT", "Page size must be 1–100");
  const selected: Record<string, string> = {};
  for (const name of filters) {
    const value = query[name];
    if (value !== undefined) selected[name] = value;
  }
  const binding = JSON.stringify([
    service.context.workspaceId,
    identity?.principalId,
    "/audit-events",
    selected,
  ]);
  const cursor = query.cursor ? cursors.decode(query.cursor, binding) : null;
  const request: AuditQuery = {
    limit,
    ...(selected.actorKind ? { actorKind: selected.actorKind as AuditActorKind } : {}),
    ...(selected.actorId ? { actorId: selected.actorId } : {}),
    ...(selected.operation ? { operation: selected.operation } : {}),
    ...(selected.outcome ? { outcome: selected.outcome as AuditOutcome } : {}),
    ...(selected.correlationId ? { correlationId: selected.correlationId } : {}),
    ...(selected.resourceId ? { resourceId: selected.resourceId } : {}),
    ...(selected.from ? { from: selected.from } : {}),
    ...(selected.to ? { to: selected.to } : {}),
    ...(cursor ? { after: { createdAt: cursor.createdAt, id: cursor.id } } : {}),
  };
  const { items, hasMore } = service.audit.list(request);
  const last = items.at(-1);
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? cursors.encode({
            binding,
            cutoff: new Date().toISOString(),
            createdAt: last.createdAt,
            id: last.id,
          })
        : null,
  };
}

export const auditRoutes: RouteModule = {
  handlers: {
    "GET /audit-events": auditEvents,
    "GET /projects/{id}/approval-policy": ({ service, params }) =>
      service.approvals.policy(params.id as string),
    "PUT /projects/{id}/approval-policy": ({ service, params, body, ifMatch }) =>
      service.approvals.setPolicy(
        params.id as string,
        body as Parameters<typeof service.approvals.setPolicy>[1],
        ifMatch(),
      ),
  },
  synchronous: ["PUT /projects/{id}/approval-policy"],
};
