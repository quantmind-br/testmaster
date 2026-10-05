import type { Static } from "@sinclair/typebox";
import { entities } from "./entities.js";
export const {
  Workspace,
  Principal,
  Membership,
  Project,
  Environment,
  EnvironmentRevision,
  SecretReference,
  Source,
  SourceRevision,
  CodeSnapshot,
  Feature,
  Requirement,
  DiscoveryJob,
  ProposalBatch,
  Proposal,
  TestCase,
  TestRevision,
  Suite,
  BatchRun,
  Run,
  Attempt,
  VariableValue,
  ResourceRecord,
  Artifact,
  Snapshot,
  Analysis,
  HealingProposal,
  Schedule,
  ScheduledFire,
  ModelCall,
  AuditEvent,
  IdempotencyReceipt,
  JobLease,
  OutboxEvent,
  Approval,
  AuthProfile,
  AuthCheckpoint,
  Worker,
  Delivery,
  DeletionOperation,
  MemoryEntry,
  VisualBaseline,
  Evaluation,
} = entities;
export type Workspace = Static<typeof Workspace>;
export type Principal = Static<typeof Principal>;
export type Membership = Static<typeof Membership>;
export type Project = Static<typeof Project>;
export type Environment = Static<typeof Environment>;
export type EnvironmentRevision = Static<typeof EnvironmentRevision>;
export type SecretReference = Static<typeof SecretReference>;
export type Source = Static<typeof Source>;
export type SourceRevision = Static<typeof SourceRevision>;
export type CodeSnapshot = Static<typeof CodeSnapshot>;
export type Feature = Static<typeof Feature>;
export type Requirement = Static<typeof Requirement>;
export type DiscoveryJob = Static<typeof DiscoveryJob>;
export type ProposalBatch = Static<typeof ProposalBatch>;
export type Proposal = Static<typeof Proposal>;
export type TestCase = Static<typeof TestCase>;
export type TestRevision = Static<typeof TestRevision>;
export type Suite = Static<typeof Suite>;
export type BatchRun = Static<typeof BatchRun>;
export type Run = Static<typeof Run>;
export type Attempt = Static<typeof Attempt>;
export type VariableValue = Static<typeof VariableValue>;
export type ResourceRecord = Static<typeof ResourceRecord>;
export type Artifact = Static<typeof Artifact>;
export type Snapshot = Static<typeof Snapshot>;
export type Analysis = Static<typeof Analysis>;
export type HealingProposal = Static<typeof HealingProposal>;
export type Schedule = Static<typeof Schedule>;
export type ScheduledFire = Static<typeof ScheduledFire>;
export type ModelCall = Static<typeof ModelCall>;
export type AuditEvent = Static<typeof AuditEvent>;
export type IdempotencyReceipt = Static<typeof IdempotencyReceipt>;
export type JobLease = Static<typeof JobLease>;
export type OutboxEvent = Static<typeof OutboxEvent>;
export type Approval = Static<typeof Approval>;
export type AuthProfile = Static<typeof AuthProfile>;
export type AuthCheckpoint = Static<typeof AuthCheckpoint>;
export type Worker = Static<typeof Worker>;
export type Delivery = Static<typeof Delivery>;
export type DeletionOperation = Static<typeof DeletionOperation>;
export type MemoryEntry = Static<typeof MemoryEntry>;
export type VisualBaseline = Static<typeof VisualBaseline>;
export type Evaluation = Static<typeof Evaluation>;
