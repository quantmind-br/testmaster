import { type AuthSessionState, ContractError } from "@testmaster/contracts";
import type { ServiceContext } from "../context.js";

export interface CredentialMeta {
  capturedAt: string | null;
  expiresAt: string | null;
}
export interface ProfileState {
  profileId: string;
  sessionState: AuthSessionState;
  reason: string | null;
  /** Role → capture and expiry times of the value held in the vault. */
  credentials: Record<string, CredentialMeta>;
  /** Cached discovery document, fingerprints of the inputs a derived credential was built from, … */
  data: Record<string, unknown>;
  lastRefreshAt: string | null;
  refreshWindowStartedAt: string | null;
  refreshCount: number;
  refreshFailures: number;
  cooldownUntil: string | null;
  otpFailures: number;
  otpWindowStartedAt: string | null;
  otpLockedUntil: string | null;
  leaseHolder: string | null;
  leaseUntil: string | null;
  fence: number;
  version: number;
}
export type StatePatch = Partial<
  Omit<ProfileState, "profileId" | "fence" | "leaseHolder" | "leaseUntil" | "version">
>;

const columns = {
  sessionState: "session_state",
  reason: "reason",
  lastRefreshAt: "last_refresh_at",
  refreshWindowStartedAt: "refresh_window_started_at",
  refreshCount: "refresh_count",
  refreshFailures: "refresh_failures",
  cooldownUntil: "cooldown_until",
  otpFailures: "otp_failures",
  otpWindowStartedAt: "otp_window_started_at",
  otpLockedUntil: "otp_locked_until",
} as const satisfies Record<string, string>;

function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** Per-profile session state, counters and the cross-process refresh lease (SEC-023). */
export class AuthStateStore {
  constructor(private readonly ctx: ServiceContext) {}
  private row(profileId: string): Record<string, unknown> | undefined {
    return this.ctx.database.get(
      "SELECT * FROM auth_profile_state WHERE workspace_id=? AND profile_id=?",
      this.ctx.workspaceId,
      profileId,
    );
  }
  /** Creates the row on first use; the profile must exist. */
  ensure(profileId: string): ProfileState {
    const existing = this.row(profileId);
    if (existing) return this.parse(existing);
    const now = new Date().toISOString();
    this.ctx.database.run(
      "INSERT INTO auth_profile_state(workspace_id,profile_id,created_at,session_state,data_json,updated_at) VALUES(?,?,?,'unauthenticated','{}',?) ON CONFLICT DO NOTHING",
      this.ctx.workspaceId,
      profileId,
      now,
      now,
    );
    const created = this.row(profileId);
    if (!created) throw new ContractError("INTERNAL", "Auth profile state could not be created");
    return this.parse(created);
  }
  get(profileId: string): ProfileState {
    return this.ensure(profileId);
  }
  private parse(row: Record<string, unknown>): ProfileState {
    const data = JSON.parse(String(row.data_json)) as {
      credentials?: Record<string, CredentialMeta>;
      [key: string]: unknown;
    };
    const { credentials = {}, ...rest } = data;
    return {
      profileId: String(row.profile_id),
      sessionState: String(row.session_state) as AuthSessionState,
      reason: nullable(row.reason),
      credentials,
      data: rest,
      lastRefreshAt: nullable(row.last_refresh_at),
      refreshWindowStartedAt: nullable(row.refresh_window_started_at),
      refreshCount: Number(row.refresh_count),
      refreshFailures: Number(row.refresh_failures),
      cooldownUntil: nullable(row.cooldown_until),
      otpFailures: Number(row.otp_failures),
      otpWindowStartedAt: nullable(row.otp_window_started_at),
      otpLockedUntil: nullable(row.otp_locked_until),
      leaseHolder: nullable(row.lease_holder),
      leaseUntil: nullable(row.lease_until),
      fence: Number(row.fence),
      version: Number(row.version),
    };
  }
  patch(profileId: string, patch: StatePatch): ProfileState {
    const current = this.ensure(profileId);
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      assignments.push(`${column}=?`);
      values.push((patch as Record<string, unknown>)[key] ?? null);
    }
    if (patch.credentials !== undefined || patch.data !== undefined) {
      assignments.push("data_json=?");
      values.push(
        JSON.stringify({
          ...(patch.data ?? current.data),
          credentials: patch.credentials ?? current.credentials,
        }),
      );
    }
    assignments.push("updated_at=?", "version=version+1");
    values.push(new Date().toISOString());
    this.ctx.database.run(
      `UPDATE auth_profile_state SET ${assignments.join(",")} WHERE workspace_id=? AND profile_id=?`,
      ...values,
      this.ctx.workspaceId,
      profileId,
    );
    return this.ensure(profileId);
  }
  /**
   * Takes the profile's refresh lease. Exactly one holder across processes gets a fence; the
   * fence increases every time, so a holder that lost its lease can be detected before it writes.
   */
  acquireLease(profileId: string, holder: string, ttlMs: number): number | null {
    this.ensure(profileId);
    const now = new Date();
    const result = this.ctx.database.run(
      "UPDATE auth_profile_state SET lease_holder=?,lease_until=?,fence=fence+1,updated_at=? WHERE workspace_id=? AND profile_id=? AND (lease_holder IS NULL OR lease_until<=?)",
      holder,
      new Date(now.getTime() + ttlMs).toISOString(),
      now.toISOString(),
      this.ctx.workspaceId,
      profileId,
      now.toISOString(),
    );
    return result.changes === 1 ? this.ensure(profileId).fence : null;
  }
  releaseLease(profileId: string, holder: string): void {
    this.ctx.database.run(
      "UPDATE auth_profile_state SET lease_holder=NULL,lease_until=NULL,updated_at=? WHERE workspace_id=? AND profile_id=? AND lease_holder=?",
      new Date().toISOString(),
      this.ctx.workspaceId,
      profileId,
      holder,
    );
  }
  /** A holder whose lease expired or was taken over must stop before it writes a credential. */
  assertFence(profileId: string, holder: string, fence: number): void {
    const state = this.ensure(profileId);
    if (state.leaseHolder !== holder || state.fence !== fence)
      throw new ContractError("REVISION_CONFLICT", "Authentication lease was lost", {
        reasonCode: "manual_auth_required",
        authFailure: "lease_lost",
      });
  }
}
