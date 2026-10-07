import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { type ModelCallRecord, SqliteModelCallRecorder } from "@testmaster/persistence";
import { afterEach, expect, it } from "vitest";
import { Application } from "../application.js";
import { scaffoldPlan } from "../authoring.js";
import { aggregateUsage } from "./usage.js";

const roots: string[] = [];
const applications: Application[] = [];
afterEach(async () => {
  for (const app of applications.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it("filtered usage reconciles immutable ledger rows, unknown costs and disclosed token components", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-usage-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home });
  applications.push(app);
  const init = await app.init();
  const recorder = new SqliteModelCallRecorder(app.database);
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  const runId = uuidV7IdGenerator.next("run");
  app.context.entities.insert("Run", {
    id: runId,
    workspaceId: app.context.workspaceId,
    testId: test.id,
    revisionId: test.activeRevisionId,
    environmentRevisionId: app.environments.get(init.environmentId).activeRevisionId,
    batchId: null,
    matrixCell: {},
    mode: "replay",
    phase: "completed",
    status: "passed",
    outcome: "passed",
    origin: "usage-test",
    gatePolicy: {},
    gate: "passed",
    cleanupOutcome: "not_required",
    analysisStatus: "not_requested",
  });
  const base: ModelCallRecord = {
    id: uuidV7IdGenerator.next("mdl"),
    workspaceId: app.context.workspaceId,
    projectId: init.projectId,
    createdAt: "2026-01-01T00:00:00.000Z",
    purpose: "analyze",
    provider: "test",
    model: "a",
    promptHash: "a".repeat(64),
    inputRefs: [],
    usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5 },
    cost: "unknown",
    latency: 3,
    outcome: "success",
    cacheHit: false,
    repairAttempt: 0,
    transportAttempt: 0,
    reservationId: null,
    responseHash: null,
    finishReason: null,
  };
  await recorder.record(base);
  await recorder.record({
    ...base,
    id: uuidV7IdGenerator.next("mdl"),
    runId,
    model: "b",
    createdAt: "2026-01-02T00:00:00.000Z",
    cost: { currency: "USD", scale: 6, amount: "12" },
    rawPrompt: "private text",
  });
  const selected = app.usage.get({
    projectId: init.projectId,
    runId,
    model: "b",
    since: "2026-01-02T00:00:00.000Z",
    until: "2026-01-02T00:00:00.000Z",
  });
  expect(selected.calls).toHaveLength(1);
  expect(selected.tokens).toEqual({ inputTokens: 10, outputTokens: 20, reasoningTokens: 5 });
  expect(selected.measuredCosts).toEqual([{ currency: "USD", scale: 6, amount: "12" }]);
  expect(selected.calls[0]).not.toHaveProperty("rawPrompt");
  const all = app.usage.get({ projectId: init.projectId });
  expect(all.unknownCostCalls).toBe(1);
  expect(all.cost).toBe("unknown");
  expect(all.measuredCosts).toEqual([{ currency: "USD", scale: 6, amount: "12" }]);
  expect(all.tokens.inputTokens! + all.tokens.outputTokens!).toBe(60);
  expect(all.lifetimeBudget.scope).toBe("project_lifetime");
  const uncertain = aggregateUsage([
    { ...base, usage: { inputTokens: null, outputTokens: 20, reasoningTokens: null } },
  ]);
  expect(uncertain.tokens.inputTokens).toBeNull();
  expect(uncertain.unknownTokenCalls.inputTokens).toBe(1);
  expect(() =>
    app.usage.get({ since: "2026-01-03T00:00:00.000Z", until: "2026-01-01T00:00:00.000Z" }),
  ).toThrow();
});
