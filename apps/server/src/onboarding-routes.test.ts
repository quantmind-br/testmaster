import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, issueLocalToken } from "@testmaster/application";
import { afterEach, expect, it } from "vitest";
import { createServer } from "./server.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-onboarding-routes-"));
  const home = join(cwd, "home");
  await mkdir(join(home, ".config", "testmaster"), { recursive: true });
  const application = await Application.open({ cwd, home, env: {} });
  const init = await application.init();
  const issued = await issueLocalToken(application);
  const app = createServer({ application, mcp: false, origins: ["http://127.0.0.1:7331"] });
  cleanup.push(async () => {
    await app.close();
    application.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const headers = { authorization: `Bearer ${issued.token}` };
  const get = (url: string) => app.inject({ url: `/v1${url}`, headers });
  const send = (
    method: "POST" | "PUT",
    url: string,
    payload: unknown,
    extra: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url: `/v1${url}`,
      headers: { ...headers, "idempotency-key": randomUUID(), ...extra },
      payload,
    });
  return { app, application, init, cwd, headers, get, send };
}

const state = (choices: Record<string, unknown> = {}) => ({
  currentStep: "project",
  completedSteps: ["mode"],
  choices,
});

it("UX-009 serves the wizard state with an ETag and refuses a write without or with a stale If-Match", async () => {
  const f = await fixture();
  const url = `/projects/${f.init.projectId}/onboarding`;
  const fresh = await f.get(url);
  expect(fresh.statusCode).toBe(200);
  expect(fresh.headers.etag).toBe('"1"');
  expect(fresh.json().data).toMatchObject({ saved: false, currentStep: "mode" });
  const missing = await f.send("PUT", url, state());
  expect(missing.statusCode).toBe(428);
  const saved = await f.send("PUT", url, state({ mode: "local" }), { "if-match": '"1"' });
  expect(saved.statusCode).toBe(200);
  expect(saved.headers.etag).toBe('"2"');
  expect((await f.get(url)).json().data).toMatchObject({
    saved: true,
    currentStep: "project",
    choices: { mode: "local" },
  });
  const stale = await f.send("PUT", url, state(), { "if-match": '"1"' });
  expect(stale.statusCode).toBe(412);
  expect(stale.json().error.code).toBe("REVISION_CONFLICT");
  // Negative control: no credential reaches the stored state, whichever way it is smuggled in.
  const smuggled = await f.send(
    "PUT",
    url,
    state({ target: { baseUrl: "http://u:p@127.0.0.1:1/", networkProfile: "local-loopback" } }),
    {
      "if-match": '"2"',
    },
  );
  expect(smuggled.statusCode).toBe(400);
  expect(JSON.stringify((await f.get(url)).json())).not.toContain("u:p@");
});

it("UX-010 reports each prerequisite with its own reason and never contacts a policy-denied target", async () => {
  const f = await fixture();
  const check = await f.send("POST", `/projects/${f.init.projectId}/onboarding/checks`, {
    targetUrl: "http://127.0.0.1:1",
    networkProfile: "public",
  });
  expect(check.statusCode).toBe(200);
  const { checks, ready } = check.json().data as {
    ready: boolean;
    checks: { id: string; status: string; reasonCode: string | null }[];
  };
  expect(ready).toBe(false);
  expect(checks.find((item) => item.id === "policy")).toMatchObject({
    status: "failed",
    reasonCode: "egress_denied",
  });
  expect(checks.find((item) => item.id === "target")?.status).toBe("not_checked");
  expect(checks.map((item) => item.id).sort()).toEqual(["auth", "policy", "runner", "target"]);
});

it("UX-044 lists a source with its overview and serves its revision history with the diff against the parent", async () => {
  const f = await fixture();
  const spec = (paths: Record<string, unknown>) =>
    JSON.stringify({ openapi: "3.0.3", info: { title: "Shop", version: "1" }, paths });
  const ok = { get: { responses: { "200": { description: "ok" } } } };
  await writeFile(join(f.cwd, "openapi.json"), spec({ "/a": ok, "/b": ok }));
  const first = await f.application.sources.add({
    projectId: f.init.projectId,
    role: "api-spec",
    path: "openapi.json",
  });
  await writeFile(join(f.cwd, "openapi.json"), spec({ "/a": ok, "/c": ok }));
  await f.application.sources.add({
    projectId: f.init.projectId,
    role: "api-spec",
    path: "openapi.json",
    sourceId: first.source.id,
    expectedVersion: Number(first.source.version),
  });
  const listed = (await f.get(`/projects/${f.init.projectId}/sources`)).json();
  expect(listed.data.items[0].overview).toMatchObject({
    revisionCount: 2,
    origin: { state: "unchanged" },
  });
  const history = (await f.get(`/sources/${first.source.id}/revisions`)).json().data;
  expect(history.revisions.map((item: { ordinal: number }) => item.ordinal)).toEqual([2, 1]);
  expect(history.revisions[0].changes.operations).toEqual({
    added: ["GET /c"],
    removed: ["GET /b"],
    changed: [],
  });
  // Negative control: a source ID from nowhere is not found, and the route needs authentication.
  expect((await f.get(`/sources/src_${randomUUID()}/revisions`)).statusCode).toBe(404);
  expect((await f.app.inject({ url: `/v1/sources/${first.source.id}/revisions` })).statusCode).toBe(
    401,
  );
});

it("UX-012 serves the requirement review, the discovery list and the feature map from catalog routes", async () => {
  const f = await fixture();
  const review = await f.get(`/projects/${f.init.projectId}/requirements/review`);
  expect(review.statusCode).toBe(200);
  expect(review.json().data).toMatchObject({ requirements: [], conflicts: [], changes: [] });
  const discovery = await f.get(`/projects/${f.init.projectId}/discovery`);
  expect(discovery.json().data).toMatchObject({ items: [], hasMore: false });
  const map = await f.get(`/projects/${f.init.projectId}/feature-map`);
  expect(map.json().data).toMatchObject({ discovery: null, rows: [], summary: { noTests: 0 } });
  // Negative control: another project's ID is not found, never an empty success.
  expect((await f.get(`/projects/prj_${randomUUID()}/feature-map`)).statusCode).toBe(404);
  expect(
    (
      await f.send("POST", `/projects/${f.init.projectId}/requirements/decisions`, {
        conflictId: "none",
        selectedRequirementId: `req_${randomUUID()}`,
        reason: "x",
        expectedVersion: 0,
      })
    ).statusCode,
  ).toBe(400);
});
