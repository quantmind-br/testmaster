import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { Application, scaffoldPlan } from "@testmaster/application";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

const cleanups: (() => Promise<void>)[] = [];
const originalExit = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExit;
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-cli-lists-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const app = await Application.open({ cwd, home, env: {} });
  cleanups.push(async () => {
    app.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const init = await app.init();
  vi.spyOn(Application.prototype, "preflight").mockResolvedValue();
  vi.spyOn(Object.getPrototypeOf(app.worker), "live").mockReturnValue(true);
  const second = app.projects.create({ name: "Second project" });
  const staging = app.environments.create({
    projectId: second.id,
    name: "staging",
    baseUrl: "http://127.0.0.1:4102",
  });
  for (const [projectId, name] of [
    [init.projectId, "a-one"],
    [init.projectId, "a-two"],
    [second.id, "b-one"],
  ] as const)
    app.tests.create({ projectId, plan: scaffoldPlan("backend"), name });
  const invoke = async (args: string[], onRuntime?: (runtime: Runtime) => void) => {
    let stdout = "";
    const output = new Writable({
      write(chunk, _encoding, done) {
        stdout += String(chunk);
        done();
      },
    });
    const runtime = new Runtime(output, output);
    runtime.app = async () => app;
    onRuntime?.(runtime);
    process.exitCode = 0;
    await runCli(["--json", "--cwd", cwd, ...args], runtime);
    return {
      exit: process.exitCode ?? 0,
      document: JSON.parse(stdout) as {
        data?: Record<string, unknown> & unknown[];
        error?: { code: string; details?: Record<string, unknown> };
        warnings?: string[];
      },
    };
  };
  const bindings = [
    "--binding",
    `${init.projectId}:${init.environmentId}`,
    "--binding",
    `${second.id}:${staging.id}`,
  ];
  return { app, cwd, init, second, staging, invoke, bindings };
}

it("REQ-034 UX-041 suite commands create, inspect, edit, expand and archive a cross-project list", async () => {
  const f = await fixture();
  const created = await f.invoke(["suite", "create", "--name", "nightly", ...f.bindings]);
  expect(created.exit).toBe(0);
  const suite = created.document.data as unknown as { id: string; version: number };
  expect(suite).toMatchObject({ version: 1, selection: { kind: "dynamic" } });
  const listed = await f.invoke(["suite", "list"]);
  expect((listed.document.data as unknown as { id: string }[]).map((item) => item.id)).toEqual([
    suite.id,
  ]);
  const expansion = await f.invoke(["suite", "expand", suite.id]);
  expect(expansion.document.data).toMatchObject({ dispatchable: true });
  expect((expansion.document.data as { members: unknown[] }).members).toHaveLength(3);
  // Remove one project, then add it back with a tag filter; each edit needs the current version.
  const removed = await f.invoke([
    "suite",
    "remove",
    suite.id,
    "--from-project",
    f.second.id,
    "--expected-version",
    "1",
  ]);
  expect(removed.exit).toBe(0);
  expect(removed.document.data).toMatchObject({ version: 2 });
  const added = await f.invoke([
    "suite",
    "add",
    suite.id,
    "--binding",
    `${f.second.id}:${f.staging.id}`,
    "--expected-version",
    "2",
  ]);
  expect(
    (added.document.data as unknown as { selection: { projects: unknown[] } }).selection.projects,
  ).toHaveLength(2);
  // Negative controls: a stale version, a fixed-list flag on a dynamic list and an unknown entry fail.
  const stale = await f.invoke([
    "suite",
    "update",
    suite.id,
    "--name",
    "x",
    "--expected-version",
    "1",
  ]);
  expect(stale.exit).not.toBe(0);
  expect(stale.document.error?.code).toBe("REVISION_CONFLICT");
  const wrongKind = await f.invoke([
    "suite",
    "add",
    suite.id,
    "--member",
    "tst_00000000-0000-4000-8000-000000000000:rev_00000000-0000-4000-8000-000000000000:env_00000000-0000-4000-8000-000000000000",
    "--expected-version",
    "3",
  ]);
  expect(wrongKind.document.error?.code).toBe("INVALID_ARGUMENT");
  const unknown = await f.invoke([
    "suite",
    "remove",
    suite.id,
    "--from-project",
    "prj_00000000-0000-4000-8000-000000000000",
    "--expected-version",
    "3",
  ]);
  expect(unknown.document.error?.code).toBe("NOT_FOUND");
  const archived = await f.invoke(["suite", "archive", suite.id, "--expected-version", "3"]);
  expect(archived.document.data).toMatchObject({ state: "archived" });
});

it("REQ-034 suite create validates its selection before touching state, also in dry-run", async () => {
  const f = await fixture();
  const none = await f.invoke(["suite", "create", "--name", "empty"]);
  expect(none.document.error?.code).toBe("INVALID_ARGUMENT");
  const mixed = await f.invoke([
    "suite",
    "create",
    "--name",
    "mixed",
    ...f.bindings,
    "--member",
    "a:b:c",
  ]);
  expect(mixed.document.error?.code).toBe("INVALID_ARGUMENT");
  const malformed = await f.invoke(["suite", "create", "--name", "bad", "--binding", "only-one"]);
  expect(malformed.document.error?.code).toBe("INVALID_ARGUMENT");
  await writeFile(join(f.cwd, "selection.json"), '{"kind":"dynamic","projects":[]}');
  const empty = await f.invoke([
    "suite",
    "create",
    "--name",
    "file",
    "--selection-file",
    "selection.json",
  ]);
  expect(empty.document.error?.code).toBe("INVALID_ARGUMENT");
  const dry = await f.invoke(["suite", "create", "--name", "dry", ...f.bindings, "--dry-run"]);
  expect(dry.exit).toBe(0);
  expect(f.app.suites.list()).toEqual([]);
  // Positive control: the same flags without --dry-run store the list.
  expect((await f.invoke(["suite", "create", "--name", "real", ...f.bindings])).exit).toBe(0);
  expect(f.app.suites.list()).toHaveLength(1);
});

it("REQ-034 UX-042 suite run admits one batch per idempotency key and refuses a partial list until its exclusions are confirmed", async () => {
  const f = await fixture();
  const suite = (await f.invoke(["suite", "create", "--name", "nightly", ...f.bindings])).document
    .data as unknown as { id: string };
  const key = "cli-suite-run-0123456789";
  const first = await f.invoke(["suite", "run", suite.id, "--idempotency-key", key]);
  expect(first.exit).toBe(0);
  expect(first.document.data).toMatchObject({ requested: 3, accepted: 3, notDispatched: [] });
  const replay = await f.invoke(["suite", "run", suite.id, "--idempotency-key", key]);
  expect((replay.document.data as { batchId: string }).batchId).toBe(
    (first.document.data as { batchId: string }).batchId,
  );
  expect(f.app.database.all("SELECT id FROM batches")).toHaveLength(1);
  // The second project's environment disappears: the list is partial and needs an explicit confirmation.
  const environment = f.app.environments.get(f.staging.id, f.second.id);
  f.app.environments.archive(f.staging.id, Number(environment.version));
  const denied = await f.invoke(["suite", "run", suite.id]);
  expect(denied.exit).not.toBe(0);
  expect(denied.document.error).toMatchObject({
    code: "PRECONDITION_FAILED",
    details: { nextActions: ["confirm_subset"] },
  });
  expect(f.app.database.all("SELECT id FROM batches")).toHaveLength(1);
  const confirmed = await f.invoke([
    "suite",
    "run",
    suite.id,
    "--confirm-exclusion",
    `project:${f.second.id}`,
  ]);
  expect(confirmed.exit).toBe(0);
  expect(confirmed.document.data).toMatchObject({ accepted: 2 });
  expect((confirmed.document.data as { notDispatched: unknown[] }).notDispatched).toHaveLength(1);
});

it("REQ-034 suite run without a live worker names --queue, the flag it accepts, never --wait", async () => {
  const f = await fixture();
  const suite = (await f.invoke(["suite", "create", "--name", "nightly", ...f.bindings])).document
    .data as unknown as { id: string };
  vi.spyOn(Object.getPrototypeOf(f.app.worker), "live").mockReturnValue(false);
  const refused = await f.invoke(["suite", "run", suite.id]);
  expect(refused.exit).not.toBe(0);
  expect(refused.document.error).toMatchObject({
    code: "PRECONDITION_FAILED",
    message: "No live worker; start a worker or use --wait or --queue",
    details: { nextActions: ["worker start", "--wait", "--queue"] },
  });
  expect(f.app.database.all("SELECT id FROM batches")).toHaveLength(0);
  const both = await f.invoke(["suite", "run", suite.id, "--wait", "--queue"]);
  expect(both.document.error?.code).toBe("INVALID_ARGUMENT");
  expect(f.app.database.all("SELECT id FROM batches")).toHaveLength(0);
  const queued = await f.invoke(["suite", "run", suite.id, "--queue"]);
  expect(queued.exit).toBe(0);
  expect(queued.document.data).toMatchObject({ requested: 3, accepted: 3 });
});

it("REQ-034 suite run --wait runs the batch in this process without a worker and returns the test run batch shape", async () => {
  const f = await fixture();
  const suite = (await f.invoke(["suite", "create", "--name", "nightly", ...f.bindings])).document
    .data as unknown as { id: string };
  vi.spyOn(Object.getPrototypeOf(f.app.worker), "live").mockReturnValue(false);
  // The members are cancelled when the in-process worker starts, so the real loop finalizes them
  // without a container; what is under test is who runs the batch and what comes back.
  const original = Object.getPrototypeOf(f.app.worker).run as (
    this: unknown,
    options: { runIds?: string[] },
  ) => Promise<unknown>;
  const workerRun = vi
    .spyOn(Object.getPrototypeOf(f.app.worker), "run")
    .mockImplementation(async function (this: unknown, options: { runIds?: string[] }) {
      for (const id of options.runIds ?? []) await f.app.runs.cancel(id);
      return original.call(this, options);
    } as never);
  const waited = await f.invoke(["suite", "run", suite.id, "--wait"]);
  expect(waited.document.error).toBeUndefined();
  const data = waited.document.data as unknown as {
    receipt: { batchId: string; memberRuns: { runId: string }[] };
    members: { runId: string; run: { phase: string; outcome: string } }[];
    batch: { id?: string; batchId?: string };
    healing: unknown[];
  };
  expect(data.receipt.memberRuns).toHaveLength(3);
  expect(data.members.map((member) => member.runId)).toEqual(
    data.receipt.memberRuns.map((member) => member.runId),
  );
  for (const member of data.members)
    expect(member.run).toMatchObject({ phase: "completed", outcome: "cancelled" });
  expect(data.healing).toEqual([]);
  expect(workerRun).toHaveBeenCalledWith(
    expect.objectContaining({
      ephemeral: true,
      runIds: data.receipt.memberRuns.map((member) => member.runId),
    }),
  );
  // The exit code is the batch result: cancelled members are not a pass.
  expect(waited.exit).not.toBe(0);
});

/** Replaces the in-process worker with `body`, which may hand over to the real loop. */
function spyWorker(
  app: Application,
  body: (
    options: { runIds?: string[]; signal?: AbortSignal },
    original: () => Promise<unknown>,
  ) => Promise<unknown>,
) {
  const prototype = Object.getPrototypeOf(app.worker);
  const original: (this: unknown, options: unknown) => Promise<unknown> = prototype.run;
  return vi.spyOn(prototype, "run").mockImplementation(async function (
    this: unknown,
    options: { runIds?: string[] },
  ) {
    return body(options, () => original.call(this, options));
  } as never);
}

it("suite run --wait --timeout never ends the batch it executes: the members finish and the limit only warns", async () => {
  const f = await fixture();
  const suite = (await f.invoke(["suite", "create", "--name", "nightly", ...f.bindings])).document
    .data as unknown as { id: string };
  vi.spyOn(Object.getPrototypeOf(f.app.worker), "live").mockReturnValue(false);
  const cancel = vi.spyOn(f.app.runs, "cancel");
  let cancelsBeforeWorkerEnded = -1;
  // The worker outlasts the 50 ms limit by far, then ends its members the way a run ends.
  spyWorker(f.app, async (options, original) => {
    await sleep(300);
    cancelsBeforeWorkerEnded = cancel.mock.calls.length;
    for (const id of options.runIds ?? []) await f.app.runs.cancel(id);
    return original();
  });
  const waited = await f.invoke(["suite", "run", suite.id, "--wait", "--timeout", "0.05"]);
  expect(waited.document.error).toBeUndefined();
  expect(cancelsBeforeWorkerEnded).toBe(0);
  const data = waited.document.data;
  const members: unknown[] = Array.isArray(data?.members) ? data.members : [];
  expect(members).toHaveLength(3);
  for (const member of members) {
    expect(member).not.toHaveProperty("error");
    expect(member).toMatchObject({ run: { phase: "completed" } });
  }
  expect(waited.exit).not.toBe(7);
  expect(waited.document.warnings).toContain(
    "--timeout and --request-timeout do not end a run this command executes: the wait continues until the run completes or the command is interrupted. The limit applies only to waits on worker-owned runs.",
  );
});

it("suite run --wait still cancels the members it executes when it is interrupted", async () => {
  const f = await fixture();
  const suite = (await f.invoke(["suite", "create", "--name", "nightly", ...f.bindings])).document
    .data as unknown as { id: string };
  vi.spyOn(Object.getPrototypeOf(f.app.worker), "live").mockReturnValue(false);
  // The worker runs until it is told to stop, like one waiting on a container.
  const memberIds: string[] = [];
  const workerRun = spyWorker(f.app, async (options, original) => {
    memberIds.push(...(options.runIds ?? []));
    const stopped = Promise.withResolvers<void>();
    options.signal?.addEventListener("abort", () => stopped.resolve());
    await stopped.promise;
    return original();
  });
  let runtime: Runtime | undefined;
  const pending = f.invoke(["suite", "run", suite.id, "--wait", "--timeout", "0.05"], (rt) => {
    runtime = rt;
  });
  await vi.waitFor(() => expect(workerRun).toHaveBeenCalled());
  await sleep(100);
  runtime?.interrupt("SIGINT");
  const interrupted = await pending;
  expect(interrupted.exit).toBe(130);
  expect(memberIds).toHaveLength(3);
  for (const id of memberIds) {
    expect(f.app.runs.get(id)).toMatchObject({ phase: "completed", outcome: "cancelled" });
    expect(f.app.runs.events(id).some((event) => event.type === "run.cancel_requested")).toBe(true);
  }
});

it("REQ-035 OPS-016 schedule commands preview, create, edit, pause, resume, list history and archive", async () => {
  const f = await fixture();
  const suite = f.app.suites.create({
    name: "nightly",
    selection: {
      kind: "dynamic",
      projects: [{ projectId: f.init.projectId, environmentId: f.init.environmentId }],
    },
  });
  const preview = await f.invoke([
    "schedule",
    "preview",
    "--cron",
    "0 9 * * 1-5",
    "--timezone",
    "America/Sao_Paulo",
  ]);
  expect(preview.document.data).toMatchObject({ timezone: "America/Sao_Paulo" });
  expect((preview.document.data as { occurrences: unknown[] }).occurrences).toHaveLength(10);
  const created = await f.invoke([
    "schedule",
    "create",
    "--name",
    "weekday-morning",
    "--suite",
    suite.id,
    "--cron",
    "0 9 * * 1-5",
    "--timezone",
    "America/Sao_Paulo",
    "--misfire",
    "catch_up",
    "--max-catch-up",
    "2",
    "--overlap",
    "forbid",
    "--auto-pause-after-failures",
    "7",
  ]);
  expect(created.exit).toBe(0);
  const schedule = created.document.data as unknown as { id: string; version: number };
  expect(created.document.data).toMatchObject({
    revision: 1,
    definition: {
      misfire: { policy: "catch_up", maxCatchUp: 2 },
      autoPauseAfterFailures: 7,
      trigger: { timezone: "America/Sao_Paulo" },
    },
  });
  const updated = await f.invoke([
    "schedule",
    "update",
    schedule.id,
    "--overlap",
    "allow",
    "--expected-version",
    "1",
  ]);
  expect(updated.document.data).toMatchObject({
    revision: 2,
    version: 2,
    definition: { overlap: "allow" },
  });
  const paused = await f.invoke(["schedule", "pause", schedule.id, "--expected-version", "2"]);
  expect(paused.document.data).toMatchObject({ state: "paused", pauseReason: "manual" });
  const resumed = await f.invoke(["schedule", "resume", schedule.id, "--expected-version", "3"]);
  expect(resumed.document.data).toMatchObject({ state: "active" });
  const revisions = await f.invoke(["schedule", "history", schedule.id, "--revisions"]);
  expect(revisions.document.data).toHaveLength(2);
  expect((await f.invoke(["schedule", "history", schedule.id])).document.data).toEqual([]);
  const archived = await f.invoke(["schedule", "archive", schedule.id, "--expected-version", "4"]);
  expect(archived.document.data).toMatchObject({ state: "archived" });
  expect((await f.invoke(["schedule", "list"])).document.data).toEqual([]);
});

it("REQ-035 OPS-016 schedule commands refuse an unknown timezone, a bad cron and a stale version without storing anything", async () => {
  const f = await fixture();
  const suite = f.app.suites.create({
    name: "nightly",
    selection: {
      kind: "dynamic",
      projects: [{ projectId: f.init.projectId, environmentId: f.init.environmentId }],
    },
  });
  const base = ["schedule", "create", "--name", "bad", "--suite", suite.id];
  const zone = await f.invoke([...base, "--cron", "0 9 * * *", "--timezone", "Mars/Olympus"]);
  expect(zone.exit).toBe(5);
  expect(zone.document.error?.code).toBe("INVALID_ARGUMENT");
  const cron = await f.invoke([...base, "--cron", "61 25 * * *"]);
  expect(cron.document.error?.code).toBe("INVALID_ARGUMENT");
  const noTrigger = await f.invoke(base);
  expect(noTrigger.document.error?.code).toBe("INVALID_ARGUMENT");
  const both = await f.invoke([...base, "--cron", "0 9 * * *", "--every-seconds", "3600"]);
  expect(both.document.error?.code).toBe("INVALID_ARGUMENT");
  const dry = await f.invoke([...base, "--cron", "61 25 * * *", "--dry-run"]);
  expect(dry.document.error?.code).toBe("INVALID_ARGUMENT");
  expect(f.app.schedules.list()).toEqual([]);
  // Positive control, then a stale version conflicts.
  const ok = await f.invoke([...base, "--name", "ok", "--cron", "0 9 * * *"]);
  expect(ok.exit).toBe(0);
  const id = (ok.document.data as unknown as { id: string }).id;
  const stale = await f.invoke(["schedule", "pause", id, "--expected-version", "9"]);
  expect(stale.document.error?.code).toBe("REVISION_CONFLICT");
});
