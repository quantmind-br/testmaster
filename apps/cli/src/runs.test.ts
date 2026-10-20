import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { Application, SignedCursorCodec, scaffoldPlan } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import { exitCodeForRun } from "@testmaster/domain";
import { ExecutionRepository, OutboxRepository } from "@testmaster/persistence";
import { afterEach, expect, it, vi } from "vitest";
import { seedRun } from "../../../packages/application/src/run-seed.testing.js";
import { runCli } from "./cli.js";
import { waitForRun } from "./execution.js";
import { Runtime } from "./runtime.js";

const cleanups: (() => Promise<void>)[] = [];
const originalExit = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExit;
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Invocation {
  exit: number;
  stdout: string;
  stderr: string;
}
type Invoke = (
  args: string[],
  json?: boolean,
  onRuntime?: (runtime: Runtime) => void,
) => Promise<Invocation>;
interface ErrorEnvelope {
  error: { code: string };
}

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-cli-runs-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const app = await Application.open({ cwd, home, env: {} });
  cleanups.push(async () => {
    app.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const init = await app.init();
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  /** One invocation at a time: the exit code is the process's. `onRuntime` sees the runtime before it runs. */
  const invoke: Invoke = async (args, json = true, onRuntime) => {
    let stdout = "";
    let stderr = "";
    const sink = (append: (text: string) => void) =>
      new Writable({
        write(chunk, _encoding, done) {
          append(String(chunk));
          done();
        },
      });
    const runtime = new Runtime(
      sink((text) => {
        stdout += text;
      }),
      sink((text) => {
        stderr += text;
      }),
    );
    runtime.app = async () => app;
    onRuntime?.(runtime);
    process.exitCode = 0;
    await runCli([...(json ? ["--json"] : []), "--cwd", cwd, ...args], runtime);
    return { exit: process.exitCode ?? 0, stdout, stderr };
  };
  /** A Run of `test` in the init environment, unless `options` names another test or environment. */
  const seed = (
    steps: number,
    options: {
      complete?: boolean;
      testId?: string;
      environmentId?: string;
      outcome?: "passed" | "failed";
    } = {},
  ) =>
    seedRun(app, {
      testId: options.testId ?? test.id,
      environmentId: options.environmentId ?? init.environmentId,
      ...(options.complete === undefined ? {} : { complete: options.complete }),
      attempts: [
        {
          outcome: options.outcome ?? "passed",
          steps: Array.from({ length: steps }, (_, index) => ({
            stepId: `step-${String(index).padStart(3, "0")}`,
            status: "passed" as const,
          })),
        },
      ],
    });
  return { app, init, test, invoke, seed };
}

interface StepsPage {
  data: {
    runId: string;
    attemptId?: string;
    total: number;
    returned: number;
    steps: { planStepId: string }[];
    nextCursor: string | null;
  };
}

async function pageOfSteps(invoke: Invoke, args: string[]) {
  const result = await invoke(["run", "steps", ...args]);
  return { ...result, page: JSON.parse(result.stdout) as StepsPage };
}

it("run steps returns every step exactly once across pages and ends with a null nextCursor", async () => {
  const { invoke, seed } = await fixture();
  const { runId } = await seed(7);
  const seen: string[] = [];
  const sizes: number[] = [];
  let cursor: string | null = null;
  do {
    const result = await pageOfSteps(invoke, [
      runId,
      "--limit",
      "3",
      ...(cursor ? ["--cursor", cursor] : []),
    ]);
    expect(result.exit).toBe(0);
    expect(result.page.data.total).toBe(7);
    sizes.push(result.page.data.returned);
    seen.push(...result.page.data.steps.map((step) => step.planStepId));
    cursor = result.page.data.nextCursor;
  } while (cursor);
  expect(sizes).toEqual([3, 3, 1]);
  expect(seen).toEqual(
    Array.from({ length: 7 }, (_, index) => `step-${String(index).padStart(3, "0")}`),
  );
});

it("run steps without --limit pages at the 50 steps the MCP resource serves", async () => {
  const { invoke, seed } = await fixture();
  const { runId } = await seed(55);
  const first = await pageOfSteps(invoke, [runId]);
  expect(first.page.data.returned).toBe(50);
  expect(first.page.data.total).toBe(55);
  expect(first.page.data.nextCursor).not.toBeNull();
  const second = await pageOfSteps(invoke, [runId, "--cursor", String(first.page.data.nextCursor)]);
  expect(second.page.data.steps.map((step) => step.planStepId)).toEqual(
    Array.from({ length: 5 }, (_, index) => `step-${String(index + 50).padStart(3, "0")}`),
  );
  expect(second.page.data.nextCursor).toBeNull();
});

it("run steps --attempt pages only that attempt's steps", async () => {
  const { invoke, seed } = await fixture();
  const { runId, attemptIds } = await seed(4);
  const result = await pageOfSteps(invoke, [
    runId,
    "--attempt",
    String(attemptIds[0]),
    "--limit",
    "3",
  ]);
  expect(result.page.data).toMatchObject({ attemptId: attemptIds[0], total: 4, returned: 3 });
  const missing = await pageOfSteps(invoke, [runId, "--attempt", "att_unknown"]);
  expect(missing.page.data).toMatchObject({ total: 0, returned: 0, nextCursor: null });
});

it("run steps refuses a cursor that was modified, expired, or issued for another run or attempt", async () => {
  const { app, invoke, seed } = await fixture();
  const first = await seed(6);
  const other = await seed(6);
  const { page } = await pageOfSteps(invoke, [first.runId, "--limit", "2"]);
  const cursor = String(page.data.nextCursor);
  const refused = async (args: string[]) => {
    const result = await invoke(["run", "steps", ...args]);
    return { exit: result.exit, code: (JSON.parse(result.stdout) as ErrorEnvelope).error.code };
  };

  // The payload carries the offset: flipping a character breaks the signature.
  const [payload, signature] = cursor.split(".");
  const flipped = `${payload?.slice(0, -1)}${payload?.endsWith("A") ? "B" : "A"}.${signature}`;
  expect(await refused([first.runId, "--cursor", flipped])).toEqual({
    exit: 5,
    code: "INVALID_ARGUMENT",
  });
  expect(await refused([first.runId, "--cursor", "not-a-cursor"])).toEqual({
    exit: 5,
    code: "INVALID_ARGUMENT",
  });
  // Foreign: another run, and the same run read for one attempt only.
  expect(await refused([other.runId, "--cursor", cursor])).toEqual({
    exit: 5,
    code: "INVALID_ARGUMENT",
  });
  expect(
    await refused([first.runId, "--attempt", String(first.attemptIds[0]), "--cursor", cursor]),
  ).toEqual({ exit: 5, code: "INVALID_ARGUMENT" });

  // Expired: correctly signed and bound, but past its expiry.
  const expired = new SignedCursorCodec(app).encode(
    {
      binding: `cli:steps:${first.runId}::${app.context.principalId}`,
      id: "2",
      createdAt: "",
      cutoff: "",
    },
    Date.now() - 1000,
  );
  const result = await refused([first.runId, "--cursor", expired]);
  expect(result.code).toBe("CURSOR_EXPIRED");
  expect(result.exit).not.toBe(0);

  // The valid cursor still pages on after the refusals.
  const next = await pageOfSteps(invoke, [first.runId, "--limit", "2", "--cursor", cursor]);
  expect(next.page.data.steps.map((step) => step.planStepId)).toEqual(["step-002", "step-003"]);
});

it("run events --follow without --format ndjson is refused before streaming", async () => {
  const { invoke, seed } = await fixture();
  const { runId } = await seed(1);
  const result = await invoke(["run", "events", runId, "--follow"], false);
  expect(result.exit).toBe(5);
  expect(result.stderr).toContain("INVALID_ARGUMENT");
  expect(result.stdout).toBe("");
});

function lines(stdout: string): { seq: number; type: string }[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { seq: number; type: string });
}

/** Records one more event of the run, then completes it the way the worker does. */
function complete(
  app: Application,
  runId: string,
  attemptId: string,
  outcome: "passed" | "failed",
) {
  const lease = app.database.get(
    "SELECT j.id,j.fence,j.lease_owner FROM job_leases j JOIN attempts a ON a.workspace_id=j.workspace_id AND a.job_id=j.id WHERE a.id=?",
    attemptId,
  );
  if (!lease) throw new Error("lease of the seeded attempt not found");
  app.database.withTx(() =>
    new OutboxRepository(app.database).append(app.context.workspaceId, runId, "step.started", {
      attemptId,
      stepId: "late-step",
      index: 99,
    }),
  );
  return new ExecutionRepository(app.database).finalize(
    {
      workspaceId: app.context.workspaceId,
      jobId: String(lease.id),
      owner: String(lease.lease_owner),
      fence: Number(lease.fence),
      attemptId,
    },
    {
      ...app.runs.get(runId),
      phase: "completed",
      status: outcome,
      outcome,
      gate: outcome === "passed" ? "passed" : "failed",
      cleanupOutcome: "not_required",
      analysisStatus: "not_requested",
    },
  );
}

it("run events --follow streams events recorded after it started and exits when the run completes", async () => {
  const { app, invoke, seed } = await fixture();
  const seeded = await seed(2, { complete: false });
  const attemptId = String(seeded.attemptIds[0]);
  const before = app.runs.events(seeded.runId);
  expect(before.length).toBeGreaterThan(0);

  const following = invoke(
    ["run", "events", seeded.runId, "--follow", "--format", "ndjson"],
    false,
  );
  // Still running: the command has not returned and has printed what was already recorded.
  const state = await Promise.race([
    following.then(() => "ended"),
    sleep(400).then(() => "running"),
  ]);
  expect(state).toBe("running");

  expect(complete(app, seeded.runId, attemptId, "passed")).toBe(true);
  const result = await following;

  const streamed = lines(result.stdout);
  const recorded = app.runs.events(seeded.runId);
  // Every event exactly once, in order, including the ones recorded while it followed.
  expect(streamed.map((event) => event.seq)).toEqual(recorded.map((event) => event.seq));
  expect(streamed.length).toBeGreaterThan(before.length);
  expect(streamed.at(-1)?.type).toBe("run.completed");
  expect(streamed.some((event) => event.type === "step.started")).toBe(true);
  expect(result.exit).toBe(0);
});

it("run events --follow --after-seq skips the events already read and ends with the failed run's exit code", async () => {
  const { app, invoke, seed } = await fixture();
  const seeded = await seed(1, { complete: false });
  const attemptId = String(seeded.attemptIds[0]);
  const before = app.runs.events(seeded.runId);
  const afterSeq = Number(before.at(-1)?.seq);

  const following = invoke(
    [
      "run",
      "events",
      seeded.runId,
      "--follow",
      "--after-seq",
      String(afterSeq),
      "--format",
      "ndjson",
    ],
    false,
  );
  await sleep(250);
  expect(complete(app, seeded.runId, attemptId, "failed")).toBe(true);
  const result = await following;

  const streamed = lines(result.stdout);
  expect(streamed.every((event) => event.seq > afterSeq)).toBe(true);
  expect(streamed.map((event) => event.type)).toEqual(["step.started", "run.completed"]);
  const expected = exitCodeForRun({ gate: "failed", outcome: "failed", reasonCode: undefined });
  expect(expected).not.toBe(0);
  expect(result.exit).toBe(expected);
});

it("run events --follow on a run that already completed prints its events and ends at once", async () => {
  const { app, invoke, seed } = await fixture();
  const seeded = await seed(1);
  const result = await invoke(
    ["run", "events", seeded.runId, "--follow", "--format", "ndjson"],
    false,
  );
  expect(lines(result.stdout).map((event) => event.seq)).toEqual(
    app.runs.events(seeded.runId).map((event) => event.seq),
  );
  expect(result.exit).toBe(0);
});

it("run events --follow stops on Ctrl-C with the interrupt exit code and keeps what it streamed", async () => {
  const { app, invoke, seed } = await fixture();
  const seeded = await seed(1, { complete: false });
  let runtime: Runtime | undefined;
  const following = invoke(
    ["run", "events", seeded.runId, "--follow", "--format", "ndjson"],
    false,
    (started) => {
      runtime = started;
    },
  );
  await sleep(300);
  runtime?.interrupt("SIGINT");
  const result = await following;
  expect(result.exit).toBe(130);
  expect(lines(result.stdout).map((event) => event.seq)).toEqual(
    app.runs.events(seeded.runId).map((event) => event.seq),
  );
  expect(app.runs.get(seeded.runId).phase).not.toBe("completed");
});

it("run analyze --model stops on Ctrl-C: the interrupt cancels the model call and exits 130", async () => {
  const { app, invoke, seed } = await fixture();
  const seeded = await seed(1);
  const received = Promise.withResolvers<AbortSignal | undefined>();
  vi.spyOn(app.analysis, "analyze").mockImplementation(async (_runId, _input, options = {}) => {
    received.resolve(options.signal);
    const cancelled = Promise.withResolvers<never>();
    options.signal?.addEventListener(
      "abort",
      () => cancelled.reject(new ContractError("PRECONDITION_FAILED", "Model request cancelled")),
      { once: true },
    );
    return cancelled.promise;
  });
  let runtime: Runtime | undefined;
  const analyzing = invoke(["run", "analyze", seeded.runId, "--model"], true, (started) => {
    runtime = started;
  });
  const signal = await received.promise;
  expect(signal?.aborted).toBe(false);
  runtime?.interrupt("SIGINT");
  const result = await analyzing;
  expect(result.exit).toBe(130);
  expect(signal?.aborted).toBe(true);
});

const inProcessLimitWarning =
  "--timeout and --request-timeout do not end a run this command executes: the wait continues until the run completes or the command is interrupted. The limit applies only to waits on worker-owned runs.";
const cancelRequested = (app: Application, runId: string) =>
  app.runs.events(runId).some((event) => event.type === "run.cancel_requested");

it("a wait limit never ends a run this process executes: the wait outlasts it and only warns", async () => {
  const { app, seed } = await fixture();
  const seeded = await seed(1, { complete: false });
  // The in-process worker finishes the run after 400 ms, well past the 50 ms limit.
  vi.spyOn(app.worker, "run").mockImplementation((async () => {
    await sleep(400);
    complete(app, seeded.runId, String(seeded.attemptIds[0]), "passed");
  }) as never);
  const runtime = new Runtime();
  const run = await waitForRun(runtime, app, seeded.runId, { timeout: 50 }, "ephemeral");
  expect(run).toMatchObject({ phase: "completed", outcome: "passed" });
  expect(cancelRequested(app, seeded.runId)).toBe(false);
  expect(runtime.warnings).toEqual([inProcessLimitWarning]);
  // Without a limit there is nothing to warn about.
  const other = await seed(1, { complete: false });
  vi.mocked(app.worker.run).mockImplementation((async () => {
    await sleep(50);
    complete(app, other.runId, String(other.attemptIds[0]), "passed");
  }) as never);
  const quiet = new Runtime();
  await waitForRun(quiet, app, other.runId, {}, "ephemeral");
  expect(quiet.warnings).toEqual([]);
});

it.each([
  ["--timeout", ["run", "wait", "RUN", "--timeout", "0.05"]],
  ["--request-timeout", ["--request-timeout", "0.05", "run", "wait", "RUN"]],
])(
  "run wait with %s ends the wait on a worker-owned run with exit 7 and leaves the run going",
  async (_flag, args) => {
    const { app, invoke, seed } = await fixture();
    const seeded = await seed(1, { complete: false });
    const result = await invoke(args.map((arg) => (arg === "RUN" ? seeded.runId : arg)));
    expect(result.exit).toBe(7);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: "UPSTREAM_TIMEOUT", details: { ownership: "worker" } },
    });
    expect(app.runs.get(seeded.runId).phase).not.toBe("completed");
    expect(cancelRequested(app, seeded.runId)).toBe(false);
  },
);

interface ListedRun {
  id: string;
  testId: string;
  batchId: string | null;
  status: string;
  createdAt: string;
}
interface RunsPage {
  total: number;
  returned: number;
  items: ListedRun[];
  nextCursor: string | null;
}

/** Runs of two tests, one passed and one failed, plus a Run of a test in a second project. */
async function listFixture() {
  const f = await fixture();
  vi.stubEnv("TESTMASTER_PROJECT_ID", undefined);
  const other = f.app.tests.create({
    projectId: f.init.projectId,
    plan: scaffoldPlan("backend"),
    name: "other",
  });
  const second = f.app.projects.create({ name: "Second project" });
  const secondEnvironment = f.app.environments.create({
    projectId: second.id,
    name: "staging",
    baseUrl: "http://127.0.0.1:4102",
  });
  const secondTest = f.app.tests.create({ projectId: second.id, plan: scaffoldPlan("backend") });
  const run = (testId: string, outcome: "passed" | "failed", environmentId: string) =>
    f.seed(0, { testId, environmentId, outcome });
  const passed = await run(f.test.id, "passed", f.init.environmentId);
  const failed = await run(other.id, "failed", f.init.environmentId);
  const inSecond = await run(secondTest.id, "passed", secondEnvironment.id);
  const list = async (args: string[] = []) => {
    const result = await f.invoke(["run", "list", ...args]);
    return {
      ...result,
      document: JSON.parse(result.stdout) as {
        data: unknown;
        error?: { code: string; message: string };
      },
    };
  };
  const ids = async (args: string[] = []) =>
    ((await list(args)).document.data as ListedRun[]).map((item) => item.id);
  return { ...f, other, second, secondTest, passed, failed, inSecond, list, ids };
}

it("run list --test returns only the runs of that test", async () => {
  const f = await listFixture();
  expect(await f.ids(["--test", f.test.id])).toEqual([f.passed.runId]);
  expect(await f.ids(["--test", f.other.id])).toEqual([f.failed.runId]);
});

it("run list --batch returns only the runs of that batch", async () => {
  const f = await listFixture();
  f.app.preflight = async () => {};
  const batch = await f.app.batches.admit(
    { selection: [{ testId: f.test.id, environmentId: f.init.environmentId }] } as Parameters<
      typeof f.app.batches.admit
    >[0],
    { wait: true },
  );
  const listed = (await f.list(["--batch", batch.batchId])).document.data as ListedRun[];
  expect(listed).toHaveLength(1);
  expect(listed[0]?.batchId).toBe(batch.batchId);
  expect(listed.map((item) => item.id)).not.toContain(f.passed.runId);
  expect(await f.ids(["--batch", "bat_unknown"])).toEqual([]);
});

it("run list --status returns only the runs with that status", async () => {
  const f = await listFixture();
  expect(await f.ids(["--status", "failed"])).toEqual([f.failed.runId]);
  expect((await f.ids(["--status", "passed"])).sort()).toEqual(
    [f.passed.runId, f.inSecond.runId].sort(),
  );
});

it("run list --since keeps the runs created at or after the timestamp", async () => {
  const f = await listFixture();
  const after = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
  expect(await f.ids(["--since", after])).toEqual([]);
  const [newest] = (await f.list()).document.data as ListedRun[];
  if (!newest) throw new Error("The fixture has runs");
  expect(newest.createdAt).toMatch(/\.\d{3}Z$/);
  const sameSecond = await f.ids(["--since", newest.createdAt.replace(/\.\d+Z$/, "Z")]);
  expect(sameSecond).toContain(newest.id);
});

it.each([
  ["--since", "yesterday", "--since must be a UTC timestamp"],
  ["--since", "2030-01-01", "--since must be a UTC timestamp"],
  ["--since", "2030-01-01T00:00:00+02:00", "--since must be a UTC timestamp"],
  ["--since", "2030-13-45T00:00:00Z", "--since must be a UTC timestamp"],
  ["--test", "", "--test must not be empty"],
  ["--batch", "", "--batch must not be empty"],
  ["--status", "", "--status must not be empty"],
  ["--project", "", "--project must not be empty"],
])("run list %s %j exits 5 with INVALID_ARGUMENT", async (flag, value, reason) => {
  const f = await listFixture();
  const result = await f.list([flag, value]);
  expect(result.exit).toBe(5);
  expect(result.document.error).toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(result.document.error?.message).toContain(reason);
});

it("run list filters by project only when --project is given", async () => {
  const f = await listFixture();
  expect(await f.ids(["--project", "prj_unknown"])).toEqual([]);
  expect(await f.ids(["--project", f.second.id])).toEqual([f.inSecond.runId]);
  expect((await f.ids()).sort()).toEqual([f.passed.runId, f.failed.runId, f.inSecond.runId].sort());
  // TESTMASTER_PROJECT_ID is the same explicit choice as the flag.
  vi.stubEnv("TESTMASTER_PROJECT_ID", f.second.id);
  expect(await f.ids()).toEqual([f.inSecond.runId]);
  // An empty variable is unset, as an empty shell variable usually is.
  vi.stubEnv("TESTMASTER_PROJECT_ID", "");
  expect((await f.ids()).sort()).toEqual([f.passed.runId, f.failed.runId, f.inSecond.runId].sort());
});

it("run list without --limit and --cursor prints the bare array of every run, newest first", async () => {
  const f = await listFixture();
  const data = (await f.list()).document.data as ListedRun[];
  expect(Array.isArray(data)).toBe(true);
  expect(data).toHaveLength(3);
  expect(data.every((item) => typeof item.id === "string")).toBe(true);
  expect(data.map((item) => item.id)).toEqual([f.inSecond.runId, f.failed.runId, f.passed.runId]);
});

it("run list --limit pages with the total and a cursor, and a walk returns every run once", async () => {
  const f = await listFixture();
  for (let index = 0; index < 2; index++) await f.seed(0);
  const unpaged = await f.ids();
  expect(unpaged).toHaveLength(5);
  const first = (await f.list(["--limit", "2"])).document.data as RunsPage;
  expect(first).toMatchObject({ total: 5, returned: 2 });
  expect(first.nextCursor).not.toBeNull();

  const walked: string[] = [];
  let cursor: string | null = null;
  do {
    const page = (await f.list(["--limit", "2", ...(cursor ? ["--cursor", cursor] : [])])).document
      .data as RunsPage;
    walked.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(cursor).toBeNull();
  expect(walked).toEqual(unpaged);
});

it("run list refuses a cursor issued for other filters", async () => {
  const f = await listFixture();
  const issued = (await f.list(["--status", "passed", "--limit", "1"])).document.data as RunsPage;
  const cursor = String(issued.nextCursor);
  expect(cursor).not.toBe("null");
  const otherFilter = await f.list(["--status", "failed", "--cursor", cursor]);
  expect(otherFilter.exit).toBe(5);
  expect(otherFilter.document.error?.code).toBe("INVALID_ARGUMENT");
  const noFilter = await f.list(["--cursor", cursor]);
  expect(noFilter.exit).toBe(5);
  expect(noFilter.document.error?.code).toBe("INVALID_ARGUMENT");
  // Positive control: the same filter accepts it.
  const same = await f.list(["--status", "passed", "--cursor", cursor]);
  expect(same.exit).toBe(0);
});
