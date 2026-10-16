import {
  type AuthCheckpointKind,
  type AuthKind,
  type AuthRefreshPolicy,
  ContractError,
} from "@testmaster/contracts";
import type { EntityDocument } from "@testmaster/persistence";

/** Reason codes that end a Run `blocked` before any dependent action (SEC-024, M4-03). */
export type AuthBlockReason =
  | "manual_auth_required"
  | "auth_checkpoint_expired"
  | "missing_secret"
  | "credential_revoked"
  | "security_precondition_failed"
  | "egress_denied";
export const authBlockReasons: ReadonlySet<string> = new Set<AuthBlockReason>([
  "manual_auth_required",
  "auth_checkpoint_expired",
  "missing_secret",
  "credential_revoked",
  "security_precondition_failed",
  "egress_denied",
]);

/**
 * Authentication could not produce a usable credential. `authFailure` says why in terms an
 * operator can act on (rejected login, OTP lock, clock skew, …); it never contains credential bytes.
 */
export class AuthBlocked extends ContractError {
  constructor(
    readonly reasonCode: AuthBlockReason,
    message: string,
    readonly authFailure: string,
    extra: Record<string, unknown> = {},
  ) {
    super(
      reasonCode === "manual_auth_required" || reasonCode === "auth_checkpoint_expired"
        ? "PRECONDITION_FAILED"
        : "POLICY_DENIED",
      message,
      { reasonCode, authFailure, ...extra },
    );
  }
}

export const defaultRefreshPolicy: AuthRefreshPolicy = {
  skewSeconds: 60,
  maxRefreshesPerHour: 12,
  cooldownSeconds: 60,
  maxConsecutiveFailures: 3,
  stateTtlSeconds: 3600,
};

/** The stored `AuthProfile` entity. */
export interface StoredAuthProfile extends EntityDocument {
  version: number;
  createdAt: string;
  projectId: string;
  name: string;
  kind: AuthKind;
  originBindings: string[];
  secretRefs: string[];
  secrets: Record<string, string>;
  /** Plain username, never a secret and never redacted; mutually exclusive with `secrets.username`. */
  username?: string;
  managedSecrets: Record<string, string>;
  config: Record<string, unknown>;
  refreshPolicy: AuthRefreshPolicy;
}
export interface StoredCheckpoint extends EntityDocument {
  version: number;
  runId: string;
  attemptId: string;
  authProfileId: string;
  challengeRef: string;
  expiresAt: string;
  state: "pending" | "completed" | "cancelled" | "expired";
  kind?: AuthCheckpointKind;
  requestedBy?: string;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
  authorizationId?: string | null;
  authorizeUrl?: string | null;
}

/** The environment facts the engine needs; matches the stored `EnvironmentRevision`. */
export interface AuthEnvironment {
  id: string;
  projectId: string;
  targetOrigins: readonly string[];
  networkProfile: "public" | "private" | "local-loopback";
  authProfileRefs: readonly string[];
}
