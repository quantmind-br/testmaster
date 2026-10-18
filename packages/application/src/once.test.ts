import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DependencyBinding, ExecutablePlan } from "@testmaster/contracts";
import { afterEach, expect, it } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";

const roots: string[] = [];
const apps: Application[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function world() {
  const root = await mkdtemp(join(tmpdir(), "tm-once-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home, env: {} });
  apps.push(app);
  app.preflight = async () => {};
  const init = await app.init();
  const planOf = (runPolicy?: "always" | "once"): ExecutablePlan => {
    const plan = scaffoldPlan("backend");
    if (runPolicy) plan.runPolicy = runPolicy;
    return plan;
  };
  const make = (name: string, runPolicy?: "always" | "once") =>
    app.tests.create({ projectId: init.projectId, plan: planOf(runPolicy), name });
  let clock = Date.parse("2030-01-01T00:00:00.000Z");
  /**
   * A completed replay of the test's active revision with committed evidence, written the way the
   * worker leaves it. `outcome` other than passed yields the later non-passing run of a re-arm.
   */
  const settle = (testId: string, outcome: "passed" | "failed" = "passed") => {
    const run = app.runs.prepare({ testId, environmentId: init.environmentId });
    clock += 1000;
    const at = new Date(clock).toISOString();
    const gate = outcome === "passed" ? "passed" : "failed";
    Object.assign(run, { createdAt: at, phase: "completed", status: outcome, outcome, gate });
    app.context.entities.insert("Run", run);
    const ws = init.workspaceId;
    const ids = { run: String(run.id), job: `job_once_${clock}`, attempt: `att_once_${clock}` };
    app.database.withTx(() => {
      app.database.run(
        "INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,state,available_at) VALUES(?,?,?,?,?,?,?)",
        ws,
        ids.job,
        at,
        "local",
        ids.run,
        "completed",
        at,
      );
      app.database.run(
        "INSERT INTO attempts(workspace_id,id,created_at,run_id,number,phase,started_at,ended_at,outcome,job_id,fence,lease_owner) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        ws,
        ids.attempt,
        at,
        ids.run,
        1,
        "completed",
        at,
        at,
        outcome,
        ids.job,
        1,
        "worker-once",
      );
      app.database.run(
        "INSERT INTO snapshots(workspace_id,id,created_at,run_id,attempt_id,revision_id,manifest_hash,committed_at) VALUES(?,?,?,?,?,?,?,?)",
        ws,
        `snp_once_${clock}`,
        at,
        ids.run,
        ids.attempt,
        String(run.revisionId),
        "m".repeat(64),
        at,
      );
    });
    return ids.run;
  };
  return { app, init, make, planOf, settle };
}

it("a once test that passed against the current environment revision is skipped without failing the gate", async () => {
  const { app, init, make, settle } = await world();
  const once = make("once-test", "once");
  const always = make("always-test");
  const priorRunId = settle(once.id);
  const receipt = await app.batches.admit(
    {
      selection: [
        { testId: once.id, environmentId: init.environmentId },
        { testId: always.id, environmentId: init.environmentId },
      ],
    },
    { wait: true },
  );
  expect(receipt.requested).toBe(2);
  expect(receipt.accepted).toBe(1);
  expect(receipt.notDispatched).toEqual([
    { memberKey: `0:${once.id}`, reasonCode: "already_passed_once" },
  ]);
  expect(receipt.gate).toBe("pending");
  // Only the ordinary test dispatched.
  expect(receipt.memberRuns.map((run) => app.runs.get(run.runId).testId)).toEqual([always.id]);
  const batch = app.batches.get(receipt.batchId);
  expect(batch.rejectedMembers).toEqual(receipt.notDispatched);
  const snapshot = app.context.entities.get("BatchRun", init.workspaceId, receipt.batchId)
    ?.selectionSnapshot as { priorEvidence?: unknown[]; rejections?: unknown[] };
  expect(snapshot.priorEvidence).toEqual([
    { memberKey: `0:${once.id}`, testId: once.id, runId: priorRunId },
  ]);
  // The skip is not a rejection, so a CLI exit on rejections is untouched.
  expect(snapshot.rejections).toEqual([]);
});

it("a batch whose members all passed once is admitted empty and does not fail", async () => {
  const { app, init, make, settle } = await world();
  const once = make("once-only", "once");
  settle(once.id);
  const receipt = await app.batches.admit(
    { selection: [{ testId: once.id, environmentId: init.environmentId }] },
    { wait: true },
  );
  expect(receipt).toMatchObject({
    requested: 1,
    accepted: 0,
    memberRuns: [],
    allMembers: [],
    gate: "not_applicable",
    notDispatched: [{ memberKey: `0:${once.id}`, reasonCode: "already_passed_once" }],
  });
  expect(app.batches.get(receipt.batchId).aggregate.gate).toBe("not_applicable");
});

it("a once test is re-armed by a new environment revision, a later failure or a new test revision", async () => {
  const { app, init, make, planOf, settle } = await world();
  const once = make("once-rearm", "once");
  const request = { selection: [{ testId: once.id, environmentId: init.environmentId }] };
  settle(once.id);
  const skipped = await app.batches.admit(request, { wait: true });
  expect(skipped.notDispatched).toHaveLength(1);

  // Control: a new environment revision has no passing run yet, so the test dispatches.
  const environment = app.environments.get(init.environmentId);
  app.environments.update(environment.id, { locale: "pt-BR" }, environment.version ?? 1);
  const environmentRearmed = await app.batches.admit(request, { wait: true });
  expect(environmentRearmed.notDispatched).toEqual([]);
  expect(environmentRearmed.accepted).toBe(1);

  // Control: the latest completed replay decides, so a later failure re-arms the test.
  settle(once.id);
  expect((await app.batches.admit(request, { wait: true })).notDispatched).toHaveLength(1);
  settle(once.id, "failed");
  const failedRearmed = await app.batches.admit(request, { wait: true });
  expect(failedRearmed.notDispatched).toEqual([]);

  // Control: a new active revision of the test is a new thing to prove.
  settle(once.id);
  expect((await app.batches.admit(request, { wait: true })).notDispatched).toHaveLength(1);
  const next = app.revisions.create(once.id, planOf("once"));
  app.revisions.promote(next.id, Number(app.tests.get(once.id).version));
  const revisionRearmed = await app.batches.admit(request, { wait: true });
  expect(revisionRearmed.notDispatched).toEqual([]);
});

it("an always test and a once test without a passing run are never skipped", async () => {
  const { app, init, make, settle } = await world();
  const always = make("always-passed");
  const fresh = make("once-never-ran", "once");
  settle(always.id);
  const receipt = await app.batches.admit(
    {
      selection: [
        { testId: always.id, environmentId: init.environmentId },
        { testId: fresh.id, environmentId: init.environmentId },
      ],
    },
    { wait: true },
  );
  expect(receipt.notDispatched).toEqual([]);
  expect(receipt.accepted).toBe(2);
});

it("a single run of a satisfied once test is refused with the prior run id, while other modes are not", async () => {
  const { app, init, make, settle } = await world();
  const once = make("once-single", "once");
  const priorRunId = settle(once.id);
  await expect(
    app.runs.admit({ testId: once.id, environmentId: init.environmentId }, { wait: true }),
  ).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
    details: { reasonCode: "already_passed_once", priorRunId },
  });
  // Negative control: a healing verification exists to run again.
  const verification = await app.runs.admit(
    { testId: once.id, environmentId: init.environmentId, origin: "verification" },
    { wait: true },
  );
  expect(verification.runId).toBeTruthy();
});

it("a list whose tests all passed once admits an empty batch and previews the satisfied members", async () => {
  const { app, init, make, settle } = await world();
  const once = make("once-suite", "once");
  const always = make("always-suite");
  const priorRunId = settle(once.id);
  const suite = app.suites.create({
    name: "once-list",
    selection: {
      kind: "dynamic",
      projects: [{ projectId: init.projectId, environmentId: init.environmentId }],
    },
  });
  const preview = app.suites.expansion(suite.id);
  expect(preview.satisfied).toEqual([expect.objectContaining({ testId: once.id, priorRunId })]);
  const mixed = await app.suites.run(suite.id, {}, { wait: true });
  expect(mixed.accepted).toBe(1);
  expect(mixed.notDispatched).toEqual([
    expect.objectContaining({ reasonCode: "already_passed_once" }),
  ]);
  expect(mixed.memberRuns.map((run) => app.runs.get(run.runId).testId)).toEqual([always.id]);

  // Negative control: without the ordinary test, nothing is left to dispatch and the gate holds.
  app.tests.archive(always.id, Number(app.tests.get(always.id).version));
  const onlyOnce = await app.suites.run(suite.id, {}, { wait: true });
  expect(onlyOnce).toMatchObject({ accepted: 0, gate: "not_applicable" });
});

it("a once test cannot be a dependency producer", async () => {
  const { app, init, make, planOf } = await world();
  const producer = make("once-producer", "once");
  const binding: DependencyBinding = {
    producerTestId: producer.id,
    outputName: "fixture-id",
    consumerInput: "fixture",
    type: "string",
    required: true,
    sensitive: false,
    maximumAge: 60000,
    permittedEnvironment: init.environmentId,
  };
  const consumerPlan = planOf();
  consumerPlan.dependsOn = [binding];
  const consumer = app.tests.create({ projectId: init.projectId, plan: consumerPlan });
  await expect(
    app.batches.admit(
      { selection: [{ testId: consumer.id, environmentId: init.environmentId }] },
      { wait: true },
    ),
  ).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
    details: { reasonCode: "upstream_failed" },
  });
  // The plan validator names the refusal before any run exists, from either side.
  const producerSide = app.planValidation.validate(init.projectId, {
    plan: planOf("once"),
    testId: producer.id,
  });
  expect(producerSide.issues.map((issue) => issue.code)).toContain("once_producer");
  const consumerSide = app.planValidation.validate(init.projectId, { plan: consumerPlan });
  expect(consumerSide.issues.map((issue) => issue.code)).toContain("dependency_producer_once");
  // Negative control: the same dependency on an ordinary producer is admitted.
  const ordinaryPlan = planOf();
  const request = ordinaryPlan.steps.find((step) => step.operation === "request");
  if (!request || request.operation !== "request") throw new Error("Request fixture missing");
  request.input.capture = [
    {
      name: "fixture-id",
      from: "jsonPointer",
      pointer: "/id",
      valueType: "string",
      sensitive: false,
    },
  ];
  const ordinary = app.tests.create({
    projectId: init.projectId,
    plan: ordinaryPlan,
    name: "always-producer",
  });
  const okPlan = planOf();
  okPlan.dependsOn = [{ ...binding, producerTestId: ordinary.id }];
  const ok = app.tests.create({ projectId: init.projectId, plan: okPlan });
  const receipt = await app.batches.admit(
    { selection: [{ testId: ok.id, environmentId: init.environmentId }] },
    { wait: true },
  );
  expect(receipt.accepted).toBe(1);
});
