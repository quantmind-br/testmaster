import { createHash } from "node:crypto";
import {
  type AuthAuthorization,
  type AuthKind,
  type AuthProfileInput,
  type AuthProfilePatch,
  type AuthProfileView,
  type AuthRefreshPolicy,
  type AuthStateExport,
  type AuthTestLoginReceipt,
  authManagedRoles,
  authStaticRoles,
  ContractError,
  type EnvironmentRevision,
  type ExecutablePlan,
  type PlanStep,
  validate,
} from "@testmaster/contracts";
import type { EntityDocument } from "@testmaster/persistence";
import { auditedOperation, auditSecurity } from "../audit.js";
import { allEntities, entity, requireEntity, type ServiceContext } from "../context.js";
import type { SecretsService } from "../secrets.js";
import { AuthEngine, type EnsureOptions } from "./engine.js";
import { originOf } from "./oauth.js";
import { AuthStateStore } from "./state.js";
import {
  AuthBlocked,
  type AuthEnvironment,
  defaultRefreshPolicy,
  type StoredAuthProfile,
  type StoredCheckpoint,
} from "./types.js";

type Stored<T> = T & EntityDocument;
/** The vault's own secret limit: a larger state could not be stored. */
/** Longest lifetime of an exported storage state; the stored copy is capped to it as well. */
const MAX_EXPORT_TTL_SECONDS = 900;
const MAX_STATE_BYTES = 65_536;
const ACTION_OPERATIONS = new Set([
  "navigate",
  "click",
  "fill",
  "press",
  "select",
  "check",
  "uncheck",
  "hover",
  "focus",
  "waitFor",
]);
const configSchema = {
  form: "AuthFormConfig",
  basic: "AuthBasicConfig",
  bearer: "AuthStaticConfig",
  "api-key": "AuthStaticConfig",
  cookie: "AuthStaticConfig",
  oauth: "AuthOAuthConfig",
  oidc: "AuthOAuthConfig",
  manual: "AuthManualConfig",
} as const satisfies Record<AuthKind, string>;
const requiredRoles = {
  basic: ["username", "password"],
  bearer: ["token"],
  "api-key": ["key"],
  cookie: ["cookie"],
} as const satisfies Partial<Record<AuthKind, readonly string[]>>;

/** Verifies the caller's own password; throws the generic `UNAUTHENTICATED` on mismatch. */
export type StepUp = (password: string, operation: string) => Promise<void>;
/** Runs the profile's browser login in a short login-only Attempt; never creates a Run. */
export type BrowserLoginProbe = (input: {
  profile: StoredAuthProfile;
  environment: AuthEnvironment;
  login: { steps: PlanStep[]; captureState: boolean };
  secretIds: string[];
  onAuthState: (storageState: string) => Promise<void>;
}) => Promise<{ ok: boolean; reasonCode: string }>;
export interface AuthProfilesDeps {
  secrets: SecretsService;
  stepUp: StepUp;
  browserLogin?: BrowserLoginProbe;
  clock?: () => number;
}

/** What the worker needs to start an Attempt for one environment. */
export interface PrepareInput {
  run: { id: string; origin: string; requestedBy: string };
  attemptId: string;
  environment: AuthEnvironment;
  signal: AbortSignal;
  /** Epoch milliseconds at which the Attempt must be over. */
  deadlineAt: number;
  interactive: boolean;
}
export interface PreparedAuth {
  /** Managed secret ids the Attempt resolves in addition to those named by the plan. */
  secretIds: string[];
  runnerAuth: {
    storageState?: { secretRef: string };
    login?: { steps: PlanStep[]; captureState: boolean };
  } | null;
  /** Receives a browser storage state captured by the login phase. */
  onAuthState: (storageState: string) => Promise<void>;
  /** Called with the Attempt's outcome; records a browser login that did not complete. */
  finish: (result: { outcome: string; reasonCode: string }) => void;
}

function keys(value: object, allowed: readonly string[]): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new ContractError("INVALID_ARGUMENT", "Unknown input field", { field: key });
}
function collectSecretRefs(value: unknown, into: Set<string>): void {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "secretRef" && typeof item === "string") into.add(item);
    else collectSecretRefs(item, into);
  }
}
function canonicalOrigins(values: readonly string[]): string[] {
  return [
    ...new Set(
      values.map((value) => {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          throw new ContractError("INVALID_ARGUMENT", "Origin binding must be an HTTP origin");
        }
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          (url.pathname !== "/" && url.pathname !== "")
        )
          throw new ContractError(
            "INVALID_ARGUMENT",
            "Origin binding must be a credential-free origin",
          );
        return url.origin;
      }),
    ),
  ];
}

/**
 * Dynamic authentication profiles (SEC-022/023/024, M4-03): configuration, session lifecycle and
 * the preparation the worker runs before every Attempt. No method returns a credential value
 * except `exportState`, which needs an explicit grant, a step-up and a bounded lifetime.
 */
export class AuthProfilesService {
  readonly engine: AuthEngine;
  private readonly store: AuthStateStore;
  private readonly clock: () => number;
  constructor(
    private readonly ctx: ServiceContext,
    private readonly deps: AuthProfilesDeps,
  ) {
    this.clock = deps.clock ?? Date.now;
    this.store = new AuthStateStore(ctx);
    this.engine = new AuthEngine(ctx, deps.secrets, this.store, this.clock);
  }

  // --- Reads ----------------------------------------------------------------------------------

  private load(id: string): StoredAuthProfile {
    const profile = requireEntity(this.ctx, "AuthProfile", id) as StoredAuthProfile;
    this.ctx.authorize("R", profile.projectId);
    return profile;
  }
  profile(id: string): StoredAuthProfile {
    return this.load(id);
  }
  view(profile: StoredAuthProfile): AuthProfileView {
    const state = this.store.get(profile.id);
    return {
      id: profile.id,
      workspaceId: profile.workspaceId,
      projectId: profile.projectId,
      name: profile.name,
      kind: profile.kind,
      originBindings: profile.originBindings,
      secrets: profile.secrets,
      managedSecrets: profile.managedSecrets,
      config: profile.config as AuthProfileView["config"],
      refreshPolicy: profile.refreshPolicy,
      session: {
        state: state.sessionState,
        reason: state.reason,
        credentials: Object.entries(state.credentials).flatMap(([role, meta]) => {
          const secretId = profile.managedSecrets[role];
          return secretId
            ? [{ role, secretId, capturedAt: meta.capturedAt, expiresAt: meta.expiresAt }]
            : [];
        }),
        lastRefreshAt: state.lastRefreshAt,
        refreshFailures: state.refreshFailures,
        cooldownUntil: state.cooldownUntil,
        otpLockedUntil: state.otpLockedUntil,
        pendingCheckpointId: this.pendingCheckpoint(profile.id),
      },
      version: profile.version,
      createdAt: profile.createdAt,
    };
  }
  private pendingCheckpoint(profileId: string): string | null {
    const row = this.ctx.database.get(
      "SELECT id FROM auth_checkpoints WHERE workspace_id=? AND auth_profile_id=? AND state='pending' ORDER BY created_at DESC LIMIT 1",
      this.ctx.workspaceId,
      profileId,
    );
    return row ? String(row.id) : null;
  }
  list(projectId?: string): AuthProfileView[] {
    this.ctx.authorize("R", projectId);
    return (allEntities(this.ctx, "AuthProfile") as StoredAuthProfile[])
      .filter((profile) => !projectId || profile.projectId === projectId)
      .flatMap((profile) => {
        try {
          this.ctx.authorize("R", profile.projectId);
          return [this.view(profile)];
        } catch {
          return [];
        }
      });
  }
  get(id: string): AuthProfileView {
    return this.view(this.load(id));
  }

  // --- Validation -----------------------------------------------------------------------------

  environment(environmentId: string): { environment: AuthEnvironment; projectId: string } {
    const env = requireEntity(this.ctx, "Environment", environmentId);
    const revision = requireEntity(
      this.ctx,
      "EnvironmentRevision",
      String(env.activeRevisionId),
    ) as Stored<EnvironmentRevision>;
    return {
      projectId: String(env.projectId),
      environment: {
        id: environmentId,
        projectId: String(env.projectId),
        targetOrigins: revision.targetOrigins,
        networkProfile: revision.networkProfile as AuthEnvironment["networkProfile"],
        authProfileRefs: revision.authProfileRefs,
      },
    };
  }

  /** Cross-checks a profile draft: config shape, roles, secrets, origins and browser steps. */
  private async validateDraft(draft: StoredAuthProfile): Promise<void> {
    const config = validate<Record<string, unknown>>(configSchema[draft.kind], draft.config);
    draft.config = config;
    const bindings = draft.originBindings;
    const form =
      draft.kind === "form"
        ? validate<{
            http?: { loginUrl: string; fields: { otp?: string } };
            browser?: { steps: PlanStep[] };
            otp?: unknown;
            challenge?: unknown;
          }>("AuthFormConfig", config)
        : null;
    if (form) {
      if (Boolean(form.http) === Boolean(form.browser))
        throw new ContractError(
          "INVALID_ARGUMENT",
          "A form profile needs exactly one of http and browser login",
        );
      if (form.http && !bindings.includes(originOf(form.http.loginUrl)))
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Login URL is outside the profile's origin bindings",
        );
      if (form.http?.fields.otp && !form.otp)
        throw new ContractError("INVALID_ARGUMENT", "An OTP field needs an otp configuration");
    }
    if (draft.kind === "oauth" || draft.kind === "oidc") {
      const oauth = validate<{
        adapter: string;
        scopes: string[];
        allowedScopes: string[];
        redirectUris: string[];
        redirectUri: string;
        cognito?: unknown;
      }>("AuthOAuthConfig", config);
      if (!oauth.redirectUris.includes(oauth.redirectUri))
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Redirect URI is not one of the registered redirect URIs",
        );
      if (oauth.scopes.some((scope) => !oauth.allowedScopes.includes(scope)))
        throw new ContractError("INVALID_ARGUMENT", "Requested scopes exceed the allowed scopes");
      if (draft.kind === "oidc" && !oauth.scopes.includes("openid"))
        throw new ContractError(
          "INVALID_ARGUMENT",
          "An OIDC profile must request the openid scope",
        );
      if (oauth.adapter === "cognito" && !oauth.cognito)
        throw new ContractError(
          "INVALID_ARGUMENT",
          "The Cognito adapter needs a cognito configuration",
        );
    }
    const roles = authStaticRoles[draft.kind] as readonly string[];
    for (const role of Object.keys(draft.secrets))
      if (!roles.includes(role))
        throw new ContractError("INVALID_ARGUMENT", "Secret role is not valid for this auth kind", {
          role,
          kind: draft.kind,
        });
    const required: readonly string[] =
      draft.kind === "form" && form?.http
        ? ["username", "password"]
        : ((requiredRoles as Record<string, readonly string[]>)[draft.kind] ?? []);
    for (const role of required)
      if (!draft.secrets[role])
        throw new ContractError("INVALID_ARGUMENT", "Required secret role is missing", { role });
    const destinations =
      draft.kind === "oauth" || draft.kind === "oidc" || (form?.http ?? false)
        ? this.engine.idpOrigins(draft)
        : bindings;
    for (const [role, id] of Object.entries(draft.secrets)) {
      const secret = this.deps.secrets.get(id);
      if (secret.managedBy)
        throw new ContractError(
          "INVALID_ARGUMENT",
          "A managed credential cannot be a static secret",
          { role },
        );
      if (secret.revokedAt)
        throw new ContractError("POLICY_DENIED", "Secret is revoked", {
          role,
          reasonCode: "credential_revoked",
        });
      const outside = destinations.filter((origin) => !secret.allowedOrigins.includes(origin));
      if (outside.length)
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Secret is not authorized for the origin that receives it",
          { role, origins: outside },
        );
    }
    if (form?.browser) this.validateBrowserSteps(draft, form.browser.steps);
    if (draft.kind === "manual") validate("AuthManualConfig", config);
  }
  /** Login steps may only act and may only reference this profile's own credentials. */
  private validateBrowserSteps(draft: StoredAuthProfile, steps: readonly PlanStep[]): void {
    const allowed = new Set<string>([...draft.secretRefs, ...Object.values(draft.managedSecrets)]);
    const referenced = new Set<string>();
    for (const step of steps) {
      if (
        step.kind === "assertion" ||
        !ACTION_OPERATIONS.has(String((step as { operation?: string }).operation))
      )
        throw new ContractError("INVALID_ARGUMENT", "Login steps may only navigate and interact", {
          stepId: step.id,
        });
    }
    collectSecretRefs(steps, referenced);
    for (const id of referenced)
      if (!allowed.has(id))
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Login step references a secret outside the profile",
          { secretRef: id },
        );
  }

  private resolvePolicy(policy: Partial<AuthRefreshPolicy> | undefined): AuthRefreshPolicy {
    return { ...defaultRefreshPolicy, ...(policy ?? {}) };
  }
  private assertName(projectId: string, name: string, except?: string): void {
    if (
      (allEntities(this.ctx, "AuthProfile") as StoredAuthProfile[]).some(
        (item) => item.projectId === projectId && item.name === name && item.id !== except,
      )
    )
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Auth profile name already exists in this project",
      );
  }

  // --- Create, update -------------------------------------------------------------------------

  async create(input: AuthProfileInput): Promise<AuthProfileView> {
    this.ctx.authorize("W", input.projectId);
    this.ctx.authorizeColumn("secret", input.projectId);
    keys(input, [
      "projectId",
      "name",
      "kind",
      "originBindings",
      "secrets",
      "config",
      "refreshPolicy",
    ]);
    validate("AuthProfileInput", input);
    const project = requireEntity(this.ctx, "Project", input.projectId);
    if (project.archivedAt) throw new ContractError("PRECONDITION_FAILED", "Project is archived");
    this.assertName(input.projectId, input.name);
    const draft = entity(this.ctx, "aup", {
      projectId: input.projectId,
      name: input.name,
      kind: input.kind,
      originBindings: canonicalOrigins(input.originBindings),
      secretRefs: [...new Set(Object.values(input.secrets))].sort(),
      secrets: input.secrets,
      managedSecrets: {},
      config: input.config,
      refreshPolicy: this.resolvePolicy(input.refreshPolicy),
    }) as StoredAuthProfile;
    await this.validateDraft(draft);
    const idp = this.engine.idpOrigins(draft);
    const managed: Record<string, string> = {};
    try {
      for (const role of authManagedRoles[draft.kind] as readonly string[]) {
        const origins = role === "refreshToken" ? idp : draft.originBindings;
        managed[role] = (
          await this.deps.secrets.createManaged({ profileId: draft.id, role }, origins)
        ).id;
      }
      draft.managedSecrets = managed;
      // Steps are validated again now that the managed secret ids are known.
      await this.validateDraft(draft);
      this.ctx.database.withTx(() => {
        this.ctx.entities.insert("AuthProfile", draft);
        this.store.ensure(draft.id);
      });
    } catch (error) {
      for (const id of Object.values(managed))
        await this.deps.secrets.eraseManaged(id, { revoke: true }).catch(() => {});
      throw error;
    }
    auditSecurity(this.ctx, "auth.profile.create", draft.id, "allowed");
    return this.view(draft);
  }

  async update(
    id: string,
    patch: AuthProfilePatch,
    expectedVersion: number,
  ): Promise<AuthProfileView> {
    const current = requireEntity(this.ctx, "AuthProfile", id) as StoredAuthProfile;
    this.ctx.authorize("W", current.projectId);
    this.ctx.authorizeColumn("secret", current.projectId);
    keys(patch, ["name", "originBindings", "secrets", "config", "refreshPolicy"]);
    validate("AuthProfilePatch", patch);
    if (current.version !== expectedVersion)
      throw new ContractError("REVISION_CONFLICT", "Auth profile changed since it was read", {
        expectedVersion,
        currentVersion: current.version,
      });
    if (patch.name !== undefined) this.assertName(current.projectId, patch.name, id);
    const draft: StoredAuthProfile = {
      ...current,
      name: patch.name ?? current.name,
      originBindings: patch.originBindings
        ? canonicalOrigins(patch.originBindings)
        : current.originBindings,
      secrets: patch.secrets ?? current.secrets,
      secretRefs: patch.secrets
        ? [...new Set(Object.values(patch.secrets))].sort()
        : current.secretRefs,
      config: (patch.config as Record<string, unknown> | undefined) ?? current.config,
      refreshPolicy: this.resolvePolicy({
        ...current.refreshPolicy,
        ...(patch.refreshPolicy ?? {}),
      }),
      version: current.version + 1,
    };
    await this.validateDraft(draft);
    // Every environment that uses the profile must stay inside its bindings.
    for (const environment of this.referencingEnvironments(id)) {
      const outside = environment.targetOrigins.filter(
        (origin) => !draft.originBindings.includes(origin),
      );
      if (outside.length)
        throw new ContractError(
          "PRECONDITION_FAILED",
          "An environment using this profile would leave its origin bindings",
          { environmentId: environment.id, origins: outside },
        );
    }
    const credentialsChanged =
      patch.secrets !== undefined ||
      patch.config !== undefined ||
      patch.originBindings !== undefined;
    if (patch.originBindings) {
      const idp = this.engine.idpOrigins(draft);
      for (const [role, secretId] of Object.entries(draft.managedSecrets))
        this.deps.secrets.rebindManaged(
          secretId,
          role === "refreshToken" ? idp : draft.originBindings,
        );
    }
    this.ctx.entities.update("AuthProfile", this.ctx.workspaceId, id, expectedVersion, draft);
    if (credentialsChanged) await this.resetSession(draft, "profile_changed", false);
    auditSecurity(this.ctx, "auth.profile.update", id, "allowed");
    return this.view(draft);
  }
  private referencingEnvironments(profileId: string): { id: string; targetOrigins: string[] }[] {
    const result: { id: string; targetOrigins: string[] }[] = [];
    for (const env of allEntities(this.ctx, "Environment")) {
      if (env.archivedAt) continue;
      const revision = requireEntity(
        this.ctx,
        "EnvironmentRevision",
        String(env.activeRevisionId),
      ) as Stored<EnvironmentRevision>;
      if (revision.authProfileRefs.includes(profileId))
        result.push({ id: env.id, targetOrigins: revision.targetOrigins });
    }
    return result;
  }
  /** Drops every derived credential: a changed profile never keeps serving a session built from old inputs. */
  private async resetSession(
    profile: StoredAuthProfile,
    reason: string,
    revoke: boolean,
  ): Promise<void> {
    for (const id of Object.values(profile.managedSecrets))
      await this.deps.secrets.eraseManaged(id, { revoke });
    this.store.patch(profile.id, {
      sessionState: revoke ? "revoked" : "unauthenticated",
      reason,
      credentials: {},
      data: {},
      refreshFailures: 0,
      cooldownUntil: null,
    });
    this.cancelPending(profile.id);
  }
  /** Network profile of an environment that uses the profile; it decides what egress the provider call may use. */
  private attachedNetworkProfile(
    profile: StoredAuthProfile,
  ): AuthEnvironment["networkProfile"] | null {
    for (const environment of allEntities(this.ctx, "Environment")) {
      if (environment.projectId !== profile.projectId) continue;
      const found = this.environment(environment.id).environment;
      if (found.authProfileRefs.includes(profile.id)) return found.networkProfile;
    }
    return null;
  }
  private cancelPending(profileId: string): void {
    const pending = this.ctx.database.all(
      "SELECT id FROM auth_checkpoints WHERE workspace_id=? AND auth_profile_id=? AND state='pending'",
      this.ctx.workspaceId,
      profileId,
    );
    for (const row of pending) {
      const checkpoint = requireEntity(
        this.ctx,
        "AuthCheckpoint",
        String(row.id),
      ) as StoredCheckpoint;
      this.ctx.entities.update(
        "AuthCheckpoint",
        this.ctx.workspaceId,
        checkpoint.id,
        checkpoint.version,
        {
          ...checkpoint,
          state: "cancelled",
          resolvedBy: this.ctx.principalId,
          resolvedAt: new Date(this.clock()).toISOString(),
          version: checkpoint.version + 1,
        },
      );
    }
  }

  // --- Session operations -----------------------------------------------------------------------

  /**
   * Performs a real login or refresh against the environment and reports the outcome. It saves no
   * draft, revision or proposal: the only state it can change is the profile's own session.
   */
  async testLogin(id: string, environmentId: string): Promise<AuthTestLoginReceipt> {
    const profile = requireEntity(this.ctx, "AuthProfile", id) as StoredAuthProfile;
    this.ctx.authorize("X", profile.projectId);
    const { environment } = this.environment(environmentId);
    return await auditedOperation(this.ctx, "auth.test_login", id, async () => {
      const receipt = (
        outcome: AuthTestLoginReceipt["outcome"],
        reasonCode: string | null,
        detail: string | null,
        roles: string[] = [],
        expiresAt: string | null = null,
      ): AuthTestLoginReceipt => ({
        profileId: id,
        environmentId,
        outcome,
        reasonCode,
        detail,
        credentialRoles: roles,
        expiresAt,
        draftsChanged: false,
        checkedAt: new Date(this.clock()).toISOString(),
      });
      try {
        const result = await this.engine.ensure(profile, environment, {
          explicit: true,
          interactive: false,
        });
        if (result.browser?.login) {
          if (!this.deps.browserLogin)
            return receipt(
              "blocked",
              "unsupported_capability",
              "Browser login needs an isolated runner",
            );
          const probe = await this.deps.browserLogin({
            profile,
            environment,
            login: result.browser.login,
            secretIds: result.secretIds,
            onAuthState: async (storageState) => {
              this.validateStorageState(profile, storageState);
              await this.engine.acceptStorageState(profile, storageState, undefined, true);
            },
          });
          if (!probe.ok)
            return receipt("failed", probe.reasonCode, "The browser login did not complete");
          const state = this.store.get(id);
          return receipt(
            "authenticated",
            null,
            null,
            result.roles,
            state.credentials.storageState?.expiresAt ?? null,
          );
        }
        return receipt("authenticated", null, null, result.roles, result.expiresAt);
      } catch (error) {
        if (!(error instanceof AuthBlocked)) throw error;
        const checkpointRequired = error.details.checkpointRequired === true;
        const outcome = checkpointRequired
          ? "checkpoint_required"
          : error.reasonCode === "manual_auth_required"
            ? "failed"
            : "blocked";
        return receipt(
          outcome,
          error.reasonCode,
          `${error.authFailure}: ${error.message}`.slice(0, 500),
        );
      }
    });
  }

  async authorize(id: string, environmentId: string): Promise<AuthAuthorization> {
    const profile = requireEntity(this.ctx, "AuthProfile", id) as StoredAuthProfile;
    this.ctx.authorize("X", profile.projectId);
    if (profile.kind !== "oauth" && profile.kind !== "oidc")
      throw new ContractError("INVALID_ARGUMENT", "Only OAuth and OIDC profiles use authorization");
    const { environment } = this.environment(environmentId);
    this.engine.assertBound(profile, environment);
    const begun = await this.engine.beginAuthorization(profile, environment);
    return {
      authorizationId: begun.authorizationId,
      authorizeUrl: begun.authorizeUrl,
      redirectUri: begun.redirectUri,
      expiresAt: begun.expiresAt,
    };
  }
  async completeAuthorization(
    id: string,
    input: { authorizationId: string; inputRef: string },
    environmentId: string,
  ): Promise<AuthProfileView> {
    const profile = requireEntity(this.ctx, "AuthProfile", id) as StoredAuthProfile;
    this.ctx.authorize("X", profile.projectId);
    const { environment } = this.environment(environmentId);
    await auditedOperation(this.ctx, "auth.complete_authorization", id, async () => {
      const redirectUrl = await this.readInput(input.inputRef);
      await this.engine.completeAuthorization(profile, environment, {
        authorizationId: input.authorizationId,
        redirectUrl,
      });
      await this.consumeInput(input.inputRef);
    });
    return this.view(profile);
  }
  /** Reads a human-supplied vault secret (redirect URL, storage state, code); it must not be a managed credential. */
  async readInput(inputRef: string): Promise<string> {
    const secret = this.deps.secrets.get(inputRef);
    if (secret.managedBy)
      throw new ContractError("INVALID_ARGUMENT", "A managed credential cannot be used as input");
    return await (await this.deps.secrets.release(inputRef)).resolve();
  }
  async consumeInput(inputRef: string): Promise<void> {
    await this.deps.secrets.remove(inputRef).catch(() => {});
  }

  /** Stores a browser state a human captured elsewhere; it is validated, bound to the profile's origins and given a TTL. */
  async importState(
    id: string,
    input: { inputRef: string; ttlSeconds?: number },
  ): Promise<AuthProfileView> {
    const profile = requireEntity(this.ctx, "AuthProfile", id) as StoredAuthProfile;
    this.ctx.authorize("X", profile.projectId);
    if (!profile.managedSecrets.storageState)
      throw new ContractError("INVALID_ARGUMENT", "This auth kind has no browser storage state");
    await auditedOperation(this.ctx, "auth.import_state", id, async () => {
      const text = await this.readInput(input.inputRef);
      this.validateStorageState(profile, text);
      await this.engine.acceptStorageState(profile, text, input.ttlSeconds, true);
      await this.consumeInput(input.inputRef);
    });
    return this.view(profile);
  }
  validateStorageState(profile: StoredAuthProfile, text: string): void {
    if (Buffer.byteLength(text) > MAX_STATE_BYTES)
      throw new ContractError("INVALID_ARGUMENT", "Storage state exceeds the size limit");
    let parsed: { cookies?: unknown; origins?: unknown };
    try {
      parsed = JSON.parse(text) as { cookies?: unknown; origins?: unknown };
    } catch {
      throw new ContractError("INVALID_ARGUMENT", "Storage state is not valid JSON");
    }
    if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins))
      throw new ContractError("INVALID_ARGUMENT", "Storage state must contain cookies and origins");
    const hosts = new Set(profile.originBindings.map((origin) => new URL(origin).hostname));
    for (const cookie of parsed.cookies as { domain?: unknown }[])
      if (!hosts.has(String(cookie?.domain ?? "").replace(/^\./u, "")))
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Storage state has a cookie outside the bound origins",
        );
    for (const entry of parsed.origins as { origin?: unknown }[]) {
      let host = "";
      try {
        host = new URL(String(entry?.origin)).hostname;
      } catch {
        /* rejected below */
      }
      if (!hosts.has(host))
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Storage state has an origin outside the bound origins",
        );
    }
  }

  /**
   * Returns the captured storage state to a caller who holds an unexpired `SecretReference:export`
   * grant and re-enters their password. The vault copy's own lifetime is capped at the export TTL.
   */
  async exportState(
    id: string,
    input: { password: string; ttlSeconds?: number },
  ): Promise<AuthStateExport> {
    const profile = requireEntity(this.ctx, "AuthProfile", id) as StoredAuthProfile;
    this.ctx.authorize("R", profile.projectId);
    this.ctx.authorizeNamed("export", "SecretReference", profile.projectId);
    const ttlSeconds = input.ttlSeconds ?? 300;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > MAX_EXPORT_TTL_SECONDS)
      throw new ContractError("INVALID_ARGUMENT", "Export lifetime is outside the allowed range", {
        minSeconds: 60,
        maxSeconds: MAX_EXPORT_TTL_SECONDS,
      });
    return await auditedOperation(this.ctx, "auth.export_state", id, async () => {
      if (this.ctx.actor.credentialKind !== null)
        await this.deps.stepUp(input.password, "export-state");
      const state = this.store.get(id);
      const meta = state.credentials.storageState;
      const secretId = profile.managedSecrets.storageState;
      if (!secretId || !meta?.expiresAt || Date.parse(meta.expiresAt) <= this.clock())
        throw new ContractError("PRECONDITION_FAILED", "No unexpired storage state is available", {
          reasonCode: "manual_auth_required",
        });
      const secret = this.deps.secrets.get(secretId);
      if (secret.provider === "managed" || secret.revokedAt)
        throw new ContractError("PRECONDITION_FAILED", "No unexpired storage state is available", {
          reasonCode: "manual_auth_required",
        });
      const storageState = await (await this.deps.secrets.release(secretId)).resolve();
      const exportExpiresAt = new Date(this.clock() + ttlSeconds * 1000);
      if (Date.parse(meta.expiresAt) > exportExpiresAt.getTime())
        this.store.patch(id, {
          credentials: {
            ...state.credentials,
            storageState: { ...meta, expiresAt: exportExpiresAt.toISOString() },
          },
        });
      return {
        profileId: id,
        storageState,
        sha256: createHash("sha256").update(storageState).digest("hex"),
        capturedAt: meta.capturedAt ?? new Date(this.clock()).toISOString(),
        expiresAt: meta.expiresAt,
        exportExpiresAt: exportExpiresAt.toISOString(),
      };
    });
  }

  /** Ends use of the session: derived credentials and storage state are deleted and Runs are blocked until re-authentication. */
  async revokeSession(id: string): Promise<AuthProfileView> {
    const profile = requireEntity(this.ctx, "AuthProfile", id) as StoredAuthProfile;
    this.ctx.authorize("W", profile.projectId);
    await auditedOperation(this.ctx, "auth.revoke_session", id, async () => {
      const networkProfile = this.attachedNetworkProfile(profile);
      if (networkProfile) await this.engine.revokeAtProvider(profile, { networkProfile });
      await this.resetSession(profile, "session_revoked", true);
    });
    return this.view(profile);
  }

  // --- Worker integration -----------------------------------------------------------------------

  /** Brings every profile of the environment to a usable state before the Attempt starts. */
  async prepare(input: PrepareInput): Promise<PreparedAuth> {
    const secretIds = new Set<string>();
    let runnerAuth: PreparedAuth["runnerAuth"] = null;
    let browserProfile: StoredAuthProfile | null = null;
    for (const profileId of input.environment.authProfileRefs) {
      const profile = requireEntity(this.ctx, "AuthProfile", profileId) as StoredAuthProfile;
      const options: EnsureOptions = {
        interactive: input.interactive,
        run: { id: input.run.id, attemptId: input.attemptId, requestedBy: input.run.requestedBy },
        signal: input.signal,
        deadlineAt: input.deadlineAt,
      };
      const result = await this.engine.ensure(profile, input.environment, options);
      for (const id of result.secretIds) secretIds.add(id);
      if (result.browser) {
        if (browserProfile)
          throw new AuthBlocked(
            "security_precondition_failed",
            "An environment may use only one browser login profile",
            "origin_denied",
          );
        browserProfile = profile;
        runnerAuth = {
          ...(result.browser.storageStateSecretId
            ? { storageState: { secretRef: result.browser.storageStateSecretId } }
            : {}),
          ...(result.browser.login ? { login: result.browser.login } : {}),
        };
      }
    }
    const captured = browserProfile;
    return {
      secretIds: [...secretIds],
      runnerAuth,
      onAuthState: async (storageState) => {
        if (!captured)
          throw new ContractError("INTERNAL", "No browser login profile expects a storage state");
        this.validateStorageState(captured, storageState);
        await this.engine.acceptStorageState(captured, storageState, undefined, false);
      },
      finish: (result) => {
        if (result.reasonCode !== "manual_auth_required") return;
        if (captured && runnerAuth?.login) {
          this.engine.recordBrowserLoginFailure(captured, input.environment, {
            id: input.run.id,
            attemptId: input.attemptId,
            requestedBy: input.run.requestedBy,
          });
          return;
        }
        for (const profileId of input.environment.authProfileRefs)
          this.engine.markTargetRejected(
            requireEntity(this.ctx, "AuthProfile", profileId) as StoredAuthProfile,
          );
      },
    };
  }

  /** Ids of managed secrets across the profiles of an environment; used to explain plan references. */
  managedIds(profileIds: readonly string[]): string[] {
    return profileIds.flatMap((id) =>
      Object.values(
        (requireEntity(this.ctx, "AuthProfile", id) as StoredAuthProfile).managedSecrets,
      ),
    );
  }
  /** Lists plan steps that name a managed secret of a profile that is not attached to the environment. */
  unattachedReferences(plan: ExecutablePlan | null, environment: AuthEnvironment): string[] {
    if (!plan) return [];
    const referenced = new Set<string>();
    collectSecretRefs(plan, referenced);
    const attached = new Set(this.managedIds(environment.authProfileRefs));
    return [...referenced].filter((id) => {
      const secret = this.deps.secrets.get(id);
      return secret.managedBy !== undefined && !attached.has(id);
    });
  }
}
