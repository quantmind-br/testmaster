import { request as httpsRequest } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { TLSSocket } from "node:tls";
import {
  ContractError,
  defaults,
  TUNNEL_HEARTBEAT_INTERVAL_MS,
  TUNNEL_PROTOCOL,
  TUNNEL_REVOKE_BOUND_MS,
  type TunnelTarget,
} from "@testmaster/contracts";
import { popAuthorization, popPublicKey } from "./proof-of-possession.js";
import { remoteRefusal } from "./remote-worker-agent.js";
import { createTunnelIdentity, type TunnelIdentity } from "./tunnel-certificate.js";
import {
  creditBytes,
  type Frame,
  FrameDecoder,
  FrameType,
  FrameWriter,
  framePayload,
  TunnelProtocolError,
  TunnelStream,
} from "./tunnel-frames.js";
import { TUNNEL_SILENCE_MS } from "./tunnels.js";

export interface TunnelAgentOptions {
  /** The TestMaster server; HTTPS only. */
  endpoint: string;
  /** Trusted CA for the endpoint, beside the system roots. */
  ca?: string | Buffer;
  tunnelId: string;
  /** The one-use token `POST /tunnels` answered. */
  openToken: string;
  target: TunnelTarget;
  expiresAt: string;
  /** One line per lifecycle fact (ready, stream, closed); never a payload or token. */
  log?: (entry: Record<string, unknown>) => void;
}

interface AgentStream {
  readonly stream: TunnelStream;
  upstream?: Socket;
  secure?: TLSSocket;
}

/**
 * The agent on the developer's machine (ADR-031, SEC-041): it opens the tunnel's session to the
 * relay over HTTPS, ends each stream's TLS with a certificate made for this session and connects
 * only to the one loopback address and port the tunnel names. It enforces the TTL and the
 * heartbeat itself, so a relay it no longer hears cannot keep the target exposed.
 */
export class TunnelAgent {
  private readonly identity: TunnelIdentity;

  constructor(private readonly options: TunnelAgentOptions) {
    const { address, port } = options.target;
    // A literal loopback IP and a port only: never a name, a wildcard or a LAN interface.
    if (
      (address !== "127.0.0.1" && address !== "::1") ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new ContractError("POLICY_DENIED", "A tunnel forwards only to a loopback IP and port", {
        reasonCode: "tunnel_target_mismatch",
      });
    const lifetime = Math.max(60, Math.ceil((Date.parse(options.expiresAt) - Date.now()) / 1000));
    this.identity = createTunnelIdentity(lifetime + 60);
  }

  /** The fingerprint workers pin; the relay learns it when the session opens. */
  get certificateSha256(): string {
    return this.identity.certificateSha256;
  }

  private log(entry: Record<string, unknown>): void {
    this.options.log?.(entry);
  }

  /** Opens the session and serves it until it ends; answers why it ended. */
  async run(signal: AbortSignal): Promise<{ reason: string }> {
    const socket = await this.connect(signal);
    return this.serve(socket, signal);
  }

  private connect(signal: AbortSignal): Promise<Duplex> {
    const base = new URL(
      this.options.endpoint.endsWith("/") ? this.options.endpoint : `${this.options.endpoint}/`,
    );
    if (base.protocol !== "https:")
      throw new ContractError("INVALID_ARGUMENT", "A tunnel agent connects over HTTPS only", {
        reason: "tls_required",
      });
    const url = new URL(`v1/tunnels/${this.options.tunnelId}/session`, base);
    const publicKey = popPublicKey(this.identity.key);
    const { promise, resolve, reject } = Promise.withResolvers<Duplex>();
    const request = httpsRequest(url, {
      method: "GET",
      headers: {
        connection: "Upgrade",
        upgrade: TUNNEL_PROTOCOL,
        "testmaster-tunnel-token": this.options.openToken,
        "testmaster-tunnel-certificate": this.identity.certificateSha256,
        "testmaster-proof": popAuthorization(
          this.identity.key,
          publicKey,
          "GET",
          `${url.pathname}${url.search}`,
        ),
      },
      ...(this.options.ca ? { ca: this.options.ca } : {}),
    });
    // The signal cancels only the opening; once upgraded, `serve` closes the session cleanly.
    const cancel = () => request.destroy(new Error("tunnel start cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
    request.on("upgrade", (_response, socket, head) => {
      signal.removeEventListener("abort", cancel);
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.on("response", (response) => {
      signal.removeEventListener("abort", cancel);
      remoteRefusal(response).then(reject, reject);
    });
    request.on("error", reject);
    request.end();
    return promise;
  }

  private serve(socket: Duplex, signal: AbortSignal): Promise<{ reason: string }> {
    const { tunnelId, target } = this.options;
    const writer = new FrameWriter(socket as Duplex & { destroyed: boolean });
    const decoder = new FrameDecoder();
    const streams = new Map<number, AgentStream>();
    const done = Promise.withResolvers<{ reason: string }>();
    let lastHeard = Date.now();
    let finished = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = (reason: string, notify: boolean) => {
      if (finished) return;
      finished = true;
      for (const timer of timers) clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      for (const entry of streams.values()) {
        entry.stream.destroy();
        entry.secure?.destroy();
        entry.upstream?.destroy();
      }
      streams.clear();
      if (notify) writer.json(FrameType.sessionClose, 0, { reason });
      socket.end();
      setTimeout(() => socket.destroy(), TUNNEL_REVOKE_BOUND_MS).unref();
      this.log({ event: "tunnel.closed", tunnelId, reason });
      done.resolve({ reason });
    };
    const stop = () => finish("agent_stopped", true);
    signal.addEventListener("abort", stop, { once: true });
    const open = (streamId: number, frame: Frame) => {
      const request = framePayload(frame);
      // A stream names no destination: the agent dials only the tunnel's own target.
      if (
        request.protocol !== "tcp" ||
        streams.has(streamId) ||
        streams.size >= defaults.tunnelStreams
      ) {
        writer.json(FrameType.streamClose, streamId, {});
        return;
      }
      const entry: AgentStream = { stream: new TunnelStream(streamId, writer) };
      streams.set(streamId, entry);
      const release = () => {
        streams.delete(streamId);
        entry.stream.destroy();
        entry.secure?.destroy();
        entry.upstream?.destroy();
      };
      entry.stream.on("close", release);
      const upstream = netConnect({ host: target.address, port: target.port });
      entry.upstream = upstream;
      upstream.on("error", release);
      upstream.on("close", release);
      upstream.once("connect", () => {
        if (entry.stream.destroyed) return;
        const secure = new TLSSocket(entry.stream, {
          isServer: true,
          key: this.identity.keyPem,
          cert: this.identity.certificatePem,
          minVersion: "TLSv1.3",
        });
        entry.secure = secure;
        secure.on("error", release);
        secure.on("close", release);
        secure.pipe(upstream).pipe(secure);
        writer.send(FrameType.streamReady, streamId);
        this.log({
          event: "tunnel.stream.opened",
          tunnelId,
          streamId,
          ...(typeof request.attemptId === "string" ? { attemptId: request.attemptId } : {}),
        });
      });
    };
    const frame = (received: Frame) => {
      lastHeard = Date.now();
      const entry = streams.get(received.streamId);
      switch (received.type) {
        case FrameType.sessionReady:
          this.log({ event: "tunnel.ready", tunnelId, ...framePayload(received) });
          return;
        case FrameType.heartbeat:
          return;
        case FrameType.streamOpen:
          open(received.streamId, received);
          return;
        case FrameType.streamData:
          entry?.stream.receive(received.payload);
          return;
        case FrameType.streamCredit:
          entry?.stream.credit(creditBytes(received));
          return;
        case FrameType.streamEnd:
          entry?.stream.remoteEnd();
          return;
        case FrameType.streamClose:
          entry?.stream.remoteClose();
          return;
        case FrameType.sessionRevoke:
        case FrameType.sessionClose: {
          const reason = framePayload(received).reason;
          finish(typeof reason === "string" ? reason : "relay_closed", false);
          return;
        }
        default:
          throw new TunnelProtocolError("unexpected_frame");
      }
    };
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const received of decoder.push(chunk)) frame(received);
      } catch {
        finish("protocol_violation", true);
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => finish("relay_disconnected", false));
    timers.push(
      setInterval(() => {
        if (Date.now() - lastHeard >= TUNNEL_SILENCE_MS) {
          finish("heartbeat_lost", false);
          socket.destroy();
          return;
        }
        writer.send(FrameType.heartbeat);
      }, TUNNEL_HEARTBEAT_INTERVAL_MS),
      setTimeout(
        () => finish("ttl_expired", true),
        Math.max(0, Date.parse(this.options.expiresAt) - Date.now()),
      ),
    );
    if (signal.aborted) stop();
    return done.promise;
  }
}
