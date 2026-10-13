import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Application, authenticateBearer, scaffoldPlan } from "../index.js";
import { Scheduler } from "./scheduler.js";
import { createScheduleWorld, type ScheduleWorld, stubHost } from "./test-world.js";

const worlds: ScheduleWorld[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(async () => {
  vi.useRealTimers();
  for (const world of worlds.splice(0)) await world.close();
});
async function world(): Promise<ScheduleWorld> {
  vi.setSystemTime(Date.parse("2026-01-01T00:00:00Z"));
  const created = await createScheduleWorld();
  worlds.push(created);
  return created;
}
const setClock = (iso: string) => vi.setSystemTime(Date.parse(iso));
const tickAt = (scheduler: Scheduler, iso: string) => {
  const ms = Date.parse(iso);
  vi.setSystemTime(ms);
  return scheduler.tick(ms);
};
const firings = (w: ScheduleWorld, id: string) => w.app.schedules.firings(id);
const dispatched = (w: ScheduleWorld, id: string) =>
  firings(w, id).filter((firing) => firing.state === "dispatched");
const outbox = (w: ScheduleWorld, type: string) =>
  w.app.database.all("SELECT aggregate_id,data_json FROM outbox WHERE type=?", type);
const every10 = { kind: "cron", cron: "*/10 * * * *", timezone: "UTC" } as const;

/** A maintainer whose API token owns a schedule; revoking any part of that authority must stop it. */
function ownedBy(w: ScheduleWorld, restrictions: string[] = []) {
  const added = w.app.members.add(w.init.workspaceId, {
    login: `maintainer-${Math.random().toString(36).slice(2, 8)}`,
    displayName: "Maintainer",
    role: "maintainer",
    projectRestrictions: restrictions,
  });
  const issued = w.app.tokens.create({
    name: "schedule-owner",
    scopes: ["R", "W", "X"],
    expiresAt: "2026-12-01T00:00:00.000Z",
    principalId: added.member.principalId,
  });
  const owner: Application = w.app.forIdentity(authenticateBearer(w.app, issued.token));
  stubHost(owner);
  return { member: added.member, token: issued.metadata, owner };
}

it("OPS-018 a dependent schedule waits for its upstream gate and only runs when the condition holds", async () => {
  const w = await world();
  setClock("2026-05-04T10:00:00Z");
  const up = w.schedule("up", { trigger: every10, overlap: "allow" });
  const down = w.schedule("down", {
    trigger: every10,
    overlap: "allow",
    dependsOn: [{ scheduleId: up.id, condition: "passed", timeoutSeconds: 600 }],
  });
  const scheduler = w.scheduler();
  await tickAt(scheduler, "2026-05-04T10:10:10Z");
  await tickAt(scheduler, "2026-05-04T10:10:11Z");
  expect(dispatched(w, up.id)).toHaveLength(1);
  expect(firings(w, down.id)[0]).toMatchObject({ state: "waiting", batchId: null });
  // Upstream passes: the dependent runs.
  w.finish(String(dispatched(w, up.id)[0]?.batchId), "passed");
  await tickAt(scheduler, "2026-05-04T10:10:20Z");
  expect(dispatched(w, down.id)).toHaveLength(1);
  // Upstream fails at the next occurrence: the dependent is skipped, never run as if it passed.
  await tickAt(scheduler, "2026-05-04T10:20:10Z");
  w.finish(String(dispatched(w, up.id)[0]?.batchId), "failed");
  await tickAt(scheduler, "2026-05-04T10:20:20Z");
  await tickAt(scheduler, "2026-05-04T10:20:30Z");
  const skipped = firings(w, down.id).find((fire) => fire.state === "skipped");
  expect(skipped).toMatchObject({ reasonCode: "upstream_failed", batchId: null });
  expect(dispatched(w, down.id)).toHaveLength(1);
  expect(w.batches()).toHaveLength(3);
});

it("OPS-018 a dependency that never runs times out as blocked and an upstream that did not dispatch skips the dependent", async () => {
  const w = await world();
  setClock("2026-05-04T10:00:00Z");
  const up = w.schedule("up", { trigger: every10, overlap: "allow" });
  const down = w.schedule("down", {
    trigger: every10,
    overlap: "allow",
    dependsOn: [{ scheduleId: up.id, condition: "terminal", timeoutSeconds: 120 }],
  });
  w.app.schedules.pause(up.id, up.version);
  const scheduler = w.scheduler();
  await tickAt(scheduler, "2026-05-04T10:10:10Z");
  expect(firings(w, down.id)[0]).toMatchObject({ state: "waiting" });
  await tickAt(scheduler, "2026-05-04T10:12:30Z");
  expect(firings(w, down.id).some((fire) => fire.state === "dispatched")).toBe(false);
  const blocked = firings(w, down.id).find((fire) => fire.state === "blocked");
  expect(blocked).toMatchObject({ reasonCode: "upstream_failed", batchId: null });
  expect(w.batches()).toHaveLength(0);
});

it("OPS-018 dependency cycles, including self dependencies, are refused with a named reason", async () => {
  const w = await world();
  setClock("2026-05-04T10:00:00Z");
  const a = w.schedule("a", { trigger: every10 });
  const b = w.schedule("b", {
    trigger: every10,
    dependsOn: [{ scheduleId: a.id, condition: "passed", timeoutSeconds: 60 }],
  });
  const c = w.schedule("c", {
    trigger: every10,
    dependsOn: [{ scheduleId: b.id, condition: "terminal", timeoutSeconds: 60 }],
  });
  const reasons = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return (error as { code: string; details: { reasonCode?: string } }).details.reasonCode;
    }
    return null;
  };
  expect(
    reasons(() =>
      w.app.schedules.update(
        a.id,
        { dependsOn: [{ scheduleId: c.id, condition: "passed", timeoutSeconds: 60 }] },
        a.version,
      ),
    ),
  ).toBe("dependency_cycle");
  expect(
    reasons(() =>
      w.app.schedules.update(
        a.id,
        { dependsOn: [{ scheduleId: a.id, condition: "passed", timeoutSeconds: 60 }] },
        a.version,
      ),
    ),
  ).toBe("dependency_cycle");
  // Negative control: a diamond is not a cycle.
  const d = w.schedule("d", {
    trigger: every10,
    dependsOn: [
      { scheduleId: b.id, condition: "passed", timeoutSeconds: 60 },
      { scheduleId: c.id, condition: "passed", timeoutSeconds: 60 },
    ],
  });
  expect(d.definition.dependsOn).toHaveLength(2);
});

it("OPS-019 a schedule whose owner was removed or lost its token pauses with owner_revoked and never runs as an administrator", async () => {
  const w = await world();
  setClock("2026-05-04T10:00:00Z");
  const removed = ownedBy(w);
  const revoked = ownedBy(w);
  const healthy = ownedBy(w);
  const make = (name: string, owner: Application) =>
    owner.schedules.create({
      name,
      selection: { kind: "suite", suiteId: w.suite.id },
      trigger: every10,
      overlap: "allow",
    });
  const first = make("owner-removed", removed.owner);
  const second = make("token-revoked", revoked.owner);
  const third = make("healthy", healthy.owner);
  w.app.members.update(
    w.init.workspaceId,
    removed.member.id,
    { disabled: true },
    removed.member.version,
  );
  w.app.tokens.revoke(revoked.token.id);
  const scheduler = w.scheduler();
  await tickAt(scheduler, "2026-05-04T10:10:10Z");
  for (const id of [first.id, second.id]) {
    const view = w.app.schedules.get(id);
    expect(view).toMatchObject({ state: "paused", pauseReason: "owner_revoked", nextFireAt: null });
    expect(dispatched(w, id)).toHaveLength(0);
  }
  expect(outbox(w, "schedule.paused")).toHaveLength(2);
  // Negative control: the schedule of a valid owner keeps running.
  expect(w.app.schedules.get(third.id).state).toBe("active");
  expect(dispatched(w, third.id)).toHaveLength(1);
  expect(
    w.app.database.all("SELECT 1 FROM audit_events WHERE action='schedules.pause.allowed'").length,
  ).toBeGreaterThanOrEqual(2);
});

it("OPS-019 losing access to the scheduled project blocks the firing with owner_revoked instead of running a reduced list", async () => {
  const w = await world();
  setClock("2026-05-04T10:00:00Z");
  const { member, owner } = ownedBy(w);
  const schedule = owner.schedules.create({
    name: "restricted",
    selection: { kind: "suite", suiteId: w.suite.id },
    trigger: every10,
  });
  const other = w.app.projects.create({ name: "Other project" });
  w.app.members.update(
    w.init.workspaceId,
    member.id,
    { projectRestrictions: [other.id] },
    member.version,
  );
  await tickAt(w.scheduler(), "2026-05-04T10:10:10Z");
  expect(w.app.schedules.get(schedule.id)).toMatchObject({
    state: "paused",
    pauseReason: "owner_revoked",
  });
  const fire = firings(w, schedule.id)[0];
  expect(fire).toMatchObject({ state: "blocked", reasonCode: "owner_revoked", batchId: null });
  expect(w.batches()).toHaveLength(0);
});

it("OPS-019 resuming needs a valid owner and does not replay the backlog accumulated while paused", async () => {
  const w = await world();
  setClock("2026-05-04T10:00:00Z");
  const schedule = w.schedule("resume", {
    trigger: every10,
    misfire: { policy: "catch_up", graceSeconds: 60, maxCatchUp: 3, catchUpWindowSeconds: 86400 },
  });
  const paused = w.app.schedules.pause(schedule.id, schedule.version);
  expect(paused).toMatchObject({ state: "paused", pauseReason: "manual", nextFireAt: null });
  const scheduler = w.scheduler();
  await tickAt(scheduler, "2026-05-05T10:00:00Z");
  expect(firings(w, schedule.id)).toHaveLength(0);
  const resumed = w.app.schedules.resume(schedule.id, paused.version);
  expect(resumed.state).toBe("active");
  await tickAt(scheduler, "2026-05-05T10:00:30Z");
  expect(firings(w, schedule.id)).toHaveLength(0);
  expect(w.batches()).toHaveLength(0);
  // Negative control: new occurrences after the resume do fire.
  await tickAt(scheduler, "2026-05-05T10:10:10Z");
  expect(dispatched(w, schedule.id)).toHaveLength(1);
});

it("OPS-019 two schedulers with a flapping lease never start the same occurrence twice", async () => {
  const w = await world();
  setClock("2026-05-04T10:00:00Z");
  const schedule = w.schedule("flapping", { trigger: every10, overlap: "allow" });
  const a = w.scheduler({ holder: "scheduler-a", leaseMs: 5_000 });
  const b = w.scheduler({ holder: "scheduler-b", leaseMs: 5_000 });
  // Leadership flaps on every tick: each instance takes over after the other's lease ran out.
  const clock = Date.parse("2026-05-04T10:10:10Z");
  vi.setSystemTime(clock);
  const first = await a.tick(clock);
  const blocked = await b.tick(clock + 1000);
  expect(first.leader).toBe(true);
  expect(blocked.leader).toBe(false);
  const second = await b.tick(clock + 20_000);
  expect(second).toMatchObject({ leader: true, fence: 2 });
  await a.tick(clock + 40_000);
  await b.tick(clock + 41_000);
  await a.tick(clock + 80_000);
  expect(dispatched(w, schedule.id)).toHaveLength(1);
  expect(w.batches()).toHaveLength(1);
  expect(firings(w, schedule.id)).toHaveLength(1);
});

it("OPS-019 a stale leader that loses the lease between planning and admission starts nothing and the new leader finishes the firing once", async () => {
  const w = await world();
  setClock("2026-05-04T10:00:00Z");
  const schedule = w.schedule("stale", { trigger: every10, overlap: "allow" });
  let stolen = false;
  const stale = w.scheduler({
    holder: "stale",
    configureApplication: (application) => {
      stubHost(application);
      if (stolen) return;
      stolen = true;
      // Another instance takes over right before the stale leader admits the batch.
      w.app.database.run(
        "UPDATE scheduler_leases SET holder='usurper',fence=fence+1,expires_at=? WHERE name='scheduler'",
        "2099-01-01T00:00:00.000Z",
      );
    },
  });
  const summary = await tickAt(stale, "2026-05-04T10:10:10Z");
  expect(summary.leader).toBe(false);
  expect(w.batches()).toHaveLength(0);
  expect(firings(w, schedule.id)[0]).toMatchObject({ state: "claimed", batchId: null });
  w.app.database.run(
    "UPDATE scheduler_leases SET expires_at=? WHERE name='scheduler'",
    "2000-01-01T00:00:00.000Z",
  );
  const next = w.scheduler({ holder: "new-leader" });
  await tickAt(next, "2026-05-04T10:10:20Z");
  await tickAt(next, "2026-05-04T10:10:30Z");
  expect(dispatched(w, schedule.id)).toHaveLength(1);
  expect(w.batches()).toHaveLength(1);
  expect(firings(w, schedule.id)).toHaveLength(1);
});

it("OPS-017 the daily firing budget skips further occurrences and a run of failed gates pauses the schedule", async () => {
  const w = await world();
  setClock("2026-05-04T10:00:00Z");
  const budget = w.schedule("budget", {
    trigger: every10,
    overlap: "allow",
    budget: { maxFiresPerDay: 1 },
  });
  const failing = w.schedule("failing", {
    trigger: every10,
    overlap: "allow",
    budget: { autoPauseAfterFailures: 2 },
  });
  const scheduler = w.scheduler();
  await tickAt(scheduler, "2026-05-04T10:10:10Z");
  await tickAt(scheduler, "2026-05-04T10:20:10Z");
  expect(dispatched(w, budget.id)).toHaveLength(1);
  expect(firings(w, budget.id).find((fire) => fire.state === "skipped")).toMatchObject({
    reasonCode: "budget_exhausted",
  });
  for (const fire of dispatched(w, failing.id)) w.finish(String(fire.batchId), "failed");
  await tickAt(scheduler, "2026-05-04T10:20:50Z");
  expect(w.app.schedules.get(failing.id)).toMatchObject({
    state: "paused",
    pauseReason: "auto_paused_failures",
  });
  // Negative control: passing gates never pause.
  expect(w.app.schedules.get(budget.id).state).toBe("active");
});

it("OPS-017 an expired schedule pauses with a reason and stops firing", async () => {
  const w = await world();
  setClock("2026-05-04T10:00:00Z");
  const expiring = w.schedule("expiring", {
    trigger: every10,
    expiresAt: "2026-05-04T10:15:00.000Z",
  });
  const scheduler = w.scheduler();
  await tickAt(scheduler, "2026-05-04T10:10:10Z");
  expect(dispatched(w, expiring.id)).toHaveLength(1);
  await tickAt(scheduler, "2026-05-04T10:20:10Z");
  expect(w.app.schedules.get(expiring.id)).toMatchObject({
    state: "paused",
    pauseReason: "expired",
  });
  expect(dispatched(w, expiring.id)).toHaveLength(1);
});

/** A test whose request carries a vault secret, so schedules over the list depend on that secret. */
async function withSecret(w: ScheduleWorld) {
  const environment = w.app.environments.get(w.init.environmentId);
  const revision = w.app.context.entities.get(
    "EnvironmentRevision",
    w.init.workspaceId,
    String(environment.activeRevisionId),
  ) as { targetOrigins: string[] };
  const secret = await w.app.secrets.set("schedule-token", "first-value", {
    ephemeral: true,
    allowedOrigins: [revision.targetOrigins[0] as string],
  });
  const plan = scaffoldPlan("backend");
  const step = plan.steps[0];
  if (step?.operation !== "request") throw new Error("Expected the HTTP scaffold request");
  step.input.headers = { Authorization: { secretRef: secret.id } };
  w.app.tests.create({ projectId: w.init.projectId, plan, name: "secured" });
  return secret;
}

it("OPS-017 a changed secret pauses a schedule whose policy says pause and a use_current schedule keeps running", async () => {
  const w = await world();
  setClock("2026-05-04T10:00:00Z");
  await withSecret(w);
  const pausing = w.schedule("pause-on-change", {
    trigger: every10,
    overlap: "allow",
    secrets: { onChange: "pause" },
  });
  const current = w.schedule("use-current", { trigger: every10, overlap: "allow" });
  const scheduler = w.scheduler();
  await tickAt(scheduler, "2026-05-04T10:10:10Z");
  expect(dispatched(w, pausing.id)).toHaveLength(1);
  await w.app.secrets.rotate("schedule-token", "second-value");
  await tickAt(scheduler, "2026-05-04T10:20:10Z");
  expect(w.app.schedules.get(pausing.id)).toMatchObject({
    state: "paused",
    pauseReason: "secret_changed",
  });
  expect(firings(w, pausing.id).find((fire) => fire.state === "skipped")).toMatchObject({
    batchId: null,
  });
  expect(dispatched(w, pausing.id)).toHaveLength(1);
  // Negative control: the default policy uses the current secret.
  expect(w.app.schedules.get(current.id).state).toBe("active");
  expect(dispatched(w, current.id)).toHaveLength(2);
});

it("OPS-019 revoking a service credential before the firing blocks the execution instead of running without it", async () => {
  const w = await world();
  setClock("2026-05-04T10:00:00Z");
  const secret = await withSecret(w);
  const schedule = w.schedule("revoked-secret", { trigger: every10, overlap: "allow" });
  const stored = w.app.context.entities.get("SecretReference", w.init.workspaceId, secret.id);
  w.app.context.entities.update(
    "SecretReference",
    w.init.workspaceId,
    secret.id,
    Number(stored?.version),
    {
      ...stored,
      revokedAt: new Date().toISOString(),
      version: Number(stored?.version) + 1,
    },
  );
  await tickAt(w.scheduler(), "2026-05-04T10:10:10Z");
  expect(w.batches()).toHaveLength(0);
  const fire = firings(w, schedule.id)[0];
  expect(fire?.state).toBe("blocked");
  expect(fire?.batchId).toBeNull();
  expect(dispatched(w, schedule.id)).toHaveLength(0);
});

it("OPS-025 the scheduler does nothing while the restored copy is isolated and resumes when it is released", async () => {
  const w = await world();
  setClock("2026-05-04T10:00:00Z");
  const schedule = w.schedule("isolated", { trigger: every10 });
  w.app.database.run("INSERT INTO operational_state(key,value) VALUES('restore:isolated','true')");
  const scheduler = w.scheduler();
  const held = await tickAt(scheduler, "2026-05-04T10:10:10Z");
  expect(held).toMatchObject({ isolated: true, leader: false, claimed: 0, dispatched: 0 });
  expect(firings(w, schedule.id)).toHaveLength(0);
  expect(w.batches()).toHaveLength(0);
  w.app.database.run("DELETE FROM operational_state WHERE key='restore:isolated'");
  const released = await tickAt(scheduler, "2026-05-04T10:10:20Z");
  expect(released).toMatchObject({ isolated: false, leader: true, dispatched: 1 });
  expect(w.batches()).toHaveLength(1);
});

it("OPS-018 a firing waits when no worker is live and is recorded as a misfire after its grace period", async () => {
  const w = await world();
  setClock("2026-05-04T10:00:00Z");
  const schedule = w.schedule("no-worker", {
    trigger: every10,
    misfire: { policy: "skip", graceSeconds: 120 },
  });
  const scheduler = new Scheduler(w.app.controllerScope(), {
    configureApplication: (application) => {
      application.preflight = async () => {};
      application.runs.host.liveWorker = () => false;
    },
  });
  await tickAt(scheduler, "2026-05-04T10:10:10Z");
  expect(firings(w, schedule.id)[0]).toMatchObject({ state: "waiting" });
  await tickAt(scheduler, "2026-05-04T10:13:00Z");
  expect(firings(w, schedule.id).find((fire) => fire.state === "misfire")).toMatchObject({
    reasonCode: "schedule_misfire",
    batchId: null,
  });
  expect(w.batches()).toHaveLength(0);
});
