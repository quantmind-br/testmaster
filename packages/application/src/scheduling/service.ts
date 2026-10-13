import { randomUUID } from "node:crypto";
import {
  ContractError,
  type ScheduleDefinition,
  type ScheduledFire,
  type ScheduleInput,
  type SchedulePatchInput,
  type SchedulePreview,
  type SchedulePreviewInput,
  type ScheduleRevisionView,
  type ScheduleSelection,
  type ScheduleView,
  validate,
} from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import { auditSecurity } from "../audit.js";
import { requireEntity, type ServiceContext } from "../context.js";
import type { IntegrationsService } from "../integrations/index.js";
import type { ResolvedSuite, StoredSuite, SuitesService } from "../suites.js";
import {
  compileTrigger,
  gapMarkersBetween,
  nextOccurrences,
  runtimeTzdataVersion,
} from "./calendar.js";
import { buildDefinition } from "./definition.js";
import { firingView, type OwnerCredential, ScheduleStore, type StoredSchedule } from "./store.js";

const PREVIEW_COUNT = 10;

function inTx<T>(ctx: ServiceContext, action: () => T): T {
  return ctx.database.inTransaction ? action() : ctx.database.withTx(action);
}
function expectVersion(current: StoredSchedule, version: number): void {
  if (version === undefined || version === null)
    throw new ContractError("PRECONDITION_REQUIRED", "Expected version is required");
  if (!Number.isSafeInteger(version) || version < 1)
    throw new ContractError("INVALID_ARGUMENT", "Expected version must be a positive integer");
  if (current.version !== version)
    throw new ContractError("REVISION_CONFLICT", "Entity version changed");
}

/**
 * Revisioned schedules (REQ-035, OPS-016…019). This service owns definitions and their lifecycle;
 * the scheduler controller (`scheduler.ts`) owns firing them.
 */
export class SchedulesService {
  readonly store: ScheduleStore;
  constructor(
    readonly ctx: ServiceContext,
    private readonly suites: SuitesService,
    private readonly integrations: IntegrationsService,
    private readonly now: () => number = Date.now,
  ) {
    this.store = new ScheduleStore(ctx.database);
  }

  private owner(): OwnerCredential {
    return this.ctx.actor.credentialKind === "api" && this.ctx.actor.credentialId
      ? { kind: "api", id: this.ctx.actor.credentialId }
      : { kind: null, id: null };
  }
  private can(projectId: string): boolean {
    try {
      this.ctx.authorize("R", projectId);
      return true;
    } catch (error) {
      if (error instanceof ContractError && error.code === "FORBIDDEN") return false;
      throw error;
    }
  }
  /** Distinct projects the definition runs in; a reader must see all of them to see the schedule. */
  projectsOf(definition: ScheduleDefinition): string[] {
    const selection = definition.selection;
    if (selection.kind === "revisions" || selection.revisionPolicy === "pinned")
      return [...new Set(selection.pinned.map((member) => member.projectId))];
    const suite = this.ctx.entities.get("Suite", this.ctx.workspaceId, selection.suiteId);
    if (!suite) return [];
    const stored = (suite as StoredSuite).selection;
    return stored.kind === "dynamic"
      ? stored.projects.map((binding) => binding.projectId)
      : [
          ...new Set(
            stored.members.map((member) =>
              String(
                this.ctx.entities.get("TestCase", this.ctx.workspaceId, member.testId)?.projectId,
              ),
            ),
          ),
        ];
  }
  private definitionOf(schedule: StoredSchedule): ScheduleDefinition {
    const revision = this.store.getRevision(schedule.workspaceId, schedule.id, schedule.revision);
    if (!revision) throw new ContractError("INTERNAL", "Schedule revision is missing");
    return revision.definition;
  }
  private visible(schedule: StoredSchedule): boolean {
    return this.projectsOf(this.definitionOf(schedule)).every((projectId) => this.can(projectId));
  }
  private load(id: string): StoredSchedule {
    const schedule = this.store.getSchedule(this.ctx.workspaceId, id);
    if (!schedule || !this.visible(schedule))
      throw new ContractError("NOT_FOUND", "Schedule does not exist", { id });
    return schedule;
  }
  view(schedule: StoredSchedule): ScheduleView {
    const revision = this.store.getRevision(schedule.workspaceId, schedule.id, schedule.revision);
    if (!revision) throw new ContractError("INTERNAL", "Schedule revision is missing");
    const definition = revision.definition;
    const runtime = runtimeTzdataVersion();
    const from = Math.max(this.now(), Date.parse(schedule.cursorAt));
    const preview =
      schedule.state === "active"
        ? nextOccurrences(compileTrigger(definition.trigger), from, PREVIEW_COUNT).map((item) => ({
            fireAt: item.fireAt,
            localTime: item.localTime,
            dst: item.dst,
          }))
        : [];
    return {
      id: schedule.id,
      workspaceId: schedule.workspaceId,
      name: schedule.name,
      state: schedule.state,
      pauseReason: schedule.pauseReason,
      pausedAt: schedule.pausedAt,
      ownerId: schedule.ownerId,
      revision: schedule.revision,
      version: schedule.version,
      definition,
      tzdataVersion: revision.tzdataVersion,
      runtimeTzdataVersion: runtime,
      tzdataDrift: definition.trigger.kind === "cron" && revision.tzdataVersion !== runtime,
      nextFireAt: schedule.nextFireAt,
      preview,
      createdAt: schedule.createdAt,
      updatedAt: schedule.updatedAt,
    } as ScheduleView;
  }

  list(): ScheduleView[] {
    this.ctx.authorize("R");
    return this.store
      .listSchedules(this.ctx.workspaceId)
      .filter((schedule) => this.visible(schedule))
      .map((schedule) => this.view(schedule));
  }
  get(id: string): ScheduleView {
    this.ctx.authorize("R");
    return this.view(this.load(id));
  }
  revisions(id: string): ScheduleRevisionView[] {
    this.ctx.authorize("R");
    this.load(id);
    return this.store.listRevisions(this.ctx.workspaceId, id);
  }
  /** Newest first; a replacement for paging in memory because history is bounded by retention. */
  firings(id: string, limit = 1000): ScheduledFire[] {
    this.ctx.authorize("R");
    this.load(id);
    return this.store.listFirings(this.ctx.workspaceId, id, { limit }).map(firingView);
  }

  /** Next occurrences of a draft trigger; DST gaps that remove an occurrence are listed, not hidden. */
  preview(input: SchedulePreviewInput): SchedulePreview {
    validate("SchedulePreviewInput", input);
    this.ctx.authorize("R");
    const trigger = compileTrigger(input.trigger);
    const from = input.from ? Date.parse(input.from) : this.now();
    const count = input.count ?? PREVIEW_COUNT;
    const found = nextOccurrences(trigger, from, count);
    const last = found.at(-1)?.instantMs ?? from;
    return {
      timezone: trigger.kind === "cron" ? trigger.timezone : "UTC",
      tzdataVersion: runtimeTzdataVersion(),
      occurrences: found.map((item) => ({
        fireAt: item.fireAt,
        localTime: item.localTime,
        dst: item.dst,
      })),
      skippedByDst: gapMarkersBetween(trigger, from, last).map((item) => item.localTime),
    };
  }

  /**
   * Freezes what a schedule runs. A list is expanded now and must be fully runnable by the caller;
   * `latest_approved` keeps only the reference and re-resolves at each firing.
   */
  private pinSelection(selection: ScheduleInput["selection"]): ScheduleSelection {
    if (selection.kind === "revisions") {
      this.suites.assertSelection({ kind: "fixed", members: selection.members });
      const { expansion } = this.suites.resolve(
        { kind: "fixed", members: selection.members },
        null,
      );
      this.assertRunnable(expansion);
      return { kind: "revisions", revisionPolicy: "pinned", pinned: this.pinned(expansion) };
    }
    const suite = requireEntity(this.ctx, "Suite", selection.suiteId) as StoredSuite;
    if (suite.state === "archived")
      throw new ContractError("PRECONDITION_FAILED", "Archived list cannot be scheduled");
    const resolved = this.suites.resolve(suite.selection, {
      id: suite.id,
      version: Number(suite.version),
    });
    this.assertRunnable(resolved.expansion);
    const policy = selection.revisionPolicy ?? "pinned";
    return {
      kind: "suite",
      suiteId: suite.id,
      revisionPolicy: policy,
      pinned: policy === "pinned" ? this.pinned(resolved.expansion) : [],
      suiteVersion: Number(suite.version),
    } as ScheduleSelection;
  }
  private pinned(expansion: ResolvedSuite["expansion"]) {
    return expansion.members.map((member) => ({
      memberKey: member.memberKey,
      projectId: member.projectId,
      testId: member.testId,
      revisionId: member.revisionId,
      environmentId: member.environmentId,
    }));
  }
  /** A schedule has nobody to confirm a subset, so an excluded member is refused up front. */
  private assertRunnable(expansion: ResolvedSuite["expansion"]): void {
    if (expansion.exclusions.length || !expansion.members.length)
      throw new ContractError(
        expansion.exclusions.some((item) => item.kind === "access_denied")
          ? "FORBIDDEN"
          : "PRECONDITION_FAILED",
        "A schedule needs every member of its list to be runnable by its owner",
        { exclusions: expansion.exclusions, nextActions: ["fix_list"] },
      );
  }
  /** What the owner's identity would dispatch right now (used by the scheduler and by resume). */
  resolveSelection(definition: ScheduleDefinition): ResolvedSuite {
    const selection = definition.selection;
    if (selection.kind === "suite" && selection.revisionPolicy === "latest_approved") {
      const suite = requireEntity(this.ctx, "Suite", selection.suiteId) as StoredSuite;
      if (suite.state === "archived")
        throw new ContractError("PRECONDITION_FAILED", "Archived list cannot be scheduled");
      return this.suites.resolve(suite.selection, { id: suite.id, version: Number(suite.version) });
    }
    return this.suites.resolve(
      {
        kind: "fixed",
        members: selection.pinned.map((member) => ({
          testId: member.testId,
          revisionId: member.revisionId,
          environmentId: member.environmentId,
        })),
      },
      selection.kind === "suite"
        ? { id: selection.suiteId, version: selection.suiteVersion }
        : null,
    );
  }

  private assertDestinations(definition: ScheduleDefinition): void {
    if (!definition.destinations.integrationIds.length) return;
    this.ctx.authorize("A");
    for (const id of definition.destinations.integrationIds) {
      const integration = this.integrations.get(id);
      if (integration.state !== "active")
        throw new ContractError("PRECONDITION_FAILED", "Notification destination is not active", {
          id,
        });
    }
  }
  /** Dependencies form a DAG: following `dependsOn` from any upstream must never reach `self`. */
  private assertAcyclic(selfId: string, dependsOn: ScheduleDefinition["dependsOn"]): void {
    for (const dependency of dependsOn) {
      if (dependency.scheduleId === selfId)
        throw new ContractError("INVALID_ARGUMENT", "A schedule cannot depend on itself", {
          reasonCode: "dependency_cycle",
          path: [selfId],
        });
      const upstream = this.store.getSchedule(this.ctx.workspaceId, dependency.scheduleId);
      if (!upstream)
        throw new ContractError("NOT_FOUND", "Dependency schedule does not exist", {
          id: dependency.scheduleId,
        });
      if (upstream.state === "archived")
        throw new ContractError("PRECONDITION_FAILED", "Dependency schedule is archived", {
          id: dependency.scheduleId,
        });
    }
    const visited = new Set<string>();
    const walk = (id: string, path: string[]): void => {
      if (visited.has(id)) return;
      visited.add(id);
      const schedule = this.store.getSchedule(this.ctx.workspaceId, id);
      if (!schedule) return;
      for (const next of this.definitionOf(schedule).dependsOn) {
        if (next.scheduleId === selfId)
          throw new ContractError("INVALID_ARGUMENT", "Schedule dependencies form a cycle", {
            reasonCode: "dependency_cycle",
            path: [selfId, ...path, id, selfId],
          });
        walk(next.scheduleId, [...path, id]);
      }
    };
    for (const dependency of dependsOn) walk(dependency.scheduleId, []);
  }
  private assertName(name: string, exceptId?: string): void {
    const clash = this.store
      .listSchedules(this.ctx.workspaceId)
      .find((item) => item.name === name && item.id !== exceptId);
    if (clash)
      throw new ContractError("INVALID_ARGUMENT", "A schedule with this name already exists", {
        name,
      });
  }
  private nextAfter(definition: ScheduleDefinition, fromMs: number): string | null {
    return nextOccurrences(compileTrigger(definition.trigger), fromMs, 1)[0]?.fireAt ?? null;
  }

  create(input: ScheduleInput): ScheduleView {
    validate("ScheduleInput", input);
    this.ctx.authorize("W");
    this.ctx.authorize("X");
    return inTx(this.ctx, () => {
      this.assertName(input.name);
      const now = this.now();
      const selection = this.pinSelection(input.selection);
      const { name: _name, selection: _selection, ...rest } = input;
      const definition = buildDefinition(selection, rest, null, now);
      this.assertDestinations(definition);
      const id = `sch_${randomUUID()}`;
      this.assertAcyclic(id, definition.dependsOn);
      const at = new Date(now).toISOString();
      const schedule: StoredSchedule = {
        id,
        workspaceId: this.ctx.workspaceId,
        name: input.name,
        state: "active",
        pauseReason: null,
        pausedAt: null,
        ownerId: this.ctx.principalId,
        ownerCredential: this.owner(),
        revision: 1,
        version: 1,
        cursorAt: at,
        nextFireAt: this.nextAfter(definition, now),
        createdAt: at,
        updatedAt: at,
      };
      this.store.insertSchedule(schedule, {
        ownerCredential: schedule.ownerCredential,
        pausedAt: null,
      });
      this.store.insertRevision(
        schedule.workspaceId,
        id,
        1,
        this.ctx.principalId,
        runtimeTzdataVersion(),
        definition,
      );
      auditSecurity(this.ctx, "schedules.create", id, "allowed");
      return this.view(schedule);
    });
  }

  update(id: string, patch: SchedulePatchInput, expectedVersion: number): ScheduleView {
    validate("SchedulePatchInput", patch);
    this.ctx.authorize("W");
    this.ctx.authorize("X");
    return inTx(this.ctx, () => {
      const current = this.load(id);
      expectVersion(current, expectedVersion);
      if (current.state === "archived")
        throw new ContractError("PRECONDITION_FAILED", "Archived schedule cannot be modified");
      if (patch.name) this.assertName(patch.name, id);
      const now = this.now();
      const base = this.definitionOf(current);
      const selection = patch.selection ? this.pinSelection(patch.selection) : base.selection;
      const { name: _name, selection: _selection, ...rest } = patch;
      const definition = buildDefinition(selection, rest, base, now);
      const changed = semanticHash(definition) !== semanticHash(base);
      if (changed) {
        this.assertDestinations(definition);
        this.assertAcyclic(id, definition.dependsOn);
      }
      const at = new Date(now).toISOString();
      const next: StoredSchedule = {
        ...current,
        name: patch.name ?? current.name,
        version: expectedVersion + 1,
        updatedAt: at,
        ...(changed
          ? {
              revision: current.revision + 1,
              // The last principal to change what runs owns the schedule and its authority.
              ownerId: this.ctx.principalId,
              ownerCredential: this.owner(),
              nextFireAt:
                current.state === "active"
                  ? this.nextAfter(definition, Math.max(now, Date.parse(current.cursorAt)))
                  : current.nextFireAt,
            }
          : {}),
      };
      if (changed)
        this.store.insertRevision(
          next.workspaceId,
          id,
          next.revision,
          this.ctx.principalId,
          runtimeTzdataVersion(),
          definition,
        );
      if (!this.store.updateSchedule(next, expectedVersion))
        throw new ContractError("REVISION_CONFLICT", "Entity version changed");
      auditSecurity(this.ctx, "schedules.update", id, "allowed");
      return this.view(next);
    });
  }

  pause(id: string, expectedVersion: number): ScheduleView {
    this.ctx.authorize("W");
    return inTx(this.ctx, () => {
      const current = this.load(id);
      expectVersion(current, expectedVersion);
      if (current.state !== "active")
        throw new ContractError("PRECONDITION_FAILED", "Only an active schedule can be paused");
      const at = new Date(this.now()).toISOString();
      const next: StoredSchedule = {
        ...current,
        state: "paused",
        pauseReason: "manual",
        pausedAt: at,
        nextFireAt: null,
        version: expectedVersion + 1,
        updatedAt: at,
      };
      if (!this.store.updateSchedule(next, expectedVersion))
        throw new ContractError("REVISION_CONFLICT", "Entity version changed");
      auditSecurity(this.ctx, "schedules.pause", id, "allowed");
      return this.view(next);
    });
  }

  /**
   * Resuming re-validates the caller, who becomes the owner, and starts from now: the paused period
   * is never replayed as a backlog.
   */
  resume(id: string, expectedVersion: number): ScheduleView {
    this.ctx.authorize("W");
    this.ctx.authorize("X");
    return inTx(this.ctx, () => {
      const current = this.load(id);
      expectVersion(current, expectedVersion);
      if (current.state !== "paused")
        throw new ContractError("PRECONDITION_FAILED", "Only a paused schedule can be resumed");
      const definition = this.definitionOf(current);
      const now = this.now();
      if (definition.expiresAt && Date.parse(definition.expiresAt) <= now)
        throw new ContractError("PRECONDITION_FAILED", "Schedule expired; change expiresAt first", {
          expiresAt: definition.expiresAt,
        });
      this.assertRunnable(this.resolveSelection(definition).expansion);
      const at = new Date(now).toISOString();
      const next: StoredSchedule = {
        ...current,
        state: "active",
        pauseReason: null,
        pausedAt: null,
        ownerId: this.ctx.principalId,
        ownerCredential: this.owner(),
        cursorAt: at,
        nextFireAt: this.nextAfter(definition, now),
        version: expectedVersion + 1,
        updatedAt: at,
      };
      if (!this.store.updateSchedule(next, expectedVersion))
        throw new ContractError("REVISION_CONFLICT", "Entity version changed");
      auditSecurity(this.ctx, "schedules.resume", id, "allowed");
      return this.view(next);
    });
  }

  archive(id: string, expectedVersion: number): ScheduleView {
    this.ctx.authorize("W");
    return inTx(this.ctx, () => {
      const current = this.load(id);
      expectVersion(current, expectedVersion);
      const at = new Date(this.now()).toISOString();
      const next: StoredSchedule = {
        ...current,
        state: "archived",
        pauseReason: null,
        pausedAt: null,
        nextFireAt: null,
        version: expectedVersion + 1,
        updatedAt: at,
      };
      if (!this.store.updateSchedule(next, expectedVersion))
        throw new ContractError("REVISION_CONFLICT", "Entity version changed");
      auditSecurity(this.ctx, "schedules.archive", id, "allowed");
      return this.view(next);
    });
  }
}
