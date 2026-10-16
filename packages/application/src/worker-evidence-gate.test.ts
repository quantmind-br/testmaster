import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerEvent } from "@testmaster/contracts";
import { exitCodeForRun, uuidV7IdGenerator } from "@testmaster/domain";
import type * as Evidence from "@testmaster/evidence";
import { AttemptExecutor } from "@testmaster/sandbox";
import { afterEach, expect, it, vi } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";
import { runVerdict } from "./run-verdict.js";

const manifest = vi.hoisted(() => ({ entries: [] as Record<string, unknown>[] }));
vi.mock("@testmaster/evidence", async (importOriginal) => ({
  ...(await importOriginal<typeof Evidence>()),
  verifyBundle: vi.fn(async () => ({
    meta: {
      manifestHash: "a".repeat(64),
      committedAt: new Date().toISOString(),
      redactionPolicyHash: "b".repeat(64),
    },
    manifest: { entries: manifest.entries },
  })),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function entry(state: "available" | "missing") {
  return {
    artifactId: uuidV7IdGenerator.next("art"),
    relativePath: "http/orders.json",
    kind: "http",
    mimeType: "application/json",
    sizeBytes: state === "available" ? 2 : 0,
    sha256: state === "available" ? "c".repeat(64) : null,
    state,
    redactionStatus: state === "available" ? "redacted" : "not_applicable",
    ...(state === "missing" ? { omissionReason: "redaction_failed" } : {}),
  };
}

/** Every step passes, so only the evidence manifest decides the gate. */
async function passedRun(state: "available" | "missing") {
  const root = await mkdtemp(join(tmpdir(), "tm-evidence-gate-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home, env: {} });
  const init = await app.init();
  app.preflight = async () => {};
  const plan = scaffoldPlan("backend");
  const test = app.tests.create({ projectId: init.projectId, plan });
  manifest.entries = [entry(state)];
  vi.spyOn(AttemptExecutor.prototype, "execute").mockImplementation(async (input) => {
    let seq = 0;
    const emit = (type: string, payload: unknown) =>
      input.onEvent?.({
        protocolVersion: "1.0.0",
        seq: seq++,
        attemptId: input.attemptId,
        occurredAt: new Date().toISOString(),
        type,
        payload,
      } as RunnerEvent);
    for (const [index, step] of plan.steps.entries()) {
      await emit("step.started", { stepId: step.id, index });
      await emit("step.finished", {
        stepId: step.id,
        index,
        status: "passed",
        durationMs: 1,
        evidencePaths: [],
      });
    }
    const finished = {
      protocolVersion: "1.0.0",
      seq,
      attemptId: input.attemptId,
      occurredAt: new Date().toISOString(),
      type: "runner.finished",
      payload: {
        outcome: "passed",
        reasonCode: "assertions_satisfied",
        cleanupOutcome: "not_required",
      },
    } as RunnerEvent;
    await input.onEvent?.(finished);
    return {
      outcome: "passed",
      reasonCode: "assertions_satisfied",
      logDropped: 0,
      events: [finished],
      bundle: { bundleDir: root, manifestSha256: "x" },
    };
  });
  const receipt = await app.runs.admit(
    {
      testId: test.id,
      environmentId: init.environmentId,
      extensions: { "testmaster:executor": "process" },
    },
    { wait: true },
  );
  await app.worker.run({ ephemeral: true, runIds: [receipt.runId] });
  const run = app.runs.get(receipt.runId);
  const events = app.runs.events(receipt.runId);
  app.close();
  return { run, events, verdict: runVerdict(run, events) };
}

it("explains a passed run whose gate failed on unavailable evidence and never exits 0", async () => {
  const { run, events, verdict } = await passedRun("missing");
  expect(run).toMatchObject({ phase: "completed", outcome: "passed", gate: "failed" });
  const completed = events.findLast((event) => event.type === "run.completed");
  expect(completed?.payload).toMatchObject({ reasonCode: "evidence_incomplete" });
  expect(verdict).toEqual({
    reasonCode: "evidence_incomplete",
    unavailableEvidence: [
      {
        relativePath: "http/orders.json",
        kind: "http",
        state: "missing",
        omissionReason: "redaction_failed",
      },
    ],
  });
  expect(
    exitCodeForRun({ gate: run.gate, outcome: run.outcome, reasonCode: verdict.reasonCode }),
  ).toBe(1);
});

it("keeps assertions_satisfied and exit 0 when all evidence is available", async () => {
  const { run, verdict } = await passedRun("available");
  expect(run).toMatchObject({ outcome: "passed", gate: "passed" });
  expect(verdict).toEqual({ reasonCode: "assertions_satisfied" });
  expect(
    exitCodeForRun({ gate: run.gate, outcome: run.outcome, reasonCode: verdict.reasonCode }),
  ).toBe(0);
});
