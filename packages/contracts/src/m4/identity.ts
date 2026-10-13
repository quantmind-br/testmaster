import { type TSchema, Type } from "@sinclair/typebox";
import { entities } from "../entities.js";
import { PermissionGrant } from "../operations.js";
import { Description, Enum, id, Name, Obj, roles, Timestamp, Version } from "../primitives.js";
import { rbacColumns, rbacValues } from "../rbac.js";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
/** Globally unique human login (ADR-017). */
export const Login = Type.String({ pattern: "^[a-z0-9][a-z0-9._@-]{2,63}$" });
const Password = Type.String({ minLength: 12, maxLength: 256 });
const TokenScopes = Type.Array(Enum(["R", "W", "X", "A"]), {
  minItems: 1,
  maxItems: 4,
  uniqueItems: true,
});
const Permissions = Obj(Object.fromEntries(rbacColumns.map((column) => [column, Type.Boolean()])));
const TokenMetadata = Obj({
  id: Name,
  name: Name,
  kind: Enum(["local", "api", "worker", "operator"]),
  principalId: Name,
  scopes: TokenScopes,
  grants: Type.Array(PermissionGrant),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  revokedAt: nullable(Timestamp),
});
const MemberView = Obj({
  id: id("mem"),
  principalId: Type.Union([id("usr"), id("svc")]),
  login: nullable(Login),
  displayName: Name,
  role: Enum(roles),
  projectRestrictions: Type.Array(id("prj")),
  disabledAt: nullable(Timestamp),
  createdAt: Timestamp,
  version: Version,
});
const RecoveryGrant = {
  recoveryToken: Type.String({ pattern: "^tm_rec_[A-Za-z0-9_-]{43}$" }),
  recoveryExpiresAt: Timestamp,
};
export const identityContracts = {
  LoginInput: Obj({ principal: Name, password: Type.String({ minLength: 1, maxLength: 1024 }) }),
  PasswordChangeInput: Obj({
    currentPassword: Type.String({ minLength: 1, maxLength: 1024 }),
    newPassword: Password,
  }),
  RecoveryInput: Obj({
    principal: Name,
    recoveryToken: Type.String({ minLength: 1, maxLength: 200 }),
    newPassword: Password,
  }),
  /** `csrfToken` is present only for a freshly created cookie session. */
  IdentityReceipt: Obj({
    principalId: Name,
    state: Enum(["authenticated", "revoked", "pending"]),
    workspaceId: nullable(id("ws")),
    sessionId: nullable(Name),
    csrfToken: nullable(Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" })),
    expiresAt: nullable(Timestamp),
  }),
  SessionMetadata: Obj({
    id: Name,
    principalId: Name,
    createdAt: Timestamp,
    lastSeenAt: Timestamp,
    expiresAt: Timestamp,
    idleExpiresAt: Timestamp,
    revokedAt: nullable(Timestamp),
    current: Type.Boolean(),
  }),
  WorkspaceInput: Obj({
    name: Type.Optional(Name),
    settingsVersion: Type.Optional(Version),
    quotaPolicyId: Type.Optional(Name),
    /** Required when creating a workspace; the new owner receives a one-time recovery token. */
    ownerLogin: Type.Optional(Login),
    ownerDisplayName: Type.Optional(Name),
  }),
  WorkspaceCreated: Obj({
    workspace: entities.Workspace,
    ownerPrincipalId: id("usr"),
    ownerLogin: Login,
    ownerRecoveryToken: RecoveryGrant.recoveryToken,
    ownerRecoveryExpiresAt: RecoveryGrant.recoveryExpiresAt,
  }),
  MembershipInput: Obj({
    role: Type.Optional(Enum(roles)),
    projectRestrictions: Type.Optional(Type.Array(id("prj"))),
    disabled: Type.Optional(Type.Boolean()),
  }),
  MemberInput: Obj({
    login: Login,
    displayName: Name,
    role: Enum(roles),
    projectRestrictions: Type.Array(id("prj")),
  }),
  MemberView,
  /** Human members receive a one-time recovery token; service accounts have none. */
  MemberCreated: Obj({
    member: MemberView,
    recoveryToken: nullable(RecoveryGrant.recoveryToken),
    recoveryExpiresAt: nullable(RecoveryGrant.recoveryExpiresAt),
  }),
  TokenInput: Obj({
    name: Name,
    scopes: TokenScopes,
    expiresAt: Timestamp,
    grants: Type.Optional(Type.Array(PermissionGrant, { maxItems: 50 })),
    /** Issuing for another member needs the admin scope; default is the caller. */
    principalId: Type.Optional(Name),
  }),
  TokenMetadata,
  /** The bearer value is returned exactly once. */
  TokenCreated: Obj({
    token: Type.String({ pattern: "^tm_(api|local|wrk|op)_[A-Za-z0-9_-]{43}$" }),
    metadata: TokenMetadata,
  }),
  MeResponse: Obj({
    principal: entities.Principal,
    workspace: entities.Workspace,
    membership: entities.Membership,
    permissions: Permissions,
    csrfToken: nullable(Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" })),
  }),
  RbacMatrix: Obj({
    roles: Type.Array(Enum(roles)),
    columns: Type.Array(Enum(rbacColumns)),
    values: Type.Array(Enum(rbacValues)),
    matrix: Obj(
      Object.fromEntries(
        roles.map((role) => [
          role,
          Obj(Object.fromEntries(rbacColumns.map((column) => [column, Enum(rbacValues)]))),
        ]),
      ),
    ),
    rules: Type.Array(Description),
  }),
};
