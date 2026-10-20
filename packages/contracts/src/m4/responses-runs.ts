import { type Static, type TSchema, Type } from "@sinclair/typebox";
import * as E from "../entities.js";
import * as Ops from "../operations.js";
import * as P from "../primitives.js";
import { errorRegistry, reasonCodes } from "../registries.js";
import { runViewContracts } from "./runs.js";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/**
 * Real response bodies of the run, batch, resource and quarantine routes whose catalog row names a
 * schema the server does not emit.
 *
 * Reused as is, with no schema here: `Run` (GET /runs items: the stored Run entity,
 * `analysisStatus` included) and `BatchReceipt` (POST /flake-studies).
 */

/** POST /runs (202) and POST /runs/{id}/rerun (200): the RunReceipt plus who executes the Run. */
const OwnedRunReceipt = P.Obj({
  ...Ops.RunReceipt.properties,
  /** `worker` when a live worker was registered at admission, `ephemeral` when the caller runs it. */
  ownership: P.Enum(["worker", "ephemeral"]),
});

/**
 * GET /runs/{id}/steps item: the stored StepResult document. The worker stamps it with
 * `entity()`, so the workspace, creation time and version are always present.
 */
const StepResultRecord = P.Obj({
  ...Ops.StepResult.properties,
  workspaceId: P.id("ws"),
  createdAt: P.Timestamp,
  version: P.Version,
});

/**
 * GET /runs/{id}/bundle: the verified bundle location with its manifest and meta. The REST route
 * never passes `out`, so `sourceBundleDir` (set only by an export) never appears.
 */
const EvidenceBundleView = P.Obj({
  /** Absolute server-side directory of the committed bundle. */
  bundleDir: Type.String({ minLength: 1 }),
  manifest: Ops.ArtifactManifest,
  meta: Ops.BundleMeta,
});

/**
 * GET /runs/{id}/attempts item: an AttemptView plus the `createdAt` the page window sorts by,
 * which is the Attempt's `startedAt`, or `""` while it has not started.
 */
const AttemptListItem = P.Obj({
  ...runViewContracts.AttemptView.properties,
  createdAt: Type.Union([P.Timestamp, Type.Literal("")]),
});

/**
 * GET /runs/{id}: the stored Run plus the verdict `runVerdict` reads from its events
 * (`reasonCode`, `unavailableEvidence`, `executionError`, each present only when the Run has one).
 */
const RunView = P.Obj({
  ...E.entities.Run.properties,
  reasonCode: Ops.RunResult.properties.reasonCode,
  unavailableEvidence: Ops.RunResult.properties.unavailableEvidence,
  executionError: Ops.RunResult.properties.executionError,
});

/** One member of the batch aggregate, as built by `aggregateBatch`. */
const BatchMemberView = P.Obj({
  /** The Run id of a dispatched member, the `<index>:<testId>` memberKey of a rejected one. */
  key: P.Name,
  runId: nullable(P.id("run")),
  requested: Type.Boolean(),
  required: Type.Boolean(),
  dependency: Type.Boolean(),
  outcome: nullable(P.Outcome),
  gate: P.Gate,
  /** Only on members that were rejected before dispatch. */
  reasonCode: Type.Optional(P.Enum(reasonCodes)),
});

/** Why a requested member was not dispatched, as frozen in the batch selection snapshot. */
const BatchRejection = P.Obj({
  memberKey: P.Name,
  /** A ContractError code, or `INTERNAL` for an unexpected admission failure. */
  code: P.Enum(Object.keys(errorRegistry)),
  message: Type.String(),
  /** The `details` bag of the ContractError: genuinely unconstrained JSON. */
  details: Type.Record(Type.String(), P.Json),
});

/** GET /batches/{id}: the stored BatchRun with its rejections and the recomputed aggregate. */
const BatchView = P.Obj({
  ...E.entities.BatchRun.properties,
  rejections: Type.Array(BatchRejection),
  aggregate: P.Obj({
    counts: Ops.BatchCounts,
    gate: P.Gate,
    expanded: P.Obj({
      count: P.Nonnegative,
      counts: Ops.BatchCounts,
      members: Type.Array(BatchMemberView),
    }),
    allMembers: Type.Array(BatchMemberView),
  }),
});

/** GET /resources item: the stored ResourceRecord with the Run, project and cleanup approval binding. */
const ResourceDetail = P.Obj({
  ...E.entities.ResourceRecord.properties,
  runId: P.id("run"),
  projectId: P.id("prj"),
  /** The approval a manual cleanup must be bound to; never a granted approval. */
  cleanupApproval: P.Obj({
    actionSet: Type.Array(P.Name),
    revisionHash: P.ContentDigest,
    environmentRevisionId: P.id("evr"),
    originSet: Type.Array(P.Name),
    policyHash: P.ContentDigest,
    reason: P.Description,
  }),
});

/** POST /resources/{id}/cleanup (200): the admission receipt, completed once the compensation ran. */
const CleanupReceipt = P.Obj({
  resourceId: P.id("res"),
  operationId: P.id("job"),
  state: P.Enum(["pending", "cleaned", "cleanup_failed", "uncertain"]),
  attemptId: P.id("att"),
  /** Absolute server-side directory of the compensation bundle, when one was committed. */
  bundleDir: Type.Optional(Type.String({ minLength: 1 })),
  reasonCode: Type.Optional(
    Type.Union([P.Enum(reasonCodes), Type.Literal("cleanup_execution_uncertain")]),
  ),
});

/** Same shape as `SelectionPreview.excluded` in the catalog (validated against it before dispatch). */
const SelectionExclusion = P.Obj({
  testId: P.id("tst"),
  reason: P.Enum(["quarantined", "unaffected", "archived", "reused", "no_revision"]),
  owner: nullable(P.EntityId),
  detail: nullable(P.Description),
  expiresAt: nullable(P.Timestamp),
});

/** POST /selective-runs (200): the BatchReceipt plus the frozen selection hash and exclusions. */
const SelectionReceipt = P.Obj({
  ...Ops.BatchReceipt.properties,
  selectionHash: P.ContentDigest,
  excluded: Type.Array(SelectionExclusion),
});

/** GET /projects/{id}/quarantine item: the QuarantineRecord keyed by its test as `id`. */
const QuarantineListItem = P.Obj({
  id: P.id("tst"),
  testId: P.id("tst"),
  owner: P.EntityId,
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
  expiresAt: P.Timestamp,
  createdAt: P.Timestamp,
  version: P.Version,
});

export const runResponseContracts = {
  OwnedRunReceipt,
  StepResultRecord,
  EvidenceBundleView,
  AttemptListItem,
  RunView,
  BatchMemberView,
  BatchView,
  ResourceDetail,
  CleanupReceipt,
  SelectionReceipt,
  QuarantineListItem,
};
export type OwnedRunReceipt = Static<typeof OwnedRunReceipt>;
export type StepResultRecord = Static<typeof StepResultRecord>;
export type EvidenceBundleView = Static<typeof EvidenceBundleView>;
export type AttemptListItem = Static<typeof AttemptListItem>;
export type RunView = Static<typeof RunView>;
export type BatchMemberView = Static<typeof BatchMemberView>;
export type BatchView = Static<typeof BatchView>;
export type ResourceDetail = Static<typeof ResourceDetail>;
export type CleanupReceipt = Static<typeof CleanupReceipt>;
export type SelectionReceipt = Static<typeof SelectionReceipt>;
export type QuarantineListItem = Static<typeof QuarantineListItem>;
