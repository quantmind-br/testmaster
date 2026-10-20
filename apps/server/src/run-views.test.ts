import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, issueLocalToken, scaffoldPlan } from "@testmaster/application";
import { afterEach, expect, it } from "vitest";
import { seedRun } from "../../../packages/application/src/run-seed.testing.js";
import { OutboxRepository } from "../../../packages/persistence/src/index.js";
import { createServer } from "./server.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-run-views-http-"));
  const home = join(cwd, "home");
  await mkdir(home);
  await mkdir(join(home, ".config", "testmaster"), { recursive: true });
  await writeFile(join(home, ".config", "testmaster", "policy.json"), JSON.stringify({}));
  const application = await Application.open({ cwd, home, env: {} });
  const init = await application.init();
  const test = application.tests.create({
    projectId: init.projectId,
    plan: scaffoldPlan("backend"),
  });
  const issued = await issueLocalToken(application);
  const app = createServer({ application, mcp: false, origins: ["http://127.0.0.1:7331"] });
  cleanup.push(async () => {
    await app.close();
    application.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const get = (url: string) =>
    app.inject({ url, headers: { authorization: `Bearer ${issued.token}` } });
  return { app, application, init, test, get };
}

it("UX-029 GET /runs/{id}/attempts returns every Attempt with its policy and retry reason", async () => {
  const f = await fixture();
  const seeded = await seedRun(f.application, {
    testId: f.test.id,
    environmentId: f.init.environmentId,
    attempts: [
      {
        outcome: "failed",
        steps: [{ stepId: "s1", status: "failed", reasonCode: "assertion_mismatch" }],
      },
      { outcome: "passed", steps: [{ stepId: "s1", status: "passed" }] },
    ],
  });
  const response = await f.get(`/v1/runs/${seeded.runId}/attempts`);
  expect(response.statusCode).toBe(200);
  const items = (
    response.json().data.items as { number: number; retry: unknown; policy: unknown }[]
  ).sort((a, b) => a.number - b.number);
  expect(items.map((item) => item.number)).toEqual([1, 2]);
  expect(items[1]?.retry).toMatchObject({
    category: "diagnostic",
    reasonCode: "assertion_mismatch",
  });
  expect(items[0]?.policy).toEqual({ maxAttempts: 2 });
  // Negative control: an unknown Run is a not-found error, not an empty list.
  expect((await f.get("/v1/runs/run_00000000000000000000000000/attempts")).statusCode).toBe(404);
}, 60_000);

const unavailableEvidence = [
  {
    relativePath: "http/orders.json",
    kind: "http",
    state: "missing",
    omissionReason: "redaction_failed",
  },
];

it("GET /runs/{id} returns the verdict of the final reduction while GET /runs items stay bare", async () => {
  const f = await fixture();
  const evidenceGap = await seedRun(f.application, {
    testId: f.test.id,
    environmentId: f.init.environmentId,
    attempts: [{ outcome: "passed", steps: [{ stepId: "s1", status: "passed" }] }],
    gate: "failed",
  });
  f.application.database.withTx(() =>
    new OutboxRepository(f.application.database).append(
      f.application.context.workspaceId,
      evidenceGap.runId,
      "run.reduced",
      { outcome: "passed", reasonCode: "evidence_incomplete", unavailableEvidence },
    ),
  );
  const plain = await seedRun(f.application, {
    testId: f.test.id,
    environmentId: f.init.environmentId,
    attempts: [{ outcome: "passed" }],
  });

  const response = await f.get(`/v1/runs/${evidenceGap.runId}`);
  expect(response.statusCode).toBe(200);
  const data = response.json().data;
  expect(data).toMatchObject({
    outcome: "passed",
    gate: "failed",
    reasonCode: "evidence_incomplete",
  });
  expect(data.unavailableEvidence).toEqual(unavailableEvidence);
  // The list rows are the stored Run: no verdict fields.
  const listed = (await f.get("/v1/runs")).json().data.items as Record<string, unknown>[];
  const row = listed.find((item) => item.id === evidenceGap.runId);
  expect(row).toBeDefined();
  expect(row).not.toHaveProperty("reasonCode");
  // Negative control: a reduction without a reason adds no reasonCode.
  const bare = (await f.get(`/v1/runs/${plain.runId}`)).json().data;
  expect(bare.outcome).toBe("passed");
  expect(bare).not.toHaveProperty("reasonCode");
}, 60_000);

it("UX-035 UX-036 GET /runs filters by batch so a matrix page lists exactly its members", async () => {
  const f = await fixture();
  f.application.preflight = async () => {};
  const batch = await f.application.batches.admit(
    {
      selection: [{ testId: f.test.id, environmentId: f.init.environmentId }],
    } as Parameters<typeof f.application.batches.admit>[0],
    { wait: true },
  );
  const outside = await seedRun(f.application, {
    testId: f.test.id,
    environmentId: f.init.environmentId,
    attempts: [{ outcome: "passed" }],
  });
  const inBatch = await f.get(`/v1/runs?batchId=${batch.batchId}`);
  expect(inBatch.statusCode).toBe(200);
  const ids = inBatch.json().data.items.map((item: { id: string }) => item.id);
  expect(ids).toHaveLength(1);
  expect(ids).not.toContain(outside.runId);
  const all = await f.get("/v1/runs");
  expect(all.json().data.items).toHaveLength(2);
}, 60_000);

it("VAL-007 GET /projects/{id}/metrics and /quarantine expose rates and visible quarantine records", async () => {
  const f = await fixture();
  await seedRun(f.application, {
    testId: f.test.id,
    environmentId: f.init.environmentId,
    attempts: [{ outcome: "failed" }],
  });
  f.application.quarantine.set(f.test.id, {
    reason: "tracked in the flaky backlog",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const metrics = await f.get(`/v1/projects/${f.init.projectId}/metrics`);
  expect(metrics.statusCode).toBe(200);
  expect(metrics.json().data).toMatchObject({
    projectId: f.init.projectId,
    considered: 1,
    truncated: false,
    quarantined: [{ testId: f.test.id, active: true, failedRunsInWindow: 1 }],
  });
  expect(metrics.json().data.metrics.rates.terminalPassRate).toMatchObject({
    numerator: 0,
    denominator: 1,
  });
  const quarantine = await f.get(`/v1/projects/${f.init.projectId}/quarantine`);
  expect(quarantine.json().data.items).toMatchObject([
    { testId: f.test.id, reason: "tracked in the flaky backlog" },
  ]);
  // Negative control: an inverted window is a client error and never an empty dashboard.
  const inverted = await f.get(
    `/v1/projects/${f.init.projectId}/metrics?since=2030-01-02T00:00:00.000Z&until=2030-01-01T00:00:00.000Z`,
  );
  expect(inverted.statusCode).toBe(400);
}, 60_000);
