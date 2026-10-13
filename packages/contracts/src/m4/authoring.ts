import { type Static, type TSchema, Type } from "@sinclair/typebox";
import * as P from "../primitives.js";

/** Stable reason codes the portal and API clients branch on; every issue also carries a readable message. */
export const planIssueSeverities = ["error", "warning"] as const;
export const planValidationChecks = [
  "structure",
  "sequence",
  "types",
  "references",
  "assertions",
  "dependencies",
  "secrets",
  "permissions",
] as const;
export const revisionChangeKinds = [
  "initial",
  "intent_assertion",
  "operational",
  "source_model",
] as const;
export const revisionStates = ["current", "candidate", "superseded", "accepted"] as const;
export const revisionAuthorships = ["human", "llm", "healing", "import"] as const;

const DraftId = Type.String({ pattern: `^drf_${P.uuidPattern}$` });
const TurnId = Type.String({ pattern: `^rft_${P.uuidPattern}$` });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Pointer = Type.String({ maxLength: 400 });

const PlanIssueSchema = P.Obj({
  severity: P.Enum(planIssueSeverities),
  code: P.Name,
  /** JSON pointer into the submitted plan, "" when the issue concerns the whole plan. */
  field: Pointer,
  stepId: Nullable(P.Name),
  message: P.Description,
});
const Similar = P.Obj({
  kind: P.Enum(["test", "proposal"]),
  id: P.Name,
  name: P.Name,
  /** Share of identical step signatures, 0..1. */
  score: Type.Number({ minimum: 0, maximum: 1 }),
  /** Same runner, same step content and an overlapping requirement: accepting it needs an explicit decision. */
  exactDuplicate: Type.Boolean(),
});
const Counts = P.Obj({
  proposed: P.Nonnegative,
  accepted: P.Nonnegative,
  rejected: P.Nonnegative,
});

export const authoringContracts = {
  ProposalBatchSummary: P.Obj({
    id: P.id("pbt"),
    createdAt: P.Timestamp,
    projectId: P.id("prj"),
    state: P.Enum(["proposed", "accepted", "rejected", "stale"]),
    version: P.Version,
    origin: P.Enum(["generated", "refinement"]),
    /** Set when accepting the batch creates revisions of an existing test instead of new tests. */
    refinesTestId: Nullable(P.id("tst")),
    stale: Type.Boolean(),
    staleReason: Nullable(P.Description),
    counts: Counts,
    modelCallId: Nullable(P.Name),
  }),
  ProposalPreviewInput: P.Obj({
    proposalIds: Type.Array(P.id("pro"), { minItems: 1, maxItems: 200, uniqueItems: true }),
  }),
  ProposalPreview: P.Obj({
    batchId: P.id("pbt"),
    batchVersion: P.Version,
    batchState: P.Enum(["proposed", "accepted", "rejected", "stale"]),
    stale: Type.Boolean(),
    staleReason: Nullable(P.Description),
    policy: P.Obj({
      /** Acceptance is an interactive act by a human principal; automation never inherits it (UX-019). */
      channel: P.Enum(["interactive"]),
      canAccept: Type.Boolean(),
      reason: Nullable(P.Name),
      text: P.Description,
    }),
    items: Type.Array(
      P.Obj({
        proposalId: P.id("pro"),
        state: P.Enum(["proposed", "accepted", "rejected"]),
        selectable: Type.Boolean(),
        validation: P.Obj({
          structural: P.Enum(["valid", "invalid"]),
          semantic: P.Enum(["valid", "invalid"]),
          issues: Type.Array(PlanIssueSchema, { maxItems: 200 }),
        }),
        revision: Nullable(
          P.Obj({
            action: P.Enum(["create_test", "create_revision"]),
            testId: Nullable(P.id("tst")),
            testName: P.Name,
            ordinal: P.Version,
            parentRevisionId: Nullable(P.id("rev")),
            origin: P.Enum(["generated"]),
            runner: P.Enum(["playwright", "http"]),
            type: P.Enum(["frontend", "backend", "integration"]),
            contentHash: P.ContentDigest,
            stepCount: P.Nonnegative,
            assertionCount: P.Nonnegative,
            estimate: P.Obj({
              unit: P.Enum(["seconds"]),
              min: Type.Number({ minimum: 0 }),
              max: Type.Number({ minimum: 0 }),
              reason: P.Description,
            }),
          }),
        ),
        authorship: P.Obj({
          generatedBy: Nullable(P.Name),
          humanEdits: Type.Array(
            P.Obj({ principalId: P.Name, at: P.Timestamp, fromVersion: P.Version }),
            { maxItems: 100 },
          ),
          refinedFrom: Nullable(P.id("pro")),
        }),
        similar: Type.Array(Similar, { maxItems: 20 }),
        needsDecision: Type.Boolean(),
      }),
      { maxItems: 200 },
    ),
    /** True when at least one selected proposal cannot be accepted as submitted. */
    blocked: Type.Boolean(),
  }),
  PlanValidationInput: P.Obj({
    plan: P.Json,
    environmentId: Type.Optional(P.id("env")),
    /** The test being edited; lets dependency checks recognise a cycle through it. */
    testId: Type.Optional(P.id("tst")),
  }),
  PlanValidation: P.Obj({
    valid: Type.Boolean(),
    /** Offered only when every check passed and the caller may execute in the project. */
    runnable: Type.Boolean(),
    issues: Type.Array(PlanIssueSchema, { maxItems: 200 }),
    checked: Type.Array(P.Enum(planValidationChecks)),
  }),
  TestHistoryEntry: P.Obj({
    id: P.id("rev"),
    ordinal: P.Version,
    createdAt: P.Timestamp,
    author: P.Name,
    origin: P.Enum(["manual", "generated", "healed", "imported"]),
    authorship: P.Enum(revisionAuthorships),
    /** A person edited the generated plan before it became this revision. */
    humanEdited: Type.Boolean(),
    parentId: Nullable(P.id("rev")),
    contentHash: P.ContentDigest,
    changeKinds: Type.Array(P.Enum(revisionChangeKinds), { minItems: 1 }),
    assertionChanges: P.Obj({
      added: Type.Array(P.Name, { maxItems: 200 }),
      removed: Type.Array(P.Name, { maxItems: 200 }),
      changed: Type.Array(P.Name, { maxItems: 200 }),
    }),
    operationalChanges: Type.Array(P.Name, { maxItems: 200 }),
    justification: Nullable(P.Description),
    proposalId: Nullable(P.id("pro")),
    healingProposalId: Nullable(P.id("hea")),
    modelCallId: Nullable(P.Name),
    states: Type.Array(P.Enum(revisionStates)),
    promotedAt: Nullable(P.Timestamp),
  }),
  TestDraftInput: P.Obj({
    baseRevisionId: P.id("rev"),
    plan: P.Json,
    /** Required when the principal already has a draft for the test. */
    expectedVersion: Type.Optional(P.Version),
  }),
  TestDraft: P.Obj({
    id: DraftId,
    testId: P.id("tst"),
    projectId: P.id("prj"),
    principalId: P.Name,
    baseRevisionId: P.id("rev"),
    plan: P.Json,
    version: P.Version,
    createdAt: P.Timestamp,
    updatedAt: P.Timestamp,
    /** The test has a newer revision than the one the draft started from. */
    baseSuperseded: Type.Boolean(),
  }),
  RefinementInput: P.Obj({
    message: Type.String({ minLength: 1, maxLength: 4000 }),
    expectedVersion: P.Version,
  }),
  TestRefinementInput: P.Obj({
    message: Type.String({ minLength: 1, maxLength: 4000 }),
    baseRevisionId: P.id("rev"),
  }),
  RefinementThread: P.Obj({
    subject: P.Obj({ kind: P.Enum(["proposal", "test"]), id: P.Name }),
    turns: Type.Array(
      P.Obj({
        id: TurnId,
        seq: P.Version,
        role: P.Enum(["user", "assistant"]),
        content: Type.String({ minLength: 1, maxLength: 8000 }),
        principalId: P.Name,
        createdAt: P.Timestamp,
        proposalId: Nullable(P.id("pro")),
        modelCallId: Nullable(P.Name),
      }),
      { maxItems: 200 },
    ),
    /** The proposal the newest assistant turn produced; reviewing it is the only way a refinement lands. */
    proposal: Nullable(P.Obj({ id: P.id("pro"), batchId: P.id("pbt") })),
  }),
};

export type ProposalBatchSummary = Static<typeof authoringContracts.ProposalBatchSummary>;
export type ProposalPreview = Static<typeof authoringContracts.ProposalPreview>;
export type PlanValidation = Static<typeof authoringContracts.PlanValidation>;
export type PlanIssue = Static<typeof PlanIssueSchema>;
export type TestHistoryEntry = Static<typeof authoringContracts.TestHistoryEntry>;
export type TestDraft = Static<typeof authoringContracts.TestDraft>;
export type RefinementThread = Static<typeof authoringContracts.RefinementThread>;
