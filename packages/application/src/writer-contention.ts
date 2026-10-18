import { ContractError } from "@testmaster/contracts";
import { withYieldingWriterWait } from "@testmaster/persistence";

/** Waiting longer than this for the writer lock is reported once through `onContended`. */
export const writerContentionNoticeMs = 5000;
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

export interface RetryWriterContentionOptions {
  /** Ends the wait; the last contention error is rethrown so the caller sees the typed refusal. */
  signal?: AbortSignal | undefined;
  /** Called once when the wait passes {@link writerContentionNoticeMs}; never a failure. */
  onContended?: ((elapsedMs: number) => void) | undefined;
  /**
   * True while the caller's own transaction is open. Waiting then would hold the writer lock
   * while sleeping, so the retry is refused as an internal error instead.
   */
  inTransaction?: (() => boolean) | undefined;
}

/** Sleeps `ms`, resolving false early when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  if (signal?.aborted) {
    resolve(false);
    return promise;
  }
  const onAbort = () => {
    clearTimeout(timer);
    resolve(false);
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve(true);
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

/**
 * Runs `operation`, repeating it with full-jitter exponential backoff (capped at one second) while
 * the writer lock is contended. There is no total deadline: another connection's transaction is
 * progress, and failing the waiter would only interrupt it. Each attempt's transactions wait for
 * the lock only briefly inside SQLite (`withYieldingWriterWait`), so the process keeps running
 * timers, heartbeats and cancellation while it waits. The wait ends on `signal`, and then the last
 * contention error is rethrown so the caller sees a typed UNAVAILABLE, never a swallowed failure.
 * Any other error propagates at once. `operation` must be safe to repeat from the start.
 */
export async function retryWriterContention<T>(
  operation: () => T | Promise<T>,
  options: RetryWriterContentionOptions = {},
): Promise<T> {
  const started = Date.now();
  let notified = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await withYieldingWriterWait(operation);
    } catch (error) {
      if (!isWriterContention(error) || options.signal?.aborted) throw error;
      if (options.inTransaction?.())
        throw new ContractError(
          "INTERNAL",
          "Refusing to wait for the writer lock while a transaction is open",
          { reasonCode: "wait_in_transaction", cause: error.message },
        );
      const elapsed = Date.now() - started;
      if (!notified && elapsed >= writerContentionNoticeMs) {
        notified = true;
        try {
          options.onContended?.(elapsed);
        } catch {
          // Observability must never turn a wait into a failure.
        }
      }
      const ceiling = Math.min(maxBackoffMs, firstBackoffMs * 2 ** Math.min(attempt, 10));
      if (!(await sleep(Math.floor(Math.random() * ceiling), options.signal))) throw error;
    }
  }
}
