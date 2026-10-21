import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerEvent } from "@testmaster/contracts";
import { LeaseRepository, StaleFenceError } from "@testmaster/persistence";
import { afterEach, expect, it } from "vitest";
import { Application } from "./application.js";
import { AttemptSession } from "./attempt-session.js";
import { scaffoldPlan } from "./authoring.js";

const roots: string[] = [];
const apps: Application[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A claimed Attempt of a queued Run, with the session the controller opens for it. */
async function claimedSession() {
  const root = await mkdtemp(join(tmpdir(), "tm-attempt-session-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home, env: {} });
  apps.push(app);
  const init = await app.init();
  app.preflight = async () => {};
  const plan = scaffoldPlan("backend");
  const test = app.tests.create({ projectId: init.projectId, plan });
  const receipt = await app.runs.admit(
    {
      testId: test.id,
      environmentId: init.environmentId,
      extensions: { "testmaster:executor": "process" },
    },
    { wait: true },
  );
  const fence = new LeaseRepository(app.database).claim({
    workspaceId: app.worker.ctx.workspaceId,
    owner: "session-test",
    queue: "local",
    runIds: [receipt.runId],
  });
  if (!fence) throw new Error("the admitted Run was not claimable");
  const controller = new AbortController();
  const session = AttemptSession.open(app.worker.ctx, app.worker.host, fence, {
    workerId: null,
    signal: controller.signal,
  });
  const inputDir = join(root, "input");
  return { app, plan, fence, session, inputDir, runId: receipt.runId };
}

function runnerEvent(attemptId: string, seq: number, type: string, payload: unknown): RunnerEvent {
  return {
    protocolVersion: "1.0.0",
    seq,
    attemptId,
    occurredAt: new Date().toISOString(),
    type,
    payload,
  } as RunnerEvent;
}

function observationCount(app: Application, attemptId: string): number {
  return Number(
    app.database.get(
      "SELECT COUNT(*) AS n FROM observations WHERE workspace_id=? AND attempt_id=?",
      app.worker.ctx.workspaceId,
      attemptId,
    )?.n,
  );
}

it("accepts runner events in sequence order, stages evidence and completes the Run under its fence", async () => {
  const { app, plan, fence, session, inputDir, runId } = await claimedSession();
  const dispatch = await session.prepare(inputDir);
  if (!dispatch) throw new Error("the session settled the Run before dispatch");
  expect(dispatch).toMatchObject({ runId, attemptId: fence.attemptId });
  expect(app.runs.events(runId).map((event) => event.type)).toContain("run.snapshot_sealed");

  const step = plan.steps[0];
  if (!step) throw new Error("the scaffolded plan has no step");
  const started = runnerEvent(fence.attemptId, 0, "step.started", { stepId: step.id, index: 0 });
  await session.acceptEvent(0, started);
  // A repeated sequence with the same event is a no-op; a different event under it is refused.
  await session.acceptEvent(0, started);
  expect(observationCount(app, fence.attemptId)).toBe(1);
  await expect(
    session.acceptEvent(
      0,
      runnerEvent(fence.attemptId, 0, "step.started", { stepId: step.id, index: 1 }),
    ),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  // A sequence past the next one leaves a gap and is refused without effect.
  await expect(
    session.acceptEvent(
      2,
      runnerEvent(fence.attemptId, 2, "step.finished", {
        stepId: step.id,
        index: 0,
        status: "passed",
        durationMs: 1,
        evidencePaths: [],
      }),
    ),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  expect(observationCount(app, fence.attemptId)).toBe(1);

  // The runner numbers its events like the session here, so each one has its own `seq`.
  let sequence = 1;
  const accept = (type: string, payload: unknown) => {
    const seq = sequence++;
    const event = runnerEvent(fence.attemptId, seq, type, payload);
    return session.acceptEvent(seq, event).then(() => event);
  };
  for (const [index, planStep] of plan.steps.entries()) {
    if (index > 0) await accept("step.started", { stepId: planStep.id, index });
    await accept("step.finished", {
      stepId: planStep.id,
      index,
      status: "passed",
      durationMs: 1,
      evidencePaths: [],
    });
  }
  const finished = await accept("runner.finished", {
    outcome: "passed",
    reasonCode: "assertions_satisfied",
    cleanupOutcome: "not_required",
  });

  const staging = await session.evidence().openAttempt({
    workspaceId: fence.workspaceId,
    runId,
    attemptId: fence.attemptId,
    revisionId: dispatch.revisionId,
    snapshotId: dispatch.snapshotId,
    ...(dispatch.executionSnapshot ? { executionSnapshot: dispatch.executionSnapshot } : {}),
    ...(dispatch.reproduction ? { reproduction: dispatch.reproduction } : {}),
  });
  const writer = await staging.beginArtifact({
    relativePath: "logs/container.log",
    kind: "log",
    mimeType: "text/plain",
    sensitivity: "internal",
  });
  await writer.write(Buffer.from("runner log\n"));
  await writer.end();
  const bundle = await staging.commit({ redactionPolicyHash: "a".repeat(64) });

  await session.finalize({
    outcome: "passed",
    reasonCode: "assertions_satisfied",
    logDropped: 0,
    events: [finished],
    bundle,
  });
  expect(app.runs.get(runId)).toMatchObject({
    phase: "completed",
    outcome: "passed",
    gate: "passed",
  });
  expect(app.runs.events(runId).map((event) => event.type)).toContain("run.reduced");
  await session.close();
});

it("refuses events, secrets and finalization once the Attempt lost its lease", async () => {
  const { app, fence, session, inputDir, runId } = await claimedSession();
  const dispatch = await session.prepare(inputDir);
  if (!dispatch) throw new Error("the session settled the Run before dispatch");
  // An unsealed secret reference is never released, whatever the fence.
  await expect(session.resolveSecret("sec_unsealed", 1)).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
  app.database.withTx(() =>
    app.database.run(
      "UPDATE job_leases SET lease_expires_at=? WHERE workspace_id=? AND id=?",
      new Date(Date.now() - 1000).toISOString(),
      fence.workspaceId,
      fence.jobId,
    ),
  );
  await expect(
    session.acceptEvent(
      0,
      runnerEvent(fence.attemptId, 0, "log", { level: "info", message: "late" }),
    ),
  ).rejects.toBeInstanceOf(StaleFenceError);
  await expect(
    session.finalize({
      outcome: "passed",
      reasonCode: "assertions_satisfied",
      logDropped: 0,
      events: [],
    }),
  ).rejects.toBeInstanceOf(StaleFenceError);
  // A failure reported after the lease is gone leaves the Run to the reconciler.
  await session.fail(new Error("worker crashed"));
  expect(app.runs.get(runId).phase).not.toBe("completed");
  expect(observationCount(app, fence.attemptId)).toBe(0);
  await session.close();
});
