import type { PersistenceDatabase } from "@testmaster/persistence";

/**
 * Whether this deployment is a restored copy that an operator has not yet released (OPS-025).
 * `restore:isolated` is the explicit flag; a restore that suspended admission is isolated too.
 * Controllers that start work on their own (scheduler, outbox dispatch, integrations) read this
 * and do nothing while it is true; they never decide to leave isolation themselves.
 */
export function isRestoreIsolated(database: Pick<PersistenceDatabase, "get">): boolean {
  const flag = database.get("SELECT value FROM operational_state WHERE key='restore:isolated'");
  if (flag && !["", "0", "false", "no"].includes(String(flag.value).toLowerCase())) return true;
  const admission = database.get("SELECT value FROM operational_state WHERE key='admission'");
  return admission?.value === "suspended_restore";
}
