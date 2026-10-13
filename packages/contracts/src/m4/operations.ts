import { type Static, type TSchema, Type } from "@sinclair/typebox";
import * as P from "../primitives.js";

/** Operations, alerts, incidents and SLO reporting of the self-hosted profile (M4-02, OPS-026…036). */
const OperationId = Type.String({ pattern: `^opr_${P.uuidPattern}$` });
const AlertId = Type.String({ pattern: `^alr_${P.uuidPattern}$` });
const IncidentId = Type.String({ pattern: `^inr_${P.uuidPattern}$` });
const IncidentEventId = Type.String({ pattern: `^ine_${P.uuidPattern}$` });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Reason = Type.String({ minLength: 1, maxLength: 2000 });
const SloIndicator = P.Obj({
  id: P.Name,
  title: P.Name,
  unit: P.Enum(["ratio", "seconds"]),
  window: P.Name,
  /** Proposed objective; never a measured value. */
  proposedTarget: nullable(Type.Number()),
  /** Observed value, or null with `measurement: "not_measured"` when nothing was measured. */
  observed: nullable(Type.Number()),
  measurement: P.Enum(["measured", "not_measured"]),
  numerator: nullable(Type.Number()),
  denominator: Type.Number(),
  buckets: Type.Array(P.Obj({ le: Type.Number(), count: P.Nonnegative })),
  errorBudgetRemaining: nullable(Type.Number()),
  notes: P.Description,
});

export const adminOperationKinds = [
  "backup",
  "restore_verify",
  "admission",
  "reconcile",
  "isolation_release",
] as const;
export const adminOperationStates = ["requested", "running", "completed", "failed"] as const;
export const admissionActions = ["pause", "drain", "resume"] as const;
export const alertSeverities = ["critical", "high", "medium"] as const;
export const alertStates = ["firing", "acknowledged", "resolved"] as const;
export const incidentSeverities = ["critical", "high", "medium", "low"] as const;
export const incidentCategories = [
  "isolation_loss",
  "secret_exposure",
  "tenant_exposure",
  "outage",
  "artifact_loss",
  "ai_degradation",
  "other",
] as const;
export const incidentStates = ["open", "mitigated", "resumed", "closed"] as const;

const EvidenceRefInput = P.Obj({
  kind: P.Enum(["audit_event", "artifact", "run", "log", "document", "test"]),
  ref: P.Name,
  sha256: Type.Optional(P.ContentDigest),
});
const Resource = P.Obj({ type: P.Name, id: P.Name });
const IncidentReach = P.Obj({
  scope: P.Enum(["confirmed", "suspected", "unknown"]),
  description: P.Name,
  resources: Type.Array(Resource, { maxItems: 100 }),
});
const IncidentAction = P.Obj({
  description: P.Name,
  verificationCriterion: P.Name,
  owner: P.Name,
  dueAt: Type.Optional(P.Timestamp),
});
const EventBase = {
  at: Type.Optional(P.Timestamp),
  text: Type.String({ minLength: 1, maxLength: 4000 }),
};
export const incidentEventKinds = [
  "timeline",
  "evidence",
  "reach",
  "action",
  "action_verified",
  "communication",
  "status",
] as const;

const IncidentEventView = P.Obj({
  id: IncidentEventId,
  seq: P.Positive,
  kind: P.Enum(incidentEventKinds),
  at: P.Timestamp,
  actor: P.Name,
  text: P.Description,
  data: P.Json,
});

export const operationsContracts = {
  AdminOperation: P.Obj({
    id: OperationId,
    workspaceId: nullable(P.id("ws")),
    kind: P.Enum(adminOperationKinds),
    state: P.Enum(adminOperationStates),
    requestedBy: P.Name,
    reason: P.Description,
    params: P.Json,
    result: P.Json,
    error: nullable(P.Obj({ code: P.Name, message: P.Description })),
    createdAt: P.Timestamp,
    startedAt: nullable(P.Timestamp),
    finishedAt: nullable(P.Timestamp),
    version: P.Version,
  }),
  AdmissionInput: P.Obj({ action: P.Enum(admissionActions), reason: Reason }),
  BackupInput: P.Obj({ reason: Reason }),
  RestoreVerifyInput: P.Obj({ backupId: P.Name, reason: Reason }),
  IsolationReleaseInput: P.Obj({ reason: Reason }),
  OperationsStatus: P.Obj({
    admission: P.Obj({
      state: P.Enum(["enabled", "paused", "draining"]),
      reason: nullable(P.Description),
      changedBy: nullable(P.Name),
      changedAt: nullable(P.Timestamp),
    }),
    globalAdmission: P.Name,
    isolation: P.Obj({ isolated: Type.Boolean(), review: nullable(P.Name) }),
    work: P.Obj({
      activeRuns: P.Nonnegative,
      queuedJobs: P.Nonnegative,
      drained: Type.Boolean(),
    }),
    backup: P.Obj({
      configured: Type.Boolean(),
      schedule: nullable(P.Name),
      lastSuccessAt: nullable(P.Timestamp),
      lastFailureAt: nullable(P.Timestamp),
    }),
    retention: P.Obj({
      lastRunAt: nullable(P.Timestamp),
      metadataWindowDays: P.Positive,
      auditWindowDays: P.Positive,
      runsPurged: P.Nonnegative,
      auditEventsPurged: P.Nonnegative,
      auditSummaries: P.Nonnegative,
    }),
  }),
  DlqEntry: P.Obj({
    source: P.Name,
    id: P.Name,
    state: P.Name,
    attempts: P.Nonnegative,
    lastError: nullable(P.Description),
    createdAt: P.Timestamp,
    subject: P.Name,
  }),
  DlqRequeueInput: P.Obj({ source: P.Name, id: P.Name }),
  AlertRuleView: P.Obj({
    id: P.Name,
    title: P.Name,
    severity: P.Enum(alertSeverities),
    owner: P.Name,
    runbook: P.Name,
    description: P.Description,
    threshold: P.Json,
  }),
  Alert: P.Obj({
    id: AlertId,
    workspaceId: P.id("ws"),
    rule: P.Name,
    subject: Type.String({ maxLength: 200 }),
    severity: P.Enum(alertSeverities),
    state: P.Enum(alertStates),
    summary: P.Description,
    detail: P.Json,
    owner: P.Name,
    runbook: P.Name,
    firstSeenAt: P.Timestamp,
    lastSeenAt: P.Timestamp,
    resolvedAt: nullable(P.Timestamp),
    acknowledgedBy: nullable(P.Name),
    acknowledgedAt: nullable(P.Timestamp),
    createdAt: P.Timestamp,
    version: P.Version,
  }),
  SloIndicator,
  SloReport: P.Obj({
    generatedAt: P.Timestamp,
    workspaceId: P.id("ws"),
    indicators: Type.Array(SloIndicator),
  }),
  MetricsText: Type.String(),
  IncidentInput: P.Obj({
    title: P.Name,
    severity: P.Enum(incidentSeverities),
    category: P.Enum(incidentCategories),
    summary: Type.String({ minLength: 1, maxLength: 4000 }),
    detectedAt: Type.Optional(P.Timestamp),
    versions: Type.Array(P.Name, { maxItems: 50 }),
    resources: Type.Array(Resource, { maxItems: 100 }),
  }),
  IncidentEventInput: Type.Union([
    P.Obj({ kind: Type.Literal("timeline"), ...EventBase }),
    P.Obj({
      kind: Type.Literal("evidence"),
      ...EventBase,
      evidenceRefs: Type.Array(EvidenceRefInput, { minItems: 1, maxItems: 50 }),
    }),
    P.Obj({ kind: Type.Literal("reach"), ...EventBase, reach: IncidentReach }),
    P.Obj({ kind: Type.Literal("action"), ...EventBase, action: IncidentAction }),
    P.Obj({
      kind: Type.Literal("action_verified"),
      ...EventBase,
      actionEventId: IncidentEventId,
      evidenceRefs: Type.Array(EvidenceRefInput, { minItems: 1, maxItems: 50 }),
    }),
    P.Obj({
      kind: Type.Literal("communication"),
      ...EventBase,
      communication: P.Obj({
        state: P.Enum(["none", "private_notified", "public_disclosed"]),
        audience: P.Name,
      }),
    }),
    P.Obj({
      kind: Type.Literal("status"),
      ...EventBase,
      status: P.Enum(["mitigated", "resumed"]),
      gates: Type.Optional(
        P.Obj({
          security: Type.Array(EvidenceRefInput, { maxItems: 50 }),
          consistency: Type.Array(EvidenceRefInput, { maxItems: 50 }),
        }),
      ),
    }),
  ]),
  IncidentCloseInput: P.Obj({
    resolution: Type.String({ minLength: 1, maxLength: 4000 }),
    dataAffected: P.Enum(["confirmed", "suspected", "none_with_evidence", "unknown"]),
    noDataAffectedEvidence: Type.Array(EvidenceRefInput, { maxItems: 50 }),
  }),
  Incident: P.Obj({
    id: IncidentId,
    workspaceId: P.id("ws"),
    title: P.Name,
    severity: P.Enum(incidentSeverities),
    category: P.Enum(incidentCategories),
    summary: P.Description,
    state: P.Enum(incidentStates),
    detectedAt: P.Timestamp,
    versions: Type.Array(P.Name),
    resources: Type.Array(Resource),
    openedBy: P.Name,
    closedAt: nullable(P.Timestamp),
    dataAffected: nullable(P.Enum(["confirmed", "suspected", "none_with_evidence", "unknown"])),
    resolution: nullable(P.Description),
    communication: P.Obj({
      state: P.Enum(["none", "private_notified", "public_disclosed"]),
    }),
    reach: P.Obj({
      confirmed: Type.Array(IncidentReach),
      suspected: Type.Array(IncidentReach),
      unknown: Type.Array(IncidentReach),
    }),
    actions: Type.Array(
      P.Obj({
        eventId: IncidentEventId,
        description: P.Name,
        verificationCriterion: P.Name,
        owner: P.Name,
        verified: Type.Boolean(),
      }),
    ),
    timeline: Type.Array(IncidentEventView),
    createdAt: P.Timestamp,
    version: P.Version,
  }),
};

export type AdminOperation = Static<typeof operationsContracts.AdminOperation>;
export type OperationsStatus = Static<typeof operationsContracts.OperationsStatus>;
export type DlqEntry = Static<typeof operationsContracts.DlqEntry>;
export type AlertView = Static<typeof operationsContracts.Alert>;
export type AlertRuleView = Static<typeof operationsContracts.AlertRuleView>;
export type SloIndicator = Static<typeof operationsContracts.SloIndicator>;
export type IncidentInput = Static<typeof operationsContracts.IncidentInput>;
export type IncidentEventInput = Static<typeof operationsContracts.IncidentEventInput>;
export type IncidentCloseInput = Static<typeof operationsContracts.IncidentCloseInput>;
export type IncidentView = Static<typeof operationsContracts.Incident>;
