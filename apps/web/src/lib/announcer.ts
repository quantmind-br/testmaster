/**
 * Coalesces announcements for a polite live region: messages within one window are joined and
 * identical consecutive messages are dropped, so a burst of status changes reads as one update.
 */
export interface Announcer {
  announce(message: string): void;
  subscribe(listener: (message: string) => void): () => void;
  dispose(): void;
}

export interface AnnouncerOptions {
  readonly windowMs?: number;
  readonly schedule?: (callback: () => void, ms: number) => () => void;
  readonly maxMessages?: number;
}

function defaultSchedule(callback: () => void, ms: number): () => void {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
}

export function createAnnouncer(options: AnnouncerOptions = {}): Announcer {
  const windowMs = options.windowMs ?? 400;
  const schedule = options.schedule ?? defaultSchedule;
  const maxMessages = options.maxMessages ?? 5;
  const listeners = new Set<(message: string) => void>();
  let queue: string[] = [];
  let cancel: (() => void) | null = null;

  function flush(): void {
    cancel = null;
    const kept = queue.slice(-maxMessages);
    queue = [];
    if (kept.length === 0) return;
    const message = kept.join(". ");
    for (const listener of listeners) listener(message);
  }

  return {
    announce(message) {
      const text = message.trim();
      if (text === "" || queue.at(-1) === text) return;
      queue.push(text);
      cancel ??= schedule(flush, windowMs);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      cancel?.();
      cancel = null;
      queue = [];
      listeners.clear();
    },
  };
}
