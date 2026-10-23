import { type TSchema, Type } from "@sinclair/typebox";
import { ServerLogSource } from "./entities.js";
import { AuthConfigInput, AuthPlainUsername, authContracts } from "./m4/auth.js";
import { SuiteFixedMember, SuiteMemberInterval, SuiteSelection } from "./m4/lists.js";
import { RunLimits } from "./operations.js";
import {
  ContentDigest,
  DecisionReason,
  Description,
  Enum,
  id,
  Json,
  Mode,
  Name,
  Obj,
  Priority,
  Timestamp,
  Version,
} from "./primitives.js";
import { errorRegistry, type Milestone } from "./registries.js";
export const ErrorEnvelope = Obj({
  schemaVersion: Type.Literal("1.0.0"),
  requestId: Name,
  error: Obj({
    code: Enum(Object.keys(errorRegistry)),
    message: Description,
    retryable: Type.Boolean(),
    details: Json,
    nextActions: Type.Array(Obj({ action: Name, parameters: Json })),
  }),
});
export const SuccessEnvelope = (data: TSchema) =>
  Obj({
    schemaVersion: Type.Literal("1.0.0"),
    requestId: Name,
    data,
    warnings: Type.Array(Description),
  });
/**
 * Shape of the success response of a route.
 * - `item`: `data` is one entity of `schema`.
 * - `page`: `data` is `{items, hasMore, nextCursor}` with each item of `schema`.
 * - `items`: `data` is `{items}` (an unpaged list) with each item of `schema`.
 * - `empty`: `data` is `{}`.
 * - `stream`: no envelope; `text/event-stream` whose `data:` lines are JSON of `schema`.
 * - `binary`: no envelope; raw bytes.
 * - `text`: no envelope; plain text.
 * - `unavailable`: no handler in this build; every call answers `CAPABILITY_UNAVAILABLE` (422).
 */
export type ResponseKind =
  | "item"
  | "page"
  | "items"
  | "empty"
  | "stream"
  | "binary"
  | "text"
  | "unavailable";
export interface RouteResponse {
  kind: ResponseKind;
  schema: string;
  /** Success status of the route. */
  status: number;
  /** Other statuses that carry the same body (a partial `206`, a not-ready `503`). */
  alsoStatus: readonly number[];
}
export interface RouteDefinition {
  method: string;
  path: string;
  scope: string;
  /**
   * `public` skips authentication, `signature` is verified by the route itself, `worker` is a
   * remote worker's `tm_wrk_` credential scoped to the worker id in the path (ADR-030).
   */
  auth: "token" | "public" | "signature" | "worker";
  milestone: Milestone;
  requestSchema: string;
  response: RouteResponse;
}
const routeRows: ReadonlyArray<readonly [string, string, string, Milestone, string?, string?]> = [
  ["GET", "/health/live", "public", "M1", "Empty", "Liveness"],
  ["GET", "/health/ready", "ops:R", "M1", "Empty", "ReadinessReport"],
  ["GET", "/capabilities", "meta:R", "M1", "Empty", "CapabilityReport"],
  [
    "POST",
    "/contracts/validate",
    "meta:R",
    "M0",
    "DocumentValidationInput",
    "DocumentValidationResult",
  ],
  ["GET", "/me", "identity:R", "M4", "Empty", "MeResponse"],
  ["GET", "/rbac/matrix", "identity:R", "M4", "Empty", "RbacMatrix"],
  ["GET", "/workspaces", "workspace:R", "M4", "Empty", "Workspace"],
  ["POST", "/workspaces", "workspace:A", "M4", "WorkspaceInput", "WorkspaceCreated"],
  ["GET,PATCH", "/workspaces/{id}", "workspace:R/A", "M4", "WorkspaceInput", "Workspace"],
  ["GET", "/workspaces/{id}/members", "members:A", "M4", "Empty", "MemberView"],
  ["POST", "/workspaces/{id}/members", "members:A", "M4", "MemberInput", "MemberCreated"],
  [
    "PATCH,DELETE",
    "/workspaces/{id}/members/{memberId}",
    "members:A",
    "M4",
    "MembershipInput",
    "MemberView",
  ],
  ["GET", "/tokens", "tokens:A", "M4", "Empty", "TokenRecord"],
  ["POST", "/tokens", "tokens:A", "M4", "TokenInput", "TokenCreated"],
  ["DELETE", "/tokens/{id}", "tokens:A", "M4", "Empty", "TokenRecord"],
  ["GET,POST", "/projects", "projects:R/W", "M1", "ProjectInput", "Project"],
  ["GET,PATCH", "/projects/{id}", "projects:R/W", "M1", "ProjectInput", "Project"],
  ["POST", "/projects/{id}/archive", "projects:W", "M1", "Empty", "Project"],
  [
    "GET,PUT",
    "/projects/{id}/approval-policy",
    "projects:R/A",
    "M4",
    "ApprovalPolicyInput",
    "ApprovalPolicy",
  ],
  ["POST", "/projects/{id}/purge", "projects:A", "M4", "ConfirmationInput", "DeletionOperation"],
  ["GET,POST", "/projects/{id}/environments", "env:R/W", "M1", "EnvironmentInput", "Environment"],
  ["GET,PATCH,DELETE", "/environments/{id}", "env:R/W", "M1", "EnvironmentInput", "Environment"],
  [
    "POST",
    "/projects/{id}/default-environment",
    "env:W",
    "M1",
    "DefaultEnvironmentInput",
    "Project",
  ],
  ["GET,POST", "/secrets", "secrets:R/W", "M1", "SecretInput", "SecretReference"],
  ["POST", "/secrets/{id}/rotate", "secrets:W", "M4", "SecretRotationInput", "SecretReference"],
  ["GET", "/secrets/{id}/history", "secrets:R", "M4", "Empty", "SecretVersionRecord"],
  ["DELETE", "/secrets/{id}", "secrets:W", "M1", "Empty", "SecretReference"],
  ["GET,POST", "/auth-profiles", "env:R/W", "M4", "AuthProfileInput", "AuthProfileView"],
  ["GET,PATCH", "/auth-profiles/{id}", "env:R/W", "M4", "AuthProfilePatch", "AuthProfileView"],
  ["POST", "/uploads", "sources:W", "M2", "UploadRequest", "UploadReceipt"],
  ["PUT", "/uploads/{id}/bytes", "upload token", "M2", "Binary", "UploadReceipt"],
  ["POST", "/uploads/{id}/complete", "sources:W", "M2", "Empty", "UploadReceipt"],
  ["GET,POST", "/projects/{id}/sources", "sources:R/W", "M2", "SourceInput", "SourceListItemView"],
  ["GET,DELETE", "/sources/{id}", "sources:R/W", "M2", "Empty", "SourceDetail"],
  ["POST", "/projects/{id}/discovery", "discovery:X", "M2", "DiscoveryRequest", "DiscoveryDetail"],
  ["GET", "/discovery/{id}", "discovery:R", "M2", "Empty", "DiscoveryDetail"],
  ["GET", "/discovery/{id}/events", "discovery:R", "M2", "Empty", "DiscoveryEvent"],
  ["POST", "/discovery/{id}/retry", "discovery:X", "M2", "DiscoveryRetryInput", "DiscoveryDetail"],
  ["GET", "/projects/{id}/discovery", "discovery:R", "M4", "Empty", "DiscoverySummary"],
  [
    "GET,PUT",
    "/projects/{id}/onboarding",
    "projects:R/W",
    "M4",
    "OnboardingStateInput",
    "OnboardingState",
  ],
  [
    "POST",
    "/projects/{id}/onboarding/checks",
    "projects:W",
    "M4",
    "PrerequisiteInput",
    "PrerequisiteReport",
  ],
  ["GET", "/sources/{id}/revisions", "sources:R", "M4", "Empty", "SourceHistory"],
  [
    "POST",
    "/projects/{id}/requirements/normalizations",
    "plans:W",
    "M4",
    "NormalizationInput",
    "RequirementReview",
  ],
  ["GET", "/projects/{id}/requirements/review", "plans:R", "M4", "Empty", "RequirementReview"],
  [
    "POST",
    "/projects/{id}/requirements/decisions",
    "plans:W",
    "M4",
    "ConflictDecisionInput",
    "RequirementReview",
  ],
  [
    "POST",
    "/requirements/{id}/approve",
    "plans:W",
    "M4",
    "RequirementApprovalInput",
    "Requirement",
  ],
  [
    "POST",
    "/requirements/{id}/reject",
    "plans:W",
    "M4",
    "RequirementRejectionInput",
    "Requirement",
  ],
  ["GET", "/projects/{id}/feature-map", "plans:R", "M4", "Empty", "FeatureCoverageMap"],
  ["POST", "/discovery/{id}/cancel", "discovery:X", "M2", "Empty", "DiscoveryJobView"],
  [
    "GET,PATCH",
    "/projects/{id}/requirements",
    "plans:R/W",
    "M2",
    "RequirementsInput",
    "RequirementSnapshotView",
  ],
  ["POST", "/projects/{id}/proposal-batches", "plans:W", "M2", "GenerationInput", "ProposalBatch"],
  ["GET", "/proposal-batches/{id}", "plans:R", "M2", "Empty", "ProposalBatchDetail"],
  ["GET", "/projects/{id}/proposal-batches", "plans:R", "M4", "Empty", "ProposalBatchSummary"],
  [
    "POST",
    "/proposal-batches/{id}/preview",
    "plans:R",
    "M4",
    "ProposalPreviewInput",
    "ProposalPreview",
  ],
  [
    "GET,POST",
    "/proposals/{id}/refinements",
    "plans:R/W",
    "M4",
    "RefinementInput",
    "RefinementThread",
  ],
  [
    "POST",
    "/projects/{id}/plan-validations",
    "plans:R",
    "M4",
    "PlanValidationInput",
    "PlanValidation",
  ],
  ["GET", "/tests/{id}/history", "tests:R", "M4", "Empty", "TestHistoryEntry"],
  ["GET,PUT,DELETE", "/tests/{id}/draft", "tests:R/W", "M4", "TestDraftInput", "TestDraft"],
  [
    "GET,POST",
    "/tests/{id}/refinements",
    "plans:R/W",
    "M4",
    "TestRefinementInput",
    "RefinementThread",
  ],
  ["PATCH", "/proposals/{id}", "plans:W", "M2", "Proposal", "Proposal"],
  [
    "POST",
    "/proposal-batches/{id}/accept",
    "tests:W",
    "M2",
    "ProposalDecisionInput",
    "ProposalDecisionReceipt",
  ],
  [
    "POST",
    "/proposal-batches/{id}/reject",
    "plans:W",
    "M2",
    "ProposalDecisionInput",
    "ProposalDecisionReceipt",
  ],
  ["GET,POST", "/projects/{id}/tests", "tests:R/W", "M1", "TestRevisionInput", "TestCase"],
  ["POST", "/projects/{id}/probes", "tests:W", "M5", "ProbeInput", "TestCase"],
  ["GET,PATCH,DELETE", "/tests/{id}", "tests:R/W", "M1", "TestMetadataInput", "TestCase"],
  [
    "GET,PUT,DELETE",
    "/tests/{id}/quarantine",
    "tests:R/W",
    "M3",
    "QuarantineInput",
    "QuarantineRecord",
  ],
  ["GET,POST", "/tests/{id}/revisions", "tests:R/W", "M1", "TestRevisionInput", "TestRevision"],
  ["POST", "/tests/{id}/promote", "tests:W", "M2", "PromoteInput", "TestCase"],
  ["GET", "/revisions/{id}/code", "tests:R", "M2", "Empty", "TestCodeExport"],
  ["POST", "/runs", "runs:X", "M1", "RunRequest", "OwnedRunReceipt"],
  ["GET", "/runs", "runs:R", "M1", "Empty", "Run"],
  ["GET", "/runs/{id}", "runs:R", "M1", "Empty", "RunView"],
  ["POST", "/runs/{id}/cancel", "runs:X", "M1", "CancelInput", "CancelReceipt"],
  ["POST", "/runs/{id}/rerun", "runs:X", "M1", "RerunInput", "OwnedRunReceipt"],
  ["POST", "/runs/{id}/reproductions", "runs:X", "M5", "ReproductionInput", "ReproductionReceipt"],
  ["GET", "/runs/{id}/steps", "runs:R", "M1", "Empty", "StepResultRecord"],
  ["GET", "/runs/{id}/events", "runs:R", "M1", "Empty", "RunEventView"],
  ["GET", "/runs/{id}/bundle", "artifacts:R", "M1", "Empty", "EvidenceBundleView"],
  ["GET", "/artifacts/{id}", "artifacts:R", "M1", "Empty", "Binary"],
  ["GET", "/artifacts/{id}/content", "signature", "M4", "Empty", "Binary"],
  ["POST", "/artifacts/{id}/links", "artifacts:R", "M4", "ArtifactLinkInput", "ArtifactLink"],
  ["GET", "/runs/{id}/attempts", "runs:R", "M4", "Empty", "AttemptListItem"],
  ["GET", "/runs/{id}/healing-proposals", "healing:R", "M4", "Empty", "HealingProposal"],
  ["GET", "/projects/{id}/metrics", "runs:R", "M4", "Empty", "ProjectMetrics"],
  ["GET", "/projects/{id}/quarantine", "tests:R", "M4", "Empty", "QuarantineListItem"],
  ["GET", "/runs/{id}/analysis", "runs:R", "M3", "Empty", "Analysis"],
  ["POST", "/runs/{id}/analysis", "analysis:X", "M3", "AnalysisInput", "Analysis"],
  ["POST", "/runs/{id}/healing-proposals", "healing:W", "M3", "HealingInput", "HealingResult"],
  ["GET", "/healing-proposals/{id}", "healing:R", "M3", "Empty", "HealingProposal"],
  ["GET", "/healing-proposals/{id}/review", "healing:R", "M3", "Empty", "HealingReview"],
  [
    "POST",
    "/healing-proposals/{id}/approve",
    "healing:W",
    "M3",
    "HealingApproveInput",
    "HealingProposal",
  ],
  [
    "POST",
    "/healing-proposals/{id}/reject",
    "healing:W",
    "M3",
    "HealingRejectInput",
    "HealingProposal",
  ],
  ["POST", "/run-comparisons", "runs:R", "M3", "RunComparisonRequest", "ComparisonResult"],
  ["POST", "/batch-comparisons", "runs:R", "M3", "BatchComparisonRequest", "ComparisonResult"],
  ["POST", "/flake-studies", "runs:X", "M3", "FlakeStudyInput", "BatchReceipt"],
  ["GET", "/flake-studies/{id}", "runs:R", "M3", "Empty", "FlakeStudyReport"],
  ["POST", "/execution-previews", "runs:R", "M3", "SelectionInput", "SelectionPreview"],
  ["POST", "/selective-runs", "runs:X", "M3", "SelectionInput", "SelectionReceipt"],
  ["POST", "/batches", "runs:X", "M1", "BatchRequest", "BatchReceipt"],
  ["GET", "/batches/{id}", "runs:R", "M1", "Empty", "BatchView"],
  ["POST", "/batches/{id}/cancel", "runs:X", "M1", "CancelInput", "BatchCancelReceipt"],
  ["GET", "/suites", "suites:R", "M4", "Empty", "Suite"],
  ["POST", "/suites", "suites:W", "M4", "SuiteInput", "Suite"],
  ["POST", "/suites/preview", "suites:R", "M4", "SuiteInput", "SuiteExpansion"],
  ["GET,DELETE", "/suites/{id}", "suites:R/W", "M4", "Empty", "Suite"],
  ["PATCH", "/suites/{id}", "suites:W", "M4", "SuitePatchInput", "Suite"],
  ["GET", "/suites/{id}/expansion", "suites:R", "M4", "Empty", "SuiteExpansion"],
  ["POST", "/suites/{id}/runs", "runs:X", "M4", "SuiteRunInput", "BatchReceipt"],
  ["GET", "/schedules", "schedules:R", "M4", "Empty", "Schedule"],
  ["POST", "/schedules", "schedules:W", "M4", "ScheduleInput", "Schedule"],
  ["POST", "/schedules/preview", "schedules:R", "M4", "SchedulePreviewInput", "SchedulePreview"],
  ["GET,DELETE", "/schedules/{id}", "schedules:R/W", "M4", "Empty", "Schedule"],
  ["PATCH", "/schedules/{id}", "schedules:W", "M4", "SchedulePatchInput", "Schedule"],
  ["POST", "/schedules/{id}/pause", "schedules:W", "M4", "Empty", "Schedule"],
  ["POST", "/schedules/{id}/resume", "schedules:W", "M4", "Empty", "Schedule"],
  ["GET", "/schedules/{id}/revisions", "schedules:R", "M4", "Empty", "ScheduleRevision"],
  ["GET", "/schedules/{id}/firings", "schedules:R", "M4", "Empty", "ScheduledFire"],
  ["GET", "/resources", "runs:R", "M2", "Empty", "ResourceDetail"],
  ["POST", "/resources/{id}/cleanup", "cleanup:X", "M2", "CleanupInput", "CleanupReceipt"],
  ["GET", "/tunnels", "tunnel:X", "M5", "Empty", "Tunnel"],
  ["POST", "/tunnels", "tunnel:X", "M5", "TunnelInput", "TunnelOpening"],
  ["GET,DELETE", "/tunnels/{id}", "tunnel:X", "M5", "Empty", "Tunnel"],
  ["GET", "/workers", "workers:A", "M4", "Empty", "Worker"],
  ["POST", "/workers", "workers:A", "M4", "WorkerEnrollmentInput", "WorkerEnrollment"],
  ["GET", "/workers/{id}", "workers:A", "M4", "Empty", "Worker"],
  // Authenticated by the route itself with the worker credential (tm_wrk_), never by a user session.
  ["POST", "/workers/{id}/heartbeat", "signature", "M4", "HeartbeatInput", "Worker"],
  // Remote worker protocol (ADR-030, ADR-031): enrollment presents the `tm_wrk_` credential and
  // binds the worker's key; every other call is signed with that key for the path's worker.
  ["POST", "/workers/enroll", "worker", "M5", "Empty", "RemoteWorkerIdentity"],
  ["POST", "/workers/{id}/claims", "worker", "M5", "RemoteClaimInput", "RemoteClaim"],
  ...(
    [
      ["GET", "input", "Empty", "Binary"],
      ["POST", "heartbeat", "Empty", "RemoteAttemptLease"],
      ["POST", "events", "RemoteEventInput", "RemoteAck"],
      ["POST", "secrets", "RemoteSecretInput", "RemoteSecretValue"],
      ["POST", "captures", "RemoteCaptureInput", "RemoteCapture"],
      ["POST", "auth-state", "RemoteAuthStateInput", "RemoteAck"],
      ["POST", "actions", "RemoteActionInput", "RemoteAction"],
      ["PUT", "bundle", "Binary", "RemoteBundleFile"],
      ["POST", "finalize", "RemoteFinalizeInput", "RemoteAck"],
      ["POST", "fail", "RemoteFailInput", "RemoteAck"],
    ] as const
  ).map(
    ([method, path, input, output]) =>
      [
        method,
        `/workers/{id}/attempts/{attemptId}/${path}`,
        "worker",
        "M5",
        input,
        output,
      ] as const,
  ),
  ["GET", "/usage", "usage:R", "M2", "Empty", "UsageReport"],
  ["GET", "/audit-events", "audit:A", "M4", "Empty", "AuditEntry"],
  [
    "POST",
    "/integrations/{provider}/webhooks",
    "signature",
    "M4",
    "InboundWebhookBody",
    "InboundWebhookReceipt",
  ],
  ["GET,POST", "/integrations", "integrations:A", "M4", "IntegrationInput", "IntegrationMetadata"],
  [
    "PATCH",
    "/integrations/{id}",
    "integrations:A",
    "M4",
    "IntegrationPatchInput",
    "IntegrationMetadata",
  ],
  ["POST", "/integrations/{id}/test", "integrations:A", "M4", "Empty", "IntegrationTestReceipt"],
  [
    "POST",
    "/integrations/github/manifests",
    "integrations:A",
    "M4",
    "GithubManifestInput",
    "GithubManifestReceipt",
  ],
  [
    "POST",
    "/integrations/github/manifests/{state}/conversion",
    "integrations:A",
    "M4",
    "GithubManifestConversionInput",
    "IntegrationMetadata",
  ],
  [
    "GET",
    "/integrations/{id}/github/installations",
    "integrations:A",
    "M4",
    "Empty",
    "GithubInstallation",
  ],
  [
    "PATCH",
    "/integrations/{id}/github/repositories/{repositoryId}",
    "integrations:A",
    "M4",
    "GithubRepositoryPatch",
    "GithubRepository",
  ],
  ["GET", "/integrations/{id}/github/pulls", "integrations:R", "M4", "Empty", "GithubPull"],
  ["GET", "/integrations/{id}/github/checks", "integrations:R", "M4", "Empty", "GithubCheck"],
  [
    "POST",
    "/integrations/{id}/github/checks/{checkId}/retry",
    "integrations:W",
    "M4",
    "Empty",
    "GithubCheck",
  ],
  [
    "POST",
    "/integrations/{id}/github/rotate-webhook-secret",
    "integrations:A",
    "M4",
    "GithubRotateWebhookSecretInput",
    "IntegrationMetadata",
  ],
  ["POST", "/preview-deployments", "integrations:W", "M4", "PreviewDeploymentInput", "GithubPull"],
  ["POST", "/exports", "portability:R", "M6", "PortabilityInput", "OperationReceipt"],
  ["POST", "/imports", "portability:W", "M6", "PortabilityInput", "OperationReceipt"],
  ["POST", "/identity/login", "public", "M4", "LoginInput", "IdentityReceipt"],
  ["POST", "/identity/logout", "identity:R", "M4", "Empty", "IdentityReceipt"],
  ["POST", "/identity/recovery", "public", "M4", "RecoveryInput", "IdentityReceipt"],
  ["GET", "/identity/sessions", "identity:R", "M4", "Empty", "SessionMetadata"],
  ["DELETE", "/identity/sessions/{id}", "identity:R", "M4", "Empty", "Empty"],
  ["POST", "/identity/password", "identity:R", "M4", "PasswordChangeInput", "IdentityReceipt"],
  ["POST", "/identity/break-glass", "identity:A", "M6", "IdentityInput", "IdentityReceipt"],
  [
    "POST",
    "/auth-profiles/{id}/test-login",
    "env:X",
    "M4",
    "AuthTestLoginInput",
    "AuthTestLoginReceipt",
  ],
  [
    "POST",
    "/auth-profiles/{id}/authorize",
    "env:X",
    "M4",
    "AuthAuthorizeInput",
    "AuthAuthorization",
  ],
  [
    "POST",
    "/auth-profiles/{id}/complete-authorization",
    "env:X",
    "M4",
    "AuthCompleteInput",
    "AuthProfileView",
  ],
  [
    "POST",
    "/auth-profiles/{id}/import-state",
    "secrets:W",
    "M4",
    "AuthStateImportInput",
    "AuthProfileView",
  ],
  // Explicit `export` grant, step-up password and a short TTL are enforced by the service; W only gates the token.
  [
    "POST",
    "/auth-profiles/{id}/export-state",
    "secrets:W",
    "M4",
    "AuthStateExportInput",
    "AuthStateExport",
  ],
  ["POST", "/auth-profiles/{id}/revoke-session", "env:W", "M4", "Empty", "AuthProfileView"],
  ["GET,POST", "/auth-checkpoints", "worker:R/X", "M4", "AuthCheckpointInput", "AuthCheckpoint"],
  ["GET", "/auth-checkpoints/{id}", "env:R", "M4", "Empty", "AuthCheckpoint"],
  ...["continue", "cancel"].map(
    (path) =>
      [
        "POST",
        `/auth-checkpoints/{id}/${path}`,
        "env:X",
        "M4",
        "AuthContinueInput",
        "AuthCheckpoint",
      ] as const,
  ),
  ["GET,POST", "/approvals", "approvals:R/W", "M1", "Approval", "Approval"],
  ["POST", "/approvals/{id}/revoke", "approvals:W", "M1", "Empty", "Approval"],
  ["DELETE", "/artifacts/{id}", "artifacts:delete", "M3", "Empty", "DeletionOperation"],
  ["GET", "/deletion-operations", "deletion:R", "M4", "Empty", "DeletionOperation"],
  ["GET", "/deletion-operations/{id}", "deletion:R", "M3", "Empty", "DeletionOperation"],
  ["GET", "/projects/{id}/model-providers", "models:R", "M4", "Empty", "ModelProviderSettings"],
  ["GET", "/environments/{id}/revisions", "env:R", "M4", "Empty", "EnvironmentRevisionView"],
  ...["drain", "revoke"].map(
    (path) => ["POST", `/workers/{id}/${path}`, "workers:A", "M4", "Empty", "Worker"] as const,
  ),
  ["GET", "/deliveries", "integrations:R", "M4", "Empty", "DeliveryRecord"],
  ["GET", "/deliveries/{id}", "integrations:R", "M4", "Empty", "DeliveryDetail"],
  ["POST", "/deliveries/{id}/retry", "integrations:W", "M4", "Empty", "DeliveryRecord"],
  ["GET", "/operations", "ops:R", "M4", "Empty", "AdminOperation"],
  ["GET", "/operations/status", "ops:R", "M4", "Empty", "OperationsStatus"],
  ["GET", "/operations/slo", "ops:R", "M4", "Empty", "SloReport"],
  ["GET", "/operations/dlq", "ops:R", "M4", "Empty", "DlqEntry"],
  ["POST", "/operations/dlq/requeue", "ops:A", "M4", "DlqRequeueInput", "DlqEntry"],
  [
    "POST",
    "/operations/isolation/release",
    "ops:A",
    "M4",
    "IsolationReleaseInput",
    "AdminOperation",
  ],
  ["GET", "/operations/{id}", "ops:R", "M4", "Empty", "AdminOperation"],
  ["POST", "/operations/admission", "ops:A", "M4", "AdmissionInput", "AdminOperation"],
  ["POST", "/operations/worker-claims", "ops:A", "M5", "OperationsClaimsInput", "OperationsStatus"],
  ["POST", "/operations/reconcile", "ops:A", "M4", "ReconcileInput", "AdminOperation"],
  ["POST", "/operations/backups", "ops:A", "M4", "BackupInput", "AdminOperation"],
  ["POST", "/operations/restores", "ops:A", "M4", "RestoreVerifyInput", "AdminOperation"],
  ["GET", "/metrics", "ops:R", "M4", "Empty", "MetricsText"],
  ["GET", "/alerts", "ops:R", "M4", "Empty", "Alert"],
  ["POST", "/alerts/{id}/acknowledge", "ops:A", "M4", "Empty", "Alert"],
  ["GET", "/alert-rules", "ops:R", "M4", "Empty", "AlertRuleView"],
  ["GET,POST", "/incidents", "ops:R/A", "M4", "IncidentInput", "Incident"],
  ["GET", "/incidents/{id}", "ops:R", "M4", "Empty", "Incident"],
  ["POST", "/incidents/{id}/events", "ops:A", "M4", "IncidentEventInput", "Incident"],
  ["POST", "/incidents/{id}/close", "ops:A", "M4", "IncidentCloseInput", "Incident"],
  [
    "GET,POST",
    "/projects/{id}/memory",
    "memory:R/W",
    "M5",
    "MemoryEntryInput",
    "MemoryEntryView",
  ],
  ["PATCH,DELETE", "/memory/{id}", "memory:W", "M5", "MemoryEntryPatchInput", "MemoryEntryView"],
  [
    "POST",
    "/integrations/{id}/issues/import",
    "integrations:W",
    "M5",
    "IssueImportInput",
    "IssueImportReceipt",
  ],
  ["GET,POST", "/issue-links", "issues:R/W", "M5", "IssueLinkDraftInput", "IssueLink"],
  ["POST", "/issue-links/{id}/preview", "issues:W", "M5", "Empty", "IssueLinkPreview"],
  ["POST", "/issue-links/{id}/execute", "issues:W", "M5", "IssueLinkExecuteInput", "IssueLink"],
  [
    "POST",
    "/projects/{id}/issue-links/sync",
    "issues:W",
    "M5",
    "Empty",
    "IssueLinkSyncReceipt",
  ],
  ["GET", "/visual-baselines", "tests:R", "M5", "Empty", "VisualBaseline"],
  ["POST", "/visual-baselines", "tests:W", "M5", "VisualBaselineInput", "VisualBaseline"],
  [
    "POST",
    "/visual-baselines/{id}/approve",
    "tests:approve",
    "M5",
    "ExpectedVersionInput",
    "VisualBaseline",
  ],
];
type ResponseOverride = Partial<RouteResponse>;
const keysWith = (
  override: ResponseOverride,
  keys: readonly string[],
): Record<string, ResponseOverride> => Object.fromEntries(keys.map((key) => [key, override]));
/**
 * Response overrides keyed `METHOD /path`, each verified against the route handler
 * (`apps/server/src/routes`). A route absent here answers `200` with one entity of its row's
 * response schema. Every key must name a catalog route; a stale key fails at module load.
 */
const responseOverrides: Readonly<Record<string, ResponseOverride>> = {
  // `context.page(...)`, `pageFrom(...)` or the audit trail's own cursor: `{items, hasMore, nextCursor}`.
  ...keysWith({ kind: "page" }, [
    "GET /projects",
    "GET /projects/{id}/environments",
    "GET /secrets",
    "GET /secrets/{id}/history",
    "GET /projects/{id}/tests",
    "GET /tests/{id}/revisions",
    "GET /tests/{id}/history",
    "GET /projects/{id}/proposal-batches",
    "GET /projects/{id}/sources",
    "GET /projects/{id}/discovery",
    "GET /projects/{id}/quarantine",
    "GET /environments/{id}/revisions",
    "GET /runs",
    "GET /runs/{id}/steps",
    "GET /runs/{id}/attempts",
    "GET /runs/{id}/healing-proposals",
    "GET /resources",
    "GET /approvals",
    "GET /workspaces/{id}/members",
    "GET /tokens",
    "GET /deletion-operations",
    "GET /audit-events",
    "GET /auth-profiles",
    "GET /auth-checkpoints",
    "GET /deliveries",
    "GET /workers",
    "GET /integrations",
    "GET /integrations/{id}/github/installations",
    "GET /integrations/{id}/github/pulls",
    "GET /integrations/{id}/github/checks",
    "GET /operations",
    "GET /operations/dlq",
    "GET /alerts",
    "GET /alert-rules",
    "GET /incidents",
    "GET /schedules",
    "GET /schedules/{id}/revisions",
    "GET /schedules/{id}/firings",
    "GET /suites",
    "GET /tunnels",
    "GET /visual-baselines",
    "GET /projects/{id}/memory",
    "GET /issue-links",
  ]),
  // Lists that the service bounds itself: `{items}` without a cursor.
  ...keysWith({ kind: "items" }, ["GET /workspaces", "GET /identity/sessions"]),
  // Handlers that return `{}` after a void service call.
  ...keysWith({ kind: "empty" }, [
    "DELETE /identity/sessions/{id}",
    "DELETE /workspaces/{id}/members/{memberId}",
  ]),
  ...keysWith({ status: 201 }, [
    "POST /projects",
    "POST /projects/{id}/environments",
    "POST /projects/{id}/tests",
    "POST /tests/{id}/revisions",
    "POST /uploads",
    "POST /proposals/{id}/refinements",
    "POST /tests/{id}/refinements",
    "POST /auth-profiles",
    "POST /auth-checkpoints",
    "POST /integrations",
    "POST /integrations/github/manifests",
    "POST /workspaces",
    "POST /workspaces/{id}/members",
    "POST /tokens",
    "POST /incidents",
    "POST /schedules",
    "POST /suites",
    "POST /workers",
    "POST /tunnels",
    "POST /visual-baselines",
    "POST /projects/{id}/probes",
    "POST /projects/{id}/memory",
    "POST /issue-links",
  ]),
  ...keysWith({ status: 202 }, [
    "POST /runs",
    "POST /runs/{id}/reproductions",
    "POST /batches",
    "POST /projects/{id}/discovery",
    "POST /projects/{id}/proposal-batches",
    "POST /suites/{id}/runs",
    "POST /operations/backups",
    "POST /operations/restores",
  ]),
  // The row names the schema of the GET (or the first method); these methods differ.
  "POST /projects/{id}/sources": { schema: "SourceDetail" },
  "DELETE /sources/{id}": { schema: "Source" },
  // Not ready answers 503 with the same envelope.
  "GET /health/ready": { alsoStatus: [503] },
  // Raw bodies: a single `Range` answers 206.
  "GET /artifacts/{id}": { kind: "binary", alsoStatus: [206] },
  "GET /artifacts/{id}/content": { kind: "binary", alsoStatus: [206] },
  // One input file of a remotely claimed Attempt, as raw bytes.
  "GET /workers/{id}/attempts/{attemptId}/input": { kind: "binary" },
  "GET /metrics": { kind: "text" },
  "GET /runs/{id}/events": { kind: "stream" },
  "GET /discovery/{id}/events": { kind: "stream" },
  // Reserved for M6: no handler is registered, every call answers CAPABILITY_UNAVAILABLE.
  ...keysWith({ kind: "unavailable" }, [
    "POST /exports",
    "POST /imports",
    "POST /identity/break-glass",
  ]),
};
const responseFor = (key: string, rowSchema: string): RouteResponse => ({
  kind: "item",
  schema: rowSchema,
  status: 200,
  alsoStatus: [],
  ...responseOverrides[key],
});
export const routeCatalog: readonly RouteDefinition[] = routeRows.flatMap(
  ([methods, path, scope, milestone, requestSchema = "Empty", responseSchema = "Empty"]) =>
    methods.split(",").map((method, index) => {
      let resolvedScope = scope;
      if (scope.includes("/")) {
        const colon = scope.lastIndexOf(":");
        const prefix = scope.slice(0, colon);
        const parts = scope.slice(colon + 1).split("/");
        resolvedScope = `${prefix}:${parts[Math.min(index, parts.length - 1)]}`;
      }
      return {
        method,
        path,
        scope: resolvedScope,
        auth: scope === "public" || scope === "signature" || scope === "worker" ? scope : "token",
        milestone,
        requestSchema:
          method === "GET" || (method === "DELETE" && path !== "/tests/{id}")
            ? "Empty"
            : method === "PATCH" && path === "/projects/{id}"
              ? "ProjectPatchInput"
              : method === "PATCH" && path === "/environments/{id}"
                ? "EnvironmentPatchInput"
                : method === "POST" && path === "/approvals"
                  ? "ApprovalInput"
                  : method === "DELETE"
                    ? "TestArchiveInput"
                    : requestSchema,
        response: responseFor(`${method} ${path}`, responseSchema),
      };
    }),
);
{
  const known = new Set(routeCatalog.map((route) => `${route.method} ${route.path}`));
  for (const key of Object.keys(responseOverrides))
    if (!known.has(key)) throw new Error(`Response override ${key} is not a catalog route`);
}
/** Adds the agent-facing description of an input property without changing its validation. */
const d = <T extends TSchema>(schema: T, description: string): T =>
  ({ ...schema, description }) as T;
const runId = (description = "Run id") => d(id("run"), description);
export const mcpTools = {
  testmaster_capabilities: { milestone: "M1", input: Obj({}), output: "CapabilityManifest" },
  testmaster_validate_document: {
    milestone: "M0",
    input: Obj({
      schema: d(
        Enum(["ExecutablePlan", "ProjectConfig", "RunRequest"]),
        "Contract to validate against",
      ),
      document: d(
        Json,
        "The document to validate; neither stored nor run. A plan's schema is the resource testmaster://schemas/ExecutablePlan",
      ),
    }),
    output: "DocumentValidationResult",
  },
  testmaster_bootstrap: {
    milestone: "M2",
    input: Obj({
      projectRoot: d(Name, "Project root directory; must be inside an approved root"),
      target: d(
        Type.String({ pattern: "^https?://[^\\s]+$", maxLength: 2048 }),
        "http(s) URL of the application under test, without credentials; it is never probed",
      ),
      scope: d(
        Type.Array(Enum(["codebase", "diff"]), { minItems: 1, uniqueItems: true }),
        "What the project will analyze: codebase and/or diff",
      ),
      mode: d(Mode, "Execution mode of the proposed config: replay (deterministic) or agent"),
    }),
    output: "BootstrapReceipt",
  },
  testmaster_analyze_code: {
    milestone: "M2",
    input: Obj({
      projectId: d(id("prj"), "Project id"),
      root: d(Name, "Directory to analyze; must be inside an approved root"),
      base: Type.Optional(
        d(
          Name,
          "Base git ref of a diff analysis (needs head or dirty); omit for the whole codebase",
        ),
      ),
      head: Type.Optional(
        d(Name, "Head git ref of a diff analysis; required with base unless dirty is true"),
      ),
      dirty: Type.Optional(
        d(
          Type.Boolean(),
          "Diff base against the working tree instead of a head ref; requires base",
        ),
      ),
    }),
    output: "CodeAnalysisReceipt",
  },
  testmaster_normalize_requirements: {
    milestone: "M2",
    input: Obj({
      projectId: d(id("prj"), "Project id"),
      sourceRevisionIds: d(Type.Array(id("svr")), "Source revisions to normalize"),
      provider: Type.Optional(
        d(Name, "Model provider id; absent: the first allowed provider with a capable model"),
      ),
      model: Type.Optional(
        d(Name, "Model id from the project's profiles; defaults to the first capable one"),
      ),
    }),
    output: "NormalizedRequirements",
  },
  testmaster_explore: {
    milestone: "M2",
    input: Obj({
      projectId: d(id("prj"), "Project id"),
      envId: d(id("env"), "Environment to explore"),
      featureIds: d(
        Type.Array(id("fea")),
        "Feature ids to explore, looked up by stable key at testmaster://projects/{projectId}/features; empty with jobId resumes that job",
      ),
      budget: Obj(
        {
          steps: d(Type.Integer({ minimum: 1, maximum: 100 }), "Browser steps, 1..100"),
          timeMs: d(
            Type.Integer({ minimum: 1000, maximum: 300000 }),
            "Time budget in ms, 1000..300000",
          ),
        },
        { description: "Exploration envelope: browser steps and time" },
      ),
      provider: Type.Optional(
        d(Name, "Model provider id for action resolution; absent: first allowed provider"),
      ),
      model: Type.Optional(
        d(Name, "Model id for action resolution; absent: the provider's first capable model"),
      ),
      mutationActions: Type.Optional(
        d(
          // Each entry is validated as a plan Step by the service; inlining the recursive Step
          // schema here would make the advertised tool schema hundreds of kilobytes.
          Type.Array(Type.Object({}, { additionalProperties: true }), { maxItems: 20 }),
          "Approved form steps (plan Step objects: click, fill, press, select, check, uncheck; each with a locator) the controller may select when one matches an observed control; max 20, refused in production environments. Without it a form-only page offers the model nothing to choose",
        ),
      ),
      jobId: Type.Optional(d(id("dsc"), "Existing exploration job to resume or retry")),
      wait: Type.Optional(
        d(Type.Boolean(), "Block until the job ends instead of returning its id"),
      ),
    }),
    output: "DiscoveryJob",
  },
  testmaster_generate_plan: {
    milestone: "M2",
    input: Obj({
      projectId: d(id("prj"), "Project id"),
      sourceSnapshotId: d(
        Name,
        "Current fingerprint of the approved requirement snapshot (testmaster_review_requirements returns it; also at testmaster://requirements/{projectId})",
      ),
      type: d(
        Enum(["frontend", "backend", "auto", "integration"]),
        "Kind of tests to propose; auto lets the model choose per requirement",
      ),
      requirementIds: Type.Optional(
        d(
          Type.Array(id("req"), { minItems: 1, maxItems: 100 }),
          "Restrict the plan to these requirements",
        ),
      ),
      provider: Type.Optional(
        d(Name, "Model provider id for plan generation; absent: first allowed provider"),
      ),
      model: Type.Optional(
        d(Name, "Model id from the project's profiles; absent: the provider's first capable model"),
      ),
      partialGeneration: Type.Optional(
        d(
          Type.Boolean(),
          "After the repairs, store the proposals that pass the checks and list the refused ones in extensions['testmaster:refusedProposals']; default false: one refused proposal refuses the whole batch",
        ),
      ),
    }),
    output: "McpProposalBatch",
  },
  testmaster_trial_plan: {
    milestone: "M2",
    input: Obj({
      batchId: d(id("pbt"), "Proposal batch id"),
      environmentId: d(id("env"), "Environment to replay the proposals' plans against"),
      proposalIds: Type.Optional(
        d(
          Type.Array(id("pro"), { minItems: 1, uniqueItems: true }),
          "Proposals of the batch to try; absent: every proposal of the batch",
        ),
      ),
    }),
    output: "PlanTrialReceipt",
  },
  testmaster_review_plan: {
    milestone: "M2",
    input: Obj({
      batchId: d(id("pbt"), "Proposal batch id"),
      expectedVersion: d(Version, "Batch version being reviewed, for optimistic concurrency"),
      acceptIds: d(Type.Array(id("pro")), "Proposals to accept"),
      rejectIds: d(Type.Array(id("pro")), "Proposals to reject"),
      reason: Type.Optional(
        d(
          DecisionReason,
          "Why you accept or reject; recorded on each decided proposal with the reviewer and time",
        ),
      ),
    }),
    output: "ProposalDecisionReceipt",
  },
  testmaster_generate_tests: {
    milestone: "M2",
    // Flat object on purpose: a top-level anyOf hides the other properties from clients that render
    // the first branch only. "proposalIds or revisionIds, or runId alone" is enforced at runtime.
    input: Obj({
      proposalIds: Type.Optional(
        d(
          Type.Array(id("pro"), { minItems: 1 }),
          "Accepted proposals to generate code for; give proposalIds or revisionIds (at least one), all from one project",
        ),
      ),
      revisionIds: Type.Optional(
        d(
          Type.Array(id("rev"), { minItems: 1 }),
          "Existing revisions to regenerate code for; give proposalIds or revisionIds (at least one), all from one project",
        ),
      ),
      runId: Type.Optional(
        d(
          id("run"),
          "A completed, failed run of a code candidate: repairs that candidate from the run's failed steps. Exclusive with proposalIds and revisionIds",
        ),
      ),
      provider: Type.Optional(
        d(Name, "Model provider id for code generation; absent: first allowed provider"),
      ),
      model: Type.Optional(
        d(
          Name,
          "Model id for code generation, validated before any call; absent: the provider's first structured-output model",
        ),
      ),
    }),
    output: "GeneratedTestsReceipt",
  },
  testmaster_run_tests: {
    milestone: "M1",
    input: Obj({
      testIds: Type.Optional(d(Type.Array(id("tst")), "Tests to run; needs environmentId")),
      revisionId: Type.Optional(
        d(
          id("rev"),
          "Run this exact revision (candidate or healed) of the single test in testIds instead of its active one; not with suiteId",
        ),
      ),
      suiteId: Type.Optional(d(id("sui"), "List to run (replay only) instead of testIds")),
      /** Required with testIds; a list (suiteId) carries an explicit environment per project. */
      environmentId: Type.Optional(d(id("env"), "Environment for testIds; lists carry their own")),
      mode: Type.Optional(
        d(Mode, "replay (deterministic, default) or agent; lists run in replay only"),
      ),
      /** Lists only: exclusion keys the caller accepts so the dispatchable subset runs. */
      confirmedExclusions: Type.Optional(
        d(
          Type.Array(Name, { maxItems: 600 }),
          "Lists only: exclusion keys accepted so the rest runs",
        ),
      ),
      limits: Type.Optional(d(RunLimits, "Per-run execution limits")),
      jobId: Type.Optional(
        d(id("bat"), "Existing batch to re-read or wait on instead of admitting"),
      ),
      idempotencyKey: Type.Optional(
        d(
          Type.String({ minLength: 16, maxLength: 128 }),
          "16-128 characters; a retried admission with the same key returns the same batch",
        ),
      ),
      wait: Type.Optional(d(Type.Boolean(), "Block until every run completes")),
      timeoutMs: Type.Optional(
        d(
          Type.Integer({ minimum: 1, maximum: 6000000 }),
          "Wait deadline in ms, default 1800000 (30 min); runs continue after it",
        ),
      ),
    }),
    output: "McpBatchReceipt",
  },
  testmaster_get_run: {
    milestone: "M1",
    input: Obj({
      runId: runId(),
      wait: Type.Optional(d(Type.Boolean(), "Block until the run completes")),
      timeoutMs: Type.Optional(
        d(
          Type.Integer({ minimum: 1, maximum: 6000000 }),
          "Wait deadline in ms; the run continues after it",
        ),
      ),
    }),
    output: "McpRunResult",
  },
  testmaster_get_analysis: {
    milestone: "M3",
    input: Obj({ runId: runId() }),
    output: "Analysis",
  },
  testmaster_analyze_run: {
    milestone: "M3",
    input: Obj({
      runId: runId("Failed run to diagnose"),
      model: Type.Optional(
        d(
          Type.Union([Type.Boolean(), Name]),
          "Also ask a model to read the recorded evidence: true uses the first capable model, a model id uses that model. Absent or false: rules only",
        ),
      ),
      provider: Type.Optional(
        d(Name, "Model provider id for the model reading; requires model (true or a model id)"),
      ),
      discoveryId: Type.Optional(d(id("dsc"), "Discovery job to cross-reference")),
    }),
    output: "McpAnalysis",
  },
  testmaster_get_evidence: {
    milestone: "M1",
    input: Obj({
      runId: runId(),
      attemptId: Type.Optional(d(id("att"), "Attempt; defaults to the last one")),
      failedOnly: Type.Optional(d(Type.Boolean(), "Only entries of failed steps")),
      maxBytes: Type.Optional(
        d(Type.Integer({ minimum: 1, maximum: 67108864 }), "Page size bound in bytes"),
      ),
      cursor: Type.Optional(
        d(Type.String({ minLength: 1, maxLength: 4096 }), "nextCursor of the previous page"),
      ),
    }),
    output: "EvidenceSummary",
  },
  testmaster_cancel_run: {
    milestone: "M1",
    input: Obj({
      runId: runId("Run to cancel"),
      reason: d(Description, "Why the run is cancelled"),
    }),
    output: "CancelReceipt",
  },
  testmaster_compare_runs: {
    milestone: "M3",
    input: Obj({
      left: runId("Baseline run"),
      right: runId("Run to compare against the baseline"),
      cursor: Type.Optional(
        d(Type.String({ minLength: 1, maxLength: 4096 }), "nextCursor of the previous page"),
      ),
      limit: Type.Optional(d(Type.Integer({ minimum: 1, maximum: 100 }), "Page size, 1..100")),
    }),
    output: "ComparisonResult",
  },
  testmaster_propose_healing: {
    milestone: "M3",
    input: Obj({
      runId: runId("Failed run to heal"),
      provider: Type.Optional(d(Name, "Model provider id")),
      model: Type.Optional(d(Name, "Model id")),
    }),
    output: "HealingResult",
  },
  testmaster_review_healing: {
    milestone: "M3",
    input: Obj({ proposalId: d(id("hea"), "Healing proposal id") }),
    output: "HealingReview",
  },
  testmaster_approve_healing: {
    milestone: "M3",
    input: Obj({
      proposalId: d(id("hea"), "Healing proposal id"),
      expectedVersion: d(Version, "approval.expectedVersion from testmaster_review_healing"),
      reason: Type.Optional(
        d(
          DecisionReason,
          "Why you approve; recorded on the proposal with the reviewer and time (testmaster_review_healing shows it)",
        ),
      ),
    }),
    output: "HealingProposal",
  },
  testmaster_reject_healing: {
    milestone: "M3",
    input: Obj({
      proposalId: d(id("hea"), "Healing proposal id"),
      reason: d(
        Type.String({ minLength: 1, maxLength: 8000 }),
        "Why you reject; recorded on the proposal with the reviewer and time (testmaster_review_healing shows it)",
      ),
    }),
    output: "HealingProposal",
  },
  testmaster_edit_plan: {
    milestone: "M2",
    input: Obj({
      proposalId: d(
        id("pro"),
        "Proposal to edit; it must still be proposed (not accepted or rejected)",
      ),
      plan: d(
        // Validated as an ExecutablePlan by the service; inlining the recursive Step schema would
        // make the advertised tool schema hundreds of kilobytes. testmaster_validate_document checks one.
        Type.Object({}, { additionalProperties: true }),
        "Replacement ExecutablePlan (kind executable); the proposal's requirement and evidence references are kept. Schema: testmaster://schemas/ExecutablePlan (steps: testmaster://schemas/Step)",
      ),
      expectedVersion: d(Version, "Proposal version being edited, for optimistic concurrency"),
    }),
    output: "McpEditedPlan",
  },
  testmaster_save_test: {
    milestone: "M2",
    input: Obj({
      plan: d(
        Type.Object({}, { additionalProperties: true }),
        "ExecutablePlan to store, linted like a CLI plan file. Schema: testmaster://schemas/ExecutablePlan (steps: testmaster://schemas/Step); check one with testmaster_validate_document",
      ),
      projectId: Type.Optional(
        d(id("prj"), "Create a new test in this project; give projectId or testId"),
      ),
      testId: Type.Optional(
        d(
          id("tst"),
          "Add a new revision to this existing test instead; the revision is a candidate until testmaster_promote_revision",
        ),
      ),
      parentRevisionId: Type.Optional(
        d(
          id("rev"),
          "Revision the new one derives from; only with testId, must belong to that test",
        ),
      ),
      name: Type.Optional(d(Name, "Test name for a new test; default: the plan name")),
      tags: Type.Optional(d(Type.Array(Name, { maxItems: 32 }), "Tags of a new test")),
      priority: Type.Optional(d(Priority, "Priority of a new test")),
      justification: Type.Optional(d(Description, "Why the test or revision is saved")),
    }),
    output: "McpSavedTest",
  },
  testmaster_import_code: {
    milestone: "M2",
    input: Obj({
      path: d(
        Name,
        "Entry file (.ts Playwright or .py pytest) inside an approved root and the project root; its relative imports are bundled",
      ),
      format: d(Enum(["playwright", "pytest"]), "Framework of the code"),
      projectId: Type.Optional(
        d(id("prj"), "Create a new test in this project; give projectId or testId"),
      ),
      testId: Type.Optional(
        d(
          id("tst"),
          "Add the code as a candidate revision of this existing test instead; it is not active until testmaster_promote_revision",
        ),
      ),
      parentRevisionId: Type.Optional(
        d(
          id("rev"),
          "Parent of the candidate; only with testId (default: the test's active revision)",
        ),
      ),
      name: Type.Optional(d(Name, "Name of a new test; default: the first test title in the code")),
    }),
    output: "McpSavedTest",
  },
  testmaster_promote_revision: {
    milestone: "M2",
    input: Obj({
      revisionId: d(id("rev"), "Candidate revision to make the active one of its test"),
      expectedVersion: d(
        Version,
        "Current version of the test: testVersion of testmaster://tests/{id}/revisions, or version of testmaster://tests/{id}",
      ),
      reason: Type.Optional(
        d(
          DecisionReason,
          "Why you promote; recorded on the test with the reviewer and time (test history shows it)",
        ),
      ),
    }),
    output: "TestCase",
  },
  testmaster_archive_test: {
    milestone: "M1",
    input: Obj({
      testId: d(id("tst"), "Test to archive"),
      expectedVersion: d(Version, "Current version of the test (testmaster://tests/{id})"),
      reason: Type.Optional(
        d(
          DecisionReason,
          "Why you archive; recorded on the test with the actor and time, not in the audit trail",
        ),
      ),
    }),
    output: "TestCase",
  },
  testmaster_save_suite: {
    milestone: "M2",
    input: Obj({
      suiteId: Type.Optional(
        d(id("sui"), "Existing list to change; absent: create a list (name required)"),
      ),
      expectedVersion: Type.Optional(d(Version, "Current list version; required with suiteId")),
      name: Type.Optional(d(Name, "List name; required to create")),
      description: Type.Optional(d(Description, "List description")),
      memberIntervalMs: Type.Optional(
        d(
          SuiteMemberInterval,
          "Minimum ms between the starts of consecutive members of a batch of this list; 0 clears; absent keeps",
        ),
      ),
      selection: Type.Optional(
        d(
          SuiteSelection,
          "Whole selection: fixed pinned members or dynamic project filters. Create needs selection or addMembers; with suiteId it replaces the selection",
        ),
      ),
      addMembers: Type.Optional(
        d(
          Type.Array(SuiteFixedMember, { minItems: 1, maxItems: 500 }),
          "Fixed members (test, revision, environment) appended to the fixed selection, or the members of a new fixed list",
        ),
      ),
      removeMembers: Type.Optional(
        d(
          Type.Array(
            Obj({
              testId: id("tst"),
              revisionId: Type.Optional(id("rev")),
              environmentId: Type.Optional(id("env")),
            }),
            { minItems: 1, maxItems: 500 },
          ),
          "Members to drop from a fixed selection; revisionId and environmentId narrow the match, absent they match every member of the test",
        ),
      ),
    }),
    output: "Suite",
  },
  testmaster_approve_execution: {
    milestone: "M3",
    input: Obj({
      actionSet: d(
        Type.Array(Name, { minItems: 1 }),
        "Risk classes, step ids or tunnel:<id> the approval covers",
      ),
      revisionHash: d(ContentDigest, "Exact revision contentHash"),
      environmentRevisionId: d(id("evr"), "Exact environment revision"),
      originSet: d(
        Type.Array(Name, { minItems: 1 }),
        "Canonical http(s) origins the run may touch, without path",
      ),
      policyHash: d(ContentDigest, "Run policy hash"),
      reason: d(Name, "Why the caller approves this execution (1-200 characters)"),
      actorId: Type.Optional(d(Name, "Principal id that will execute; defaults to the caller")),
      limits: Type.Optional(
        d(Type.Unsafe<Record<string, unknown>>({ type: "object" }), "Copy of binding.limits"),
      ),
      expiresAt: Type.Optional(
        d(Timestamp, "Expiry, at most 30 minutes ahead; default 30 minutes"),
      ),
    }),
    output: "Approval",
  },
  testmaster_open_report: {
    milestone: "M1",
    input: Obj({
      runId: Type.Optional(runId("Run id; send runId or batchId")),
      batchId: Type.Optional(
        d(
          id("bat"),
          "Batch id (the batchId/jobId of a run_tests receipt): one report over its member runs; send runId or batchId",
        ),
      ),
    }),
    output: "ReportLocation",
  },
  testmaster_add_source: {
    milestone: "M2",
    input: Obj({
      projectId: d(id("prj"), "Project id"),
      path: d(
        Name,
        "Source file inside an approved root: PRD (markdown, text, JSON, PDF), OpenAPI, GraphQL or Postman",
      ),
      role: d(
        Name,
        "What the source is, e.g. prd or api; role api-spec reads as OpenAPI unless format says otherwise",
      ),
      name: Type.Optional(d(Name, "Display name; defaults to the file name")),
      format: Type.Optional(
        d(
          Enum(["markdown", "text", "prd-json", "pdf", "openapi", "graphql", "postman"]),
          "Parser to use; absent: chosen from the extension and role",
        ),
      ),
      sourceId: Type.Optional(
        d(id("src"), "Existing source to add a new revision to; needs expectedVersion"),
      ),
      expectedVersion: Type.Optional(
        d(Version, "Current version of sourceId, for optimistic concurrency"),
      ),
    }),
    output: "McpSourceReceipt",
  },
  testmaster_archive_source: {
    milestone: "M2",
    input: Obj({
      sourceId: d(id("src"), "Source to archive"),
      expectedVersion: d(
        Version,
        "Current version of the source (testmaster://projects/{projectId}/sources)",
      ),
    }),
    output: "Source",
  },
  testmaster_review_requirements: {
    milestone: "M4",
    input: Obj({
      projectId: d(id("prj"), "Project id"),
      expectedVersion: d(
        Version,
        "Snapshot version these decisions are based on: version of testmaster_normalize_requirements or testmaster://requirements/{projectId}. Each item then applies at its requirement's current version",
      ),
      update: Type.Optional(
        d(
          Type.Array(
            Obj({
              requirementId: d(id("req"), "Requirement to edit"),
              text: Type.Optional(d(Description, "New requirement text")),
              acceptanceCriteria: Type.Optional(
                d(Type.Array(Description), "New acceptance criteria; replaces the list"),
              ),
            }),
            { maxItems: 100 },
          ),
          "Edits applied first; an edit clears the requirement's approval",
        ),
      ),
      adjudicate: Type.Optional(
        d(
          Type.Array(
            Obj({
              conflictId: d(Name, "Conflict id from testmaster_normalize_requirements"),
              selectedRequirementId: d(
                id("req"),
                "Requirement the conflict resolves to; the conflict's other requirements are superseded and never planned",
              ),
              reason: d(Type.String({ minLength: 1, maxLength: 2000 }), "Why this one"),
            }),
            { maxItems: 100 },
          ),
          "Conflict decisions applied after the edits",
        ),
      ),
      reject: Type.Optional(
        d(
          Type.Array(
            Obj({
              requirementId: d(id("req"), "Requirement that is out of scope or not wanted"),
              reason: d(
                Type.String({ minLength: 1, maxLength: 2000 }),
                "Why it is rejected; required and recorded",
              ),
            }),
            { maxItems: 100 },
          ),
          "Rejections applied after the conflict decisions and before the approvals. A rejected requirement is not pending, is never planned and cannot be approved or edited again; an id in both reject and approve refuses the whole call",
        ),
      ),
      approve: Type.Optional(
        d(
          Type.Array(id("req"), { maxItems: 100 }),
          "Requirements to approve, applied last; a requirement in an unresolved conflict is refused",
        ),
      ),
      reason: Type.Optional(
        d(
          DecisionReason,
          "Why you edit and approve; recorded on each edited or approved requirement with the reviewer and time (the requirements resource shows it). Rejections and conflict decisions carry their own reason",
        ),
      ),
    }),
    output: "McpRequirementsReview",
  },
  testmaster_set_secret: {
    milestone: "M1",
    input: Obj({
      name: d(Name, "Secret name: letters, digits, dot, underscore, hyphen; unique"),
      valueFile: Type.Optional(
        d(
          Name,
          "File inside an approved root that holds the value; one trailing newline is removed. Give exactly one of valueFile or fromEnv",
        ),
      ),
      fromEnv: Type.Optional(
        d(
          Name,
          "Name of an environment variable of the TestMaster process that holds the value. Give exactly one of valueFile or fromEnv",
        ),
      ),
      allowedOrigins: d(
        Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { minItems: 1, maxItems: 32 }),
        "Exact origins (scheme://host[:port]) the secret may be sent to; any other destination is refused",
      ),
    }),
    output: "SecretReference",
  },
  testmaster_rotate_secret: {
    milestone: "M1",
    input: Obj({
      secret: d(
        Name,
        "Secret id (sec_…) or name of a live secret; its allowedOrigins and id stay, its secretVersion goes up",
      ),
      valueFile: Type.Optional(
        d(
          Name,
          "File inside an approved root that holds the new value; one trailing newline is removed. Give exactly one of valueFile or fromEnv",
        ),
      ),
      fromEnv: Type.Optional(
        d(
          Name,
          "Name of an environment variable of the TestMaster process that holds the new value. Give exactly one of valueFile or fromEnv",
        ),
      ),
    }),
    output: "SecretReference",
  },
  testmaster_save_auth_profile: {
    milestone: "M4",
    input: Obj({
      projectId: Type.Optional(d(id("prj"), "Project id; required to create a profile")),
      profileId: Type.Optional(
        d(id("aup"), "Profile to update; absent: create. Needs expectedVersion"),
      ),
      expectedVersion: Type.Optional(
        d(Version, "Current version of profileId, for optimistic concurrency"),
      ),
      name: Type.Optional(d(Name, "Profile name, unique in the project; required to create")),
      kind: Type.Optional(
        d(
          authContracts.AuthProfileInput.properties.kind,
          "form, basic, bearer, api-key, cookie, oauth, oidc or manual; required to create, never changes",
        ),
      ),
      originBindings: Type.Optional(
        d(
          authContracts.AuthProfileInput.properties.originBindings,
          "Origins the profile may authenticate against; every environment that uses it must target one of them",
        ),
      ),
      secrets: Type.Optional(
        d(
          authContracts.AuthProfileInput.properties.secrets,
          "Role to secret id (testmaster_set_secret): form password, totpSeed (username too when it is a secret); basic password; bearer token; api-key key; cookie cookie. Every role except username must be a secret; a plain value is refused",
        ),
      ),
      username: Type.Optional(
        d(
          AuthPlainUsername,
          "Username as a plain value (form, basic, oauth, oidc): stored and shown as written and NOT masked in evidence, so a username like root stays readable in DOM and logs. Use secrets.username instead to mask it (an e-mail, for example). Never both. On update, setting it replaces secrets.username",
        ),
      ),
      config: Type.Optional(
        d(
          AuthConfigInput,
          "Keys of the kind: form {http|browser}; basic, bearer, api-key, cookie: {} (header optional for the last three); oauth/oidc adapter, issuer, clientId, scopes, allowedScopes, redirectUris, redirectUri; manual challenge. Each key names its kinds",
        ),
      ),
      refreshPolicy: Type.Optional(
        d(
          Type.Partial(authContracts.AuthRefreshPolicy),
          "Session refresh limits; absent fields keep their defaults",
        ),
      ),
    }),
    output: "AuthProfileView",
  },
  testmaster_update_environment: {
    milestone: "M1",
    input: Obj({
      environmentId: d(id("env"), "Environment to change"),
      expectedVersion: d(Version, "Current version of the environment, for optimistic concurrency"),
      name: Type.Optional(d(Name, "New name, unique in the project")),
      baseUrl: Type.Optional(
        d(Type.String({ format: "uri", maxLength: 2048 }), "New target URL of the application"),
      ),
      networkProfile: Type.Optional(
        d(Enum(["public", "private", "local-loopback"]), "Network profile of the target"),
      ),
      locale: Type.Optional(d(Name, "Browser locale, e.g. en-US")),
      timezone: Type.Optional(d(Name, "Browser timezone, e.g. UTC")),
      production: Type.Optional(d(Type.Boolean(), "Mark the environment as production")),
      additionalOrigins: Type.Optional(
        d(
          Type.Array(Type.String({ format: "uri" }), { maxItems: 32 }),
          "Exact extra origins page subrequests may reach; replaces the list, [] clears it. They never receive credentials",
        ),
      ),
      ignoredOrigins: Type.Optional(
        d(
          Type.Array(Type.String({ format: "uri" }), { maxItems: 32 }),
          "Exact origins whose requests are aborted and recorded without failing the run; replaces the list, [] clears it. Never reached",
        ),
      ),
      authRefs: Type.Optional(
        d(
          Type.Array(id("aup"), { maxItems: 16 }),
          "Auth profiles bound to the environment; replaces the list. Each must be bound to the target origin",
        ),
      ),
      serverLog: Type.Optional(
        d(
          Type.Union([ServerLogSource, Type.Null()]),
          "Opt-in docker container of the application server; its log lines during each attempt become logs/server.log. null stops reading it",
        ),
      ),
    }),
    output: "McpEnvironmentUpdate",
  },
  testmaster_test_auth_login: {
    milestone: "M4",
    input: Obj({
      profileId: d(id("aup"), "Auth profile to sign in with"),
      environmentId: d(
        id("env"),
        "Environment the login targets; the profile must be bound to it (testmaster_update_environment authRefs)",
      ),
    }),
    output: "AuthTestLoginReceipt",
  },
} as const;
export const mcpToolCatalog = Object.entries(mcpTools).map(([name, tool]) => ({
  name,
  milestone: tool.milestone,
  inputSchema: `Mcp_${name}`,
  outputSchema: tool.output,
  enabled: true,
  disabledReason: null,
}));
