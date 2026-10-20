import { setTimeout as delay } from "node:timers/promises";
import { ContractError } from "@testmaster/contracts";
import {
  type AuxiliaryFence,
  type AuxiliaryJob,
  type AuxiliaryLeaseRepository,
  StaleFenceError,
} from "@testmaster/persistence";

/**
 * Lease of an auxiliary model job (analysis, healing). A model call has no deadline, so the lease
 * is not sized to one: it is renewed while the holder runs, and only a holder that stopped (crash,
 * killed process) lets it expire, which is what tells another process the job was abandoned.
 */
export const AUXILIARY_LEASE_MS = 60_000;
const RENEW_EVERY_MS = 15_000;

/** Renews `fence` until `stop()`; a busy writer only skips one renewal, a lost fence stops it. */
export function keepLeaseAlive(
  jobs: AuxiliaryLeaseRepository,
  fence: AuxiliaryFence,
): { stop(): void } {
  const timer = setInterval(() => {
    try {
      jobs.heartbeat(fence, AUXILIARY_LEASE_MS);
    } catch (error) {
      if (error instanceof StaleFenceError) clearInterval(timer);
    }
  }, RENEW_EVERY_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/**
 * One 50 ms pass of a wait on another holder's job. `signal` cuts the pass short and the pass then
 * resolves: the waiter's loop sees the abort on its next check and answers with its own error.
 */
export function waitPass(signal?: AbortSignal): Promise<void> {
  return delay(50, undefined, signal ? { signal } : undefined).catch(() => undefined);
}

/**
 * One wait pass on another holder's job that ends the wait when the caller is cancelled, before
 * or during the pass: `PRECONDITION_FAILED` `wait_cancelled` with `cancelled` as the message. The
 * cancellation ends only this caller's wait and leaves the other holder's job alone, so a
 * cancelled waiter never goes on to take the job.
 */
export async function waitTurn(
  signal: AbortSignal | undefined,
  jobId: string,
  cancelled: string,
): Promise<void> {
  await waitPass(signal);
  if (signal?.aborted)
    throw new ContractError("PRECONDITION_FAILED", cancelled, { reason: "wait_cancelled", jobId });
}

/**
 * Reopens `jobId`, a request that never reached the provider. When another caller reopened or
 * settled it first, this waits one turn (`waitTurn`) and returns null: the caller reads the job
 * again.
 */
export async function reopenUnpaidOrWait(
  jobs: AuxiliaryLeaseRepository,
  workspaceId: string,
  jobId: string,
  signal: AbortSignal | undefined,
  cancelled: string,
): Promise<AuxiliaryJob | null> {
  try {
    return jobs.reopenUnpaid(workspaceId, jobId, new Date().toISOString());
  } catch (error) {
    if (!(error instanceof ContractError && error.code === "PRECONDITION_FAILED")) throw error;
  }
  await waitTurn(signal, jobId, cancelled);
  return null;
}
