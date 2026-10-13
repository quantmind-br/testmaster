import { randomUUID } from "node:crypto";
import { ContractError } from "@testmaster/contracts";
import type { PersistenceDatabase } from "@testmaster/persistence";
import type { Application, AuthenticatedIdentity, PermissionGrant } from "./application.js";
import type { Scope } from "./context.js";
import { randomToken, sha256Hex } from "./passwords.js";

/** Bearer-token kinds (ADR-017); every kind is stored in `server_tokens`. */
export type TokenKind = "local" | "api" | "worker" | "operator";
export const tokenPrefix: Readonly<Record<TokenKind, string>> = Object.freeze({
  local: "tm_local_",
  api: "tm_api_",
  worker: "tm_wrk_",
  operator: "tm_op_",
});
const audiences: Readonly<Record<TokenKind, string>> = Object.freeze({
  local: "testmaster-local",
  api: "testmaster-api",
  worker: "testmaster-worker",
  operator: "testmaster-operator",
});
const tokenShape = /^(tm_local|tm_api|tm_wrk|tm_op)_[A-Za-z0-9_-]{43}$/;
/** Metadata kept in `server_tokens.data_json`; the secret itself is never stored. */
export interface TokenData {
  name: string;
  kind: TokenKind;
  scopes: Scope[];
  grants: PermissionGrant[];
  audience: string;
  operator: boolean;
}
export interface NewToken {
  workspaceId: string;
  principalId: string;
  kind: TokenKind;
  name: string;
  scopes: Scope[];
  grants: PermissionGrant[];
  expiresAt: string;
  /** Pre-minted secret when the caller must persist it elsewhere before the row exists. */
  token?: string;
}
export const tokenId = (): string => `tok_${randomUUID()}`;
export function mintToken(kind: TokenKind): string {
  return `${tokenPrefix[kind]}${randomToken()}`;
}
export function tokenKind(token: string): TokenKind | null {
  if (!tokenShape.test(token)) return null;
  const kinds = Object.keys(tokenPrefix) as TokenKind[];
  return kinds.find((kind) => token.startsWith(tokenPrefix[kind])) ?? null;
}
/** Persists a new token row inside the caller's transaction and returns the one-time secret. */
export function insertToken(
  database: PersistenceDatabase,
  spec: NewToken,
): { token: string; id: string } {
  const token = spec.token ?? mintToken(spec.kind);
  const id = tokenId();
  const data: TokenData = {
    name: spec.name,
    kind: spec.kind,
    scopes: spec.scopes,
    grants: spec.grants,
    audience: audiences[spec.kind],
    operator: spec.kind === "operator",
  };
  database.run(
    "INSERT INTO server_tokens(workspace_id,id,created_at,version,data_json,principal_id,token_hash,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,NULL)",
    spec.workspaceId,
    id,
    new Date().toISOString(),
    1,
    JSON.stringify(data),
    spec.principalId,
    sha256Hex(token),
    spec.expiresAt,
  );
  return { token, id };
}
const invalid = () =>
  new ContractError("UNAUTHENTICATED", "Capability token is invalid or expired");
/**
 * Resolves a bearer token to the identity it was issued for. The lookup runs with controller
 * scope because the workspace is only known after the token is found.
 */
export function authenticateBearer(app: Application, token: string): AuthenticatedIdentity {
  const kind = tokenKind(token);
  if (!kind) throw new ContractError("UNAUTHENTICATED", "A valid capability token is required");
  if (kind === "worker") throw invalid();
  const row = app
    .controllerScope()
    .database.get(
      "SELECT workspace_id,id,data_json,principal_id,expires_at,revoked_at FROM server_tokens WHERE token_hash=?",
      sha256Hex(token),
    );
  if (
    !row ||
    row.revoked_at ||
    !Number.isFinite(Date.parse(String(row.expires_at))) ||
    Date.parse(String(row.expires_at)) <= Date.now()
  )
    throw invalid();
  const data = JSON.parse(String(row.data_json)) as TokenData;
  if (data.kind !== kind || data.audience !== audiences[kind]) throw invalid();
  const identity: AuthenticatedIdentity = {
    principalId: String(row.principal_id),
    scopes: data.scopes,
    ...(data.grants.length ? { grants: data.grants } : {}),
    expiresAt: String(row.expires_at),
    workspaceId: String(row.workspace_id),
    credential: { kind, id: String(row.id) },
  };
  if (kind === "operator") {
    const principal = app
      .controllerScope()
      .database.get(
        "SELECT disabled_at FROM principals WHERE workspace_id=? AND id=?",
        identity.workspaceId,
        identity.principalId,
      );
    if (!principal || principal.disabled_at) throw invalid();
  } else app.forIdentity(identity).context.authorize("R");
  return identity;
}
/** Marks one token revoked; later authentication, claims and SSE re-checks all fail. */
export function revokeTokenRow(
  database: PersistenceDatabase,
  workspaceId: string,
  id: string,
): boolean {
  return (
    database.run(
      "UPDATE server_tokens SET revoked_at=? WHERE workspace_id=? AND id=? AND revoked_at IS NULL",
      new Date().toISOString(),
      workspaceId,
      id,
    ).changes > 0
  );
}
