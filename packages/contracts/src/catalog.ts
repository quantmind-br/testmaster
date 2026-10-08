import { type Static, type TSchema, Type } from "@sinclair/typebox";
import * as Entities from "./entities.js";
import * as Metrics from "./metrics.js";
import * as Ops from "./operations.js";
import * as Plans from "./plans.js";
import * as P from "./primitives.js";
import * as Protocol from "./protocol.js";
import { reasonCodes } from "./registries.js";
import { ErrorEnvelope, mcpTools, SuccessEnvelope } from "./surfaces.js";

const names = Type.Array(P.Name);
/** Model-facing citation of supplied evidence (`E1`, `E2`, …); resolved by the application. */
const EvidenceHandle = Type.String({ pattern: "^E[1-9][0-9]{0,5}$" });
const evidenceIds = (minItems: number) => Type.Array(EvidenceHandle, { minItems, maxItems: 100 });
const HealingPatch = P.Obj({
  changes: Type.Array(
    P.Obj({
      stepId: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
      path: P.JsonPointer,
      value: P.Json,
    }),
    { minItems: 1, maxItems: 20 },
  ),
  evidenceHandles: evidenceIds(1),
  explanation: P.Description,
});
const supplemental = {
  DocumentValidationInput: P.Obj({
    schema: P.Enum(["ExecutablePlan", "ProjectConfig", "RunRequest"]),
    document: P.Json,
  }),
  DocumentValidationResult: P.Obj({ validated: Type.Literal(true), schema: P.Name }),
  AIRequirementsOutput: P.Obj({
    requirements: Type.Array(
      P.Obj({
        key: P.Name,
        text: P.Description,
        acceptanceCriteria: Type.Array(P.Description, { minItems: 1 }),
        evidenceIds: evidenceIds(1),
        originKind: P.Enum(["explicit", "user_spec", "inferred", "observed"]),
        confidence: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
        reason: P.Description,
      }),
      { minItems: 1, maxItems: 100 },
    ),
    conflicts: Type.Array(
      P.Obj({
        keys: Type.Array(P.Name, { minItems: 2 }),
        reason: P.Description,
        evidenceIds: evidenceIds(2),
      }),
    ),
    openQuestions: Type.Array(P.Description),
  }),
  AIRequirementConflictsOutput: P.Obj({
    conflicts: Type.Array(
      P.Obj({
        keys: Type.Array(P.Name, { minItems: 2 }),
        reason: P.Description,
        evidenceIds: evidenceIds(2),
      }),
    ),
    openQuestions: Type.Array(P.Description),
  }),
  AIProposalsOutput: P.Obj({
    proposals: Type.Array(
      P.Obj({
        plan: Plans.ExecutablePlan,
        requirementRefs: Type.Array(P.id("req"), { minItems: 1 }),
        evidenceIds: evidenceIds(1),
        warnings: names,
      }),
      { minItems: 1, maxItems: 50 },
    ),
  }),
  Empty: P.Obj({}),
  TokenBudgetInput: P.Obj({ tokens: P.Nonnegative }),
  Binary: Type.String({ contentEncoding: "base64" }),
  Health: P.Obj({ status: P.Enum(["alive", "ready", "unavailable"]) }),
  ProjectInput: P.Obj({
    name: P.Name,
    workspaceId: Type.Optional(P.id("ws")),
    defaultEnvironmentId: Type.Optional(P.id("env")),
  }),
  WorkspaceInput: P.Obj({
    name: Type.Optional(P.Name),
    settingsVersion: Type.Optional(P.Version),
    quotaPolicyId: Type.Optional(P.Name),
  }),
  MembershipInput: P.Obj({
    principalId: P.EntityId,
    role: P.Enum(P.roles),
    projectRestrictions: Type.Array(P.id("prj")),
  }),
  TokenInput: P.Obj({ name: P.Name, scopes: names, expiresAt: P.Timestamp }),
  TokenMetadata: P.Obj({ id: P.Name, name: P.Name, scopes: names, expiresAt: P.Timestamp }),
  EnvironmentInput: P.Obj({
    name: P.Name,
    baseUrl: Type.String({ format: "uri" }),
    networkProfile: P.Enum(["public", "private", "local-loopback"]),
    authRefs: Type.Optional(Type.Array(P.id("aup"))),
    production: Type.Optional(Type.Boolean()),
  }),
  DefaultEnvironmentInput: P.Obj({ environmentId: P.id("env") }),
  SecretInput: P.Obj({
    name: P.Name,
    value: Type.Optional(Type.String()),
    secretRef: Type.Optional(P.id("sec")),
    allowedOrigins: names,
  }),
  ConfirmationInput: P.Obj({ confirmationToken: P.Name }),
  UploadReceipt: P.Obj({
    uploadId: P.Name,
    contentHash: P.ContentDigest,
    sizeBytes: P.Nonnegative,
    state: P.Enum(["pending", "complete"]),
    target: Type.Optional(Type.String()),
    token: Type.Optional(Type.String()),
  }),
  SourceInput: P.Obj({
    role: P.Name,
    name: P.Name,
    uploadId: P.Name,
    sourceId: Type.Optional(P.id("src")),
  }),
  DiscoveryRetryInput: P.Obj({
    featureIds: Type.Array(P.id("fea")),
    inputsFingerprint: Type.Optional(P.ContentDigest),
  }),
  RequirementsInput: P.Obj({ requirements: Type.Array(Entities.entities.Requirement) }),
  GenerationInput: P.Obj({ inputRefs: Type.Array(P.EvidenceRef), scope: names, budget: P.Json }),
  ProposalDecisionInput: P.Obj({
    proposalIds: Type.Array(P.id("pro")),
    expectedVersion: P.Version,
    reason: Type.Optional(P.Description),
  }),
  ProposalDecisionReceipt: P.Obj({
    accepted: Type.Array(P.id("tst")),
    retained: Type.Array(P.id("pro")),
    rejected: Type.Array(P.id("pro")),
  }),
  TestMetadataInput: P.Obj({
    name: Type.Optional(P.Name),
    tags: Type.Optional(names),
    priority: Type.Optional(P.Priority),
  }),
  PromoteInput: P.Obj({
    revisionId: P.id("rev"),
    expectedActiveRevisionId: P.id("rev"),
    approval: Type.Optional(P.id("apr")),
  }),
  CancelInput: P.Obj({ reason: Type.Optional(P.Description) }),
  RerunInput: P.Obj({ environmentId: Type.Optional(P.id("env")) }),
  BudgetInput: P.Obj({ budget: P.Json }),
  ExpectedVersionInput: P.Obj({ expectedVersion: P.Version }),
  RunComparisonRequest: P.Obj({
    leftRunId: P.id("run"),
    rightRunId: P.id("run"),
    page: Type.Optional(P.Pagination),
  }),
  BatchComparisonRequest: P.Obj({
    leftBatchId: P.id("bat"),
    rightBatchId: P.id("bat"),
    page: Type.Optional(P.Pagination),
  }),
  ComparisonResult: P.Obj({
    comparability: P.Enum(["comparable", "partially_comparable", "incomparable"]),
    reasons: names,
    differences: Type.Array(P.Obj({ field: P.Name, left: P.Json, right: P.Json }), {
      maxItems: 100,
    }),
    nextCursor: Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]),
    comparisonIdentity: P.ContentDigest,
  }),
  FlakeStudyInput: P.Obj({
    testRevision: P.id("rev"),
    environment: P.id("env"),
    n: Type.Integer({ minimum: 2, maximum: 100 }),
    seed: Type.Integer(),
    includeStudyIds: Type.Optional(Type.Array(P.id("bat"), { maxItems: 20, uniqueItems: true })),
  }),
  FlakeStudyReport: P.Obj({
    batchId: P.id("bat"),
    studyIds: Type.Array(P.id("bat"), { minItems: 1 }),
    testId: P.id("tst"),
    revisionId: P.id("rev"),
    environmentRevisionId: P.id("evr"),
    identityHash: P.ContentDigest,
    window: P.Obj({
      from: Type.Union([P.Timestamp, Type.Null()]),
      to: Type.Union([P.Timestamp, Type.Null()]),
    }),
    counts: P.Obj({
      nPlanned: P.Nonnegative,
      nPass: P.Nonnegative,
      nFail: P.Nonnegative,
      nBlocked: P.Nonnegative,
      nCancelled: P.Nonnegative,
      nInconclusive: P.Nonnegative,
      nValid: P.Nonnegative,
      nInFlight: P.Nonnegative,
    }),
    failureRate: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
    wilson95: Type.Union([
      P.Obj({
        low: Type.Number({ minimum: 0, maximum: 1 }),
        high: Type.Number({ minimum: 0, maximum: 1 }),
      }),
      Type.Null(),
    ]),
    zeroFailureUpper95: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
    classification: P.Enum([
      "insufficient_data",
      "passing_observed",
      "deterministic_failure",
      "suspected_flaky",
      "confirmed_flaky",
      "unstable_infrastructure",
    ]),
    runIds: Type.Array(P.id("run")),
    failureCauses: Type.Array(
      P.Obj({
        runId: P.id("run"),
        attemptId: P.id("att"),
        stepId: Type.Union([P.Name, Type.Null()]),
        category: P.Enum(["environment", "product_or_contract", "unknown"]),
        reasonCode: P.Enum(reasonCodes),
        contentHash: P.ContentDigest,
      }),
    ),
    limitations: Type.Array(P.Description),
    incompatible: Type.Array(P.Obj({ batchId: P.id("bat"), reasons: names })),
  }),
  AnalysisInput: P.Obj({
    model: Type.Optional(Type.Boolean()),
    /** Authorized code discovery whose snapshot grounds optional source fix targets. */
    discoveryId: Type.Optional(P.id("dsc")),
    budget: Type.Optional(
      P.Obj({ deadlineMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 180000 })) }),
    ),
  }),
  AIAnalysisOutput: P.Obj({
    failureKind: P.FailureKind,
    hypotheses: Type.Array(
      P.Obj({
        text: P.Description,
        supports: Type.Array(EvidenceHandle, { maxItems: 100 }),
        contradicts: Type.Array(EvidenceHandle, { maxItems: 100 }),
        confidence: Type.Number({ minimum: 0, maximum: 1 }),
      }),
      { maxItems: 20 },
    ),
    recommendedAction: P.Enum([
      "fix_product",
      "fix_test",
      "fix_environment",
      "review_contract",
      "collect_more_evidence",
    ]),
    fixTargetHandle: Type.Union([EvidenceHandle, Type.Null()]),
    /** Persisted verbatim into `Analysis.limitations`, so each item uses that bound (Name). */
    limitations: Type.Array(P.Name, { maxItems: 100 }),
    nextSteps: Type.Array(P.Obj({ text: P.Description, evidence: evidenceIds(1) }), { maxItems: 5 }),
    evidenceGaps: Type.Array(P.Name, { maxItems: 20 }),
  }),
  HealingInput: P.Obj({
    budget: Type.Optional(
      P.Obj({ deadlineMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 180000 })) }),
    ),
  }),
  HealingRejectInput: P.Obj({ reason: Type.String({ minLength: 1, maxLength: 8000 }) }),
  HealingPatch,
  /** Model-only healing response: an admissible patch or an evidence-backed abstention. */
  AIHealingOutput: Type.Union([
    P.Obj({ kind: Type.Literal("patch"), patch: HealingPatch }),
    P.Obj({
      kind: Type.Literal("abstain"),
      reason: P.Description,
      evidenceHandles: evidenceIds(1),
    }),
  ]),
  HealingReview: P.Obj({
    changes: Type.Array(P.Obj({ stepId: P.Name, path: P.JsonPointer, before: P.Json, after: P.Json }), { maxItems: 20 }),
    identity: Type.Array(P.Obj({
      stepId: P.Name,
      previous: P.Json,
      candidates: Type.Array(P.Obj({
        role: Type.Union([P.Name, Type.Null()]), name: Type.Union([P.Description, Type.Null()]),
        tag: Type.Union([P.Name, Type.Null()]), type: Type.Union([P.Name, Type.Null()]),
        label: Type.Union([P.Description, Type.Null()]), form: Type.Union([P.Description, Type.Null()]),
        matched: Type.Boolean(), visible: Type.Boolean(),
      })),
      equivalence: Type.Union([P.Obj({ equivalent: Type.Boolean(), reasons: Type.Array(P.Description) }), Type.Null()]),
    })),
    automation: P.Obj({ decision: P.Enum(["applied_by_policy", "manual_review_required", "not_eligible"]), reasons: Type.Array(P.Description) }),
    preservedAssertions: P.Obj({ hash: P.ContentDigest, intact: Type.Boolean(), stepIds: Type.Array(P.Name) }),
    risk: P.Risk,
    verification: Type.Union([P.Obj({ runId: P.id("run"), outcome: P.Outcome, gate: P.Gate }), Type.Null()]),
    approval: P.Obj({ expectedVersion: P.Version, proposalId: P.id("hea"), candidateRevisionId: P.id("rev") }),
    evidenceRefs: Type.Array(P.EvidenceRef), limitations: Type.Array(P.Description),
  }),
  QuarantineInput: P.Obj({
    reason: Type.String({ minLength: 1, maxLength: 2000 }),
    expiresAt: P.Timestamp,
    expectedVersion: Type.Optional(P.Version),
  }),
  QuarantineRecord: P.Obj({
    testId: P.id("tst"),
    owner: P.EntityId,
    reason: Type.String({ minLength: 1, maxLength: 2000 }),
    expiresAt: P.Timestamp,
    createdAt: P.Timestamp,
    version: P.Version,
  }),
  SelectionInput: P.Obj({
    projectId: P.id("prj"),
    environmentId: P.id("env"),
    testIds: Type.Optional(Type.Array(P.id("tst"), { maxItems: 500, uniqueItems: true })),
    runIds: Type.Optional(Type.Array(P.id("run"), { maxItems: 500, uniqueItems: true })),
    /** Explicit immutable revision for exactly one selected test or Run. */
    revisionId: Type.Optional(P.id("rev")),
    all: Type.Optional(Type.Boolean()),
    diff: Type.Optional(
      P.Obj({
        base: Type.Optional(P.Name),
        head: Type.Optional(P.Name),
        workingTree: Type.Optional(Type.Boolean()),
      }),
    ),
    reuseFromRunIds: Type.Optional(Type.Array(P.id("run"), { maxItems: 100, uniqueItems: true })),
    skipDependencies: Type.Optional(Type.Boolean()),
    quarantinePolicy: Type.Optional(P.Enum(["exclude", "strict"])),
    allowEmpty: Type.Optional(Type.Boolean()),
    emptyReason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
    seed: Type.Optional(Type.Integer()),
    provenance: Type.Optional(Ops.RunRequest.properties.provenance),
    expectedSelectionHash: Type.Optional(P.ContentDigest),
    /** Claimed target; must equal the frozen environment revision baseUrl. Never an override. */
    targetUrl: Type.Optional(Type.String({ format: "uri", maxLength: 2048 })),
  }),
  SelectionPreview: P.Obj({
    selectionHash: P.ContentDigest,
    mode: P.Enum(["tests", "runs", "diff", "all"]),
    requested: Type.Array(
      P.Obj({ testId: P.id("tst"), revisionId: P.id("rev"), reason: P.Description }),
    ),
    expanded: Type.Array(
      P.Obj({
        testId: P.id("tst"),
        revisionId: P.id("rev"),
        consumers: Type.Array(P.id("tst")),
      }),
    ),
    excluded: Type.Array(
      P.Obj({
        testId: P.id("tst"),
        reason: P.Enum(["quarantined", "unaffected", "archived", "reused", "no_revision"]),
        owner: Type.Union([P.EntityId, Type.Null()]),
        detail: Type.Union([P.Description, Type.Null()]),
        expiresAt: Type.Union([P.Timestamp, Type.Null()]),
      }),
    ),
    producerBindings: Type.Array(
      P.Obj({
        consumerTestId: P.id("tst"),
        producerTestId: P.id("tst"),
        outputName: P.Name,
        source: P.Enum(["execute", "reuse"]),
        producerRunId: Type.Union([P.id("run"), Type.Null()]),
      }),
    ),
    effects: Type.Array(
      P.Obj({
        testId: P.id("tst"),
        stepId: P.Name,
        origin: Type.Union([P.Name, Type.Null()]),
        method: Type.Union([P.Name, Type.Null()]),
        risk: P.Risk,
      }),
    ),
    resources: Type.Array(
      P.Obj({
        testId: P.id("tst"),
        stepId: P.Name,
        resourceType: P.Name,
        cleanupDeclared: Type.Boolean(),
      }),
    ),
    uncertainEffects: Type.Array(P.Description),
    approvalsRequired: Type.Array(P.Obj({ testId: P.id("tst"), actions: names })),
    refusals: Type.Array(P.Obj({ testId: P.Name, code: P.Name, message: P.Description })),
    diff: Type.Union([
      P.Obj({
        changedPaths: Type.Array(Type.String({ maxLength: 4096 })),
        unmappedPaths: Type.Array(Type.String({ maxLength: 4096 })),
        conservative: Type.Boolean(),
      }),
      Type.Null(),
    ]),
    provenance: P.Obj({
      commitSha: Type.Union([P.Name, Type.Null()]),
      checkoutSha: Type.Union([P.Name, Type.Null()]),
      dirtyHash: Type.Union([P.ContentDigest, Type.Null()]),
      binding: P.Enum(["verified", "unbound"]),
    }),
    empty: Type.Boolean(),
  }),
  CiResult: P.Obj({
    schemaVersion: Type.Literal("1.0.0"),
    kind: P.Enum(["batch", "empty", "admission_rejected"]),
    batchId: Type.Union([P.id("bat"), Type.Null()]),
    gate: P.Gate,
    exitCode: Type.Integer({ minimum: 0, maximum: 255 }),
    counts: Type.Union([Ops.BatchCounts, Type.Null()]),
    provenance: P.Obj({
      assessedSha: Type.Union([P.Name, Type.Null()]),
      checkoutSha: Type.Union([P.Name, Type.Null()]),
      binding: P.Enum(["verified", "unbound"]),
      /** "local-checkout" only for a loopback target served from the verified clean checkout. */
      targetBinding: P.Enum(["local-checkout", "unbound"]),
    }),
    selection: P.Obj({
      requested: P.Nonnegative,
      excluded: Type.Array(
        P.Obj({
          testId: P.id("tst"),
          reason: P.Name,
          owner: Type.Union([P.EntityId, Type.Null()]),
          expiresAt: Type.Union([P.Timestamp, Type.Null()]),
        }),
      ),
      emptyReason: Type.Union([P.Description, Type.Null()]),
      quarantinePolicy: P.Enum(["exclude", "strict"]),
    }),
    outputs: P.Obj({
      report: Type.Union([P.Name, Type.Null()]),
      junit: Type.Union([P.Name, Type.Null()]),
      summary: Type.Union([P.Name, Type.Null()]),
      bundleIndex: Type.Union([P.Name, Type.Null()]),
    }),
    bundles: Type.Array(
      P.Obj({
        runId: P.id("run"),
        state: P.Enum(["exported", "missing", "failed"]),
        path: Type.Union([P.Name, Type.Null()]),
        error: Type.Union([P.Description, Type.Null()]),
      }),
    ),
    reportHash: Type.Union([P.ContentDigest, Type.Null()]),
    error: Type.Union([P.Obj({ code: P.Name, message: P.Description }), Type.Null()]),
  }),
  UsageQuery: P.Obj({
    projectId: Type.Optional(P.id("prj")),
    runId: Type.Optional(P.id("run")),
    model: Type.Optional(P.Name),
    since: Type.Optional(P.Timestamp),
    until: Type.Optional(P.Timestamp),
  }),
  BatchCancelReceipt: P.Obj({ batchId: P.id("bat"), members: Type.Array(Ops.CancelReceipt) }),
  CleanupInput: P.Obj({ approval: Type.Optional(P.id("apr")), ownerProof: P.EvidenceRef }),
  TunnelInput: P.Obj({
    binding: P.Name,
    ttlMs: P.Positive,
    host: P.Name,
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
  }),
  TunnelMetadata: P.Obj({ id: P.Name, binding: P.Name, expiresAt: P.Timestamp }),
  HeartbeatInput: P.Obj({
    leaseId: P.id("job"),
    state: P.Enum(["ready", "draining", "offline"]),
    version: P.Version,
  }),
  IntegrationInput: P.Obj({
    provider: P.Name,
    destinationRef: P.Name,
    enabled: Type.Boolean(),
    settings: P.Json,
  }),
  IntegrationMetadata: P.Obj({
    id: P.Name,
    provider: P.Name,
    destinationRef: P.Name,
    enabled: Type.Boolean(),
  }),
  PortabilityInput: P.Obj({ package: P.Name, version: P.Name, options: P.Json }),
  OperationReceipt: P.Obj({
    jobId: P.id("job"),
    state: P.Enum(["queued", "running", "completed", "failed"]),
    progress: Type.Number({ minimum: 0, maximum: 1 }),
  }),
  IdentityInput: P.Obj({ principal: P.Name, credentialRef: Type.Optional(P.id("sec")) }),
  IdentityReceipt: P.Obj({
    principalId: P.EntityId,
    state: P.Enum(["authenticated", "revoked", "pending"]),
  }),
  SessionMetadata: P.Obj({ id: P.Name, principalId: P.EntityId, expiresAt: P.Timestamp }),
  AuthContinueInput: P.Obj({ inputRef: Type.Optional(P.id("sec")) }),
  AdmissionInput: P.Obj({ action: P.Enum(["pause", "resume"]), reason: P.Description }),
  ReconcileInput: P.Obj({
    mode: P.Enum(["preview", "apply"]),
    approval: Type.Optional(P.id("apr")),
  }),
  BackupInput: P.Obj({ destination: P.Name }),
  BootstrapReceipt: P.Obj({
    projectId: P.id("prj"),
    config: Ops.ProjectConfig,
    preflight: Type.Array(P.Obj({ check: P.Name, passed: Type.Boolean() })),
    nextActions: names,
  }),
  RequirementSnapshot: P.Obj({
    requirements: Type.Array(Entities.entities.Requirement),
    conflicts: Type.Array(P.Obj({ left: P.EvidenceRef, right: P.EvidenceRef })),
  }),
  GeneratedTestsReceipt: P.Obj({
    candidates: Type.Array(P.id("rev")),
    validationErrors: Type.Array(P.Obj({ path: P.Name, message: P.Description })),
  }),
  EvidenceSummary: P.Obj({
    manifest: Ops.ArtifactManifest,
    resources: Type.Array(Type.String({ minLength: 1, maxLength: 8192 })),
    integrity: P.Enum(["verified", "partial", "invalid"]),
    freshness: P.Enum(["current", "stale"]),
    verificationEligible: Type.Boolean(),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  }),
  ReportLocation: P.Obj({ location: Type.String() }),
};
export type HealingReview = Static<typeof supplemental.HealingReview>;

const httpInputs = {
  ProjectPatchInput: Type.Partial(supplemental.ProjectInput),
  EnvironmentPatchInput: Type.Partial(supplemental.EnvironmentInput),
  ApprovalInput: P.Obj({
    actorId: Type.Optional(P.id("usr")),
    reviewerId: Type.Optional(P.id("usr")),
    actionSet: names,
    revisionHash: P.ContentDigest,
    environmentRevisionId: P.id("evr"),
    originSet: names,
    expiresAt: Type.Optional(P.Timestamp),
    policyHash: P.ContentDigest,
  }),
};
export const schemaCatalog: Readonly<Record<string, TSchema>> = Object.freeze({
  RatioMetric: Metrics.RatioMetric,
  CoverageMetrics: Metrics.CoverageMetrics,
  ExecutionMetrics: Metrics.ExecutionMetrics,
  RuntimeTiming: Metrics.RuntimeTiming,
  EntityId: P.EntityId,
  Timestamp: P.Timestamp,
  ContentDigest: P.ContentDigest,
  Money: P.Money,
  Version: P.Version,
  EvidenceRef: P.EvidenceRef,
  Pagination: P.Pagination,
  ExecutablePlan: Plans.ExecutablePlan,
  Step: Plans.Step,
  IntentPlan: Plans.IntentPlan,
  TestRevisionInput: Plans.TestRevisionInput,
  CodeReference: Plans.CodeReference,
  DependencyBinding: Plans.DependencyBinding,
  Locator: Plans.Locator,
  Value: P.Value,
  ProjectConfig: Ops.ProjectConfig,
  EffectiveConfig: Ops.EffectiveConfig,
  ExecutionLimits: Ops.ExecutionLimits,
  NetworkPolicy: Ops.NetworkPolicy,
  RunRequest: Ops.RunRequest,
  RunReceipt: Ops.RunReceipt,
  RunResult: Ops.RunResult,
  BatchRequest: Ops.BatchRequest,
  BatchReceipt: Ops.BatchReceipt,
  BatchResult: Ops.BatchReceipt,
  BundleMeta: Ops.BundleMeta,
  UploadRequest: Ops.UploadRequest,
  CancelReceipt: Ops.CancelReceipt,
  BackupManifest: Ops.BackupManifest,
  RestoreRequest: Ops.RestoreRequest,
  UsageEntry: Ops.UsageEntry,
  Event: Ops.Event,
  ...Entities.entities,
  FeatureMap: Entities.FeatureMap,
  DiscoveryRequest: Entities.DiscoveryRequest,
  DiscoveryResult: Entities.DiscoveryResult,
  ExecutionSnapshot: Entities.ExecutionSnapshot,
  IntegrationEvent: Entities.IntegrationEvent,
  CohortManifest: Entities.CohortManifest,
  EvaluationResult: Entities.EvaluationResult,
  TraceabilityRecord: Entities.TraceabilityRecord,
  ModelRequest: Entities.ModelRequest,
  ModelResponse: Entities.ModelResponse,
  RunnerEvent: Protocol.RunnerEvent,
  SupervisorEvent: Protocol.SupervisorEvent,
  AgentActionSelection: Protocol.AgentActionSelection,
  AIGeneratedCodeOutput: Protocol.AIGeneratedCodeOutput,
  CapabilityManifest: Protocol.CapabilityManifest,
  ErrorEnvelope,
  SuccessEnvelope: SuccessEnvelope(P.Json),
  ...supplemental,
  ...httpInputs,
  ...Object.fromEntries(
    Object.entries(mcpTools).map(([name, tool]) => [`Mcp_${name}`, tool.input]),
  ),
});
