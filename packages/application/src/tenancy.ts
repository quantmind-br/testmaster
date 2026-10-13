import { ContractError } from "@testmaster/contracts";
import { PersistenceDatabase } from "@testmaster/persistence";
import type { PostgresConfig } from "./server-config.js";

/** Workspace scope of a database view; `"*"` is reserved for controllers and host operations. */
export type WorkspaceScope = string;
/** Engine-aware surface of the persistence layer that tenancy needs (ADR-015). */
interface TenantAwareDatabase {
  readonly engine?: "sqlite" | "postgres";
  forWorkspace?(scope: WorkspaceScope): PersistenceDatabase;
}
interface PostgresEngine {
  openPostgres?(config: PostgresConfig): PersistenceDatabase | Promise<PersistenceDatabase>;
}
/** The view of `database` whose rows are limited to `scope`; a no-op on SQLite. */
export function scopeDatabase(database: PersistenceDatabase, scope: WorkspaceScope) {
  // Engine-specific members are declared by the PostgreSQL bridge; SQLite instances lack them.
  const aware = database as unknown as TenantAwareDatabase;
  return aware.forWorkspace ? aware.forWorkspace(scope) : database;
}
/** True when the database is the PostgreSQL server engine (multi-tenant, no implicit workspace). */
export function isPostgres(database: PersistenceDatabase): boolean {
  const aware = database as unknown as TenantAwareDatabase;
  return aware.engine === "postgres";
}
/** Opens the PostgreSQL engine with controller scope. */
export async function openServerDatabase(config: PostgresConfig): Promise<PersistenceDatabase> {
  // The engine class gains `openPostgres` with the PostgreSQL bridge; older builds lack it.
  const engine = PersistenceDatabase as unknown as PostgresEngine;
  if (!engine.openPostgres)
    throw new ContractError("CAPABILITY_UNAVAILABLE", "PostgreSQL engine is unavailable", {
      capability: "postgres",
      milestone: "M4",
    });
  return scopeDatabase(await engine.openPostgres(config), "*");
}
