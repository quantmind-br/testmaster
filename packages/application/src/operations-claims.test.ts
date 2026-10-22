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

/** A local workspace whose admission and worker see the checked-in image lock, never Docker. */
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "tm-claims-"));
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
  vi.spyOn(DockerExecutor.prototype, "listOrphans").mockResolvedValue([]);
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  const admit = async () =>
    (await app.runs.admit({ testId: test.id, environmentId: init.environmentId }, { wait: true }))
      .runId;
  return { app, init, admit };
}

/** Stands in for the sandbox: every attempt holds its first step until the test releases it. */
function heldAttempts() {
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  vi.spyOn(AttemptExecutor.prototype, "execute").mockImplementation(async (input) => {
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
    started.resolve();
    await released.promise;
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

it("OPS-035 paused worker claims keep a queued Run queued until resume while the running Attempt finishes", async () => {
  const { app, init, admit } = await workspace();
  const attempts = heldAttempts();
  const first = await admit();
  const stop = new AbortController();
  let workerId = "";
  const running = app.worker.run({
    signal: stop.signal,
    onReady: (id) => {
      workerId = id;
    },
  });
  await attempts.started;

  const paused = app.operations.workerClaims({
    action: "pause",
    reason: "suspected egress bypass",
  });
  expect(paused.claims).toMatchObject({ paused: true, reason: "suspected egress bypass" });
  // Admission is a separate switch: the paused workspace still queues new work.
  expect(paused.admission.state).toBe("enabled");
  const second = await admit();
  attempts.release();
  await vi.waitFor(() => expect(app.runs.get(first).phase).toBe("completed"), {
    timeout: 10_000,
  });
  expect(app.runs.get(first).outcome).toBe("passed");
  await passes(app, workerId, 3);
  expect(app.runs.get(second).phase).toBe("queued");

  const viewer = app.forIdentity({ principalId: init.principalId, scopes: ["R"] });
  expect(() => viewer.operations.workerClaims({ action: "resume", reason: "viewer" })).toThrowError(
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
  expect(app.operations.status().claims.paused).toBe(true);

  expect(app.operations.workerClaims({ action: "resume", reason: "contained" }).claims).toEqual({
    paused: false,
    reason: null,
    changedBy: null,
    changedAt: null,
  });
  await vi.waitFor(() => expect(app.runs.get(second).phase).toBe("completed"), {
    timeout: 10_000,
  });
  expect(app.runs.get(second).outcome).toBe("passed");
  const audited = app.database
    .all("SELECT action FROM audit_events WHERE action LIKE 'ops.claims.%' ORDER BY timestamp")
    .map((row) => String(row.action));
  expect(audited).toEqual(["ops.claims.pause", "ops.claims.resume"]);
  stop.abort();
  await running;
});
