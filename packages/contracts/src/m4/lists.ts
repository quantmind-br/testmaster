import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { RunLimits } from "../operations.js";
import * as P from "../primitives.js";
import { reasonCodes } from "../registries.js";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** Dynamic selection filters; every present filter must match (UX-041). */
export const SuiteFilter = P.Obj({
  tags: Type.Optional(Type.Array(P.Name, { maxItems: 32 })),
  priorities: Type.Optional(Type.Array(P.Priority, { maxItems: 4 })),
  nameContains: Type.Optional(P.Name),
});
/** One project of a dynamic list with its explicit environment pin (REQ-034). */
export const SuiteProjectBinding = P.Obj({
  projectId: P.id("prj"),
  environmentId: P.id("env"),
  filter: Type.Optional(SuiteFilter),
});
/** One member of a fixed list: a pinned TestRevision snapshot with its environment. */
export const SuiteFixedMember = P.Obj({
  testId: P.id("tst"),
  revisionId: P.id("rev"),
  environmentId: P.id("env"),
});
/**
 * A list is either a fixed snapshot of TestRevisions or a dynamic filter over projects.
 * Both are ordered and carry an explicit environment per project.
 */
export const SuiteSelection = Type.Union([
  P.Obj({
    kind: Type.Literal("fixed"),
    members: Type.Array(SuiteFixedMember, { minItems: 1, maxItems: 500 }),
  }),
  P.Obj({
    kind: Type.Literal("dynamic"),
    projects: Type.Array(SuiteProjectBinding, { minItems: 1, maxItems: 50 }),
  }),
]);
export const suiteStates = ["active", "archived"] as const;
export const suiteExclusionKinds = [
  "access_denied",
  "project_unavailable",
  "environment_unavailable",
  "test_unavailable",
  "revision_unavailable",
] as const;

const SuiteExclusion = P.Obj({
  /** `project:<prj_…>` or `member:<tst_…>`; confirmations name exclusions by this key. */
  key: P.Name,
  scope: P.Enum(["project", "member"]),
  projectId: P.id("prj"),
  testId: nullable(P.id("tst")),
  kind: P.Enum(suiteExclusionKinds),
  reasonCode: P.Enum(reasonCodes),
  message: P.Description,
});
const SuiteResolvedMember = P.Obj({
  memberKey: P.Name,
  projectId: P.id("prj"),
  projectName: P.Name,
  testId: P.id("tst"),
  testName: P.Name,
  revisionId: P.id("rev"),
  revisionOrdinal: P.Version,
  environmentId: P.id("env"),
  environmentName: P.Name,
});
/** Destination and credential mapping of one project; two projects never share a mapping row. */
const SuiteMapping = P.Obj({
  projectId: P.id("prj"),
  projectName: P.Name,
  environmentId: P.id("env"),
  environmentName: P.Name,
  environmentRevisionId: P.id("evr"),
  targetOrigins: Type.Array(P.Name),
  /** Secret references the pinned revisions use (IDs only, never values). */
  secretRefs: Type.Array(P.id("sec")),
  memberCount: P.Nonnegative,
});

export const listContracts = {
  SuiteInput: P.Obj({
    name: P.Name,
    description: Type.Optional(P.Description),
    selection: SuiteSelection,
  }),
  SuitePatchInput: Type.Partial(
    P.Obj({ name: P.Name, description: P.Description, selection: SuiteSelection }),
  ),
  /** The effective expansion a list resolves to right now, before any BatchRun exists. */
  SuiteExpansion: P.Obj({
    suiteId: nullable(P.id("sui")),
    suiteVersion: nullable(P.Version),
    kind: P.Enum(["fixed", "dynamic"]),
    resolvedAt: P.Timestamp,
    /** Hash of members, exclusions and mapping; a run may pin it to run exactly what was previewed. */
    hash: P.ContentDigest,
    members: Type.Array(SuiteResolvedMember),
    exclusions: Type.Array(SuiteExclusion),
    mapping: Type.Array(SuiteMapping),
    /** Exclusion keys a caller must confirm to run the dispatchable subset. */
    requiresConfirmation: Type.Array(P.Name),
    dispatchable: Type.Boolean(),
  }),
  SuiteRunInput: P.Obj({
    /** Exclusion keys the caller accepts; the BatchRun still declares them and its gate stays failed. */
    confirmedExclusions: Type.Optional(Type.Array(P.Name, { maxItems: 600 })),
    expectedExpansionHash: Type.Optional(P.ContentDigest),
    mode: Type.Optional(Type.Literal("replay")),
    healingPolicy: Type.Optional(P.Enum(["off", "propose"])),
    seed: Type.Optional(Type.Integer()),
    limits: Type.Optional(RunLimits),
  }),
};
export type SuiteSelection = Static<typeof SuiteSelection>;
export type SuiteFilter = Static<typeof SuiteFilter>;
export type SuiteInput = Static<typeof listContracts.SuiteInput>;
export type SuitePatchInput = Static<typeof listContracts.SuitePatchInput>;
export type SuiteExpansion = Static<typeof listContracts.SuiteExpansion>;
export type SuiteRunInput = Static<typeof listContracts.SuiteRunInput>;
