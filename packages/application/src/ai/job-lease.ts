import { setTimeout as delay } from "node:timers/promises";
import {
  type AuxiliaryFence,
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
