import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutablePlan, RunnerEvent } from "@testmaster/contracts";
import { AttemptExecutor, DockerExecutor, readImageLock } from "@testmaster/sandbox";
import { afterEach, expect, it, vi } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";

const roots: string[] = [];
const applications: Application[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of applications.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** One queued HTTP Run; admission and the worker see the checked-in image lock, never Docker. */
async function queuedRun() {
  const root = await mkdtemp(join(tmpdir(), "tm-worker-drain-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home, env: {} });
  applications.push(app);
  const init = await app.init();
  const lock = await readImageLock(
    new URL("../../../containers/images.lock.json", import.meta.url).pathname,
  );
  vi.spyOn(app, "preflight").mockResolvedValue();
  vi.spyOn(app, "images").mockResolvedValue(lock);
  vi.spyOn(app.runs.host, "admittedImages").mockReturnValue(lock);
  vi.spyOn(DockerExecutor.prototype, "listOrphans").mockResolvedValue({
    orphans: [],
    failures: [],
  });
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  const receipt = await app.runs.admit(
    { testId: test.id, environmentId: init.environmentId },
    { wait: true },
  );
  return { app, runId: receipt.runId };
}

/**
 * Stands in for the sandbox: the attempt starts its first step and holds it until the test
 * releases it, then passes every step. An abort of the attempt's signal ends it the way the
 * executor does, as `cancelled`.
 */
function heldAttempt() {
  const started = Promise.withResolvers<AbortSignal>();
  const released = Promise.withResolvers<void>();
  vi.spyOn(AttemptExecutor.prototype, "execute").mockImplementation(async (input, signal) => {
    if (!signal) throw new Error("The worker runs every attempt with an abort signal");
    let seq = 0;
    const emit = async (type: string, payload: unknown) => {
      const event = {
        protocolVersion: "1.0.0",
        seq: seq++,
        attemptId: input.attemptId,
        occurredAt: new Date().toISOString(),
        type,
        payload,
      } as RunnerEvent;
      await input.onEvent?.(event);
      return event;
    };
    const steps = (input.plan as ExecutablePlan).steps;
    await emit("step.started", { stepId: steps[0]?.id, index: 0 });
    started.resolve(signal);
    await Promise.race([
      released.promise,
      new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
    ]);
    if (signal.aborted)
      return { outcome: "cancelled", reasonCode: "user_cancelled", logDropped: 0, events: [] };
    for (const [index, step] of steps.entries()) {
      if (index > 0) await emit("step.started", { stepId: step.id, index });
      await emit("step.finished", {
        stepId: step.id,
        index,
        status: "passed",
        durationMs: 1,
        evidencePaths: [],
      });
    }
    const finished = await emit("runner.finished", {
      outcome: "passed",
      reasonCode: "assertions_satisfied",
      cleanupOutcome: "not_required",
    });
    return {
      outcome: "passed",
      reasonCode: "assertions_satisfied",
      logDropped: 0,
      events: [finished],
    };
  });
  return { started: started.promise, release: () => released.resolve() };
}

/** Waits for `count` more scheduling passes of the worker loop: each one writes a new heartbeat. */
async function passes(app: Application, workerId: string, count: number): Promise<void> {
  const seen = new Set<unknown>();
  await vi.waitFor(
    () => {
      seen.add(
        app.database.get("SELECT last_heartbeat_at FROM workers WHERE id=?", workerId)
          ?.last_heartbeat_at,
      );
      if (seen.size <= count) throw new Error("The worker has not scheduled again yet");
    },
    { timeout: 10_000, interval: 10 },
  );
}

it("OPS-015 a draining worker lets the attempt in flight finish however long the drain lasts", async () => {
  const { app, runId } = await queuedRun();
  const attempt = heldAttempt();
  // Monotonic time runs normally until the test moves it ten minutes ahead.
  let skippedMs = 0;
  const now = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => now() + skippedMs);
  const drain = new AbortController();
  let workerId = "";
  const running = app.worker.run({
    signal: drain.signal,
    onReady: (id) => {
      workerId = id;
    },
  });
  const signal = await attempt.started;
  drain.abort();
  await passes(app, workerId, 2);
  skippedMs = 10 * 60_000;
  await passes(app, workerId, 2);
  expect(signal.aborted).toBe(false);
  attempt.release();
  await expect(running).resolves.toMatchObject({ drained: true });
  expect(signal.aborted).toBe(false);
  expect(app.runs.get(runId)).toMatchObject({ phase: "completed", outcome: "passed" });
});

it("OPS-015 a forced stop ends the attempt a draining worker still runs, and never as passed", async () => {
  const { app, runId } = await queuedRun();
  const attempt = heldAttempt();
  const drain = new AbortController();
  const force = new AbortController();
  let workerId = "";
  const running = app.worker.run({
    signal: drain.signal,
    force: force.signal,
    onReady: (id) => {
      workerId = id;
    },
  });
  const signal = await attempt.started;
  drain.abort();
  await passes(app, workerId, 2);
  // Control: the drain alone leaves the attempt running.
  expect(signal.aborted).toBe(false);
  force.abort();
  await expect(running).resolves.toMatchObject({ drained: true });
  expect(signal.aborted).toBe(true);
  expect(app.runs.get(runId)).toMatchObject({ phase: "completed", outcome: "inconclusive" });
});
