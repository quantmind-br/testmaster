import { useCallback, useRef, useState } from "react";
import { ApiError } from "../../api";

export interface GuardedAction {
  readonly busy: boolean;
  readonly failure: string | null;
  /** Runs `action` unless one is already running; resolves to its value, or null when it failed or was ignored. */
  run<T>(action: () => Promise<T>): Promise<{ readonly value: T } | null>;
  clearFailure(): void;
}

/**
 * One request at a time per control. The guard is a ref, so a double click or a repeated Enter
 * sends a single request even before React has re-rendered the disabled state.
 */
export function useGuardedAction(): GuardedAction {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const run = useCallback(async <T>(action: () => Promise<T>) => {
    if (running.current) return null;
    running.current = true;
    setBusy(true);
    setFailure(null);
    try {
      return { value: await action() };
    } catch (error) {
      setFailure(
        error instanceof ApiError
          ? `${error.message} (${error.code}, request ${error.requestId})`
          : "The action failed.",
      );
      return null;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  const clearFailure = useCallback(() => setFailure(null), []);
  return { busy, failure, run, clearFailure };
}
