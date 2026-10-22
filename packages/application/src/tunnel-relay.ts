import { randomUUID } from "node:crypto";
import { type IncomingMessage, STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  ContractError,
  defaults,
  errorRegistry,
  TUNNEL_HEARTBEAT_INTERVAL_MS,
  TUNNEL_PROTOCOL,
  TUNNEL_REVOKE_BOUND_MS,
} from "@testmaster/contracts";
import { type PopProof, type PopVerifier, parsePopAuthorization } from "./proof-of-possession.js";
import {
  creditBytes,
  FrameDecoder,
  FrameType,
  FrameWriter,
  TunnelProtocolError,
  TunnelStream,
} from "./tunnel-frames.js";
import {
  TUNNEL_SILENCE_MS,
  type TunnelEnd,
  type TunnelSessionStatus,
  type TunnelSessions,
  type TunnelsService,
  type TunnelUsage,
} from "./tunnels.js";

/** The relay's own allowance of bytes above the steady rate: one second of traffic. */
const BURST_MS = 1000;
const SESSION_PATH = /^\/v1\/tunnels\/(tun_[0-9a-f-]+)\/session$/;
const STREAM_PATH = /^\/v1\/workers\/(wrk_[0-9a-f-]+)\/attempts\/(att_[0-9a-f-]+)\/tunnel$/;
const OPEN_TOKEN = /^tm_tun_[A-Za-z0-9_-]{43}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** A remote Attempt as the relay needs it: who holds it, for which Run, and when it ends. */
export interface RelayAttempt {
  readonly workerId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly settled: boolean;
  /**
   * Aborts when the controller stops holding the Attempt (settled, lease lost). A cancel request
   * does not abort it: the worker stops the Attempt itself, so its result says `cancelled`.
   */
  readonly released: AbortSignal;
  /** Throws while the Attempt's fence is no longer current. */
  assertCurrent(): void;
}

/** What the relay reads from the rest of the API process. */
export interface TunnelRelayHost {
  /** The one nonce cache of the process (ADR-031). */
  readonly proofs: PopVerifier;
  /** The workspace a tunnel belongs to, read across tenants; null when it does not exist. */
  tunnelWorkspace(tunnelId: string): string | null;
  /** The tunnel service of a workspace's system scope. */
  tunnels(workspaceId: string): TunnelsService;
  /** Resolves a signed worker call; throws `UNAUTHENTICATED` otherwise. */
  identifyWorker(
    proof: PopProof,
    request: { readonly method: string; readonly path: string },
    workerId: string,
  ): { workerId: string };
  /** The remote Attempt this process holds, if any. */
  heldAttempt(attemptId: string): RelayAttempt | undefined;
  /** The tunnel the Run was admitted through, if any. */
  runTunnel(workspaceId: string, runId: string): string | undefined;
}

/**
 * Bounds a session's aggregate rate and total bytes (SEC-044): a virtual clock makes each chunk
 * wait until the rate allows it, and the total quota ends the session once it is spent.
 */
class SessionMeter {
  private availableAt = 0;
  total = 0;
  constructor(private readonly exhausted: () => void) {}
  async take(bytes: number): Promise<void> {
    this.total += bytes;
    if (this.total > defaults.tunnelTotalBytes) {
      this.exhausted();
      throw new Error("tunnel byte quota exhausted");
    }
    const now = Date.now();
    this.availableAt =
      Math.max(this.availableAt, now - BURST_MS) + (bytes * 1000) / defaults.tunnelBytesPerSecond;
    const wait = this.availableAt - now;
    if (wait > 0) await delay(wait);
  }
}

interface RelayStream {
  readonly stream: TunnelStream;
  readonly attemptId: string;
  readonly ready: PromiseWithResolvers<void>;
  worker?: Duplex;
}

interface RelaySession {
  readonly tunnelId: string;
  readonly workspaceId: string;
  readonly socket: Duplex;
  readonly writer: FrameWriter;
  readonly streams: Map<number, RelayStream>;
  readonly meter: SessionMeter;
  nextStreamId: number;
  opened: number;
  refused: number;
  lastHeard: number;
  readonly timers: NodeJS.Timeout[];
}

class UpgradeRefusal extends Error {
  constructor(readonly failure: ContractError) {
    super(failure.message);
  }
}

/** Writes an HTTP refusal with the API's error envelope and closes the connection. */
function refuse(socket: Duplex, failure: ContractError): void {
  const status = errorRegistry[failure.code].httpStatus;
  const body = JSON.stringify({
    schemaVersion: "1.0.0",
    requestId: randomUUID(),
    error: { code: failure.code, message: failure.message, details: failure.details },
  });
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
  );
}

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
};

/**
 * The tunnel relay of one API process (ADR-031). It holds the agents' sessions and joins each
 * worker stream to the session of the tunnel its Attempt's Run was admitted through. It enforces
 * the stream, rate and byte quotas, the heartbeat and the TTL; the agent enforces the TTL and the
 * heartbeat too, so a partition ends the session on both sides. Bytes inside a stream are the
 * worker's TLS to the agent: the relay forwards ciphertext and audits metadata only.
 */
export class TunnelRelay implements TunnelSessions {
  readonly id = randomUUID();
  private readonly sessions = new Map<string, RelaySession>();

  constructor(private readonly host: TunnelRelayHost) {}

  status(tunnelId: string): TunnelSessionStatus {
    const session = this.sessions.get(tunnelId);
    if (!session) return { held: false, activeStreams: 0 };
    return { held: true, activeStreams: session.streams.size, usage: this.usage(session) };
  }

  close(tunnelId: string, state: TunnelEnd, reason: string): void {
    this.end(tunnelId, state, reason, false);
  }

  /** Ends every session, as when the process stops; the reconciler settles their rows. */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.end(id, "closed", "relay_stopped", true);
  }

  /** Takes an upgrade the relay serves; answers false for any other upgrade. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const path = request.url ?? "";
    const session = SESSION_PATH.exec(path);
    const stream = STREAM_PATH.exec(path);
    if (!session && !stream) return false;
    socket.on("error", () => socket.destroy());
    try {
      if (request.method !== "GET" || header(request, "upgrade") !== TUNNEL_PROTOCOL)
        throw new UpgradeRefusal(
          new ContractError("INVALID_ARGUMENT", `The upgrade must be GET to ${TUNNEL_PROTOCOL}`),
        );
      if (session) this.openSession(session[1] as string, request, socket, head);
      else if (stream)
        this.openStream(stream[1] as string, stream[2] as string, request, socket, head);
    } catch (error) {
      refuse(
        socket,
        error instanceof UpgradeRefusal
          ? error.failure
          : error instanceof ContractError
            ? error
            : new ContractError("INTERNAL", "Tunnel upgrade failed"),
      );
    }
    return true;
  }

  private openSession(
    tunnelId: string,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const token = header(request, "testmaster-tunnel-token");
    const certificateSha256 = header(request, "testmaster-tunnel-certificate");
    const proof = parsePopAuthorization(header(request, "testmaster-proof"));
    const unauthenticated = new ContractError(
      "UNAUTHENTICATED",
      "A valid tunnel open token and agent proof are required",
    );
    if (!token || !OPEN_TOKEN.test(token) || !certificateSha256 || !SHA256.test(certificateSha256))
      throw unauthenticated;
    // The agent's proof is signed by the key whose public half it names: the session binds it.
    if (
      !proof ||
      !this.host.proofs.verify(proof, { method: "GET", path: request.url ?? "" }, proof.keyId)
    )
      throw unauthenticated;
    const workspaceId = this.host.tunnelWorkspace(tunnelId);
    if (!workspaceId) throw unauthenticated;
    const tunnels = this.host.tunnels(workspaceId);
    const opened = tunnels.open(tunnelId, token, {
      publicKey: proof.keyId,
      certificateSha256,
      relayId: this.id,
    });
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: ${TUNNEL_PROTOCOL}\r\nconnection: Upgrade\r\n\r\n`,
    );
    const writer = new FrameWriter(socket as Duplex & { destroyed: boolean });
    const session: RelaySession = {
      tunnelId,
      workspaceId,
      socket,
      writer,
      streams: new Map(),
      meter: new SessionMeter(() => {
        tunnels.recordStream(tunnelId, "tunnel.byte_quota.denied", tunnelId);
        queueMicrotask(() => this.end(tunnelId, "closed", "quota_exhausted", true));
      }),
      nextStreamId: 1,
      opened: 0,
      refused: 0,
      lastHeard: Date.now(),
      timers: [],
    };
    this.sessions.set(tunnelId, session);
    const decoder = new FrameDecoder();
    const receive = (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) this.frame(session, frame);
      } catch (error) {
        this.end(
          tunnelId,
          "closed",
          error instanceof TunnelProtocolError ? "protocol_violation" : "relay_error",
          true,
        );
      }
    };
    socket.on("data", receive);
    socket.on("close", () => this.end(tunnelId, "closed", "agent_disconnected", true));
    session.timers.push(
      setInterval(() => {
        if (Date.now() - session.lastHeard >= TUNNEL_SILENCE_MS) {
          this.end(tunnelId, "closed", "heartbeat_lost", true);
          return;
        }
        writer.send(FrameType.heartbeat);
        this.settleSafely(() => tunnels.recordHeartbeat(tunnelId, this.usage(session)));
      }, TUNNEL_HEARTBEAT_INTERVAL_MS),
      setTimeout(
        () => this.end(tunnelId, "expired", "ttl_expired", true),
        Math.max(0, Date.parse(opened.expiresAt) - Date.now()),
      ),
    );
    writer.json(FrameType.sessionReady, 0, {
      expiresAt: opened.expiresAt,
      heartbeatIntervalMs: TUNNEL_HEARTBEAT_INTERVAL_MS,
    });
    if (head.length) receive(head);
  }

  private usage(session: RelaySession): TunnelUsage {
    return {
      streamsOpened: session.opened,
      streamsRefused: session.refused,
      bytes: session.meter.total,
    };
  }

  /** A database failure here leaves the row to the reconciler, which ends a silent session. */
  private settleSafely(write: () => unknown): void {
    try {
      write();
    } catch {
      // The reconciler closes a tunnel whose heartbeat is no longer recorded (SEC-043).
    }
  }

  private frame(
    session: RelaySession,
    frame: { type: FrameType; streamId: number; payload: Buffer },
  ) {
    session.lastHeard = Date.now();
    const entry = session.streams.get(frame.streamId);
    switch (frame.type) {
      case FrameType.heartbeat:
        return;
      case FrameType.sessionClose:
        this.end(session.tunnelId, "closed", "agent_closed", true);
        return;
      case FrameType.streamReady:
        entry?.ready.resolve();
        return;
      case FrameType.streamData:
        entry?.stream.receive(frame.payload);
        return;
      case FrameType.streamCredit:
        entry?.stream.credit(creditBytes(frame));
        return;
      case FrameType.streamEnd:
        entry?.stream.remoteEnd();
        return;
      case FrameType.streamClose:
        // A stream the agent refused before it was ready is answered with a refusal first.
        if (entry && !entry.worker) entry.ready.reject(new Error("the agent refused the stream"));
        else entry?.stream.remoteClose();
        return;
      default:
        // Only the relay opens streams and revokes; an agent sending those breaks the protocol.
        throw new TunnelProtocolError("unexpected_frame");
    }
  }

  private openStream(
    workerId: string,
    attemptId: string,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const proof = parsePopAuthorization(header(request, "authorization"));
    if (!proof) throw new ContractError("UNAUTHENTICATED", "A valid worker proof is required");
    this.host.identifyWorker(proof, { method: "GET", path: request.url ?? "" }, workerId);
    const attempt = this.host.heldAttempt(attemptId);
    if (!attempt || attempt.workerId !== workerId || attempt.settled || attempt.released.aborted)
      throw new ContractError(
        "PRECONDITION_FAILED",
        "The worker does not hold this Attempt's lease",
        {
          reasonCode: "lease_lost",
          attemptId,
        },
      );
    attempt.assertCurrent();
    const tunnelId = this.host.runTunnel(attempt.workspaceId, attempt.runId);
    const session = tunnelId ? this.sessions.get(tunnelId) : undefined;
    const tunnels = this.host.tunnels(attempt.workspaceId);
    if (!tunnelId || !session || session.workspaceId !== attempt.workspaceId) {
      if (tunnelId) tunnels.recordStream(tunnelId, "tunnel.stream.denied", attemptId);
      throw new ContractError("FORBIDDEN", "The Attempt's Run has no live tunnel on this relay", {
        reasonCode: "tunnel_lost",
        attemptId,
      });
    }
    if (session.streams.size >= defaults.tunnelStreams) {
      session.refused++;
      tunnels.recordStream(tunnelId, "tunnel.stream_quota.denied", attemptId);
      throw new ContractError("QUOTA_EXCEEDED", "The tunnel carries its maximum of streams", {
        limit: defaults.tunnelStreams,
      });
    }
    const streamId = session.nextStreamId;
    session.nextStreamId += 2;
    const stream = new TunnelStream(streamId, session.writer, (bytes) => session.meter.take(bytes));
    const entry: RelayStream = { stream, attemptId, ready: Promise.withResolvers<void>() };
    session.streams.set(streamId, entry);
    const drop = () => {
      stream.destroy();
      socket.destroy();
    };
    stream.on("close", () => {
      session.streams.delete(streamId);
      socket.destroy();
    });
    socket.on("close", () => stream.destroy());
    attempt.released.addEventListener("abort", drop, { once: true });
    stream.on("close", () => attempt.released.removeEventListener("abort", drop));
    session.writer.json(FrameType.streamOpen, streamId, {
      protocol: "tcp",
      runId: attempt.runId,
      attemptId,
    });
    entry.ready.promise.then(
      () => {
        if (socket.destroyed || stream.destroyed) return;
        session.opened++;
        tunnels.recordStream(tunnelId, "tunnel.stream.allowed", attemptId);
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nupgrade: ${TUNNEL_PROTOCOL}\r\nconnection: Upgrade\r\n\r\n`,
        );
        entry.worker = socket;
        if (head.length) stream.write(head);
        socket.pipe(stream).pipe(socket);
      },
      () => {
        // A session that ended already closed this worker's connection.
        if (socket.destroyed) return;
        session.refused++;
        tunnels.recordStream(tunnelId, "tunnel.stream.denied", attemptId);
        refuse(
          socket,
          new ContractError("PRECONDITION_FAILED", "The tunnel's target refused the connection", {
            reasonCode: "tunnel_target_unavailable",
          }),
        );
        stream.remoteClose();
      },
    );
  }

  /**
   * Ends a session: new streams are refused at once, every stream closes and the agent receives
   * `session.revoke` or `session.close`. `settle` records the end when the relay decided it.
   */
  private end(tunnelId: string, state: TunnelEnd, reason: string, settle: boolean): void {
    const session = this.sessions.get(tunnelId);
    if (!session) return;
    this.sessions.delete(tunnelId);
    for (const timer of session.timers) clearTimeout(timer);
    for (const entry of session.streams.values()) {
      entry.ready.reject(new Error("the tunnel session ended"));
      entry.stream.destroy();
      entry.worker?.destroy();
    }
    session.writer.json(state === "revoked" ? FrameType.sessionRevoke : FrameType.sessionClose, 0, {
      reason,
    });
    session.socket.end();
    // The agent closes its side on the frame; a peer that does not is cut after the bound.
    setTimeout(() => session.socket.destroy(), TUNNEL_REVOKE_BOUND_MS).unref();
    if (settle)
      this.settleSafely(() =>
        this.host.tunnels(session.workspaceId).settle(tunnelId, state, reason, this.usage(session)),
      );
  }
}
