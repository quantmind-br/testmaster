import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  type AuthCheckpointKind,
  type AuthFormConfig,
  type AuthManualConfig,
  type AuthOAuthConfig,
  type AuthRefreshPolicy,
  type AuthSessionState,
  ContractError,
  defaults,
  type PlanStep,
  validate,
} from "@testmaster/contracts";
import { auditSecurity } from "../audit.js";
import { entity, type ServiceContext } from "../context.js";
import type { SecretsService } from "../secrets.js";
import { performHttpLogin } from "./http-login.js";
import { AuthNetwork, EgressDenied } from "./net.js";
import {
  acceptTokens,
  authorizeUrl,
  cognitoAdapterUnavailable,
  cognitoMfaResponse,
  cognitoPasswordLogin,
  cognitoRefresh,
  fetchJwks,
  originOf,
  pkcePair,
  randomToken,
  resolveEndpoints,
  sha256Hex,
  TokenError,
  tokenRequest,
} from "./oauth.js";
import type { AuthStateStore, ProfileState } from "./state.js";
import { diagnoseClock, parseSeed, secondsLeftInStep, totpCode } from "./totp.js";
import {
  AuthBlocked,
  type AuthEnvironment,
  type StoredAuthProfile,
  type StoredCheckpoint,
} from "./types.js";

/** One refresh or login per profile and process at a time; followers share the leader's outcome. */
const inflight = new Map<string, Promise<void>>();
const LEASE_MS = 30_000;
const CHECKPOINT_POLL_MS = 250;

export interface EnsureOptions {
  /** A human started this (test login, re-authentication): contact the provider and reset failure caps. */
  explicit?: boolean;
  /** The run may wait for a human to resolve a checkpoint. */
  interactive: boolean;
  /** Present inside a Run; checkpoints reference it. Absent for profile-level tests. */
  run?: { id: string; attemptId: string; requestedBy: string };
  signal?: AbortSignal;
  /** Epoch milliseconds after which waiting must stop (the Run's attempt deadline). */
  deadlineAt?: number;
  /** Set on the pass that follows a resolved checkpoint, so a second one is never opened. */
  afterCheckpoint?: boolean;
}
/** What the Attempt needs besides the managed secrets the plan already references. */
export interface EnsureResult {
  roles: string[];
  expiresAt: string | null;
  /** Managed secret ids the Attempt must be able to resolve. */
  secretIds: string[];
  browser?: {
    storageStateSecretId?: string;
    login?: { steps: PlanStep[]; captureState: boolean };
  };
}

function parseConfig<T>(name: string, profile: StoredAuthProfile): T {
  return validate<T>(name, profile.config);
}

export class AuthEngine {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly secrets: SecretsService,
    readonly store: AuthStateStore,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Origins that receive the profile's credentials: the identity provider or login endpoint. */
  idpOrigins(profile: StoredAuthProfile): string[] {
    if (profile.kind === "oauth" || profile.kind === "oidc") {
      const config = parseConfig<AuthOAuthConfig>("AuthOAuthConfig", profile);
      const origins = new Set<string>([originOf(config.issuer)]);
      for (const endpoint of Object.values(config.endpoints ?? {})) origins.add(originOf(endpoint));
      if (config.adapter === "cognito" && config.cognito) {
        origins.add(
          originOf(
            config.cognito.endpoint ??
              `https://cognito-idp.${config.cognito.region}.amazonaws.com/`,
          ),
        );
      }
      return [...origins];
    }
    if (profile.kind === "form") {
      const config = parseConfig<AuthFormConfig>("AuthFormConfig", profile);
      return config.http ? [originOf(config.http.loginUrl)] : [];
    }
    return [];
  }
  network(profile: StoredAuthProfile, env: AuthEnvironment): AuthNetwork {
    return new AuthNetwork({
      allowedOrigins: [...new Set([...profile.originBindings, ...this.idpOrigins(profile)])],
      networkProfile: env.networkProfile,
    });
  }
  /** The profile may only serve environments whose origins it is bound to. */
  assertBound(profile: StoredAuthProfile, env: AuthEnvironment): void {
    if (profile.projectId !== env.projectId)
      throw new AuthBlocked(
        "security_precondition_failed",
        "Auth profile belongs to another project",
        "origin_denied",
      );
    const outside = env.targetOrigins.filter((origin) => !profile.originBindings.includes(origin));
    if (outside.length)
      throw new AuthBlocked(
        "security_precondition_failed",
        "Auth profile is not bound to every target origin of the environment",
        "origin_denied",
        { origins: outside },
      );
  }

  /** Reads a vault secret for a request to `url`; refuses before resolving if the origin is not bound. */
  private async readFor(secretId: string, url: string): Promise<string> {
    const meta = this.secrets.get(secretId);
    if (meta.revokedAt)
      throw new AuthBlocked("credential_revoked", "Credential was revoked", "secret_revoked");
    if (!meta.allowedOrigins.includes(originOf(url)))
      throw new AuthBlocked(
        "security_precondition_failed",
        "Secret is not authorized for the destination origin",
        "origin_denied",
        { secretRef: secretId },
      );
    return (await (await this.secrets.release(secretId)).resolve()).trim();
  }
  private async readManaged(profile: StoredAuthProfile, role: string): Promise<string | null> {
    const id = profile.managedSecrets[role];
    if (!id) return null;
    const meta = this.secrets.get(id);
    if (meta.provider === "managed" || meta.revokedAt) return null;
    return await (await this.secrets.release(id)).resolve();
  }
  private async writeManaged(
    profile: StoredAuthProfile,
    role: string,
    value: string,
    expiresAtMs: number | null,
    rearm = false,
  ): Promise<void> {
    const id = profile.managedSecrets[role];
    if (!id)
      throw new ContractError("INVALID_ARGUMENT", "Auth profile has no such managed credential", {
        role,
      });
    await this.secrets.writeManaged(id, value, { rearm });
    const state = this.store.get(profile.id);
    this.store.patch(profile.id, {
      credentials: {
        ...state.credentials,
        [role]: {
          capturedAt: new Date(this.clock()).toISOString(),
          expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
        },
      },
    });
  }
  private isFresh(profile: StoredAuthProfile, state: ProfileState, role: string): boolean {
    const credential = state.credentials[role];
    const id = profile.managedSecrets[role];
    if (!credential?.expiresAt || !id) return false;
    const meta = this.secrets.get(id);
    if (meta.provider === "managed" || meta.revokedAt) return false;
    return (
      Date.parse(credential.expiresAt) - profile.refreshPolicy.skewSeconds * 1000 > this.clock()
    );
  }

  // --- Bounded, single-flight refresh -------------------------------------------------------

  /** Runs `work` under the profile's lease; concurrent callers in this process share one flight. */
  private async singleFlight(
    profile: StoredAuthProfile,
    options: EnsureOptions,
    fresh: () => boolean,
    work: (lease: { holder: string; fence: number }) => Promise<void>,
  ): Promise<void> {
    const key = `${this.ctx.workspaceId}:${profile.id}`;
    const running = inflight.get(key);
    if (running) return await running;
    const flight = (async () => {
      const holder = `${process.pid}:${randomUUID()}`;
      const giveUpAt = Math.min(options.deadlineAt ?? Infinity, this.clock() + LEASE_MS);
      for (;;) {
        if (fresh()) return;
        const fence = this.store.acquireLease(profile.id, holder, LEASE_MS);
        if (fence !== null) {
          try {
            if (fresh()) return;
            await work({ holder, fence });
          } finally {
            this.store.releaseLease(profile.id, holder);
          }
          return;
        }
        if (options.signal?.aborted || this.clock() >= giveUpAt)
          throw new AuthBlocked(
            "manual_auth_required",
            "Another process is refreshing this credential",
            "refresh_in_progress",
          );
        await delay(100);
      }
    })();
    inflight.set(key, flight);
    try {
      await flight;
    } finally {
      inflight.delete(key);
    }
  }
  private admitAttempt(
    profile: StoredAuthProfile,
    explicit: boolean,
    policy: AuthRefreshPolicy,
  ): ProfileState {
    let state = this.store.get(profile.id);
    const now = this.clock();
    if (explicit && (state.refreshFailures || state.cooldownUntil))
      state = this.store.patch(profile.id, { refreshFailures: 0, cooldownUntil: null });
    if (state.cooldownUntil && Date.parse(state.cooldownUntil) > now)
      throw new AuthBlocked(
        "manual_auth_required",
        "Authentication is cooling down after a failed attempt",
        "refresh_cooldown",
        { until: state.cooldownUntil },
      );
    if (state.refreshFailures >= policy.maxConsecutiveFailures)
      throw new AuthBlocked(
        "manual_auth_required",
        "Authentication failed repeatedly; re-authentication is required",
        "reauth_required",
      );
    const windowOpen =
      state.refreshWindowStartedAt !== null &&
      now - Date.parse(state.refreshWindowStartedAt) < 3_600_000;
    const count = windowOpen ? state.refreshCount : 0;
    if (count >= policy.maxRefreshesPerHour)
      throw new AuthBlocked(
        "manual_auth_required",
        "Authentication attempts exceeded the hourly limit",
        "refresh_rate_limited",
      );
    return this.store.patch(profile.id, {
      refreshCount: count + 1,
      refreshWindowStartedAt: windowOpen
        ? state.refreshWindowStartedAt
        : new Date(now).toISOString(),
    });
  }
  private failAttempt(
    profile: StoredAuthProfile,
    reason: string,
    sessionState: AuthSessionState,
  ): void {
    const state = this.store.get(profile.id);
    this.store.patch(profile.id, {
      refreshFailures: state.refreshFailures + 1,
      cooldownUntil: new Date(
        this.clock() + profile.refreshPolicy.cooldownSeconds * 1000,
      ).toISOString(),
      sessionState,
      reason,
    });
    auditSecurity(this.ctx, "auth.refresh", profile.id, "denied");
  }
  private succeed(profile: StoredAuthProfile): void {
    this.store.patch(profile.id, {
      refreshFailures: 0,
      cooldownUntil: null,
      sessionState: "authenticated",
      reason: null,
      lastRefreshAt: new Date(this.clock()).toISOString(),
    });
    auditSecurity(this.ctx, "auth.login", profile.id, "allowed");
  }

  // --- One-time passwords -------------------------------------------------------------------

  /** Refuses further codes while the profile is locked after repeated rejections (no brute force). */
  private assertOtpAllowed(profile: StoredAuthProfile): void {
    const state = this.store.get(profile.id);
    if (state.otpLockedUntil && Date.parse(state.otpLockedUntil) > this.clock())
      throw new AuthBlocked(
        "manual_auth_required",
        "One-time password attempts are locked",
        "otp_locked",
        { until: state.otpLockedUntil },
      );
  }
  private noteOtpFailure(
    profile: StoredAuthProfile,
    otp: NonNullable<AuthFormConfig["otp"]>,
  ): void {
    const state = this.store.get(profile.id);
    const now = this.clock();
    const windowMs = (otp.windowSeconds ?? 300) * 1000;
    const open =
      state.otpWindowStartedAt !== null && now - Date.parse(state.otpWindowStartedAt) < windowMs;
    const failures = (open ? state.otpFailures : 0) + 1;
    const locked = failures >= (otp.maxFailures ?? 3);
    this.store.patch(profile.id, {
      otpFailures: locked ? 0 : failures,
      otpWindowStartedAt: open ? state.otpWindowStartedAt : new Date(now).toISOString(),
      otpLockedUntil: locked ? new Date(now + windowMs).toISOString() : state.otpLockedUntil,
      ...(locked ? { sessionState: "locked" as const, reason: "otp_locked" } : {}),
    });
  }
  /**
   * Generates the current code from the vault seed immediately before use. A code in the last
   * seconds of its step waits for the next one so it cannot expire in flight.
   */
  private async currentOtp(
    profile: StoredAuthProfile,
    otp: NonNullable<AuthFormConfig["otp"]>,
    destination: string,
  ): Promise<{ code: string; periodSeconds: number } | null> {
    const seedId = profile.secrets.totpSeed;
    if (seedId) {
      const { key, options } = parseSeed(await this.readFor(seedId, destination));
      const merged = {
        algorithm: otp.algorithm ?? options.algorithm ?? "SHA1",
        digits: otp.digits ?? options.digits ?? 6,
        periodSeconds: otp.periodSeconds ?? options.periodSeconds ?? 30,
      };
      if (secondsLeftInStep(this.clock(), merged.periodSeconds) < 3) await delay(3200);
      return { code: totpCode(key, this.clock(), merged), periodSeconds: merged.periodSeconds };
    }
    const supplied = await this.readManaged(profile, "otp");
    if (supplied) {
      // A human-supplied code is single use.
      await this.secrets.eraseManaged(profile.managedSecrets.otp as string, { revoke: false });
      return { code: supplied.trim(), periodSeconds: otp.periodSeconds ?? 30 };
    }
    return null;
  }
  private otpRejected(
    profile: StoredAuthProfile,
    otp: NonNullable<AuthFormConfig["otp"]>,
    dateHeader: string | undefined,
    periodSeconds: number,
  ): AuthBlocked {
    this.noteOtpFailure(profile, otp);
    const drift = diagnoseClock(dateHeader, this.clock(), periodSeconds);
    if (drift.status === "skewed")
      return new AuthBlocked(
        "manual_auth_required",
        "One-time password rejected: the clocks differ by more than one time step",
        "clock_skew",
        { driftSeconds: drift.driftSeconds },
      );
    return new AuthBlocked(
      "manual_auth_required",
      "One-time password was rejected",
      "otp_rejected",
    );
  }

  // --- Checkpoints --------------------------------------------------------------------------

  private findPendingCheckpoint(
    attemptId: string,
    profileId: string,
  ): StoredCheckpoint | undefined {
    const row = this.ctx.database.get(
      "SELECT id FROM auth_checkpoints WHERE workspace_id=? AND attempt_id=? AND auth_profile_id=? AND state='pending'",
      this.ctx.workspaceId,
      attemptId,
      profileId,
    );
    return row
      ? (this.ctx.entities.get("AuthCheckpoint", this.ctx.workspaceId, String(row.id)) as
          | StoredCheckpoint
          | undefined)
      : undefined;
  }
  /** Records a human-resolvable pendency and, when interactive, waits for it. Never solves anything. */
  private async needHuman(
    profile: StoredAuthProfile,
    env: AuthEnvironment,
    options: EnsureOptions,
    kind: AuthCheckpointKind,
    authFailure: string,
    authorization?: { id: string; url: string },
  ): Promise<void> {
    if (!options.run || options.afterCheckpoint)
      throw new AuthBlocked(
        "manual_auth_required",
        "Authentication needs a human step",
        options.afterCheckpoint ? "checkpoint_unresolved" : authFailure,
        { kind, checkpointRequired: true },
      );
    const ttl = defaults.manualAuthCheckpointMs;
    const expiresAt = new Date(Math.min(this.clock() + ttl, options.deadlineAt ?? Infinity));
    const existing = this.findPendingCheckpoint(options.run.attemptId, profile.id);
    const checkpoint =
      existing ??
      (entity(this.ctx, "acp", {
        runId: options.run.id,
        attemptId: options.run.attemptId,
        authProfileId: profile.id,
        challengeRef: `${kind}:${env.id}`.slice(0, 120),
        expiresAt: expiresAt.toISOString(),
        state: "pending",
        kind,
        requestedBy: options.run.requestedBy,
        resolvedBy: null,
        resolvedAt: null,
        authorizationId: authorization?.id ?? null,
        authorizeUrl: authorization?.url ?? null,
      }) as StoredCheckpoint);
    if (!existing) {
      this.ctx.entities.insert("AuthCheckpoint", checkpoint);
      this.store.patch(profile.id, { sessionState: "reauth_required", reason: authFailure });
      auditSecurity(this.ctx, "auth.checkpoint.created", checkpoint.id, "allowed");
    }
    if (!options.interactive)
      throw new AuthBlocked(
        "manual_auth_required",
        "Authentication needs a human step and this run cannot wait for one",
        authFailure,
        { kind, checkpointId: checkpoint.id },
      );
    await this.awaitCheckpoint(checkpoint.id, options);
  }
  private async awaitCheckpoint(id: string, options: EnsureOptions): Promise<void> {
    for (;;) {
      const current = this.ctx.entities.get("AuthCheckpoint", this.ctx.workspaceId, id) as
        | StoredCheckpoint
        | undefined;
      if (!current)
        throw new AuthBlocked(
          "manual_auth_required",
          "Checkpoint disappeared",
          "checkpoint_missing",
        );
      if (current.state === "completed") return;
      if (current.state === "cancelled")
        throw new AuthBlocked(
          "manual_auth_required",
          "The authentication checkpoint was cancelled",
          "checkpoint_cancelled",
          { checkpointId: id },
        );
      if (current.state === "expired" || Date.parse(current.expiresAt) <= this.clock()) {
        if (current.state === "pending")
          this.ctx.entities.update("AuthCheckpoint", this.ctx.workspaceId, id, current.version, {
            ...current,
            state: "expired",
            version: current.version + 1,
          });
        auditSecurity(this.ctx, "auth.checkpoint.expired", id, "denied");
        throw new AuthBlocked(
          "auth_checkpoint_expired",
          "The authentication checkpoint expired before it was resolved",
          "checkpoint_expired",
          { checkpointId: id },
        );
      }
      if (options.signal?.aborted)
        throw new AuthBlocked(
          "manual_auth_required",
          "The run was cancelled while waiting for authentication",
          "checkpoint_abandoned",
          { checkpointId: id },
        );
      await delay(CHECKPOINT_POLL_MS);
    }
  }

  // --- Entry point --------------------------------------------------------------------------

  /** Brings one profile to a usable state for `env` and reports what the Attempt needs. */
  async ensure(
    profile: StoredAuthProfile,
    env: AuthEnvironment,
    options: EnsureOptions,
  ): Promise<EnsureResult> {
    this.assertBound(profile, env);
    const state = this.store.get(profile.id);
    if (state.sessionState === "revoked" && !options.explicit)
      throw new AuthBlocked(
        "credential_revoked",
        "The authentication session was revoked",
        "session_revoked",
      );
    switch (profile.kind) {
      case "bearer":
      case "api-key":
      case "cookie":
        return this.ensureStatic(profile);
      case "basic":
        return await this.ensureBasic(profile, env, options);
      case "form": {
        const config = parseConfig<AuthFormConfig>("AuthFormConfig", profile);
        return config.browser
          ? await this.ensureBrowser(profile, env, options, config)
          : await this.ensureHttp(profile, env, options, config);
      }
      case "oauth":
      case "oidc":
        return await this.ensureOAuth(profile, env, options);
      case "manual":
        return await this.ensureManual(profile, env, options);
    }
  }

  private ensureStatic(profile: StoredAuthProfile): EnsureResult {
    for (const id of profile.secretRefs) {
      if (this.secrets.get(id).revokedAt)
        throw new AuthBlocked("credential_revoked", "Credential was revoked", "secret_revoked", {
          secretRef: id,
        });
    }
    return { roles: Object.keys(profile.secrets), expiresAt: null, secretIds: [] };
  }

  private async ensureBasic(
    profile: StoredAuthProfile,
    env: AuthEnvironment,
    options: EnsureOptions,
  ): Promise<EnsureResult> {
    const usernameId = profile.secrets.username;
    const passwordId = profile.secrets.password;
    if (!usernameId || !passwordId)
      throw new AuthBlocked("missing_secret", "Basic profile has no credentials", "missing_secret");
    const fingerprint = sha256Hex(
      [usernameId, passwordId].map((id) => `${id}:${this.secrets.get(id).secretVersion}`).join("|"),
    );
    const state = this.store.get(profile.id);
    const authorizationId = profile.managedSecrets.authorization as string;
    if (
      !options.explicit &&
      state.data.basicFingerprint === fingerprint &&
      this.secrets.get(authorizationId).provider !== "managed"
    )
      return { roles: ["authorization"], expiresAt: null, secretIds: [authorizationId] };
    const target = env.targetOrigins[0] ?? profile.originBindings[0] ?? "";
    const username = await this.readFor(usernameId, target);
    const password = await this.readFor(passwordId, target);
    await this.writeManaged(
      profile,
      "authorization",
      `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      null,
      options.explicit,
    );
    this.store.patch(profile.id, {
      data: { ...this.store.get(profile.id).data, basicFingerprint: fingerprint },
    });
    this.succeed(profile);
    return { roles: ["authorization"], expiresAt: null, secretIds: [authorizationId] };
  }

  private async ensureHttp(
    profile: StoredAuthProfile,
    env: AuthEnvironment,
    options: EnsureOptions,
    config: AuthFormConfig,
  ): Promise<EnsureResult> {
    const login = config.http;
    if (!login)
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Form profile has neither http nor browser login",
      );
    const roles = login.success.tokenPointer ? ["token"] : ["session"];
    const role = roles[0] as string;
    const result = (): EnsureResult => ({
      roles,
      expiresAt: this.store.get(profile.id).credentials[role]?.expiresAt ?? null,
      secretIds: [profile.managedSecrets[role] as string],
    });
    const fresh = () =>
      !options.explicit && this.isFresh(profile, this.store.get(profile.id), role);
    if (config.challenge) {
      // A declared human challenge (CAPTCHA, WebAuthn, …) is never attempted automatically.
      if (fresh()) return result();
      await this.needHuman(profile, env, options, config.challenge.kind, "challenge_required");
      return await this.ensure(profile, env, { ...options, afterCheckpoint: true });
    }
    try {
      await this.singleFlight(profile, options, fresh, async (lease) => {
        const policy = profile.refreshPolicy;
        this.admitAttempt(profile, options.explicit === true, policy);
        const network = this.network(profile, env);
        const destination = login.loginUrl;
        network.assertAllowed(destination);
        const usernameId = profile.secrets.username;
        const passwordId = profile.secrets.password;
        if (!usernameId || !passwordId)
          throw new AuthBlocked(
            "missing_secret",
            "Form profile has no credentials",
            "missing_secret",
          );
        const username = await this.readFor(usernameId, destination);
        const password = await this.readFor(passwordId, destination);
        let otp: { code: string; periodSeconds: number } | null = null;
        if (config.otp && login.fields.otp) {
          this.assertOtpAllowed(profile);
          otp = await this.currentOtp(profile, config.otp, destination);
          if (!otp) {
            // No seed and no human-supplied code.
            throw new AuthBlocked(
              "manual_auth_required",
              "A one-time password is required and none is available",
              "otp_unavailable",
            );
          }
        }
        const outcome = await performHttpLogin(
          network,
          login,
          { username, password, ...(otp ? { otp: otp.code } : {}) },
          this.clock(),
        );
        this.store.assertFence(profile.id, lease.holder, lease.fence);
        if (outcome.kind === "challenge") {
          this.failAttempt(profile, "challenge_required", "reauth_required");
          throw new AuthBlocked(
            "manual_auth_required",
            "The login page requires a human challenge",
            "challenge_required",
            { kind: outcome.challenge },
          );
        }
        if (outcome.kind === "rejected") {
          this.failAttempt(profile, "login_rejected", "reauth_required");
          if (otp && config.otp)
            throw this.otpRejected(profile, config.otp, outcome.dateHeader, otp.periodSeconds);
          throw new AuthBlocked(
            "manual_auth_required",
            "The login was rejected",
            "login_rejected",
            {
              status: outcome.status,
            },
          );
        }
        const ttlMs = (login.ttlSeconds ?? policy.stateTtlSeconds) * 1000;
        const cookieExpiry = outcome.cookies
          .map((cookie) => cookie.expiresAtMs)
          .filter((value): value is number => value !== null);
        const expiresAt = Math.min(this.clock() + ttlMs, ...cookieExpiry);
        const value =
          role === "token"
            ? `${login.success.tokenScheme ?? "Bearer"} ${outcome.token}`
            : outcome.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
        await this.writeManaged(profile, role, value, expiresAt, options.explicit);
        this.succeed(profile);
      });
    } catch (error) {
      if (error instanceof EgressDenied)
        throw new AuthBlocked("egress_denied", "Login endpoint is not allowed", "origin_denied");
      throw error;
    }
    return result();
  }

  private async ensureBrowser(
    profile: StoredAuthProfile,
    env: AuthEnvironment,
    options: EnsureOptions,
    config: AuthFormConfig,
  ): Promise<EnsureResult> {
    const stateId = profile.managedSecrets.storageState as string;
    const state = this.store.get(profile.id);
    if (!options.explicit && this.isFresh(profile, state, "storageState"))
      return {
        roles: ["storageState"],
        expiresAt: state.credentials.storageState?.expiresAt ?? null,
        secretIds: [stateId],
        browser: { storageStateSecretId: stateId },
      };
    if (config.challenge) {
      await this.needHuman(profile, env, options, config.challenge.kind, "challenge_required");
      return await this.ensure(profile, env, { ...options, afterCheckpoint: true });
    }
    const login = config.browser;
    if (!login) throw new ContractError("INVALID_ARGUMENT", "Form profile has no browser login");
    this.admitAttempt(profile, options.explicit === true, profile.refreshPolicy);
    const secretIds = new Set<string>();
    const collect = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) {
        if (key === "secretRef" && typeof item === "string") secretIds.add(item);
        else collect(item);
      }
    };
    collect(login.steps);
    if (config.otp && profile.managedSecrets.otp) {
      this.assertOtpAllowed(profile);
      const destination = env.targetOrigins[0] ?? profile.originBindings[0] ?? "";
      const otp = await this.currentOtp(profile, config.otp, destination);
      if (otp) {
        await this.writeManaged(
          profile,
          "otp",
          otp.code,
          this.clock() + otp.periodSeconds * 2000,
          options.explicit === true,
        );
        secretIds.add(profile.managedSecrets.otp);
      }
    }
    return {
      roles: ["storageState"],
      expiresAt: null,
      secretIds: [...secretIds],
      browser: { login: { steps: login.steps as PlanStep[], captureState: true } },
    };
  }

  /** Stores a captured or imported browser state and starts its TTL. */
  async acceptStorageState(
    profile: StoredAuthProfile,
    storageState: string,
    ttlSeconds: number | undefined,
    explicit: boolean,
  ): Promise<string> {
    const ttl = (ttlSeconds ?? profile.refreshPolicy.stateTtlSeconds) * 1000;
    const expiresAt = this.clock() + ttl;
    await this.writeManaged(profile, "storageState", storageState, expiresAt, explicit);
    this.succeed(profile);
    return new Date(expiresAt).toISOString();
  }
  /** Stores a one-time code a human read from their own authenticator; it is erased after one use. */
  async acceptOtp(profile: StoredAuthProfile, code: string): Promise<void> {
    await this.writeManaged(
      profile,
      "otp",
      code.trim(),
      this.clock() + defaults.manualAuthCheckpointMs,
      true,
    );
  }
  /** A browser login that did not finish: count it, and leave a pendency a human can resolve. */
  recordBrowserLoginFailure(
    profile: StoredAuthProfile,
    env: AuthEnvironment,
    run: { id: string; attemptId: string; requestedBy: string },
  ): StoredCheckpoint | null {
    const config = parseConfig<AuthFormConfig>("AuthFormConfig", profile);
    this.failAttempt(profile, "login_rejected", "reauth_required");
    if (config.otp) this.noteOtpFailure(profile, config.otp);
    if (this.findPendingCheckpoint(run.attemptId, profile.id)) return null;
    const checkpoint = entity(this.ctx, "acp", {
      runId: run.id,
      attemptId: run.attemptId,
      authProfileId: profile.id,
      challengeRef: `expired-state:${env.id}`,
      expiresAt: new Date(this.clock() + defaults.manualAuthCheckpointMs).toISOString(),
      state: "pending",
      kind: config.challenge?.kind ?? "expired-state",
      requestedBy: run.requestedBy,
      resolvedBy: null,
      resolvedAt: null,
      authorizationId: null,
      authorizeUrl: null,
    }) as StoredCheckpoint;
    this.ctx.entities.insert("AuthCheckpoint", checkpoint);
    auditSecurity(this.ctx, "auth.checkpoint.created", checkpoint.id, "allowed");
    return checkpoint;
  }

  private async ensureManual(
    profile: StoredAuthProfile,
    env: AuthEnvironment,
    options: EnsureOptions,
  ): Promise<EnsureResult> {
    const config = parseConfig<AuthManualConfig>("AuthManualConfig", profile);
    const state = this.store.get(profile.id);
    const stateId = profile.managedSecrets.storageState;
    if (stateId && !options.explicit && this.isFresh(profile, state, "storageState"))
      return {
        roles: ["storageState"],
        expiresAt: state.credentials.storageState?.expiresAt ?? null,
        secretIds: [stateId],
        browser: { storageStateSecretId: stateId },
      };
    await this.needHuman(
      profile,
      env,
      options,
      config.challenge.kind,
      Object.keys(state.credentials).length ? "state_expired" : "challenge_required",
    );
    return await this.ensure(profile, env, { ...options, afterCheckpoint: true });
  }

  // --- OAuth / OIDC / Cognito ---------------------------------------------------------------

  private async ensureOAuth(
    profile: StoredAuthProfile,
    env: AuthEnvironment,
    options: EnsureOptions,
  ): Promise<EnsureResult> {
    const config = parseConfig<AuthOAuthConfig>("AuthOAuthConfig", profile);
    const accessId = profile.managedSecrets.accessToken as string;
    const result = (): EnsureResult => ({
      roles: ["accessToken"],
      expiresAt: this.store.get(profile.id).credentials.accessToken?.expiresAt ?? null,
      secretIds: [accessId],
    });
    const fresh = () =>
      !options.explicit && this.isFresh(profile, this.store.get(profile.id), "accessToken");
    const pending: { human: { kind: AuthCheckpointKind; failure: string } | null } = {
      human: null,
    };
    try {
      await this.singleFlight(profile, options, fresh, async (lease) => {
        this.admitAttempt(profile, options.explicit === true, profile.refreshPolicy);
        const network = this.network(profile, env);
        const refreshToken = await this.readManaged(profile, "refreshToken");
        if (refreshToken) {
          try {
            await this.refreshTokens(profile, config, network, refreshToken, lease, options);
            this.succeed(profile);
            return;
          } catch (error) {
            if (!(error instanceof TokenError) || !this.isGrantRejected(error)) throw error;
            // The refresh token is spent or revoked: never retry it.
            await this.secrets.eraseManaged(profile.managedSecrets.refreshToken as string, {
              revoke: false,
            });
            this.failAttempt(profile, "refresh_rejected", "reauth_required");
            pending.human = { kind: "reauthorization", failure: "refresh_rejected" };
          }
        }
        if (config.adapter === "cognito" && profile.secrets.username && profile.secrets.password) {
          const outcome = await this.cognitoLogin(profile, config, network, lease, options);
          if (outcome === "ok") {
            pending.human = null;
            this.succeed(profile);
          } else pending.human = outcome;
          return;
        }
        pending.human ??= { kind: "reauthorization", failure: "reauth_required" };
        this.store.patch(profile.id, {
          sessionState: "reauth_required",
          reason: pending.human.failure,
        });
      });
    } catch (error) {
      if (error instanceof EgressDenied)
        throw new AuthBlocked(
          "egress_denied",
          "Identity provider endpoint is not allowed",
          "origin_denied",
        );
      if (error instanceof TokenError)
        throw new AuthBlocked(
          "manual_auth_required",
          "The identity provider rejected the request",
          "provider_rejected",
          { providerError: error.code },
        );
      throw error;
    }
    if (!pending.human) return result();
    const { kind, failure } = pending.human;
    let authorization: { id: string; url: string } | undefined;
    if (kind === "reauthorization" && options.run && !options.afterCheckpoint) {
      // The checkpoint carries the URL a human opens to authorize again.
      try {
        const begun = await this.beginAuthorization(profile, env);
        authorization = { id: begun.authorizationId, url: begun.authorizeUrl };
      } catch {
        authorization = undefined;
      }
    }
    await this.needHuman(profile, env, options, kind, failure, authorization);
    return await this.ensure(profile, env, { ...options, afterCheckpoint: true });
  }
  private isGrantRejected(error: TokenError): boolean {
    return (
      error.code === "invalid_grant" ||
      error.code === "NotAuthorizedException" ||
      (error.status === 400 && error.code === "invalid_request")
    );
  }
  private async refreshTokens(
    profile: StoredAuthProfile,
    config: AuthOAuthConfig,
    network: AuthNetwork,
    refreshToken: string,
    lease: { holder: string; fence: number },
    options: EnsureOptions,
  ): Promise<void> {
    void options;
    if (config.adapter === "cognito") {
      const clientSecretId = profile.secrets.clientSecret;
      const username = profile.secrets.username
        ? await this.readFor(profile.secrets.username, config.cognito?.endpoint ?? config.issuer)
        : "";
      const clientSecret = clientSecretId
        ? await this.readFor(clientSecretId, config.cognito?.endpoint ?? config.issuer)
        : undefined;
      const result = await cognitoRefresh(network, config, {
        refreshToken,
        username,
        ...(clientSecret ? { clientSecret } : {}),
      });
      if (!result.tokens) throw new TokenError("provider_response_invalid", 200);
      await this.storeTokens(
        profile,
        lease,
        {
          accessToken: result.tokens.accessToken,
          ...(result.tokens.refreshToken ? { refreshToken: result.tokens.refreshToken } : {}),
          expiresInSeconds: result.tokens.expiresInSeconds,
        },
        options.explicit === true,
      );
      return;
    }
    const endpoints = await resolveEndpoints(network, config);
    const form: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
    };
    if (profile.secrets.clientSecret)
      form.client_secret = await this.readFor(profile.secrets.clientSecret, endpoints.token);
    const document = await tokenRequest(network, endpoints.token, form);
    const jwks =
      endpoints.jwks && config.audience ? await fetchJwks(network, endpoints.jwks) : undefined;
    const tokens = acceptTokens(config, document, {
      nowMs: this.clock(),
      requireIdToken: false,
      ...(jwks ? { jwks } : {}),
    });
    await this.storeTokens(profile, lease, tokens, options.explicit === true);
  }
  private async cognitoLogin(
    profile: StoredAuthProfile,
    config: AuthOAuthConfig,
    network: AuthNetwork,
    lease: { holder: string; fence: number },
    options: EnsureOptions,
  ): Promise<"ok" | { kind: AuthCheckpointKind; failure: string }> {
    const destination = config.cognito?.endpoint ?? config.issuer;
    const username = await this.readFor(profile.secrets.username as string, destination);
    const password = await this.readFor(profile.secrets.password as string, destination);
    const clientSecret = profile.secrets.clientSecret
      ? await this.readFor(profile.secrets.clientSecret, destination)
      : undefined;
    try {
      let result = await cognitoPasswordLogin(network, config, {
        username,
        password,
        ...(clientSecret ? { clientSecret } : {}),
      });
      if (result.challenge) {
        if (result.challenge.name !== "SOFTWARE_TOKEN_MFA")
          return { kind: "push", failure: "challenge_required" };
        if (!config.otp) return { kind: "webauthn", failure: "challenge_required" };
        this.assertOtpAllowed(profile);
        const otp = await this.currentOtp(profile, config.otp, destination);
        if (!otp)
          throw new AuthBlocked(
            "manual_auth_required",
            "A one-time password is required and none is available",
            "otp_unavailable",
          );
        try {
          result = await cognitoMfaResponse(network, config, {
            username,
            code: otp.code,
            session: result.challenge.session,
            ...(clientSecret ? { clientSecret } : {}),
          });
        } catch (error) {
          if (
            error instanceof TokenError &&
            (error.code === "CodeMismatchException" || error.code === "ExpiredCodeException")
          ) {
            this.failAttempt(profile, "otp_rejected", "reauth_required");
            throw this.otpRejected(profile, config.otp, undefined, otp.periodSeconds);
          }
          throw error;
        }
      }
      if (!result.tokens) return { kind: "push", failure: "challenge_required" };
      this.store.assertFence(profile.id, lease.holder, lease.fence);
      if (config.audience || result.tokens.idToken) {
        const endpoints = await resolveEndpoints(network, config);
        const jwks = endpoints.jwks ? await fetchJwks(network, endpoints.jwks) : undefined;
        if (result.tokens.idToken && jwks)
          acceptTokens(
            config,
            {
              access_token: result.tokens.accessToken,
              id_token: result.tokens.idToken,
              scope: config.scopes.join(" "),
            },
            { nowMs: this.clock(), jwks, requireIdToken: true },
          );
      }
      await this.storeTokens(
        profile,
        lease,
        {
          accessToken: result.tokens.accessToken,
          ...(result.tokens.refreshToken ? { refreshToken: result.tokens.refreshToken } : {}),
          expiresInSeconds: result.tokens.expiresInSeconds,
        },
        options.explicit === true,
      );
      return "ok";
    } catch (error) {
      if (error instanceof TokenError) {
        if (cognitoAdapterUnavailable(error)) {
          // The pool does not allow the password flow: do not guess another way in.
          this.failAttempt(profile, "adapter_unavailable", "reauth_required");
          return { kind: "adapter-unavailable", failure: "adapter_unavailable" };
        }
        this.failAttempt(profile, "login_rejected", "reauth_required");
        throw new AuthBlocked("manual_auth_required", "The login was rejected", "login_rejected", {
          providerError: error.code,
        });
      }
      // Anything else (network, protocol) is reported as is.
      throw error;
    }
  }
  /**
   * The rotated refresh token is stored before the access token and the state, so a crash never
   * leaves a spent one behind. `rearm` is true only for an explicit human re-authentication; a
   * refresh that races a revocation fails on the revoked slot instead of reviving the session.
   */
  private async storeTokens(
    profile: StoredAuthProfile,
    lease: { holder: string; fence: number } | null,
    tokens: { accessToken: string; refreshToken?: string; expiresInSeconds: number },
    rearm: boolean,
  ): Promise<void> {
    if (lease) this.store.assertFence(profile.id, lease.holder, lease.fence);
    if (tokens.refreshToken)
      await this.writeManaged(profile, "refreshToken", tokens.refreshToken, null, rearm);
    if (lease) this.store.assertFence(profile.id, lease.holder, lease.fence);
    const config = parseConfig<AuthOAuthConfig>("AuthOAuthConfig", profile);
    await this.writeManaged(
      profile,
      "accessToken",
      `${config.tokenScheme ?? "Bearer"} ${tokens.accessToken}`,
      this.clock() + tokens.expiresInSeconds * 1000,
      rearm,
    );
  }

  // --- Authorization-code enrollment ---------------------------------------------------------

  /** Starts an authorization-code flow with PKCE, state and (OIDC) nonce; returns the URL for a human. */
  async beginAuthorization(
    profile: StoredAuthProfile,
    env: AuthEnvironment,
  ): Promise<{
    authorizationId: string;
    authorizeUrl: string;
    redirectUri: string;
    expiresAt: string;
  }> {
    const config = parseConfig<AuthOAuthConfig>("AuthOAuthConfig", profile);
    if (config.adapter === "cognito" && !config.endpoints?.authorization)
      throw new AuthBlocked(
        "manual_auth_required",
        "The Cognito adapter has no hosted authorization endpoint",
        "adapter_unavailable",
      );
    const network = this.network(profile, env);
    const endpoints = await resolveEndpoints(network, config);
    const { verifier, challenge } = pkcePair();
    const state = randomToken();
    const nonce = profile.kind === "oidc" ? randomToken() : undefined;
    const expiresAt = new Date(this.clock() + 600_000).toISOString();
    const verifierSecret = await this.secrets.protectCapture(
      `pkce-${profile.id}-${randomToken(6)}`,
      verifier,
      [originOf(endpoints.token)],
    );
    const id = `aza_${randomUUID().replaceAll("-", "")}`;
    this.ctx.database.run(
      "INSERT INTO auth_authorizations(workspace_id,id,created_at,profile_id,state_hash,nonce,verifier_secret_id,redirect_uri,scopes_json,created_by,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      this.ctx.workspaceId,
      id,
      new Date(this.clock()).toISOString(),
      profile.id,
      sha256Hex(state),
      nonce ?? null,
      verifierSecret.id,
      config.redirectUri,
      JSON.stringify(config.scopes),
      this.ctx.principalId,
      expiresAt,
    );
    auditSecurity(this.ctx, "auth.authorize", profile.id, "allowed");
    return {
      authorizationId: id,
      authorizeUrl: authorizeUrl(endpoints, config, {
        state,
        challenge,
        scopes: config.scopes,
        ...(nonce ? { nonce } : {}),
      }),
      redirectUri: config.redirectUri,
      expiresAt,
    };
  }
  /** Exchanges the code a human obtained from the identity provider; the redirect URL is a vault secret. */
  async completeAuthorization(
    profile: StoredAuthProfile,
    env: AuthEnvironment,
    input: { authorizationId: string; redirectUrl: string },
  ): Promise<void> {
    const config = parseConfig<AuthOAuthConfig>("AuthOAuthConfig", profile);
    const row = this.ctx.database.get(
      "SELECT * FROM auth_authorizations WHERE workspace_id=? AND id=? AND profile_id=?",
      this.ctx.workspaceId,
      input.authorizationId,
      profile.id,
    );
    if (!row) throw new ContractError("NOT_FOUND", "Authorization does not exist");
    if (row.consumed_at || Date.parse(String(row.expires_at)) <= this.clock())
      throw new AuthBlocked(
        "security_precondition_failed",
        "Authorization was already used or has expired",
        "state_mismatch",
      );
    let callback: URL;
    try {
      callback = new URL(input.redirectUrl.trim());
    } catch {
      throw new ContractError("INVALID_ARGUMENT", "Redirect URL is not a valid URL");
    }
    const registered = new URL(String(row.redirect_uri));
    if (callback.origin !== registered.origin || callback.pathname !== registered.pathname)
      throw new AuthBlocked(
        "security_precondition_failed",
        "Redirect does not match the registered redirect URI",
        "redirect_mismatch",
      );
    const state = callback.searchParams.get("state");
    if (!state || sha256Hex(state) !== String(row.state_hash))
      throw new AuthBlocked(
        "security_precondition_failed",
        "Authorization state does not match",
        "state_mismatch",
      );
    // Consume before the exchange: a code is never exchanged twice, whatever happens next.
    const consumed = this.ctx.database.run(
      "UPDATE auth_authorizations SET consumed_at=?,version=version+1 WHERE workspace_id=? AND id=? AND consumed_at IS NULL",
      new Date(this.clock()).toISOString(),
      this.ctx.workspaceId,
      input.authorizationId,
    );
    if (consumed.changes !== 1)
      throw new AuthBlocked(
        "security_precondition_failed",
        "Authorization was already used",
        "state_mismatch",
      );
    const providerError = callback.searchParams.get("error");
    const code = callback.searchParams.get("code");
    if (providerError || !code)
      throw new AuthBlocked(
        "manual_auth_required",
        "The identity provider did not grant authorization",
        "provider_rejected",
        { providerError: providerError ?? "missing_code" },
      );
    const network = this.network(profile, env);
    const endpoints = await resolveEndpoints(network, config);
    const verifier = await (await this.secrets.release(String(row.verifier_secret_id))).resolve();
    const form: Record<string, string> = {
      grant_type: "authorization_code",
      code,
      redirect_uri: String(row.redirect_uri),
      client_id: config.clientId,
      code_verifier: JSON.parse(verifier) as string,
    };
    if (profile.secrets.clientSecret)
      form.client_secret = await this.readFor(profile.secrets.clientSecret, endpoints.token);
    try {
      const document = await tokenRequest(network, endpoints.token, form);
      const jwks = endpoints.jwks ? await fetchJwks(network, endpoints.jwks) : undefined;
      const nonce = row.nonce ? String(row.nonce) : undefined;
      const tokens = acceptTokens(config, document, {
        nowMs: this.clock(),
        requireIdToken: profile.kind === "oidc",
        ...(jwks ? { jwks } : {}),
        ...(nonce ? { nonce } : {}),
      });
      await this.secrets.remove(String(row.verifier_secret_id)).catch(() => {});
      await this.storeTokens(profile, null, tokens, true);
      this.succeed(profile);
    } catch (error) {
      if (error instanceof TokenError)
        throw new AuthBlocked(
          "manual_auth_required",
          "The identity provider rejected the authorization code",
          "provider_rejected",
          { providerError: error.code },
        );
      if (error instanceof EgressDenied)
        throw new AuthBlocked(
          "egress_denied",
          "Identity provider endpoint is not allowed",
          "origin_denied",
        );
      throw error;
    }
  }
}
