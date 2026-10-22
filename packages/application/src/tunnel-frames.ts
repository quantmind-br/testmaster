import { Duplex } from "node:stream";
import { TUNNEL_FRAME_PAYLOAD_BYTES, TUNNEL_STREAM_WINDOW_BYTES } from "@testmaster/contracts";

/** The frame types of a tunnel session (ADR-031, `specs/07-security.md` §10.1). */
export const FrameType = {
  sessionReady: 1,
  streamOpen: 2,
  streamReady: 3,
  streamData: 4,
  streamCredit: 5,
  streamEnd: 6,
  streamClose: 7,
  heartbeat: 8,
  sessionRevoke: 9,
  sessionClose: 10,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];
const frameTypes = new Set<number>(Object.values(FrameType));

/** version (1), type (1), stream id (4), sequence (4), payload length (4). */
const HEADER_BYTES = 14;
const VERSION = 1;

export interface Frame {
  readonly type: FrameType;
  readonly streamId: number;
  readonly payload: Buffer;
}

/** A frame that breaks the protocol: the session it arrived on is closed. */
export class TunnelProtocolError extends Error {
  constructor(readonly reason: string) {
    super(`tunnel protocol violation: ${reason}`);
    this.name = "TunnelProtocolError";
  }
}

export function encodeFrame(type: FrameType, streamId: number, sequence: number, payload: Buffer) {
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt8(VERSION, 0);
  header.writeUInt8(type, 1);
  header.writeUInt32BE(streamId, 2);
  header.writeUInt32BE(sequence, 6);
  header.writeUInt32BE(payload.length, 10);
  return Buffer.concat([header, payload]);
}

/**
 * Splits a byte stream into frames. Every frame must carry the next sequence number of its
 * direction, a known type and at most 64 KiB, so a peer can neither reorder, replay nor make the
 * reader buffer an unbounded frame.
 */
export class FrameDecoder {
  private buffered: Buffer = Buffer.alloc(0);
  private expected = 0;

  push(chunk: Buffer): Frame[] {
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
    const frames: Frame[] = [];
    while (this.buffered.length >= HEADER_BYTES) {
      if (this.buffered.readUInt8(0) !== VERSION) throw new TunnelProtocolError("version");
      const type = this.buffered.readUInt8(1);
      if (!frameTypes.has(type)) throw new TunnelProtocolError("type");
      const length = this.buffered.readUInt32BE(10);
      if (length > TUNNEL_FRAME_PAYLOAD_BYTES) throw new TunnelProtocolError("payload_size");
      if (this.buffered.length < HEADER_BYTES + length) break;
      const sequence = this.buffered.readUInt32BE(6);
      if (sequence !== this.expected) throw new TunnelProtocolError("sequence");
      this.expected = (this.expected + 1) >>> 0;
      frames.push({
        type: type as FrameType,
        streamId: this.buffered.readUInt32BE(2),
        payload: Buffer.from(this.buffered.subarray(HEADER_BYTES, HEADER_BYTES + length)),
      });
      this.buffered = this.buffered.subarray(HEADER_BYTES + length);
    }
    return frames;
  }
}

/** The writing side of a session: numbers every frame it sends. */
export class FrameWriter {
  private sequence = 0;
  constructor(private readonly socket: { write(chunk: Buffer): boolean; destroyed: boolean }) {}
  send(type: FrameType, streamId = 0, payload: Buffer = Buffer.alloc(0)): void {
    if (this.socket.destroyed) return;
    this.socket.write(encodeFrame(type, streamId, this.sequence, payload));
    this.sequence = (this.sequence + 1) >>> 0;
  }
  json(type: FrameType, streamId: number, value: unknown): void {
    this.send(type, streamId, Buffer.from(JSON.stringify(value)));
  }
}

/** Reads a small JSON control payload; a malformed one is a protocol violation. */
export function framePayload(frame: Frame): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(frame.payload.toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // Falls through to the violation below.
  }
  throw new TunnelProtocolError("payload");
}

/**
 * One multiplexed byte stream of a session. Writes wait while 256 KiB are unacknowledged, and
 * received bytes are acknowledged only once the reader took them and the meter let them pass, so
 * neither side buffers more than one window per stream however slowly the other reads, and a
 * metered side bounds the rate of both directions.
 */
export class TunnelStream extends Duplex {
  private inFlight = 0;
  private owed = 0;
  private waiting: (() => void) | null = null;
  private remoteEnded = false;
  private closedByPeer = false;
  /** Bytes moved in either direction, for the session's quota. */
  bytes = 0;

  constructor(
    readonly streamId: number,
    private readonly writer: FrameWriter,
    private readonly meter: (bytes: number) => Promise<void> = async () => {},
  ) {
    super({ allowHalfOpen: true });
  }
  /** Data from the peer. */
  receive(payload: Buffer): void {
    if (this.destroyed || this.remoteEnded) return;
    this.bytes += payload.length;
    if (this.push(payload)) this.acknowledge(payload.length);
    else this.owed += payload.length;
  }

  private acknowledge(bytes: number): void {
    this.meter(bytes).then(
      () => {
        if (!this.destroyed) this.writer.json(FrameType.streamCredit, this.streamId, bytes);
      },
      (error: Error) => this.destroy(error),
    );
  }

  /** The peer acknowledged `bytes`; a waiting write may go on. */
  credit(bytes: number): void {
    this.inFlight = Math.max(0, this.inFlight - bytes);
    const resume = this.waiting;
    this.waiting = null;
    resume?.();
  }

  /** The peer will send nothing more. */
  remoteEnd(): void {
    if (this.remoteEnded) return;
    this.remoteEnded = true;
    this.push(null);
  }

  /** The peer aborted the stream. */
  remoteClose(): void {
    this.closedByPeer = true;
    this.destroy();
  }

  override _read(): void {
    if (this.owed === 0) return;
    const owed = this.owed;
    this.owed = 0;
    this.acknowledge(owed);
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    void this.send(chunk).then(() => callback(), callback);
  }

  private async send(chunk: Buffer): Promise<void> {
    for (let offset = 0; offset < chunk.length; offset += TUNNEL_FRAME_PAYLOAD_BYTES) {
      const part = chunk.subarray(offset, offset + TUNNEL_FRAME_PAYLOAD_BYTES);
      while (this.inFlight + part.length > TUNNEL_STREAM_WINDOW_BYTES && !this.destroyed) {
        const { promise, resolve } = Promise.withResolvers<void>();
        this.waiting = resolve;
        await promise;
      }
      if (this.destroyed) throw new Error("tunnel stream closed");
      await this.meter(part.length);
      this.inFlight += part.length;
      this.bytes += part.length;
      this.writer.send(FrameType.streamData, this.streamId, part);
    }
  }

  override _final(callback: (error?: Error) => void): void {
    this.writer.send(FrameType.streamEnd, this.streamId);
    callback();
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    if (!this.closedByPeer) this.writer.json(FrameType.streamClose, this.streamId, {});
    const resume = this.waiting;
    this.waiting = null;
    resume?.();
    callback(error);
  }
}

/** Parses a credit frame's byte count; anything else is a protocol violation. */
export function creditBytes(frame: Frame): number {
  const value = Number(frame.payload.toString("utf8"));
  if (!Number.isSafeInteger(value) || value <= 0 || value > TUNNEL_STREAM_WINDOW_BYTES)
    throw new TunnelProtocolError("credit");
  return value;
}
