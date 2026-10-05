import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function open() {
  const root = await mkdtemp(join(tmpdir(), "tm-app-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  return Application.open({ cwd: root, home });
}
it("refuses asynchronous admission without a durable owner before creating any Run", async () => {
  const app = await open();
  try {
    const init = await app.init();
    const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
    await expect(
      app.runs.admit({ testId: test.id, environmentId: init.environmentId }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(app.runs.list()).toEqual([]);
    expect(app.database.all("SELECT * FROM job_leases")).toEqual([]);
    expect(app.database.all("SELECT * FROM idempotency_receipts")).toEqual([]);
  } finally {
    app.close();
  }
});
it("admits one pinned Run with lease and outbox atomically and rejects body reuse", async () => {
  const app = await open();
  try {
    const init = await app.init();
    const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
    app.preflight = async () => {};
    const request = { testId: test.id, environmentId: init.environmentId };
    const receipt = await app.runs.admit(request, {
      wait: true,
      idempotencyKey: "admission-risk-key-12345",
    });
    const next = app.revisions.create(test.id, scaffoldPlan("backend"));
    app.revisions.promote(next.id, app.tests.get(test.id).version ?? 1);
    expect(
      await app.runs.admit(request, { wait: true, idempotencyKey: "admission-risk-key-12345" }),
    ).toEqual(receipt);
    expect(app.runs.get(receipt.runId).revisionId).toBe(test.activeRevisionId);
    expect(app.database.all("SELECT * FROM job_leases")).toHaveLength(1);
    expect(
      app.runs.events(receipt.runId).filter((event) => event.type === "run.accepted"),
    ).toHaveLength(1);
    await expect(
      app.runs.admit(
        { ...request, revisionId: next.id },
        { wait: true, idempotencyKey: "admission-risk-key-12345" },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  } finally {
    app.close();
  }
});
it("rejects insufficient session scopes even for the local workspace owner", async () => {
  const app = await open();
  const init = await app.init();
  const options = {
    cwd: app.config.cwd,
    home: app.config.home,
    identity: { principalId: init.principalId, scopes: ["R" as const] },
  };
  app.close();
  const reader = await Application.open(options);
  try {
    expect(reader.projects.list()).toHaveLength(1);
    expect(() => reader.projects.create({ name: "Forbidden" })).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(() => reader.runs.cancel("run_missing")).toThrow();
  } finally {
    reader.close();
  }
});
it("rolls back all batch membership if any selected member is invalid", async () => {
  const app = await open();
  try {
    const init = await app.init();
    const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
    app.preflight = async () => {};
    const missing = "tst_00000000-0000-4000-8000-000000000001";
    await expect(
      app.batches.admit(
        {
          selection: [
            { testId: test.id, environmentId: init.environmentId },
            { testId: missing, environmentId: init.environmentId },
          ],
        },
        { wait: true },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(app.runs.list()).toHaveLength(0);
    expect(app.database.all("SELECT * FROM batches")).toHaveLength(0);
    const partial = await app.batches.admit(
      {
        selection: [
          { testId: test.id, environmentId: init.environmentId },
          { testId: missing, environmentId: init.environmentId },
        ],
        partialDispatch: true,
      },
      { wait: true },
    );
    expect(partial.accepted).toBe(1);
    expect(partial.notDispatched).toHaveLength(1);
    expect(partial.gate).toBe("failed");
  } finally {
    app.close();
  }
});
