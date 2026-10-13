/**
 * Shapes of the `/v1` resources the run pages read. They mirror the contracts in
 * packages/contracts but list only the fields the portal uses, so a server addition never
 * breaks a page and a missing field is visible to the type checker.
 */
export type RunPhase =
  | "queued"
  | "preparing"
  | "running"
  | "collecting"
  | "analyzing"
  | "completed";
export type Verdict = "passed" | "failed" | "blocked" | "cancelled" | "inconclusive";
export type StepStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "skipped"
  | "not_run"
  | "inconclusive";

export interface RunRecord {
  readonly id: string;
  readonly testId: string;
  readonly revisionId: string;
  readonly environmentRevisionId: string;
  readonly batchId: string | null;
  readonly mode: string;
  readonly phase: RunPhase;
  readonly status: string;
  readonly outcome: Verdict | null;
  readonly origin: string;
  readonly gate: "pending" | "passed" | "failed" | "not_applicable";
  readonly cleanupOutcome: "not_required" | "pending" | "passed" | "failed" | "inconclusive";
  readonly analysisStatus: "not_requested" | "pending" | "complete" | "partial" | "unavailable";
  readonly reasonCode?: string;
  readonly createdAt: string;
  readonly version: number;
  readonly matrixCell?: RunMatrixCell;
}

export interface RunMatrixCell {
  readonly environmentId?: string;
  readonly environmentName?: string;
  readonly baseUrl?: string;
  readonly seed?: number;
  readonly repetitionIndex?: number;
  readonly correlationId?: string;
  readonly healingPolicy?: string;
  readonly limits?: { readonly maxAttempts?: number };
  readonly admissionSnapshot?: {
    readonly repository?: {
      readonly commitSha?: string | null;
      readonly checkoutSha?: string | null;
      readonly binding?: string;
    };
    readonly generationModel?: string;
  };
}

export interface StepRecord {
  readonly id: string;
  readonly attemptId: string;
  readonly planStepId: string;
  readonly index: number;
  readonly status: StepStatus;
  readonly reasonCode?: string;
  readonly expected: unknown;
  readonly observed: unknown;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly durationMs: number;
  readonly evidenceRefs: readonly { readonly relativePath: string; readonly snapshotId: string }[];
}

export interface AttemptRecord {
  readonly id: string;
  readonly runId: string;
  readonly number: number;
  readonly workerId: string | null;
  readonly phase: RunPhase;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly outcome: Verdict | null;
  readonly kind: "initial" | "retry";
  readonly policy: { readonly maxAttempts: number };
  readonly retry: {
    readonly previousAttemptId: string;
    readonly previousOutcome: Verdict | null;
    readonly category: "infrastructure" | "diagnostic";
    readonly reasonCode: string | null;
  } | null;
}

export interface ManifestEntry {
  readonly relativePath: string;
  readonly artifactId: string;
  readonly kind: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string | null;
  readonly state: "available" | "missing" | "expired" | "partial";
  readonly redactionStatus: "redacted" | "restrictedRaw" | "not_applicable";
  readonly omissionReason?: string;
}

export interface BundleRecord {
  readonly manifest: {
    readonly runId: string;
    readonly attemptId: string;
    readonly revisionId: string;
    readonly snapshotId: string;
    readonly subset?: boolean;
    readonly entries: readonly ManifestEntry[];
  };
}

export interface RunEventEnvelope {
  readonly eventId?: string;
  readonly seq: number;
  readonly type: string;
  readonly runId?: string;
  readonly attemptId?: string | null;
  readonly occurredAt?: string;
  readonly payload?: unknown;
}

export interface ArtifactLinkRecord {
  readonly artifactId: string;
  readonly url: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
  readonly disposition: "inline" | "attachment";
}

export interface CancelReceipt {
  readonly runId: string;
  readonly result: "requested" | "already_terminal" | "rejected";
  readonly status: string;
}
