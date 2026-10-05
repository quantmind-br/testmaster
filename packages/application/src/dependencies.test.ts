import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DependencyBinding, ExecutablePlan, RunRequest } from "@testmaster/contracts";
import { ExecutionRepository, LeaseRepository } from "@testmaster/persistence";
import { AttemptExecutor } from "@testmaster/sandbox";
import { afterEach, expect, it, vi } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";
import { entity } from "./context.js";
import type { ResolvedDependency } from "./runs.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tm-dependency-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home });
  const init = await app.init();
  app.preflight = async () => {};
  return { app, init };
}
function producerPlan(sensitive = false): ExecutablePlan {
  const plan = scaffoldPlan("backend");
  const step = plan.steps.find((entry) => entry.operation === "request");
  if (!step || step.operation !== "request") throw new Error("Request fixture missing");
  step.input.capture = [
    { name: "fixture-id", from: "jsonPointer", pointer: "/id", valueType: "string", sensitive },
  ];
  return plan;
}
function binding(testId: string, environmentId: string): DependencyBinding {
  return {
    producerTestId: testId,
    outputName: "fixture-id",
    consumerInput: "fixture",
    type: "string",
    required: true,
    sensitive: false,
    maximumAge: 60000,
    permittedEnvironment: environmentId,
  };
}
function consumerPlan(dependency: DependencyBinding): ExecutablePlan {
  const plan = scaffoldPlan("backend");
  plan.dependsOn = [dependency];
  return plan;
}
function dependencies(cell: unknown): ResolvedDependency[] {
  if (
    !cell ||
    typeof cell !== "object" ||
    !("dependencyBindings" in cell) ||
    !Array.isArray(cell.dependencyBindings)
  )
    throw new Error("Dependency snapshot missing");
  return cell.dependencyBindings as ResolvedDependency[];
}
it("expands required producers once, separates requested counts and pins revisions/environment atomically", async () => {
  const { app, init } = await fixture();
  try {
    const producer = app.tests.create({ projectId: init.projectId, plan: producerPlan() });
    const consumer = app.tests.create({
      projectId: init.projectId,
      plan: consumerPlan(binding(producer.id, init.environmentId)),
    });
    const request = { selection: [{ testId: consumer.id, environmentId: init.environmentId }] };
    const receipt = await app.batches.admit(request, {
      wait: true,
      idempotencyKey: "dependency-batch-idempotent-123",
    });
    expect(receipt).toMatchObject({
      requested: 1,
      accepted: 1,
      counts: { inFlight: 1 },
      gate: "pending",
    });
    expect(receipt.memberRuns).toHaveLength(1);
    expect(receipt.expanded).toHaveLength(1);
    expect(receipt.allMembers).toEqual([receipt.expanded[0]!.runId, receipt.memberRuns[0]!.runId]);
    const producerRun = app.runs.get(receipt.expanded[0]!.runId);
    const consumerRun = app.runs.get(receipt.memberRuns[0]!.runId);
    expect(dependencies(consumerRun.matrixCell)).toMatchObject([
      {
        producerRunId: producerRun.id,
        producerRevisionId: producer.activeRevisionId,
        producerEnvironmentRevisionId: producerRun.environmentRevisionId,
      },
    ]);
    const next = app.revisions.create(producer.id, producerPlan());
    app.revisions.promote(next.id, app.tests.get(producer.id).version ?? 1);
    expect(
      await app.batches.admit(request, {
        wait: true,
        idempotencyKey: "dependency-batch-idempotent-123",
      }),
    ).toEqual(receipt);
    expect(app.runs.get(producerRun.id).revisionId).toBe(producer.activeRevisionId);
    expect(app.database.all("SELECT * FROM job_leases")).toHaveLength(2);
    const batch = app.batches.get(receipt.batchId);
    expect(batch.aggregate).toMatchObject({
      counts: { inFlight: 1 },
      expanded: { count: 1, counts: { inFlight: 1 } },
    });
  } finally {
    app.close();
  }
});
it("keeps a single owned receipt while admitting its implicit producer batch", async () => {
  const { app, init } = await fixture();
  try {
    const producer = app.tests.create({ projectId: init.projectId, plan: producerPlan() });
    const consumer = app.tests.create({
      projectId: init.projectId,
      plan: consumerPlan(binding(producer.id, init.environmentId)),
    });
    const receipt = await app.runs.admit(
      { testId: consumer.id, environmentId: init.environmentId },
      { wait: true },
    );
    expect(receipt.ownership).toBe("ephemeral");
    expect(app.runs.get(receipt.runId).testId).toBe(consumer.id);
    expect(app.runs.expandRunIds([receipt.runId])).toHaveLength(2);
    expect(app.database.all("SELECT * FROM batches")).toHaveLength(1);
  } finally {
    app.close();
  }
});
it("shares an explicitly selected producer across consumers without expanding it twice", async () => {
  const { app, init } = await fixture();
  try {
    const producer = app.tests.create({ projectId: init.projectId, plan: producerPlan() });
    const consumer = app.tests.create({
      projectId: init.projectId,
      plan: consumerPlan(binding(producer.id, init.environmentId)),
    });
    const second = app.tests.create({
      projectId: init.projectId,
      plan: consumerPlan(binding(producer.id, init.environmentId)),
    });
    const receipt = await app.batches.admit(
      {
        selection: [consumer, second, producer].map((test) => ({
          testId: test.id,
          environmentId: init.environmentId,
        })),
      },
      { wait: true },
    );
    expect(receipt.expanded).toEqual([]);
    expect(receipt.accepted).toBe(3);
    expect(receipt.allMembers).toHaveLength(3);
    const refs = [consumer, second].map(
      (test) =>
        dependencies(app.runs.list().find((run) => run.testId === test.id)!.matrixCell)[0]!
          .producerRunId,
    );
    expect(refs[0]).toBe(refs[1]);
  } finally {
    app.close();
  }
});
it("refuses missing output, environment/type/taint mismatch, ambiguity and cycles before durable admission effects", async () => {
  const { app, init } = await fixture();
  try {
    const producer = app.tests.create({ projectId: init.projectId, plan: producerPlan() });
    const badBindings = [
      { ...binding(producer.id, init.environmentId), outputName: "absent" },
      { ...binding(producer.id, init.environmentId), type: "number" as const },
      { ...binding(producer.id, init.environmentId), sensitive: true },
      {
        ...binding(producer.id, init.environmentId),
        permittedEnvironment: "env_00000000-0000-4000-8000-000000000001",
      },
      binding("tst_00000000-0000-4000-8000-000000000001", init.environmentId),
    ];
    for (const dependency of badBindings) {
      const consumer = app.tests.create({
        projectId: init.projectId,
        plan: consumerPlan(dependency),
      });
      await expect(
        app.runs.admit({ testId: consumer.id, environmentId: init.environmentId }, { wait: true }),
      ).rejects.toHaveProperty("code");
    }
    const consumer = app.tests.create({
      projectId: init.projectId,
      plan: consumerPlan(binding(producer.id, init.environmentId)),
    });
    const next = app.revisions.create(producer.id, producerPlan());
    const selection: RunRequest[] = [
      { testId: consumer.id, environmentId: init.environmentId },
      {
        testId: producer.id,
        revisionId: String(producer.activeRevisionId),
        environmentId: init.environmentId,
      },
      { testId: producer.id, revisionId: next.id, environmentId: init.environmentId },
    ];
    await expect(app.batches.admit({ selection }, { wait: true })).rejects.toMatchObject({
      details: { reasonCode: "ambiguous_producer" },
    });
    const cycle = producerPlan();
    cycle.dependsOn = [binding(producer.id, init.environmentId)];
    const cyclicRevision = app.revisions.create(producer.id, cycle);
    app.revisions.promote(cyclicRevision.id, app.tests.get(producer.id).version ?? 1);
    await expect(
      app.runs.admit({ testId: producer.id, environmentId: init.environmentId }, { wait: true }),
    ).rejects.toMatchObject({ details: { reasonCode: "dependency_cycle" } });
    expect(app.runs.list()).toEqual([]);
    for (const table of ["batches", "job_leases", "idempotency_receipts", "outbox"]) {
      if (table === "outbox")
        expect(
          app.database.all("SELECT * FROM outbox WHERE type IN ('run.accepted','batch.accepted')"),
        ).toEqual([]);
      else expect(app.database.all(`SELECT * FROM ${table}`)).toEqual([]);
    }
  } finally {
    app.close();
  }
});
it("blocks a failed required producer without invoking a browser or image resolution", async () => {
  const { app, init } = await fixture();
  try {
    const producer = app.tests.create({ projectId: init.projectId, plan: producerPlan() });
    const consumer = app.tests.create({
      projectId: init.projectId,
      plan: consumerPlan(binding(producer.id, init.environmentId)),
    });
    const receipt = await app.runs.admit(
      { testId: consumer.id, environmentId: init.environmentId },
      { wait: true },
    );
    const upstreamId = dependencies(app.runs.get(receipt.runId).matrixCell)[0]!.producerRunId;
    const fence = new LeaseRepository(app.database).claim({
      workspaceId: init.workspaceId,
      owner: "test",
      queue: "local",
      runIds: [upstreamId],
    });
    if (!fence) throw new Error("Producer lease missing");
    new ExecutionRepository(app.database).finalize(fence, {
      ...app.runs.get(upstreamId),
      phase: "completed",
      status: "failed",
      outcome: "failed",
      gate: "failed",
    });
    const images = vi.spyOn(app, "images");
    await app.worker.run({ ephemeral: true, runIds: [receipt.runId] });
    expect(images).not.toHaveBeenCalled();
    expect(app.runs.get(receipt.runId)).toMatchObject({
      phase: "completed",
      outcome: "blocked",
      gate: "failed",
    });
    expect(
      app.runs.events(receipt.runId).some((event) => event.type === "run.dependency_blocked"),
    ).toBe(true);
    expect(app.database.all("SELECT * FROM resources")).toEqual([]);
  } finally {
    app.close();
  }
});
it.each(["fresh", "expired", "wrong-type"] as const)(
  "resolves only %s typed public output before consumer effects",
  async (scenario) => {
    const { app, init } = await fixture();
    try {
      const plan = producerPlan();
      const producer = app.tests.create({ projectId: init.projectId, plan });
      const consumer = app.tests.create({
        projectId: init.projectId,
        plan: consumerPlan(binding(producer.id, init.environmentId)),
      });
      const receipt = await app.runs.admit(
        {
          testId: consumer.id,
          environmentId: init.environmentId,
          extensions: { "testmaster:executor": "process" },
        },
        { wait: true },
      );
      const consumerRun = app.runs.get(receipt.runId);
      const upstream = app.runs.get(dependencies(consumerRun.matrixCell)[0]!.producerRunId);
      const fence = new LeaseRepository(app.database).claim({
        workspaceId: init.workspaceId,
        owner: "test",
        queue: "local",
        runIds: [upstream.id],
      });
      if (!fence) throw new Error("Producer lease missing");
      const execution = new ExecutionRepository(app.database);
      const captureStep = plan.steps.find((step) => step.operation === "request")!;
      const occurredAt = new Date(Date.now() - (scenario === "expired" ? 120000 : 0)).toISOString();
      execution.publish(
        fence,
        "VariableValue",
        entity(app.context, "var", {
          createdAt: occurredAt,
          batchId: upstream.batchId,
          producerRunId: upstream.id,
          producerStepId: captureStep.id,
          name: "fixture-id",
          type: scenario === "wrong-type" ? "number" : "string",
          encryptedValueRef: null,
          taint: "public",
        }),
      );
      execution.observe(fence, {
        id: entity(app.context, "evt", {}).id,
        seq: 0,
        payload: {
          protocolVersion: "1.0.0",
          attemptId: fence.attemptId,
          occurredAt,
          seq: 0,
          type: "variable.captured",
          payload: {
            name: "fixture-id",
            valueType: "string",
            sensitive: false,
            value: { literal: "created-123" },
          },
        },
      });
      execution.finalize(fence, {
        ...upstream,
        phase: "completed",
        status: "passed",
        outcome: "passed",
        gate: "passed",
      });
      const execute = vi.spyOn(AttemptExecutor.prototype, "execute").mockResolvedValue({
        outcome: "blocked",
        reasonCode: "insufficient_evidence",
        logDropped: 0,
        events: [],
      });
      await app.worker.run({ ephemeral: true, runIds: [receipt.runId] });
      if (scenario === "fresh") {
        expect(execute).toHaveBeenCalledOnce();
        expect(execute.mock.calls[0]![0].runnerInput?.variables).toEqual({
          fixture: { value: "created-123", sensitive: false },
        });
      } else {
        expect(execute).not.toHaveBeenCalled();
        expect(app.runs.get(receipt.runId)).toMatchObject({ outcome: "blocked", gate: "failed" });
      }
      const variables = app.database.all("SELECT data_json FROM variables");
      expect(JSON.stringify(variables)).not.toContain("created-123");
    } finally {
      app.close();
    }
  },
);
