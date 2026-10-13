import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { ContentDigest, Enum, id, Name, Obj, Timestamp, Version } from "../primitives.js";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
/**
 * Who acted, as the audit trail presents it (UX-050). `human` is a person's principal, `agent` a
 * service-account principal (automation and AI agents), `integration` an inbound provider label,
 * `system` a workspace controller principal and `unauthenticated` a pre-identity attempt.
 */
export const auditActorKinds = [
  "human",
  "agent",
  "integration",
  "system",
  "unauthenticated",
] as const;
export type AuditActorKind = (typeof auditActorKinds)[number];
/** `recorded` is an event whose action name carries no outcome suffix (a completed change). */
export const auditOutcomes = ["allowed", "denied", "requested", "recorded"] as const;
export type AuditOutcome = (typeof auditOutcomes)[number];

export const auditContracts = {
  /** One audit row with no payload: hashes only, never a request body or a secret value. */
  AuditEntry: Obj({
    id: id("aud"),
    createdAt: Timestamp,
    actor: Obj({ id: Name, kind: Enum(auditActorKinds), displayName: nullable(Name) }),
    operation: Name,
    outcome: Enum(auditOutcomes),
    scope: Obj({ resourceType: Name, resourceId: Name }),
    correlationId: Name,
    beforeHash: nullable(ContentDigest),
    afterHash: nullable(ContentDigest),
  }),
  /** Per-project approval policy (SEC-039). Absent policy means one approver and no separation. */
  ApprovalPolicy: Obj({
    projectId: id("prj"),
    requiredApprovers: Type.Union([Type.Literal(1), Type.Literal(2)]),
    separationOfDuties: Type.Boolean(),
    version: Version,
    updatedAt: nullable(Timestamp),
    updatedBy: nullable(Name),
  }),
  ApprovalPolicyInput: Obj({
    requiredApprovers: Type.Union([Type.Literal(1), Type.Literal(2)]),
    separationOfDuties: Type.Boolean(),
  }),
};
export type AuditEntry = Static<typeof auditContracts.AuditEntry>;
export type ApprovalPolicy = Static<typeof auditContracts.ApprovalPolicy>;
export type ApprovalPolicyInput = Static<typeof auditContracts.ApprovalPolicyInput>;
