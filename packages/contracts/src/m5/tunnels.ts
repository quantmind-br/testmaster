import { type Static, Type } from "@sinclair/typebox";
import * as P from "../primitives.js";

/** The `Upgrade` token of a tunnel session and of a worker's tunnel stream (ADR-031). */
export const TUNNEL_PROTOCOL = "testmaster-tunnel/1";
/** A one-use open token is valid this long after the tunnel is created (SEC-042). */
export const TUNNEL_OPEN_TOKEN_TTL_SECONDS = 60;
/** The relay and the agent each send a heartbeat this often (SEC-043). */
export const TUNNEL_HEARTBEAT_INTERVAL_MS = 10_000;
/** A side that heard nothing for this many heartbeat intervals closes the session (SEC-043). */
export const TUNNEL_HEARTBEAT_MISSES = 3;
/** Revocation closes the active streams within this bound on a healthy network (SEC-043). */
export const TUNNEL_REVOKE_BOUND_MS = 5_000;
/** Largest payload of one tunnel frame. */
export const TUNNEL_FRAME_PAYLOAD_BYTES = 64 * 1024;
/** Unacknowledged bytes a stream may have in flight in each direction before its sender waits. */
export const TUNNEL_STREAM_WINDOW_BYTES = 256 * 1024;

const Count = Type.Integer({ minimum: 0 });

/** The one loopback address and port a tunnel forwards to: a literal IP, never a name (SEC-041). */
export const TunnelTarget = P.Obj({
  address: P.Enum(["127.0.0.1", "::1"]),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
});

/** A tunnel as its owner and borrowers see it; the open token is never part of it. */
export const Tunnel = P.Obj({
  id: P.id("tun"),
  projectId: P.id("prj"),
  target: TunnelTarget,
  state: P.Enum(["requested", "active", "closing", "closed", "expired", "revoked"]),
  createdBy: P.Name,
  createdAt: P.Timestamp,
  expiresAt: P.Timestamp,
  openedAt: Type.Union([P.Timestamp, Type.Null()]),
  closedAt: Type.Union([P.Timestamp, Type.Null()]),
  closeReason: Type.Union([P.Name, Type.Null()]),
  /** True while an agent session is connected and heard within the heartbeat bound (INT-024). */
  live: Type.Boolean(),
  lastHeartbeatAt: Type.Union([P.Timestamp, Type.Null()]),
  /** SHA-256 of the agent's session certificate; workers pin it for end-to-end TLS. */
  certificateSha256: Type.Union([P.ContentDigest, Type.Null()]),
  usage: P.Obj({
    streamsOpened: Count,
    streamsRefused: Count,
    activeStreams: Count,
    bytes: Count,
  }),
  version: P.Version,
});

export const tunnelContracts = {
  TunnelInput: P.Obj({
    projectId: P.id("prj"),
    target: TunnelTarget,
    /** Session lifetime; default 900, maximum 3600 (SEC-043). */
    ttlSeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 3600 })),
  }),
  Tunnel,
  /** The created tunnel and its one-use open token, shown once (SEC-042). */
  TunnelOpening: P.Obj({
    tunnel: Tunnel,
    openToken: Type.String({ pattern: "^tm_tun_[A-Za-z0-9_-]{43}$" }),
    openTokenExpiresAt: P.Timestamp,
  }),
};
export type TunnelTarget = Static<typeof TunnelTarget>;
export type TunnelView = Static<typeof Tunnel>;
export type TunnelInput = Static<typeof tunnelContracts.TunnelInput>;
export type TunnelOpening = Static<typeof tunnelContracts.TunnelOpening>;
