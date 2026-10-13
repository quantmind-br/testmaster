import { type Static, type TSchema, Type } from "@sinclair/typebox";
import * as P from "../primitives.js";
import { reasonCodes } from "../registries.js";
import { SuiteFixedMember } from "./lists.js";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const ScheduleId = Type.String({ pattern: `^sch_${P.uuidPattern}$` });
const FiringId = Type.String({ pattern: `^sfr_${P.uuidPattern}$` });

export const scheduleStates = ["active", "paused", "archived"] as const;
export const schedulePauseReasons = [
  "manual",
  "owner_revoked",
  "auto_paused_failures",
  "secret_changed",
  "expired",
] as const;
export const scheduleFiringStates = [
  "claimed",
  "waiting",
  "dispatched",
  "skipped",
  "misfire",
  "overlap",
  "blocked",
] as const;
export const scheduleDstKinds = [
  "none",
  "fold_first",
  "fold_second",
  "gap_shifted",
  "gap_skipped",
] as const;

/** Five-field cron evaluated in an IANA timezone, or a UTC interval (OPS-016). */
export const ScheduleTriggerInput = Type.Union([
  P.Obj({
    kind: Type.Literal("cron"),
    cron: Type.String({ minLength: 9, maxLength: 120 }),
    /** Defaults to UTC; an unknown zone is refused, never replaced by UTC. */
    timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    /** A local time that does not exist: `skip` (default) or fire when the gap ends. */
    dstGap: Type.Optional(P.Enum(["skip", "after_gap"])),
    /** A local time that happens twice: first occurrence (default), last, or both. */
    dstFold: Type.Optional(P.Enum(["once", "once_last", "both"])),
  }),
  P.Obj({
    kind: Type.Literal("interval"),
    everySeconds: Type.Integer({ minimum: 60, maximum: 31_536_000 }),
    anchor: P.Timestamp,
  }),
]);
export const ScheduleTrigger = Type.Union([
  P.Obj({
    kind: Type.Literal("cron"),
    cron: Type.String({ minLength: 9, maxLength: 120 }),
    timezone: Type.String({ minLength: 1, maxLength: 64 }),
    dstGap: P.Enum(["skip", "after_gap"]),
    dstFold: P.Enum(["once", "once_last", "both"]),
  }),
  P.Obj({
    kind: Type.Literal("interval"),
    everySeconds: Type.Integer({ minimum: 60, maximum: 31_536_000 }),
    anchor: P.Timestamp,
  }),
]);
/** What a schedule runs: a list (pinned by default) or explicit pinned revisions. */
export const ScheduleSelectionInput = Type.Union([
  P.Obj({
    kind: Type.Literal("suite"),
    suiteId: P.id("sui"),
    /** `pinned` freezes the expansion at save time; `latest_approved` re-resolves at every firing. */
    revisionPolicy: Type.Optional(P.Enum(["pinned", "latest_approved"])),
  }),
  P.Obj({
    kind: Type.Literal("revisions"),
    members: Type.Array(SuiteFixedMember, { minItems: 1, maxItems: 500 }),
  }),
]);
const SchedulePinnedMember = P.Obj({
  memberKey: P.Name,
  projectId: P.id("prj"),
  testId: P.id("tst"),
  revisionId: P.id("rev"),
  environmentId: P.id("env"),
});
export const ScheduleSelection = Type.Union([
  P.Obj({
    kind: Type.Literal("suite"),
    suiteId: P.id("sui"),
    revisionPolicy: P.Enum(["pinned", "latest_approved"]),
    /** Frozen at save time for `pinned`; empty for `latest_approved`. */
    pinned: Type.Array(SchedulePinnedMember),
    suiteVersion: P.Version,
  }),
  P.Obj({
    kind: Type.Literal("revisions"),
    revisionPolicy: Type.Literal("pinned"),
    pinned: Type.Array(SchedulePinnedMember),
  }),
]);
const MisfireInput = P.Obj({
  /** `skip` records the gap; `fire_once` runs one representative; `catch_up` runs a bounded backlog. */
  policy: P.Enum(["skip", "fire_once", "catch_up"]),
  graceSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400 })),
  maxCatchUp: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 })),
  catchUpWindowSeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 604800 })),
});
const Misfire = P.Obj({
  policy: P.Enum(["skip", "fire_once", "catch_up"]),
  graceSeconds: Type.Integer({ minimum: 1, maximum: 86400 }),
  maxCatchUp: Type.Integer({ minimum: 1, maximum: 24 }),
  catchUpWindowSeconds: Type.Integer({ minimum: 60, maximum: 604800 }),
});
const DependencyInput = P.Obj({
  scheduleId: ScheduleId,
  /** `passed` needs a passed gate; blocked and inconclusive never satisfy it. */
  condition: P.Enum(["passed", "failed", "terminal"]),
  timeoutSeconds: Type.Integer({ minimum: 1, maximum: 86400 }),
});
const BudgetInput = P.Obj({
  maxFiresPerDay: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
  maxRunsPerDay: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
  autoPauseAfterFailures: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
const Budget = P.Obj({
  maxFiresPerDay: Type.Integer({ minimum: 1, maximum: 1440 }),
  maxRunsPerDay: Type.Integer({ minimum: 1, maximum: 100000 }),
  autoPauseAfterFailures: Type.Integer({ minimum: 1, maximum: 100 }),
});
const SecretsPolicyInput = P.Obj({ onChange: P.Enum(["use_current", "pause"]) });
const Destinations = P.Obj({
  integrationIds: Type.Array(Type.String({ pattern: `^int_${P.uuidPattern}$` }), {
    maxItems: 16,
  }),
});

const definitionFields = {
  description: Type.Optional(P.Description),
  overlap: Type.Optional(P.Enum(["forbid", "allow", "replace"])),
  replaceTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400 })),
  dependsOn: Type.Optional(Type.Array(DependencyInput, { maxItems: 16 })),
  budget: Type.Optional(BudgetInput),
  secrets: Type.Optional(SecretsPolicyInput),
  /** Scheduled runs replay; healing may propose but never apply unattended. */
  healingPolicy: Type.Optional(P.Enum(["off", "propose"])),
  expiresAt: Type.Optional(nullable(P.Timestamp)),
  destinations: Type.Optional(Destinations),
};
const ScheduleOutcomeStates = P.Enum(scheduleFiringStates);

export const ScheduleDefinition = P.Obj({
  description: P.Description,
  selection: ScheduleSelection,
  trigger: ScheduleTrigger,
  misfire: Misfire,
  overlap: P.Enum(["forbid", "allow", "replace"]),
  replaceTimeoutSeconds: Type.Integer({ minimum: 1, maximum: 86400 }),
  dependsOn: Type.Array(DependencyInput),
  budget: Budget,
  secrets: SecretsPolicyInput,
  healingPolicy: P.Enum(["off", "propose"]),
  expiresAt: nullable(P.Timestamp),
  destinations: Destinations,
});
const SchedulePreviewEntry = P.Obj({
  /** The UTC fire instant that becomes the unique key part of the firing. */
  fireAt: P.Timestamp,
  localTime: P.Name,
  dst: P.Enum(scheduleDstKinds),
});

export const scheduleContracts = {
  ScheduleInput: P.Obj({
    name: P.Name,
    selection: ScheduleSelectionInput,
    trigger: ScheduleTriggerInput,
    misfire: Type.Optional(MisfireInput),
    ...definitionFields,
  }),
  SchedulePatchInput: Type.Partial(
    P.Obj({
      name: P.Name,
      selection: ScheduleSelectionInput,
      trigger: ScheduleTriggerInput,
      misfire: MisfireInput,
      ...definitionFields,
    }),
  ),
  /** A draft definition whose next ten occurrences are previewed before it is saved. */
  SchedulePreviewInput: P.Obj({
    trigger: ScheduleTriggerInput,
    from: Type.Optional(P.Timestamp),
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  }),
  SchedulePreview: P.Obj({
    timezone: Type.String(),
    tzdataVersion: Type.String(),
    occurrences: Type.Array(SchedulePreviewEntry),
    /** Local times a DST gap removed, so a gap that skips a firing is visible, not silent. */
    skippedByDst: Type.Array(P.Name),
  }),
  Schedule: P.Obj({
    id: ScheduleId,
    workspaceId: P.id("ws"),
    name: P.Name,
    state: P.Enum(scheduleStates),
    pauseReason: nullable(P.Enum(schedulePauseReasons)),
    pausedAt: nullable(P.Timestamp),
    ownerId: P.Name,
    /** Revision ordinal of the definition in force; changing the zone or cron creates a new one. */
    revision: P.Version,
    version: P.Version,
    definition: ScheduleDefinition,
    tzdataVersion: P.Name,
    runtimeTzdataVersion: P.Name,
    tzdataDrift: Type.Boolean(),
    nextFireAt: nullable(P.Timestamp),
    preview: Type.Array(SchedulePreviewEntry),
    createdAt: P.Timestamp,
    updatedAt: P.Timestamp,
  }),
  ScheduleRevision: P.Obj({
    /** `<scheduleId>@<revision>`; a stable page tiebreaker. */
    id: P.Name,
    scheduleId: ScheduleId,
    revision: P.Version,
    createdAt: P.Timestamp,
    createdBy: P.Name,
    tzdataVersion: P.Name,
    definition: ScheduleDefinition,
  }),
  /** One planned occurrence and what became of it; unique per schedule, revision and instant. */
  ScheduledFire: P.Obj({
    id: FiringId,
    scheduleId: ScheduleId,
    revision: P.Version,
    /** The planned UTC fire instant. */
    scheduledAt: P.Timestamp,
    /** When the occurrence was claimed; the keyset the history pages on. */
    createdAt: P.Timestamp,
    localTime: P.Name,
    /** When the scheduler decided the outcome; null while claimed or waiting. */
    decidedAt: nullable(P.Timestamp),
    state: ScheduleOutcomeStates,
    reasonCode: Type.Optional(P.Enum(reasonCodes)),
    detail: nullable(P.Description),
    batchId: nullable(P.id("bat")),
    dst: P.Enum(scheduleDstKinds),
    /** More than one for an aggregated misfire that covers a gap of occurrences. */
    missedCount: P.Nonnegative,
    missedUntil: nullable(P.Timestamp),
    tzdataVersion: P.Name,
    /** Expansion size of the frozen selection; the full list lives on the BatchRun. */
    memberCount: P.Nonnegative,
  }),
};
export type ScheduleInput = Static<typeof scheduleContracts.ScheduleInput>;
export type SchedulePatchInput = Static<typeof scheduleContracts.SchedulePatchInput>;
export type SchedulePreviewInput = Static<typeof scheduleContracts.SchedulePreviewInput>;
export type SchedulePreview = Static<typeof scheduleContracts.SchedulePreview>;
export type ScheduleView = Static<typeof scheduleContracts.Schedule>;
export type ScheduleRevisionView = Static<typeof scheduleContracts.ScheduleRevision>;
export type ScheduledFire = Static<typeof scheduleContracts.ScheduledFire>;
export type ScheduleDefinition = Static<typeof ScheduleDefinition>;
export type ScheduleTrigger = Static<typeof ScheduleTrigger>;
export type ScheduleTriggerInput = Static<typeof ScheduleTriggerInput>;
export type ScheduleSelection = Static<typeof ScheduleSelection>;
export type ScheduleSelectionInput = Static<typeof ScheduleSelectionInput>;
