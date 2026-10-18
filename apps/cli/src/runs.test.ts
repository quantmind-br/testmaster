import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { Application, SignedCursorCodec, scaffoldPlan } from "@testmaster/application";
import { exitCodeForRun } from "@testmaster/domain";
import { ExecutionRepository, OutboxRepository } from "@testmaster/persistence";
import { afterEach, expect, it } from "vitest";
import { seedRun } from "../../../packages/application/src/run-seed.testing.js";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

const cleanups: (() => Promise<void>)[] = [];
const originalExit = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExit;
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
  const seed = (steps: number, options: { complete?: boolean } = {}) =>
    seedRun(app, {
      testId: test.id,
      environmentId: init.environmentId,
      ...(options.complete === undefined ? {} : { complete: options.complete }),
      attempts: [
        {
          outcome: "passed",
          steps: Array.from({ length: steps }, (_, index) => ({
            stepId: `step-${String(index).padStart(3, "0")}`,
            status: "passed" as const,
          })),
        },
      ],
    });
  return { app, invoke, seed };
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
