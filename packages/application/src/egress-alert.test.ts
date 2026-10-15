import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttemptExecutor, readImageLock } from "@testmaster/sandbox";
import { afterEach, expect, it, vi } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";
import { seedRun } from "./run-seed.testing.js";

const roots: string[] = [];
const applications: Application[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of applications.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface EgressFixture {
  app: Application;
  init: { projectId: string; environmentId: string };
  test: { id: string };
}
async function fixture(): Promise<EgressFixture> {
  const root = await mkdtemp(join(tmpdir(), "tm-egress-alert-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home });
  applications.push(app);
  const init = await app.init();
  app.preflight = async () => {};
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  return { app, init, test };
}

/** Runs one admitted Run through the real worker; only the sandbox attempt result is stubbed. */
async function workerBlocked(
  fx: EgressFixture,
  reasonCode: "egress_denied" | "security_precondition_failed",
): Promise<string> {
  const lock = await readImageLock(
    new URL("../../../containers/images.lock.json", import.meta.url).pathname,
  );
  vi.spyOn(fx.app, "images").mockResolvedValue(lock);
  vi.spyOn(fx.app.runs.host, "admittedImages").mockReturnValue(lock);
  const execute = vi.spyOn(AttemptExecutor.prototype, "execute").mockResolvedValue({
    outcome: "blocked",
    reasonCode,
    logDropped: 0,
    events: [],
  });
  const receipt = await fx.app.runs.admit(
    { testId: fx.test.id, environmentId: fx.init.environmentId, limits: { maxAttempts: 1 } },
    { wait: true },
  );
  await fx.app.worker.run({ ephemeral: true, runIds: [receipt.runId] });
  // The sandbox attempt really ran, so the reason below comes from its result, not an admission refusal.
  expect(execute).toHaveBeenCalledOnce();
  return receipt.runId;
}

const completedPayload = (app: Application, runId: string): Record<string, unknown> =>
  (app.runs.events(runId).find((event) => event.type === "run.completed")?.payload ?? {}) as Record<
    string,
    unknown
  >;

it("OPS-028 egress_denied fires for a Run the worker finalized as blocked, with no seeded reason code", async () => {
  const fx = await fixture();
  const runId = await workerBlocked(fx, "egress_denied");
  expect(fx.app.runs.get(runId)).toMatchObject({
    phase: "completed",
    outcome: "blocked",
    gate: "failed",
  });
  // The finalized Run document has no reason field; the completion event carries the final one.
  expect(fx.app.runs.get(runId)).not.toHaveProperty("reasonCode");
  expect(completedPayload(fx.app, runId)).toMatchObject({
    id: runId,
    outcome: "blocked",
    reasonCode: "egress_denied",
  });

  const evaluated = await fx.app.alerts.evaluate();
  expect(evaluated.errors.egress_denied).toBeUndefined();
  const alert = evaluated.fired.find((candidate) => candidate.rule === "egress_denied");
  expect(alert, "egress_denied must fire").toBeDefined();
  expect(alert?.detail).toMatchObject({ denied: 1 });
});

it("OPS-028 egress_denied stays quiet for a passing Run and for a Run blocked by another reason", async () => {
  const fx = await fixture();
  const passed = await seedRun(fx.app, {
    testId: fx.test.id,
    environmentId: fx.init.environmentId,
    attempts: [{ outcome: "passed", steps: [{ stepId: "step-1", status: "passed" }] }],
  });
  expect(fx.app.runs.get(passed.runId)).toMatchObject({ outcome: "passed", gate: "passed" });
  const blocked = await workerBlocked(fx, "security_precondition_failed");
  expect(completedPayload(fx.app, blocked)).toMatchObject({
    outcome: "blocked",
    reasonCode: "security_precondition_failed",
  });

  const evaluated = await fx.app.alerts.evaluate();
  expect(evaluated.errors.egress_denied).toBeUndefined();
  expect(evaluated.fired.map((alert) => alert.rule)).not.toContain("egress_denied");
});
