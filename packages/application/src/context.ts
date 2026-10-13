import { ContractError, type EntityPrefix } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import type {
  EntityDocument,
  EntityRepository,
  PageCursor,
  PersistenceDatabase,
} from "@testmaster/persistence";

export type Scope = "R" | "W" | "X" | "A";
/** Who admitted a Run; the worker re-authorizes this actor before it claims the job (ADR-017). */
export interface RunActor {
  principalId: string;
  credentialKind: string | null;
  credentialId: string | null;
}
export interface ServiceContext {
  database: PersistenceDatabase;
  entities: EntityRepository;
  workspaceId: string;
  principalId: string;
  correlationId?: string;
  authorize(scope: Scope, projectId?: string): void;
  /** RBAC `secret` (write, rotate) and `export` columns, applied on top of the W and R scopes. */
  authorizeColumn(column: "secret" | "export", projectId?: string): void;
  /** The credential the caller authenticated with; null for the in-process local CLI. */
  readonly actor: RunActor;
  /** True while the actor may still execute in the project; false once access was revoked. */
  reauthorizeActor(actor: RunActor, projectId: string): boolean;
  authorizeRaw?(projectId: string, environmentId: string): void;
  /**
   * Named resource authority (`healing:approve`, `artifacts:delete`) evaluated against role
   * defaults and resource-scoped PermissionGrants; generic W/X never implies it.
   */
  authorizeNamed(
    action: "approve" | "delete" | "export",
    resourceType: "HealingProposal" | "Artifact" | "SecretReference",
    projectId: string,
    environmentId?: string | null,
  ): void;
}
export function entity(
  ctx: ServiceContext,
  prefix: EntityPrefix,
  fields: Record<string, unknown>,
): EntityDocument {
  return {
    id: uuidV7IdGenerator.next(prefix),
    workspaceId: ctx.workspaceId,
    createdAt: new Date().toISOString(),
    version: 1,
    ...fields,
  };
}
export function requireEntity(
  ctx: ServiceContext,
  kind: Parameters<EntityRepository["get"]>[0],
  id: string,
): EntityDocument {
  const value = ctx.entities.get(kind, ctx.workspaceId, id);
  if (!value) throw new ContractError("NOT_FOUND", `${kind} does not exist`, { id });
  return value;
}
export function allEntities(
  ctx: ServiceContext,
  kind: Parameters<EntityRepository["page"]>[0],
): EntityDocument[] {
  const items: EntityDocument[] = [];
  let cursor: PageCursor | null = null;
  do {
    const page: { items: EntityDocument[]; next: PageCursor | null } = ctx.entities.page(
      kind,
      ctx.workspaceId,
      { limit: 100, ...(cursor ? { cursor } : {}) },
    );
    items.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return items;
}
