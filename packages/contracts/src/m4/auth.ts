import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Step } from "../plans.js";
import * as P from "../primitives.js";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Url = Type.String({ format: "uri", maxLength: 2048 });
const Origins = Type.Array(Url, { minItems: 1, maxItems: 16 });

/** Roles a static (user-supplied) secret can play in a profile, per kind. Managed roles are never supplied. */
export const authStaticRoles = {
  form: ["username", "password", "totpSeed"],
  basic: ["username", "password"],
  bearer: ["token"],
  "api-key": ["key"],
  cookie: ["cookie"],
  oauth: ["clientSecret", "username", "password", "totpSeed"],
  oidc: ["clientSecret", "username", "password", "totpSeed"],
  manual: [],
} as const satisfies Record<string, readonly string[]>;
/** Roles the engine maintains in the vault; a plan references them with an ordinary `secretRef`. */
export const authManagedRoles = {
  form: ["session", "token", "storageState", "otp"],
  basic: ["authorization"],
  bearer: [],
  "api-key": [],
  cookie: [],
  oauth: ["accessToken", "refreshToken", "otp"],
  oidc: ["accessToken", "refreshToken", "otp"],
  manual: ["storageState", "accessToken", "otp"],
} as const satisfies Record<string, readonly string[]>;
export type AuthKind = keyof typeof authStaticRoles;
export const authKinds = Object.keys(authStaticRoles) as AuthKind[];
export const authChallengeKinds = ["captcha", "webauthn", "push", "email-otp"] as const;
export const authCheckpointKinds = [
  ...authChallengeKinds,
  "reauthorization",
  "adapter-unavailable",
  "expired-state",
] as const;
export const authSessionStates = [
  "unauthenticated",
  "authenticated",
  "expired",
  "reauth_required",
  "revoked",
  "locked",
] as const;

const Challenge = P.Obj({
  kind: P.Enum(authChallengeKinds),
  /** `storage-state` and `otp` need a human-supplied secret; `retry` waits for out-of-band approval. */
  resolution: P.Enum(["storage-state", "otp", "retry"]),
});
const Ttl = Type.Integer({ minimum: 60, maximum: 86400 });
const HttpLogin = P.Obj({
  loginUrl: Url,
  contentType: P.Enum(["form", "json"]),
  /** Request field names that receive the vault values; the values themselves never appear here. */
  fields: P.Obj({ username: P.Name, password: P.Name, otp: Type.Optional(P.Name) }),
  staticFields: Type.Optional(
    Type.Record(Type.String({ maxLength: 100 }), Type.String({ maxLength: 500 })),
  ),
  success: P.Obj({
    statusIn: Type.Array(Type.Integer({ minimum: 100, maximum: 599 }), {
      minItems: 1,
      maxItems: 8,
    }),
    /** Cookies copied into the managed `session` credential (header form); omitted copies all. */
    cookieNames: Type.Optional(Type.Array(P.Name, { minItems: 1, maxItems: 16 })),
    /** JSON pointer of a response token stored as the managed `token` credential. */
    tokenPointer: Type.Optional(P.JsonPointer),
    tokenScheme: Type.Optional(P.Name),
  }),
  /** A response that matches is a human-only challenge (for example a CAPTCHA), never retried. */
  challenge: Type.Optional(
    P.Obj({
      statusIn: Type.Optional(
        Type.Array(Type.Integer({ minimum: 100, maximum: 599 }), { maxItems: 8 }),
      ),
      bodyContains: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      kind: P.Enum(authChallengeKinds),
    }),
  ),
  ttlSeconds: Type.Optional(Ttl),
});
const BrowserLogin = P.Obj({
  /** Executed before the plan inside the Attempt; they reference vault secrets and the managed `otp` role only. */
  steps: Type.Array(Step, { minItems: 1, maxItems: 24 }),
  ttlSeconds: Type.Optional(Ttl),
});
const Otp = P.Obj({
  algorithm: Type.Optional(P.Enum(["SHA1", "SHA256", "SHA512"])),
  digits: Type.Optional(Type.Integer({ minimum: 6, maximum: 8 })),
  periodSeconds: Type.Optional(Type.Integer({ minimum: 15, maximum: 120 })),
  /** Failed codes allowed in the window before the profile locks (no brute force). */
  maxFailures: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  windowSeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 3600 })),
});
const OAuthEndpoints = P.Obj({
  authorization: Type.Optional(Url),
  token: Type.Optional(Url),
  jwks: Type.Optional(Url),
  revocation: Type.Optional(Url),
});
const Cognito = P.Obj({
  region: P.Name,
  /** Defaults to the regional `cognito-idp` endpoint; a fixture or VPC endpoint can override it. */
  endpoint: Type.Optional(Url),
  userPoolId: Type.Optional(P.Name),
});

/** Kind-specific configuration; the service picks the schema by `kind` (and `adapter` for OAuth/OIDC). */
export const authConfigContracts = {
  AuthFormConfig: P.Obj({
    http: Type.Optional(HttpLogin),
    browser: Type.Optional(BrowserLogin),
    challenge: Type.Optional(Challenge),
    otp: Type.Optional(Otp),
  }),
  AuthBasicConfig: P.Obj({}),
  AuthStaticConfig: P.Obj({
    /** Header or cookie the static credential is meant for; documentation for plan authors. */
    header: Type.Optional(P.Name),
  }),
  AuthOAuthConfig: P.Obj({
    adapter: P.Enum(["generic", "cognito"]),
    issuer: Url,
    clientId: P.Name,
    audience: Type.Optional(P.Name),
    scopes: Type.Array(P.Name, { maxItems: 32 }),
    allowedScopes: Type.Array(P.Name, { maxItems: 32 }),
    redirectUris: Type.Array(Url, { minItems: 1, maxItems: 8 }),
    redirectUri: Url,
    endpoints: Type.Optional(OAuthEndpoints),
    cognito: Type.Optional(Cognito),
    otp: Type.Optional(Otp),
    tokenScheme: Type.Optional(P.Name),
  }),
  AuthManualConfig: P.Obj({
    challenge: Challenge,
    ttlSeconds: Type.Optional(Ttl),
  }),
};

export const AuthRefreshPolicy = P.Obj({
  /** A credential this close to expiry is refreshed before use. */
  skewSeconds: Type.Integer({ minimum: 0, maximum: 600 }),
  maxRefreshesPerHour: Type.Integer({ minimum: 1, maximum: 60 }),
  /** After a failed refresh the profile is not contacted again for this long. */
  cooldownSeconds: Type.Integer({ minimum: 0, maximum: 3600 }),
  maxConsecutiveFailures: Type.Integer({ minimum: 1, maximum: 10 }),
  /** Lifetime of a captured or imported browser storage state. */
  stateTtlSeconds: Ttl,
});
export type AuthRefreshPolicy = Static<typeof AuthRefreshPolicy>;

const Credential = P.Obj({
  role: P.Name,
  secretId: P.id("sec"),
  capturedAt: nullable(P.Timestamp),
  expiresAt: nullable(P.Timestamp),
});
export const AuthSession = P.Obj({
  state: P.Enum(authSessionStates),
  reason: nullable(P.Name),
  credentials: Type.Array(Credential),
  lastRefreshAt: nullable(P.Timestamp),
  refreshFailures: P.Nonnegative,
  cooldownUntil: nullable(P.Timestamp),
  otpLockedUntil: nullable(P.Timestamp),
  pendingCheckpointId: nullable(P.id("acp")),
});
export type AuthSession = Static<typeof AuthSession>;

export const authContracts = {
  ...authConfigContracts,
  AuthRefreshPolicy,
  AuthProfileInput: P.Obj({
    projectId: P.id("prj"),
    name: P.Name,
    kind: P.Enum(authKinds),
    originBindings: Origins,
    /** Static role → existing vault SecretReference; managed roles are created by the server. */
    secrets: Type.Record(P.Name, P.id("sec")),
    config: P.Json,
    refreshPolicy: Type.Optional(Type.Partial(AuthRefreshPolicy)),
  }),
  AuthProfilePatch: Type.Partial(
    P.Obj({
      name: P.Name,
      originBindings: Origins,
      secrets: Type.Record(P.Name, P.id("sec")),
      config: P.Json,
      refreshPolicy: Type.Partial(AuthRefreshPolicy),
    }),
  ),
  /** The stored profile plus its live session summary; no credential value is ever included. */
  AuthProfileView: P.Obj({
    id: P.id("aup"),
    workspaceId: P.id("ws"),
    projectId: P.id("prj"),
    name: P.Name,
    kind: P.Enum(authKinds),
    originBindings: Origins,
    secrets: Type.Record(P.Name, P.id("sec")),
    managedSecrets: Type.Record(P.Name, P.id("sec")),
    config: P.Json,
    refreshPolicy: AuthRefreshPolicy,
    session: AuthSession,
    version: P.Version,
    createdAt: P.Timestamp,
  }),
  AuthTestLoginInput: P.Obj({ environmentId: P.id("env") }),
  /** A test login never saves a draft, revision or proposal: `persisted` is always false for them. */
  AuthTestLoginReceipt: P.Obj({
    profileId: P.id("aup"),
    environmentId: P.id("env"),
    outcome: P.Enum(["authenticated", "failed", "checkpoint_required", "blocked"]),
    reasonCode: nullable(P.Name),
    detail: nullable(P.Description),
    credentialRoles: Type.Array(P.Name),
    expiresAt: nullable(P.Timestamp),
    draftsChanged: Type.Literal(false),
    checkedAt: P.Timestamp,
  }),
  AuthAuthorizeInput: P.Obj({ environmentId: P.id("env") }),
  AuthAuthorization: P.Obj({
    authorizationId: P.Name,
    authorizeUrl: Url,
    redirectUri: Url,
    expiresAt: P.Timestamp,
  }),
  /** `inputRef` names a vault secret holding the redirect URL the identity provider returned. */
  AuthCompleteInput: P.Obj({ authorizationId: P.Name, inputRef: P.id("sec") }),
  AuthStateImportInput: P.Obj({
    inputRef: P.id("sec"),
    ttlSeconds: Type.Optional(Ttl),
  }),
  /** Step-up: the caller re-enters their own password; the export is bound to a short TTL. */
  AuthStateExportInput: P.Obj({
    password: Type.String({ minLength: 1, maxLength: 1024 }),
    ttlSeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 900 })),
  }),
  AuthStateExport: P.Obj({
    profileId: P.id("aup"),
    storageState: Type.String({ maxLength: 262144 }),
    sha256: P.ContentDigest,
    capturedAt: P.Timestamp,
    expiresAt: P.Timestamp,
    exportExpiresAt: P.Timestamp,
  }),
  AuthCheckpointInput: P.Obj({
    runId: P.id("run"),
    attemptId: P.id("att"),
    authProfileId: P.id("aup"),
    kind: P.Enum(authCheckpointKinds),
    challengeRef: P.Name,
  }),
  AuthContinueInput: P.Obj({ inputRef: Type.Optional(P.id("sec")) }),
};

export type AuthProfileConfig = Static<typeof authConfigContracts.AuthFormConfig>;
export type AuthFormConfig = Static<typeof authConfigContracts.AuthFormConfig>;
export type AuthOAuthConfig = Static<typeof authConfigContracts.AuthOAuthConfig>;
export type AuthManualConfig = Static<typeof authConfigContracts.AuthManualConfig>;
export type AuthProfileInput = Static<typeof authContracts.AuthProfileInput>;
export type AuthProfilePatch = Static<typeof authContracts.AuthProfilePatch>;
export type AuthProfileView = Static<typeof authContracts.AuthProfileView>;
export type AuthTestLoginReceipt = Static<typeof authContracts.AuthTestLoginReceipt>;
export type AuthAuthorization = Static<typeof authContracts.AuthAuthorization>;
export type AuthCheckpointInput = Static<typeof authContracts.AuthCheckpointInput>;
export type AuthStateExport = Static<typeof authContracts.AuthStateExport>;
export type AuthCheckpointKind = (typeof authCheckpointKinds)[number];
export type AuthChallengeKind = (typeof authChallengeKinds)[number];
export type AuthSessionState = (typeof authSessionStates)[number];
