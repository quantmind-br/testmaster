import { randomUUID } from "node:crypto";
import { ContractError, type Role, rbacMatrix } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import {
  EntityRepository,
  type EntityDocument,
  type PersistenceDatabase,
} from "@testmaster/persistence";
import type { Application, AuthenticatedIdentity, PermissionGrant } from "./application.js";
import { auditAs } from "./audit.js";
import type { Scope, ServiceContext } from "./context.js";
import {
  insertCredential,
  issueRecoveryRow,
  type RecoveryGrant,
  revokePrincipalSessions,
} from "./identity.js";
import { resolveIssuance } from "./local-auth.js";
import { loginPattern } from "./passwords.js";
import { isPostgres } from "./tenancy.js";
import { insertToken, revokeTokenRow, type TokenData } from "./tokens.js";

const systemPrincipalKey = (workspaceId: string) => `system-principal:${workspaceId}`;
const operatorPrincipalKey = "operator-principal";
const roleOrder = Object.keys(rbacMatrix) as Role[];
const isRole = (value: string): value is Role => (roleOrder as string[]).includes(value);

export interface ProvisionInput {
  name: string;
  mode: "single-user" | "server" | "distributed";
  ownerLogin: string;
  ownerDisplayName?: string;
  quotaPolicyId?: string;
  settingsVersion?: number;
}
export interface ProvisionedWorkspace {
  workspace: EntityDocument;
  ownerPrincipalId: string;
  ownerLogin: string;
  ownerRecovery: RecoveryGrant;
  systemPrincipalId: string;
}
/**
 * Creates a workspace with its first owner and the controller's system principal in one
 * transaction. Callers decide who may do this: the host operator or an operator token.
 */
export function provisionWorkspace(
  database: PersistenceDatabase,
  input: ProvisionInput,
): ProvisionedWorkspace {
  const entities = new EntityRepository(database);
  const workspaceId = uuidV7IdGenerator.next("ws");
  const ownerPrincipalId = uuidV7IdGenerator.next("usr");
  const systemPrincipalId = uuidV7IdGenerator.next("svc");
  return database.withTx(() => {
    entities.insert("Workspace", {
      id: workspaceId,
      workspaceId,
      name: input.name,
      mode: input.mode,
      settingsVersion: input.settingsVersion ?? 1,
      quotaPolicyId: input.quotaPolicyId ?? "default",
    });
    entities.insert("Principal", {
      id: ownerPrincipalId,
      workspaceId,
      kind: "human",
      displayName: input.ownerDisplayName ?? input.ownerLogin,
      disabledAt: null,
    });
    entities.insert("Membership", {
      id: uuidV7IdGenerator.next("mem"),
      workspaceId,
      principalId: ownerPrincipalId,
      role: "org_owner",
      projectRestrictions: [],
    });
    insertCredential(database, {
      workspaceId,
      principalId: ownerPrincipalId,
      login: input.ownerLogin,
    });
    const ownerRecovery = issueRecoveryRow(database, workspaceId, ownerPrincipalId);
    // Controller loops act inside the workspace as this credential-less service principal.
    entities.insert("Principal", {
      id: systemPrincipalId,
      workspaceId,
      kind: "service",
      displayName: "TestMaster controller",
      disabledAt: null,
    });
    entities.insert("Membership", {
      id: uuidV7IdGenerator.next("mem"),
      workspaceId,
      principalId: systemPrincipalId,
      role: "org_owner",
      projectRestrictions: [],
    });
    database.run(
      "INSERT INTO operational_state(key,value) VALUES(?,?)",
      systemPrincipalKey(workspaceId),
      systemPrincipalId,
    );
    const workspace = entities.get("Workspace", workspaceId, workspaceId) as EntityDocument;
    return {
      workspace,
      ownerPrincipalId,
      ownerLogin: input.ownerLogin,
      ownerRecovery,
      systemPrincipalId,
    };
  });
}
/** The credential-less principal controller loops use inside one workspace. */
export function systemPrincipalId(database: PersistenceDatabase, workspaceId: string): string {
  const row = database.get(
    "SELECT value FROM operational_state WHERE key=?",
    systemPrincipalKey(workspaceId),
  );
  if (!row)
    throw new ContractError("PRECONDITION_FAILED", "Workspace has no controller principal", {
      workspaceId,
    });
  return String(row.value);
}
const stateKey = (database: PersistenceDatabase, key: string): string | undefined => {
  const value = database.get("SELECT value FROM operational_state WHERE key=?", key)?.value;
  return value === undefined ? undefined : String(value);
};
function requireRole(ctx: ServiceContext): Role {
  const row = ctx.database.get(
    "SELECT role FROM memberships WHERE workspace_id=? AND principal_id=?",
    ctx.workspaceId,
    ctx.principalId,
  );
  const role = String(row?.role);
  if (!isRole(role)) throw new ContractError("FORBIDDEN", "Workspace membership is required");
  return role;
}
function expected(current: EntityDocument | null | undefined, version: number | undefined): void {
  if (version !== undefined && current?.version !== version)
    throw new ContractError("REVISION_CONFLICT", "Entity version changed", {
      currentVersion: current?.version,
    });
}
/** Host-trust operations: no RBAC, performed by whoever controls the server config and database. */
export class OperatorService {
  constructor(private readonly system: PersistenceDatabase) {}
  private audit(workspaceId: string, action: string, resourceId: string): void {
    auditAs(
      { database: this.system, workspaceId, actor: "host-operator" },
      action,
      resourceId,
      "allowed",
    );
  }
  /** Creates the first workspace and owner; refused once any workspace exists. */
  bootstrap(input: {
    workspaceName: string;
    ownerLogin: string;
    ownerDisplayName?: string;
  }): ProvisionedWorkspace {
    if (this.system.get("SELECT id FROM workspaces LIMIT 1"))
      throw new ContractError("PRECONDITION_FAILED", "Server is already bootstrapped");
    const result = provisionWorkspace(this.system, {
      name: input.workspaceName,
      mode: "server",
      ownerLogin: input.ownerLogin,
      ...(input.ownerDisplayName ? { ownerDisplayName: input.ownerDisplayName } : {}),
    });
    this.audit(String(result.workspace.id), "server.bootstrap", String(result.workspace.id));
    return result;
  }
  /** A `tm_op_` token that may create workspaces; it carries no workspace membership. */
  operatorToken(options: { expiresAt?: string } = {}): {
    token: string;
    id: string;
    expiresAt: string;
  } {
    const home = this.system.get("SELECT id FROM workspaces ORDER BY created_at LIMIT 1");
    if (!home) throw new ContractError("PRECONDITION_FAILED", "Bootstrap the server first");
    const workspaceId = String(home.id);
    const expiresAt = options.expiresAt ?? new Date(Date.now() + 30 * 86400000).toISOString();
    if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())
      throw new ContractError("INVALID_ARGUMENT", "Token expiry must be in the future");
    return this.system.withTx(() => {
      let principalId = stateKey(this.system, operatorPrincipalKey);
      if (!principalId) {
        principalId = uuidV7IdGenerator.next("svc");
        new EntityRepository(this.system).insert("Principal", {
          id: principalId,
          workspaceId,
          kind: "service",
          displayName: "Host operator",
          disabledAt: null,
        });
        this.system.run(
          "INSERT INTO operational_state(key,value) VALUES(?,?)",
          operatorPrincipalKey,
          principalId,
        );
      }
      const issued = insertToken(this.system, {
        workspaceId,
        principalId: String(principalId),
        kind: "operator",
        name: "operator",
        scopes: ["R", "A"],
        grants: [],
        expiresAt,
      });
      this.audit(workspaceId, "server.operator-token", issued.id);
      return { ...issued, expiresAt };
    });
  }
  /** One-time recovery token for any member, for operators locked out of every owner account. */
  recoveryToken(login: string): RecoveryGrant & { principalId: string; workspaceId: string } {
    const row = this.system.get(
      "SELECT workspace_id,principal_id FROM password_credentials WHERE login=?",
      login,
    );
    if (!row) throw new ContractError("NOT_FOUND", "Login does not exist");
    const workspaceId = String(row.workspace_id);
    const principalId = String(row.principal_id);
    return this.system.withTx(() => {
      const grant = issueRecoveryRow(this.system, workspaceId, principalId);
      this.audit(workspaceId, "auth.recovery.issue", principalId);
      return { ...grant, principalId, workspaceId };
    });
  }
  workspaceIds(): string[] {
    return this.system
      .all("SELECT id FROM workspaces ORDER BY created_at")
      .map((row) => String(row.id));
  }
}
export class WorkspacesService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly system: PersistenceDatabase,
    private readonly credential: AuthenticatedIdentity["credential"] | null,
  ) {}
  private get operator(): boolean {
    return this.credential?.kind === "operator";
  }
  list(): EntityDocument[] {
    if (this.operator) {
      return this.system
        .all("SELECT id FROM workspaces ORDER BY created_at,id")
        .map(
          (row) =>
            new EntityRepository(this.system).get(
              "Workspace",
              String(row.id),
              String(row.id),
            ) as EntityDocument,
        );
    }
    this.ctx.authorize("R");
    return [this.get(this.ctx.workspaceId)];
  }
  get(id: string): EntityDocument {
    if (!this.operator) {
      this.ctx.authorize("R");
      if (id !== this.ctx.workspaceId)
        throw new ContractError("NOT_FOUND", "Workspace does not exist");
    }
    const found = new EntityRepository(this.system).get("Workspace", id, id);
    if (!found) throw new ContractError("NOT_FOUND", "Workspace does not exist");
    return found;
  }
  /** Only a `tm_op_` token may create workspaces, and only on the multi-tenant PostgreSQL profile. */
  create(input: {
    name?: string;
    ownerLogin?: string;
    ownerDisplayName?: string;
    quotaPolicyId?: string;
    settingsVersion?: number;
  }): ProvisionedWorkspace {
    if (!this.operator)
      throw new ContractError("FORBIDDEN", "Creating a workspace needs an operator token", {
        reason: "operator_required",
      });
    if (!isPostgres(this.system))
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Multiple workspaces need the PostgreSQL server profile",
      );
    if (!input.name || !input.ownerLogin)
      throw new ContractError("INVALID_ARGUMENT", "name and ownerLogin are required");
    const provisioned = provisionWorkspace(this.system, {
      name: input.name,
      mode: "server",
      ownerLogin: input.ownerLogin,
      ...(input.ownerDisplayName ? { ownerDisplayName: input.ownerDisplayName } : {}),
      ...(input.quotaPolicyId ? { quotaPolicyId: input.quotaPolicyId } : {}),
      ...(input.settingsVersion ? { settingsVersion: input.settingsVersion } : {}),
    });
    auditAs(
      {
        database: this.system,
        workspaceId: String(provisioned.workspace.id),
        actor: this.ctx.principalId,
      },
      "workspace.create",
      String(provisioned.workspace.id),
      "allowed",
      this.ctx.correlationId,
    );
    return provisioned;
  }
  update(
    id: string,
    patch: { name?: string; settingsVersion?: number; quotaPolicyId?: string },
    expectedVersion: number,
  ): EntityDocument {
    this.ctx.authorize("A");
    if (id !== this.ctx.workspaceId)
      throw new ContractError("NOT_FOUND", "Workspace does not exist");
    return this.ctx.database.withTx(() => {
      const current = this.ctx.entities.get("Workspace", id, id);
      if (!current) throw new ContractError("NOT_FOUND", "Workspace does not exist");
      expected(current, expectedVersion);
      const next = {
        ...current,
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.settingsVersion ? { settingsVersion: patch.settingsVersion } : {}),
        ...(patch.quotaPolicyId ? { quotaPolicyId: patch.quotaPolicyId } : {}),
        version: expectedVersion + 1,
      };
      this.ctx.entities.update("Workspace", id, id, expectedVersion, next);
      auditAs(
        { database: this.ctx.database, workspaceId: id, actor: this.ctx.principalId },
        "workspace.update",
        id,
        "allowed",
        this.ctx.correlationId,
      );
      return next;
    });
  }
}
export interface MemberView {
  id: string;
  principalId: string;
  login: string | null;
  displayName: string;
  role: Role;
  projectRestrictions: string[];
  disabledAt: string | null;
  createdAt: string;
  version: number;
}
const memberSelect = `SELECT m.id AS id,m.principal_id AS principal_id,m.role AS role,m.data_json AS data_json,m.created_at AS created_at,m.version AS version,p.display_name AS display_name,p.disabled_at AS disabled_at,c.login AS login
  FROM memberships m JOIN principals p ON p.workspace_id=m.workspace_id AND p.id=m.principal_id
  LEFT JOIN password_credentials c ON c.workspace_id=m.workspace_id AND c.principal_id=m.principal_id`;
function toMember(row: Record<string, unknown>): MemberView {
  const data = JSON.parse(String(row.data_json)) as { projectRestrictions?: string[] };
  return {
    id: String(row.id),
    principalId: String(row.principal_id),
    login: row.login ? String(row.login) : null,
    displayName: String(row.display_name),
    role: String(row.role) as Role,
    projectRestrictions: data.projectRestrictions ?? [],
    disabledAt: row.disabled_at ? String(row.disabled_at) : null,
    createdAt: String(row.created_at),
    version: Number(row.version),
  };
}
export class MembersService {
  constructor(private readonly ctx: ServiceContext) {}
  private workspace(workspaceId: string): void {
    if (workspaceId !== this.ctx.workspaceId)
      throw new ContractError("NOT_FOUND", "Workspace does not exist");
  }
  private audit(action: string, resourceId: string): void {
    auditAs(
      {
        database: this.ctx.database,
        workspaceId: this.ctx.workspaceId,
        actor: this.ctx.principalId,
      },
      action,
      resourceId,
      "allowed",
      this.ctx.correlationId,
    );
  }
  list(workspaceId: string): MemberView[] {
    this.ctx.authorize("A");
    this.workspace(workspaceId);
    return this.ctx.database
      .all(
        `${memberSelect} WHERE m.workspace_id=? AND m.principal_id<>COALESCE((SELECT value FROM operational_state WHERE key=?),'') ORDER BY m.created_at,m.id`,
        this.ctx.workspaceId,
        systemPrincipalKey(this.ctx.workspaceId),
      )
      .map(toMember);
  }
  private find(memberId: string): MemberView {
    const row = this.ctx.database.get(
      `${memberSelect} WHERE m.workspace_id=? AND m.id=?`,
      this.ctx.workspaceId,
      memberId,
    );
    if (!row) throw new ContractError("NOT_FOUND", "Member does not exist");
    return toMember(row);
  }
  /** Humans get a login plus a one-time recovery token; service accounts only reserve the login. */
  add(
    workspaceId: string,
    input: { login: string; displayName: string; role: Role; projectRestrictions: string[] },
  ): { member: MemberView; recovery: RecoveryGrant | null } {
    this.ctx.authorize("A");
    this.workspace(workspaceId);
    if (!loginPattern.test(input.login))
      throw new ContractError("INVALID_ARGUMENT", "Login must match ^[a-z0-9][a-z0-9._@-]{2,63}$");
    if (input.role === "org_owner" && requireRole(this.ctx) !== "org_owner")
      throw new ContractError("FORBIDDEN", "Only an org_owner can add an org_owner", {
        reason: "owner_protected",
      });
    for (const projectId of input.projectRestrictions)
      if (!this.ctx.entities.get("Project", this.ctx.workspaceId, projectId))
        throw new ContractError("NOT_FOUND", "Project does not exist", { projectId });
    const human = input.role !== "service_account";
    const principalId = uuidV7IdGenerator.next(human ? "usr" : "svc");
    return this.ctx.database.withTx(() => {
      this.ctx.entities.insert("Principal", {
        id: principalId,
        workspaceId: this.ctx.workspaceId,
        kind: human ? "human" : "service",
        displayName: input.displayName,
        disabledAt: null,
      });
      const membershipId = uuidV7IdGenerator.next("mem");
      this.ctx.entities.insert("Membership", {
        id: membershipId,
        workspaceId: this.ctx.workspaceId,
        principalId,
        role: input.role,
        projectRestrictions: input.projectRestrictions,
      });
      insertCredential(this.ctx.database, {
        workspaceId: this.ctx.workspaceId,
        principalId,
        login: input.login,
      });
      const recovery = human
        ? issueRecoveryRow(this.ctx.database, this.ctx.workspaceId, principalId)
        : null;
      this.audit("member.add", membershipId);
      return { member: this.find(membershipId), recovery };
    });
  }
  /**
   * Guards shared by update and remove. The last-owner rule runs first so the only owner always
   * hears that the workspace needs an owner; otherwise self changes are refused as promotion.
   */
  private guard(target: MemberView, nextRole: Role | null, removesAccess: boolean): void {
    if (target.role === "org_owner" && (removesAccess || (nextRole && nextRole !== "org_owner"))) {
      const owners = this.ctx.database.get(
        "SELECT COUNT(*) AS n FROM memberships m JOIN principals p ON p.workspace_id=m.workspace_id AND p.id=m.principal_id WHERE m.workspace_id=? AND m.role='org_owner' AND p.disabled_at IS NULL AND p.id<>COALESCE((SELECT value FROM operational_state WHERE key=?),'')",
        this.ctx.workspaceId,
        systemPrincipalKey(this.ctx.workspaceId),
      );
      if (Number(owners?.n) <= 1)
        throw new ContractError("PRECONDITION_FAILED", "Workspace needs an org_owner");
    }
    if (target.principalId === this.ctx.principalId)
      throw new ContractError("FORBIDDEN", "Members cannot change their own membership", {
        reason: "self_promotion",
      });
    if (
      (target.role === "org_owner" || nextRole === "org_owner") &&
      requireRole(this.ctx) !== "org_owner"
    )
      throw new ContractError("FORBIDDEN", "Only an org_owner can change org_owner memberships", {
        reason: "owner_protected",
      });
  }
  update(
    workspaceId: string,
    memberId: string,
    patch: { role?: Role; projectRestrictions?: string[]; disabled?: boolean },
    expectedVersion: number,
  ): MemberView {
    this.ctx.authorize("A");
    this.workspace(workspaceId);
    const target = this.find(memberId);
    this.guard(target, patch.role ?? null, patch.disabled === true);
    for (const projectId of patch.projectRestrictions ?? [])
      if (!this.ctx.entities.get("Project", this.ctx.workspaceId, projectId))
        throw new ContractError("NOT_FOUND", "Project does not exist", { projectId });
    return this.ctx.database.withTx(() => {
      const current = this.ctx.entities.get("Membership", this.ctx.workspaceId, memberId);
      expected(current, expectedVersion);
      this.ctx.entities.update("Membership", this.ctx.workspaceId, memberId, expectedVersion, {
        ...(current as EntityDocument),
        ...(patch.role ? { role: patch.role } : {}),
        ...(patch.projectRestrictions ? { projectRestrictions: patch.projectRestrictions } : {}),
        version: expectedVersion + 1,
      });
      if (patch.disabled !== undefined) this.setDisabled(target.principalId, patch.disabled);
      this.audit("member.update", memberId);
      return this.find(memberId);
    });
  }
  private setDisabled(principalId: string, disabled: boolean): void {
    const principal = this.ctx.entities.get(
      "Principal",
      this.ctx.workspaceId,
      principalId,
    ) as EntityDocument;
    this.ctx.entities.update(
      "Principal",
      this.ctx.workspaceId,
      principalId,
      Number(principal.version),
      {
        ...principal,
        disabledAt: disabled ? new Date().toISOString() : null,
        version: Number(principal.version) + 1,
      },
    );
    if (disabled) this.endAccess(principalId);
  }
  /** Tokens and sessions of a member that lost access stop working at once. */
  private endAccess(principalId: string): void {
    this.ctx.database.run(
      "UPDATE server_tokens SET revoked_at=? WHERE workspace_id=? AND principal_id=? AND revoked_at IS NULL",
      new Date().toISOString(),
      this.ctx.workspaceId,
      principalId,
    );
    revokePrincipalSessions(this.ctx.database, this.ctx.workspaceId, principalId);
  }
  remove(workspaceId: string, memberId: string): void {
    this.ctx.authorize("A");
    this.workspace(workspaceId);
    const target = this.find(memberId);
    this.guard(target, null, true);
    this.ctx.database.withTx(() => {
      this.ctx.database.run(
        "DELETE FROM memberships WHERE workspace_id=? AND id=?",
        this.ctx.workspaceId,
        memberId,
      );
      this.setDisabled(target.principalId, true);
      this.audit("member.remove", memberId);
    });
  }
}
export interface TokenView {
  id: string;
  name: string;
  kind: TokenData["kind"];
  principalId: string;
  scopes: Scope[];
  grants: PermissionGrant[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}
const maxTokenLifetimeMs = 366 * 86400000;
const toToken = (row: Record<string, unknown>): TokenView => {
  const data = JSON.parse(String(row.data_json)) as TokenData;
  return {
    id: String(row.id),
    name: data.name,
    kind: data.kind,
    principalId: String(row.principal_id),
    scopes: data.scopes,
    grants: data.grants,
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
  };
};
const tokenSelect =
  "SELECT id,data_json,principal_id,created_at,expires_at,revoked_at FROM server_tokens WHERE workspace_id=?";
export class TokensService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly app: () => Application,
  ) {}
  list(): TokenView[] {
    this.ctx.authorize("A");
    return this.ctx.database
      .all(`${tokenSelect} ORDER BY created_at DESC,id DESC LIMIT 500`, this.ctx.workspaceId)
      .map(toToken);
  }
  /** The secret is returned once and only its hash is kept. */
  create(input: {
    name: string;
    scopes: Scope[];
    expiresAt: string;
    grants?: PermissionGrant[];
    principalId?: string;
  }): { token: string; metadata: TokenView } {
    this.ctx.authorize("A");
    const issuance = resolveIssuance(this.app(), {
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      ...(input.grants ? { grants: input.grants } : {}),
    });
    if (Date.parse(issuance.expiresAt) - Date.now() > maxTokenLifetimeMs)
      throw new ContractError("INVALID_ARGUMENT", "API tokens live at most 366 days");
    const principalId = input.principalId ?? this.ctx.principalId;
    const member = this.ctx.database.get(
      "SELECT p.disabled_at AS disabled_at FROM memberships m JOIN principals p ON p.workspace_id=m.workspace_id AND p.id=m.principal_id WHERE m.workspace_id=? AND m.principal_id=?",
      this.ctx.workspaceId,
      principalId,
    );
    if (!member || member.disabled_at)
      throw new ContractError("NOT_FOUND", "Principal is not an active member of this workspace");
    return this.ctx.database.withTx(() => {
      const issued = insertToken(this.ctx.database, {
        workspaceId: this.ctx.workspaceId,
        principalId,
        kind: "api",
        name: input.name,
        scopes: issuance.scopes,
        grants: issuance.grants,
        expiresAt: issuance.expiresAt,
      });
      auditAs(
        {
          database: this.ctx.database,
          workspaceId: this.ctx.workspaceId,
          actor: this.ctx.principalId,
        },
        "auth.token.issue",
        issued.id,
        "allowed",
        this.ctx.correlationId,
      );
      const row = this.ctx.database.get(`${tokenSelect} AND id=?`, this.ctx.workspaceId, issued.id);
      return { token: issued.token, metadata: toToken(row as Record<string, unknown>) };
    });
  }
  revoke(id: string): TokenView {
    this.ctx.authorize("A");
    const row = this.ctx.database.get(`${tokenSelect} AND id=?`, this.ctx.workspaceId, id);
    if (!row) throw new ContractError("NOT_FOUND", "Token does not exist");
    this.ctx.database.withTx(() => {
      revokeTokenRow(this.ctx.database, this.ctx.workspaceId, id);
      auditAs(
        {
          database: this.ctx.database,
          workspaceId: this.ctx.workspaceId,
          actor: this.ctx.principalId,
        },
        "auth.token.revoke",
        id,
        "allowed",
        this.ctx.correlationId,
      );
    });
    return toToken(
      this.ctx.database.get(`${tokenSelect} AND id=?`, this.ctx.workspaceId, id) as Record<
        string,
        unknown
      >,
    );
  }
}
