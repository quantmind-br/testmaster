// The relational projection is authoritative for constraints; data_json preserves wire fields.
export const tableCatalog = {
  Workspace: { table: "workspaces", fields: ["name", "mode", "settingsVersion", "quotaPolicyId"] },
  Principal: { table: "principals", fields: ["kind", "displayName", "disabledAt"] },
  Membership: { table: "memberships", fields: ["principalId", "role"] },
  Project: { table: "projects", fields: ["name", "slug", "defaultEnvironmentId", "archivedAt"] },
  Environment: {
    table: "environments",
    fields: ["projectId", "name", "activeRevisionId", "archivedAt"],
  },
  EnvironmentRevision: {
    table: "environment_revisions",
    fields: ["environmentId", "networkProfile", "production"],
  },
  SecretReference: {
    table: "secret_references",
    fields: ["provider", "locator", "secretVersion", "revokedAt"],
  },
  AuthProfile: { table: "auth_profiles", fields: ["projectId", "kind"] },
  AuthCheckpoint: {
    table: "auth_checkpoints",
    fields: ["runId", "attemptId", "authProfileId", "state", "expiresAt"],
  },
  Worker: { table: "workers", fields: ["state", "lastHeartbeatAt"] },
  Source: { table: "sources", fields: ["projectId", "activeRevisionId"] },
  SourceRevision: {
    table: "source_revisions",
    fields: ["sourceId", "parentId", "contentHash", "status", "sizeBytes"],
  },
  CodeSnapshot: { table: "code_snapshots", fields: ["projectId", "manifestHash"] },
  Feature: { table: "features", fields: ["projectId", "stableKey"] },
  Requirement: { table: "requirements", fields: ["projectId", "originKind", "approval"] },
  DiscoveryJob: { table: "discovery_jobs", fields: ["projectId", "inputsFingerprint", "phase"] },
  ProposalBatch: { table: "proposal_batches", fields: ["projectId", "state"] },
  Proposal: { table: "proposals", fields: ["batchId", "state"] },
  TestCase: { table: "tests", fields: ["projectId", "name", "activeRevisionId", "archivedAt"] },
  TestRevision: {
    table: "test_revisions",
    fields: [
      "testId",
      "ordinal",
      "parentId",
      "contentHash",
      "runnerKind",
      "origin",
      "codeArtifactId",
    ],
  },
  Suite: { table: "suites", fields: ["name"] },
  BatchRun: { table: "batches", fields: ["requestedCount"] },
  Run: {
    table: "runs",
    fields: [
      "testId",
      "revisionId",
      "environmentRevisionId",
      "batchId",
      "mode",
      "phase",
      "status",
      "outcome",
      "gate",
      "cleanupOutcome",
      "analysisStatus",
    ],
  },
  Attempt: {
    table: "attempts",
    fields: [
      "runId",
      "number",
      "workerId",
      "seed",
      "phase",
      "startedAt",
      "endedAt",
      "outcome",
      "jobId",
      "fence",
      "leaseOwner",
    ],
  },
  StepResult: { table: "steps", fields: ["attemptId", "planStepId", "index", "status"] },
  VariableValue: {
    table: "variables",
    fields: [
      "batchId",
      "producerRunId",
      "producerStepId",
      "name",
      "type",
      "encryptedValueRef",
      "taint",
    ],
  },
  ResourceRecord: { table: "resources", fields: ["creatorAttemptId", "state"] },
  Artifact: {
    table: "artifacts",
    fields: [
      "runId",
      "attemptId",
      "revisionId",
      "snapshotId",
      "hash",
      "bytes",
      "storageKey",
      "state",
      "redactionStatus",
    ],
  },
  Snapshot: {
    table: "snapshots",
    fields: ["runId", "attemptId", "revisionId", "manifestHash", "committedAt"],
  },
  Approval: {
    table: "approvals",
    fields: [
      "actorId",
      "reviewerId",
      "environmentRevisionId",
      "expiresAt",
      "revokedAt",
      "revisionHash",
      "policyHash",
    ],
  },
  AuditEvent: {
    table: "audit_events",
    fields: ["actor", "action", "resourceId", "requestId", "timestamp", "beforeHash", "afterHash"],
  },
  DeletionOperation: { table: "deletion_operations", fields: ["physicalState", "revokedAt"] },
  MemoryEntry: {
    table: "memory_entries",
    fields: ["projectId", "approval", "expiresAt", "tombstoneAt"],
  },
  Evaluation: { table: "evaluations", fields: ["corpusDigest"] },
} as const;
export type EntityKind = keyof typeof tableCatalog;
export const immutableKinds: Partial<Record<EntityKind, true>> = {
  EnvironmentRevision: true,
  SourceRevision: true,
  CodeSnapshot: true,
  TestRevision: true,
  Snapshot: true,
  AuditEvent: true,
};
export function columnName(field: string): string {
  return field === "index"
    ? "step_index"
    : field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
