import { type Static, Type } from "@sinclair/typebox";
import { Step } from "../plans.js";
import * as P from "../primitives.js";
import { RunnerEvent } from "../protocol.js";

/** Largest JSON body a remote worker sends; a finalize carries the Attempt's runner events. */
export const REMOTE_WORKER_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
/** How long a remote worker waits between two empty claims. */
export const REMOTE_CLAIM_INTERVAL_MS = 1000;
/** How often a remote worker renews the lease of each Attempt it runs (a lease lasts 30 s). */
export const REMOTE_HEARTBEAT_INTERVAL_MS = 10_000;

const Count = Type.Integer({ minimum: 0 });
const Short = Type.String({ minLength: 1, maxLength: 128 });
/** A path inside an Attempt's input or bundle directory: relative, normalized, no `..`. */
const RelativePath = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: "^(?!.*(?:^|/)\\.\\.?(?:/|$))[^/\\u0000-\\u001f]+(?:/[^/\\u0000-\\u001f]+)*$",
});

export const remoteWorkerContracts = {
  /** The identity a `tm_wrk_` credential resolves to; presenting it the first time enrolls it. */
  RemoteWorkerIdentity: P.Obj({
    workerId: P.id("wrk"),
    /** True for an operator's pool worker that claims for every workspace. */
    shared: Type.Boolean(),
    labels: Type.Record(Type.String(), P.Name),
    state: P.Enum(["enrolling", "ready", "draining", "revoked", "offline"]),
  }),
  /** What the worker can run now; the server compares it with the Attempts the worker holds. */
  RemoteClaimInput: P.Obj({
    handshake: P.Obj({
      schemaVersions: Type.Array(Short, { maxItems: 100 }),
      runnerVersion: Short,
      runners: Type.Array(Short, { maxItems: 100 }),
      actions: Type.Array(Short, { maxItems: 100 }),
      imageDigests: Type.Array(Short, { maxItems: 100 }),
    }),
    capacity: P.Obj({
      cpu: Type.Number({ minimum: 0 }),
      memoryBytes: Count,
      pids: Count,
      diskBytes: Count,
      pools: P.Obj({ browser: Count, http: Count, python: Count, terminal: Count }),
    }),
    /** Concurrent Attempts this worker runs; counted once in the fair-share slots. */
    slots: Type.Integer({ minimum: 1, maximum: 64 }),
    /** `draining`: the worker stops claiming and finishes what it holds. */
    state: P.Enum(["ready", "draining"]),
    architecture: Short,
    os: Short,
  }),
  /** At most one claimed Attempt; null when nothing is claimable or the worker may not claim. */
  RemoteClaim: P.Obj({
    state: P.Enum(["enrolling", "ready", "draining", "revoked", "offline"]),
    attempt: Type.Union([
      P.Obj({
        attemptId: P.id("att"),
        runId: P.id("run"),
        workspaceId: P.id("ws"),
        leaseExpiresAt: P.Timestamp,
        /** The sandbox input without its input directory, which the worker chooses. */
        dispatch: Type.Record(Type.String(), P.Json),
        inputFiles: Type.Array(
          P.Obj({
            path: RelativePath,
            sizeBytes: Count,
            sha256: P.ContentDigest,
            mode: Type.Integer({ minimum: 0, maximum: 0o777 }),
          }),
          { maxItems: 10_000 },
        ),
        /** The Run's evidence quotas, which the worker's own store enforces while it seals. */
        evidenceLimits: P.Obj({ objectBytes: Count, attemptBytes: Count }),
      }),
      Type.Null(),
    ]),
  }),
  RemoteAttemptLease: P.Obj({ leaseExpiresAt: P.Timestamp, cancelRequested: Type.Boolean() }),
  RemoteEventInput: P.Obj({ sequence: Count, event: RunnerEvent }),
  RemoteSecretInput: P.Obj({ secretRef: P.id("sec"), secretVersion: P.Version }),
  RemoteSecretValue: P.Obj({ value: Type.String() }),
  RemoteCaptureInput: P.Obj({ capture: Type.Record(Type.String(), P.Json) }),
  RemoteCapture: P.Obj({ capture: Type.Record(Type.String(), P.Json) }),
  RemoteAuthStateInput: P.Obj({ storageState: Type.String({ maxLength: 16 * 1024 * 1024 }) }),
  RemoteActionInput: P.Obj({ stepId: P.Name, observation: P.Json }),
  RemoteAction: P.Obj({ action: Type.Union([Step, Type.Null()]) }),
  RemoteBundleFile: P.Obj({ path: RelativePath, sizeBytes: Count, sha256: P.ContentDigest }),
  RemoteFinalizeInput: P.Obj({
    result: P.Obj({
      outcome: P.Outcome,
      reasonCode: P.Name,
      facts: Type.Optional(Type.Record(Type.String(), P.Json)),
      bundle: Type.Optional(
        P.Obj({
          manifestSha256: P.ContentDigest,
          files: Type.Array(
            P.Obj({ path: RelativePath, sizeBytes: Count, sha256: P.ContentDigest }),
            { maxItems: 10_000 },
          ),
        }),
      ),
      logDropped: Count,
      events: Type.Array(RunnerEvent),
      cleanupFailure: Type.Optional(
        P.Obj({
          type: P.Enum(["container", "browser_profile"]),
          containerName: Type.Optional(P.Name),
          details: Type.Optional(P.Description),
        }),
      ),
    }),
  }),
  RemoteFailInput: P.Obj({
    error: P.Obj({
      code: P.Name,
      reasonCode: Type.Optional(P.Name),
      message: Type.Optional(P.Description),
      /** `container_cleanup_failed` names the container the worker could not remove. */
      containerName: Type.Optional(P.Name),
    }),
  }),
  RemoteAck: P.Obj({ accepted: Type.Literal(true) }),
};
export type RemoteWorkerIdentity = Static<typeof remoteWorkerContracts.RemoteWorkerIdentity>;
export type RemoteClaimInput = Static<typeof remoteWorkerContracts.RemoteClaimInput>;
export type RemoteClaim = Static<typeof remoteWorkerContracts.RemoteClaim>;
export type RemoteClaimedAttempt = NonNullable<RemoteClaim["attempt"]>;
export type RemoteAttemptLease = Static<typeof remoteWorkerContracts.RemoteAttemptLease>;
export type RemoteFinalizeInput = Static<typeof remoteWorkerContracts.RemoteFinalizeInput>;
export type RemoteFailInput = Static<typeof remoteWorkerContracts.RemoteFailInput>;
export type RemoteBundleFile = Static<typeof remoteWorkerContracts.RemoteBundleFile>;
export type RemoteEventInput = Static<typeof remoteWorkerContracts.RemoteEventInput>;
export type RemoteSecretInput = Static<typeof remoteWorkerContracts.RemoteSecretInput>;
export type RemoteCaptureInput = Static<typeof remoteWorkerContracts.RemoteCaptureInput>;
export type RemoteCapture = Static<typeof remoteWorkerContracts.RemoteCapture>;
export type RemoteAuthStateInput = Static<typeof remoteWorkerContracts.RemoteAuthStateInput>;
export type RemoteActionInput = Static<typeof remoteWorkerContracts.RemoteActionInput>;
export type RemoteAction = Static<typeof remoteWorkerContracts.RemoteAction>;
