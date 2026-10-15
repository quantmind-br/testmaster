import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecutablePlan, validate } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { FileEvidenceStore } from "@testmaster/evidence";
import { expect, it } from "vitest";
import { AttemptExecutor } from "./executor.js";

const TOOL = "art_01900000-0000-7000-8000-0000000000aa";
const lit = (value: unknown) => ({ literal: value });
const node = (script: string) => ({
  program: { path: "/usr/bin/node" },
  args: [lit("-e"), lit(script)],
});
const action = (id: string, operation: string, input: unknown, timeoutMs?: number) => ({
  id,
  kind: "action",
  operation,
  description: id,
  input,
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
});
const check = (id: string, input: unknown, expectation: unknown) => ({
  id,
  kind: "assertion",
  operation: "assert",
  description: id,
  input,
  expectation,
});
const plan = (steps: unknown[]): ExecutablePlan =>
  validate<ExecutablePlan>("ExecutablePlan", {
    schemaVersion: "1.0.0",
    kind: "executable",
    name: "terminal",
    type: "cli",
    runner: "terminal",
    requirementRefs: [],
    steps,
  });

/** Runs a terminal plan in the real sandbox with a fixture program bind-mounted read-only. */
async function execute(steps: unknown[], options: { cancelOnStep?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tm-terminal-"));
  const runtime = join(root, "runtime");
  const inputDir = join(root, "input");
  await mkdir(runtime);
  await mkdir(inputDir, { mode: 0o755 });
  // A fixture program: executable straight from the read-only bind (the sandbox /tmp is noexec).
  await writeFile(
    join(inputDir, "tool"),
    '#!/usr/bin/node\nconsole.log("tool argv0=" + process.argv0);\n',
  );
  await chmod(join(inputDir, "tool"), 0o555);
  const lock = JSON.parse(
    await (await import("node:fs/promises")).readFile("containers/images.lock.json", "utf8"),
  );
  const controller = new AbortController();
  const attemptId = uuidV7IdGenerator.next("att");
  const executor = new AttemptExecutor(
    new FileEvidenceStore({ rootDir: join(root, "evidence") }),
    undefined,
    runtime,
  );
  try {
    const result = await executor.execute(
      {
        workspaceId: uuidV7IdGenerator.next("ws"),
        runId: uuidV7IdGenerator.next("run"),
        attemptId,
        revisionId: uuidV7IdGenerator.next("rev"),
        snapshotId: uuidV7IdGenerator.next("snp"),
        kind: "terminal",
        imageId: lock["testmaster-runner"].imageId,
        inputDir,
        plan: plan(steps),
        networkPolicy: {
          allowedOrigins: ["http://127.0.0.1:9"],
          networkProfile: "local-loopback",
          baseUrl: "http://127.0.0.1:9",
        },
        runnerInput: {
          baseUrl: "http://127.0.0.1:9",
          stepTimeoutMs: 8000,
          artifacts: {
            [TOOL]: {
              path: "/run/testmaster/input/tool",
              mimeType: "application/octet-stream",
              sizeBytes: 50,
              name: "tool",
            },
          },
        },
        seccompPath: join(process.cwd(), "containers/seccomp_profile.json"),
        attemptTimeoutMs: 40000,
        onEvent: async (event) => {
          if (
            options.cancelOnStep &&
            event.type === "step.started" &&
            event.payload.stepId === options.cancelOnStep
          )
            setTimeout(() => controller.abort(), 700);
        },
      },
      controller.signal,
    );
    const finished = (id: string) =>
      result.events.find((event) => event.type === "step.finished" && event.payload.stepId === id)
        ?.payload;
    return { result, finished, attemptId, root };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

it("runs a CLI fixture and a PTY session in the sandbox and leaves no process behind", async () => {
  const { result, finished, root } = await execute([
    action("tool", "run", { program: { artifactRef: TOOL } }),
    check(
      "tool-out",
      { processStepId: "tool", stream: "stdout" },
      { predicate: "textContains", value: lit("tool argv0=") },
    ),
    action("tui", "launch", {
      ...node(`process.stdin.setRawMode(true); process.stdin.resume();
          process.stdout.write("\\x1b[?1049hREADY " + process.stdout.columns + "x" + process.stdout.rows);
          process.stdin.on("data", (d) => { if (d[0] === 0x11) process.exit(0); });`),
      cols: 90,
      rows: 20,
    }),
    action("ready", "waitForText", { text: lit("READY 90x20"), deadlineMs: 8000 }),
    action("quit", "sendKeys", { keys: ["Ctrl+Q"] }),
    action("exited", "waitForExit", { deadlineMs: 8000 }),
    check("code", { processStepId: "tui" }, { predicate: "exitCodeIn", values: [0] }),
    check("clean", { processStepId: "tui" }, { predicate: "noLingeringProcesses" }),
  ]);
  try {
    expect(result.outcome, JSON.stringify(result.events.slice(-6))).toBe("passed");
    expect(result.facts?.networkMode).toBe("none");
    expect(finished("clean")?.status).toBe("passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 90000);

it("counts a process that outlives the program and still tears the sandbox down", async () => {
  const { result, finished, root } = await execute([
    action(
      "leaky",
      "run",
      node(
        `require("node:child_process").spawn("sleep", ["300"], { detached: true, stdio: "ignore" }).unref();`,
      ),
    ),
    check("clean", { processStepId: "leaky" }, { predicate: "noLingeringProcesses" }),
  ]);
  try {
    expect(result.outcome).toBe("failed");
    expect(finished("clean")?.reasonCode).toBe("assertion_mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 90000);

it("fails a hung program with assertion_timeout and does not need the container to be killed", async () => {
  const started = performance.now();
  const { result, finished, root } = await execute([
    action("hang", "run", node("setTimeout(() => {}, 600000)"), 1500),
    check("code", { processStepId: "hang" }, { predicate: "exitCodeIn", values: [0] }),
  ]);
  try {
    expect(result.outcome).toBe("failed");
    expect(finished("hang")?.reasonCode).toBe("assertion_timeout");
    expect(performance.now() - started).toBeLessThan(40000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 90000);

it("cancels a running program: the attempt ends promptly and its container is gone", async () => {
  const started = performance.now();
  const { result, attemptId, root } = await execute(
    [
      action("hang", "run", node("setTimeout(() => {}, 600000)"), 30000),
      check("code", { processStepId: "hang" }, { predicate: "exitCodeIn", values: [0] }),
    ],
    { cancelOnStep: "hang" },
  );
  try {
    // A requested stop with no failure proven before it is cancelled/user_cancelled, the same
    // verdict the worker then confirms (specs/03 §3, OPS-014); nothing may keep running either.
    expect(result.outcome).toBe("cancelled");
    expect(result.reasonCode).toBe("user_cancelled");
    expect(performance.now() - started).toBeLessThan(30000);
    const listing = spawnSync(
      "docker",
      ["ps", "-a", "--filter", `name=tm-att-${attemptId}`, "-q"],
      {
        encoding: "utf8",
      },
    );
    expect(listing.stdout.trim()).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
