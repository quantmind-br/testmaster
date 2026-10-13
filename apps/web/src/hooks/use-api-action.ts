import { useCallback, useRef, useState } from "react";
import { ApiError } from "../api/client";

export interface ApiAction {
  readonly pending: boolean;
  readonly error: ApiError | null;
  /** Runs one request. A second call while one is in flight is ignored (no duplicate submit). */
  run<T>(task: () => Promise<T>): Promise<T | undefined>;
  clear(): void;
}

function toApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError(0, "unknown", { code: "INTERNAL", message: String(error) });
}

/** In-flight guard plus the last error, for mutations that are not behind a confirm dialog. */
export function useApiAction(): ApiAction {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const inflight = useRef(false);
  const run = useCallback(async <T>(task: () => Promise<T>): Promise<T | undefined> => {
    if (inflight.current) return undefined;
    inflight.current = true;
    setPending(true);
    setError(null);
    try {
      return await task();
    } catch (failure) {
      setError(toApiError(failure));
      return undefined;
    } finally {
      inflight.current = false;
      setPending(false);
    }
  }, []);
  const clear = useCallback(() => setError(null), []);
  return { pending, error, run, clear };
}
