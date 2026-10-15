import { setTimeout as delay } from "node:timers/promises";
import { ContractError } from "@testmaster/contracts";

/** How long a long-lived loop keeps retrying one operation before the contention is fatal. */
export const writerContentionBudgetMs = 20_000;
const firstBackoffMs = 50;
const maxBackoffMs = 1000;

/**
 * True for the typed, retryable refusal `PersistenceDatabase.withTx` raises when it could not take
 * the writer lock. The transaction never started, so repeating the operation is safe.
 */
export function isWriterContention(error: unknown): error is ContractError {
  return (
    error instanceof ContractError &&
    error.code === "UNAVAILABLE" &&
    (error.details as { reasonCode?: string } | undefined)?.reasonCode === "writer_contention"
  );
}

/**
 * Runs `operation`, repeating it with capped exponential backoff while the writer lock is
 * contended. The wait is bounded by `budgetMs` and ends early on `signal`; either way the last
 * contention error is rethrown so the caller sees a typed UNAVAILABLE, never a swallowed failure.
 * Any other error propagates at once. `operation` must be safe to repeat from the start.
 */
export async function retryWriterContention<T>(
  operation: () => T | Promise<T>,
  options: { signal?: AbortSignal | undefined; budgetMs?: number | undefined } = {},
): Promise<T> {
  const deadline = performance.now() + (options.budgetMs ?? writerContentionBudgetMs);
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const wait = Math.min(maxBackoffMs, firstBackoffMs * 2 ** attempt);
      if (
        !isWriterContention(error) ||
        options.signal?.aborted ||
        performance.now() + wait > deadline
      )
        throw error;
      try {
        await delay(wait, undefined, options.signal ? { signal: options.signal } : {});
      } catch {
        throw error;
      }
    }
  }
}
