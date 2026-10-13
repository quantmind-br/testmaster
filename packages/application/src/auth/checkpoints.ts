import {
  type AuthCheckpointInput,
  type AuthFormConfig,
  type AuthManualConfig,
  ContractError,
  defaults,
  validate,
} from "@testmaster/contracts";
import { auditedOperation, auditSecurity } from "../audit.js";
import { allEntities, entity, requireEntity, type ServiceContext } from "../context.js";
import type { AuthProfilesService } from "./profiles.js";
import { AuthBlocked, type StoredAuthProfile, type StoredCheckpoint } from "./types.js";

type Resolution = "authorization" | "storage-state" | "otp" | "retry";

/**
 * Manual authentication checkpoints (SEC-024): a pendency a human resolves out of band (CAPTCHA,
 * WebAuthn, push, e-mail code, a fresh authorization). Nothing here solves a challenge; the
 * service only records the pendency, authenticates whoever continues it and enforces its TTL.
 */
export class AuthCheckpointsService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly profiles: AuthProfilesService,
    private readonly clock: () => number = Date.now,
  ) {}

  private profileOf(checkpoint: StoredCheckpoint): StoredAuthProfile {
    return requireEntity(this.ctx, "AuthProfile", checkpoint.authProfileId) as StoredAuthProfile;
  }
  private load(id: string): StoredCheckpoint {
    const checkpoint = requireEntity(this.ctx, "AuthCheckpoint", id) as StoredCheckpoint;
    this.ctx.authorize("R", this.profileOf(checkpoint).projectId);
    return checkpoint;
  }
  get(id: string): StoredCheckpoint {
    return this.sweep(this.load(id));
  }
  list(filter: { runId?: string; profileId?: string; state?: string } = {}): StoredCheckpoint[] {
    this.ctx.authorize("R");
    return (allEntities(this.ctx, "AuthCheckpoint") as StoredCheckpoint[])
      .filter(
        (item) =>
          (!filter.runId || item.runId === filter.runId) &&
          (!filter.profileId || item.authProfileId === filter.profileId) &&
          (!filter.state || item.state === filter.state),
      )
      .flatMap((item) => {
        try {
          return [this.sweep(this.load(item.id))];
        } catch {
          return [];
        }
      });
  }

  /** An unresolved checkpoint past its deadline is recorded as expired and can never be continued. */
  private sweep(checkpoint: StoredCheckpoint): StoredCheckpoint {
    if (checkpoint.state !== "pending" || Date.parse(checkpoint.expiresAt) > this.clock())
      return checkpoint;
    const next: StoredCheckpoint = {
      ...checkpoint,
      state: "expired",
      version: checkpoint.version + 1,
    };
    this.ctx.entities.update(
      "AuthCheckpoint",
      this.ctx.workspaceId,
      checkpoint.id,
      checkpoint.version,
      next,
    );
    auditSecurity(this.ctx, "auth.checkpoint.expired", checkpoint.id, "denied");
    return next;
  }

  /** Called by the authorized worker path when an Attempt needs a human; idempotent per Attempt and profile. */
  create(input: AuthCheckpointInput): StoredCheckpoint {
    this.ctx.authorize("X");
    validate("AuthCheckpointInput", input);
    const run = requireEntity(this.ctx, "Run", input.runId);
    const attempt = requireEntity(this.ctx, "Attempt", input.attemptId);
    const profile = requireEntity(
      this.ctx,
      "AuthProfile",
      input.authProfileId,
    ) as StoredAuthProfile;
    const test = requireEntity(this.ctx, "TestCase", String(run.testId));
    this.ctx.authorize("X", profile.projectId);
    if (attempt.runId !== run.id || test.projectId !== profile.projectId)
      throw new ContractError("INVALID_ARGUMENT", "Checkpoint does not match its Run and profile");
    const existing = this.ctx.database.get(
      "SELECT id FROM auth_checkpoints WHERE workspace_id=? AND attempt_id=? AND auth_profile_id=? AND state='pending'",
      this.ctx.workspaceId,
      attempt.id,
      profile.id,
    );
    if (existing) return this.load(String(existing.id));
    const cell = run.matrixCell as {
      actor?: { principalId?: string };
      limits?: Record<string, number>;
    };
    const startedAt = typeof attempt.startedAt === "string" ? Date.parse(attempt.startedAt) : null;
    const deadline =
      startedAt === null
        ? Infinity
        : startedAt + (cell.limits?.attemptTimeoutMs ?? defaults.attemptTimeoutMs);
    const checkpoint = entity(this.ctx, "acp", {
      runId: run.id,
      attemptId: attempt.id,
      authProfileId: profile.id,
      challengeRef: input.challengeRef,
      expiresAt: new Date(
        Math.min(this.clock() + defaults.manualAuthCheckpointMs, deadline),
      ).toISOString(),
      state: "pending",
      kind: input.kind,
      requestedBy: cell.actor?.principalId ?? this.ctx.principalId,
      resolvedBy: null,
      resolvedAt: null,
      authorizationId: null,
      authorizeUrl: null,
    }) as StoredCheckpoint;
    this.ctx.entities.insert("AuthCheckpoint", checkpoint);
    auditSecurity(this.ctx, "auth.checkpoint.created", checkpoint.id, "allowed");
    return checkpoint;
  }

  /** Only the principal who asked for the Run, or an administrator of the workspace, may resolve it. */
  private assertResolver(checkpoint: StoredCheckpoint, profile: StoredAuthProfile): void {
    this.ctx.authorize("X", profile.projectId);
    if (checkpoint.requestedBy === this.ctx.principalId) return;
    try {
      this.ctx.authorize("A");
    } catch {
      auditSecurity(this.ctx, "auth.checkpoint.resolve", checkpoint.id, "denied");
      throw new ContractError(
        "FORBIDDEN",
        "Only the requester or an administrator can resolve this checkpoint",
      );
    }
  }
  private assertPending(checkpoint: StoredCheckpoint): StoredCheckpoint {
    const current = this.sweep(checkpoint);
    if (current.state === "expired")
      throw new AuthBlocked(
        "auth_checkpoint_expired",
        "The authentication checkpoint expired before it was resolved",
        "checkpoint_expired",
        { checkpointId: current.id },
      );
    if (current.state !== "pending")
      throw new ContractError("PRECONDITION_FAILED", "Checkpoint is already resolved", {
        state: current.state,
      });
    return current;
  }
  private resolution(checkpoint: StoredCheckpoint, profile: StoredAuthProfile): Resolution {
    if (checkpoint.authorizationId) return "authorization";
    const declared =
      profile.kind === "form"
        ? validate<AuthFormConfig>("AuthFormConfig", profile.config).challenge
        : profile.kind === "manual"
          ? validate<AuthManualConfig>("AuthManualConfig", profile.config).challenge
          : undefined;
    return (declared?.resolution as Resolution | undefined) ?? "retry";
  }

  private finish(checkpoint: StoredCheckpoint, state: "completed" | "cancelled"): StoredCheckpoint {
    const next: StoredCheckpoint = {
      ...checkpoint,
      state,
      resolvedBy: this.ctx.principalId,
      resolvedAt: new Date(this.clock()).toISOString(),
      version: checkpoint.version + 1,
    };
    this.ctx.entities.update(
      "AuthCheckpoint",
      this.ctx.workspaceId,
      checkpoint.id,
      checkpoint.version,
      next,
    );
    return next;
  }

  /** Delivers the human-supplied input (a vault secret, never a request value) and releases the waiting Run. */
  async continue(id: string, input: { inputRef?: string } = {}): Promise<StoredCheckpoint> {
    const loaded = this.load(id);
    const profile = this.profileOf(loaded);
    this.assertResolver(loaded, profile);
    const pending = this.assertPending(loaded);
    return await auditedOperation(this.ctx, "auth.checkpoint.continue", id, async () => {
      const resolution = this.resolution(pending, profile);
      if (resolution !== "retry" && !input.inputRef)
        throw new ContractError("INVALID_ARGUMENT", "This checkpoint needs an input secret", {
          resolution,
        });
      if (input.inputRef) {
        const text = await this.profiles.readInput(input.inputRef);
        if (resolution === "authorization") {
          const environmentId = pending.challengeRef.slice(pending.challengeRef.indexOf(":") + 1);
          const { environment } = this.profiles.environment(environmentId);
          await this.profiles.engine.completeAuthorization(profile, environment, {
            authorizationId: String(pending.authorizationId),
            redirectUrl: text,
          });
        } else if (resolution === "storage-state") {
          this.profiles.validateStorageState(profile, text);
          await this.profiles.engine.acceptStorageState(profile, text, undefined, true);
        } else if (resolution === "otp") {
          if (!/^[0-9A-Za-z]{4,12}$/u.test(text.trim()))
            throw new ContractError("INVALID_ARGUMENT", "The supplied code is not a one-time code");
          await this.profiles.engine.acceptOtp(profile, text);
        }
        await this.profiles.consumeInput(input.inputRef);
      }
      return this.finish(pending, "completed");
    });
  }

  async cancel(id: string): Promise<StoredCheckpoint> {
    const loaded = this.load(id);
    this.assertResolver(loaded, this.profileOf(loaded));
    const pending = this.assertPending(loaded);
    return await auditedOperation(this.ctx, "auth.checkpoint.cancel", id, async () =>
      this.finish(pending, "cancelled"),
    );
  }
}
