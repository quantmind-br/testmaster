/**
 * Server-sent events over `fetch`. `EventSource` hides HTTP failures and cannot drop a stale
 * `Last-Event-ID`, which the portal needs to recover from `CURSOR_EXPIRED`, so the stream is
 * parsed here. The controller keeps state monotonic: duplicates and reordered events are dropped,
 * a sequence gap triggers a snapshot refetch, and a snapshot never replaces a newer event.
 */

export interface SseMessage {
  readonly id: string | null;
  readonly event: string;
  readonly data: string;
}

/** Incremental parser for the `text/event-stream` wire format (WHATWG HTML §9.2). */
export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event = "";
  private id: string | null = null;
  private lastId = "";

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const messages: SseMessage[] = [];
    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.buffer);
      if (!match) break;
      // A bare trailing CR may be the first half of CRLF; wait for more bytes.
      if (match[0] === "\r" && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const message = this.line(line);
      if (message) messages.push(message);
    }
    return messages;
  }

  private line(line: string): SseMessage | null {
    if (line === "") {
      if (this.data.length === 0) {
        this.event = "";
        return null;
      }
      const message: SseMessage = {
        id: this.id ?? (this.lastId === "" ? null : this.lastId),
        event: this.event === "" ? "message" : this.event,
        data: this.data.join("\n"),
      };
      this.data = [];
      this.event = "";
      this.id = null;
      return message;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) {
      this.id = value;
      this.lastId = value;
    }
    return null;
  }
}

export interface StreamEvent {
  readonly eventId?: string;
  readonly seq: number;
  readonly type: string;
  readonly payload?: unknown;
  readonly [key: string]: unknown;
}

export type StreamStatus = "idle" | "connecting" | "live" | "reconnecting" | "closed" | "failed";

export interface StreamTransport {
  /** Resolves when the stream ends cleanly; rejects on transport or HTTP failure. */
  open(options: {
    lastEventId: string | null;
    signal: AbortSignal;
    onMessage(message: SseMessage): void;
    onOpen(): void;
  }): Promise<void>;
}

export interface StreamControllerOptions {
  readonly transport: StreamTransport;
  readonly onEvent: (event: StreamEvent) => void;
  /** Refetch authoritative state. Called on a gap, on `CURSOR_EXPIRED` and when a stream ends. */
  readonly snapshot: () => Promise<void>;
  /** The server closes the stream after a terminal event; no reconnect is attempted then. */
  readonly isTerminal?: (event: StreamEvent) => boolean;
  readonly onStatus?: (status: StreamStatus) => void;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly backoffMs?: (attempt: number) => number;
  readonly maxFailures?: number;
}

export interface StreamController {
  start(): Promise<void>;
  stop(): void;
  readonly lastSeq: () => number | null;
}

const cursorErrors = new Set(["CURSOR_EXPIRED"]);

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      resolve();
    },
    { once: true },
  );
  return promise;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
    return error.code;
  return "";
}

export function createStreamController(options: StreamControllerOptions): StreamController {
  const abort = new AbortController();
  const sleep = options.sleep ?? defaultSleep;
  const backoff = options.backoffMs ?? ((attempt) => Math.min(30_000, 500 * 2 ** attempt));
  const maxFailures = options.maxFailures ?? 8;
  let lastEventId: string | null = null;
  let lastSeq: number | null = null;
  let terminal = false;
  const status = (value: StreamStatus) => options.onStatus?.(value);

  function accept(message: SseMessage): boolean {
    let event: StreamEvent;
    try {
      event = JSON.parse(message.data) as StreamEvent;
    } catch {
      return false;
    }
    if (!Number.isSafeInteger(event.seq)) return false;
    // Duplicate or reordered delivery never regresses state or reopens a terminal result.
    if (lastSeq !== null && event.seq <= lastSeq) return false;
    const gap = lastSeq !== null && event.seq > lastSeq + 1;
    if (message.id !== null) lastEventId = message.id;
    lastSeq = event.seq;
    options.onEvent(event);
    if (options.isTerminal?.(event)) terminal = true;
    return gap;
  }

  /** Snapshot failures never end the stream; the next gap, end or expiry retries them. */
  async function refresh(): Promise<void> {
    try {
      await options.snapshot();
    } catch {
      // Reported by the snapshot owner (for example through a view state).
    }
  }

  async function start(): Promise<void> {
    let failures = 0;
    status("connecting");
    while (!abort.signal.aborted && !terminal) {
      const pending: Promise<void>[] = [];
      try {
        await options.transport.open({
          lastEventId,
          signal: abort.signal,
          onOpen: () => {
            failures = 0;
            status("live");
          },
          onMessage: (message) => {
            if (accept(message)) pending.push(refresh());
          },
        });
        await Promise.all(pending);
        if (terminal || abort.signal.aborted) break;
        // A clean end without a terminal event: resume from the last cursor.
        status("reconnecting");
        await refresh();
        await sleep(backoff(0), abort.signal);
      } catch (error) {
        await Promise.all(pending);
        if (abort.signal.aborted) break;
        if (cursorErrors.has(errorCode(error))) {
          lastEventId = null;
          await refresh();
          status("reconnecting");
          continue;
        }
        failures += 1;
        if (failures >= maxFailures) {
          status("failed");
          return;
        }
        status("reconnecting");
        await sleep(backoff(failures), abort.signal);
      }
    }
    if (terminal) await refresh();
    status("closed");
  }

  return {
    start,
    stop() {
      abort.abort();
    },
    lastSeq: () => lastSeq,
  };
}

/** Browser transport: `fetch` streaming with cookie auth. */
export function fetchTransport(
  url: string,
  fetchImplementation: typeof fetch = globalThis.fetch.bind(globalThis),
): StreamTransport {
  return {
    async open({ lastEventId, signal, onMessage, onOpen }) {
      const headers: Record<string, string> = { Accept: "text/event-stream" };
      if (lastEventId) headers["Last-Event-ID"] = lastEventId;
      const response = await fetchImplementation(url, {
        headers,
        signal,
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok || !response.body) {
        let code = "INTERNAL";
        try {
          code = ((await response.json()) as { error?: { code?: string } }).error?.code ?? code;
        } catch {
          // Non-JSON failure body: keep the generic code.
        }
        throw Object.assign(new Error(`Event stream failed with ${response.status}`), {
          code,
          status: response.status,
        });
      }
      onOpen();
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const message of parser.push(decoder.decode(value, { stream: true })))
          onMessage(message);
      }
    },
  };
}
