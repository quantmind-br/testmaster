import { CloneType, type Static, type TSchema, Type } from "@sinclair/typebox";
import * as Entities from "./entities.js";
import { auditContracts } from "./m4/audit.js";
import { authContracts } from "./m4/auth.js";
import { authoringContracts } from "./m4/authoring.js";
import { githubContracts } from "./m4/github.js";
import { identityContracts } from "./m4/identity.js";
import { integrationContracts } from "./m4/integrations.js";
import { listContracts } from "./m4/lists.js";
import { deliveryContracts, notificationContracts } from "./m4/notifications.js";
import { onboardingContracts } from "./m4/onboarding.js";
import { operationsContracts } from "./m4/operations.js";
import { runResponseContracts } from "./m4/responses-runs.js";
import { CodeDiffView, sourceResponseContracts } from "./m4/responses-sources.js";
import { systemResponseContracts } from "./m4/responses-system.js";
import { viewResponseContracts } from "./m4/responses-views.js";
import { runViewContracts } from "./m4/runs.js";
import { scheduleContracts } from "./m4/schedules.js";
import { settingsContracts } from "./m4/settings.js";
import { sourceInsightContracts } from "./m4/sources.js";
import { workerContracts } from "./m4/workers.js";
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
const healingAbstention = P.Obj({
  abstained: Type.Literal(true),
  failedRunId: P.id("run"),
  /** `model_abstained`: the model found no safe test-only repair; `semantic_failure`: the rules did. */
  reasonCode: P.Enum(["model_abstained", "semantic_failure"]),
  reason: P.Description,
  jobId: P.id("job"),
  /** The call that abstained; null when the rules decided before any model call. */
  modelCallId: Type.Union([P.id("mdl"), Type.Null()]),
  nextAction: P.Description,
});
export type HealingAbstention = Static<typeof healingAbstention>;
/**
 * Inspection actions a model may select for a next step. The application renders the visible text
 * from the action, so model prose never becomes advice shown to the user.
 */
export const nextStepActions = [
  "collect_more_evidence",
  "restore_environment",
  "review_security_precondition",
  "compare_contract",
  "inspect_persistence",
  "compare_requirement",
  "review_healing_proposal",
  "inspect_locator_candidates",
] as const;
export type NextStepAction = (typeof nextStepActions)[number];
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
/** REST `RunReceipt` plus the MCP resources of the run; status is read live, never frozen at admission. */
const McpRunReceipt = P.Obj({
  ...Ops.RunReceipt.properties,
  resources: P.Obj({ result: Type.String(), manifest: Type.String(), report: Type.String() }),
});
/** A requirement with the state derived from its decision fields: nothing about it is stored twice. */
const McpRequirement = P.Obj({
  ...Entities.entities.Requirement.properties,
  status: P.Enum(["pending", "approved", "rejected", "superseded"]),
});
const { skippedFiles: _skipped, ...codeSnapshotProperties } =
  Entities.entities.CodeSnapshot.properties;
// `ProposalBatch` redeclares the entity's optional `version` as required; spreading that
// intersection into another object makes its declaration unnameable, so it is restated here.
const { version: _batchVersion, ...proposalBatchProperties } =
  Entities.entities.ProposalBatch.properties;
const CodeSnapshotSummary = P.Obj(codeSnapshotProperties);
const supplemental = {
  DocumentValidationInput: P.Obj({
    schema: P.Enum(["ExecutablePlan", "ProjectConfig", "RunRequest"]),
    document: P.Json,
  }),
  DocumentValidationResult: P.Obj({ validated: Type.Literal(true), schema: P.Name }),
  /** One extraction batch; a batch that states no requirement (a preamble, a title) returns none. */
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
      { maxItems: 100 },
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
        plan: Plans.ModelExecutablePlan,
        requirementRefs: Type.Array(P.id("req"), { minItems: 1 }),
        evidenceIds: evidenceIds(1),
        warnings: names,
      }),
      { maxItems: 50 },
    ),
    // A requirement the model cannot cover with an HTTP or browser plan is declined here
    // instead of being given an invented endpoint; the service enforces that each requirement
    // is either proposed or declined.
    unsupported: Type.Optional(
      Type.Array(
        P.Obj({
          requirementId: P.id("req"),
          reason: Type.String({ minLength: 1, maxLength: 500 }),
        }),
        { maxItems: 100 },
      ),
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
  EnvironmentInput: P.Obj({
    name: P.Name,
    baseUrl: Type.String({ format: "uri" }),
    networkProfile: P.Enum(["public", "private", "local-loopback"]),
    additionalOrigins: Type.Optional(
      Type.Array(Type.String({ format: "uri" }), {
        maxItems: 32,
        description:
          "Exact extra origins (scheme, host, port; no path, query, credentials or wildcard) page subrequests may reach. Replaces the previous list; [] clears it. They never receive credentials and are not target origins.",
      }),
    ),
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
    format: Type.Optional(
      P.Enum(["markdown", "text", "prd-json", "pdf", "openapi", "graphql", "postman"]),
    ),
  }),
  DiscoveryRetryInput: P.Obj({
    featureIds: Type.Array(P.id("fea")),
    inputsFingerprint: Type.Optional(P.ContentDigest),
  }),
  RequirementsInput: P.Obj({
    requirements: Type.Array(Entities.entities.Requirement),
    /** Why the edits are made; recorded on each edited requirement with the reviewer and time. */
    reason: Type.Optional(P.DecisionReason),
  }),
  GenerationInput: P.Obj({ inputRefs: Type.Array(P.EvidenceRef), scope: names }),
  ProposalDecisionInput: P.Obj({
    proposalIds: Type.Array(P.id("pro")),
    expectedVersion: P.Version,
    /** Why the proposals are accepted or rejected; recorded on each decided proposal with the reviewer and time. */
    reason: Type.Optional(P.DecisionReason),
    /** Selected proposals the preview flagged as exact duplicates and the caller accepts anyway (UX-017). */
    acknowledgedDuplicates: Type.Optional(Type.Array(P.id("pro"), { uniqueItems: true })),
  }),
  ProposalDecisionReceipt: P.Obj({
    accepted: Type.Array(P.id("tst")),
    /** The test and candidate revision each accepted proposal produced. */
    acceptedProposals: Type.Array(
      P.Obj({ proposalId: P.id("pro"), testId: P.id("tst"), revisionId: P.id("rev") }),
    ),
    retained: Type.Array(P.id("pro")),
    rejected: Type.Array(P.id("pro")),
  }),
  TestMetadataInput: P.Obj({
    name: Type.Optional(P.Name),
    tags: Type.Optional(names),
    priority: Type.Optional(P.Priority),
  }),
  TestArchiveInput: P.Obj({
    /** Why the test is archived; recorded on the test with the actor and time. */
    reason: Type.Optional(P.DecisionReason),
  }),
  PromoteInput: P.Obj({
    revisionId: P.id("rev"),
    expectedActiveRevisionId: P.id("rev"),
    approval: Type.Optional(P.id("apr")),
    /** Why the revision is promoted; recorded on the test with the reviewer and time. */
    reason: Type.Optional(P.DecisionReason),
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
    /** Explicit provider/model id for the enrichment call (`model` is the on/off switch); the first allowed structured model when absent. Both require `model: true`. */
    provider: Type.Optional(P.Name),
    modelId: Type.Optional(P.Name),
    /** Authorized code discovery whose snapshot grounds optional source fix targets. */
    discoveryId: Type.Optional(P.id("dsc")),
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
    nextSteps: Type.Array(P.Obj({ action: P.Enum(nextStepActions), evidence: evidenceIds(1) }), {
      maxItems: 5,
    }),
    evidenceGaps: Type.Array(P.Name, { maxItems: 20 }),
    /**
     * Set only when the observation agrees with an approved requirement the failed test maps to
     * while the test's own expectation contradicts it. `criterionIndex` is the zero-based position
     * in that requirement's supplied `acceptanceCriteria`. Code verifies the claim; it can only
     * lower a rules `product_bug` to `unknown`, never change a cause to another one.
     */
    requirementAgreement: Type.Optional(
      Type.Union([
        P.Obj({
          requirementId: P.id("req"),
          criterionIndex: Type.Integer({ minimum: 0, maximum: 99 }),
        }),
        Type.Null(),
      ]),
    ),
  }),
  HealingInput: P.Obj({
    /** Explicit provider/model for the healing call; the first allowed structured model when absent. */
    provider: Type.Optional(P.Name),
    model: Type.Optional(P.Name),
  }),
  HealingRejectInput: P.Obj({ reason: Type.String({ minLength: 1, maxLength: 8000 }) }),
  HealingApproveInput: P.Obj({
    expectedVersion: P.Version,
    /** Why the reviewer approves; recorded on the proposal with the reviewer and time. */
    reason: Type.Optional(P.DecisionReason),
  }),
  /**
   * A healing request that ended without a candidate because no safe test-only repair exists. It
   * is a normal result, not an error: `reasonCode` and `reason` are code-owned, never model text.
   */
  HealingAbstention: healingAbstention,
  /** Result of a healing request: a candidate proposal or an abstention. */
  HealingResult: Type.Union([Entities.entities.HealingProposal, healingAbstention], {
    type: "object",
  }),
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
    /**
     * The proposal's status: `proposed` awaits a decision (again after a verification that did
     * not pass), `approved` has its verification Run pending, `verified` passed it and its
     * candidate is the test's active revision, `rejected` was declined.
     */
    status: P.Enum(["proposed", "approved", "rejected", "verified"]),
    changes: Type.Array(
      P.Obj({ stepId: P.Name, path: P.JsonPointer, before: P.Json, after: P.Json }),
      { maxItems: 20 },
    ),
    identity: Type.Array(
      P.Obj({
        stepId: P.Name,
        previous: P.Json,
        candidates: Type.Array(
          P.Obj({
            role: Type.Union([P.Name, Type.Null()]),
            name: Type.Union([P.Description, Type.Null()]),
            tag: Type.Union([P.Name, Type.Null()]),
            type: Type.Union([P.Name, Type.Null()]),
            label: Type.Union([P.Description, Type.Null()]),
            form: Type.Union([P.Description, Type.Null()]),
            placeholder: Type.Optional(Type.Union([P.Description, Type.Null()])),
            testId: Type.Optional(Type.Union([P.Description, Type.Null()])),
            matched: Type.Boolean(),
            visible: Type.Boolean(),
          }),
        ),
        /** Recorded elements not listed: document/metadata elements and candidates beyond the review cap. */
        omittedCandidates: Type.Optional(Type.Integer({ minimum: 1 })),
        equivalence: Type.Union([
          P.Obj({ equivalent: Type.Boolean(), reasons: Type.Array(P.Description) }),
          Type.Null(),
        ]),
      }),
    ),
    automation: P.Obj({
      decision: P.Enum(["applied_by_policy", "manual_review_required", "not_eligible"]),
      reasons: Type.Array(P.Description),
    }),
    preservedAssertions: P.Obj({
      hash: P.ContentDigest,
      intact: Type.Boolean(),
      stepIds: Type.Array(P.Name),
    }),
    risk: P.Risk,
    /**
     * The steps of the candidate plan whose own class is `risk` (changed steps first, at most 10),
     * each with the short reason for that class, e.g. `text mentions "probe"`.
     */
    riskBasis: Type.Array(P.Obj({ stepId: P.Description, risk: P.Risk, basis: P.Description }), {
      maxItems: 10,
    }),
    verification: Type.Union([
      // Null while the verification Run has not reached a verdict (queued, running, collecting).
      P.Obj({
        runId: P.id("run"),
        outcome: Type.Union([P.Outcome, Type.Null()]),
        gate: P.Gate,
      }),
      Type.Null(),
    ]),
    approval: P.Obj({
      expectedVersion: P.Version,
      proposalId: P.id("hea"),
      candidateRevisionId: P.id("rev"),
      /**
       * Present once the proposal was approved (manually or by policy) or rejected. A decision
       * recorded before who/when/reason were stored lacks those fields.
       */
      decision: Type.Optional(
        P.Obj({
          status: P.Enum(["approved", "rejected"]),
          /** How an approval was given; absent for a rejection. */
          mode: Type.Optional(P.Enum(["manual", "policy"])),
          actorId: Type.Optional(P.Name),
          decidedAt: Type.Optional(P.Timestamp),
          /** The reason the reviewer recorded, when one was given. */
          reason: Type.Optional(P.DecisionReason),
        }),
      ),
    }),
    evidenceRefs: Type.Array(P.EvidenceRef),
    limitations: Type.Array(P.Description),
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
      targetBinding: P.Enum(["local-checkout", "github-deployment", "unbound"]),
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
  PortabilityInput: P.Obj({ package: P.Name, version: P.Name, options: P.Json }),
  OperationReceipt: P.Obj({
    jobId: P.id("job"),
    state: P.Enum(["queued", "running", "completed", "failed"]),
    progress: Type.Number({ minimum: 0, maximum: 1 }),
  }),
  IdentityInput: P.Obj({ principal: P.Name, credentialRef: Type.Optional(P.id("sec")) }),
  ReconcileInput: P.Obj({
    mode: P.Enum(["preview", "apply"]),
    approval: Type.Optional(P.id("apr")),
  }),
  BootstrapReceipt: P.Obj({
    projectId: P.id("prj"),
    /**
     * What testmaster.config.json would hold for this call (the file's effective config with the
     * requested target, mode and project id applied). Nothing is written; the stored environment is
     * `environment`, and one aimed at another origin is never retargeted.
     */
    proposedConfig: CloneType(Ops.ProjectConfig, {
      description:
        "Proposal for testmaster.config.json built from the requested target and mode; never written to disk and never the stored environment (see environment)",
    }),
    preflight: Type.Array(P.Obj({ check: P.Name, passed: Type.Boolean() })),
    /** The environment that targets the given origin: found, or created because the project had none. */
    environment: Type.Optional(
      P.Obj({
        id: P.id("env"),
        name: P.Name,
        version: P.Version,
        created: Type.Boolean(),
      }),
    ),
    nextActions: Type.Array(P.Description),
  }),
  RequirementSnapshot: P.Obj({
    requirements: Type.Array(Entities.entities.Requirement),
    conflicts: Type.Array(P.Obj({ left: P.EvidenceRef, right: P.EvidenceRef })),
  }),
  NormalizedRequirements: P.Obj({
    requirements: Type.Array(McpRequirement),
    conflicts: Type.Array(
      P.Obj({
        id: P.Name,
        reason: P.Description,
        requirementIds: Type.Array(P.id("req"), { minItems: 1 }),
        left: P.EvidenceRef,
        right: P.EvidenceRef,
      }),
    ),
    sourceSnapshotId: Type.String({
      description:
        "Fingerprint of the requirement snapshot. It changes with every edit or approval: pass the fingerprint that testmaster_review_requirements returns as testmaster_generate_plan.sourceSnapshotId once the requirements are approved",
    }),
    version: P.Nonnegative,
    resource: Type.String({ description: "testmaster://requirements/{projectId}" }),
  }),
  /**
   * Bounded by construction: lists are capped and carry their total and omitted counts; the full
   * skipped list is in the stored discovery and the full feature list is the project features
   * resource.
   */
  CodeAnalysisReceipt: P.Obj({
    /** The stored snapshot without `skippedFiles`, which the receipt summarizes below. */
    codeSnapshot: CodeSnapshotSummary,
    scannedFileCount: P.Nonnegative,
    skippedFileCount: P.Nonnegative,
    skippedByReason: Type.Array(
      P.Obj({ reason: Type.String({ minLength: 1 }), count: P.Positive }),
    ),
    skippedFiles: Type.Array(P.Obj({ path: Type.String(), reason: Type.String({ minLength: 1 }) })),
    omittedSkippedFiles: P.Nonnegative,
    warnings: Type.Array(
      P.Obj({ path: Type.String(), code: Type.String({ minLength: 1 }), message: Type.String() }),
    ),
    omittedWarnings: P.Nonnegative,
    featureCount: P.Nonnegative,
    features: Type.Array(P.Obj({ id: P.id("fea"), stableKey: P.Name })),
    omittedFeatures: P.Nonnegative,
    featuresResource: Type.String({
      description:
        "testmaster://projects/{projectId}/features{?match,cursor}: the current features with their stable key, filterable by substring and paged (features only an earlier analysis found are not listed); the ids testmaster_explore takes come from here",
    }),
    /** Present for diff scope only: changed paths, the files the change reaches and the analyzed files it does not. */
    diff: Type.Optional(
      P.Obj({
        baseSha: CodeDiffView.properties.baseSha,
        headSha: CodeDiffView.properties.headSha,
        mergeBase: CodeDiffView.properties.mergeBase,
        includeWorkingTree: CodeDiffView.properties.includeWorkingTree,
        dirtyHash: CodeDiffView.properties.dirtyHash,
        changes: CodeDiffView.properties.changes,
        impact: P.Obj({
          criticalSmoke: CodeDiffView.properties.impact.properties.criticalSmoke,
          authTouched: CodeDiffView.properties.impact.properties.authTouched,
          selectedFiles: CodeDiffView.properties.impact.properties.selectedFiles,
          excludedFiles: CodeDiffView.properties.impact.properties.excludedFiles,
          gaps: CodeDiffView.properties.impact.properties.gaps,
        }),
        fingerprint: CodeDiffView.properties.fingerprint,
        /** `changes`, `selectedFiles` and `excludedFiles` are capped; these are the entries left out. */
        omitted: P.Obj({
          changes: P.Nonnegative,
          selectedFiles: P.Nonnegative,
          excludedFiles: P.Nonnegative,
        }),
      }),
    ),
  }),
  /** `Analysis` plus, when a model reading was asked for, what became of it. */
  McpAnalysis: P.Obj({
    ...Entities.entities.Analysis.properties,
    modelStatus: Type.Optional(
      P.Obj({
        state: P.Enum(["used", "abstained", "unavailable"]),
        reasonCode: Type.Union([P.Name, Type.Null()]),
        message: P.Description,
        modelCallId: Type.Union([P.id("mdl"), Type.Null()]),
      }),
    ),
  }),
  /** The edited `Proposal` plus the version its batch has now, which `testmaster_review_plan` takes. */
  McpEditedPlan: P.Obj({
    ...Entities.entities.Proposal.properties,
    batchVersion: P.Version,
  }),
  /** The generated `ProposalBatch` plus where its proposals are read: the batch itself carries none. */
  McpProposalBatch: P.Obj({
    ...proposalBatchProperties,
    version: P.Version,
    resource: Type.String({ description: "testmaster://plan-batches/{batchId}" }),
  }),
  McpRunReceipt,
  /** `RunResult` plus which test revision and environment revision the run executed, and why it ran. */
  McpRunResult: P.Obj({
    ...Ops.RunResult.properties,
    testId: P.id("tst"),
    revisionId: P.id("rev"),
    environmentRevisionId: P.id("evr"),
    mode: P.Mode,
    /** What admitted the run, for example `mcp`, `cli` or `verification` (a healing verification). */
    origin: P.Name,
  }),
  McpBatchReceipt: P.Obj({
    ...Ops.BatchReceipt.properties,
    memberRuns: Type.Array(McpRunReceipt),
    expanded: Type.Array(McpRunReceipt),
  }),
  GeneratedTestsReceipt: P.Obj({
    /** Revisions the call tried to generate code for; `candidates` plus failures show partial success. */
    requested: P.Nonnegative,
    /** One entry per candidate revision created: which test it belongs to and which proposal it came from. */
    candidates: Type.Array(
      P.Obj({
        id: P.id("rev"),
        testId: P.id("tst"),
        testName: P.Name,
        /** The revision the code was generated from (the accepted proposal's revision, or the one regenerated). */
        sourceRevisionId: P.id("rev"),
        /** Present when the candidate was generated from an accepted proposal. */
        proposalId: Type.Optional(P.id("pro")),
        /** `testmaster://revisions/{id}/code`: the candidate's files, each inline while it fits, and a resource per file. */
        code: Type.String({ minLength: 1, maxLength: 512 }),
      }),
    ),
    /** One entry per revision whose candidate the checks refused after every repair. */
    validationErrors: Type.Array(P.Obj({ path: P.Name, message: P.Description })),
  }),
  /** A saved test or revision, and whether runs of it use the revision yet. */
  McpSavedTest: P.Obj({
    test: Entities.entities.TestCase,
    revision: Entities.entities.TestRevision,
    /** True when the revision is the test's active one (a new test); a new revision of a test is not. */
    active: Type.Boolean(),
    nextActions: Type.Array(P.Description),
  }),
  EvidenceSummary: P.Obj({
    manifest: Ops.ArtifactManifest,
    resources: Type.Array(Type.String({ minLength: 1, maxLength: 8192 })),
    integrity: P.Enum(["verified", "partial", "invalid"]),
    freshness: P.Enum(["current", "stale"]),
    /** Why `freshness` is stale; empty when current. */
    staleReasons: Type.Array(
      P.Obj({
        code: P.Enum(["revision_superseded", "environment_revision_changed"]),
        message: P.Description,
      }),
    ),
    verificationEligible: Type.Boolean(),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  }),
  /** Where a committed report is read: `location` is the JSON report, `formats` the ready URI of each text format. */
  ReportLocation: P.Obj({
    location: Type.String(),
    formats: P.Obj({
      json: Type.String(),
      markdown: Type.String(),
      html: Type.String(),
      junit: Type.String(),
    }),
  }),
  /** What an added source revision came to; chunks and the inventory stay out, `diagnostics` is whole, `requirementsReset` only when it reset a requirement. */
  McpSourceReceipt: P.Obj({
    source: sourceResponseContracts.SourceDetail.properties.source,
    revision: Type.Omit(sourceResponseContracts.SourceDetail.properties.revision, ["chunks"]),
    chunkCount: P.Nonnegative,
    diagnostics: sourceResponseContracts.SourceDetail.properties.diagnostics,
    requirementsReset: sourceResponseContracts.SourceDetail.properties.requirementsReset,
  }),
  /** Outcome of each requested decision, then where the snapshot stands. */
  McpRequirementsReview: P.Obj({
    results: Type.Array(
      P.Obj({
        action: P.Enum(["update", "adjudicate", "reject", "approve"]),
        id: P.Name,
        ok: Type.Boolean(),
        error: Type.Union([P.Obj({ code: P.Name, message: P.Description }), Type.Null()]),
      }),
    ),
    sourceSnapshotId: Type.String({
      description:
        "Fingerprint of the snapshot after the decisions: pass it to testmaster_generate_plan",
    }),
    version: P.Nonnegative,
    pendingApprovalIds: Type.Array(P.id("req")),
    unresolvedConflictIds: Type.Array(P.Name),
  }),
  McpEnvironmentUpdate: P.Obj({
    environment: Entities.entities.Environment,
    revision: settingsContracts.EnvironmentRevisionView,
  }),
};
export type HealingReview = Static<typeof supplemental.HealingReview>;
export type McpRunResult = Static<typeof supplemental.McpRunResult>;

const httpInputs = {
  ProjectPatchInput: Type.Partial(supplemental.ProjectInput),
  EnvironmentPatchInput: Type.Partial(supplemental.EnvironmentInput),
  ApprovalInput: P.Obj({
    actorId: Type.Optional(P.Name),
    reviewerId: Type.Optional(P.Name),
    actionSet: names,
    revisionHash: P.ContentDigest,
    environmentRevisionId: P.id("evr"),
    originSet: names,
    expiresAt: Type.Optional(P.Timestamp),
    policyHash: P.ContentDigest,
    reason: P.Name,
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
  QueueAdmission: Ops.QueueAdmission,
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
  ...integrationContracts,
  ...authoringContracts,
  ...auditContracts,
  ...notificationContracts,
  ...deliveryContracts,
  ...workerContracts,
  ...githubContracts,
  ...identityContracts,
  ...settingsContracts,
  ...onboardingContracts,
  ...sourceInsightContracts,
  ...listContracts,
  ...scheduleContracts,
  ...runViewContracts,
  ...authContracts,
  ...operationsContracts,
  ...runResponseContracts,
  ...sourceResponseContracts,
  ...systemResponseContracts,
  ...viewResponseContracts,
  ...Object.fromEntries(
    Object.entries(mcpTools).map(([name, tool]) => [`Mcp_${name}`, tool.input]),
  ),
});
