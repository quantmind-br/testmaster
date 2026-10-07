import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";
import { entity } from "./context.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(repository = false) {
  const root = await mkdtemp(join(tmpdir(), "tm-selection-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  if (repository) {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, "source.ts"), "export const price = 1;\n");
    execFileSync("git", ["add", "source.ts"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "baseline",
      ],
      { cwd: root },
    );
  }
  const app = await Application.open({ cwd: root, home });
  const init = await app.init();
  app.preflight = async () => {};
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  return {
    app,
    init,
    test,
    root,
    input: { projectId: init.projectId, environmentId: init.environmentId, testIds: [test.id] },
  };
}
function rows(app: Application) {
  return ["runs", "attempts", "batches", "outbox", "approvals", "job_leases"].map((table) =>
    app.database.all(`SELECT * FROM ${table}`),
  );
}
describe("selection", () => {
  it("preview leaves execution rows, outbox and single-use approvals unchanged", async () => {
    const { app, input } = await fixture();
    try {
      const test = app.tests.get(input.testIds[0]!);
      const revision = app.revisions.get(String(test.activeRevisionId));
      const environment = app.environments.get(input.environmentId);
      const env = app.context.entities.get(
        "EnvironmentRevision",
        app.context.workspaceId,
        String(environment.activeRevisionId),
      )!;
      app.approvals.create({
        actionSet: ["write"],
        revisionHash: String(revision.contentHash),
        environmentRevisionId: String(environment.activeRevisionId),
        originSet: env.targetOrigins as string[],
        policyHash: app.config.effectiveConfig.policyHash,
      });
      const approval = vi.spyOn(app.runs.host, "verifyApproval");
      const before = rows(app);
      const preview = await app.selection.preview(input);
      expect(preview.requested).toHaveLength(1);
      expect(preview.effects.length).toBeGreaterThan(0);
      expect(rows(app)).toEqual(before);
      expect(approval).not.toHaveBeenCalled();
      await app.selection.run(
        { ...input, expectedSelectionHash: preview.selectionHash },
        { wait: true },
      );
      expect(approval).toHaveBeenCalledTimes(1);
      expect(app.runs.list()).toHaveLength(1);
    } finally {
      app.close();
    }
  });
  it("rejects mixed modes and empty execution without an explicit coverage reason", async () => {
    const { app, input } = await fixture();
    try {
      await expect(app.selection.preview({ ...input, all: true })).rejects.toHaveProperty(
        "code",
        "INVALID_ARGUMENT",
      );
      const empty = { ...input, testIds: [] };
      expect((await app.selection.preview(empty)).empty).toBe(true);
      await expect(app.selection.run(empty, { wait: true })).rejects.toHaveProperty(
        "code",
        "INVALID_ARGUMENT",
      );
      await expect(
        app.selection.run({ ...empty, allowEmpty: true, emptyReason: " " }, { wait: true }),
      ).rejects.toHaveProperty("code", "INVALID_ARGUMENT");
      const receipt = await app.selection.run(
        { ...empty, allowEmpty: true, emptyReason: "Explicit no coverage" },
        { wait: true },
      );
      expect(receipt.gate).toBe("not_applicable");
    } finally {
      app.close();
    }
  });
  it("selects all active tests for unmapped diff and reports a genuinely empty unchanged diff", async () => {
    const { app, input, root } = await fixture(true);
    try {
      const second = app.tests.create({
        projectId: input.projectId,
        plan: scaffoldPlan("backend"),
      });
      const { testIds: _ids, ...common } = input;
      const unchanged = await app.selection.preview({
        ...common,
        diff: { base: "HEAD", head: "HEAD" },
      });
      expect(unchanged.empty).toBe(true);
      await expect(
        app.selection.run({ ...common, diff: { base: "HEAD", head: "HEAD" } }, { wait: true }),
      ).rejects.toHaveProperty("code", "INVALID_ARGUMENT");
      await writeFile(join(root, "source.ts"), "export const price = 2;\n");
      execFileSync("git", ["add", "source.ts"], { cwd: root });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "changed",
        ],
        { cwd: root },
      );
      const preview = await app.selection.preview({
        ...common,
        diff: { base: "HEAD~1", head: "HEAD" },
      });
      expect(preview.diff).toMatchObject({ unmappedPaths: ["source.ts"], conservative: true });
      expect(preview.requested.map((item) => item.testId)).toEqual(
        expect.arrayContaining([input.testIds[0], second.id]),
      );
    } finally {
      app.close();
    }
  });
  it("refuses revalidation drift without admitting a stale preview", async () => {
    const { app, input, test } = await fixture();
    try {
      const preview = await app.selection.preview(input);
      app.tests.update(test.id, { name: "Concurrent edit" }, test.version ?? 1);
      await expect(
        app.selection.run(
          { ...input, expectedSelectionHash: preview.selectionHash },
          { wait: true },
        ),
      ).rejects.toHaveProperty("code", "REVISION_CONFLICT");
      expect(app.runs.list()).toHaveLength(0);
    } finally {
      app.close();
    }
  });
  it("keeps a source Run revision and enforces strict replay while target claims cannot override the environment", async () => {
    const { app, input, test } = await fixture();
    try {
      const source = app.runs.prepare({ testId: test.id, environmentId: input.environmentId });
      app.context.entities.insert("Run", source);
      const next = app.revisions.create(test.id, scaffoldPlan("backend"));
      app.revisions.promote(next.id, app.tests.get(test.id).version ?? 1);
      const { testIds: _ids, ...common } = input;
      const selection = { ...common, runIds: [source.id] };
      const preview = await app.selection.preview(selection);
      expect(preview.requested[0]?.revisionId).toBe(source.revisionId);
      const receipt = await app.selection.run(
        { ...selection, expectedSelectionHash: preview.selectionHash },
        { wait: true, strict: true },
      );
      const admitted = app.runs.get(receipt.memberRuns[0]!.runId);
      expect(admitted.mode).toBe("replay");
      expect(admitted.matrixCell).toMatchObject({
        limits: { maxAttempts: 1 },
        healingPolicy: "off",
      });
      await expect(
        app.selection.preview({ ...input, targetUrl: "http://127.0.0.1:1" }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        details: { reason: "target_mismatch" },
      });
    } finally {
      app.close();
    }
  });
  it("selects an explicit revision only for exactly one test of that revision", async () => {
    const { app, input, test, init } = await fixture();
    try {
      const original = String(test.activeRevisionId);
      const next = app.revisions.create(test.id, scaffoldPlan("backend"));
      app.revisions.promote(next.id, app.tests.get(test.id).version ?? 1);
      const explicit = await app.selection.preview({ ...input, revisionId: original });
      expect(explicit.requested).toEqual([
        { testId: test.id, revisionId: original, reason: `Explicit revision ${original}` },
      ]);
      expect(explicit.selectionHash).not.toBe((await app.selection.preview(input)).selectionHash);
      const other = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
      await expect(
        app.selection.preview({ ...input, testIds: [test.id, other.id], revisionId: original }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(
        app.selection.preview({ ...input, testIds: [other.id], revisionId: original }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    } finally {
      app.close();
    }
  });
  it("expands quarantined producers for consumers and refuses failed, foreign and expired fixture reuse", async () => {
    const { app, input } = await fixture();
    try {
      const producerPlan = scaffoldPlan("backend");
      const request = producerPlan.steps[0]!;
      if (request.operation !== "request") throw new Error("request required");
      request.input.capture = [
        { name: "id", from: "jsonPointer", pointer: "/id", valueType: "string", sensitive: false },
      ];
      const producer = app.tests.create({ projectId: input.projectId, plan: producerPlan });
      const plan = scaffoldPlan("backend");
      plan.dependsOn = [
        {
          producerTestId: producer.id,
          outputName: "id",
          consumerInput: "fixture",
          type: "string",
          required: true,
          sensitive: false,
          maximumAge: 1000,
          permittedEnvironment: input.environmentId,
        },
      ];
      const consumer = app.tests.create({ projectId: input.projectId, plan });
      const selection = { ...input, testIds: [consumer.id] };
      app.quarantine.set(producer.id, {
        reason: "Pending cause investigation",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
      expect(
        (await app.selection.preview(selection)).expanded.map((item) => item.testId),
      ).toContain(producer.id);
      const failed = app.runs.prepare({ testId: producer.id, environmentId: input.environmentId });
      Object.assign(failed, {
        phase: "completed",
        status: "failed",
        outcome: "failed",
        gate: "failed",
      });
      app.context.entities.insert("Run", failed);
      await expect(
        app.selection.run(
          { ...selection, reuseFromRunIds: [failed.id], skipDependencies: true },
          { wait: true },
        ),
      ).rejects.toHaveProperty("code", "PRECONDITION_FAILED");
      const other = app.projects.create({ name: "Foreign" });
      const foreignEnvironment = app.environments.create({
        projectId: other.id,
        name: "foreign",
        baseUrl: "http://127.0.0.1:8123",
      });
      const foreignTest = app.tests.create({ projectId: other.id, plan: producerPlan });
      const foreign = app.runs.prepare({
        testId: foreignTest.id,
        environmentId: foreignEnvironment.id,
      });
      Object.assign(foreign, {
        phase: "completed",
        status: "failed",
        outcome: "failed",
        gate: "failed",
      });
      app.context.entities.insert("Run", foreign);
      await expect(
        app.selection.run(
          { ...selection, reuseFromRunIds: [foreign.id], skipDependencies: true },
          { wait: true },
        ),
      ).rejects.toHaveProperty("code", "PRECONDITION_FAILED");
      const passed = app.runs.prepare({ testId: producer.id, environmentId: input.environmentId });
      Object.assign(passed, {
        phase: "completed",
        status: "passed",
        outcome: "passed",
        gate: "passed",
      });
      app.context.entities.insert("Run", passed);
      app.context.entities.insert(
        "VariableValue",
        entity(app.context, "var", {
          createdAt: new Date(Date.now() - 10000).toISOString(),
          batchId: null,
          producerRunId: passed.id,
          producerStepId: request.id,
          name: "id",
          type: "string",
          encryptedValueRef: null,
          taint: "public",
        }),
      );
      await expect(
        app.selection.run(
          { ...selection, reuseFromRunIds: [passed.id], skipDependencies: true },
          { wait: true },
        ),
      ).rejects.toHaveProperty("code", "PRECONDITION_FAILED");
      expect(app.database.all("SELECT * FROM batches")).toHaveLength(0);
    } finally {
      app.close();
    }
  });
});
