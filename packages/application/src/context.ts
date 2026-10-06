import { ContractError, type EntityPrefix } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import type {
  EntityDocument,
  EntityRepository,
  PageCursor,
  PersistenceDatabase,
} from "@testmaster/persistence";

export type Scope = "R" | "W" | "X" | "A";
export interface ServiceContext {
  database: PersistenceDatabase;
  entities: EntityRepository;
  workspaceId: string;
  principalId: string;
  correlationId?: string;
  authorize(scope: Scope, projectId?: string): void;
  authorizeRaw?(projectId: string, environmentId: string): void;
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
