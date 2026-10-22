import { TUNNEL_FRAME_PAYLOAD_BYTES, TUNNEL_STREAM_WINDOW_BYTES } from "@testmaster/contracts";
import { describe, expect, it } from "vitest";
import {
  creditBytes,
  encodeFrame,
  type Frame,
  FrameDecoder,
  FrameType,
  FrameWriter,
  TunnelProtocolError,
  TunnelStream,
} from "./tunnel-frames.js";

/** A socket that decodes everything written to it, as the peer would. */
function wire() {
  const decoder = new FrameDecoder();
  const frames: Frame[] = [];
  const socket = {
    destroyed: false,
    write(chunk: Buffer) {
      frames.push(...decoder.push(chunk));
      return true;
    },
  };
  return { writer: new FrameWriter(socket), frames };
}

const violation = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    if (error instanceof TunnelProtocolError) return error.reason;
    throw error;
  }
  return null;
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("SEC-043 tunnel frames", () => {
  it("SEC-043 a replayed, reordered, unknown or oversized frame breaks the session", () => {
    const first = encodeFrame(FrameType.heartbeat, 0, 0, Buffer.alloc(0));
    const replay = new FrameDecoder();
    expect(replay.push(first)).toHaveLength(1);
    expect(violation(() => replay.push(first))).toBe("sequence");

    expect(
      violation(() =>
        new FrameDecoder().push(encodeFrame(FrameType.heartbeat, 0, 1, Buffer.alloc(0))),
      ),
    ).toBe("sequence");

    const unknown = encodeFrame(FrameType.heartbeat, 0, 0, Buffer.alloc(0));
    unknown.writeUInt8(99, 1);
    expect(violation(() => new FrameDecoder().push(unknown))).toBe("type");

    // Only the header of an oversized frame is needed to refuse it: the body is never buffered.
    const oversized = encodeFrame(
      FrameType.streamData,
      1,
      0,
      Buffer.alloc(TUNNEL_FRAME_PAYLOAD_BYTES + 1),
    ).subarray(0, 14);
    expect(violation(() => new FrameDecoder().push(oversized))).toBe("payload_size");

    const largest = encodeFrame(
      FrameType.streamData,
      1,
      0,
      Buffer.alloc(TUNNEL_FRAME_PAYLOAD_BYTES),
    );
    const decoder = new FrameDecoder();
    expect(decoder.push(largest.subarray(0, 100))).toEqual([]);
    expect(decoder.push(largest.subarray(100))[0]?.payload.length).toBe(TUNNEL_FRAME_PAYLOAD_BYTES);
  });

  it("SEC-043 a credit outside one window is a protocol violation", () => {
    const credit = (value: string): Frame => ({
      type: FrameType.streamCredit,
      streamId: 1,
      payload: Buffer.from(value),
    });
    expect(creditBytes(credit(String(TUNNEL_STREAM_WINDOW_BYTES)))).toBe(
      TUNNEL_STREAM_WINDOW_BYTES,
    );
    for (const value of ["0", "-1", String(TUNNEL_STREAM_WINDOW_BYTES + 1), "1.5", "x"])
      expect(violation(() => creditBytes(credit(value)))).toBe("credit");
  });

  it("SEC-043 a writer stops at one unacknowledged window and resumes on credit", async () => {
    const { writer, frames } = wire();
    const stream = new TunnelStream(1, writer);
    const data = () => frames.filter((frame) => frame.type === FrameType.streamData);
    const sent = () => data().reduce((total, frame) => total + frame.payload.length, 0);

    const written = new Promise<void>((resolve, reject) =>
      stream.write(Buffer.alloc(TUNNEL_STREAM_WINDOW_BYTES * 2), (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    await settle();
    expect(sent()).toBe(TUNNEL_STREAM_WINDOW_BYTES);
    expect(data().every((frame) => frame.payload.length <= TUNNEL_FRAME_PAYLOAD_BYTES)).toBe(true);

    stream.credit(TUNNEL_FRAME_PAYLOAD_BYTES);
    await settle();
    expect(sent()).toBe(TUNNEL_STREAM_WINDOW_BYTES + TUNNEL_FRAME_PAYLOAD_BYTES);

    stream.credit(TUNNEL_STREAM_WINDOW_BYTES);
    await written;
    expect(sent()).toBe(TUNNEL_STREAM_WINDOW_BYTES * 2);
    stream.destroy();
  });

  it("SEC-043 received bytes are acknowledged only once the reader took them and the meter let them pass", async () => {
    const { writer, frames } = wire();
    const allow = Promise.withResolvers<void>();
    const metered: number[] = [];
    const stream = new TunnelStream(1, writer, async (bytes) => {
      metered.push(bytes);
      await allow.promise;
    });
    const credits = () =>
      frames
        .filter((frame) => frame.type === FrameType.streamCredit)
        .reduce((total, frame) => total + creditBytes(frame), 0);

    const chunk = 16 * 1024;
    const buffered = stream.readableHighWaterMark;
    const total = buffered * 2;
    stream.pause();
    for (let offset = 0; offset < total; offset += chunk) stream.receive(Buffer.alloc(chunk));
    await settle();
    // Bytes pushed while the readable buffer is below its mark pass to the meter; the rest wait
    // for a read, and none is acknowledged before the meter lets it pass.
    const passed = metered.reduce((sum, bytes) => sum + bytes, 0);
    expect(passed).toBe(buffered - chunk);
    expect(credits()).toBe(0);

    allow.resolve();
    await settle();
    expect(credits()).toBe(passed);

    let read = 0;
    stream.on("data", (data: Buffer) => {
      read += data.length;
    });
    stream.resume();
    await settle();
    await settle();
    expect(read).toBe(total);
    expect(credits()).toBe(total);
    stream.destroy();
  });

  it("SEC-043 a meter that refuses received bytes aborts the stream without acknowledging them", async () => {
    const { writer, frames } = wire();
    const stream = new TunnelStream(3, writer, async () => {
      throw new Error("quota_exhausted");
    });
    const closed = new Promise<Error | undefined>((resolve) =>
      stream.once("error", (error) => resolve(error)),
    );
    stream.resume();
    stream.receive(Buffer.from("payload"));
    expect((await closed)?.message).toBe("quota_exhausted");
    expect(frames.map((frame) => frame.type)).toEqual([FrameType.streamClose]);
  });
});
