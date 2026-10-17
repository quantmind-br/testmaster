import { readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExecutablePlan,
  type PlanStep,
  type RunnerEvent,
  validatePlanSemantics,
  validateRunnerWireEvent,
} from "@testmaster/contracts";
import { expect, it } from "vitest";
import type { ProtocolClient } from "./protocol.js";
import { type RunnerInput, Runtime } from "./runtime.js";
import { runTerminal } from "./terminal.js";

const ATTEMPT = "att_01900000-0000-7000-8000-000000000002";
const NODE = process.execPath;
const lit = (value: unknown) => ({ literal: value });
const node = (script: string) => ({ program: { path: NODE }, args: [lit("-e"), lit(script)] });
const action = (id: string, operation: string, input: unknown, timeoutMs?: number): PlanStep =>
  ({
    id,
    kind: "action",
    operation,
    description: id,
    input,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }) as PlanStep;
const check = (id: string, input: unknown, expectation: unknown, timeoutMs?: number): PlanStep =>
  ({
    id,
    kind: "assertion",
    operation: "assert",
    description: id,
    input,
    expectation,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }) as PlanStep;
const contains = (text: string) => ({ predicate: "textContains", value: lit(text) });
const exitIs = (...values: number[]) => ({ predicate: "exitCodeIn", values });
const launch = (id: string, script: string, cols = 80, rows = 24) =>
  action(id, "launch", { ...node(script), cols, rows });

async function execute(
  steps: PlanStep[],
  extra: Partial<RunnerInput> = {},
  cancelAfterMs?: number,
) {
  // A plan needs one required assertion; scenarios that only drive a program get a trivial one.
  const guarded = steps.some((step) => step.kind === "assertion")
    ? steps
    : [
        ...steps,
        check(
          "zz-sentinel",
          { file: { root: "workdir", path: ".absent" } },
          { predicate: "fileAbsent" },
        ),
      ];
  const plan = {
    schemaVersion: "1.0.0",
    kind: "executable",
    name: "terminal",
    type: "cli",
    runner: "terminal",
    requirementRefs: [],
    steps: guarded,
    dependsOn: Object.keys(extra.variables ?? {}).map((name) => ({
      producerTestId: "tst_01900000-0000-7000-8000-000000000001",
      outputName: name,
      consumerInput: name,
      type: "string",
      required: true,
      sensitive: true,
      maximumAge: 1000,
      permittedEnvironment: "env_01900000-0000-7000-8000-000000000001",
    })),
  } as ExecutablePlan;
  validatePlanSemantics(plan);
  const events: RunnerEvent[] = [];
  const artifacts = new Map<string, { kind: string; text: string }>();
  const controller = new AbortController();
  const protocol = {
    controller,
    emit: async (type: string, payload: unknown) => {
      events.push(
        validateRunnerWireEvent({
          protocolVersion: "1.0.0",
          seq: events.length,
          attemptId: ATTEMPT,
          occurredAt: new Date().toISOString(),
          type,
          payload,
        }),
      );
    },
    artifact: async (path: string, kind: string, _mime: string, bytes: Uint8Array) => {
      artifacts.set(path, { kind, text: Buffer.from(bytes).toString("utf8") });
    },
    secret: async () => "canary-secret",
  } as unknown as ProtocolClient;
  const runtime = new Runtime(
    {
      attemptId: ATTEMPT,
      nonce: "n".repeat(32),
      baseUrl: "http://127.0.0.1:1",
      networkPolicy: { allowedOrigins: [], networkProfile: "local-loopback" },
      secrets: [],
      plan,
      ...extra,
    },
    protocol,
    controller.signal,
  );
  if (cancelAfterMs !== undefined) setTimeout(() => controller.abort(), cancelAfterMs);
  const result = await runTerminal(runtime, { sweep: "marked" });
  const finished = (id: string) => {
    const event = events.find(
      (candidate) =>
        candidate.type === "step.finished" &&
        (candidate.payload as { stepId: string }).stepId === id,
    );
    return event?.payload as {
      status: string;
      reasonCode?: string;
      error?: { code: string; message: string };
      evidencePaths: string[];
    };
  };
  const cited = new Set(guarded.flatMap((step) => finished(step.id)?.evidencePaths ?? []));
  return { result, events, artifacts, finished, cited };
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** A program whose key presses are echoed as JSON, on the alternate screen with DECCKM on. */
// Keys sent back to back can reach a busy program in one read ("\r\x11"), so Ctrl+Q is looked
// for anywhere in the chunk, not only as its first byte.
const keyEcho = `
process.stdin.setRawMode(true); process.stdin.resume();
process.stdout.write("\\x1b[?1049h\\x1b[?1hREADY");
process.stdin.on("data", (data) => {
  process.stdout.write("\\r\\nKEY:" + JSON.stringify(data.toString()));
  if (data.includes(0x11)) process.exit(7);
});`;

it("reports exit code, stdout and stderr separately and feeds stdin", async () => {
  const { result, finished } = await execute([
    action("echo", "run", {
      ...node(
        `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write("out:"+s);process.stderr.write("err!");process.exit(3)})`,
      ),
      stdin: lit("typed"),
    }),
    check("code", { processStepId: "echo" }, exitIs(3)),
    check(
      "out",
      { processStepId: "echo", stream: "stdout" },
      { predicate: "textEquals", value: lit("out:typed") },
    ),
    check(
      "err",
      { processStepId: "echo", stream: "stderr" },
      { predicate: "textEquals", value: lit("err!") },
    ),
    check(
      "not-in-out",
      { processStepId: "echo", stream: "stdout" },
      { predicate: "textNotContains", value: lit("err!") },
    ),
  ]);
  expect(result).toEqual({ outcome: "passed", reasonCode: "assertions_satisfied" });
  expect(finished("code").status).toBe("passed");
});

it("fails a wrong exit code with assertion_mismatch and the observed code", async () => {
  const { result, finished } = await execute([
    action("go", "run", node("process.exit(2)")),
    check("code", { processStepId: "go" }, exitIs(0)),
  ]);
  expect(result).toEqual({ outcome: "failed", reasonCode: "assertion_mismatch" });
  expect(finished("code").error?.message).toContain("last observation: 2");
});

it("cites the output of the process a failing assertion read, not only the step that wrote it", async () => {
  const { result, finished, artifacts } = await execute([
    action("go", "run", node(`process.stdout.write("actual-output")`)),
    check(
      "out",
      { processStepId: "go", stream: "stdout" },
      { predicate: "textEquals", value: lit("expected-output") },
    ),
  ]);
  expect(result).toEqual({ outcome: "failed", reasonCode: "assertion_mismatch" });
  expect(finished("out").evidencePaths).toEqual(
    expect.arrayContaining(["terminal/go.json", "terminal/go.stdout.txt"]),
  );
  for (const path of finished("out").evidencePaths) expect(artifacts.has(path)).toBe(true);
});

it("cites nothing extra for a passing assertion on a process", async () => {
  const { result, finished } = await execute([
    action("go", "run", node(`process.stdout.write("fine")`)),
    check(
      "out",
      { processStepId: "go", stream: "stdout" },
      { predicate: "textEquals", value: lit("fine") },
    ),
  ]);
  expect(result).toEqual({ outcome: "passed", reasonCode: "assertions_satisfied" });
  expect(finished("go").evidencePaths).toEqual(
    expect.arrayContaining(["terminal/go.json", "terminal/go.stdout.txt"]),
  );
  expect(finished("out").evidencePaths).toEqual([]);
});

it("cites only artifacts that exist when the process wrote no stderr", async () => {
  const { finished, artifacts } = await execute([
    action("go", "run", node(`process.stdout.write("x")`)),
    check("code", { processStepId: "go" }, exitIs(1)),
  ]);
  const cited = finished("code").evidencePaths;
  expect(cited).toContain("terminal/go.json");
  expect(cited).not.toContain("terminal/go.stderr.txt");
  for (const path of cited) expect(artifacts.has(path)).toBe(true);
});

it("captures a JSON field of stdout as a variable and keeps it out of evidence when sensitive", async () => {
  const { result, events, artifacts } = await execute([
    action("login", "run", {
      ...node(`console.log(JSON.stringify({token:"tok-9f8e7d6c5b4a"}))`),
      capture: [
        {
          name: "token",
          from: "stdout",
          jsonPointer: "/token",
          valueType: "string",
          sensitive: true,
        },
      ],
    }),
    check("exit", { processStepId: "login" }, exitIs(0)),
  ]);
  expect(result.outcome).toBe("passed");
  expect(events.some((event) => event.type === "variable.captured")).toBe(true);
  for (const [path, artifact] of artifacts)
    expect(artifact.text, path).not.toContain("tok-9f8e7d6c5b4a");
});

it("kills the whole process tree when a run exceeds its time and reports assertion_timeout", async () => {
  const { result, artifacts, finished } = await execute([
    action(
      "hang",
      "run",
      node(`
        const child = require("node:child_process").spawn("sleep", ["60"], { stdio: "ignore" });
        process.stdout.write(String(child.pid) + "\\n"); setTimeout(() => {}, 60000);`),
      400,
    ),
  ]);
  expect(result).toEqual({ outcome: "failed", reasonCode: "assertion_timeout" });
  expect(finished("hang").status).toBe("failed");
  const pid = Number(artifacts.get("terminal/hang.stdout.txt")?.text.trim());
  expect(pid).toBeGreaterThan(1);
  expect(alive(pid)).toBe(false);
});

it("blocks a program that cannot be started instead of failing the assertion", async () => {
  const missing = await execute([
    action("nope", "run", { program: { path: join(tmpdir(), "testmaster-no-such-program") } }),
    check("code", { processStepId: "nope" }, exitIs(0)),
  ]);
  expect(missing.result).toEqual({ outcome: "blocked", reasonCode: "unsupported_capability" });
  expect(missing.finished("nope").error?.code).toBe("ENOENT");
  const plain = join(tmpdir(), `testmaster-not-executable-${process.pid}`);
  await writeFile(plain, "just text", { mode: 0o755 });
  const noexec = await execute([
    action("text", "run", { program: { path: plain } }),
    check("code", { processStepId: "text" }, exitIs(0)),
  ]);
  expect(noexec.finished("text").error?.code).toBe("ENOEXEC");
});

it("encodes cursor keys by the DECCKM mode the program set and shows the alternate screen", async () => {
  const { result, artifacts } = await execute([
    launch("tui", keyEcho),
    action("ready", "waitForText", { text: lit("READY"), deadlineMs: 5000 }),
    action("up", "sendKeys", { keys: ["Up"] }),
    action("seen", "waitForText", { text: lit('KEY:"\\u001bOA"'), deadlineMs: 5000 }),
    action("enter", "sendKeys", { keys: ["Enter", "Ctrl+Q"] }),
    action("exit", "waitForExit", { deadlineMs: 5000 }),
    check("code", { processStepId: "tui" }, exitIs(7)),
    check("clean", { processStepId: "tui" }, { predicate: "noLingeringProcesses" }),
  ]);
  expect(result).toEqual({ outcome: "passed", reasonCode: "assertions_satisfied" });
  expect(artifacts.get("terminal/steps/seen-screen.txt")?.text).toContain("buffer=alternate");
  expect(artifacts.get("terminal/tui.cast")?.text.split("\n")[0]).toContain('"version":2');
});

it("resizes the PTY and the emulator together", async () => {
  const { result, artifacts } = await execute([
    launch(
      "tui",
      `const show = () => process.stdout.write("SIZE " + process.stdout.columns + "x" + process.stdout.rows + "\\r\\n");
       show(); process.stdout.on("resize", show); setTimeout(() => {}, 30000);`,
      100,
      30,
    ),
    action("first", "waitForText", { text: lit("SIZE 100x30"), deadlineMs: 5000 }),
    action("shrink", "resize", { cols: 40, rows: 12 }),
    action("second", "waitForText", { text: lit("SIZE 40x12"), deadlineMs: 5000 }),
    action("stop", "signal", { signal: "SIGTERM" }),
    action("gone", "waitForExit", { deadlineMs: 5000 }),
  ]);
  expect(result.outcome).toBe("passed");
  expect(artifacts.get("terminal/steps/shrink-screen.txt")?.text).toMatch(/^# cols=40 rows=12 /u);
  expect(artifacts.get("terminal/tui.cast")?.text).toContain('"40x12"');
});

it("shows only the visible columns of an alternate screen after it is narrowed", async () => {
  const { result } = await execute([
    launch(
      "tui",
      `process.stdout.write("\\x1b[?1049h\\x1b[H" + "L".repeat(90)); setTimeout(() => {}, 30000);`,
      100,
      30,
    ),
    action("full", "waitForText", { text: lit("L".repeat(90)), deadlineMs: 5000 }),
    action("narrow", "resize", { cols: 40, rows: 12 }),
    check(
      "clipped",
      { screen: { row: 0 } },
      { predicate: "textEquals", value: lit("L".repeat(40)) },
    ),
    check(
      "no-overflow",
      { screen: {} },
      { predicate: "textNotContains", value: lit("L".repeat(41)) },
    ),
    action("stop", "signal", { signal: "SIGKILL" }),
  ]);
  expect(result).toEqual({ outcome: "passed", reasonCode: "assertions_satisfied" });
});

it("captures OSC 52 in the emulator without drawing it", async () => {
  const payload = Buffer.from("copied text").toString("base64");
  const { result, artifacts } = await execute([
    launch(
      "tui",
      `process.stdout.write("\\x1b]52;c;${payload}\\x07DONE"); setTimeout(() => {}, 30000);`,
    ),
    action("done", "waitForText", { text: lit("DONE"), deadlineMs: 5000 }),
    check("clip", { clipboard: "osc52" }, { predicate: "textEquals", value: lit("copied text") }),
    check("not-drawn", { screen: {} }, { predicate: "textNotContains", value: lit("copied text") }),
    action("stop", "signal", { signal: "SIGKILL" }),
  ]);
  expect(result).toEqual({ outcome: "passed", reasonCode: "assertions_satisfied" });
  expect(artifacts.get("terminal/tui.json")?.text).toContain("osc52");
});

it("counts and kills a process that outlives the program, and passes when nothing does", async () => {
  const leak = `
    const child = require("node:child_process").spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    child.unref(); console.log(child.pid);`;
  const bad = await execute([
    action("leaky", "run", node(leak)),
    check("clean", { processStepId: "leaky" }, { predicate: "noLingeringProcesses" }),
  ]);
  expect(bad.result).toEqual({ outcome: "failed", reasonCode: "assertion_mismatch" });
  expect(bad.finished("clean").error?.message).toContain("last observation: 1");
  const pid = Number(bad.artifacts.get("terminal/leaky.stdout.txt")?.text.trim());
  expect(alive(pid)).toBe(false);
  const good = await execute([
    action("tidy", "run", node(`console.log("fine")`)),
    check("clean", { processStepId: "tidy" }, { predicate: "noLingeringProcesses" }),
  ]);
  expect(good.result.outcome).toBe("passed");
});

it("redacts a secret typed into the session from the recording and the evidence", async () => {
  const { result, artifacts } = await execute(
    [
      launch(
        "tui",
        `process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write("READY");
         process.stdin.on("data", (data) => process.stdout.write("GOT:" + data));`,
      ),
      action("ready", "waitForText", { text: lit("READY"), deadlineMs: 5000 }),
      action("type", "sendText", { text: { variableRef: "pw" } }),
      action("echoed", "waitForText", { text: lit("GOT:"), deadlineMs: 5000 }),
      action("stop", "signal", { signal: "SIGKILL" }),
    ],
    { variables: { pw: { value: "hunter2-secret-value", sensitive: true } } },
  );
  expect(result.outcome).toBe("passed");
  for (const [path, artifact] of artifacts)
    expect(artifact.text, path).not.toContain("hunter2-secret-value");
  expect(artifacts.get("terminal/tui.cast")?.text).toContain("GOT:");
});

it("redacts a secret copied with OSC 52 from the recording, where it travels as base64", async () => {
  const { result, artifacts } = await execute(
    [
      launch(
        "tui",
        `process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write("READY");
         process.stdin.on("data", (data) => process.stdout.write("\\x1b]52;c;" + Buffer.from("copy:" + data).toString("base64") + "\\x07DONE"));`,
      ),
      action("ready", "waitForText", { text: lit("READY"), deadlineMs: 5000 }),
      action("type", "sendText", { text: { variableRef: "pw" } }),
      action("copied", "waitForText", { text: lit("DONE"), deadlineMs: 5000 }),
      action("stop", "signal", { signal: "SIGKILL" }),
    ],
    { variables: { pw: { value: "hunter2-secret-value", sensitive: true } } },
  );
  expect(result.outcome).toBe("passed");
  const encoded = Buffer.from("copy:hunter2-secret-value").toString("base64");
  const prefix = encoded.slice(0, 16);
  for (const [path, artifact] of artifacts) {
    expect(artifact.text, path).not.toContain("hunter2-secret-value");
    expect(artifact.text, path).not.toContain(prefix);
  }
  expect(artifacts.get("terminal/tui.cast")?.text).toContain("]52;c;");
});

it("keeps polling a live assertion until the deadline and reports the last observation", async () => {
  const { result, finished } = await execute([
    launch("tui", `process.stdout.write("steady"); setTimeout(() => {}, 30000);`),
    action("ready", "waitForText", { text: lit("steady"), deadlineMs: 5000 }),
    check("never", { screen: {} }, contains("absent-text"), 300),
  ]);
  expect(result).toEqual({ outcome: "failed", reasonCode: "assertion_timeout" });
  expect(finished("never").error?.message).toContain("last observation: steady");
});

it("attaches the process and cast of a session nobody waited on to the failing step", async () => {
  const { result, artifacts, finished, cited } = await execute([
    launch("tui", `process.stdout.write("steady"); setTimeout(() => {}, 30000);`),
    action("ready", "waitForText", { text: lit("steady"), deadlineMs: 5000 }),
    check("never", { screen: {} }, contains("absent-text"), 300),
  ]);
  expect(result).toEqual({ outcome: "failed", reasonCode: "assertion_timeout" });
  expect(finished("never").evidencePaths).toEqual(
    expect.arrayContaining(["terminal/tui.json", "terminal/tui.cast"]),
  );
  for (const path of artifacts.keys()) expect(cited.has(path)).toBe(true);
});

it("attaches the process and cast of a session nobody waited on to the last step when all pass", async () => {
  const { result, artifacts, finished, cited } = await execute([
    launch("tui", `process.stdout.write("steady"); setTimeout(() => {}, 30000);`),
    check("seen", { screen: {} }, contains("steady"), 5000),
  ]);
  expect(result).toEqual({ outcome: "passed", reasonCode: "assertions_satisfied" });
  expect(finished("seen").evidencePaths).toEqual(
    expect.arrayContaining(["terminal/tui.json", "terminal/tui.cast"]),
  );
  for (const path of artifacts.keys()) expect(cited.has(path)).toBe(true);
});

it("fails at once when the session already ended instead of waiting for the deadline", async () => {
  const started = performance.now();
  const { result, finished } = await execute([
    launch("tui", `process.stdout.write("bye"); process.exit(0);`),
    action("gone", "waitForExit", { deadlineMs: 5000 }),
    check("late", { screen: {} }, contains("hello"), 20000),
  ]);
  expect(result).toEqual({ outcome: "failed", reasonCode: "assertion_mismatch" });
  expect(finished("late").error?.message).toContain("last observation: bye");
  expect(performance.now() - started).toBeLessThan(15000);
});

it("refuses to interact with a session that already ended", async () => {
  const { result, finished } = await execute([
    launch("tui", `process.exit(0);`),
    action("gone", "waitForExit", { deadlineMs: 5000 }),
    action("late", "sendKeys", { keys: ["Enter"] }),
  ]);
  expect(result).toEqual({ outcome: "failed", reasonCode: "assertion_mismatch" });
  expect(finished("late").status).toBe("failed");
});

it("refuses a second live session", async () => {
  const { result, finished } = await execute([
    launch("one", `setTimeout(() => {}, 30000);`),
    launch("two", `setTimeout(() => {}, 30000);`),
  ]);
  expect(result.outcome).toBe("blocked");
  expect(finished("two").reasonCode).toBe("unsupported_capability");
});

it("writes files into the workdir and the home and asserts on them, never outside", async () => {
  const { result, finished } = await execute([
    action("cfg", "writeFile", {
      root: "home",
      path: ".config/app/config.json",
      content: lit('{"theme":"dark"}'),
    }),
    action(
      "show",
      "run",
      node(
        `console.log(require("node:fs").readFileSync(process.env.HOME + "/.config/app/config.json", "utf8"))`,
      ),
    ),
    check(
      "seen",
      { processStepId: "show", stream: "stdout" },
      { predicate: "textContains", value: lit("dark") },
    ),
    check(
      "theme",
      { file: { root: "home", path: ".config/app/config.json" }, jsonPointer: "/theme" },
      { predicate: "jsonEquals", value: lit("dark") },
    ),
    check(
      "exists",
      { file: { root: "home", path: ".config/app/config.json" } },
      { predicate: "fileExists" },
    ),
    check(
      "absent",
      { file: { root: "workdir", path: "nothing.txt" } },
      { predicate: "fileAbsent" },
    ),
    action("escape", "writeFile", { root: "workdir", path: "../escape.txt", content: lit("x") }),
  ]);
  expect(finished("theme").status).toBe("passed");
  expect(result).toEqual({ outcome: "blocked", reasonCode: "security_precondition_failed" });
  expect(finished("escape").status).toBe("blocked");
});

it("runs a program from a fixture with its fixture name as argv[0]", async () => {
  const dir = join(tmpdir(), `testmaster-fixture-${process.pid}`);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "hello-tool");
  await writeFile(path, `#!${NODE}\nconsole.log("argv0=" + process.argv0)\n`, { mode: 0o555 });
  const art = "art_01900000-0000-7000-8000-000000000009";
  const { result, artifacts } = await execute(
    [
      action("tool", "run", { program: { artifactRef: art } }),
      check("exit", { processStepId: "tool" }, exitIs(0)),
    ],
    {
      artifacts: {
        [art]: { path, mimeType: "application/octet-stream", sizeBytes: 60, name: "hello-tool" },
      },
    },
  );
  expect(result.outcome).toBe("passed");
  const metadata = JSON.parse(artifacts.get("terminal/tool.json")?.text ?? "{}");
  expect(metadata.program).toMatchObject({ source: "artifact", name: "hello-tool" });
  expect(metadata.program.sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(await readdir(dir)).toContain("hello-tool");
});

it("kills the process tree on cancellation", async () => {
  const { result, artifacts } = await execute(
    [
      action(
        "long",
        "run",
        node(`
        const child = require("node:child_process").spawn("sleep", ["60"], { stdio: "ignore" });
        process.stdout.write(String(child.pid) + "\\n"); setTimeout(() => {}, 60000);`),
        60000,
      ),
    ],
    {},
    600,
  );
  expect(result.outcome).toBe("cancelled");
  const pid = Number(artifacts.get("terminal/long.stdout.txt")?.text.trim());
  if (pid) expect(alive(pid)).toBe(false);
});
