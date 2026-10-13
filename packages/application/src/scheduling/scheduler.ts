import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  ContractError,
  type ScheduleDefinition,
  type ScheduleRevisionView,
} from "@testmaster/contracts";
import {
  EntityRepository,
  OutboxRepository,
  type PersistenceDatabase,
} from "@testmaster/persistence";
import type { Application, AuthenticatedIdentity, PermissionGrant } from "../application.js";
import { auditAs } from "../audit.js";
import type { Controller } from "../controllers.js";
import { isRestoreIsolated } from "../operations-state.js";
import type { TokenData } from "../tokens.js";
import {
  compileTrigger,
  gapMarkersBetween,
  nextOccurrences,
  type Occurrence,
  occurrencesBetween,
} from "./calendar.js";
import {
  type FiringFrozen,
  type FiringState,
  type Lease,
  type PauseReason,
  ScheduleStore,
  type StoredFiring,
  type StoredSchedule,
} from "./store.js";

const LEASE_NAME = "scheduler";
const DAY_MS = 86_400_000;
const OCCURRENCE_CAP = 100_000;
const AUTO_PAUSE_EVALUATION_MS = 30_000;
const iso = (ms: number): string => new Date(ms).toISOString();

export interface SchedulerOptions {
  /** Distinguishes this scheduler instance in the lease; defaults to host, pid and a random suffix. */
  holder?: string;
  now?: () => number;
  /** How long a leadership term lasts without renewal. */
  leaseMs?: number;
  /** Runs on every Application a firing acts through; tests use it to stub host preconditions. */
  configureApplication?: (application: Application) => void;
}
export interface TickSummary {
  leader: boolean;
  isolated: boolean;
  fence: number | null;
  claimed: number;
  dispatched: number;
}
class PlanSkipped extends Error {}
class LeaseLost extends Error {
  constructor() {
    super("Scheduler lease lost");
  }
}
interface Drive {
  firing: StoredFiring;
  schedule: StoredSchedule;
  definition: ScheduleDefinition;
  store: ScheduleStore;
  database: PersistenceDatabase;
  lease: Lease;
  nowMs: number;
}
/** What a drive step decided; `wait` keeps the firing open, `done` ends it. */
type Step = { kind: "continue" } | { kind: "done" };
const proceed: Step = { kind: "continue" };
const finished: Step = { kind: "done" };

/**
 * The scheduler controller (OPS-016…018). One leader at a time holds a database lease with a fence;
 * every firing write re-checks the fence. Correctness never depends on the lease alone: a firing is
 * unique per (schedule, revision, instant) and its batch admission is idempotent per firing, so a
 * duplicated leader, a replayed tick or a clock that moved cannot start the same occurrence twice.
 */
export class Scheduler {
  readonly holder: string;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private lease: Lease | null = null;
  private readonly evaluated = new Map<string, number>();
  constructor(
    private readonly scope: Application,
    private readonly options: SchedulerOptions = {},
  ) {
    this.holder = options.holder ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? 30_000;
  }

  private databaseFor(workspaceId: string): PersistenceDatabase {
    return this.scope.database.forWorkspace(workspaceId);
  }
  private storeFor(workspaceId: string): ScheduleStore {
    return new ScheduleStore(this.databaseFor(workspaceId));
  }

  /** Takes or renews leadership; null when another instance holds an unexpired lease. */
  private acquire(nowMs: number): Lease | null {
    const store = new ScheduleStore(this.scope.database);
    return this.scope.database.withTx(() => {
      const current = store.lease(LEASE_NAME);
      const expiresAt = iso(nowMs + this.leaseMs);
      if (!current) {
        const created = { holder: this.holder, fence: 1, acquiredAt: iso(nowMs), expiresAt };
        return store.insertLease(LEASE_NAME, created) ? created : null;
      }
      const live = Date.parse(current.expiresAt) > nowMs;
      if (current.holder === this.holder && live) {
        const renewed = { ...current, expiresAt };
        return store.updateLease(LEASE_NAME, current.fence, renewed) ? renewed : null;
      }
      if (live) return null;
      const taken = {
        holder: this.holder,
        fence: current.fence + 1,
        acquiredAt: iso(nowMs),
        expiresAt,
      };
      return store.updateLease(LEASE_NAME, current.fence, taken) ? taken : null;
    });
  }
  /** Gives leadership up immediately so another instance can take over without waiting for expiry. */
  release(): void {
    const lease = this.lease;
    if (!lease) return;
    this.scope.database.withTx(() =>
      new ScheduleStore(this.scope.database).expireLease(
        LEASE_NAME,
        lease.holder,
        lease.fence,
        iso(0),
      ),
    );
    this.lease = null;
  }
  /** Throws inside the caller's transaction when this instance is no longer the leader. */
  private guard(database: PersistenceDatabase, lease: Lease): void {
    const current = new ScheduleStore(database).lease(LEASE_NAME);
    if (!current || current.holder !== lease.holder || current.fence !== lease.fence)
      throw new LeaseLost();
  }

  async tick(nowMs: number = this.now()): Promise<TickSummary> {
    const summary: TickSummary = {
      leader: false,
      isolated: false,
      fence: null,
      claimed: 0,
      dispatched: 0,
    };
    // A restored copy must not act on its own until an operator releases it (OPS-025).
    if (isRestoreIsolated(this.scope.database)) return { ...summary, isolated: true };
    const lease = this.acquire(nowMs);
    this.lease = lease;
    if (!lease) return summary;
    summary.leader = true;
    summary.fence = lease.fence;
    try {
      const apps = new Map<string, Application>();
      const store = new ScheduleStore(this.scope.database);
      for (const schedule of store.activeSchedules()) {
        const database = this.databaseFor(schedule.workspaceId);
        if (this.ownerProblem(database, schedule, nowMs)) {
          this.pause(schedule, lease, nowMs, "owner_revoked", "The schedule owner lost access");
          continue;
        }
        if (this.autoPause(schedule, lease, nowMs, apps)) continue;
        if (schedule.nextFireAt && Date.parse(schedule.nextFireAt) <= nowMs)
          summary.claimed += this.plan(schedule, lease, nowMs);
      }
      for (const firing of store.pendingFirings()) {
        const outcome = await this.drive(firing, lease, nowMs, apps);
        if (outcome === "dispatched") summary.dispatched++;
      }
    } catch (error) {
      if (!(error instanceof LeaseLost)) throw error;
      this.lease = null;
      summary.leader = false;
    }
    return summary;
  }

  private revision(store: ScheduleStore, schedule: StoredSchedule): ScheduleRevisionView | null {
    return store.getRevision(schedule.workspaceId, schedule.id, schedule.revision);
  }
  private projectOf(definition: ScheduleDefinition): string | null {
    return definition.selection.pinned[0]?.projectId ?? null;
  }
  private emit(
    database: PersistenceDatabase,
    schedule: StoredSchedule,
    type: "schedule.misfire" | "schedule.paused",
    payload: Record<string, unknown>,
  ): void {
    const definition = this.revision(new ScheduleStore(database), schedule)?.definition;
    new OutboxRepository(database).append(schedule.workspaceId, schedule.id, type, {
      scheduleId: schedule.id,
      projectId: definition ? this.projectOf(definition) : null,
      ...payload,
    });
  }

  /** Cheap, SQL-only ownership checks run for every active schedule on every tick. */
  private ownerProblem(
    database: PersistenceDatabase,
    schedule: StoredSchedule,
    nowMs: number,
  ): string | null {
    const principal = database.get(
      "SELECT disabled_at FROM principals WHERE workspace_id=? AND id=?",
      schedule.workspaceId,
      schedule.ownerId,
    );
    if (!principal || principal.disabled_at) return "The owner was removed or disabled";
    const membership = database.get(
      "SELECT 1 AS present FROM memberships WHERE workspace_id=? AND principal_id=?",
      schedule.workspaceId,
      schedule.ownerId,
    );
    if (!membership) return "The owner is no longer a member of the workspace";
    if (schedule.ownerCredential.id) {
      const token = database.get(
        "SELECT revoked_at,expires_at FROM server_tokens WHERE workspace_id=? AND id=?",
        schedule.workspaceId,
        schedule.ownerCredential.id,
      );
      if (!token || token.revoked_at || Date.parse(String(token.expires_at)) <= nowMs)
        return "The credential the schedule was created with was revoked or expired";
    }
    return null;
  }
  private ownerIdentity(
    database: PersistenceDatabase,
    schedule: StoredSchedule,
  ): AuthenticatedIdentity {
    let scopes: AuthenticatedIdentity["scopes"] = ["R", "X"];
    let grants: PermissionGrant[] = [];
    let credential: AuthenticatedIdentity["credential"] = {
      kind: "system",
      id: `schedule:${schedule.id}`,
    };
    if (schedule.ownerCredential.id) {
      const token = database.get(
        "SELECT data_json FROM server_tokens WHERE workspace_id=? AND id=?",
        schedule.workspaceId,
        schedule.ownerCredential.id,
      );
      const data = JSON.parse(String(token?.data_json ?? "{}")) as Partial<TokenData>;
      scopes = data.scopes ?? [];
      grants = data.grants ?? [];
      credential = { kind: "api", id: schedule.ownerCredential.id };
    }
    return {
      principalId: schedule.ownerId,
      scopes,
      ...(grants.length ? { grants } : {}),
      workspaceId: schedule.workspaceId,
      credential,
    };
  }
  private application(schedule: StoredSchedule, database: PersistenceDatabase): Application {
    const application = this.scope.forIdentity(this.ownerIdentity(database, schedule));
    this.options.configureApplication?.(application);
    return application;
  }
  private systemApplication(workspaceId: string, apps: Map<string, Application>): Application {
    let application = apps.get(workspaceId);
    if (!application) {
      application = this.scope.forWorkspaceSystem(workspaceId);
      apps.set(workspaceId, application);
    }
    return application;
  }

  private pause(
    schedule: StoredSchedule,
    lease: Lease,
    nowMs: number,
    reason: PauseReason,
    detail: string,
  ): void {
    const database = this.databaseFor(schedule.workspaceId);
    const store = new ScheduleStore(database);
    database.withTx(() => {
      this.guard(database, lease);
      const fresh = store.getSchedule(schedule.workspaceId, schedule.id);
      if (!fresh || fresh.state !== "active") return;
      const at = iso(nowMs);
      const next: StoredSchedule = {
        ...fresh,
        state: "paused",
        pauseReason: reason,
        pausedAt: at,
        nextFireAt: null,
        version: fresh.version + 1,
        updatedAt: at,
      };
      if (!store.updateSchedule(next, fresh.version)) return;
      this.emit(database, next, "schedule.paused", {
        reasonCode: reason === "owner_revoked" ? "owner_revoked" : null,
        pauseReason: reason,
        detail,
      });
      auditAs(
        { database, workspaceId: next.workspaceId, actor: "system:scheduler" },
        "schedules.pause",
        next.id,
        "allowed",
      );
    });
  }

  /** Pauses after N consecutive failed gates; a passed or still-running batch resets the count. */
  private autoPause(
    schedule: StoredSchedule,
    lease: Lease,
    nowMs: number,
    apps: Map<string, Application>,
  ): boolean {
    const last = this.evaluated.get(schedule.id) ?? 0;
    if (nowMs - last < AUTO_PAUSE_EVALUATION_MS && nowMs >= last) return false;
    this.evaluated.set(schedule.id, nowMs);
    const store = this.storeFor(schedule.workspaceId);
    const definition = this.revision(store, schedule)?.definition;
    if (!definition) return false;
    const limit = definition.budget.autoPauseAfterFailures;
    const recent = store.recentDispatched(schedule.workspaceId, schedule.id, limit);
    if (recent.length < limit) return false;
    const system = this.systemApplication(schedule.workspaceId, apps);
    const allFailed = recent.every(
      (firing) =>
        firing.batchId !== null &&
        (system.batches.get(firing.batchId).aggregate as { gate: string }).gate === "failed",
    );
    if (!allFailed) return false;
    this.pause(
      schedule,
      lease,
      nowMs,
      "auto_paused_failures",
      `The last ${limit} runs of this schedule failed their gate`,
    );
    return true;
  }

  private claimed(
    schedule: StoredSchedule,
    occurrence: Occurrence,
    lease: Lease,
    nowMs: number,
    tzdataVersion: string,
  ): StoredFiring {
    return {
      id: `sfr_${randomUUID()}`,
      workspaceId: schedule.workspaceId,
      scheduleId: schedule.id,
      revision: schedule.revision,
      fireInstant: occurrence.fireAt,
      state: "claimed",
      reasonCode: null,
      batchId: null,
      decidedAt: null,
      missedCount: 0,
      leaseFence: lease.fence,
      version: 1,
      createdAt: iso(nowMs),
      data: {
        localTime: occurrence.localTime,
        dst: occurrence.dst,
        detail: null,
        missedUntil: null,
        memberCount: 0,
        tzdataVersion,
      },
    };
  }

  /**
   * Turns the elapsed window (cursor, now] into firings in one transaction: occurrences within the
   * grace period are claimed, the rest follow the misfire policy and are recorded as one aggregated
   * row so a long outage never creates thousands of rows.
   */
  private plan(schedule: StoredSchedule, lease: Lease, nowMs: number): number {
    const database = this.databaseFor(schedule.workspaceId);
    const store = new ScheduleStore(database);
    const revision = this.revision(store, schedule);
    if (!revision) return 0;
    const definition = revision.definition;
    const cursorMs = Date.parse(schedule.cursorAt);
    // A clock that moved back never re-fires: the cursor only moves forward.
    if (nowMs <= cursorMs) return 0;
    if (definition.expiresAt && Date.parse(definition.expiresAt) <= nowMs) {
      this.pause(schedule, lease, nowMs, "expired", "The schedule reached its expiry");
      return 0;
    }
    const trigger = compileTrigger(definition.trigger);
    const { misfire } = definition;
    const window = occurrencesBetween(trigger, cursorMs, nowMs, {
      keepFirst: 1,
      keepLast: misfire.maxCatchUp,
      cap: OCCURRENCE_CAP,
    });
    const candidates = window.occurrences.slice(-misfire.maxCatchUp);
    const lateBefore = nowMs - misfire.graceSeconds * 1000;
    const onTime = candidates.filter((item) => item.instantMs > lateBefore);
    const late = candidates.filter((item) => item.instantMs <= lateBefore);
    let dispatch = [...onTime];
    if (misfire.policy === "fire_once" && !dispatch.length && late.length)
      dispatch = [late[late.length - 1] as Occurrence];
    if (misfire.policy === "catch_up")
      dispatch = [
        ...late.filter((item) => item.instantMs >= nowMs - misfire.catchUpWindowSeconds * 1000),
        ...onTime,
      ];
    const dispatched = new Set(dispatch.map((item) => item.instantMs));
    const skipped = candidates.filter((item) => !dispatched.has(item.instantMs));
    const missedCount = window.count - dispatch.length;
    const markers = gapMarkersBetween(trigger, cursorMs, nowMs, 20);
    const next = nextOccurrences(trigger, nowMs, 1)[0]?.fireAt ?? null;
    let created = 0;
    try {
      database.withTx(() => {
        this.guard(database, lease);
        const fresh = store.getSchedule(schedule.workspaceId, schedule.id);
        if (!fresh || fresh.state !== "active" || fresh.cursorAt !== schedule.cursorAt)
          throw new PlanSkipped();
        for (const item of dispatch)
          if (store.insertFiring(this.claimed(fresh, item, lease, nowMs, revision.tzdataVersion)))
            created++;
        if (missedCount > 0) {
          const anchor =
            window.count > candidates.length
              ? (window.first as Occurrence)
              : (skipped[0] as Occurrence);
          const aggregate = this.claimed(fresh, anchor, lease, nowMs, revision.tzdataVersion);
          const row: StoredFiring = {
            ...aggregate,
            state: "misfire",
            reasonCode: "schedule_misfire",
            decidedAt: iso(nowMs),
            missedCount,
            data: {
              ...aggregate.data,
              missedUntil: skipped.at(-1)?.fireAt ?? null,
              detail: `${window.capped ? "At least " : ""}${missedCount} occurrence(s) were not run (${misfire.policy})`,
            },
          };
          if (store.insertFiring(row))
            this.emit(database, fresh, "schedule.misfire", {
              reasonCode: "schedule_misfire",
              firingId: row.id,
              missedCount,
            });
        }
        for (const marker of markers) {
          const row = this.claimed(fresh, marker, lease, nowMs, revision.tzdataVersion);
          store.insertFiring({
            ...row,
            state: "skipped",
            decidedAt: iso(nowMs),
            data: { ...row.data, detail: "The local time does not exist (DST gap)" },
          });
        }
        if (!store.advance(fresh.workspaceId, fresh.id, fresh.cursorAt, iso(nowMs), next))
          throw new PlanSkipped();
      });
    } catch (error) {
      // Someone changed the schedule meanwhile; the next tick re-reads it.
      if (error instanceof PlanSkipped) return 0;
      throw error;
    }
    return created;
  }

  /** Writes a terminal state; false when another leader already decided this firing. */
  private decide(
    drive: Drive,
    state: Exclude<FiringState, "claimed" | "waiting">,
    reasonCode: string | null,
    detail: string,
    extra: { batchId?: string; memberCount?: number; frozen?: FiringFrozen } = {},
  ): Step {
    const { database, store, firing, lease, nowMs } = drive;
    database.withTx(() => {
      this.guard(database, lease);
      store.updateFiring({
        ...firing,
        state,
        reasonCode,
        batchId: extra.batchId ?? null,
        decidedAt: iso(nowMs),
        leaseFence: lease.fence,
        data: {
          ...firing.data,
          detail,
          memberCount: extra.memberCount ?? firing.data.memberCount,
          ...(extra.frozen ? { frozen: extra.frozen } : {}),
        },
      });
    });
    return finished;
  }
  /** Keeps the firing open (waiting) with the reason, or decides `expired` once its deadline passed. */
  private hold(
    drive: Drive,
    detail: string,
    deadlineMs: number,
    expired: { state: "misfire" | "blocked"; reasonCode: string },
  ): Step {
    if (drive.nowMs > deadlineMs)
      return this.decide(drive, expired.state, expired.reasonCode, detail);
    const { database, store, firing, lease } = drive;
    database.withTx(() => {
      this.guard(database, lease);
      store.updateFiring({
        ...firing,
        state: "waiting",
        leaseFence: lease.fence,
        data: { ...firing.data, detail },
      });
    });
    return finished;
  }

  private async drive(
    firing: StoredFiring,
    lease: Lease,
    nowMs: number,
    apps: Map<string, Application>,
  ): Promise<"dispatched" | "other"> {
    const database = this.databaseFor(firing.workspaceId);
    const store = new ScheduleStore(database);
    const schedule = store.getSchedule(firing.workspaceId, firing.scheduleId);
    const revision = store.getRevision(firing.workspaceId, firing.scheduleId, firing.revision);
    // A missing schedule or revision cannot happen (foreign keys); the firing stays pending.
    if (!schedule || !revision) return "other";
    return this.evaluate(
      { firing, schedule, definition: revision.definition, store, database, lease, nowMs },
      apps,
    );
  }

  private async evaluate(
    drive: Drive,
    apps: Map<string, Application>,
  ): Promise<"dispatched" | "other"> {
    const { schedule, firing, definition, nowMs } = drive;
    if (schedule.state === "archived") {
      this.decide(drive, "skipped", null, "The schedule was archived before this firing ran");
      return "other";
    }
    if (schedule.state === "paused") {
      const revoked = schedule.pauseReason === "owner_revoked";
      this.decide(
        drive,
        revoked ? "blocked" : "skipped",
        revoked ? "owner_revoked" : null,
        `The schedule was paused (${schedule.pauseReason}) before this firing ran`,
      );
      return "other";
    }
    if (schedule.revision !== firing.revision) {
      this.decide(drive, "skipped", null, "The schedule definition changed before this firing ran");
      return "other";
    }
    if (definition.expiresAt && Date.parse(definition.expiresAt) <= nowMs) {
      this.pause(schedule, drive.lease, nowMs, "expired", "The schedule reached its expiry");
      this.decide(drive, "skipped", null, "The schedule expired");
      return "other";
    }
    const problem = this.ownerProblem(drive.database, schedule, nowMs);
    if (problem) return this.ownerRevoked(drive, problem);
    const owner = this.application(schedule, drive.database);
    try {
      owner.context.authorize("X");
    } catch (error) {
      if (error instanceof ContractError && ["FORBIDDEN", "UNAUTHENTICATED"].includes(error.code))
        return this.ownerRevoked(drive, "The owner may no longer execute in the workspace");
      throw error;
    }
    const system = this.systemApplication(firing.workspaceId, apps);
    const waiting = this.dependencies(drive, system);
    if (waiting.kind === "done") return "other";
    const overlap = this.overlap(drive, system, owner);
    if (overlap.kind === "done") return "other";

    let frozen = firing.data.frozen;
    if (!frozen) {
      let resolved: ReturnType<Application["schedules"]["resolveSelection"]>;
      try {
        resolved = owner.schedules.resolveSelection(definition);
      } catch (error) {
        if (error instanceof ContractError && ["FORBIDDEN", "UNAUTHENTICATED"].includes(error.code))
          return this.ownerRevoked(drive, "The owner may no longer read the scheduled list");
        if (error instanceof ContractError) {
          this.decide(drive, "blocked", "upstream_failed", error.message);
          return "other";
        }
        throw error;
      }
      const { expansion, requests } = resolved;
      if (expansion.exclusions.length || !requests.length) {
        // No human can confirm a subset here, so a dropped member blocks the firing instead of shrinking it.
        if (expansion.exclusions.some((item) => item.kind === "access_denied"))
          return this.ownerRevoked(drive, "The owner lost access to part of the scheduled list");
        this.decide(
          drive,
          "blocked",
          "upstream_failed",
          expansion.exclusions.length
            ? `Scheduled list members are unavailable: ${expansion.exclusions.map((item) => item.key).join(", ")}`
            : "The scheduled list has no runnable member",
        );
        return "other";
      }
      const entities = new EntityRepository(drive.database);
      const fingerprint: Record<string, number | null> = {};
      for (const mapping of expansion.mapping)
        for (const id of mapping.secretRefs) {
          const secret = entities.get("SecretReference", firing.workspaceId, id);
          fingerprint[id] = secret && !secret.revokedAt ? Number(secret.secretVersion) : null;
        }
      const created: FiringFrozen = {
        requests,
        expansion: expansion as unknown as Record<string, unknown>,
        secretFingerprint: fingerprint,
      };
      frozen = created;
      drive.database.withTx(() => {
        this.guard(drive.database, drive.lease);
        drive.store.updateFiring({
          ...firing,
          data: { ...firing.data, memberCount: requests.length, frozen: created },
        });
      });
      drive.firing = {
        ...firing,
        data: { ...firing.data, memberCount: requests.length, frozen: created },
      };
    }
    return this.admit(drive, owner, frozen);
  }

  private ownerRevoked(drive: Drive, detail: string): "other" {
    this.pause(drive.schedule, drive.lease, drive.nowMs, "owner_revoked", detail);
    this.decide(drive, "blocked", "owner_revoked", detail);
    return "other";
  }

  /** Upstream schedules must have produced a run (since this schedule last fired) that satisfies the condition. */
  private dependencies(drive: Drive, system: Application): Step {
    const { definition, firing, store } = drive;
    if (!definition.dependsOn.length) return proceed;
    const fireMs = Date.parse(firing.fireInstant);
    const previous = store.latestFiringBefore(
      firing.workspaceId,
      firing.scheduleId,
      firing.fireInstant,
    );
    const lower = previous?.fireInstant ?? iso(0);
    for (const dependency of definition.dependsOn) {
      const candidates = store.firingsBetween(
        firing.workspaceId,
        dependency.scheduleId,
        lower,
        firing.fireInstant,
      );
      const deadline = fireMs + dependency.timeoutSeconds * 1000;
      const latest = candidates[0];
      if (!latest)
        return this.hold(drive, `Waiting for schedule ${dependency.scheduleId}`, deadline, {
          state: "blocked",
          reasonCode: "upstream_failed",
        });
      if (latest.state === "claimed" || latest.state === "waiting")
        return this.hold(drive, `Waiting for schedule ${dependency.scheduleId}`, deadline, {
          state: "blocked",
          reasonCode: "upstream_failed",
        });
      if (latest.state !== "dispatched" || !latest.batchId)
        return this.decide(
          drive,
          "skipped",
          "upstream_failed",
          `Upstream schedule ${dependency.scheduleId} did not run (${latest.state})`,
        );
      const gate = (system.batches.get(latest.batchId).aggregate as { gate: string }).gate;
      if (gate === "pending")
        return this.hold(
          drive,
          `Upstream schedule ${dependency.scheduleId} is still running`,
          deadline,
          {
            state: "blocked",
            reasonCode: "upstream_failed",
          },
        );
      const satisfied =
        dependency.condition === "terminal" ||
        (dependency.condition === "passed" && gate === "passed") ||
        (dependency.condition === "failed" && gate === "failed");
      if (!satisfied)
        return this.decide(
          drive,
          "skipped",
          "upstream_failed",
          `Upstream gate is ${gate}; the dependency requires ${dependency.condition}`,
        );
    }
    return proceed;
  }

  /** Batches this schedule dispatched that are still running. */
  private activeBatches(drive: Drive, system: Application): string[] {
    return drive.store
      .recentDispatched(drive.firing.workspaceId, drive.firing.scheduleId, 50)
      .filter((other) => other.id !== drive.firing.id && other.batchId)
      .map((other) => other.batchId as string)
      .filter(
        (batchId) => (system.batches.get(batchId).aggregate as { gate: string }).gate === "pending",
      );
  }
  private overlap(drive: Drive, system: Application, owner: Application): Step {
    const { definition, firing } = drive;
    if (definition.overlap === "allow") return proceed;
    const active = this.activeBatches(drive, system);
    if (!active.length) return proceed;
    if (definition.overlap === "forbid")
      return this.decide(
        drive,
        "overlap",
        "schedule_overlap",
        `A previous run of this schedule is still running (${active.join(", ")})`,
      );
    // replace: cancel durably, then wait until the old runs stopped before starting the new batch.
    for (const batchId of active) {
      for (const runId of system.batches.get(batchId).memberRuns as string[]) {
        owner.runs.cancel(runId);
      }
      auditAs(
        { database: drive.database, workspaceId: firing.workspaceId, actor: "system:scheduler" },
        "schedules.overlap_replace",
        batchId,
        "allowed",
      );
    }
    return this.hold(
      drive,
      `Waiting for the replaced run(s) to stop (${active.join(", ")})`,
      Date.parse(firing.fireInstant) + definition.replaceTimeoutSeconds * 1000,
      { state: "blocked", reasonCode: "schedule_overlap" },
    );
  }

  private async admit(
    drive: Drive,
    owner: Application,
    frozen: FiringFrozen,
  ): Promise<"dispatched" | "other"> {
    const { definition, firing, store, schedule, nowMs } = drive;
    const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
    const today = store.dispatchedSince(firing.workspaceId, firing.scheduleId, iso(dayStart));
    const { budget } = definition;
    const runsToday = today.reduce((sum, item) => sum + item.data.memberCount, 0);
    if (
      today.length >= budget.maxFiresPerDay ||
      runsToday + frozen.requests.length > budget.maxRunsPerDay
    ) {
      this.decide(drive, "skipped", "budget_exhausted", "The daily firing or run budget is spent");
      return "other";
    }
    if (definition.secrets.onChange === "pause") {
      const previous = store.recentDispatched(firing.workspaceId, firing.scheduleId, 1)[0];
      const before = previous?.data.frozen?.secretFingerprint;
      if (before && JSON.stringify(before) !== JSON.stringify(frozen.secretFingerprint)) {
        this.pause(
          schedule,
          drive.lease,
          nowMs,
          "secret_changed",
          "A secret used by this schedule changed",
        );
        this.decide(
          drive,
          "skipped",
          null,
          "A secret used by this schedule changed; the schedule was paused",
        );
        return "other";
      }
    }
    try {
      const receipt = await owner.suites.admit(
        frozen.expansion as never,
        frozen.requests as never,
        { healingPolicy: definition.healingPolicy === "propose" ? "propose" : "off" },
        {
          origin: "schedule",
          scheduleId: schedule.id,
          idempotencyKey: `sched:${firing.id}`,
          guard: () => this.guard(drive.database, drive.lease),
        },
      );
      this.decide(drive, "dispatched", null, "Batch admitted", {
        batchId: receipt.batchId,
        memberCount: receipt.requested,
      });
      return "dispatched";
    } catch (error) {
      if (error instanceof LeaseLost) throw error;
      if (!(error instanceof ContractError)) throw error;
      if (error.details.lease === "lost") throw new LeaseLost();
      const noWorker =
        error.code === "PRECONDITION_FAILED" &&
        Array.isArray(error.details.nextActions) &&
        error.details.nextActions.includes("worker start");
      if (noWorker) {
        this.hold(
          drive,
          "No live worker; waiting until one is available",
          Date.parse(firing.fireInstant) + definition.misfire.graceSeconds * 1000,
          { state: "misfire", reasonCode: "schedule_misfire" },
        );
        return "other";
      }
      if (["FORBIDDEN", "UNAUTHENTICATED"].includes(error.code)) {
        this.ownerRevoked(drive, error.message);
        return "other";
      }
      const reasonCode =
        error.code === "QUOTA_EXCEEDED" || error.code === "RATE_LIMITED"
          ? "quota_exceeded"
          : error.details.secretRef
            ? "credential_revoked"
            : "upstream_failed";
      this.decide(drive, "blocked", reasonCode, error.message);
      return "other";
    }
  }
}

/** Registers the scheduler in the controller registry; local mode runs it too (OPS-016). */
export function schedulerController(options: SchedulerOptions = {}): Controller {
  let scheduler: Scheduler | null = null;
  return {
    name: "scheduler",
    intervalMs: 5000,
    local: true,
    async run(scope) {
      scheduler ??= new Scheduler(scope, options);
      await scheduler.tick();
    },
  };
}
