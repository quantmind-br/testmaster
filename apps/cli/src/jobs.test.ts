import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Application, scaffoldPlan } from "@testmaster/application";
import { exitCodeForError } from "@testmaster/domain";
import { AuxiliaryLeaseRepository } from "@testmaster/persistence";
import { afterEach, expect, it, vi } from "vitest";
import { AttemptExecutor } from "../../../packages/sandbox/src/index.js";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

const cleanups: (() => Promise<void>)[] = [];
const originalExit = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExit;
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Envelope {
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-cli-jobs-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const app = await Application.open({ cwd, home, env: {} });
  cleanups.push(async () => {
    app.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const init = await app.init();
  /** `exit` is the process's, so it is only meaningful when one invocation runs at a time. */
  const invoke = async (args: string[], onRuntime?: (runtime: Runtime) => void) => {
    let stdout = "";
    const runtime = new Runtime(
      new Writable({
        write(chunk, _encoding, done) {
          stdout += String(chunk);
          done();
        },
      }),
      new Writable({ write: (_chunk, _encoding, done) => done() }),
    );
    runtime.app = async () => app;
    onRuntime?.(runtime);
    process.exitCode = 0;
    await runCli(["--json", "--cwd", cwd, ...args], runtime);
    return { exit: process.exitCode ?? 0, body: JSON.parse(stdout) as Envelope };
  };
  const leases = new AuxiliaryLeaseRepository(app.database);
  const queueJob = (targetId: string, operation = "wait-test") =>
    leases.enqueue(app.context.workspaceId, "analysis", {
      operation,
      targetId,
      actorId: app.context.principalId,
      evidenceHash: "a".repeat(64),
      configHash: "b".repeat(64),
      options: {},
    }).job;
  const env = app.environments.list(init.projectId)[0];
  const revision = app.environments
    .revisions(String(env?.id))
    .find((item) => item.id === env?.activeRevisionId);
  const url = String(revision?.targetOrigins[0]);
  /**
   * An exploration whose browser work waits until `release()` or until the exploration is asked
   * to stop: a real, long-running job created through the application.
   */
  const exploration = async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const arrived = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(AttemptExecutor.prototype, "execute").mockImplementation((async (
      _input: unknown,
      signal?: AbortSignal,
    ) => {
      entered();
      await new Promise<void>((resolve) => {
        void gate.then(resolve);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return signal?.aborted
        ? { outcome: "cancelled", reasonCode: "user_cancelled" }
        : { outcome: "passed", reasonCode: "assertions_satisfied" };
    }) as never);
    const { job, completion } = app.explore.begin({
      projectId: init.projectId,
      url,
      budget: { steps: 5, timeMs: 60_000 },
    });
    await arrived;
    return { id: String(job.id), release, completion };
  };
  const reads = vi.spyOn(app.jobs, "get");
  /** Resolves once a running `job wait` has read its still unsettled job a few more times. */
  const polling = async () => {
    const before = reads.mock.calls.length;
    await vi.waitFor(() => expect(reads.mock.calls.length).toBeGreaterThanOrEqual(before + 3), {
      timeout: 10_000,
    });
  };
  return { app, init, invoke, leases, queueJob, exploration, polling };
}

const UNKNOWN_JOB = "job_00000000-0000-4000-8000-000000000000";

it("get of an unknown or foreign id fails NOT_FOUND for every id family", async () => {
  const f = await fixture();
  for (const id of [UNKNOWN_JOB, "dsc_00000000-0000-4000-8000-000000000000", "bat_x", "nonsense"]) {
    const result = await f.invoke(["job", "get", id]);
    expect(result.body.error?.code, id).toBe("NOT_FOUND");
    expect(result.exit, id).toBe(exitCodeForError("NOT_FOUND"));
  }
  const waited = await f.invoke(["job", "wait", UNKNOWN_JOB]);
  expect(waited.body.error?.code).toBe("NOT_FOUND");
});

it("wait returns the stored result of a real analysis job that already ended, with exit 0", async () => {
  const f = await fixture();
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const run = f.app.runs.resolve({ testId: test.id, environmentId: f.init.environmentId });
  Object.assign(run, { phase: "completed", status: "failed", outcome: "failed", gate: "failed" });
  f.app.context.entities.insert("Run", run);
  const analysis = await f.app.analysis.analyze(run.id);
  const [job] = f.leases.forTarget(f.app.context.workspaceId, "analysis", run.id);
  if (!job) throw new Error("The analysis created no job");

  const waited = await f.invoke(["job", "wait", job.jobId]);
  expect(waited.exit).toBe(0);
  expect(waited.body.data).toMatchObject({
    id: job.jobId,
    kind: "analysis",
    state: "completed",
    settled: true,
    result: { analysisId: analysis.id },
  });
  const read = await f.invoke(["job", "get", job.jobId]);
  expect(read.body.data).toEqual(waited.body.data);
});

it("wait blocks while an auxiliary job is held and returns the result its holder stores", async () => {
  const f = await fixture();
  const job = f.queueJob("run_target");
  const fence = f.leases.claim({
    workspaceId: f.app.context.workspaceId,
    owner: "holder",
    queue: "analysis",
    jobId: job.jobId,
  });
  if (!fence) throw new Error("The job could not be claimed");
  let ended = false;
  const waiting = f.invoke(["job", "wait", job.jobId]).finally(() => {
    ended = true;
  });
  await f.polling();
  expect(ended).toBe(false);
  expect((await f.invoke(["job", "get", job.jobId])).body.data).toMatchObject({
    state: "leased",
    settled: false,
    result: null,
  });

  f.leases.finish(fence, "completed", { analysisId: "ana_done" });
  const settled = await waiting;
  expect(settled.body.data).toMatchObject({
    state: "completed",
    settled: true,
    result: { analysisId: "ana_done" },
  });
  // Control: the waiter's own exit code is the process's, so read it from a sequential wait.
  expect((await f.invoke(["job", "wait", job.jobId])).exit).toBe(0);
});

it("wait on a cancelled job exits 1, and a job that needs settlement ends the wait with exit 1", async () => {
  const f = await fixture();
  const cancelled = f.queueJob("run_cancelled");
  const asked = await f.invoke(["job", "cancel", cancelled.jobId, "--reason", "no longer needed"]);
  expect(asked.body.data).toMatchObject({ requested: true, job: { state: "cancelled" } });
  const waited = await f.invoke(["job", "wait", cancelled.jobId]);
  expect(waited.exit).toBe(1);
  expect(waited.body.data).toMatchObject({
    state: "cancelled",
    settled: true,
    result: { reason: "cancel_requested", cancelReason: "no longer needed" },
  });

  const paid = f.queueJob("run_paid");
  const fence = f.leases.claim({
    workspaceId: f.app.context.workspaceId,
    owner: "crashed",
    queue: "analysis",
    jobId: paid.jobId,
  });
  if (!fence) throw new Error("The job could not be claimed");
  f.leases.mark(fence, { paidCallStarted: true });
  f.leases.expire(new Date(Date.now() + 120_000).toISOString());
  const stuck = await f.invoke(["job", "wait", paid.jobId]);
  expect(stuck.exit).toBe(1);
  expect(stuck.body.data).toMatchObject({
    state: "reconciliation_required",
    settled: false,
    needsSettlement: true,
  });
  // Cancelling would discard a call that may be billed, so it is refused and nothing changes.
  const refused = await f.invoke(["job", "cancel", paid.jobId, "--reason", "stuck"]);
  expect(refused.body.error?.code).toBe("PRECONDITION_FAILED");
  expect((await f.invoke(["job", "get", paid.jobId])).body.data?.state).toBe(
    "reconciliation_required",
  );
});

it("cancel of a running exploration ends it cancelled, and wait then returns the cancelled job", async () => {
  const f = await fixture();
  const running = await f.exploration();
  expect((await f.invoke(["job", "get", running.id])).body.data).toMatchObject({
    kind: "exploration",
    state: "exploring",
    settled: false,
  });

  const asked = await f.invoke(["job", "cancel", running.id, "--reason", "wrong environment"]);
  expect(asked.body.data).toMatchObject({
    jobId: running.id,
    reason: "wrong environment",
    requested: true,
  });
  // A request is not a stop: the job is confirmed cancelled by reading it.
  const waited = await f.invoke(["job", "wait", running.id]);
  expect(waited.body.data).toMatchObject({
    kind: "exploration",
    state: "cancelled",
    settled: true,
  });
  expect(waited.exit).toBe(1);
  expect((await running.completion).phase).toBe("cancelled");

  // Control: cancelling a job that already ended asks nothing of it and changes nothing.
  const again = await f.invoke(["job", "cancel", running.id, "--reason", "again"]);
  expect(again.body.data).toMatchObject({ requested: false, job: { state: "cancelled" } });
});

it("wait returns a completed exploration once its work ends, with exit 0", async () => {
  const f = await fixture();
  const running = await f.exploration();
  let ended = false;
  const waiting = f.invoke(["job", "wait", running.id]).finally(() => {
    ended = true;
  });
  await f.polling();
  expect(ended).toBe(false);
  running.release();
  const settled = await waiting;
  expect(settled.body.data).toMatchObject({
    kind: "exploration",
    state: "completed",
    settled: true,
  });
  expect((await f.invoke(["job", "wait", running.id])).exit).toBe(0);
});

it("Ctrl-C detaches a wait without cancelling the job", async () => {
  const f = await fixture();
  const running = await f.exploration();
  let runtime: Runtime | undefined;
  const pending = f.invoke(["job", "wait", running.id], (created) => {
    runtime = created;
  });
  await f.polling();
  runtime?.interrupt("SIGINT");
  const interrupted = await pending;
  expect(interrupted.exit).toBe(130);
  expect(interrupted.body.error?.details).toMatchObject({
    signal: "SIGINT",
    receipts: [{ jobId: running.id }],
  });
  // The exploration is still running and uncancelled.
  expect((await f.invoke(["job", "get", running.id])).body.data).toMatchObject({
    state: "exploring",
    settled: false,
  });
  running.release();
  expect((await running.completion).phase).toBe("completed");
});

it("cancel refuses a job a process holds, and a blank or missing reason", async () => {
  const f = await fixture();
  const job = f.queueJob("run_held");
  const fence = f.leases.claim({
    workspaceId: f.app.context.workspaceId,
    owner: "holder",
    queue: "analysis",
    jobId: job.jobId,
  });
  if (!fence) throw new Error("The job could not be claimed");
  const held = await f.invoke(["job", "cancel", job.jobId, "--reason", "stop it"]);
  expect(held.body.error?.code).toBe("PRECONDITION_FAILED");
  expect((await f.invoke(["job", "get", job.jobId])).body.data?.state).toBe("leased");
  // The holder still finishes: nothing was taken from it.
  f.leases.finish(fence, "completed", { analysisId: "ana_kept" });
  expect((await f.invoke(["job", "get", job.jobId])).body.data).toMatchObject({
    state: "completed",
    result: { analysisId: "ana_kept" },
  });

  const blank = await f.invoke(["job", "cancel", job.jobId, "--reason", "   "]);
  expect(blank.body.error?.code).toBe("INVALID_ARGUMENT");
  const missing = await f.invoke(["job", "cancel", job.jobId]);
  expect(missing.body.error?.code).toBe("INVALID_ARGUMENT");
});
