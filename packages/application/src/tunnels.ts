import { createHash, randomBytes } from "node:crypto";
import {
  ContractError,
  TUNNEL_HEARTBEAT_INTERVAL_MS,
  TUNNEL_HEARTBEAT_MISSES,
  TUNNEL_OPEN_TOKEN_TTL_SECONDS,
  type TunnelInput,
  type TunnelOpening,
  type TunnelTarget,
  type TunnelView,
  validate,
} from "@testmaster/contracts";
import { semanticHash, uuidV7IdGenerator } from "@testmaster/domain";
import { AuditRepository } from "@testmaster/persistence";
import { type RunActor, requireEntity, type ServiceContext } from "./context.js";

/** A side that heard nothing for this long closes the session (SEC-043). */
export const TUNNEL_SILENCE_MS = TUNNEL_HEARTBEAT_INTERVAL_MS * TUNNEL_HEARTBEAT_MISSES;
/** Session lifetime when the creator names none (`specs/08-operations.md`). */
const DEFAULT_TTL_SECONDS = 900;
const TERMINAL = ["closed", "expired", "revoked"] as const;
export type TunnelEnd = (typeof TERMINAL)[number];
/** The end a tunnel row records. */
export interface TunnelEndRecord {
  state: TunnelEnd;
  reason: string;
}

/** The sessions the relay of this process holds; the service reads and closes them through it. */
export interface TunnelSessions {
  /** Whether this process holds the tunnel's session, the streams it carries now and its live usage. */
  status(tunnelId: string): TunnelSessionStatus;
  /** Ends the session this process holds, if any: new streams are refused, active ones close. */
  close(tunnelId: string, state: TunnelEnd, reason: string): void;
}

/** Usage a tunnel's session accumulated; the row stores it at each heartbeat and at the end. */
export interface TunnelUsage {
  streamsOpened: number;
  streamsRefused: number;
  bytes: number;
}

export interface TunnelSessionStatus {
  held: boolean;
  activeStreams: number;
  /** Present while this process holds the session; newer than the row's heartbeat copy. */
  usage?: TunnelUsage;
}

/** What a tunnelled Attempt's dispatch names: the worker dials only this target, pinning this certificate. */
export interface TunnelDispatch {
  tunnelId: string;
  target: TunnelTarget;
  certificateSha256: string;
}

/** Hash of an open token; only the hash is stored, so a database reader cannot open a session. */
export const openTokenHash = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Tunnels (ADR-031, M5-02): a project's one-use path from remote workers to one loopback address
 * and port on a developer's machine. The row records the lifecycle the relay and the reconciler
 * settle; a tunnel that stops being active cancels every Run still bound to it with `tunnel_lost`.
 */
export class TunnelsService {
  constructor(
    readonly ctx: ServiceContext,
    private readonly sessions: () => TunnelSessions | undefined,
    /** Cancels a Run bound to a tunnel that ended (`RunsService.cancelTunnelLost`). */
    private readonly cancelRun: (runId: string) => void,
  ) {}

  private row(id: string): Record<string, unknown> {
    const row = this.ctx.database.get(
      "SELECT * FROM tunnels WHERE workspace_id=? AND id=?",
      this.ctx.workspaceId,
      id,
    );
    if (!row) throw new ContractError("NOT_FOUND", "Tunnel does not exist", { id });
    return row;
  }

  private view(row: Record<string, unknown>): TunnelView {
    const id = String(row.id);
    const status = this.sessions()?.status(id) ?? { held: false, activeStreams: 0 };
    const usage = status.usage ?? {
      streamsOpened: Number(row.streams_opened),
      streamsRefused: Number(row.streams_refused),
      bytes: Number(row.bytes_total),
    };
    const heartbeat = row.last_heartbeat_at === null ? null : String(row.last_heartbeat_at);
    const view: TunnelView = {
      id,
      projectId: String(row.project_id),
      target: {
        address: String(row.target_address) as TunnelTarget["address"],
        port: Number(row.target_port),
      },
      state: String(row.state) as TunnelView["state"],
      createdBy: String(row.created_by),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
      openedAt: row.opened_at === null ? null : String(row.opened_at),
      closedAt: row.closed_at === null ? null : String(row.closed_at),
      closeReason: row.close_reason === null ? null : String(row.close_reason),
      live:
        row.state === "active" &&
        status.held &&
        heartbeat !== null &&
        Date.now() - Date.parse(heartbeat) < TUNNEL_SILENCE_MS,
      lastHeartbeatAt: heartbeat,
      certificateSha256: row.certificate_sha256 === null ? null : String(row.certificate_sha256),
      usage: { ...usage, activeStreams: status.activeStreams },
      version: Number(row.version),
    };
    validate("Tunnel", view);
    return view;
  }

  /** Appends an audit event; `after` binds metadata such as the final usage, never a payload. */
  private audit(action: string, resourceId: string, after?: unknown, requestId?: string): void {
    new AuditRepository(this.ctx.database).append({
      workspaceId: this.ctx.workspaceId,
      createdAt: new Date().toISOString(),
      version: 1,
      actor: this.ctx.principalId || "unauthenticated:local",
      action,
      resourceId,
      requestId: requestId ?? this.ctx.correlationId ?? resourceId,
      beforeHash: null,
      afterHash: after === undefined ? null : semanticHash(after),
      timestamp: new Date().toISOString(),
    });
  }

  /** Joins the caller's transaction, such as an idempotent route's, instead of nesting one. */
  private transaction<T>(action: () => T): T {
    return this.ctx.database.inTransaction ? action() : this.ctx.database.withTx(action);
  }

  /** Creates a tunnel and its one-use open token, shown once (SEC-042). */
  create(input: TunnelInput): TunnelOpening {
    validate("TunnelInput", input);
    this.ctx.authorize("X", input.projectId);
    requireEntity(this.ctx, "Project", input.projectId);
    const now = Date.now();
    const ttlSeconds = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const id = uuidV7IdGenerator.next("tun");
    const openToken = `tm_tun_${randomBytes(32).toString("base64url")}`;
    const openTokenExpiresAt = iso(now + TUNNEL_OPEN_TOKEN_TTL_SECONDS * 1000);
    this.transaction(() => {
      this.ctx.database.run(
        "INSERT INTO tunnels(workspace_id,id,project_id,target_address,target_port,state,created_by,owner_actor_json,open_token_hash,open_token_expires_at,ttl_seconds,created_at,expires_at) VALUES(?,?,?,?,?,'requested',?,?,?,?,?,?,?)",
        this.ctx.workspaceId,
        id,
        input.projectId,
        input.target.address,
        input.target.port,
        this.ctx.principalId,
        JSON.stringify(this.ctx.actor),
        openTokenHash(openToken),
        openTokenExpiresAt,
        ttlSeconds,
        iso(now),
        iso(now + ttlSeconds * 1000),
      );
      this.audit("tunnel.create.allowed", id, input);
    });
    return { tunnel: this.view(this.row(id)), openToken, openTokenExpiresAt };
  }

  /** The tunnels of the projects the caller may execute in, newest first. */
  list(): TunnelView[] {
    this.ctx.authorize("X");
    return this.ctx.database
      .all(
        "SELECT * FROM tunnels WHERE workspace_id=? ORDER BY created_at DESC,id DESC",
        this.ctx.workspaceId,
      )
      .filter((row) => {
        try {
          this.ctx.authorize("X", String(row.project_id));
          return true;
        } catch {
          return false;
        }
      })
      .map((row) => this.view(row));
  }

  get(id: string): TunnelView {
    const row = this.row(id);
    this.ctx.authorize("X", String(row.project_id));
    return this.view(row);
  }

  /** The owner's revocation: new streams stop at once and the active ones close (SEC-043). */
  revoke(id: string): TunnelView {
    const row = this.row(id);
    this.ctx.authorize("X", String(row.project_id));
    this.settle(id, "revoked", "owner_revoked");
    return this.view(this.row(id));
  }

  /**
   * Consumes the open token and makes the tunnel active with the agent's key and certificate.
   * A token is accepted once, before it expires, for the tunnel it was issued with.
   */
  open(
    id: string,
    token: string,
    session: { publicKey: string; certificateSha256: string; relayId: string },
  ): { projectId: string; target: TunnelTarget; expiresAt: string } {
    const at = new Date().toISOString();
    const opened = this.transaction(() => {
      const changed = this.ctx.database.run(
        "UPDATE tunnels SET state='active',open_token_hash=NULL,public_key=?,certificate_sha256=?,relay_id=?,opened_at=?,last_heartbeat_at=?,version=version+1 WHERE workspace_id=? AND id=? AND state='requested' AND open_token_hash=? AND open_token_expires_at>?",
        session.publicKey,
        session.certificateSha256,
        session.relayId,
        at,
        at,
        this.ctx.workspaceId,
        id,
        openTokenHash(token),
        at,
      );
      this.audit(changed.changes ? "tunnel.open.allowed" : "tunnel.open.denied", id);
      return changed.changes === 1;
    });
    if (!opened)
      throw new ContractError("UNAUTHENTICATED", "A valid tunnel open token is required");
    const row = this.row(id);
    return {
      projectId: String(row.project_id),
      target: {
        address: String(row.target_address) as TunnelTarget["address"],
        port: Number(row.target_port),
      },
      expiresAt: String(row.expires_at),
    };
  }

  /** The relay heard the agent: the session is live, and its counters are recorded. */
  recordHeartbeat(id: string, usage: TunnelUsage): void {
    this.ctx.database.run(
      "UPDATE tunnels SET last_heartbeat_at=?,streams_opened=?,streams_refused=?,bytes_total=? WHERE workspace_id=? AND id=? AND state='active'",
      new Date().toISOString(),
      usage.streamsOpened,
      usage.streamsRefused,
      usage.bytes,
      this.ctx.workspaceId,
      id,
    );
  }

  /**
   * The end recorded for a tunnel, or null while it is live. A relay uses it to notice a tunnel
   * that another controller revoked or settled, since only the process that settles closes its
   * own session directly.
   */
  endedAs(id: string): TunnelEndRecord | null {
    const row = this.ctx.database.get(
      "SELECT state,close_reason FROM tunnels WHERE workspace_id=? AND id=?",
      this.ctx.workspaceId,
      id,
    );
    const state = String(row?.state);
    return (TERMINAL as readonly string[]).includes(state)
      ? { state: state as TunnelEnd, reason: String(row?.close_reason ?? "closed") }
      : null;
  }

  /** A stream decision of the relay: allowed, refused by the quota or refused by authority. */
  recordStream(id: string, action: string, attemptId: string): void {
    this.audit(action, id, undefined, attemptId);
  }

  /**
   * Ends a tunnel that is not yet ended: records the final usage, audits it, closes the session
   * this process holds and cancels every Run still bound to the tunnel with `tunnel_lost`.
   * Answers false when the tunnel had already ended.
   */
  settle(id: string, state: TunnelEnd, reason: string, usage?: TunnelUsage): boolean {
    const at = new Date().toISOString();
    const settled = this.transaction(() => {
      if (usage)
        this.ctx.database.run(
          "UPDATE tunnels SET streams_opened=?,streams_refused=?,bytes_total=? WHERE workspace_id=? AND id=?",
          usage.streamsOpened,
          usage.streamsRefused,
          usage.bytes,
          this.ctx.workspaceId,
          id,
        );
      const changed = this.ctx.database.run(
        "UPDATE tunnels SET state=?,closed_at=?,close_reason=?,open_token_hash=NULL,version=version+1 WHERE workspace_id=? AND id=? AND state IN ('requested','active','closing')",
        state,
        at,
        reason,
        this.ctx.workspaceId,
        id,
      );
      if (!changed.changes) return false;
      const row = this.row(id);
      this.audit(`tunnel.${state}.allowed`, id, {
        reason,
        streamsOpened: Number(row.streams_opened),
        streamsRefused: Number(row.streams_refused),
        bytes: Number(row.bytes_total),
      });
      return true;
    });
    this.sessions()?.close(id, state, reason);
    if (!settled) return false;
    for (const run of this.ctx.database.all(
      "SELECT id FROM runs WHERE workspace_id=? AND phase<>'completed' AND json_extract(data_json,'$.matrixCell.tunnelId')=?",
      this.ctx.workspaceId,
      id,
    ))
      this.cancelRun(String(run.id));
    return true;
  }

  /**
   * The reconciler's pass (SEC-043): an unopened token expires, a session ends at its TTL or
   * after three missed heartbeats, and a tunnel whose owner lost execution access is revoked.
   * Answers how many tunnels it ended.
   */
  sweep(): number {
    const now = Date.now();
    let ended = 0;
    const rows = this.ctx.database.all(
      "SELECT id,project_id,state,open_token_expires_at,expires_at,last_heartbeat_at,owner_actor_json FROM tunnels WHERE workspace_id=? AND state IN ('requested','active','closing')",
      this.ctx.workspaceId,
    );
    for (const row of rows) {
      const id = String(row.id);
      const owner = JSON.parse(String(row.owner_actor_json)) as RunActor;
      const heartbeat =
        row.last_heartbeat_at === null ? 0 : Date.parse(String(row.last_heartbeat_at));
      const end: [TunnelEnd, string] | null = !this.ctx.reauthorizeActor(
        owner,
        String(row.project_id),
      )
        ? ["revoked", "owner_revoked"]
        : row.state === "requested" && Date.parse(String(row.open_token_expires_at)) <= now
          ? ["expired", "open_token_expired"]
          : Date.parse(String(row.expires_at)) <= now
            ? ["expired", "ttl_expired"]
            : row.state !== "requested" && now - heartbeat >= TUNNEL_SILENCE_MS
              ? ["closed", "heartbeat_lost"]
              : null;
      if (end && this.settle(id, ...end)) ended++;
    }
    return ended;
  }
}

/**
 * Admits a Run through a tunnel (ADR-031): the tunnel is active, belongs to the test's project
 * and forwards to the Run's base URL; only the hardened Docker sandbox of a remote worker uses it.
 */
export function assertTunnelAdmissible(
  ctx: ServiceContext,
  id: string,
  projectId: string,
  baseUrl: string,
  executor: unknown,
): void {
  const row = ctx.database.get(
    "SELECT project_id,state,expires_at,target_address,target_port FROM tunnels WHERE workspace_id=? AND id=?",
    ctx.workspaceId,
    id,
  );
  if (!row || row.project_id !== projectId)
    throw new ContractError("NOT_FOUND", "Tunnel does not exist in the test's project", { id });
  if (row.state !== "active" || Date.parse(String(row.expires_at)) <= Date.now())
    throw new ContractError("PRECONDITION_FAILED", "The tunnel is not active", {
      reasonCode: "tunnel_lost",
      tunnelId: id,
    });
  if (executor !== "docker")
    throw new ContractError("POLICY_DENIED", "A tunnelled Run runs only in the Docker sandbox", {
      reasonCode: "security_precondition_failed",
    });
  const url = new URL(baseUrl);
  const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (host !== row.target_address || port !== Number(row.target_port))
    throw new ContractError("POLICY_DENIED", "The Run's base URL is not the tunnel's target", {
      reasonCode: "tunnel_target_mismatch",
      tunnelId: id,
    });
}

/** The tunnel an Attempt dials; a tunnel no longer active ends the claim with `tunnel_lost`. */
export function tunnelDispatch(ctx: ServiceContext, id: string): TunnelDispatch {
  const row = ctx.database.get(
    "SELECT target_address,target_port,state,certificate_sha256,expires_at FROM tunnels WHERE workspace_id=? AND id=?",
    ctx.workspaceId,
    id,
  );
  if (
    row?.state !== "active" ||
    row.certificate_sha256 === null ||
    Date.parse(String(row.expires_at)) <= Date.now()
  )
    throw new ContractError("PRECONDITION_FAILED", "The Run's tunnel is not active", {
      reasonCode: "tunnel_lost",
      tunnelId: id,
    });
  return {
    tunnelId: id,
    target: {
      address: String(row.target_address) as TunnelTarget["address"],
      port: Number(row.target_port),
    },
    certificateSha256: String(row.certificate_sha256),
  };
}

/** The tunnel a Run was admitted through, if any. */
export function runTunnelId(run: { readonly matrixCell?: unknown }): string | undefined {
  const cell = run.matrixCell;
  if (!cell || typeof cell !== "object" || !("tunnelId" in cell)) return undefined;
  return typeof cell.tunnelId === "string" ? cell.tunnelId : undefined;
}
