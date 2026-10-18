import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutablePlan, RunnerEvent } from "@testmaster/contracts";
import { AttemptExecutor, readImageLock } from "@testmaster/sandbox";
import { afterEach, expect, it, vi } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";
import { entity } from "./context.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/**
 * Stands in for the sandbox: a jsonEquals step whose pointer is not `/status` reads nothing, as
 * the runner does on a body `{"status": "ok"}`; every other step passes.
 */
function fakeRunner(executed: ExecutablePlan[], cleanupOutcome = "not_required") {
  vi.spyOn(AttemptExecutor.prototype, "execute").mockImplementation(async (input) => {
    const plan = input.plan as ExecutablePlan;
    executed.push(plan);
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
    let failed = false;
    for (const [index, step] of plan.steps.entries()) {
      await emit("step.started", { stepId: step.id, index });
      const pointer =
        step.kind === "assertion" && "jsonPointer" in step.input ? step.input.jsonPointer : null;
      const wrong = pointer !== null && pointer !== undefined && pointer !== "/status";
      failed ||= wrong;
      await emit(
        "step.finished",
        wrong
          ? {
              stepId: step.id,
              index,
              status: "failed",
              reasonCode: "assertion_mismatch",
              error: {
                code: "RuntimeError",
                message: `HTTP jsonEquals expectation was not satisfied; missing JSON pointer: ${pointer}`,
              },
              expected: "ok",
              observed: null,
              durationMs: 1,
              evidencePaths: [],
            }
          : { stepId: step.id, index, status: "passed", durationMs: 1, evidencePaths: [] },
      );
    }
    const outcome = failed ? "failed" : "passed";
    const reasonCode = failed ? "assertion_mismatch" : "assertions_satisfied";
    const finished = await emit("runner.finished", {
      outcome,
      reasonCode,
      cleanupOutcome,
    });
    return { outcome, reasonCode, logDropped: 0, events: [finished] };
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tm-plan-trial-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home, env: {} });
  const init = await app.init();
  const lock = await readImageLock(
    new URL("../../../containers/images.lock.json", import.meta.url).pathname,
  );
  vi.spyOn(app, "preflight").mockResolvedValue();
  vi.spyOn(app, "images").mockResolvedValue(lock);
  vi.spyOn(app.runs.host, "admittedImages").mockReturnValue(lock);
  const batch = entity(app.context, "pbt", {
    projectId: init.projectId,
    sourceSnapshotId: "seeded",
    state: "proposed",
  });
  app.context.entities.insert("ProposalBatch", batch);
  const propose = (
    pointer: string,
    fields: { state?: string; validation?: string } = {},
  ): string => {
    const plan = scaffoldPlan("backend");
    const check = plan.steps[2];
    if (check?.kind !== "assertion" || !("responseStepId" in check.input))
      throw new Error("Bad scaffold");
    check.input = { ...check.input, jsonPointer: pointer };
    plan.name = `Health at ${pointer}`;
    const proposal = entity(app.context, "pro", {
      batchId: batch.id,
      plan,
      requirementRefs: [],
      evidenceRefs: [],
      warnings: [],
      state: fields.state ?? "proposed",
      validation: fields.validation ?? "valid",
    });
    app.context.entities.insert("Proposal", proposal);
    return proposal.id;
  };
  return { app, init, batchId: batch.id, propose };
}

function modelCalls(app: Application): number {
  return Number(app.database.get("SELECT COUNT(*) AS n FROM model_calls")?.n);
}

it("replays proposed plans before acceptance and reports the failed step of a wrong pointer, with no model call and no version change", async () => {
  const f = await fixture();
  const executed: ExecutablePlan[] = [];
  fakeRunner(executed);
  const right = f.propose("/status");
  const wrong = f.propose("/state");
  const accepted = f.propose("/status", { state: "accepted" });
  const invalid = f.propose("/status", { validation: "invalid" });
  const before = f.app.proposals.detail(f.batchId);
  const calls = modelCalls(f.app);

  const admission = await f.app.planTrials.admit(f.batchId, {
    environmentId: f.init.environmentId,
  });
  const runIds = admission.items.flatMap((item) => (item.run ? [item.run.runId] : []));
  expect(admission.items.every((item) => !item.run || item.run.ownership === "ephemeral")).toBe(
    true,
  );
  await f.app.worker.run({ ephemeral: true, runIds });
  const receipt = f.app.planTrials.receipt(admission);

  const trial = (id: string) => receipt.trials.find((item) => item.proposalId === id);
  expect(trial(right)).toMatchObject({ tried: true, outcome: "passed", failedSteps: [] });
  expect(trial(wrong)).toMatchObject({
    tried: true,
    outcome: "failed",
    reasonCode: "assertion_mismatch",
    failedSteps: [
      {
        stepId: "check-health",
        status: "failed",
        reasonCode: "assertion_mismatch",
        message: expect.stringContaining("/state"),
        expected: "ok",
        observed: null,
      },
    ],
  });
  expect(trial(accepted)).toMatchObject({
    tried: false,
    reason: expect.stringContaining("accepted"),
  });
  expect(trial(invalid)).toMatchObject({
    tried: false,
    reason: expect.stringContaining("invalid"),
  });
  expect(executed.map((plan) => plan.name).sort()).toEqual([
    "Health at /state",
    "Health at /status",
  ]);
  for (const id of runIds)
    expect(f.app.runs.get(id)).toMatchObject({ origin: "trial", mode: "replay" });

  // Nothing about the batch or its proposals changed, and no model was asked.
  expect(modelCalls(f.app)).toBe(calls);
  expect(f.app.proposals.detail(f.batchId)).toEqual(before);
  expect(receipt.batchVersion).toBe(before.batch.version);
  f.app.close();
});

it("reports the failed gate and cleanup outcome of a trial whose assertions passed but whose required cleanup failed", async () => {
  const f = await fixture();
  fakeRunner([], "failed");
  const proposalId = f.propose("/status");
  const [proposal] = f.app.proposals.detail(f.batchId).proposals;
  if (!proposal) throw new Error("Proposal missing");
  const plan = structuredClone(proposal.plan) as ExecutablePlan;
  const create = plan.steps[0];
  if (create?.kind !== "action" || !("method" in create.input)) throw new Error("Bad plan");
  create.input = {
    ...create.input,
    method: "POST",
    resource: {
      resourceType: "health",
      correlationKey: { literal: "h" },
      handle: "/status",
      ownerProof: "/status",
    },
  };
  plan.cleanup = [
    {
      resourceRef: "get-health",
      operation: "request",
      input: { method: "DELETE", pathSegments: [{ literal: "health" }] },
      successPredicate: { predicate: "statusIn", values: [200] },
      deadlineMs: 1000,
      required: true,
    },
  ];
  const version = Number(proposal.version ?? 1);
  f.app.context.entities.update("Proposal", f.app.context.workspaceId, proposalId, version, {
    ...proposal,
    plan,
    version: version + 1,
  });

  const admission = await f.app.planTrials.admit(f.batchId, {
    environmentId: f.init.environmentId,
  });
  const runIds = admission.items.flatMap((item) => (item.run ? [item.run.runId] : []));
  await f.app.worker.run({ ephemeral: true, runIds });
  const [trial] = f.app.planTrials.receipt(admission).trials;
  expect(trial?.reason).toBeUndefined();

  // Cleanup is not a step, so only the gate says why this passed trial does not pass.
  expect(trial).toMatchObject({
    tried: true,
    outcome: "passed",
    gate: "failed",
    cleanupOutcome: "failed",
    failedSteps: [],
  });
  f.app.close();
});

it("keeps trial tests out of test listings and normal admission, and reuses one per proposal plan", async () => {
  const f = await fixture();
  fakeRunner([]);
  const proposalId = f.propose("/state");
  const trial = async () => {
    const admission = await f.app.planTrials.admit(f.batchId, {
      environmentId: f.init.environmentId,
      proposalIds: [proposalId],
    });
    const run = admission.items[0]?.run;
    if (!run) throw new Error("Not tried");
    await f.app.worker.run({ ephemeral: true, runIds: [run.runId] });
    return f.app.runs.get(run.runId);
  };
  const first = await trial();
  const second = await trial();
  // The same plan runs from the same hidden revision; there is still no project test.
  expect(second.revisionId).toBe(first.revisionId);
  expect(f.app.tests.list(f.init.projectId)).toEqual([]);
  await expect(
    f.app.runs.admit(
      { testId: first.testId, revisionId: first.revisionId, environmentId: f.init.environmentId },
      { wait: true },
    ),
  ).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
    message: expect.stringContaining("trial"),
  });
  // An edited plan runs from a new revision of the same hidden test.
  const [proposal] = f.app.proposals.detail(f.batchId).proposals;
  if (!proposal) throw new Error("Proposal missing");
  const plan = structuredClone(proposal.plan) as ExecutablePlan;
  const check = plan.steps[2];
  if (check?.kind !== "assertion" || !("responseStepId" in check.input))
    throw new Error("Bad plan");
  check.input = { ...check.input, jsonPointer: "/status" };
  // An edit of the proposal (testmaster_edit_plan): same proposal, new plan, next version.
  const version = Number(proposal.version ?? 1);
  f.app.context.entities.update("Proposal", f.app.context.workspaceId, proposalId, version, {
    ...proposal,
    plan,
    version: version + 1,
  });
  const fixed = await trial();
  expect(fixed).toMatchObject({ testId: first.testId, outcome: "passed" });
  expect(fixed.revisionId).not.toBe(first.revisionId);
  await expect(
    f.app.planTrials.admit(f.batchId, {
      environmentId: f.init.environmentId,
      proposalIds: ["pro_00000000-0000-7000-8000-000000000000"],
    }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  f.app.close();
});
