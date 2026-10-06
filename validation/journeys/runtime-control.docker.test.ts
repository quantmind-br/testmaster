import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Application } from "@testmaster/application";
import { expect, it, vi } from "vitest";
import { LeaseRepository } from "../../packages/persistence/src/index.js";
import {
  action,
  assertion,
  controlledShop,
  eventually,
  executable,
  healthPlan,
  journey,
  text,
} from "./harness.js";

const exec = promisify(execFile);
const browserPlan = () =>
  executable("Pinned browser", "playwright", [
    action("open_login", "navigate", { path: "/login" }),
    assertion("password_present", { locator: { by: "testId", value: "password" } }, "visible"),
  ]);
const capacity = (memoryGiB: number, browserSlots: number) => ({
  cpu: 16,
  memoryBytes: memoryGiB * 1024 ** 3,
  pids: 1024,
  diskBytes: 8 * 1024 ** 3,
  pools: { browser: browserSlots, http: 1, python: 1 },
});

it("OPS-032 resource headroom queues a second browser while an HTTP pool progresses; repeated cancel kills all container children", async () => {
  await journey("runtime-pools-cancel", async (session) => {
    const target = await controlledShop();
    let app: Application | undefined;
    let worker: Promise<unknown> | undefined;
    try {
      const init = await session.init(target.url);
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      const first = app.tests.create({ projectId: text(init.projectId), plan: browserPlan() });
      const second = app.tests.create({ projectId: text(init.projectId), plan: browserPlan() });
      const http = app.tests.create({ projectId: text(init.projectId), plan: healthPlan() });
      target.hold();
      worker = app.worker.run({ capacity: capacity(4, 2) });
      await eventually(async () => app!.worker.live(), Boolean);
      const status = app.worker.status()[0]!;
      expect(
        (status.imageDigests as string[]).every((id) => /^sha256:[a-f0-9]{64}$/.test(id)),
      ).toBe(true);
      expect((status.imageDigests as string[]).length).toBeGreaterThan(0);
      // Raise the pinned per-run ceiling; pool/resource budgets still dominate.
      const admit = (testId: string) =>
        app!.runs.admit(
          {
            testId,
            environmentId: text(init.environmentId),
            extensions: { "testmaster:maxConcurrency": 3 },
          },
          { wait: false },
        );
      // Worker global concurrency is a separate operator ceiling, configured before restart below.
      app.config.effectiveConfig.config.execution!.concurrency = 3;
      const a = await admit(first.id);
      const b = await admit(second.id);
      const h = await admit(http.id);
      session.runIds.push(a.runId, b.runId, h.runId);
      await eventually(
        async () => target.hits(),
        (hits) => hits >= 2,
      );
      expect(app.runs.get(b.runId).status).toBe("queued");
      expect(app.database.all("SELECT * FROM attempts WHERE run_id=?", b.runId)).toHaveLength(0);
      expect(app.database.all("SELECT * FROM job_leases WHERE state='leased'")).toHaveLength(2);
      const attempt = app.database.get("SELECT id FROM attempts WHERE run_id=?", a.runId)!;
      const { stdout: before } = await exec("docker", [
        "top",
        `tm-att-${attempt.id}`,
        "-eo",
        "pid,comm",
      ]);
      expect(before).toMatch(/chrome|chromium/);
      app.runs.cancel(a.runId);
      app.runs.cancel(a.runId);
      app.runs.cancel(b.runId);
      app.runs.cancel(h.runId);
      await eventually(
        async () => app!.runs.get(a.runId),
        (run) => run.phase === "completed",
      );
      const original = app.runs.get(a.runId);
      expect(app.runs.cancel(a.runId)).toMatchObject({
        result: "already_terminal",
        status: original.status,
      });
      expect(app.runs.get(a.runId)).toEqual(original);
      expect(
        app.runs.events(a.runId).filter((event) => event.type === "run.cancel_requested"),
      ).toHaveLength(1);
      expect(
        app.runs.events(a.runId).filter((event) => event.type === "run.completed"),
      ).toHaveLength(1);
      const { stdout: after } = await exec("docker", [
        "ps",
        "-a",
        "-q",
        "--filter",
        `label=io.testmaster.run=${a.runId}`,
      ]);
      expect(after.trim()).toBe("");
      app.worker.drain();
      await worker;
      worker = undefined;
      session.oracles.push({
        check: "resourceAdmissionAndCancelChildren",
        healthy: true,
        queuedRun: b.runId,
        browserRun: a.runId,
        httpRun: h.runId,
        remainingContainers: after.trim(),
        imageDigests: status.imageDigests,
      });
    } finally {
      target.release();
      if (app && worker) {
        app.worker.drain();
        await worker;
      }
      app?.close();
      await target.close();
    }
  });
}, 180000);

it("DATA-001 concurrent declarative and imported revisions retain distinct code, steps and verdicts", async () => {
  await journey("runtime-concurrent-revisions", async (session) => {
    const target = await controlledShop();
    let app: Application | undefined;
    let worker: Promise<unknown> | undefined;
    try {
      const init = await session.init(target.url);
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      app.config.effectiveConfig.config.execution!.concurrency = 2;
      const test = app.tests.create({ projectId: text(init.projectId), plan: browserPlan() });
      const path = join(session.cwd, "different.spec.ts");
      await writeFile(
        path,
        "import { test, expect } from '@playwright/test';\ntest('imported wrong oracle', async ({ page }) => { await page.goto('/login'); await expect(page.getByTestId('password')).toHaveAttribute('type', 'email'); });\n",
      );
      const imported = await app.codeImport.import({
        projectId: text(init.projectId),
        path,
        format: "playwright",
      });
      const rev = await app.codeImport.createRevision(
        test.id,
        imported.revision.codeRef!,
        test.activeRevisionId!,
      );
      target.hold();
      worker = app.worker.run({ capacity: capacity(8, 2) });
      await eventually(async () => app!.worker.live(), Boolean);
      const a = await app.runs.admit({
        testId: test.id,
        revisionId: test.activeRevisionId!,
        environmentId: text(init.environmentId),
      });
      const b = await app.runs.admit({
        testId: test.id,
        revisionId: rev.id,
        environmentId: text(init.environmentId),
      });
      session.runIds.push(a.runId, b.runId);
      await eventually(
        async () => target.hits(),
        (hits) => hits >= 2,
      );
      expect(app.database.all("SELECT * FROM job_leases WHERE state='leased'")).toHaveLength(2);
      target.release();
      const completed = await Promise.all([app.runs.wait(a.runId), app.runs.wait(b.runId)]);
      expect(completed.map((run) => run.outcome)).toEqual(["passed", "failed"]);
      const stepsA = app.runs.steps(a.runId);
      const stepsB = app.runs.steps(b.runId);
      expect(stepsA.map((step) => step.planStepId)).toContain("password_present");
      expect(stepsB.map((step) => step.planStepId)).not.toContain("password_present");
      expect(stepsB.map((step) => step.planStepId)).toContain("imported-code");
      expect(completed.map((run) => run.revisionId)).toEqual([test.activeRevisionId, rev.id]);
      app.worker.drain();
      await worker;
      worker = undefined;
      session.oracles.push({
        check: "concurrentPinnedCode",
        healthy: true,
        runs: completed.map((run) => ({
          id: run.id,
          revisionId: run.revisionId,
          outcome: run.outcome,
        })),
        stepsA: stepsA.map((step) => step.planStepId),
        stepsB: stepsB.map((step) => step.planStepId),
      });
    } finally {
      target.release();
      if (app && worker) {
        app.worker.drain();
        await worker;
      }
      app?.close();
      await target.close();
    }
  });
}, 180000);

it("REQ-001 doctor distinguishes dead target from absent optional model; SEC-002 missing Docker creates blocked Run", async () => {
  await journey("runtime-doctor-preconditions", async (session) => {
    const target = await controlledShop();
    let closed = false;
    try {
      await session.init(target.url);
      const test = await session.createTest(healthPlan());
      const up = await session.command(["doctor", "--target", target.url]);
      expect((up.checks as Record<string, Record<string, unknown>>).target!.status).toBe("PASS");
      expect((up.checks as Record<string, Record<string, unknown>>).model!.status).toBe("ABSENT");
      const url = target.url;
      await target.close();
      closed = true;
      const dead = await session.start(["doctor", "--target", url]).result;
      const checks = (dead.json!.data as Record<string, unknown>).checks as Record<
        string,
        Record<string, unknown>
      >;
      expect(checks.target!.diagnostics).toEqual(["target_unreachable"]);
      expect(checks.model!.diagnostics).toEqual(["model_not_configured"]);
      const result = await session.start(["test", "run", text(test.id), "--wait"], {
        DOCKER_HOST: "unix:///tmp/testmaster-missing-daemon.sock",
      }).result;
      const run = (result.json!.data as Record<string, unknown>).run as Record<string, unknown>;
      expect(run.outcome).toBe("blocked");
      expect(run.gate).toBe("failed");
      const events = await session.start(["run", "events", text(run.id), "--format", "ndjson"])
        .result;
      expect(events.stdout).toContain("security_precondition_failed");
      session.oracles.push({
        check: "doctorTargetModelAndMissingSandbox",
        healthy: true,
        targetDown: checks.target,
        modelAbsent: checks.model,
        blockedRun: run.id,
      });
    } finally {
      if (!closed) await target.close();
    }
  });
}, 180000);

it("OPS-014 global deadline refuses the next target step and retains partial evidence", async () => {
  await journey("runtime-global-deadline", async (session) => {
    const target = await controlledShop();
    let app: Application | undefined;
    let worker: Promise<unknown> | undefined;
    try {
      const init = await session.init(target.url);
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      const plan = healthPlan();
      plan.steps.push(
        action("never_request", "request", {
          method: "GET",
          pathSegments: [{ literal: "api" }, { literal: "products" }],
        }),
      );
      const test = app.tests.create({ projectId: text(init.projectId), plan });
      target.hold();
      worker = app.worker.run({ capacity: capacity(8, 2) });
      await eventually(async () => app!.worker.live(), Boolean);
      const receipt = await app.runs.admit({
        testId: test.id,
        environmentId: text(init.environmentId),
        limits: { executionTimeoutMs: 3000, attemptTimeoutMs: 30000, maxAttempts: 1 },
      });
      session.runIds.push(receipt.runId);
      const run = await app.runs.wait(receipt.runId);
      expect(run.outcome).not.toBe("passed");
      expect(target.hits()).toBe(1);
      expect(
        app.runs
          .events(receipt.runId)
          .some(
            (event) =>
              event.type === "step.started" &&
              (event.payload as Record<string, unknown>).stepId === "never_request",
          ),
      ).toBe(false);
      const bundle = await app.artifacts.get(receipt.runId);
      expect(bundle.manifest.entries.length).toBeGreaterThan(0);
      app.worker.drain();
      await worker;
      worker = undefined;
      session.oracles.push({
        check: "globalDeadlineNoSubsequentEffects",
        healthy: true,
        runId: receipt.runId,
        targetHits: target.hits(),
        outcome: run.outcome,
      });
    } finally {
      target.release();
      if (app && worker) {
        app.worker.drain();
        await worker;
      }
      app?.close();
      await target.close();
    }
  });
}, 180000);

it("OPS-015 drain after claim retains the active job but never starts the queued attempt", async () => {
  await journey("runtime-drain-after-claim", async (session) => {
    const target = await controlledShop();
    let app: Application | undefined;
    let worker: Promise<unknown> | undefined;
    let restoreClaim: (() => void) | undefined;
    try {
      const init = await session.init(target.url);
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      const test = app.tests.create({ projectId: text(init.projectId), plan: healthPlan() });
      target.hold();
      worker = app.worker.run({ capacity: capacity(8, 2) });
      await eventually(async () => app!.worker.live(), Boolean);
      const claim = LeaseRepository.prototype.claim;
      const afterClaim = vi
        .spyOn(LeaseRepository.prototype, "claim")
        .mockImplementation(function (request) {
          const fence = claim.call(this, request);
          if (fence) queueMicrotask(() => app!.worker.drain());
          return fence;
        });
      restoreClaim = () => afterClaim.mockRestore();
      const a = await app.runs.admit({ testId: test.id, environmentId: text(init.environmentId) });
      const b = await app.runs.admit({ testId: test.id, environmentId: text(init.environmentId) });
      session.runIds.push(a.runId, b.runId);
      await eventually(
        async () => target.hits(),
        (hits) => hits === 1,
      );
      app.worker.drain();
      expect(app.worker.live()).toBe(false);
      target.release();
      await worker;
      worker = undefined;
      expect(app.runs.get(a.runId).outcome).toBe("passed");
      expect(app.runs.get(b.runId).status).toBe("queued");
      expect(app.database.all("SELECT * FROM attempts WHERE run_id=?", b.runId)).toHaveLength(0);
      app.runs.cancel(b.runId);
      session.oracles.push({
        check: "drainStopsNewClaims",
        healthy: true,
        completedRun: a.runId,
        queuedRun: b.runId,
        targetHits: target.hits(),
      });
    } finally {
      target.release();
      if (app && worker) {
        app.worker.drain();
        await worker;
      }
      app?.close();
      await target.close();
      restoreClaim?.();
    }
  });
}, 180000);

it("M1-06 admitted batch selection remains immutable while tags and available tests change in flight", async () => {
  await journey("runtime-batch-selection", async (session) => {
    const target = await controlledShop();
    let app: Application | undefined;
    let worker: Promise<unknown> | undefined;
    try {
      const init = await session.init(target.url);
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      const first = app.tests.create({
        projectId: text(init.projectId),
        plan: healthPlan(),
        tags: ["selected"],
      });
      const second = app.tests.create({
        projectId: text(init.projectId),
        plan: healthPlan(),
        tags: ["selected"],
      });
      target.hold();
      worker = app.worker.run({ capacity: capacity(8, 2) });
      await eventually(async () => app!.worker.live(), Boolean);
      const selection = app.tests
        .list(text(init.projectId))
        .filter((test) => test.tags.includes("selected"))
        .map((test) => ({ testId: test.id, environmentId: text(init.environmentId) }));
      const receipt = await app.batches.admit({ selection });
      session.runIds.push(...receipt.allMembers);
      await eventually(
        async () => target.hits(),
        (hits) => hits === 1,
      );
      const before = app.batches.get(receipt.batchId).selectionSnapshot;
      app.tests.update(second.id, { tags: ["excluded"] }, second.version ?? 1);
      const added = app.tests.create({
        projectId: text(init.projectId),
        plan: healthPlan(),
        tags: ["selected"],
      });
      target.release();
      await Promise.all(receipt.memberRuns.map((member) => app!.runs.wait(member.runId)));
      expect(app.batches.get(receipt.batchId).selectionSnapshot).toEqual(before);
      expect(receipt.memberRuns.map((member) => app!.runs.get(member.runId).testId).sort()).toEqual(
        [first.id, second.id].sort(),
      );
      expect(app.runs.list().some((run) => run.testId === added.id)).toBe(false);
      expect(app.batches.get(receipt.batchId).aggregate).toMatchObject({ counts: { passed: 2 } });
      app.worker.drain();
      await worker;
      worker = undefined;
      session.oracles.push({
        check: "admittedSuiteSelection",
        healthy: true,
        batchId: receipt.batchId,
        admittedTests: [first.id, second.id],
        excludedLater: second.id,
        addedLater: added.id,
      });
    } finally {
      target.release();
      if (app && worker) {
        app.worker.drain();
        await worker;
      }
      app?.close();
      await target.close();
    }
  });
}, 180000);
