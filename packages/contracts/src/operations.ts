import { type Static, Type } from "@sinclair/typebox";
import {
  AnalysisStatus,
  ArtifactState,
  CleanupOutcome,
  ContentDigest,
  Description,
  Enum,
  EvidenceRef,
  Extensions,
  Gate,
  id,
  Json,
  Mode,
  Name,
  Nonnegative,
  Obj,
  Outcome,
  Phase,
  Positive,
  RedactionStatus,
  RelativePath,
  StepStatus,
  Timestamp,
  Value,
  Version,
} from "./primitives.js";
import { reasonCodes } from "./registries.js";

export const defaults = Object.freeze({
  controllerBind: "127.0.0.1",
  httpRequestsPerAttempt: 4,
  llmTransportRetries: 1,
  browserCpu: 2,
  browserMemoryBytes: 2147483648,
  browserPids: 256,
  httpCpu: 1,
  httpMemoryBytes: 536870912,
  httpPids: 128,
  pythonCpu: 1,
  pythonMemoryBytes: 1073741824,
  pythonPids: 128,
  rawArtifactBytes: 268435456,
  storageWarningPercent: 80,
  storageSuspendPercent: 90,
  tenantActiveJobs: 1000,
  actorAdmissionsPerMinute: 60,
  actorAdmissionBurst: 20,
  maxPageSize: 100,
  signedLinkMs: 300000,
  tunnelMs: 900000,
  tunnelMaxMs: 3600000,
  tunnelStreams: 32,
  tunnelBytesPerSecond: 10485760,
  tunnelTotalBytes: 536870912,
  localBackup: "manual",
  serverBackup: "daily",
  backupDailyCopies: 7,
  backupWeeklyCopies: 4,
  backupMonthlyCopies: 3,
  scheduleMisfire: "skip",
  scheduleGraceMs: 300000,
  scheduleOverlap: "forbid",
  logRetentionDays: 14,
  executionTimeoutMs: 1800000,
  attemptTimeoutMs: 300000,
  stepTimeoutMs: 30000,
  networkRequestTimeoutMs: 30000,
  preparationTimeoutMs: 120000,
  collectionGraceMs: 60000,
  analysisGraceMs: 60000,
  maxAttempts: 2,
  browserConcurrency: 2,
  httpConcurrency: 4,
  pythonConcurrency: 1,
  batchCells: 500,
  workerHeartbeatMs: 10000,
  workerLeaseMs: 30000,
  cancellationGraceMs: 10000,
  tempBytes: 1073741824,
  bodyBytes: 10485760,
  artifactBytes: 67108864,
  attemptArtifactBytes: 268435456,
  logBytes: 10485760,
  pageSize: 50,
  manualAuthCheckpointMs: 300000,
  approvalMs: 1800000,
  artifactRetentionDays: 30,
  metadataRetentionDays: 90,
  auditRetentionDays: 365,
  llmEnabled: false,
  telemetryEnabled: false,
});
export const ExecutionLimits = Obj({
  executionTimeoutMs: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 7200000, default: defaults.executionTimeoutMs }),
  ),
  attemptTimeoutMs: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 900000, default: defaults.attemptTimeoutMs }),
  ),
  stepTimeoutMs: Type.Optional(Positive),
  networkRequestTimeoutMs: Type.Optional(Positive),
  preparationTimeoutMs: Type.Optional(Positive),
  collectionGraceMs: Type.Optional(Nonnegative),
  analysisGraceMs: Type.Optional(Nonnegative),
  maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 2, default: 2 })),
  bodyBytes: Type.Optional(Positive),
  artifactBytes: Type.Optional(Positive),
  attemptArtifactBytes: Type.Optional(Positive),
  logBytes: Type.Optional(Positive),
});
export const NetworkPolicy = Obj({
  allowedOrigins: Type.Array(Type.String({ format: "uri" })),
  privateTargets: Type.Optional(
    Type.Array(Obj({ host: Name, port: Type.Integer({ minimum: 1, maximum: 65535 }) })),
  ),
  networkProfile: Enum(["public", "local-loopback", "private"]),
  allowInsecureTls: Type.Optional(Type.Boolean()),
  baseUrl: Type.Optional(Type.String({ format: "uri" })),
});
export const ProjectConfig = Obj({
  schemaVersion: Type.Literal("1.0.0"),
  project: Type.Optional(Obj({ name: Name, id: Type.Optional(id("prj")) })),
  execution: Type.Optional(
    Obj({
      ...ExecutionLimits.properties,
      executor: Type.Optional(Enum(["docker", "process"])),
      mode: Type.Optional(Mode),
      concurrency: Type.Optional(Positive),
    }),
  ),
  environment: Type.Optional(
    Obj({
      baseUrl: Type.String({ format: "uri" }),
      networkProfile: Enum(["public", "local-loopback", "private"]),
      locale: Type.Optional(Name),
      timezone: Type.Optional(Name),
      authProfileRefs: Type.Optional(Type.Array(id("aup"))),
    }),
  ),
  browser: Type.Optional(
    Obj({
      name: Enum(["chromium", "firefox", "webkit"]),
      viewport: Type.Optional(Obj({ width: Positive, height: Positive })),
      testIdAttributes: Type.Optional(Type.Array(Name, { minItems: 1 })),
    }),
  ),
  healing: Type.Optional(Obj({ mode: Enum(["off", "propose", "apply"]) })),
  artifacts: Type.Optional(
    Obj({
      trace: Enum(["off", "on"]),
      video: Enum(["off", "on"]),
      httpBodies: Type.Optional(Enum(["off", "on"])),
      retentionDays: Positive,
    }),
  ),
  telemetry: Type.Optional(Obj({ enabled: Type.Boolean() })),
  extensions: Type.Optional(Extensions),
});
export const EffectiveConfig = Obj({
  config: ProjectConfig,
  origins: Type.Record(
    Type.String(),
    Enum(["flag", "environment", "project", "profile", "default"]),
  ),
  policyHash: ContentDigest,
});
export const RunRequest = Obj({
  testId: id("tst"),
  revisionId: Type.Optional(id("rev")),
  environmentId: id("env"),
  mode: Type.Optional(Mode),
  healingPolicy: Type.Optional(Enum(["off", "propose", "apply"])),
  origin: Type.Optional(Enum(["cli", "api", "mcp", "schedule", "webhook", "verification"])),
  seed: Type.Optional(Type.Integer()),
  limits: Type.Optional(ExecutionLimits),
  provenance: Type.Optional(
    Obj({
      commitSha: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      deploymentId: Type.Optional(Type.Union([Name, Type.Null()])),
      dirtyHash: Type.Optional(Type.Union([ContentDigest, Type.Null()])),
      repositoryId: Type.Optional(Type.Union([Name, Type.Null()])),
      checkoutSha: Type.Optional(Type.Union([Type.String({ pattern: "^[0-9a-f]{40}$" }), Type.Null()])),
      baseSha: Type.Optional(Type.Union([Type.String({ pattern: "^[0-9a-f]{40}$" }), Type.Null()])),
    }),
  ),
  /** Frozen repetition identity for flake studies; distinct repetitions are never deduplicated. */
  repetitionIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: 99 })),
  extensions: Type.Optional(Extensions),
});
export const RunReceipt = Obj({
  runId: id("run"),
  status: Type.Union([Phase, Outcome]),
  revisionId: id("rev"),
  environmentRevisionId: id("evr"),
  acceptedAt: Timestamp,
  links: Obj({ self: Type.String(), events: Type.String(), bundle: Type.String() }),
  idempotencyKey: Type.String({ minLength: 16, maxLength: 128 }),
});
export const BatchRequest = Obj({
  selection: Type.Array(RunRequest, { maxItems: 500 }),
  partialDispatch: Type.Optional(Type.Boolean()),
  allowEmpty: Type.Optional(Type.Boolean()),
  bindings: Type.Optional(Type.Array(Json)),
  matrix: Type.Optional(Json),
});
export const BatchCounts = Obj({
  passed: Nonnegative,
  failed: Nonnegative,
  blocked: Nonnegative,
  cancelled: Nonnegative,
  inconclusive: Nonnegative,
  inFlight: Nonnegative,
});
export const BatchReceipt = Obj({
  batchId: id("bat"),
  jobId: Type.Optional(id("bat")),
  requested: Nonnegative,
  accepted: Nonnegative,
  notDispatched: Type.Array(Obj({ memberKey: Name, reasonCode: Enum(reasonCodes) })),
  memberRuns: Type.Array(RunReceipt),
  expanded: Type.Array(RunReceipt),
  allMembers: Type.Array(id("run")),
  counts: BatchCounts,
  gate: Gate,
});
export const RunResult = Obj({
  runId: id("run"),
  phase: Phase,
  outcome: Type.Union([Outcome, Type.Null()]),
  status: Type.Union([Phase, Outcome]),
  gate: Gate,
  cleanupOutcome: CleanupOutcome,
  analysisStatus: AnalysisStatus,
  reasonCode: Type.Optional(Enum(reasonCodes)),
  passedOnRetry: Type.Boolean(),
  firstAttemptOutcome: Type.Union([Outcome, Type.Null()]),
});
export const CancelReceipt = Obj({
  runId: id("run"),
  result: Enum(["requested", "already_terminal", "rejected"]),
  status: Type.Union([Phase, Outcome]),
});
export const Reproduction = Obj({
  degree: Enum(["evidence-replay", "strict-execution-replay", "fresh-llm-regeneration"]),
  limitations: Type.Array(Name),
  originalRunId: Type.Optional(id("run")),
});
export const ArtifactManifest = Obj({
  schemaVersion: Type.Literal("1.0.0"),
  workspaceId: Type.Optional(id("ws")),
  runId: id("run"),
  attemptId: id("att"),
  revisionId: id("rev"),
  snapshotId: id("snp"),
  executionSnapshot: Type.Optional(Json),
  reproduction: Type.Optional(Reproduction),
  entries: Type.Array(
    Obj({
      relativePath: RelativePath,
      artifactId: id("art"),
      kind: Name,
      mimeType: Name,
      sizeBytes: Nonnegative,
      sha256: Type.Union([ContentDigest, Type.Null()]),
      state: ArtifactState,
      redactionStatus: RedactionStatus,
      omissionReason: Type.Optional(Name),
    }),
  ),
  parentSnapshot: Type.Optional(id("snp")),
  subset: Type.Optional(Type.Boolean()),
});
export const BundleMeta = Obj({
  schemaVersion: Type.Literal("1.0.0"),
  workspaceId: Type.Optional(id("ws")),
  runId: id("run"),
  attemptId: id("att"),
  revisionId: id("rev"),
  snapshotId: id("snp"),
  manifestHash: ContentDigest,
  committedAt: Timestamp,
  redactionPolicyHash: ContentDigest,
});
export const UploadRequest = Obj({
  mediaType: Name,
  sizeBytes: Type.Integer({ minimum: 0, maximum: 26214400 }),
  contentHash: ContentDigest,
});
export const PermissionGrant = Obj({
  resourceType: Name,
  actions: Type.Array(
    Enum(["read", "write", "execute", "admin", "approve", "raw", "export", "delete"]),
  ),
  projectIds: Type.Array(id("prj")),
  environmentIds: Type.Array(id("env")),
  expiresAt: Type.Union([Timestamp, Type.Null()]),
  grantedBy: id("usr"),
  deny: Type.Optional(Type.Boolean()),
});
export const StepResult = Obj({
  id: id("stp"),
  attemptId: id("att"),
  planStepId: Name,
  index: Nonnegative,
  status: StepStatus,
  reasonCode: Type.Optional(Enum(reasonCodes)),
  expected: Json,
  observed: Json,
  error: Type.Union([Obj({ code: Name, message: Description }), Type.Null()]),
  durationMs: Nonnegative,
  evidenceRefs: Type.Array(EvidenceRef),
});
export const BackupManifest = Obj({
  schemaVersion: Type.Literal("1.0.0"),
  createdAt: Timestamp,
  files: Type.Array(
    Obj({ relativePath: RelativePath, sizeBytes: Nonnegative, sha256: ContentDigest }),
  ),
  databaseVersion: Version,
  secretIncluded: Type.Literal(false),
  keyIds: Type.Optional(Type.Array(ContentDigest)),
  configDigests: Type.Optional(Type.Array(ContentDigest)),
});
export const RestoreRequest = Obj({
  manifest: BackupManifest,
  destination: Name,
  isolated: Type.Literal(true),
});
export const UsageEntry = Obj({
  provider: Name,
  model: Name,
  reserved: Type.Union([Nonnegative, Type.Null()]),
  actual: Type.Union([Nonnegative, Type.Null()]),
  tokens: Type.Union([Nonnegative, Type.Null()]),
  cost: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  currency: Type.String({ pattern: "^[A-Z]{3}$" }),
  occurredAt: Timestamp,
});
export const Event = Obj({
  schemaVersion: Type.Literal("1.0.0"),
  eventId: id("evt"),
  seq: Nonnegative,
  type: Enum([
    "run.accepted",
    "attempt.started",
    "step.started",
    "step.finished",
    "artifact.available",
    "cleanup.finished",
    "analysis.available",
    "run.completed",
    "run.cancel_requested",
  ]),
  runId: id("run"),
  attemptId: Type.Union([id("att"), Type.Null()]),
  occurredAt: Timestamp,
  payload: Json,
});
export const VariableCapture = Obj({
  name: Name,
  valueType: Enum(["string", "number", "boolean", "object", "array", "null"]),
  sensitive: Type.Boolean(),
  value: Type.Optional(Value),
  encryptedValueRef: Type.Optional(Name),
});
export type ExecutionLimits = Static<typeof ExecutionLimits>;
export type NetworkPolicy = Static<typeof NetworkPolicy>;
export type ProjectConfig = Static<typeof ProjectConfig>;
export type EffectiveConfig = Static<typeof EffectiveConfig>;
export type RunRequest = Static<typeof RunRequest>;
export type RunReceipt = Static<typeof RunReceipt>;
export type RunResult = Static<typeof RunResult>;
export type BatchRequest = Static<typeof BatchRequest>;
export type BatchReceipt = Static<typeof BatchReceipt>;
export type ArtifactManifest = Static<typeof ArtifactManifest>;
export type BundleMeta = Static<typeof BundleMeta>;
export type StepResult = Static<typeof StepResult>;
export type CancelReceipt = Static<typeof CancelReceipt>;
