import { type ReactNode, useCallback, useRef, useState } from "react";
import { ApiError } from "../../api";
import { Icon, type Shape, type Tone } from "../../components/status";

/** A labelled state: text plus a shape, never colour alone. */
export function Pill({
  label,
  tone = "neutral",
  shape = "info",
}: {
  label: string;
  tone?: Tone;
  shape?: Shape;
}): ReactNode {
  return (
    <span className={`badge tone-${tone}`}>
      <Icon shape={shape} />
      <span>{label}</span>
    </span>
  );
}

export function ErrorNotice({ error }: { error: ApiError | null }): ReactNode {
  if (!error) return null;
  return (
    <div className="banner tone-danger" role="alert" data-testid="action-error">
      <Icon shape="cross" />
      <div>
        <p>{error.message}</p>
        <p className="mono">
          {error.code}
          {error.requestId ? ` · request ${error.requestId}` : ""}
        </p>
      </div>
    </div>
  );
}

/**
 * One in-flight action at a time: a second click while the first runs is ignored, so a double
 * submit sends a single request. Failures are kept for display; an aborted request is not one.
 */
export function useAction(): {
  pending: boolean;
  error: ApiError | null;
  run: <T>(action: () => Promise<T>) => Promise<T | undefined>;
  clear: () => void;
} {
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    setPending(true);
    setError(null);
    try {
      return await action();
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return undefined;
      setError(
        cause instanceof ApiError
          ? cause
          : new ApiError(0, "", { message: cause instanceof Error ? cause.message : "Failed" }),
      );
      return undefined;
    } finally {
      running.current = false;
      setPending(false);
    }
  }, []);
  return { pending, error, run, clear: useCallback(() => setError(null), []) };
}
