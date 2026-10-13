import { useEffect, useRef, useState } from "react";
import {
  createStreamController,
  fetchTransport,
  type StreamEvent,
  type StreamStatus,
} from "../api/sse";

export interface EventStreamOptions {
  /** Called for each new event, in order, never twice for the same `seq`. */
  readonly onEvent: (event: StreamEvent) => void;
  /** Refetch authoritative state; used on gaps, `CURSOR_EXPIRED` and after the stream ends. */
  readonly snapshot: () => Promise<void>;
  readonly isTerminal?: (event: StreamEvent) => boolean;
  readonly enabled?: boolean;
}

/**
 * Live updates with `Last-Event-ID` resume. Handlers are read through a ref so a re-render never
 * reconnects; only a change of `path` or `enabled` does.
 */
export function useEventStream(path: string, options: EventStreamOptions): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>("idle");
  const latest = useRef(options);
  latest.current = options;
  const enabled = options.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    const controller = createStreamController({
      transport: fetchTransport(`/v1${path}`),
      onEvent: (event) => latest.current.onEvent(event),
      snapshot: () => latest.current.snapshot(),
      isTerminal: (event) => latest.current.isTerminal?.(event) ?? false,
      onStatus: setStatus,
    });
    void controller.start();
    return () => controller.stop();
  }, [path, enabled]);
  return status;
}
