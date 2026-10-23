import type { PersistenceDatabase } from "@testmaster/persistence";

export type RemoteAttemptRouteState = "active" | "settled" | "failed" | "dropped";

/** Which controller holds the in-memory `AttemptSession` of a remotely run Attempt (ADR-035). */
export interface RemoteAttemptRoute {
  attemptId: string;
  workspaceId: string;
  runId: string;
  workerId: string;
  controllerId: string;
  fence: number;
  state: RemoteAttemptRouteState;
  updatedAt: string;
}

export type RemoteAttemptHolder = Omit<RemoteAttemptRoute, "state" | "updatedAt">;

/**
 * Records the controller that claimed the Attempt, as `active`. The session cannot move, so another
 * controller reads this row to forward a worker's call instead of answering it. Writing the same
 * Attempt again (a re-claim under a higher fence) replaces the holder.
 */
export function recordHolder(
  database: PersistenceDatabase,
  holder: RemoteAttemptHolder,
  nowMs: number = Date.now(),
): void {
  database.run(
    "INSERT INTO remote_attempts(attempt_id,workspace_id,run_id,worker_id,controller_id,fence,state,updated_at) VALUES(?,?,?,?,?,?,'active',?) ON CONFLICT(attempt_id) DO UPDATE SET controller_id=excluded.controller_id,worker_id=excluded.worker_id,fence=excluded.fence,state='active',updated_at=excluded.updated_at",
    holder.attemptId,
    holder.workspaceId,
    holder.runId,
    holder.workerId,
    holder.controllerId,
    holder.fence,
    new Date(nowMs).toISOString(),
  );
}

/** The row of an Attempt, whatever its state; null when no controller ever recorded it. Needs the `"*"` scope on PostgreSQL. */
export function holderOf(
  database: PersistenceDatabase,
  attemptId: string,
): RemoteAttemptRoute | null {
  const row = database.get(
    "SELECT attempt_id,workspace_id,run_id,worker_id,controller_id,fence,state,updated_at FROM remote_attempts WHERE attempt_id=?",
    attemptId,
  );
  return row
    ? {
        attemptId: String(row.attempt_id),
        workspaceId: String(row.workspace_id),
        runId: String(row.run_id),
        workerId: String(row.worker_id),
        controllerId: String(row.controller_id),
        fence: Number(row.fence),
        state: String(row.state) as RemoteAttemptRouteState,
        updatedAt: String(row.updated_at),
      }
    : null;
}

/** Ends an active route (settled, failed or dropped); a route that already ended keeps its first end. */
export function markSettled(
  database: PersistenceDatabase,
  attemptId: string,
  state: Exclude<RemoteAttemptRouteState, "active"> = "settled",
  nowMs: number = Date.now(),
): boolean {
  return (
    database.run(
      "UPDATE remote_attempts SET state=?,updated_at=? WHERE attempt_id=? AND state='active'",
      state,
      new Date(nowMs).toISOString(),
      attemptId,
    ).changes > 0
  );
}
