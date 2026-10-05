import { type TSchema, Type } from "@sinclair/typebox";
import { Description, Enum, id, Json, Name, Obj, Version } from "./primitives.js";
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
export interface RouteDefinition {
  method: string;
  path: string;
  scope: string;
  milestone: Milestone;
  requestSchema: string;
  responseSchema: string;
}
const routeRows: ReadonlyArray<readonly [string, string, string, Milestone, string?, string?]> = [
  ["GET", "/health/live", "public", "M1", "Empty", "Health"],
  ["GET", "/health/ready", "ops:R", "M1", "Empty", "Health"],
  ["GET", "/capabilities", "meta:R", "M1", "Empty", "CapabilityManifest"],
  ["GET", "/me", "identity:R", "M4", "Empty", "Principal"],
  ["GET,POST", "/workspaces", "workspace:R/A", "M4", "WorkspaceInput", "Workspace"],
  ["GET,PATCH", "/workspaces/{id}", "workspace:R/A", "M4", "WorkspaceInput", "Workspace"],
  ["GET,POST", "/workspaces/{id}/members", "members:A", "M4", "MembershipInput", "Membership"],
  [
    "PATCH,DELETE",
    "/workspaces/{id}/members/{memberId}",
    "members:A",
    "M4",
    "MembershipInput",
    "Membership",
  ],
  ["GET,POST", "/tokens", "tokens:A", "M4", "TokenInput", "TokenMetadata"],
  ["DELETE", "/tokens/{id}", "tokens:A", "M4", "Empty", "TokenMetadata"],
  ["GET,POST", "/projects", "projects:R/W", "M1", "ProjectInput", "Project"],
  ["GET,PATCH", "/projects/{id}", "projects:R/W", "M1", "ProjectInput", "Project"],
  ["POST", "/projects/{id}/archive", "projects:W", "M1", "Empty", "Project"],
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
  ["POST", "/secrets/{id}/rotate", "secrets:W", "M4", "SecretInput", "SecretReference"],
  ["DELETE", "/secrets/{id}", "secrets:W", "M1", "Empty", "SecretReference"],
  ["GET,POST", "/auth-profiles", "env:R/W", "M4", "AuthProfile", "AuthProfile"],
  ["PATCH", "/auth-profiles/{id}", "env:W", "M4", "AuthProfile", "AuthProfile"],
  ["POST", "/uploads", "sources:W", "M2", "UploadRequest", "UploadReceipt"],
  ["PUT", "/uploads/{id}/bytes", "upload token", "M2", "Binary", "UploadReceipt"],
  ["POST", "/uploads/{id}/complete", "sources:W", "M2", "Empty", "UploadReceipt"],
  ["GET,POST", "/projects/{id}/sources", "sources:R/W", "M2", "SourceInput", "SourceRevision"],
  ["GET,DELETE", "/sources/{id}", "sources:R/W", "M2", "Empty", "Source"],
  ["POST", "/projects/{id}/discovery", "discovery:X", "M2", "DiscoveryRequest", "DiscoveryJob"],
  ["GET", "/discovery/{id}", "discovery:R", "M2", "Empty", "DiscoveryResult"],
  ["POST", "/discovery/{id}/retry", "discovery:X", "M2", "DiscoveryRetryInput", "DiscoveryJob"],
  ["POST", "/discovery/{id}/cancel", "discovery:X", "M2", "Empty", "DiscoveryJob"],
  [
    "GET,PATCH",
    "/projects/{id}/requirements",
    "plans:R/W",
    "M2",
    "RequirementsInput",
    "Requirement",
  ],
  ["POST", "/projects/{id}/proposal-batches", "plans:W", "M2", "GenerationInput", "ProposalBatch"],
  ["GET", "/proposal-batches/{id}", "plans:R", "M2", "Empty", "ProposalBatch"],
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
  ["GET,PATCH,DELETE", "/tests/{id}", "tests:R/W", "M1", "TestMetadataInput", "TestCase"],
  ["GET,POST", "/tests/{id}/revisions", "tests:R/W", "M1", "TestRevisionInput", "TestRevision"],
  ["POST", "/tests/{id}/promote", "tests:W", "M2", "PromoteInput", "TestCase"],
  ["GET", "/revisions/{id}/code", "tests:R", "M2", "Empty", "CodeReference"],
  ["POST", "/runs", "runs:X", "M1", "RunRequest", "RunReceipt"],
  ["GET", "/runs", "runs:R", "M1", "Empty", "RunResult"],
  ["GET", "/runs/{id}", "runs:R", "M1", "Empty", "RunResult"],
  ["POST", "/runs/{id}/cancel", "runs:X", "M1", "CancelInput", "CancelReceipt"],
  ["POST", "/runs/{id}/rerun", "runs:X", "M1", "RerunInput", "RunReceipt"],
  ["GET", "/runs/{id}/steps", "runs:R", "M1", "Empty", "StepResult"],
  ["GET", "/runs/{id}/events", "runs:R", "M1", "Empty", "Event"],
  ["GET", "/runs/{id}/bundle", "artifacts:R", "M1", "Empty", "ArtifactManifest"],
  ["GET", "/artifacts/{id}", "artifacts:R", "M1", "Empty", "Binary"],
  ["GET,POST", "/runs/{id}/analysis", "runs:R/analysis:X", "M3", "BudgetInput", "Analysis"],
  ["POST", "/runs/{id}/healing-proposals", "healing:W", "M3", "BudgetInput", "HealingProposal"],
  [
    "POST",
    "/healing-proposals/{id}/approve",
    "healing:approve",
    "M3",
    "ExpectedVersionInput",
    "HealingProposal",
  ],
  [
    "POST",
    "/healing-proposals/{id}/reject",
    "healing:approve",
    "M3",
    "CancelInput",
    "HealingProposal",
  ],
  ["POST", "/run-comparisons", "runs:R", "M3", "RunComparisonRequest", "ComparisonResult"],
  ["POST", "/batch-comparisons", "runs:R", "M3", "BatchComparisonRequest", "ComparisonResult"],
  ["POST", "/flake-studies", "runs:X", "M3", "FlakeStudyInput", "BatchReceipt"],
  ["POST", "/batches", "runs:X", "M1", "BatchRequest", "BatchReceipt"],
  ["GET", "/batches/{id}", "runs:R", "M1", "Empty", "BatchReceipt"],
  ["POST", "/batches/{id}/cancel", "runs:X", "M1", "CancelInput", "BatchCancelReceipt"],
  ["GET,POST", "/suites", "suites:R/W", "M4", "Suite", "Suite"],
  ["GET,PATCH,DELETE", "/suites/{id}", "suites:R/W", "M4", "Suite", "Suite"],
  ["POST", "/suites/{id}/runs", "runs:X", "M4", "BatchRequest", "BatchReceipt"],
  ["GET,POST", "/schedules", "schedules:R/W", "M4", "Schedule", "Schedule"],
  ["GET,PATCH,DELETE", "/schedules/{id}", "schedules:R/W", "M4", "Schedule", "Schedule"],
  ["GET", "/schedules/{id}/firings", "schedules:R", "M4", "Empty", "ScheduledFire"],
  ["GET", "/resources", "runs:R", "M2", "Empty", "ResourceRecord"],
  ["POST", "/resources/{id}/cleanup", "cleanup:X", "M2", "CleanupInput", "ResourceRecord"],
  ["GET,POST", "/tunnels", "tunnel:X", "M5", "TunnelInput", "TunnelMetadata"],
  ["DELETE", "/tunnels/{id}", "tunnel:X", "M5", "Empty", "TunnelMetadata"],
  ["GET,POST", "/workers", "workers:A", "M4", "Worker", "Worker"],
  ["POST", "/workers/{id}/heartbeat", "worker:X", "M4", "HeartbeatInput", "Worker"],
  ["GET", "/usage", "usage:R", "M2", "Empty", "UsageEntry"],
  ["GET", "/audit-events", "audit:R", "M4", "Empty", "AuditEvent"],
  ["POST", "/integrations/{provider}/webhooks", "signature", "M4", "IntegrationEvent", "Delivery"],
  ["GET,POST", "/integrations", "integrations:A", "M4", "IntegrationInput", "IntegrationMetadata"],
  [
    "PATCH",
    "/integrations/{id}",
    "integrations:A",
    "M4",
    "IntegrationInput",
    "IntegrationMetadata",
  ],
  ["POST", "/exports", "portability:R", "M6", "PortabilityInput", "OperationReceipt"],
  ["POST", "/imports", "portability:W", "M6", "PortabilityInput", "OperationReceipt"],
  ...["login", "logout", "recovery"].map(
    (path) =>
      ["POST", `/identity/${path}`, "identity", "M4", "IdentityInput", "IdentityReceipt"] as const,
  ),
  ["GET", "/identity/sessions", "identity:R", "M4", "Empty", "SessionMetadata"],
  ["DELETE", "/identity/sessions/{id}", "identity:W", "M4", "Empty", "SessionMetadata"],
  ["POST", "/identity/break-glass", "identity:A", "M6", "IdentityInput", "IdentityReceipt"],
  ["POST", "/auth-profiles/{id}/test-login", "env:X", "M4", "AuthProfile", "OperationReceipt"],
  ["POST", "/auth-profiles/{id}/export-state", "secrets:export", "M4", "Empty", "OperationReceipt"],
  ["POST", "/auth-checkpoints", "worker:X", "M4", "AuthCheckpoint", "AuthCheckpoint"],
  ["GET", "/auth-checkpoints/{id}", "env:R", "M4", "Empty", "AuthCheckpoint"],
  ...["continue", "cancel"].map(
    (path) =>
      [
        "POST",
        `/auth-checkpoints/{id}/${path}`,
        "env:X",
        "M4",
        "AuthContinueInput",
        "OperationReceipt",
      ] as const,
  ),
  ["GET,POST", "/approvals", "approvals:R/W", "M1", "Approval", "Approval"],
  ["POST", "/approvals/{id}/revoke", "approvals:W", "M1", "Empty", "Approval"],
  ["DELETE", "/artifacts/{id}", "artifacts:delete", "M4", "Empty", "DeletionOperation"],
  ["GET", "/deletion-operations/{id}", "deletion:R", "M4", "Empty", "DeletionOperation"],
  ...["drain", "revoke"].map(
    (path) => ["POST", `/workers/{id}/${path}`, "workers:A", "M4", "Empty", "Worker"] as const,
  ),
  ["GET", "/deliveries", "integrations:R", "M4", "Empty", "Delivery"],
  ["GET", "/deliveries/{id}", "integrations:R", "M4", "Empty", "Delivery"],
  ["POST", "/deliveries/{id}/retry", "integrations:W", "M4", "Empty", "Delivery"],
  ["GET", "/operations", "ops:R", "M4", "Empty", "OperationReceipt"],
  ["GET", "/operations/{id}", "ops:R", "M4", "Empty", "OperationReceipt"],
  ["POST", "/operations/admission", "ops:A", "M4", "AdmissionInput", "OperationReceipt"],
  ["POST", "/operations/reconcile", "ops:A", "M4", "ReconcileInput", "OperationReceipt"],
  ["POST", "/operations/backups", "ops:A", "M4", "BackupInput", "OperationReceipt"],
  ["POST", "/operations/restores", "ops:A", "M4", "RestoreRequest", "OperationReceipt"],
  ["GET,POST", "/projects/{id}/memory", "memory:R/W", "M5", "MemoryEntry", "MemoryEntry"],
  ["PATCH,DELETE", "/memory/{id}", "memory:W", "M5", "MemoryEntry", "MemoryEntry"],
  ["GET,POST", "/visual-baselines", "tests:R/W", "M5", "VisualBaseline", "VisualBaseline"],
  [
    "POST",
    "/visual-baselines/{id}/approve",
    "tests:approve",
    "M5",
    "ExpectedVersionInput",
    "VisualBaseline",
  ],
];
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
      if (path === "/runs/{id}/analysis")
        resolvedScope = method === "GET" ? "runs:R" : "analysis:X";
      return {
        method,
        path,
        scope: resolvedScope,
        milestone,
        requestSchema: method === "GET" || method === "DELETE" ? "Empty" : requestSchema,
        responseSchema,
      };
    }),
);
export const mcpTools = {
  testmaster_capabilities: { milestone: "M1", input: Obj({}), output: "CapabilityManifest" },
  testmaster_bootstrap: {
    milestone: "M2",
    input: Obj({ projectRoot: Name, target: Name, scope: Type.Array(Name), mode: Name }),
    output: "BootstrapReceipt",
  },
  testmaster_analyze_code: {
    milestone: "M2",
    input: Obj({
      projectId: id("prj"),
      root: Name,
      base: Type.Optional(Name),
      head: Type.Optional(Name),
      dirty: Type.Optional(Type.Boolean()),
    }),
    output: "CodeSnapshot",
  },
  testmaster_normalize_requirements: {
    milestone: "M2",
    input: Obj({ projectId: id("prj"), sourceRevisionIds: Type.Array(id("svr")) }),
    output: "RequirementSnapshot",
  },
  testmaster_explore: {
    milestone: "M2",
    input: Obj({
      projectId: id("prj"),
      envId: id("env"),
      featureIds: Type.Array(id("fea")),
      budget: Json,
    }),
    output: "DiscoveryJob",
  },
  testmaster_generate_plan: {
    milestone: "M2",
    input: Obj({
      projectId: id("prj"),
      sourceSnapshotId: Name,
      type: Enum(["frontend", "backend", "integration"]),
      budget: Json,
    }),
    output: "ProposalBatch",
  },
  testmaster_review_plan: {
    milestone: "M2",
    input: Obj({
      batchId: id("pbt"),
      expectedVersion: Version,
      acceptIds: Type.Array(id("pro")),
      rejectIds: Type.Array(id("pro")),
    }),
    output: "ProposalDecisionReceipt",
  },
  testmaster_generate_tests: {
    milestone: "M2",
    input: Obj({
      proposalIds: Type.Optional(Type.Array(id("pro"))),
      revisionIds: Type.Optional(Type.Array(id("rev"))),
      budget: Json,
    }),
    output: "GeneratedTestsReceipt",
  },
  testmaster_run_tests: {
    milestone: "M1",
    input: Obj({
      testIds: Type.Optional(Type.Array(id("tst"))),
      suiteId: Type.Optional(id("sui")),
      environmentId: id("env"),
      mode: Name,
      limits: Type.Optional(Json),
    }),
    output: "BatchReceipt",
  },
  testmaster_get_run: { milestone: "M1", input: Obj({ runId: id("run") }), output: "RunResult" },
  testmaster_get_evidence: {
    milestone: "M1",
    input: Obj({
      runId: id("run"),
      attemptId: Type.Optional(id("att")),
      failedOnly: Type.Optional(Type.Boolean()),
      maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 67108864 })),
    }),
    output: "EvidenceSummary",
  },
  testmaster_cancel_run: {
    milestone: "M1",
    input: Obj({ runId: id("run"), reason: Description }),
    output: "CancelReceipt",
  },
  testmaster_compare_runs: {
    milestone: "M3",
    input: Obj({ left: id("run"), right: id("run") }),
    output: "ComparisonResult",
  },
  testmaster_propose_healing: {
    milestone: "M3",
    input: Obj({ failedRunId: id("run"), budget: Json }),
    output: "HealingProposal",
  },
  testmaster_approve_healing: {
    milestone: "M3",
    input: Obj({ proposalId: id("hea"), expectedVersion: Version }),
    output: "HealingProposal",
  },
  testmaster_open_report: {
    milestone: "M1",
    input: Obj({ runId: id("run") }),
    output: "ReportLocation",
  },
} as const;
export const mcpToolCatalog = Object.entries(mcpTools).map(([name, tool]) => ({
  name,
  milestone: tool.milestone,
  inputSchema: `Mcp_${name}`,
  outputSchema: tool.output,
  enabled: tool.milestone !== "M3",
  disabledReason: tool.milestone === "M3" ? "Available in M3" : null,
}));
