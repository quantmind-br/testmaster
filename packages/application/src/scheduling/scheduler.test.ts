import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Scheduler } from "./scheduler.js";
import { createScheduleWorld, type ScheduleWorld } from "./test-world.js";

const worlds: ScheduleWorld[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(async () => {
  vi.useRealTimers();
  for (const world of worlds.splice(0)) await world.close();
});
async function world(): Promise<ScheduleWorld> {
  // Rows are written before the test dates, so nothing looks like it comes from the future.
  vi.setSystemTime(Date.parse("2026-01-01T00:00:00Z"));
  const created = await createScheduleWorld();
  worlds.push(created);
  return created;
}
/** Moves the process clock and ticks the scheduler at exactly that instant. */
const tickAt = (scheduler: Scheduler, iso: string) => {
  const ms = Date.parse(iso);
  vi.setSystemTime(ms);
  return scheduler.tick(ms);
};
const setClock = (iso: string) => vi.setSystemTime(Date.parse(iso));
const firings = (w: ScheduleWorld, id: string) => w.app.schedules.firings(id);
const dispatched = (w: ScheduleWorld, id: string) =>
  firings(w, id).filter((firing) => firing.state === "dispatched");
const outbox = (w: ScheduleWorld, type: string) =>
  w.app.database.all("SELECT aggregate_id,data_json FROM outbox WHERE type=?", type);

it("OPS-016 OPS-017 a cron schedule fires once per occurrence and keeps the planned instant on the firing", async () => {
  const w = await world();
  setClock("2026-05-04T08:00:00Z");
  const schedule = w.schedule("daily");
  const scheduler = w.scheduler();
  expect((await tickAt(scheduler, "2026-05-04T08:59:00Z")).dispatched).toBe(0);
  expect(dispatched(w, schedule.id)).toHaveLength(0);
  const first = await tickAt(scheduler, "2026-05-04T09:00:10Z");
  expect(first).toMatchObject({ leader: true, claimed: 1, dispatched: 1 });
  const [fire] = dispatched(w, schedule.id);
  expect(fire?.scheduledAt).toBe("2026-05-04T09:00:00.000Z");
  const batch = w.app.context.entities.get("BatchRun", w.init.workspaceId, String(fire?.batchId));
  expect(batch?.scheduleId).toBe(schedule.id);
  const runs = ((batch?.memberRuns ?? []) as string[]).map((id) => w.app.runs.get(id));
  expect(runs).toHaveLength(2);
  expect(runs.every((run) => run.origin === "schedule")).toBe(true);
  // The same instant never fires twice, whatever the number of ticks.
  await tickAt(scheduler, "2026-05-04T09:00:20Z");
  await tickAt(scheduler, "2026-05-04T09:01:00Z");
  expect(dispatched(w, schedule.id)).toHaveLength(1);
  expect(w.batches()).toHaveLength(1);
  // The next day is a new occurrence once the previous batch finished (overlap defaults to forbid).
  w.finish(String(fire?.batchId), "passed");
  await tickAt(scheduler, "2026-05-05T09:00:05Z");
  expect(dispatched(w, schedule.id)).toHaveLength(2);
  expect(w.app.schedules.get(schedule.id).nextFireAt).toBe("2026-05-06T09:00:00.000Z");
});

it("OPS-016 the unique key (schedule, revision, instant) refuses a second firing for the same occurrence", async () => {
  const w = await world();
  setClock("2026-05-04T08:00:00Z");
  const schedule = w.schedule("unique");
  const scheduler = w.scheduler();
  await tickAt(scheduler, "2026-05-04T09:00:10Z");
  const store = w.app.schedules.store;
  const existing = store.listFirings(w.init.workspaceId, schedule.id, { limit: 10 })[0];
  if (!existing) throw new Error("expected a firing");
  expect(store.insertFiring({ ...existing, id: `sfr_${crypto.randomUUID()}` })).toBe(false);
  // Negative control: another instant is accepted.
  expect(
    store.insertFiring({
      ...existing,
      id: `sfr_${crypto.randomUUID()}`,
      fireInstant: "2026-05-05T09:00:00.000Z",
    }),
  ).toBe(true);
  expect(() =>
    w.app.database.run(
      "UPDATE schedule_firings SET fire_instant='2030-01-01T00:00:00.000Z' WHERE id=?",
      existing.id,
    ),
  ).toThrow();
});

it("OPS-016 a DST gap skips the nonexistent local time by default and after_gap fires once when the gap ends", async () => {
  const w = await world();
  setClock("2026-03-08T06:00:00Z");
  const skip = w.schedule("ny-skip", {
    trigger: { kind: "cron", cron: "30 2 * * *", timezone: "America/New_York" },
  });
  const after = w.schedule("ny-after", {
    trigger: {
      kind: "cron",
      cron: "30 2 * * *",
      timezone: "America/New_York",
      dstGap: "after_gap",
    },
  });
  const scheduler = w.scheduler();
  await tickAt(scheduler, "2026-03-08T07:00:30Z");
  await tickAt(scheduler, "2026-03-08T08:00:00Z");
  expect(dispatched(w, skip.id)).toHaveLength(0);
  expect(w.batches()).toHaveLength(1);
  // The removal is recorded when the window that contains it is planned, at the next real occurrence.
  await tickAt(scheduler, "2026-03-09T06:30:10Z");
  expect(dispatched(w, skip.id)).toHaveLength(1);
  expect(dispatched(w, skip.id)[0]?.scheduledAt).toBe("2026-03-09T06:30:00.000Z");
  const gap = firings(w, skip.id).find((fire) => fire.dst === "gap_skipped");
  expect(gap).toMatchObject({ state: "skipped", scheduledAt: "2026-03-08T07:00:00.000Z" });
  expect(gap?.batchId).toBeNull();
  // after_gap: one firing at 03:00 EDT (07:00Z), never two.
  const shifted = dispatched(w, after.id);
  expect(shifted).toHaveLength(1);
  expect(shifted[0]).toMatchObject({ scheduledAt: "2026-03-08T07:00:00.000Z", dst: "gap_shifted" });
});

it("OPS-016 a DST fold fires once by default and twice with both, in London as well as New York", async () => {
  const w = await world();
  setClock("2026-11-01T05:00:00Z");
  const once = w.schedule("ny-once", {
    trigger: { kind: "cron", cron: "30 1 * * *", timezone: "America/New_York" },
    overlap: "allow",
  });
  const both = w.schedule("ny-both", {
    trigger: {
      kind: "cron",
      cron: "30 1 * * *",
      timezone: "America/New_York",
      dstFold: "both",
    },
    overlap: "allow",
  });
  const scheduler = w.scheduler();
  await tickAt(scheduler, "2026-11-01T05:30:10Z");
  await tickAt(scheduler, "2026-11-01T06:30:10Z");
  expect(dispatched(w, once.id).map((fire) => fire.scheduledAt)).toEqual([
    "2026-11-01T05:30:00.000Z",
  ]);
  expect(dispatched(w, both.id).map((fire) => fire.scheduledAt)).toEqual([
    "2026-11-01T06:30:00.000Z",
    "2026-11-01T05:30:00.000Z",
  ]);
  expect(dispatched(w, both.id).map((fire) => fire.dst)).toEqual(["fold_second", "fold_first"]);

  setClock("2026-10-25T00:00:00Z");
  const london = w.schedule("london-once", {
    trigger: { kind: "cron", cron: "30 1 * * *", timezone: "Europe/London" },
    overlap: "allow",
  });
  await tickAt(scheduler, "2026-10-25T00:30:10Z");
  await tickAt(scheduler, "2026-10-25T01:30:10Z");
  expect(dispatched(w, london.id).map((fire) => fire.scheduledAt)).toEqual([
    "2026-10-25T00:30:00.000Z",
  ]);
});

it("OPS-016 an unknown timezone and a changed timezone are handled as data: refused, or a new revision", async () => {
  const w = await world();
  setClock("2026-05-04T08:00:00Z");
  expect(() =>
    w.schedule("bad-zone", {
      trigger: { kind: "cron", cron: "0 9 * * *", timezone: "Mars/Olympus" },
    }),
  ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  const schedule = w.schedule("zone");
  expect(schedule.revision).toBe(1);
  const moved = w.app.schedules.update(
    schedule.id,
    { trigger: { kind: "cron", cron: "0 9 * * *", timezone: "Asia/Tokyo" } },
    schedule.version,
  );
  expect(moved.revision).toBe(2);
  expect(w.app.schedules.revisions(schedule.id).map((item) => item.revision)).toEqual([2, 1]);
  expect(moved.nextFireAt).toBe("2026-05-05T00:00:00.000Z");
  // A name-only change is not a new definition.
  const renamed = w.app.schedules.update(schedule.id, { name: "zone-renamed" }, moved.version);
  expect(renamed.revision).toBe(2);
  expect(() =>
    w.app.database.run(
      "UPDATE schedule_revisions SET tzdata_version='x' WHERE schedule_id=?",
      schedule.id,
    ),
  ).toThrow();
});

it("OPS-017 skip records one aggregated misfire for a missed window and dispatches nothing", async () => {
  const w = await world();
  setClock("2026-05-04T10:00:00Z");
  const schedule = w.schedule("skip", {
    trigger: { kind: "cron", cron: "*/10 * * * *", timezone: "UTC" },
    misfire: { policy: "skip", graceSeconds: 60 },
  });
  const scheduler = w.scheduler();
  await tickAt(scheduler, "2026-05-04T11:05:00Z");
  const rows = firings(w, schedule.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    state: "misfire",
    reasonCode: "schedule_misfire",
    missedCount: 6,
  });
  expect(w.batches()).toHaveLength(0);
  expect(outbox(w, "schedule.misfire")).toHaveLength(1);
  // Negative control: an on-time occurrence still fires normally afterwards.
  await tickAt(scheduler, "2026-05-04T11:10:20Z");
  expect(dispatched(w, schedule.id)).toHaveLength(1);
});

it("OPS-017 fire_once runs one representative of the missed window and still records the rest as missed", async () => {
  const w = await world();
  setClock("2026-05-04T10:00:00Z");
  const schedule = w.schedule("fire-once", {
    trigger: { kind: "cron", cron: "*/10 * * * *", timezone: "UTC" },
    misfire: { policy: "fire_once", graceSeconds: 60 },
  });
  await tickAt(w.scheduler(), "2026-05-04T11:05:00Z");
  const rows = firings(w, schedule.id);
  expect(dispatched(w, schedule.id)).toHaveLength(1);
  expect(dispatched(w, schedule.id)[0]?.scheduledAt).toBe("2026-05-04T11:00:00.000Z");
  expect(rows.find((row) => row.state === "misfire")?.missedCount).toBe(5);
  expect(w.batches()).toHaveLength(1);
});

it("OPS-017 catch_up replays at most three occurrences inside its window and a week-long outage creates a bounded number of rows", async () => {
  const w = await world();
  setClock("2026-05-04T10:00:00Z");
  const schedule = w.schedule("catch-up", {
    trigger: { kind: "cron", cron: "*/10 * * * *", timezone: "UTC" },
    misfire: { policy: "catch_up", graceSeconds: 60, maxCatchUp: 3, catchUpWindowSeconds: 86400 },
    overlap: "allow",
  });
  const scheduler = w.scheduler();
  await tickAt(scheduler, "2026-05-04T11:05:00Z");
  expect(dispatched(w, schedule.id).map((fire) => fire.scheduledAt)).toEqual([
    "2026-05-04T11:00:00.000Z",
    "2026-05-04T10:50:00.000Z",
    "2026-05-04T10:40:00.000Z",
  ]);
  expect(firings(w, schedule.id).find((row) => row.state === "misfire")?.missedCount).toBe(3);
  // A week of silence: never more than maxCatchUp batches and one aggregated misfire row.
  const before = firings(w, schedule.id).length;
  await tickAt(scheduler, "2026-05-11T11:05:00Z");
  const added = firings(w, schedule.id).length - before;
  expect(added).toBeLessThanOrEqual(4);
  expect(dispatched(w, schedule.id).length).toBeLessThanOrEqual(6);
  const aggregate = firings(w, schedule.id).filter((row) => row.state === "misfire");
  expect(aggregate.at(0)?.missedCount).toBeGreaterThan(1000);
});

it("OPS-017 a clock that moves back never fires again and a clock that jumps forward does not avalanche", async () => {
  const w = await world();
  setClock("2026-05-04T10:00:00Z");
  const schedule = w.schedule("clock", {
    trigger: { kind: "cron", cron: "*/10 * * * *", timezone: "UTC" },
  });
  const scheduler = w.scheduler();
  await tickAt(scheduler, "2026-05-04T10:20:20Z");
  const count = firings(w, schedule.id).length;
  expect(dispatched(w, schedule.id)).toHaveLength(1);
  const cursor = (
    w.app.schedules.store.getSchedule(w.init.workspaceId, schedule.id) as { cursorAt: string }
  ).cursorAt;
  await tickAt(scheduler, "2026-05-04T09:00:00Z");
  await tickAt(scheduler, "2026-05-04T10:20:20Z");
  expect(firings(w, schedule.id)).toHaveLength(count);
  expect(
    (w.app.schedules.store.getSchedule(w.init.workspaceId, schedule.id) as { cursorAt: string })
      .cursorAt,
  ).toBe(cursor);
  await tickAt(scheduler, "2027-05-04T10:20:20Z");
  const jumped = firings(w, schedule.id);
  expect(jumped.length - count).toBeLessThanOrEqual(2);
  expect(dispatched(w, schedule.id).length).toBeLessThanOrEqual(2);
});

it("OPS-017 overlap forbid records an overlap firing and starts nothing while the previous batch runs", async () => {
  const w = await world();
  setClock("2026-05-04T10:00:00Z");
  const forbid = w.schedule("forbid", {
    trigger: { kind: "cron", cron: "*/10 * * * *", timezone: "UTC" },
    overlap: "forbid",
  });
  const allow = w.schedule("allow", {
    trigger: { kind: "cron", cron: "*/10 * * * *", timezone: "UTC" },
    overlap: "allow",
  });
  const scheduler = w.scheduler();
  await tickAt(scheduler, "2026-05-04T10:10:10Z");
  await tickAt(scheduler, "2026-05-04T10:20:10Z");
  expect(dispatched(w, forbid.id)).toHaveLength(1);
  const overlapped = firings(w, forbid.id).find((fire) => fire.state === "overlap");
  expect(overlapped).toMatchObject({ reasonCode: "schedule_overlap", batchId: null });
  // Negative control: allow keeps starting batches.
  expect(dispatched(w, allow.id)).toHaveLength(2);
  // Once the previous batch finished, forbid fires again.
  w.finish(String(dispatched(w, forbid.id)[0]?.batchId), "passed");
  await tickAt(scheduler, "2026-05-04T10:30:10Z");
  expect(dispatched(w, forbid.id)).toHaveLength(2);
});

it("OPS-017 overlap replace cancels the running batch durably and starts the new one after it stopped", async () => {
  const w = await world();
  setClock("2026-05-04T10:00:00Z");
  const schedule = w.schedule("replace", {
    trigger: { kind: "cron", cron: "*/10 * * * *", timezone: "UTC" },
    overlap: "replace",
  });
  const scheduler = w.scheduler();
  await tickAt(scheduler, "2026-05-04T10:10:10Z");
  const old = String(dispatched(w, schedule.id)[0]?.batchId);
  const oldRuns = w.app.context.entities.get("BatchRun", w.init.workspaceId, old)
    ?.memberRuns as string[];
  await tickAt(scheduler, "2026-05-04T10:20:10Z");
  for (const runId of oldRuns) {
    expect(
      w.app.database.all(
        "SELECT 1 FROM outbox WHERE aggregate_id=? AND type='run.cancel_requested'",
        runId,
      ),
    ).toHaveLength(1);
    expect(w.app.runs.get(runId).outcome).toBe("cancelled");
  }
  await tickAt(scheduler, "2026-05-04T10:20:20Z");
  const fires = dispatched(w, schedule.id);
  expect(fires).toHaveLength(2);
  expect(fires[0]?.batchId).not.toBe(old);
  expect(w.batches()).toHaveLength(2);
});
