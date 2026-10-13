import type {
  ScheduleDefinition,
  ScheduledFire,
  ScheduleRevisionView,
} from "@testmaster/contracts";
import type { PersistenceDatabase } from "@testmaster/persistence";

type Row = Record<string, unknown>;
export type ScheduleState = "active" | "paused" | "archived";
export type PauseReason =
  | "manual"
  | "owner_revoked"
  | "auto_paused_failures"
  | "secret_changed"
  | "expired";
export type FiringState =
  | "claimed"
  | "waiting"
  | "dispatched"
  | "skipped"
  | "misfire"
  | "overlap"
  | "blocked";

/** The owner's credential: an API token ends with the schedule's authority; sessions never do. */
export interface OwnerCredential {
  kind: "api" | null;
  id: string | null;
}
export interface StoredSchedule {
  id: string;
  workspaceId: string;
  name: string;
  state: ScheduleState;
  pauseReason: PauseReason | null;
  pausedAt: string | null;
  ownerId: string;
  ownerCredential: OwnerCredential;
  revision: number;
  version: number;
  cursorAt: string;
  nextFireAt: string | null;
  createdAt: string;
  updatedAt: string;
}
/** Frozen inputs of one firing, written before admission so a re-drive after a crash reuses them. */
export interface FiringFrozen {
  requests: unknown[];
  expansion: Record<string, unknown>;
  secretFingerprint: Record<string, number | null>;
}
export interface StoredFiring {
  id: string;
  workspaceId: string;
  scheduleId: string;
  revision: number;
  fireInstant: string;
  state: FiringState;
  reasonCode: string | null;
  batchId: string | null;
  decidedAt: string | null;
  missedCount: number;
  leaseFence: number;
  version: number;
  createdAt: string;
  data: {
    localTime: string;
    dst: ScheduledFire["dst"];
    detail: string | null;
    missedUntil: string | null;
    memberCount: number;
    tzdataVersion: string;
    frozen?: FiringFrozen;
  };
}
export interface Lease {
  holder: string;
  fence: number;
  acquiredAt: string;
  expiresAt: string;
}

interface ScheduleRowData {
  ownerCredential: OwnerCredential;
  pausedAt: string | null;
}
export function decodeSchedule(row: Row): StoredSchedule {
  const data = JSON.parse(String(row.data_json)) as ScheduleRowData;
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    state: String(row.state) as ScheduleState,
    pauseReason: row.pause_reason === null ? null : (String(row.pause_reason) as PauseReason),
    pausedAt: data.pausedAt ?? null,
    ownerId: String(row.owner_id),
    ownerCredential: data.ownerCredential,
    revision: Number(row.revision),
    version: Number(row.version),
    cursorAt: String(row.cursor_at),
    nextFireAt: row.next_fire_at === null ? null : String(row.next_fire_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
export function decodeRevision(row: Row): ScheduleRevisionView {
  return {
    id: `${String(row.schedule_id)}@${Number(row.revision)}`,
    scheduleId: String(row.schedule_id),
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    createdBy: String(row.created_by),
    tzdataVersion: String(row.tzdata_version),
    definition: JSON.parse(String(row.data_json)) as ScheduleDefinition,
  } as ScheduleRevisionView;
}
export function decodeFiring(row: Row): StoredFiring {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    scheduleId: String(row.schedule_id),
    revision: Number(row.revision),
    fireInstant: String(row.fire_instant),
    state: String(row.state) as FiringState,
    reasonCode: row.reason_code === null ? null : String(row.reason_code),
    batchId: row.batch_id === null ? null : String(row.batch_id),
    decidedAt: row.decided_at === null ? null : String(row.decided_at),
    missedCount: Number(row.missed_count),
    leaseFence: Number(row.lease_fence),
    version: Number(row.version),
    createdAt: String(row.created_at),
    data: JSON.parse(String(row.data_json)) as StoredFiring["data"],
  };
}
export function firingView(firing: StoredFiring): ScheduledFire {
  return {
    id: firing.id,
    scheduleId: firing.scheduleId,
    revision: firing.revision,
    scheduledAt: firing.fireInstant,
    createdAt: firing.createdAt,
    localTime: firing.data.localTime,
    decidedAt: firing.decidedAt,
    state: firing.state,
    ...(firing.reasonCode ? { reasonCode: firing.reasonCode } : {}),
    detail: firing.data.detail,
    batchId: firing.batchId,
    dst: firing.data.dst,
    missedCount: firing.missedCount,
    missedUntil: firing.data.missedUntil,
    tzdataVersion: firing.data.tzdataVersion,
    memberCount: firing.data.memberCount,
  } as ScheduledFire;
}

/** SQL for schedules, revisions, firings and the scheduler lease; shared by the service and the scheduler. */
export class ScheduleStore {
  constructor(readonly database: PersistenceDatabase) {}

  getSchedule(workspaceId: string, id: string): StoredSchedule | null {
    const row = this.database.get(
      "SELECT * FROM schedules WHERE workspace_id=? AND id=?",
      workspaceId,
      id,
    );
    return row ? decodeSchedule(row) : null;
  }
  listSchedules(workspaceId: string): StoredSchedule[] {
    return this.database
      .all(
        "SELECT * FROM schedules WHERE workspace_id=? AND state<>'archived' ORDER BY created_at DESC,id DESC",
        workspaceId,
      )
      .map(decodeSchedule);
  }
  /** Active schedules across every workspace (controller scope). */
  activeSchedules(): StoredSchedule[] {
    return this.database
      .all("SELECT * FROM schedules WHERE state='active' ORDER BY next_fire_at,id")
      .map(decodeSchedule);
  }
  insertSchedule(
    schedule: StoredSchedule,
    extra: { ownerCredential: OwnerCredential; pausedAt: string | null },
  ): void {
    this.database.run(
      "INSERT INTO schedules(workspace_id,id,created_at,version,data_json,name,state,pause_reason,revision,owner_id,cursor_at,next_fire_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      schedule.workspaceId,
      schedule.id,
      schedule.createdAt,
      schedule.version,
      JSON.stringify(extra),
      schedule.name,
      schedule.state,
      schedule.pauseReason,
      schedule.revision,
      schedule.ownerId,
      schedule.cursorAt,
      schedule.nextFireAt,
      schedule.updatedAt,
    );
  }
  /** Compare-and-set on the version; returns false when someone else changed the schedule first. */
  updateSchedule(next: StoredSchedule, expectedVersion: number): boolean {
    return (
      this.database.run(
        "UPDATE schedules SET version=?,data_json=?,name=?,state=?,pause_reason=?,revision=?,owner_id=?,cursor_at=?,next_fire_at=?,updated_at=? WHERE workspace_id=? AND id=? AND version=?",
        next.version,
        JSON.stringify({ ownerCredential: next.ownerCredential, pausedAt: next.pausedAt }),
        next.name,
        next.state,
        next.pauseReason,
        next.revision,
        next.ownerId,
        next.cursorAt,
        next.nextFireAt,
        next.updatedAt,
        next.workspaceId,
        next.id,
        expectedVersion,
      ).changes > 0
    );
  }
  insertRevision(
    workspaceId: string,
    scheduleId: string,
    revision: number,
    createdBy: string,
    tzdataVersion: string,
    definition: ScheduleDefinition,
  ): void {
    this.database.run(
      "INSERT INTO schedule_revisions(workspace_id,schedule_id,revision,created_at,created_by,tzdata_version,data_json) VALUES(?,?,?,?,?,?,?)",
      workspaceId,
      scheduleId,
      revision,
      new Date().toISOString(),
      createdBy,
      tzdataVersion,
      JSON.stringify(definition),
    );
  }
  getRevision(
    workspaceId: string,
    scheduleId: string,
    revision: number,
  ): ScheduleRevisionView | null {
    const row = this.database.get(
      "SELECT * FROM schedule_revisions WHERE workspace_id=? AND schedule_id=? AND revision=?",
      workspaceId,
      scheduleId,
      revision,
    );
    return row ? decodeRevision(row) : null;
  }
  listRevisions(workspaceId: string, scheduleId: string): ScheduleRevisionView[] {
    return this.database
      .all(
        "SELECT * FROM schedule_revisions WHERE workspace_id=? AND schedule_id=? ORDER BY revision DESC",
        workspaceId,
        scheduleId,
      )
      .map(decodeRevision);
  }

  getFiring(workspaceId: string, id: string): StoredFiring | null {
    const row = this.database.get(
      "SELECT * FROM schedule_firings WHERE workspace_id=? AND id=?",
      workspaceId,
      id,
    );
    return row ? decodeFiring(row) : null;
  }
  /** Newest first; `before` is a keyset on (fire_instant,id). */
  listFirings(
    workspaceId: string,
    scheduleId: string,
    options: { limit: number; before?: { fireInstant: string; id: string } },
  ): StoredFiring[] {
    return this.database
      .all(
        `SELECT * FROM schedule_firings WHERE workspace_id=? AND schedule_id=? ${
          options.before ? "AND (fire_instant<? OR (fire_instant=? AND id<?))" : ""
        } ORDER BY fire_instant DESC,id DESC LIMIT ?`,
        workspaceId,
        scheduleId,
        ...(options.before
          ? [options.before.fireInstant, options.before.fireInstant, options.before.id]
          : []),
        options.limit,
      )
      .map(decodeFiring);
  }
  pendingFirings(): StoredFiring[] {
    return this.database
      .all(
        "SELECT * FROM schedule_firings WHERE state IN ('claimed','waiting') ORDER BY fire_instant,id",
      )
      .map(decodeFiring);
  }
  /** Inserts a firing; false when its (schedule, revision, instant) key already exists. */
  insertFiring(firing: StoredFiring): boolean {
    const existing = this.database.get(
      "SELECT id FROM schedule_firings WHERE workspace_id=? AND schedule_id=? AND revision=? AND fire_instant=?",
      firing.workspaceId,
      firing.scheduleId,
      firing.revision,
      firing.fireInstant,
    );
    if (existing) return false;
    this.database.run(
      "INSERT INTO schedule_firings(workspace_id,id,created_at,version,data_json,schedule_id,revision,fire_instant,state,reason_code,batch_id,decided_at,missed_count,lease_fence) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      firing.workspaceId,
      firing.id,
      firing.createdAt,
      firing.version,
      JSON.stringify(firing.data),
      firing.scheduleId,
      firing.revision,
      firing.fireInstant,
      firing.state,
      firing.reasonCode,
      firing.batchId,
      firing.decidedAt,
      firing.missedCount,
      firing.leaseFence,
    );
    return true;
  }
  /** Moves a claimed or waiting firing forward; false if it was already decided. */
  updateFiring(firing: StoredFiring): boolean {
    return (
      this.database.run(
        "UPDATE schedule_firings SET version=version+1,data_json=?,state=?,reason_code=?,batch_id=?,decided_at=?,missed_count=?,lease_fence=? WHERE workspace_id=? AND id=? AND state IN ('claimed','waiting')",
        JSON.stringify(firing.data),
        firing.state,
        firing.reasonCode,
        firing.batchId,
        firing.decidedAt,
        firing.missedCount,
        firing.leaseFence,
        firing.workspaceId,
        firing.id,
      ).changes > 0
    );
  }
  dispatchedSince(workspaceId: string, scheduleId: string, sinceIso: string): StoredFiring[] {
    return this.database
      .all(
        "SELECT * FROM schedule_firings WHERE workspace_id=? AND schedule_id=? AND state='dispatched' AND decided_at>=? ORDER BY fire_instant DESC,id DESC",
        workspaceId,
        scheduleId,
        sinceIso,
      )
      .map(decodeFiring);
  }
  /**
   * Moves the evaluation cursor without touching `version`, so a user's If-Match is never
   * invalidated by the scheduler. Compare-and-set on the cursor the caller read.
   */
  advance(
    workspaceId: string,
    id: string,
    seenCursor: string,
    cursorAt: string,
    nextFireAt: string | null,
  ): boolean {
    return (
      this.database.run(
        "UPDATE schedules SET cursor_at=?,next_fire_at=? WHERE workspace_id=? AND id=? AND state='active' AND cursor_at=?",
        cursorAt,
        nextFireAt,
        workspaceId,
        id,
        seenCursor,
      ).changes > 0
    );
  }
  firingsBetween(
    workspaceId: string,
    scheduleId: string,
    afterInstant: string,
    uptoInstant: string,
  ): StoredFiring[] {
    return this.database
      .all(
        "SELECT * FROM schedule_firings WHERE workspace_id=? AND schedule_id=? AND fire_instant>? AND fire_instant<=? ORDER BY fire_instant DESC,id DESC",
        workspaceId,
        scheduleId,
        afterInstant,
        uptoInstant,
      )
      .map(decodeFiring);
  }
  latestFiringBefore(
    workspaceId: string,
    scheduleId: string,
    instant: string,
  ): StoredFiring | null {
    const row = this.database.get(
      "SELECT * FROM schedule_firings WHERE workspace_id=? AND schedule_id=? AND fire_instant<? ORDER BY fire_instant DESC,id DESC LIMIT 1",
      workspaceId,
      scheduleId,
      instant,
    );
    return row ? decodeFiring(row) : null;
  }
  recentDispatched(workspaceId: string, scheduleId: string, limit: number): StoredFiring[] {
    return this.database
      .all(
        "SELECT * FROM schedule_firings WHERE workspace_id=? AND schedule_id=? AND state='dispatched' ORDER BY fire_instant DESC,id DESC LIMIT ?",
        workspaceId,
        scheduleId,
        limit,
      )
      .map(decodeFiring);
  }

  lease(name: string): Lease | null {
    const row = this.database.get(
      "SELECT holder,fence,acquired_at,expires_at FROM scheduler_leases WHERE name=?",
      name,
    );
    return row
      ? {
          holder: String(row.holder),
          fence: Number(row.fence),
          acquiredAt: String(row.acquired_at),
          expiresAt: String(row.expires_at),
        }
      : null;
  }
  insertLease(name: string, lease: Lease): boolean {
    if (this.lease(name)) return false;
    this.database.run(
      "INSERT INTO scheduler_leases(name,holder,fence,acquired_at,expires_at) VALUES(?,?,?,?,?)",
      name,
      lease.holder,
      lease.fence,
      lease.acquiredAt,
      lease.expiresAt,
    );
    return true;
  }
  /** Updates only if the stored fence is the one the caller saw. */
  updateLease(name: string, seenFence: number, next: Lease): boolean {
    return (
      this.database.run(
        "UPDATE scheduler_leases SET holder=?,fence=?,acquired_at=?,expires_at=? WHERE name=? AND fence=?",
        next.holder,
        next.fence,
        next.acquiredAt,
        next.expiresAt,
        name,
        seenFence,
      ).changes > 0
    );
  }
  expireLease(name: string, holder: string, fence: number, atIso: string): void {
    this.database.run(
      "UPDATE scheduler_leases SET expires_at=? WHERE name=? AND holder=? AND fence=?",
      atIso,
      name,
      holder,
      fence,
    );
  }
}
