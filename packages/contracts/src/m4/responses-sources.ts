import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { entities } from "../entities.js";
import * as P from "../primitives.js";
import { sourceInsightContracts } from "./sources.js";

/*
 * Exact `data` schemas for the source, requirement, discovery and proposal-batch routes. Every field
 * mirrors the code that produces the body (apps/server/src/routes/{core,onboarding,authoring,events}.ts,
 * packages/application/src/ai/{sources,requirements,discovery,proposals}.ts, packages/planner) and what
 * it stores. Entities are returned as stored documents: `workspaceId`, `createdAt` and `version` are
 * always present (optional only in the entity input schemas).
 */

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
/** Free text with no length bound in the producing code. */
const text = Type.String();
const filled = Type.String({ minLength: 1 });
const sha1 = Type.String({ pattern: "^[0-9a-f]{40}$" });
const storedFields = {
  workspaceId: P.id("ws"),
  createdAt: P.Timestamp,
  version: P.Version,
};

// ---------------------------------------------------------------------------------------------
// Sources: POST /projects/{id}/sources, GET /sources/{id}, GET /projects/{id}/sources (item)
// ---------------------------------------------------------------------------------------------

/** `parseSource` (packages/planner/src/sources/parse.ts) maps each format to one media type. */
const SourceMediaType = P.Enum([
  "text/markdown",
  "text/plain",
  "application/json",
  "application/pdf",
  "application/vnd.oai.openapi",
  "application/graphql",
]);
const StoredSource = P.Obj({ ...entities.Source.properties, ...storedFields });
/** The parser's revision (no `createdAt`/`version`: those exist only on the stored SourceRevision row). */
const ParsedSourceRevision = P.Obj({
  id: P.id("svr"),
  workspaceId: P.id("ws"),
  contentHash: P.ContentDigest,
  mediaType: SourceMediaType,
  sizeBytes: P.Nonnegative,
  parserVersion: P.Name,
  status: P.Enum(["ready", "partial", "needs_input", "invalid"]),
  parentId: nullable(P.id("svr")),
  /** The evidence ref of every chunk, in order. */
  chunks: Type.Array(P.EvidenceRef),
});
const SourceChunk = P.Obj({
  id: Type.String({ pattern: "^chunk_[0-9a-f]{64}$" }),
  /** Block kind: mdast node type, `text`, `page`, OpenAPI section, GraphQL definition kind, `request`, … */
  kind: P.Name,
  /** Non-blank by construction (`add` skips blank text); never truncated here. */
  text: filled,
  contentHash: P.ContentDigest,
  evidenceRef: P.EvidenceRef,
  /** Only line-addressed formats (markdown, text, GraphQL). */
  lineStart: Type.Optional(P.Positive),
  lineEnd: Type.Optional(P.Positive),
  requirementLike: Type.Boolean(),
});
const SourceDiagnostic = P.Obj({
  code: filled,
  message: text,
  /** Declared by the type; the parser never sets it. */
  location: Type.Optional(text),
});
/**
 * `inventory` is a per-format record built in `parseSource`; a failed or text-only parse leaves it
 * empty. `operation`, `request`, `script`, `name`, `listen` and `product` are copied verbatim from
 * the uploaded document and are genuinely unconstrained JSON (P.Json).
 */
const SourceInventory = Type.Union([
  /** markdown, text, pdf and any invalid/needs_input parse. */
  P.Obj({}),
  /** openapi */
  P.Obj({
    operations: Type.Array(
      P.Obj({
        path: text,
        method: P.Enum(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "TRACE"]),
        operation: P.Json,
      }),
    ),
    specification: P.Enum(["OpenAPI", "Swagger"]),
  }),
  /** graphql */
  P.Obj({
    operations: Type.Array(
      P.Obj({
        kind: P.Enum(["Query", "Mutation", "Subscription"]),
        /** Absent when the root type declares no fields. */
        fields: Type.Optional(Type.Array(text)),
        supported: Type.Boolean(),
      }),
    ),
  }),
  /** postman */
  P.Obj({
    requests: Type.Array(
      P.Obj({ name: Type.Optional(P.Json), request: P.Json, jsonPointer: text }),
    ),
    scripts: Type.Array(
      P.Obj({
        listen: Type.Optional(P.Json),
        script: Type.Optional(P.Json),
        jsonPointer: text,
        executed: Type.Literal(false),
      }),
    ),
    environmentRefs: Type.Array(filled),
    unsupported: Type.Array(Type.Literal("arbitrary_scripts"), { maxItems: 1 }),
  }),
  /** prd-json */
  P.Obj({ product: P.Json }),
]);

// ---------------------------------------------------------------------------------------------
// Requirements: GET/PATCH /projects/{id}/requirements
// ---------------------------------------------------------------------------------------------

/** A Requirement exactly as the snapshot stores it (`normalize` writes the three extensions). */
const RequirementRecord = P.Obj({
  ...entities.Requirement.properties,
  ...storedFields,
  extensions: P.Obj({
    "testmaster:projectId": P.id("prj"),
    "testmaster:key": Type.Optional(P.Name),
    "testmaster:reason": Type.Optional(P.Description),
  }),
});
const RequirementConflictRecord = P.Obj({
  /** `conflict-<n>`, assigned in creation order. */
  id: P.Name,
  /** Two or more for a model-detected conflict, exactly one for an implementation-inference conflict. */
  requirementIds: Type.Array(P.id("req"), { minItems: 1 }),
  reason: P.Description,
  sourceRefs: Type.Array(P.EvidenceRef, { minItems: 1 }),
  resolution: nullable(
    P.Obj({
      selectedRequirementId: P.id("req"),
      reason: Type.String({ minLength: 1, maxLength: 2000 }),
      actorId: P.Name,
    }),
  ),
});

// ---------------------------------------------------------------------------------------------
// Discovery: POST /projects/{id}/discovery, GET /discovery/{id}, POST /discovery/{id}/retry,
// POST /discovery/{id}/cancel, GET /discovery/{id}/events
// ---------------------------------------------------------------------------------------------

const DiscoveryStatus = P.Enum(["partial", "needs_input", "unreachable"]);
const CodeRef = P.Obj({ path: filled, contentHash: P.ContentDigest, line: P.Positive });
/** Page/route facts: Next.js page files (`GET`) and Node `path === "/x"` comparisons in HTTP server files (`UNKNOWN` unless the same condition compares the method). */
const CodeRoute = P.Obj({
  framework: P.Enum(["node-http", "next"]),
  /** `GET` for Next pages; the compared method for Node comparisons, else `UNKNOWN`. */
  method: filled,
  path: text,
  ref: CodeRef,
});
/**
 * API endpoints: Express calls, Next App Router `route.*` handlers (one per exported HTTP method,
 * naming the exporting binding) and the hardened Python summary (FastAPI/Flask).
 */
const CodeEndpoint = P.Obj({
  framework: P.Enum(["express", "next", "fastapi", "flask"]),
  method: filled,
  path: text,
  handler: Type.Optional(text),
  ref: CodeRef,
});
const CodeSymbol = P.Obj({
  name: text,
  kind: P.Enum(["class", "binding", "function"]),
  ref: CodeRef,
});
const CodeComponent = P.Obj({ name: text, kind: Type.Literal("component"), ref: CodeRef });
const CodeTest = P.Obj({
  name: text,
  kind: P.Enum(["test", "it", "describe", "pytest"]),
  ref: CodeRef,
});
const CodeSkipped = P.Obj({ path: text, reason: filled });
const CodeSummaryView = P.Obj({
  detectorVersion: filled,
  manifestHash: P.ContentDigest,
  coverage: Type.Literal("partial"),
  techStack: Type.Array(
    P.Obj({
      name: P.Enum(["express", "react", "next", "@playwright/test", "vitest"]),
      detectorVersion: filled,
      ref: CodeRef,
    }),
  ),
  entrypoints: Type.Array(CodeRef),
  features: Type.Array(CodeComponent),
  fileRefs: Type.Array(CodeRef),
  routes: Type.Array(CodeRoute),
  endpoints: Type.Array(CodeEndpoint),
  schemas: Type.Array(CodeSymbol),
  externalServices: Type.Array(P.Obj({ url: filled, ref: CodeRef })),
  authPatterns: Type.Array(CodeRef),
  testHooks: Type.Array(P.Obj({ name: filled, ref: CodeRef })),
  existingTests: Type.Array(CodeTest),
  symbols: Type.Array(CodeSymbol),
  imports: Type.Array(P.Obj({ source: filled, ref: CodeRef })),
  /** `path` is empty for run-wide warnings such as `python_unavailable`. */
  warnings: Type.Array(P.Obj({ path: text, code: filled, message: text })),
  scannedFiles: Type.Array(filled),
  skippedFiles: Type.Array(CodeSkipped),
});
/** The stored diff of a diff-scope discovery; `CodeAnalysisReceipt.diff` reuses its fields. */
export const CodeDiffView = P.Obj({
  baseSha: sha1,
  headSha: sha1,
  mergeBase: sha1,
  includeWorkingTree: Type.Boolean(),
  dirtyHash: nullable(P.ContentDigest),
  changes: Type.Array(
    P.Obj({
      /** First letter of the git name-status code (A, M, D, R, C, T, …). */
      status: Type.String({ minLength: 1, maxLength: 1 }),
      path: filled,
      previousPath: Type.Optional(filled),
    }),
  ),
  impact: P.Obj({
    coverage: Type.Literal("partial"),
    criticalSmoke: Type.Boolean(),
    authTouched: Type.Boolean(),
    selectedFiles: Type.Array(filled),
    excludedFiles: Type.Array(CodeSkipped),
    routes: Type.Array(Type.Union([CodeRoute, CodeEndpoint])),
    components: Type.Array(CodeComponent),
    gaps: Type.Array(text),
  }),
  fingerprint: P.ContentDigest,
});
/** `resolveRepositoryProvenance` (packages/application/src/provenance.ts) without claims. */
const RepositoryProvenance = P.Obj({
  repositoryId: nullable(filled),
  commitSha: nullable(sha1),
  checkoutSha: nullable(sha1),
  baseSha: nullable(sha1),
  dirtyHash: nullable(P.ContentDigest),
  deploymentId: nullable(P.Name),
  binding: P.Enum(["verified", "unbound"]),
  bindingSource: Type.Optional(Type.Literal("github-deployment")),
  limitations: Type.Array(
    P.Enum([
      "repository-commit-unavailable",
      "synthetic-merge-checkout-differs-from-assessed-head",
      "working-tree-dirty",
      "untracked-nested-repository-unhashed",
    ]),
  ),
});
const DiscoveryJobView = P.Obj({
  ...entities.DiscoveryJob.properties,
  ...storedFields,
  /** Discovery jobs are created `queued` and only ever become `completed` or `cancelled`. */
  phase: P.Enum(["queued", "completed", "cancelled"]),
  perFeatureResults: Type.Array(
    P.Obj({
      featureId: P.id("fea"),
      status: P.Enum(["partial", "needs_input"]),
      evidenceRefs: Type.Array(P.EvidenceRef),
      errors: Type.Array(P.Name),
    }),
  ),
  usage: P.Obj({ modelCalls: P.Nonnegative, status: DiscoveryStatus }),
});
const DiscoveryFeatureMap = P.Obj({
  projectId: P.id("prj"),
  version: P.Version,
  features: Type.Array(P.Obj({ ...entities.Feature.properties, ...storedFields })),
  sourceRevisionIds: Type.Array(P.id("svr")),
  /** `buildStaticFeatureMap` never returns `ready`. */
  status: P.Enum(["partial", "needs_input"]),
});
const DiscoveryDetail = P.Obj({
  job: DiscoveryJobView,
  codeSnapshot: P.Obj({ ...entities.CodeSnapshot.properties, ...storedFields }),
  summary: CodeSummaryView,
  diff: nullable(CodeDiffView),
  featureMap: DiscoveryFeatureMap,
  status: DiscoveryStatus,
  warnings: Type.Array(text),
  /** Declared optional by `DiscoveryDetail`; every discovery stored by current code has it. */
  repository: Type.Optional(RepositoryProvenance),
});

// ---------------------------------------------------------------------------------------------
// Proposal batches: GET /proposal-batches/{id}
// ---------------------------------------------------------------------------------------------

const ProposalBatchRecord = P.Obj({
  ...entities.ProposalBatch.properties,
  ...storedFields,
  extensions: Type.Optional(
    P.Obj({
      "testmaster:requirementVersion": Type.Optional(P.Nonnegative),
      "testmaster:modelCallId": Type.Optional(P.id("mdl")),
      /** Requirements the model declined because no HTTP or browser plan can observe them. */
      "testmaster:unsupportedRequirements": Type.Optional(
        Type.Array(
          P.Obj({
            requirementId: P.id("req"),
            reason: Type.String({ minLength: 1, maxLength: 500 }),
          }),
        ),
      ),
      /** Proposals refused by the semantic checks in a `partialGeneration` batch; never stored. */
      "testmaster:refusedProposals": Type.Optional(
        Type.Array(
          P.Obj({
            requirementIds: Type.Array(P.id("req")),
            reasonCode: filled,
            message: filled,
            pointers: Type.Optional(Type.Array(text)),
          }),
        ),
      ),
      /** Set only on a batch created by chatting about an existing test. */
      "testmaster:refinesTest": Type.Optional(
        P.Obj({ testId: P.id("tst"), baseRevisionId: P.id("rev") }),
      ),
      /** Why the batch became stale (`source:<svr>` or `code:<csp>`). */
      "testmaster:invalidatedBy": Type.Optional(filled),
    }),
  ),
});
const ProposalRecord = P.Obj({
  ...entities.Proposal.properties,
  ...storedFields,
  extensions: Type.Optional(
    P.Obj({
      "testmaster:authorship": Type.Optional(
        P.Obj({
          kind: Type.Literal("llm"),
          via: Type.Optional(Type.Literal("chat")),
          modelCallId: P.id("mdl"),
        }),
      ),
      "testmaster:edits": Type.Optional(
        Type.Array(P.Obj({ principalId: P.Name, at: P.Timestamp, fromVersion: P.Version })),
      ),
      /** The proposal this one was refined from through chat. */
      "testmaster:refines": Type.Optional(P.id("pro")),
      "testmaster:candidateRevisionId": Type.Optional(P.id("rev")),
      "testmaster:testId": Type.Optional(P.id("tst")),
    }),
  ),
});

export const sourceResponseContracts = {
  /** Item of GET /projects/{id}/sources: the stored Source (incl. `workspaceId`) plus its overview. */
  SourceListItemView: P.Obj({
    ...entities.Source.properties,
    ...storedFields,
    overview: sourceInsightContracts.SourceOverview,
  }),
  /** POST /projects/{id}/sources and GET /sources/{id}. */
  SourceDetail: P.Obj({
    source: StoredSource,
    revision: ParsedSourceRevision,
    chunks: Type.Array(SourceChunk),
    diagnostics: Type.Array(SourceDiagnostic),
    inventory: SourceInventory,
    archivedAt: nullable(P.Timestamp),
  }),
  /** GET/PATCH /projects/{id}/requirements: the application's `RequirementSnapshot`. */
  RequirementSnapshotView: P.Obj({
    requirements: Type.Array(RequirementRecord),
    conflicts: Type.Array(RequirementConflictRecord),
    openQuestions: Type.Array(P.Description),
    /** 0 while nothing was normalized. */
    version: P.Nonnegative,
    /** Empty while nothing was normalized, else a hex digest. */
    fingerprint: Type.Union([P.ContentDigest, Type.Literal("")]),
  }),
  /** POST /projects/{id}/discovery (202), GET /discovery/{id}, POST /discovery/{id}/retry. */
  DiscoveryDetail,
  /** POST /discovery/{id}/cancel; also `DiscoveryDetail.job`. */
  DiscoveryJobView,
  /**
   * One `data:` JSON of GET /discovery/{id}/events as events.ts builds it today. `service.discovery.events`
   * returns the raw outbox row (columns `id,seq,type,created_at,data_json,…`) merged with the parsed
   * DiscoveryDetail, which has neither `occurredAt` nor `payload`, so both keys are dropped by
   * JSON.stringify and `attemptId` is always null.
   */
  DiscoveryEvent: P.Obj({
    schemaVersion: Type.Literal("1.0.0"),
    eventId: P.id("evt"),
    seq: P.Nonnegative,
    type: P.Enum(["discovery.accepted", "discovery.updated"]),
    jobId: P.id("dsc"),
    attemptId: Type.Null(),
  }),
  /**
   * One `data:` JSON of GET /runs/{id}/events. Same shape as the catalog `Event` except `type`: the
   * outbox of a Run carries many more types than the nine `Event` lists (run.receipt, run.reduced,
   * run.phase_changed, attempt.claimed, attempt.timing, runner events, cleanup.finished, …).
   */
  RunEventView: P.Obj({
    schemaVersion: Type.Literal("1.0.0"),
    eventId: P.id("evt"),
    seq: P.Nonnegative,
    type: P.Name,
    runId: P.id("run"),
    attemptId: nullable(P.id("att")),
    occurredAt: P.Timestamp,
    payload: P.Json,
  }),
  /** GET /proposal-batches/{id}: the batch and its proposals, newest first. */
  ProposalBatchDetail: P.Obj({
    batch: ProposalBatchRecord,
    proposals: Type.Array(ProposalRecord),
  }),
};

export type SourceListItemView = Static<typeof sourceResponseContracts.SourceListItemView>;
export type SourceDetail = Static<typeof sourceResponseContracts.SourceDetail>;
export type RequirementSnapshotView = Static<
  typeof sourceResponseContracts.RequirementSnapshotView
>;
export type DiscoveryDetail = Static<typeof sourceResponseContracts.DiscoveryDetail>;
export type DiscoveryJobView = Static<typeof sourceResponseContracts.DiscoveryJobView>;
export type DiscoveryEvent = Static<typeof sourceResponseContracts.DiscoveryEvent>;
export type RunEventView = Static<typeof sourceResponseContracts.RunEventView>;
export type ProposalBatchDetail = Static<typeof sourceResponseContracts.ProposalBatchDetail>;
