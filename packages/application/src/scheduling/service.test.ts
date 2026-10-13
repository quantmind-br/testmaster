import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { scaffoldPlan } from "../index.js";
import { createScheduleWorld, type ScheduleWorld, stubHost } from "./test-world.js";

const worlds: ScheduleWorld[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-05-04T08:00:00Z"));
});
afterEach(async () => {
  vi.useRealTimers();
  for (const world of worlds.splice(0)) await world.close();
});
async function world(): Promise<ScheduleWorld> {
  const created = await createScheduleWorld();
  worlds.push(created);
  return created;
}

it("REQ-035 OPS-016 a saved schedule shows the next ten occurrences with their local time and the tzdata version", async () => {
  const w = await world();
  const schedule = w.schedule("preview", {
    trigger: { kind: "cron", cron: "30 9 * * 1-5", timezone: "Europe/London" },
  });
  expect(schedule.revision).toBe(1);
  expect(schedule.preview).toHaveLength(10);
  expect(schedule.preview[0]).toMatchObject({
    fireAt: "2026-05-04T08:30:00.000Z",
    dst: "none",
  });
  expect(schedule.preview.map((entry) => entry.fireAt)).toEqual(
    [...schedule.preview.map((entry) => entry.fireAt)].sort(),
  );
  expect(schedule.tzdataVersion).toBe(schedule.runtimeTzdataVersion);
  expect(schedule.tzdataDrift).toBe(false);
  expect(schedule.nextFireAt).toBe(schedule.preview[0]?.fireAt);
  // Negative control: weekends never appear.
  expect(
    schedule.preview.every((entry) => ![0, 6].includes(new Date(entry.fireAt).getUTCDay())),
  ).toBe(true);
});

it("REQ-035 OPS-016 a draft preview names the local times a DST gap removed and refuses invalid triggers", async () => {
  const w = await world();
  const preview = w.app.schedules.preview({
    trigger: { kind: "cron", cron: "30 2 * * *", timezone: "America/New_York" },
    from: "2026-03-06T00:00:00Z",
    count: 10,
  });
  expect(preview.occurrences).toHaveLength(10);
  expect(preview.timezone).toBe("America/New_York");
  expect(preview.skippedByDst).toHaveLength(1);
  expect(preview.occurrences.some((entry) => entry.fireAt === "2026-03-08T07:30:00.000Z")).toBe(
    false,
  );
  expect(() =>
    w.app.schedules.preview({
      trigger: { kind: "cron", cron: "61 * * * *", timezone: "UTC" },
    }),
  ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  expect(() =>
    w.app.schedules.preview({
      trigger: { kind: "cron", cron: "0 9 1 * 1", timezone: "UTC" },
    }),
  ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  // Preview writes nothing.
  expect(w.app.schedules.list()).toEqual([]);
});

it("REQ-035 a definition change creates an immutable revision while the history stays readable", async () => {
  const w = await world();
  const schedule = w.schedule("revisions");
  const changed = w.app.schedules.update(
    schedule.id,
    { overlap: "allow", misfire: { policy: "fire_once" } },
    schedule.version,
  );
  expect(changed.revision).toBe(2);
  expect(changed.definition.overlap).toBe("allow");
  expect(changed.definition.misfire).toMatchObject({ policy: "fire_once", graceSeconds: 300 });
  const history = w.app.schedules.revisions(schedule.id);
  expect(history.map((item) => item.revision)).toEqual([2, 1]);
  expect(history[1]?.definition.overlap).toBe("forbid");
  expect(history[0]?.id).toBe(`${schedule.id}@2`);
  // Stale versions are refused, not merged.
  expect(() =>
    w.app.schedules.update(schedule.id, { name: "again" }, schedule.version),
  ).toThrowError(expect.objectContaining({ code: "REVISION_CONFLICT" }));
  expect(() =>
    w.app.database.run("DELETE FROM schedule_revisions WHERE schedule_id=?", schedule.id),
  ).toThrow();
});

it("REQ-035 a pinned selection is frozen at save time and latest_approved follows the list", async () => {
  const w = await world();
  const pinned = w.schedule("pinned");
  const latest = w.schedule("latest", {
    selection: { kind: "suite", suiteId: w.suite.id, revisionPolicy: "latest_approved" },
  });
  expect(pinned.definition.selection.pinned).toHaveLength(2);
  expect(latest.definition.selection.pinned).toEqual([]);
  w.app.tests.create({
    projectId: w.init.projectId,
    plan: scaffoldPlan("backend"),
    name: "added-later",
  });
  const after = w.app.schedules.get(pinned.id);
  expect(after.definition.selection.pinned).toHaveLength(2);
  const resolved = w.app.schedules.resolveSelection(w.app.schedules.get(latest.id).definition);
  expect(resolved.requests).toHaveLength(3);
  expect(w.app.schedules.resolveSelection(after.definition).requests).toHaveLength(2);
});

it("REQ-035 an unreadable project hides the schedule and an owner cannot schedule what they cannot run", async () => {
  const w = await world();
  const schedule = w.schedule("hidden");
  const other = w.app.projects.create({ name: "Other" });
  const added = w.app.members.add(w.init.workspaceId, {
    login: "restricted-reader",
    displayName: "Restricted reader",
    role: "maintainer",
    projectRestrictions: [other.id],
  });
  const restricted = w.app.forIdentity({
    principalId: added.member.principalId,
    scopes: ["R", "W", "X"],
    grants: [],
    workspaceId: w.init.workspaceId,
    credential: { kind: "api", id: "tok_restricted" },
  });
  stubHost(restricted);
  expect(restricted.schedules.list()).toEqual([]);
  expect(() => restricted.schedules.get(schedule.id)).toThrowError(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  expect(() =>
    restricted.schedules.create({
      name: "sneaky",
      selection: { kind: "suite", suiteId: w.suite.id },
      trigger: { kind: "cron", cron: "0 9 * * *", timezone: "UTC" },
    }),
  ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  // Negative control: the full owner sees it.
  expect(w.app.schedules.list().map((item) => item.id)).toEqual([schedule.id]);
});

it("REQ-035 archiving removes a schedule from firing, history stays and it can no longer change", async () => {
  const w = await world();
  const schedule = w.schedule("archive");
  const archived = w.app.schedules.archive(schedule.id, schedule.version);
  expect(archived).toMatchObject({ state: "archived", nextFireAt: null, preview: [] });
  expect(w.app.schedules.revisions(schedule.id)).toHaveLength(1);
  expect(() =>
    w.app.schedules.update(schedule.id, { name: "late" }, archived.version),
  ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  expect(() => w.app.schedules.pause(schedule.id, archived.version)).toThrowError(
    expect.objectContaining({ code: "PRECONDITION_FAILED" }),
  );
});
