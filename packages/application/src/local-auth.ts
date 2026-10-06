import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ContractError } from "@testmaster/contracts";
import type { Application, AuthorizationIdentity, PermissionGrant } from "./application.js";
import { auditSecurity } from "./audit.js";
import type { Scope } from "./context.js";
import { privateDirectory } from "./secrets.js";

interface TokenRecord {
  workspaceId: string;
  audience: "testmaster-local";
  identity: AuthorizationIdentity;
  expiresAt: string;
  revoked: boolean;
}
export function authenticateLocalToken(app: Application, token: string): AuthorizationIdentity {
  if (!/^tm_local_[A-Za-z0-9_-]{43}$/.test(token))
    throw new ContractError("UNAUTHENTICATED", "A valid local capability token is required");
  const hash = createHash("sha256").update(token).digest("hex");
  const row = app.database.get(
    "SELECT value FROM operational_state WHERE key=?",
    `local-token:${hash}`,
  );
  const record = row ? (JSON.parse(String(row.value)) as TokenRecord) : null;
  if (
    !record ||
    record.revoked ||
    record.workspaceId !== app.context.workspaceId ||
    record.audience !== "testmaster-local" ||
    !Number.isFinite(Date.parse(record.expiresAt)) ||
    Date.parse(record.expiresAt) <= Date.now()
  )
    throw new ContractError("UNAUTHENTICATED", "Local capability token is invalid or expired");
  const view = app.withIdentity(record.identity);
  view.context.authorize("R");
  return record.identity;
}
export async function issueLocalToken(
  app: Application,
  options: {
    scopes?: Scope[];
    tokenPath?: string;
    expiresAt?: string;
    grants?: PermissionGrant[];
  } = {},
) {
  app.context.authorize("A");
  auditSecurity(app.context, "auth.token.issue", "local-api", "requested");
  const scopes = options.scopes ?? ["R", "W", "X", "A"];
  if (scopes.some((scope) => !["R", "W", "X", "A"].includes(scope)) || !scopes.includes("R"))
    throw new ContractError("INVALID_ARGUMENT", "Local token scopes must include read");
  const membership = app.database.get(
    "SELECT role FROM memberships WHERE workspace_id=? AND principal_id=?",
    app.context.workspaceId,
    app.context.principalId,
  );
  const role = String(membership?.role);
  const grants: PermissionGrant[] =
    options.grants ??
    (["org_owner", "org_admin"].includes(role) && scopes.includes("A")
      ? [
          {
            resourceType: "Artifact",
            actions: ["raw"],
            projectIds: [],
            environmentIds: [],
            expiresAt: null,
            grantedBy: app.context.principalId,
          },
        ]
      : []);
  const tokenPath =
    options.tokenPath ?? join(app.config.home, ".local", "share", "testmaster", "server.token");
  const directory = await privateDirectory(dirname(tokenPath));
  const path = `/proc/self/fd/${directory.fd}/${basename(tokenPath)}`;
  try {
    try {
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          (stat.mode & 0o777) !== 0o600 ||
          stat.uid !== process.getuid?.() ||
          stat.size > 256
        )
          throw new ContractError("POLICY_DENIED", "Token file must be a private regular file");
        const token = (await file.readFile("utf8")).trim();
        const identity = authenticateLocalToken(app, token);
        if (JSON.stringify(identity.scopes) !== JSON.stringify(scopes))
          throw new ContractError(
            "PRECONDITION_FAILED",
            "Existing token scopes differ; use another token file",
          );
        if (JSON.stringify(identity.grants ?? []) !== JSON.stringify(grants))
          throw new ContractError(
            "PRECONDITION_FAILED",
            "Existing token grants differ; revoke it and issue a new token file",
          );
        return { token, tokenPath, identity };
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const token = `tm_local_${randomBytes(32).toString("base64url")}`;
    const hash = createHash("sha256").update(token).digest("hex");
    const identity: AuthorizationIdentity = {
      principalId: app.context.principalId,
      scopes,
      ...(options.grants !== undefined || grants.length ? { grants } : {}),
    };
    const expiresAt = options.expiresAt ?? new Date(Date.now() + 30 * 86400000).toISOString();
    if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())
      throw new ContractError("INVALID_ARGUMENT", "Token expiry must be in the future");
    const file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(`${token}\n`);
      await file.sync();
      app.database.withTx(() => {
        app.database.run(
          "INSERT INTO operational_state(key,value) VALUES(?,?)",
          `local-token:${hash}`,
          JSON.stringify({
            workspaceId: app.context.workspaceId,
            audience: "testmaster-local",
            identity,
            expiresAt,
            revoked: false,
          } satisfies TokenRecord),
        );
        auditSecurity(app.context, "auth.token.issue", "local-api", "allowed");
      });
      await directory.sync();
    } finally {
      await file.close();
    }
    return { token, tokenPath, identity };
  } finally {
    await directory.close();
  }
}
export function revokeLocalToken(app: Application, token: string): void {
  app.context.authorize("A");
  const key = `local-token:${createHash("sha256").update(token).digest("hex")}`;
  const row = app.database.get("SELECT value FROM operational_state WHERE key=?", key);
  app.database.withTx(() => {
    auditSecurity(app.context, "auth.token.revoke", "local-api", "allowed");
    if (row)
      app.database.run(
        "UPDATE operational_state SET value=? WHERE key=?",
        JSON.stringify({ ...JSON.parse(String(row.value)), revoked: true }),
        key,
      );
  });
}
