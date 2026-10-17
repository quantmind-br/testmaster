import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Application, scaffoldPlan } from "@testmaster/application";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpServer } from "./server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-mcp-lists-"));
  const app = await Application.open({ cwd, home: join(cwd, "home"), env: {} });
  const init = await app.init();
  vi.spyOn(Application.prototype, "preflight").mockResolvedValue();
  vi.spyOn(Object.getPrototypeOf(app.worker), "live").mockReturnValue(true);
  const first = app.tests.create({
    projectId: init.projectId,
    plan: scaffoldPlan("backend"),
    name: "checkout",
  });
  app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend"), name: "profile" });
  const suite = app.suites.create({
    name: "nightly",
    selection: {
      kind: "dynamic",
      projects: [{ projectId: init.projectId, environmentId: init.environmentId }],
    },
  });
  const connect = async (scopes: ("R" | "W" | "X")[]) => {
    const server = createMcpServer({
      application: app.forIdentity({ principalId: init.principalId, scopes }),
      roots: [cwd],
    });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(right);
    const client = new Client({ name: "lists-test", version: "1" });
    await client.connect(left);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  };
  cleanups.push(async () => {
    app.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const call = async (
    client: Client,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; body: Record<string, unknown> }> => {
    const result = await client.callTool({ name: "testmaster_run_tests", arguments: args });
    const text = String((result.content as { text: string }[])[0]?.text);
    return { isError: result.isError === true, body: JSON.parse(text) };
  };
  return { app, init, suite, first, connect, call };
}

it("REQ-034 testmaster_run_tests with a suiteId admits one frozen batch for the list and replays an idempotency key", async () => {
  const f = await fixture();
  const client = await f.connect(["R", "W", "X"]);
  const key = "mcp-list-run-0123456789";
  const first = await f.call(client, { suiteId: f.suite.id, mode: "replay", idempotencyKey: key });
  expect(first.isError).toBe(false);
  expect(f.app.database.all("SELECT id FROM batches")).toHaveLength(1);
  const batch = f.app.database.get("SELECT id,data_json FROM batches");
  expect(JSON.parse(String(batch?.data_json))).toMatchObject({ suiteId: f.suite.id });
  expect(f.app.database.all("SELECT id FROM runs")).toHaveLength(2);
  const replay = await f.call(client, { suiteId: f.suite.id, mode: "replay", idempotencyKey: key });
  expect(replay.isError).toBe(false);
  expect(f.app.database.all("SELECT id FROM batches")).toHaveLength(1);
  expect(JSON.stringify(replay.body)).toContain(String(batch?.id));
  // Positive control for the legacy path: explicit tests still need an environment and admit as before.
  const tests = await f.call(client, {
    testIds: [f.first.id],
    environmentId: f.init.environmentId,
    mode: "replay",
  });
  expect(tests.isError).toBe(false);
  expect(f.app.database.all("SELECT id FROM batches")).toHaveLength(2);
});

it("REQ-034 UX-042 testmaster_run_tests refuses lists without execution scope, mixed selections, unsupported modes and a missing environment", async () => {
  const f = await fixture();
  const reader = await f.connect(["R"]);
  const denied = await f.call(reader, { suiteId: f.suite.id, mode: "replay" });
  expect(denied.isError).toBe(true);
  expect(denied.body).toMatchObject({ error: { code: "FORBIDDEN" } });
  const client = await f.connect(["R", "W", "X"]);
  const mixed = await f.call(client, {
    suiteId: f.suite.id,
    testIds: [f.first.id],
    environmentId: f.init.environmentId,
    mode: "replay",
  });
  expect(mixed.body).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
  const explore = await f.call(client, { suiteId: f.suite.id, mode: "explore" });
  expect(explore.body).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
  const noEnvironment = await f.call(client, { testIds: [f.first.id], mode: "replay" });
  expect(noEnvironment.body).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
  const unknownExclusion = await f.call(client, {
    suiteId: f.suite.id,
    mode: "replay",
    confirmedExclusions: ["project:prj_00000000-0000-4000-8000-000000000000"],
  });
  expect(unknownExclusion.body).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
  expect(f.app.database.all("SELECT id FROM batches")).toEqual([]);
});

it("REQ-034 UX-042 testmaster_run_tests refuses a partial list until the dropped project is confirmed and then declares it", async () => {
  const f = await fixture();
  const second = f.app.projects.create({ name: "Second project" });
  const staging = f.app.environments.create({
    projectId: second.id,
    name: "staging",
    baseUrl: "http://127.0.0.1:4102",
  });
  f.app.tests.create({ projectId: second.id, plan: scaffoldPlan("backend"), name: "b-one" });
  const suite = f.app.suites.create({
    name: "two-projects",
    selection: {
      kind: "dynamic",
      projects: [
        { projectId: f.init.projectId, environmentId: f.init.environmentId },
        { projectId: second.id, environmentId: staging.id },
      ],
    },
  });
  f.app.environments.archive(
    staging.id,
    Number(f.app.environments.get(staging.id, second.id).version),
  );
  const client = await f.connect(["R", "W", "X"]);
  const denied = await f.call(client, { suiteId: suite.id, mode: "replay" });
  expect(denied.isError).toBe(true);
  expect(denied.body).toMatchObject({
    error: { code: "PRECONDITION_FAILED", details: { nextActions: ["confirm_subset"] } },
  });
  expect(f.app.database.all("SELECT id FROM batches")).toEqual([]);
  const confirmed = await f.call(client, {
    suiteId: suite.id,
    mode: "replay",
    confirmedExclusions: [`project:${second.id}`],
  });
  expect(confirmed.isError).toBe(false);
  expect(JSON.stringify(confirmed.body)).toContain(`project:${second.id}`);
  expect(f.app.database.all("SELECT id FROM runs")).toHaveLength(2);
});

it("run_tests wait deadline is UPSTREAM_TIMEOUT with resume details and the receipt is read live", async () => {
  const f = await fixture();
  const client = await f.connect(["R", "W", "X"]);
  const args = { environmentId: f.init.environmentId, mode: "replay" };
  const timed = await f.call(client, {
    ...args,
    testIds: [f.first.id],
    wait: true,
    timeoutMs: 1,
  });
  expect(timed.isError).toBe(true);
  const error = timed.body.error as { code: string; details: Record<string, unknown> };
  expect(error.code).toBe("UPSTREAM_TIMEOUT");
  expect(error.details).toMatchObject({ waitTimeout: true, runsContinue: true });
  const runIds = error.details.runIds as string[];
  expect(runIds).toHaveLength(1);
  const jobId = String(error.details.jobId);

  type Member = { status: string; queue?: unknown; resources: Record<string, string> };
  const receipt = async () => {
    const read = await f.call(client, { ...args, jobId });
    expect(read.isError).toBe(false);
    return (read.body.memberRuns as Member[])[0] as Member;
  };
  // Control: while the run still waits, the receipt says so.
  expect((await receipt()).status).toBe("queued");
  f.app.runs.cancel(String(runIds[0]));
  // The admission-time receipt said queued; the live one follows the run and drops the stale queue.
  const after = await receipt();
  expect(after.status).toBe("cancelled");
  expect(after).not.toHaveProperty("queue");
  expect(after.resources.result).toBe(`testmaster://runs/${runIds[0]}/result`);
  expect(after.resources.report).toBe(`testmaster://runs/${runIds[0]}/report`);
});

it("open_report with a batchId serves one report over both member runs with the aggregate counts", async () => {
  const f = await fixture();
  const client = await f.connect(["R", "W", "X"]);
  const admitted = await f.call(client, { suiteId: f.suite.id, mode: "replay" });
  expect(admitted.isError).toBe(false);
  const batchId = String(admitted.body.batchId);
  const runIds = f.app.database.all("SELECT id FROM runs").map((row) => String(row.id));
  expect(runIds).toHaveLength(2);
  for (const runId of runIds)
    f.app.database.run(
      "UPDATE runs SET phase='completed',status='passed',outcome='passed',gate='passed' WHERE workspace_id=? AND id=?",
      f.app.context.workspaceId,
      runId,
    );
  const open = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: "testmaster_open_report", arguments: args });
    return {
      isError: result.isError === true,
      body: JSON.parse(String((result.content as { text: string }[])[0]?.text)),
    };
  };
  const opened = await open({ batchId });
  expect(opened.isError).toBe(false);
  const location = `testmaster://batches/${batchId}/report`;
  expect(opened.body).toEqual({
    location,
    formats: {
      json: location,
      markdown: `${location}?format=markdown`,
      html: `${location}?format=html`,
      junit: `${location}?format=junit`,
    },
  });
  // Each listed format URI opens that format.
  const markdown = (await client.readResource({ uri: opened.body.formats.markdown })).contents[0];
  expect(markdown?.mimeType).toBe("text/markdown");
  const junit = (await client.readResource({ uri: opened.body.formats.junit })).contents[0];
  expect(String(junit?.text)).toMatch(/^<\?xml/u);
  const content = (await client.readResource({ uri: opened.body.location })).contents[0] as Record<
    string,
    unknown
  >;
  const report = JSON.parse(String(content.text));
  expect(report.runs.map((entry: { run: { id: string } }) => entry.run.id).sort()).toEqual(
    [...runIds].sort(),
  );
  expect(report.executionMetrics.counts).toMatchObject({ requested: 2, accepted: 2, passed: 2 });
  expect((content._meta as Record<string, unknown>)["testmaster:batch"]).toMatchObject({
    batchId,
    memberRuns: expect.arrayContaining(runIds),
  });
  // Control: a run report covers that run alone.
  const single = (await client.readResource({ uri: `testmaster://runs/${runIds[0]}/report` }))
    .contents[0] as Record<string, unknown>;
  expect(JSON.parse(String(single.text)).runs).toHaveLength(1);
  // Exactly one id is accepted, and a run id never opens a batch report.
  expect((await open({ batchId, runId: runIds[0] })).body).toMatchObject({
    error: { code: "INVALID_ARGUMENT" },
  });
  expect((await open({})).body).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
  await expect(
    client.readResource({ uri: `testmaster://batches/${runIds[0]}/report` }),
  ).rejects.toMatchObject({ code: -32002 });
});
