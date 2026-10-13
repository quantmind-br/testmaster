import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ARTIFACT_LINK_TTL_SECONDS, type ArtifactLink, ContractError } from "@testmaster/contracts";
import { canonicalJson } from "@testmaster/domain";
import type { PersistenceDatabase } from "@testmaster/persistence";
import type { Application, AuthenticatedIdentity, PermissionGrant } from "./application.js";
import { auditSecurity } from "./audit.js";
import { requireEntity, type Scope, type ServiceContext } from "./context.js";
import type { RunsService } from "./runs.js";
import type { TokenData, TokenKind } from "./tokens.js";

export type ArtifactDisposition = "inline" | "attachment";
const maxLinkLength = 2048;
interface LinkClaims {
  /** Claim format version. */
  v: 1;
  w: string;
  a: string;
  m: "GET";
  d: ArtifactDisposition;
  /** Expiry, milliseconds since the epoch. */
  exp: number;
  n: string;
  p: string;
  k: string;
  c: string;
}
export interface ResolvedArtifactLink {
  identity: AuthenticatedIdentity;
  disposition: ArtifactDisposition;
  expiresAt: string;
}
const sign = (key: Buffer, payload: string) =>
  createHmac("sha256", key).update(payload).digest("base64url");

function linkKey(
  database: PersistenceDatabase,
  workspaceId: string,
  create: boolean,
): Buffer | null {
  const name = `link-key:${workspaceId}`;
  const read = () => database.get("SELECT value FROM operational_state WHERE key=?", name);
  const existing = read();
  if (existing) return Buffer.from(String(existing.value), "base64url");
  if (!create) return null;
  const value = database.withTx(() => {
    const row = read();
    if (row) return String(row.value);
    const fresh = randomBytes(32).toString("base64url");
    database.run("INSERT INTO operational_state(key,value) VALUES(?,?)", name, fresh);
    return fresh;
  });
  return Buffer.from(value, "base64url");
}

/** True when the artifact was tombstoned, expired or its access revoked by retention. */
export function artifactRevoked(
  database: PersistenceDatabase,
  workspaceId: string,
  artifact: { id: string; state?: unknown },
): boolean {
  return (
    artifact.state === "expired" ||
    Boolean(
      database.get(
        "SELECT 1 FROM operational_state WHERE key=?",
        `retention:artifact:${workspaceId}:${artifact.id}`,
      ),
    )
  );
}

const unauthenticated = (reason: "link_missing" | "link_invalid" | "link_expired") =>
  new ContractError("UNAUTHENTICATED", "Artifact link is missing, invalid or expired", { reason });

/**
 * Signed artifact gateway links (UX-032, ADR-018). A link is a capability for one artifact and
 * one method, valid for five minutes. It carries no secret value: it names the credential that
 * minted it, and every use re-reads that credential, the caller's role and the artifact's
 * tombstone, so revoking a session, demoting a member or deleting the artifact ends the link at once.
 */
export class ArtifactLinksService {
  constructor(
    readonly ctx: ServiceContext,
    readonly runs: RunsService,
    readonly now: () => number = Date.now,
  ) {}

  issue(artifactId: string, disposition: ArtifactDisposition = "inline"): ArtifactLink {
    const artifact = requireEntity(this.ctx, "Artifact", artifactId);
    const run = this.runs.get(String(artifact.runId));
    const test = requireEntity(this.ctx, "TestCase", run.testId);
    const projectId = String(test.projectId);
    this.ctx.authorize("R", projectId);
    const actor = this.ctx.actor;
    if (!actor.credentialKind || !actor.credentialId || actor.credentialKind === "system")
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Artifact links need an authenticated credential",
      );
    if (artifactRevoked(this.ctx.database, this.ctx.workspaceId, artifact))
      throw new ContractError("NOT_FOUND", "Artifact access revoked");
    if (artifact.state !== "available")
      throw new ContractError("NOT_FOUND", "Artifact unavailable", { state: artifact.state });
    if (artifact.redactionStatus === "restrictedRaw") {
      auditSecurity(this.ctx, "artifact.link", artifactId, "denied");
      throw new ContractError(
        "FORBIDDEN",
        "Restricted raw evidence is not available through the portal gateway",
        { reason: "restricted_raw" },
      );
    }
    const key = linkKey(this.ctx.database, this.ctx.workspaceId, true) as Buffer;
    const expires = this.now() + ARTIFACT_LINK_TTL_SECONDS * 1000;
    const claims: LinkClaims = {
      v: 1,
      w: this.ctx.workspaceId,
      a: artifactId,
      m: "GET",
      d: disposition,
      exp: expires,
      n: randomBytes(9).toString("base64url"),
      p: actor.principalId,
      k: actor.credentialKind,
      c: actor.credentialId,
    };
    const payload = Buffer.from(canonicalJson(claims)).toString("base64url");
    const token = `${payload}.${sign(key, payload)}`;
    auditSecurity(this.ctx, "artifact.link", artifactId, "allowed");
    return {
      artifactId,
      method: "GET",
      disposition,
      url: `/v1/artifacts/${artifactId}/content?link=${token}`,
      expiresAt: new Date(expires).toISOString(),
      ttlSeconds: ARTIFACT_LINK_TTL_SECONDS,
    };
  }
}

/**
 * Verifies a link for `artifactId` and rebuilds the minting credential's identity from live
 * state. Expiry is checked after the signature so a forged link never learns anything.
 */
export function resolveArtifactLink(
  app: Application,
  artifactId: string,
  token: string | undefined,
  now: () => number = Date.now,
): ResolvedArtifactLink {
  if (!token) throw unauthenticated("link_missing");
  if (token.length > maxLinkLength) throw unauthenticated("link_invalid");
  const [payload, signature, ...extra] = token.split(".");
  if (!payload || !signature || extra.length) throw unauthenticated("link_invalid");
  let claims: LinkClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as LinkClaims;
  } catch {
    throw unauthenticated("link_invalid");
  }
  if (
    claims?.v !== 1 ||
    typeof claims.w !== "string" ||
    typeof claims.a !== "string" ||
    typeof claims.p !== "string" ||
    typeof claims.k !== "string" ||
    typeof claims.c !== "string" ||
    !Number.isFinite(claims.exp)
  )
    throw unauthenticated("link_invalid");
  const system = app.controllerScope().database;
  const key = linkKey(system, claims.w, false);
  if (!key) throw unauthenticated("link_invalid");
  const expected = Buffer.from(sign(key, payload), "base64url");
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected))
    throw unauthenticated("link_invalid");
  // The artifact in the path must be the one the link was minted for; one link, one resource.
  if (claims.a !== artifactId || claims.m !== "GET") throw unauthenticated("link_invalid");
  if (claims.exp <= now()) throw unauthenticated("link_expired");
  const disposition = claims.d === "attachment" ? "attachment" : "inline";
  const identity = credentialIdentity(app, system, claims);
  return { identity, disposition, expiresAt: new Date(claims.exp).toISOString() };
}

function credentialIdentity(
  app: Application,
  database: PersistenceDatabase,
  claims: LinkClaims,
): AuthenticatedIdentity {
  const dead = () => unauthenticated("link_invalid");
  let scopes: Scope[] = ["R", "W", "X", "A"];
  let grants: PermissionGrant[] = [];
  let expiresAt: string;
  if (claims.k === "session") {
    const row = database.get(
      "SELECT principal_id,expires_at,revoked_at FROM sessions WHERE workspace_id=? AND id=?",
      claims.w,
      claims.c,
    );
    if (
      !row ||
      row.revoked_at ||
      row.principal_id !== claims.p ||
      Date.parse(String(row.expires_at)) <= Date.now()
    )
      throw dead();
    expiresAt = String(row.expires_at);
  } else {
    const row = database.get(
      "SELECT principal_id,data_json,expires_at,revoked_at FROM server_tokens WHERE workspace_id=? AND id=?",
      claims.w,
      claims.c,
    );
    if (
      !row ||
      row.revoked_at ||
      row.principal_id !== claims.p ||
      Date.parse(String(row.expires_at)) <= Date.now()
    )
      throw dead();
    const data = JSON.parse(String(row.data_json)) as TokenData;
    if (data.kind !== claims.k) throw dead();
    scopes = data.scopes;
    grants = data.grants;
    expiresAt = String(row.expires_at);
  }
  if (!scopes.includes("R")) throw dead();
  const identity: AuthenticatedIdentity = {
    principalId: claims.p,
    scopes,
    ...(grants.length ? { grants } : {}),
    expiresAt,
    workspaceId: claims.w,
    credential: { kind: claims.k as TokenKind | "session", id: claims.c },
  };
  try {
    // Membership and role are re-read, so a removed or disabled member loses the link too.
    app.forIdentity(identity).context.authorize("R");
  } catch (error) {
    if (error instanceof ContractError) throw dead();
    throw error;
  }
  return identity;
}
