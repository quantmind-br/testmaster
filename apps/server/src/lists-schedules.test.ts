import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Application,
  authenticateBearer,
  issueLocalToken,
  Scheduler,
  scaffoldPlan,
} from "@testmaster/application";
import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "./server.js";

interface FiringRow {
  id: string;
  state: string;
  scheduleId: string;
  batchId: string;
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A server over a local workspace with two projects, a staging environment each and two tests each. */
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-lists-http-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const application = await Application.open({ cwd, home, env: {} });
  const init = await application.init();
  vi.spyOn(Application.prototype, "preflight").mockResolvedValue();
  vi.spyOn(Object.getPrototypeOf(application.worker), "live").mockReturnValue(true);
  const other = application.projects.create({ name: "Second project" });
  const staging = application.environments.create({
    projectId: other.id,
    name: "staging",
    baseUrl: "http://127.0.0.1:4102",
  });
  const make = (projectId: string, name: string) =>
    application.tests.create({ projectId, plan: scaffoldPlan("backend"), name });
  make(init.projectId, "a-one");
  make(init.projectId, "a-two");
  make(other.id, "b-one");
  make(other.id, "b-two");
  const admin = await issueLocalToken(application);
  const readOnly = await issueLocalToken(application, {
    scopes: ["R"],
    tokenPath: join(home, "read.token"),
  });
  const noExecute = await issueLocalToken(application, {
    scopes: ["R", "W"],
    tokenPath: join(home, "write.token"),
  });
  const app = createServer({ application, mcp: false, origins: ["http://127.0.0.1:7331"] });
  cleanup.push(async () => {
    await app.close();
    application.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const authorize = (token: string) => ({ authorization: `Bearer ${token}` });
  const call = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    headers: Record<string, string> = authorize(admin.token),
  ) =>
    app.inject({
      method,
      url,
      headers: method === "GET" ? headers : { "idempotency-key": randomUUID(), ...headers },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const dynamic = {
    kind: "dynamic",
    projects: [
      { projectId: init.projectId, environmentId: init.environmentId },
      { projectId: other.id, environmentId: staging.id },
    ],
  };
  return {
    app,
    application,
    init,
    other,
    admin,
    readOnly,
    noExecute,
    authorize,
    call,
    dynamic,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const items = (response: { json(): { data: unknown } }): { id: string }[] => {
  const data = response.json().data as { items?: { id: string }[] } | { id: string }[];
  return Array.isArray(data) ? data : (data.items ?? []);
};
const etag = (response: { headers: Record<string, unknown> }): string =>
  String(response.headers.etag);

async function createSuite(f: Fixture, name = "nightly") {
  const response = await f.call("POST", "/v1/suites", { name, selection: f.dynamic });
  expect(response.statusCode).toBe(201);
  return response;
}

it("REQ-034 UX-041 list routes create, patch with If-Match, preview and archive over /v1 and refuse unauthenticated or unauthorized callers", async () => {
  const f = await fixture();
  expect((await f.app.inject("/v1/suites")).statusCode).toBe(401);
  expect(
    (
      await f.call(
        "POST",
        "/v1/suites",
        { name: "no-write", selection: f.dynamic },
        f.authorize(f.readOnly.token),
      )
    ).statusCode,
  ).toBe(403);
  const created = await createSuite(f);
  const suite = created.json().data as { id: string; version: number; name: string };
  expect(etag(created)).toBe('"1"');
  expect(items(await f.call("GET", "/v1/suites")).map((item) => item.id)).toEqual([suite.id]);
  expect((await f.call("GET", `/v1/suites/${suite.id}`)).json().data.name).toBe("nightly");
  // A duplicate name and an unknown ID are refused.
  expect(
    (await f.call("POST", "/v1/suites", { name: "nightly", selection: f.dynamic })).statusCode,
  ).toBeGreaterThanOrEqual(400);
  expect((await f.call("GET", `/v1/suites/sui_${randomUUID()}`)).statusCode).toBe(404);
  // Patch needs If-Match; a stale version conflicts and nothing changes.
  const noMatch = await f.call("PATCH", `/v1/suites/${suite.id}`, { description: "x" });
  expect(noMatch.statusCode).toBe(428);
  const patched = await f.call(
    "PATCH",
    `/v1/suites/${suite.id}`,
    { description: "Nightly regression" },
    { ...f.authorize(f.admin.token), "if-match": etag(created) },
  );
  expect(patched.statusCode).toBe(200);
  expect(patched.json().data).toMatchObject({ description: "Nightly regression", version: 2 });
  const stale = await f.call(
    "PATCH",
    `/v1/suites/${suite.id}`,
    { description: "stale" },
    { ...f.authorize(f.admin.token), "if-match": etag(created) },
  );
  expect(stale.statusCode).toBe(412);
  expect(stale.json().error.code).toBe("REVISION_CONFLICT");
  // Preview resolves without storing anything.
  const before = items(await f.call("GET", "/v1/suites")).length;
  const preview = await f.call("POST", "/v1/suites/preview", {
    name: "draft",
    selection: f.dynamic,
  });
  expect(preview.statusCode).toBe(200);
  expect(preview.json().data.members).toHaveLength(4);
  expect(items(await f.call("GET", "/v1/suites")).length).toBe(before);
  // Archive requires If-Match and removes the list from the active set.
  const archived = await f.call("DELETE", `/v1/suites/${suite.id}`, undefined, {
    ...f.authorize(f.admin.token),
    "if-match": etag(patched),
  });
  expect(archived.statusCode).toBe(200);
  expect(items(await f.call("GET", "/v1/suites"))).toEqual([]);
});

it("REQ-034 UX-041 the expansion route returns members and one mapping row per project without secret values", async () => {
  const f = await fixture();
  const suite = (await createSuite(f)).json().data as { id: string };
  const expansion = await f.call("GET", `/v1/suites/${suite.id}/expansion`);
  expect(expansion.statusCode).toBe(200);
  const data = expansion.json().data;
  expect(data.members).toHaveLength(4);
  expect(data.mapping).toHaveLength(2);
  expect(new Set(data.mapping.map((row: { projectId: string }) => row.projectId)).size).toBe(2);
  expect(data.exclusions).toEqual([]);
  expect(data.dispatchable).toBe(true);
  // Negative control: a viewer token can read the expansion but not run it.
  const viewer = f.authorize(f.readOnly.token);
  expect(
    (await f.call("GET", `/v1/suites/${suite.id}/expansion`, undefined, viewer)).statusCode,
  ).toBe(200);
  expect((await f.call("POST", `/v1/suites/${suite.id}/runs`, {}, viewer)).statusCode).toBe(403);
});

it("REQ-034 UX-041 running a list over HTTP admits one frozen batch per idempotency key and replays it after the list changed", async () => {
  const f = await fixture();
  const created = await createSuite(f);
  const suite = created.json().data as { id: string };
  const headers = { ...f.authorize(f.admin.token), "idempotency-key": "list-run-0123456789abcdef" };
  const first = await f.app.inject({
    method: "POST",
    url: `/v1/suites/${suite.id}/runs`,
    headers,
    payload: {},
  });
  expect(first.statusCode).toBe(202);
  const receipt = first.json().data;
  expect(receipt).toMatchObject({ requested: 4, accepted: 4, notDispatched: [] });
  const batch = f.application.batches.get(receipt.batchId);
  expect(batch.suiteId).toBe(suite.id);
  // Edit the list, then replay the same key: the original batch comes back, nothing new is admitted.
  await f.call(
    "PATCH",
    `/v1/suites/${suite.id}`,
    { selection: { kind: "dynamic", projects: [f.dynamic.projects[0]] } },
    { ...f.authorize(f.admin.token), "if-match": etag(created) },
  );
  const replay = await f.app.inject({
    method: "POST",
    url: `/v1/suites/${suite.id}/runs`,
    headers,
    payload: {},
  });
  expect(replay.json().data.batchId).toBe(receipt.batchId);
  expect(f.application.database.all("SELECT id FROM batches")).toHaveLength(1);
  // Negative control: a new key admits a new batch from the edited list.
  const next = await f.call("POST", `/v1/suites/${suite.id}/runs`, {});
  expect(next.json().data.requested).toBe(2);
  expect(f.application.database.all("SELECT id FROM batches")).toHaveLength(2);
});

it("UX-042 a token restricted to one project gets a forbidden answer naming the exclusion and a confirmed subset declares what was dropped", async () => {
  const f = await fixture();
  const suite = (await createSuite(f)).json().data as { id: string };
  const added = f.application.members.add(f.init.workspaceId, {
    login: "project-a-maintainer",
    displayName: "Project A maintainer",
    role: "maintainer",
    projectRestrictions: [f.init.projectId],
  });
  const issued = f.application.tokens.create({
    name: "restricted",
    scopes: ["R", "W", "X"],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    principalId: added.member.principalId,
  });
  expect(authenticateBearer(f.application, issued.token).principalId).toBe(
    added.member.principalId,
  );
  const restricted = f.authorize(issued.token);
  const expansion = await f.call("GET", `/v1/suites/${suite.id}/expansion`, undefined, restricted);
  expect(expansion.json().data.exclusions).toMatchObject([
    { key: `project:${f.other.id}`, kind: "access_denied" },
  ]);
  const before = f.application.database.all("SELECT id FROM batches").length;
  const denied = await f.call("POST", `/v1/suites/${suite.id}/runs`, {}, restricted);
  expect(denied.statusCode).toBe(403);
  expect(denied.json().error).toMatchObject({
    code: "FORBIDDEN",
    details: { nextActions: ["confirm_subset"] },
  });
  expect(f.application.database.all("SELECT id FROM batches")).toHaveLength(before);
  const confirmed = await f.call(
    "POST",
    `/v1/suites/${suite.id}/runs`,
    { confirmedExclusions: [`project:${f.other.id}`] },
    restricted,
  );
  expect(confirmed.statusCode).toBe(202);
  expect(confirmed.json().data).toMatchObject({
    accepted: 2,
    notDispatched: [{ memberKey: `project:${f.other.id}`, reasonCode: "actor_revoked" }],
  });
  expect(confirmed.json().data.gate).not.toBe("passed");
  // The restricted token cannot even save a list that names the other project.
  const sneaky = await f.call(
    "POST",
    "/v1/suites",
    { name: "sneaky", selection: f.dynamic },
    restricted,
  );
  expect(sneaky.statusCode).toBe(403);
});

it("REQ-035 OPS-016 schedule routes create, preview, patch, pause, resume and list revisions and firings over /v1", async () => {
  const f = await fixture();
  const suite = (await createSuite(f)).json().data as { id: string };
  expect((await f.app.inject("/v1/schedules")).statusCode).toBe(401);
  const input = {
    name: "nightly-schedule",
    selection: { kind: "suite", suiteId: suite.id },
    trigger: { kind: "cron", cron: "0 3 * * *", timezone: "America/Sao_Paulo" },
  };
  expect(
    (await f.call("POST", "/v1/schedules", input, f.authorize(f.noExecute.token))).statusCode,
  ).toBe(403);
  const bad = await f.call("POST", "/v1/schedules", {
    ...input,
    trigger: { ...input.trigger, timezone: "Mars/Olympus" },
  });
  expect(bad.statusCode).toBeGreaterThanOrEqual(400);
  expect(bad.json().error.code).toBe("INVALID_ARGUMENT");
  expect(items(await f.call("GET", "/v1/schedules"))).toEqual([]);
  const preview = await f.call("POST", "/v1/schedules/preview", { trigger: input.trigger });
  expect(preview.statusCode).toBe(200);
  expect(preview.json().data.occurrences).toHaveLength(10);
  const created = await f.call("POST", "/v1/schedules", input);
  expect(created.statusCode).toBe(201);
  const schedule = created.json().data as {
    id: string;
    version: number;
    revision: number;
    preview: unknown[];
  };
  expect(schedule).toMatchObject({ revision: 1, version: 1 });
  expect(schedule.preview).toHaveLength(10);
  expect(items(await f.call("GET", "/v1/schedules")).map((item) => item.id)).toEqual([schedule.id]);
  const patched = await f.call(
    "PATCH",
    `/v1/schedules/${schedule.id}`,
    { overlap: "allow" },
    { ...f.authorize(f.admin.token), "if-match": etag(created) },
  );
  expect(patched.json().data).toMatchObject({ revision: 2, version: 2 });
  const revisions = items(await f.call("GET", `/v1/schedules/${schedule.id}/revisions`));
  expect(revisions.map((item) => item.id)).toEqual([`${schedule.id}@2`, `${schedule.id}@1`]);
  const paused = await f.call("POST", `/v1/schedules/${schedule.id}/pause`, undefined, {
    ...f.authorize(f.admin.token),
    "if-match": etag(patched),
  });
  expect(paused.json().data).toMatchObject({ state: "paused", pauseReason: "manual" });
  const resumed = await f.call("POST", `/v1/schedules/${schedule.id}/resume`, undefined, {
    ...f.authorize(f.admin.token),
    "if-match": etag(paused),
  });
  expect(resumed.json().data.state).toBe("active");
  expect(items(await f.call("GET", `/v1/schedules/${schedule.id}/firings`))).toEqual([]);
  // Negative control: pausing again with the old version conflicts.
  const conflict = await f.call("POST", `/v1/schedules/${schedule.id}/pause`, undefined, {
    ...f.authorize(f.admin.token),
    "if-match": etag(patched),
  });
  expect(conflict.statusCode).toBe(412);
});

it("OPS-016 OPS-017 the firing history route pages what the scheduler decided and links the batch each firing admitted", async () => {
  // The fake clock keeps every firing at or before the "now" that cursor pagination cuts off at.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
  const f = await fixture();
  const suite = (await createSuite(f)).json().data as { id: string };
  const created = await f.call("POST", "/v1/schedules", {
    name: "every-minute",
    selection: { kind: "suite", suiteId: suite.id },
    trigger: { kind: "cron", cron: "* * * * *", timezone: "UTC" },
    overlap: "allow",
  });
  const schedule = created.json().data as { id: string };
  const scheduler = new Scheduler(f.application.controllerScope(), {
    configureApplication: (application) => {
      application.preflight = async () => {};
      application.runs.host.liveWorker = () => true;
    },
  });
  const start = Date.now();
  for (let minute = 1; minute <= 3; minute++) {
    vi.setSystemTime(start + minute * 60_000 + 5_000);
    await scheduler.tick(Date.now());
  }
  const page = await f.call("GET", `/v1/schedules/${schedule.id}/firings?limit=2`);
  expect(page.statusCode).toBe(200);
  const body = page.json().data as { items: FiringRow[]; hasMore: boolean };
  expect(body.items).toHaveLength(2);
  expect(body.hasMore).toBe(true);
  expect(body.items[0]).toMatchObject({ state: "dispatched", scheduleId: schedule.id });
  expect(body.items[0]?.batchId).toMatch(/^bat_/);
  const all = await f.call("GET", `/v1/schedules/${schedule.id}/firings?limit=10`);
  expect(items(all)).toHaveLength(3);
  // Every batch of the history belongs to this schedule.
  for (const firing of items(all) as FiringRow[]) {
    const batch = f.application.batches.get(firing.batchId);
    expect(batch.scheduleId).toBe(schedule.id);
  }
  // Negative control: an unknown schedule has no history.
  expect((await f.call("GET", `/v1/schedules/sch_${randomUUID()}/firings`)).statusCode).toBe(404);
});
