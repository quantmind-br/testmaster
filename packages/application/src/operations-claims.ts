import type { PersistenceDatabase } from "@testmaster/persistence";

/** The `operational_state` key that holds one workspace's worker-claim pause (OPS-035). */
export const WORKSPACE_CLAIMS_KEY = (workspaceId: string): string => `ops:claims:${workspaceId}`;

export interface WorkspaceClaims {
  paused: boolean;
  reason: string | null;
  changedBy: string | null;
  changedAt: string | null;
}

interface StoredClaims {
  reason: string;
  by: string;
  at: string;
}

/** Whether workers of every kind, local and remote, may claim this workspace's queued Runs. */
export function workspaceClaimsPaused(
  database: PersistenceDatabase,
  workspaceId: string,
): WorkspaceClaims {
  const row = database.get(
    "SELECT value FROM operational_state WHERE key=?",
    WORKSPACE_CLAIMS_KEY(workspaceId),
  );
  if (!row) return { paused: false, reason: null, changedBy: null, changedAt: null };
  const stored = JSON.parse(String(row.value)) as StoredClaims;
  return { paused: true, reason: stored.reason, changedBy: stored.by, changedAt: stored.at };
}

/**
 * Pauses or resumes claims for one workspace. A pause stops new claims only: an Attempt already
 * running keeps its lease and finishes, because no safeguard cuts work in progress.
 */
export function setWorkspaceClaims(
  database: PersistenceDatabase,
  workspaceId: string,
  input: { paused: boolean; reason: string; actor: string; at: string },
): void {
  const key = WORKSPACE_CLAIMS_KEY(workspaceId);
  if (!input.paused) {
    database.run("DELETE FROM operational_state WHERE key=?", key);
    return;
  }
  database.run(
    "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    key,
    JSON.stringify({ reason: input.reason, by: input.actor, at: input.at } satisfies StoredClaims),
  );
}
