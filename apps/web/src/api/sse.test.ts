import { describe, expect, it } from "vitest";
import {
  createStreamController,
  type SseMessage,
  SseParser,
  type StreamEvent,
  type StreamStatus,
  type StreamTransport,
} from "./sse";

function frame(seq: number, type = "step.completed"): string {
  const event = { seq, type, runId: "run_1", eventId: `evt_${seq}` };
  return `id: cursor-${seq}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
}

describe("SSE parser", () => {
  it("UX-026 parses id, event and multi-line data across arbitrary chunk boundaries", () => {
    const parser = new SseParser();
    const text = ": heartbeat\n\nid: 1\nevent: a\ndata: one\ndata: two\n\nid: 2\ndata: x\r\n\r\n";
    const messages: SseMessage[] = [];
    for (const character of text) messages.push(...parser.push(character));
    expect(messages).toEqual([
      { id: "1", event: "a", data: "one\ntwo" },
      { id: "2", event: "message", data: "x" },
    ]);
  });

  it("UX-026 ignores comments and blocks without data", () => {
    const parser = new SseParser();
    expect(parser.push(": ping\n\nevent: empty\n\n")).toEqual([]);
    expect(parser.push("data: ok\n\n")).toEqual([{ id: null, event: "message", data: "ok" }]);
  });

  it("UX-026 keeps the last event id for later messages and rejects ids with NUL", () => {
    const parser = new SseParser();
    expect(parser.push("id: 5\ndata: a\n\ndata: b\n\n")).toEqual([
      { id: "5", event: "message", data: "a" },
      { id: "5", event: "message", data: "b" },
    ]);
    expect(parser.push("id: 6\0\ndata: c\n\n")).toEqual([{ id: "5", event: "message", data: "c" }]);
  });
});

interface Script {
  /** Chunks delivered to onMessage before the attempt ends. */
  readonly frames?: string[];
  readonly fail?: { code: string };
  readonly hang?: boolean;
}

function scripted(scripts: Script[]) {
  const opens: { lastEventId: string | null }[] = [];
  const transport: StreamTransport = {
    async open({ lastEventId, signal, onMessage, onOpen }) {
      opens.push({ lastEventId });
      const script = scripts.shift() ?? { frames: [] };
      if (script.fail) throw Object.assign(new Error("failed"), script.fail);
      onOpen();
      const parser = new SseParser();
      for (const text of script.frames ?? [])
        for (const message of parser.push(text)) onMessage(message);
      if (script.hang)
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    },
  };
  return { opens, transport };
}

function harness(scripts: Script[], terminal = "run.completed") {
  const { opens, transport } = scripted(scripts);
  const seen: number[] = [];
  const statuses: StreamStatus[] = [];
  let snapshots = 0;
  const controller = createStreamController({
    transport,
    onEvent: (event: StreamEvent) => seen.push(event.seq),
    snapshot: async () => {
      snapshots++;
    },
    isTerminal: (event) => event.type === terminal,
    onStatus: (status) => statuses.push(status),
    sleep: async () => undefined,
  });
  return { controller, opens, seen, statuses, snapshots: () => snapshots };
}

describe("stream controller", () => {
  it("UX-026 delivers events in order and closes after the terminal event with one snapshot", async () => {
    const h = harness([{ frames: [frame(0), frame(1), frame(2, "run.completed")] }]);
    await h.controller.start();
    expect(h.seen).toEqual([0, 1, 2]);
    expect(h.statuses.at(-1)).toBe("closed");
    expect(h.opens).toHaveLength(1);
    expect(h.snapshots()).toBe(1);
  });

  it("UX-027 drops duplicate and reordered events instead of regressing state", async () => {
    const h = harness([
      { frames: [frame(0), frame(1), frame(1), frame(0), frame(2, "run.completed"), frame(1)] },
    ]);
    await h.controller.start();
    expect(h.seen).toEqual([0, 1, 2]);
    expect(h.controller.lastSeq()).toBe(2);
  });

  it("UX-028 never delivers an event after the terminal one, even if the server repeats", async () => {
    const h = harness([{ frames: [frame(0, "run.completed"), frame(1)] }]);
    await h.controller.start();
    expect(h.seen).toEqual([0, 1]);
    expect(h.opens).toHaveLength(1);
  });

  it("UX-029 resumes with Last-Event-ID after a transport failure and keeps order", async () => {
    const h = harness([
      { frames: [frame(0), frame(1)], fail: undefined },
      { fail: { code: "NETWORK" } },
      { frames: [frame(2), frame(3, "run.completed")] },
    ]);
    await h.controller.start();
    expect(h.seen).toEqual([0, 1, 2, 3]);
    expect(h.opens.map((open) => open.lastEventId)).toEqual([null, "cursor-1", "cursor-1"]);
    expect(h.statuses).toContain("reconnecting");
  });

  it("UX-029 a sequence gap refetches the snapshot without losing later events", async () => {
    const h = harness([{ frames: [frame(0), frame(3), frame(4, "run.completed")] }]);
    await h.controller.start();
    expect(h.seen).toEqual([0, 3, 4]);
    // One snapshot for the gap, one after the terminal event.
    expect(h.snapshots()).toBe(2);
  });

  it("UX-029 CURSOR_EXPIRED drops the stale cursor, refetches and reconnects from the start", async () => {
    const h = harness([
      { frames: [frame(0), frame(1)], hang: false },
      { fail: { code: "CURSOR_EXPIRED" } },
      { frames: [frame(0), frame(1), frame(2, "run.completed")] },
    ]);
    await h.controller.start();
    expect(h.opens.map((open) => open.lastEventId)).toEqual([null, "cursor-1", null]);
    // Replayed events 0 and 1 were already applied and are not delivered twice.
    expect(h.seen).toEqual([0, 1, 2]);
    expect(h.snapshots()).toBeGreaterThanOrEqual(2);
  });

  it("UX-029 gives up with a failed status after repeated transport failures", async () => {
    const { transport } = scripted(
      Array.from({ length: 10 }, () => ({ fail: { code: "NETWORK" } })),
    );
    const statuses: StreamStatus[] = [];
    const controller = createStreamController({
      transport,
      onEvent: () => undefined,
      snapshot: async () => undefined,
      onStatus: (status) => statuses.push(status),
      sleep: async () => undefined,
      maxFailures: 3,
    });
    await controller.start();
    expect(statuses.at(-1)).toBe("failed");
  });

  it("UX-029 stop() ends a live stream without a further reconnect", async () => {
    const { opens, transport } = scripted([{ frames: [frame(0)], hang: true }]);
    const delivered = Promise.withResolvers<void>();
    const controller = createStreamController({
      transport,
      onEvent: () => delivered.resolve(),
      snapshot: async () => undefined,
      sleep: async () => undefined,
    });
    const running = controller.start();
    await delivered.promise;
    controller.stop();
    await running;
    expect(opens).toHaveLength(1);
  });

  it("UX-029 a failing snapshot does not end the stream", async () => {
    const { transport } = scripted([{ frames: [frame(0), frame(5, "run.completed")] }]);
    const seen: number[] = [];
    const controller = createStreamController({
      transport,
      onEvent: (event) => seen.push(event.seq),
      snapshot: async () => {
        throw new Error("snapshot unavailable");
      },
      isTerminal: (event) => event.type === "run.completed",
      sleep: async () => undefined,
    });
    await controller.start();
    expect(seen).toEqual([0, 5]);
  });
});
