import { type Static, type TSchema, Type } from "@sinclair/typebox";
import {
  ContentDigest,
  DecisionReason,
  Description,
  Enum,
  id,
  Name,
  Nonnegative,
  Obj,
  Timestamp,
  Version,
} from "../primitives.js";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const names = Type.Array(Name);
const RevisionStatus = Enum(["ready", "partial", "needs_input", "invalid"]);
/** Location of a span inside a source revision; mirrors the optional fields of an EvidenceRef. */
const SpanLocation = Obj({
  relativePath: Type.Optional(Type.String({ maxLength: 1024 })),
  offset: Type.Optional(Nonnegative),
  length: Type.Optional(Nonnegative),
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  jsonPointer: Type.Optional(Type.String({ maxLength: 2048 })),
});
const Excerpt = Type.String({ maxLength: 600 });

const SourceOverview = Obj({
  ownerId: nullable(Name),
  revisionCount: Type.Integer({ minimum: 1 }),
  active: Obj({
    id: id("svr"),
    ordinal: Version,
    contentHash: ContentDigest,
    mediaType: Name,
    sizeBytes: Nonnegative,
    parserVersion: Name,
    status: RevisionStatus,
    importedAt: nullable(Timestamp),
    importedBy: nullable(Name),
  }),
  /** Where the bytes came from and whether that origin still matches the active revision. */
  origin: Obj({
    kind: Enum(["local-file", "upload", "tracker"]),
    path: nullable(Type.String({ maxLength: 1024 })),
    state: Enum(["unchanged", "changed", "missing", "upload", "remote"]),
  }),
  dependents: Obj({
    /** Active tests that may rest on something the newest revision changed or removed. */
    staleTests: Nonnegative,
    /** Requirement evidence still pointing at a superseded revision of this source. */
    supersededRequirementRefs: Nonnegative,
  }),
  diagnostics: Nonnegative,
  processedChunks: Nonnegative,
});

const RevisionView = Obj({
  id: id("svr"),
  ordinal: Version,
  parentId: nullable(id("svr")),
  contentHash: ContentDigest,
  mediaType: Name,
  sizeBytes: Nonnegative,
  parserVersion: Name,
  status: RevisionStatus,
  active: Type.Boolean(),
  importedAt: nullable(Timestamp),
  importedBy: nullable(Name),
  chunkCount: Nonnegative,
  chunksTruncated: Type.Boolean(),
  chunks: Type.Array(
    Obj({
      hash: ContentDigest,
      kind: Name,
      text: Type.String({ maxLength: 2000 }),
      textTruncated: Type.Boolean(),
      ref: SpanLocation,
      requirementLike: Type.Boolean(),
    }),
    { maxItems: 200 },
  ),
  diagnosticCount: Nonnegative,
  diagnostics: Type.Array(
    Obj({ code: Name, message: Type.String({ maxLength: 1000 }), location: nullable(Name) }),
    { maxItems: 50 },
  ),
  operationCount: nullable(Nonnegative),
  /** Against the parent revision; `null` for the first revision. Nothing is deleted by an update. */
  changes: nullable(
    Obj({
      comparedTo: id("svr"),
      operations: Obj({ added: names, removed: names, changed: names }),
      chunksAdded: Nonnegative,
      chunksRemoved: Nonnegative,
    }),
  ),
});

const Origin = Obj({
  sourceRevisionId: id("svr"),
  sourceId: nullable(id("src")),
  sourceName: nullable(Name),
  revisionOrdinal: nullable(Version),
  /** True when this is the source's active revision; false means the evidence is superseded. */
  current: Type.Boolean(),
  revisionHash: nullable(ContentDigest),
  /** Hash of the cited span as it was when the requirement was written; `null` for legacy evidence. */
  spanHash: nullable(ContentDigest),
  ref: SpanLocation,
  /** Bounded plain text of the span, or `null` when the span is no longer in the stored revision. */
  excerpt: nullable(Excerpt),
});

const RequirementChange = Obj({
  at: Timestamp,
  kind: Enum([
    "requirement_added",
    "requirement_removed",
    "interpretation_changed",
    "edited",
    "approved",
    "rejected",
    "approval_reset",
    "conflict_decided",
    "normalized",
  ]),
  actorId: Name,
  requirementId: nullable(id("req")),
  requirementKey: nullable(Name),
  before: nullable(Type.String({ maxLength: 2000 })),
  after: nullable(Type.String({ maxLength: 2000 })),
  note: nullable(Type.String({ maxLength: 500 })),
  sourceRevisionIds: Type.Array(id("svr"), { maxItems: 50 }),
});

const FeatureEvidence = Obj({
  runId: id("run"),
  testId: id("tst"),
  revisionId: id("rev"),
  status: Name,
  outcome: nullable(Name),
  /** Only a Run that reached a verdict (passed or failed) counts as evidence; blocked or inconclusive never does. */
  valid: Type.Boolean(),
  createdAt: Timestamp,
});

export const sourceInsightContracts = {
  SourceOverview,
  SourceListItem: Obj({
    id: id("src"),
    projectId: id("prj"),
    role: Name,
    displayName: Name,
    origin: Name,
    activeRevisionId: nullable(id("svr")),
    version: Version,
    createdAt: Timestamp,
    overview: SourceOverview,
  }),
  SourceHistory: Obj({
    id: id("src"),
    version: Version,
    projectId: id("prj"),
    role: Name,
    displayName: Name,
    createdAt: Timestamp,
    archivedAt: nullable(Timestamp),
    overview: SourceOverview,
    exclusions: Obj({
      /** Files the intake refuses outright: credentials, VCS data and dependency trees. */
      policy: names,
      /** Parts of this source the parser recorded but does not interpret. */
      unsupported: names,
      /** Exclusions of the latest code discovery of the project. */
      discovery: names,
    }),
    revisions: Type.Array(RevisionView, { maxItems: 200 }),
    staleTests: Type.Array(
      Obj({
        testId: id("tst"),
        name: Name,
        revisionId: id("rev"),
        reasons: Type.Array(Name, { minItems: 1 }),
      }),
      { maxItems: 200 },
    ),
  }),
  DiscoverySummary: Obj({
    id: id("dsc"),
    createdAt: Timestamp,
    projectId: id("prj"),
    phase: Name,
    scope: Enum(["codebase", "diff"]),
    baseSha: nullable(Name),
    headSha: nullable(Name),
    includesWorkingTree: Type.Boolean(),
    status: Enum(["partial", "needs_input", "unreachable"]),
    counts: Obj({
      scannedFiles: Nonnegative,
      skippedFiles: Nonnegative,
      endpoints: Nonnegative,
      routes: Nonnegative,
      features: Nonnegative,
      warnings: Nonnegative,
    }),
    sourceRevisionIds: Type.Array(id("svr")),
  }),
  NormalizationInput: Obj({
    sourceRevisionIds: Type.Array(id("svr"), { minItems: 1, maxItems: 20, uniqueItems: true }),
    provider: Type.Optional(Name),
    model: Type.Optional(Name),
  }),
  ConflictDecisionInput: Obj({
    conflictId: Name,
    selectedRequirementId: id("req"),
    reason: Type.String({ minLength: 1, maxLength: 2000 }),
    expectedVersion: Type.Integer({ minimum: 0 }),
  }),
  /** A reviewer's decision that a requirement is out of scope; the reason is mandatory. */
  RequirementRejectionInput: Obj({
    reason: Type.String({ minLength: 1, maxLength: 2000 }),
  }),
  /** A reviewer's approval of a requirement; the reason is optional. */
  RequirementApprovalInput: Obj({
    reason: Type.Optional(DecisionReason),
  }),
  RequirementReview: Obj({
    id: id("prj"),
    projectId: id("prj"),
    /** Snapshot version; also the ETag, and what a conflict decision must echo. */
    version: Nonnegative,
    fingerprint: Type.String({ maxLength: 128 }),
    requirements: Type.Array(
      Obj({
        id: id("req"),
        version: Version,
        key: nullable(Name),
        text: Description,
        acceptanceCriteria: Type.Array(Description),
        originKind: Enum(["explicit", "user_spec", "inferred", "observed"]),
        confidence: nullable(Type.Number({ minimum: 0, maximum: 1 })),
        approval: nullable(id("apr")),
        /** Set when a reviewer rejected the requirement: it is not pending and is never planned. */
        rejection: nullable(
          Obj({ reason: Type.String({ maxLength: 2000 }), actorId: Name, rejectedAt: Timestamp }),
        ),
        /** The reason given with the latest approval or edit; null when that decision gave none. */
        decision: nullable(
          Obj({
            action: Enum(["approved", "edited"]),
            reason: DecisionReason,
            actorId: Name,
            decidedAt: Timestamp,
          }),
        ),
        reason: nullable(Description),
        origins: Type.Array(Origin, { maxItems: 50 }),
        conflictIds: names,
        /** At least one origin points at a superseded source revision. */
        supersededOrigin: Type.Boolean(),
      }),
    ),
    conflicts: Type.Array(
      Obj({
        id: Name,
        reason: Description,
        requirementIds: Type.Array(id("req")),
        origins: Type.Array(Origin, { maxItems: 50 }),
        resolution: nullable(
          Obj({ selectedRequirementId: id("req"), reason: Description, actorId: Name }),
        ),
      }),
    ),
    openQuestions: Type.Array(Description),
    changes: Type.Array(RequirementChange, { maxItems: 100 }),
  }),
  FeatureCoverageMap: Obj({
    id: id("prj"),
    projectId: id("prj"),
    generatedAt: Timestamp,
    discovery: nullable(
      Obj({
        id: id("dsc"),
        createdAt: Timestamp,
        status: Enum(["partial", "needs_input", "unreachable"]),
        scope: Enum(["codebase", "diff"]),
        baseSha: nullable(Name),
        headSha: nullable(Name),
      }),
    ),
    rows: Type.Array(
      Obj({
        key: Name,
        kind: Enum(["requirement", "endpoint", "route", "desired"]),
        title: Description,
        requirementIds: Type.Array(id("req")),
        sources: Type.Array(
          Obj({
            sourceId: nullable(id("src")),
            sourceName: nullable(Name),
            revisionId: id("svr"),
            current: Type.Boolean(),
          }),
        ),
        endpoints: names,
        routes: names,
        files: names,
        tests: Type.Array(
          Obj({
            testId: id("tst"),
            name: Name,
            revisionId: id("rev"),
            revisionOrdinal: Version,
            via: Enum(["requirement", "request", "navigation"]),
          }),
        ),
        evidence: Type.Array(FeatureEvidence, { maxItems: 20 }),
        /**
         * `no_tests` and `tests_without_valid_run` are different states and are never rolled into
         * "covered"; only a Run that reached a verdict moves a row to `valid_run`.
         */
        coverage: Enum(["no_tests", "tests_without_valid_run", "valid_run"]),
      }),
      { maxItems: 500 },
    ),
    truncated: Type.Boolean(),
    summary: Obj({
      noTests: Nonnegative,
      testsWithoutValidRun: Nonnegative,
      validRun: Nonnegative,
    }),
    limitations: names,
  }),
};
export type SourceOverview = Static<typeof sourceInsightContracts.SourceOverview>;
export type SourceListItem = Static<typeof sourceInsightContracts.SourceListItem>;
export type SourceHistory = Static<typeof sourceInsightContracts.SourceHistory>;
export type DiscoverySummary = Static<typeof sourceInsightContracts.DiscoverySummary>;
export type NormalizationInput = Static<typeof sourceInsightContracts.NormalizationInput>;
export type ConflictDecisionInput = Static<typeof sourceInsightContracts.ConflictDecisionInput>;
export type RequirementApprovalInput = Static<
  typeof sourceInsightContracts.RequirementApprovalInput
>;
export type RequirementRejectionInput = Static<
  typeof sourceInsightContracts.RequirementRejectionInput
>;
export type RequirementReview = Static<typeof sourceInsightContracts.RequirementReview>;
export type FeatureCoverageMap = Static<typeof sourceInsightContracts.FeatureCoverageMap>;
