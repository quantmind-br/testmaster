import { randomUUID, timingSafeEqual } from "node:crypto";
import { ContractError } from "@testmaster/contracts";
import type { PersistenceDatabase } from "@testmaster/persistence";
import type { Application, AuthenticatedIdentity } from "./application.js";
import { auditAs } from "./audit.js";
import type { ServiceContext } from "./context.js";
import {
  assertPasswordAcceptable,
  hashPassword,
  loginPattern,
  deriveCsrfToken,
  randomToken,
  sha256Hex,
  verifyAgainstDummy,
  verifyPassword,
} from "./passwords.js";

export { deriveCsrfToken };
export const sessionPolicy = Object.freeze({
  absoluteMs: 12 * 3600_000,
  idleMs: 30 * 60_000,
  touchMs: 60_000,
});
export const lockoutPolicy = Object.freeze({
  maxFailures: 10,
  windowMs: 15 * 60_000,
  lockMs: 15 * 60_000,
});
export const recoveryTtlMs = 30 * 60_000;
export const recoveryTokenPrefix = "tm_rec_";
const invalidCredentials = () => new ContractError("UNAUTHENTICATED", "Invalid credentials");

export interface IdentityReceipt {
  principalId: string;
  state: "authenticated" | "revoked" | "pending";
  workspaceId: string | null;
  sessionId: string | null;
  csrfToken: string | null;
  expiresAt: string | null;
}
export interface LoginResult {
  receipt: IdentityReceipt;
  /** Cookie value; shown to the transport once and never persisted in clear. */
  sessionToken: string;
}
export interface SessionView {
  id: string;
  principalId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  idleExpiresAt: string;
  revokedAt: string | null;
  current: boolean;
}
export interface RecoveryGrant {
  recoveryToken: string;
  recoveryExpiresAt: string;
}
interface CredentialRow {
  workspaceId: string;
  id: string;
  principalId: string;
  login: string;
  passwordHash: string | null;
  failedCount: number;
  windowStartedAt: string | null;
  lockedUntil: string | null;
  recoveryHash: string | null;
  recoveryExpiresAt: string | null;
}
const credentialColumns =
  "workspace_id,id,principal_id,login,password_hash,failed_count,failure_window_started_at,locked_until,recovery_hash,recovery_expires_at";
const toCredential = (row: Record<string, unknown>): CredentialRow => ({
  workspaceId: String(row.workspace_id),
  id: String(row.id),
  principalId: String(row.principal_id),
  login: String(row.login),
  passwordHash: row.password_hash === null ? null : String(row.password_hash),
  failedCount: Number(row.failed_count),
  windowStartedAt: row.failure_window_started_at ? String(row.failure_window_started_at) : null,
  lockedUntil: row.locked_until ? String(row.locked_until) : null,
  recoveryHash: row.recovery_hash ? String(row.recovery_hash) : null,
  recoveryExpiresAt: row.recovery_expires_at ? String(row.recovery_expires_at) : null,
});
export function findCredentialByLogin(
  database: PersistenceDatabase,
  login: string,
): CredentialRow | null {
  const row = database.get(
    `SELECT ${credentialColumns} FROM password_credentials WHERE login=?`,
    login,
  );
  return row ? toCredential(row) : null;
}
/** Reserves a login for a principal; the password stays unset until recovery completes. */
export function insertCredential(
  database: PersistenceDatabase,
  spec: { workspaceId: string; principalId: string; login: string },
): void {
  if (!loginPattern.test(spec.login))
    throw new ContractError("INVALID_ARGUMENT", "Login must match ^[a-z0-9][a-z0-9._@-]{2,63}$");
  if (findCredentialByLogin(database, spec.login))
    throw new ContractError("PRECONDITION_FAILED", "Login is already in use");
  const now = new Date().toISOString();
  database.run(
    "INSERT INTO password_credentials(workspace_id,id,created_at,version,data_json,principal_id,login,password_hash,failed_count,updated_at) VALUES(?,?,?,?,?,?,?,NULL,0,?)",
    spec.workspaceId,
    `cred_${randomUUID()}`,
    now,
    1,
    "{}",
    spec.principalId,
    spec.login,
    now,
  );
}
/** Stores a one-time recovery token (30 minutes); the previous one stops working. */
export function issueRecoveryRow(
  database: PersistenceDatabase,
  workspaceId: string,
  principalId: string,
): RecoveryGrant {
  const token = `${recoveryTokenPrefix}${randomToken()}`;
  const expiresAt = new Date(Date.now() + recoveryTtlMs).toISOString();
  const result = database.run(
    "UPDATE password_credentials SET recovery_hash=?,recovery_expires_at=?,updated_at=? WHERE workspace_id=? AND principal_id=?",
    sha256Hex(token),
    expiresAt,
    new Date().toISOString(),
    workspaceId,
    principalId,
  );
  if (!result.changes) throw new ContractError("NOT_FOUND", "Credential does not exist");
  return { recoveryToken: token, recoveryExpiresAt: expiresAt };
}
/** Revokes every live session of a principal; returns how many were ended. */
export function revokePrincipalSessions(
  database: PersistenceDatabase,
  workspaceId: string,
  principalId: string,
  exceptSessionId?: string,
): number {
  const result = database.run(
    "UPDATE sessions SET revoked_at=? WHERE workspace_id=? AND principal_id=? AND revoked_at IS NULL AND id<>?",
    new Date().toISOString(),
    workspaceId,
    principalId,
    exceptSessionId ?? "",
  );
  return Number(result.changes);
}
interface SessionRow {
  workspaceId: string;
  id: string;
  principalId: string;
  csrfHash: string;
  expiresAt: string;
  idleExpiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}
const sessionColumns =
  "workspace_id,id,principal_id,csrf_hash,expires_at,idle_expires_at,last_seen_at,revoked_at,created_at";
const toSession = (row: Record<string, unknown>): SessionRow => ({
  workspaceId: String(row.workspace_id),
  id: String(row.id),
  principalId: String(row.principal_id),
  csrfHash: String(row.csrf_hash),
  expiresAt: String(row.expires_at),
  idleExpiresAt: String(row.idle_expires_at),
  lastSeenAt: String(row.last_seen_at),
  revokedAt: row.revoked_at ? String(row.revoked_at) : null,
});
const sessionInvalid = () => new ContractError("UNAUTHENTICATED", "Session is invalid or expired");
function liveSession(database: PersistenceDatabase, sessionToken: string): SessionRow {
  const row = database.get(
    `SELECT ${sessionColumns} FROM sessions WHERE token_hash=?`,
    sha256Hex(sessionToken),
  );
  if (!row) throw sessionInvalid();
  const session = toSession(row);
  const now = Date.now();
  if (
    session.revokedAt ||
    Date.parse(session.expiresAt) <= now ||
    Date.parse(session.idleExpiresAt) <= now
  )
    throw sessionInvalid();
  return session;
}
/**
 * Resolves a session cookie to its identity and slides the idle window at most once per minute.
 * Roles are re-read on every request, so a demoted or disabled principal loses access immediately.
 */
export function authenticateSession(app: Application, sessionToken: string): AuthenticatedIdentity {
  const system = app.controllerScope().database;
  const session = liveSession(system, sessionToken);
  const identity: AuthenticatedIdentity = {
    principalId: session.principalId,
    scopes: ["R", "W", "X", "A"],
    expiresAt: session.expiresAt,
    workspaceId: session.workspaceId,
    credential: { kind: "session", id: session.id },
  };
  app.forIdentity(identity).context.authorize("R");
  const now = Date.now();
  if (now - Date.parse(session.lastSeenAt) >= sessionPolicy.touchMs)
    system.run(
      "UPDATE sessions SET last_seen_at=?,idle_expires_at=? WHERE workspace_id=? AND id=?",
      new Date(now).toISOString(),
      new Date(Math.min(now + sessionPolicy.idleMs, Date.parse(session.expiresAt))).toISOString(),
      session.workspaceId,
      session.id,
    );
  return identity;
}
/** Constant-time check of the double-submit token a cookie session must echo in `X-CSRF-Token`. */
export function sessionCsrfMatches(
  app: Application,
  sessionId: string,
  csrfToken: string | undefined,
): boolean {
  if (!csrfToken) return false;
  const row = app
    .controllerScope()
    .database.get("SELECT csrf_hash FROM sessions WHERE id=?", sessionId);
  if (!row) return false;
  const expected = Buffer.from(String(row.csrf_hash), "hex");
  const actual = Buffer.from(sha256Hex(csrfToken), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
/** Password login, sessions, recovery and password change (ADR-017). */
export class IdentityService {
  constructor(
    private readonly ctx: ServiceContext,
    /** Controller-scope view: credentials are looked up by login before the workspace is known. */
    private readonly system: PersistenceDatabase,
    private readonly currentSessionId: string | null,
  ) {}
  private actor(credential: CredentialRow | null) {
    return {
      database: this.system,
      workspaceId: credential?.workspaceId ?? this.homeWorkspace(),
      actor: credential?.principalId ?? "unauthenticated:login",
    };
  }
  /** Failures for a login nobody owns are recorded under the oldest workspace. */
  private homeWorkspace(): string {
    return String(
      this.system.get("SELECT id FROM workspaces ORDER BY created_at LIMIT 1")?.id ?? "",
    );
  }
  private audit(
    credential: CredentialRow | null,
    action: string,
    outcome: "allowed" | "denied",
    resource: string,
  ): void {
    const who = this.actor(credential);
    if (who.workspaceId)
      auditAs(who, action, resource, outcome, this.ctx.correlationId ?? randomUUID());
  }
  private recordFailure(credential: CredentialRow): void {
    const now = Date.now();
    const windowOpen =
      credential.windowStartedAt !== null &&
      now - Date.parse(credential.windowStartedAt) < lockoutPolicy.windowMs;
    const count = (windowOpen ? credential.failedCount : 0) + 1;
    const locked = count >= lockoutPolicy.maxFailures;
    this.system.run(
      "UPDATE password_credentials SET failed_count=?,failure_window_started_at=?,locked_until=?,updated_at=? WHERE workspace_id=? AND id=?",
      locked ? 0 : count,
      locked ? null : windowOpen ? credential.windowStartedAt : new Date(now).toISOString(),
      locked ? new Date(now + lockoutPolicy.lockMs).toISOString() : credential.lockedUntil,
      new Date(now).toISOString(),
      credential.workspaceId,
      credential.id,
    );
  }
  private isLocked(credential: CredentialRow): boolean {
    return credential.lockedUntil !== null && Date.parse(credential.lockedUntil) > Date.now();
  }
  private active(credential: CredentialRow): boolean {
    const principal = this.system.get(
      "SELECT kind,disabled_at FROM principals WHERE workspace_id=? AND id=?",
      credential.workspaceId,
      credential.principalId,
    );
    const membership = this.system.get(
      "SELECT 1 AS present FROM memberships WHERE workspace_id=? AND principal_id=?",
      credential.workspaceId,
      credential.principalId,
    );
    return Boolean(principal && principal.kind === "human" && !principal.disabled_at && membership);
  }
  /** Every failure path returns the same error and does the same amount of hashing work. */
  async login(input: { principal: string; password: string }): Promise<LoginResult> {
    const login = input.principal.trim().toLowerCase();
    const credential = loginPattern.test(login) ? findCredentialByLogin(this.system, login) : null;
    if (!credential) {
      await verifyAgainstDummy(input.password);
      this.audit(null, "auth.login", "denied", `login:${sha256Hex(login).slice(0, 16)}`);
      throw invalidCredentials();
    }
    const locked = this.isLocked(credential);
    const verified =
      !locked &&
      credential.passwordHash !== null &&
      (await verifyPassword(input.password, credential.passwordHash));
    if (locked || credential.passwordHash === null) await verifyAgainstDummy(input.password);
    if (!verified || !this.active(credential)) {
      if (!locked) this.recordFailure(credential);
      this.audit(
        credential,
        locked ? "auth.login.locked" : "auth.login",
        "denied",
        credential.principalId,
      );
      throw invalidCredentials();
    }
    const now = Date.now();
    const sessionToken = randomToken();
    const csrfToken = deriveCsrfToken(sessionToken);
    const sessionId = `ses_${randomUUID()}`;
    const expiresAt = new Date(now + sessionPolicy.absoluteMs).toISOString();
    this.system.withTx(() => {
      this.system.run(
        "UPDATE password_credentials SET failed_count=0,failure_window_started_at=NULL,locked_until=NULL,updated_at=? WHERE workspace_id=? AND id=?",
        new Date(now).toISOString(),
        credential.workspaceId,
        credential.id,
      );
      this.system.run(
        "INSERT INTO sessions(workspace_id,id,created_at,version,data_json,principal_id,token_hash,csrf_hash,expires_at,idle_expires_at,last_seen_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)",
        credential.workspaceId,
        sessionId,
        new Date(now).toISOString(),
        1,
        "{}",
        credential.principalId,
        sha256Hex(sessionToken),
        sha256Hex(csrfToken),
        expiresAt,
        new Date(now + sessionPolicy.idleMs).toISOString(),
        new Date(now).toISOString(),
      );
      this.audit(credential, "auth.login", "allowed", sessionId);
    });
    return {
      sessionToken,
      receipt: {
        principalId: credential.principalId,
        state: "authenticated",
        workspaceId: credential.workspaceId,
        sessionId,
        csrfToken,
        expiresAt,
      },
    };
  }
  /** Ends the session this request authenticated with. */
  logout(): IdentityReceipt {
    if (!this.currentSessionId)
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Logout applies to browser sessions; revoke the token instead",
      );
    this.ctx.authorize("R");
    this.ctx.database.withTx(() => {
      this.ctx.database.run(
        "UPDATE sessions SET revoked_at=? WHERE workspace_id=? AND id=? AND revoked_at IS NULL",
        new Date().toISOString(),
        this.ctx.workspaceId,
        this.currentSessionId,
      );
      auditAs(
        {
          database: this.ctx.database,
          workspaceId: this.ctx.workspaceId,
          actor: this.ctx.principalId,
        },
        "auth.logout",
        this.currentSessionId as string,
        "allowed",
        this.ctx.correlationId,
      );
    });
    return {
      principalId: this.ctx.principalId,
      state: "revoked",
      workspaceId: this.ctx.workspaceId,
      sessionId: this.currentSessionId,
      csrfToken: null,
      expiresAt: null,
    };
  }
  /** The caller's own sessions; hashes are never exposed. */
  sessions(): SessionView[] {
    this.ctx.authorize("R");
    return this.ctx.database
      .all(
        `SELECT ${sessionColumns} FROM sessions WHERE workspace_id=? AND principal_id=? ORDER BY created_at DESC,id DESC LIMIT 100`,
        this.ctx.workspaceId,
        this.ctx.principalId,
      )
      .map((row) => ({
        ...toSession(row),
        createdAt: String(row.created_at),
        current: String(row.id) === this.currentSessionId,
      }))
      .map(({ workspaceId: _workspaceId, csrfHash: _csrfHash, ...view }) => view);
  }
  /** Own sessions need read; ending another member's session needs admin. */
  revokeSession(sessionId: string): void {
    this.ctx.authorize("R");
    const row = this.ctx.database.get(
      "SELECT principal_id FROM sessions WHERE workspace_id=? AND id=?",
      this.ctx.workspaceId,
      sessionId,
    );
    if (!row) throw new ContractError("NOT_FOUND", "Session does not exist");
    if (String(row.principal_id) !== this.ctx.principalId) this.ctx.authorize("A");
    this.ctx.database.withTx(() => {
      this.ctx.database.run(
        "UPDATE sessions SET revoked_at=? WHERE workspace_id=? AND id=? AND revoked_at IS NULL",
        new Date().toISOString(),
        this.ctx.workspaceId,
        sessionId,
      );
      auditAs(
        {
          database: this.ctx.database,
          workspaceId: this.ctx.workspaceId,
          actor: this.ctx.principalId,
        },
        "auth.session.revoke",
        sessionId,
        "allowed",
        this.ctx.correlationId,
      );
    });
  }
  /** Admin-issued recovery for a member; owners can only be recovered by an owner. */
  issueRecoveryToken(login: string): RecoveryGrant {
    this.ctx.authorize("A");
    const credential = findCredentialByLogin(this.system, login);
    if (!credential || credential.workspaceId !== this.ctx.workspaceId)
      throw new ContractError("NOT_FOUND", "Member does not exist");
    const target = this.ctx.database.get(
      "SELECT role FROM memberships WHERE workspace_id=? AND principal_id=?",
      this.ctx.workspaceId,
      credential.principalId,
    );
    const actor = this.ctx.database.get(
      "SELECT role FROM memberships WHERE workspace_id=? AND principal_id=?",
      this.ctx.workspaceId,
      this.ctx.principalId,
    );
    if (!target) throw new ContractError("NOT_FOUND", "Member does not exist");
    if (target.role === "org_owner" && actor?.role !== "org_owner")
      throw new ContractError("FORBIDDEN", "Only an org_owner can recover an org_owner", {
        reason: "owner_protected",
      });
    return this.ctx.database.withTx(() => {
      const grant = issueRecoveryRow(
        this.ctx.database,
        this.ctx.workspaceId,
        credential.principalId,
      );
      auditAs(
        {
          database: this.ctx.database,
          workspaceId: this.ctx.workspaceId,
          actor: this.ctx.principalId,
        },
        "auth.recovery.issue",
        credential.principalId,
        "allowed",
        this.ctx.correlationId,
      );
      return grant;
    });
  }
  /** Public: trades a one-time token for a new password and ends every session of the member. */
  async recover(input: {
    principal: string;
    recoveryToken: string;
    newPassword: string;
  }): Promise<IdentityReceipt> {
    assertPasswordAcceptable(input.newPassword);
    const login = input.principal.trim().toLowerCase();
    const credential = loginPattern.test(login) ? findCredentialByLogin(this.system, login) : null;
    if (!credential) {
      await verifyAgainstDummy(input.recoveryToken);
      this.audit(null, "auth.recovery", "denied", `login:${sha256Hex(login).slice(0, 16)}`);
      throw invalidCredentials();
    }
    const supplied = Buffer.from(sha256Hex(input.recoveryToken), "hex");
    const stored = credential.recoveryHash ? Buffer.from(credential.recoveryHash, "hex") : null;
    const valid =
      !this.isLocked(credential) &&
      stored !== null &&
      stored.length === supplied.length &&
      timingSafeEqual(stored, supplied) &&
      credential.recoveryExpiresAt !== null &&
      Date.parse(credential.recoveryExpiresAt) > Date.now() &&
      this.active(credential);
    if (!valid) {
      if (!this.isLocked(credential)) this.recordFailure(credential);
      this.audit(credential, "auth.recovery", "denied", credential.principalId);
      throw invalidCredentials();
    }
    const hash = await hashPassword(input.newPassword);
    this.system.withTx(() => {
      this.system.run(
        "UPDATE password_credentials SET password_hash=?,recovery_hash=NULL,recovery_expires_at=NULL,failed_count=0,failure_window_started_at=NULL,locked_until=NULL,updated_at=? WHERE workspace_id=? AND id=?",
        hash,
        new Date().toISOString(),
        credential.workspaceId,
        credential.id,
      );
      revokePrincipalSessions(this.system, credential.workspaceId, credential.principalId);
      this.audit(credential, "auth.recovery", "allowed", credential.principalId);
    });
    return {
      principalId: credential.principalId,
      state: "pending",
      workspaceId: credential.workspaceId,
      sessionId: null,
      csrfToken: null,
      expiresAt: null,
    };
  }
  /** Changes the caller's own password; every other session of the member ends. */
  async changePassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
    this.ctx.authorize("R");
    assertPasswordAcceptable(input.newPassword);
    const row = this.system.get(
      `SELECT ${credentialColumns} FROM password_credentials WHERE workspace_id=? AND principal_id=?`,
      this.ctx.workspaceId,
      this.ctx.principalId,
    );
    const credential = row ? toCredential(row) : null;
    const verified =
      credential !== null &&
      !this.isLocked(credential) &&
      credential.passwordHash !== null &&
      (await verifyPassword(input.currentPassword, credential.passwordHash));
    if (!credential || !verified) {
      if (credential && !this.isLocked(credential)) this.recordFailure(credential);
      this.audit(credential, "auth.password.change", "denied", this.ctx.principalId);
      throw invalidCredentials();
    }
    const hash = await hashPassword(input.newPassword);
    this.system.withTx(() => {
      this.system.run(
        "UPDATE password_credentials SET password_hash=?,failed_count=0,failure_window_started_at=NULL,updated_at=? WHERE workspace_id=? AND id=?",
        hash,
        new Date().toISOString(),
        credential.workspaceId,
        credential.id,
      );
      revokePrincipalSessions(
        this.system,
        credential.workspaceId,
        credential.principalId,
        this.currentSessionId ?? undefined,
      );
      this.audit(credential, "auth.password.change", "allowed", credential.principalId);
    });
  }
}
