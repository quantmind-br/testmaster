import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";
import { runMatrixCell } from "./comparisons.js";

it("retains distinct repetition identities and quarantines with expiry, writer authority and CAS", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-history-"));
  await mkdir(join(root, "home"));
  const app = await Application.open({ cwd: root, home: join(root, "home") });
  try {
    const init = await app.init();
    app.preflight = async () => {};
    const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
    const receipt = await app.batches.admit(
      {
        selection: [0, 1, 2].map((repetitionIndex) => ({
          testId: test.id,
          environmentId: init.environmentId,
          repetitionIndex,
        })),
      },
      { wait: true },
    );
    expect(receipt.requested).toBe(3);
    expect(new Set(receipt.allMembers).size).toBe(3);
    expect(
      receipt.memberRuns
        .map((member) => runMatrixCell(app.runs.get(member.runId)).repetitionIndex)
        .sort(),
    ).toEqual([0, 1, 2]);
    const liveWorker = app.runs.host.liveWorker;
    app.runs.host.liveWorker = () => true;
    const study = await app.flake.study({
      testRevision: String(test.activeRevisionId),
      environment: init.environmentId,
      n: 2,
      seed: 0,
    });
    app.runs.host.liveWorker = liveWorker;
    expect(study.accepted).toBe(2);
    const serialCells = study.allMembers.map((id) => runMatrixCell(app.runs.get(id)));
    expect(serialCells[0]!.flakePredecessorRunId).toBeNull();
    expect(serialCells[1]!.flakePredecessorRunId).toBe(study.allMembers[0]);
    expect(serialCells[0]!.limits).toMatchObject({ maxAttempts: 1 });
    expect(app.flake.report(study.batchId).counts).toMatchObject({
      nPlanned: 2,
      nValid: 0,
      nInFlight: 2,
    });
    expect(app.flake.report(study.batchId, [study.batchId]).counts.nPlanned).toBe(2);
    expect(() => app.flake.report(receipt.batchId)).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    await expect(
      app.flake.study({
        testRevision: String(test.activeRevisionId),
        environment: init.environmentId,
        n: 1,
        seed: 0,
      }),
    ).rejects.toThrow();
    await expect(
      app.flake.study({
        testRevision: String(test.activeRevisionId),
        environment: init.environmentId,
        n: 101,
        seed: 0,
      }),
    ).rejects.toThrow();
    expect(() =>
      app.quarantine.set(test.id, {
        reason: " ",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() =>
      app.quarantine.set(test.id, {
        reason: "intermittent target cause",
        expiresAt: new Date(Date.now() - 1).toISOString(),
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    const record = app.quarantine.set(test.id, {
      reason: "independent target reset investigation",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    expect(app.quarantine.activeFor(init.projectId).get(test.id)).toEqual(record);
    expect(
      app.quarantine.activeFor(init.projectId, new Date(Date.now() + 120000)).has(test.id),
    ).toBe(false);
    expect(() =>
      app.quarantine.set(test.id, { reason: "changed", expiresAt: record.expiresAt }),
    ).toThrow(expect.objectContaining({ code: "PRECONDITION_REQUIRED" }));
    expect(() => app.quarantine.remove(test.id, record.version + 1)).toThrow(
      expect.objectContaining({ code: "REVISION_CONFLICT" }),
    );
    const updated = app.quarantine.set(test.id, {
      reason: "changed",
      expiresAt: record.expiresAt,
      expectedVersion: record.version,
    });
    expect(updated.version).toBe(record.version + 1);
    app.quarantine.remove(test.id, updated.version);
    expect(app.quarantine.get(test.id)).toBeNull();
    const run = app.runs.get(receipt.memberRuns[0]!.runId);
    expect(run.outcome).toBeNull();
    const authorize = app.context.authorize;
    app.context.authorize = (scope, projectId) => {
      if (scope === "W") throw new Error("writer denied");
      authorize(scope, projectId);
    };
    expect(() =>
      app.quarantine.set(test.id, {
        reason: "unauthorized",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
    ).toThrow("writer denied");
    expect(app.quarantine.get(test.id)).toBeNull();
    app.context.authorize = authorize;
    expect(
      app.database.all("SELECT action FROM audit_events WHERE resource_id=?", test.id).length,
    ).toBeGreaterThanOrEqual(3);
  } finally {
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});
