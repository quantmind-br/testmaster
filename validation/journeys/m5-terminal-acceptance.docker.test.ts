import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExecutablePlan, JsonValue, PlanStep } from "@testmaster/contracts";
import { expect, it } from "vitest";
import {
  data,
  eventually,
  type Journey,
  type Json,
  journey,
  literal,
  object,
  root,
  text,
} from "./harness.js";

const exec = promisify(execFile);
const fixtureSource = join(root, "fixtures/reference-tui");
const metadata = {
  class: "deterministic-e2e" as const,
  runner: "real-docker" as const,
  externalDependency: "fixtures/reference-tui built with the host Go toolchain",
  limitations: [
    "Linux x64 runner image only; the Go fixture is a static binary built on the host.",
    "Automated oracle only; no model, healing, agent mode or code export is involved.",
  ],
};

/**
 * One planted defect: a source replacement in a throwaway copy of the fixture and the single
 * test it must fail. Every other test of the suite must still pass against that binary.
 */
const defects: { name: string; test: string; from: string; to: string }[] = [
  {
    name: "wrong-version",
    test: "cli-version",
    from: 'const version = "1.2.3"',
    to: 'const version = "1.2.4"',
  },
  {
    name: "warning-on-stdout",
    test: "cli-list",
    from: 'fmt.Fprintln(os.Stderr, "warning: the entry list is static")',
    to: 'fmt.Fprintln(os.Stdout, "warning: the entry list is static")',
  },
  {
    name: "init-wrong-file",
    test: "cli-init",
    from: '"project.json")',
    to: '"projekt.json")',
  },
  {
    name: "usage-exits-zero",
    test: "cli-usage",
    from: "const usageExit = 2",
    to: "const usageExit = 0",
  },
  {
    name: "down-key-ignored",
    test: "tui-nav",
    from: "s.at = min(s.at+1, len(entries)-1)",
    to: "s.at = min(s.at+0, len(entries)-1)",
  },
  {
    name: "clipboard-truncated",
    test: "tui-clipboard",
    from: "EncodeToString([]byte(entry))",
    to: "EncodeToString([]byte(entry[1:]))",
  },
  {
    name: "resize-ignored",
    test: "tui-resize",
    from: "signal.Notify(winch, syscall.SIGWINCH)",
    to: "signal.Notify(winch, syscall.SIGUSR2)",
  },
];

/** Builds the fixture (optionally with one planted defect) into a static Linux binary. */
async function build(scratch: string, defect?: (typeof defects)[number]): Promise<string> {
  const source = join(scratch, `src-${defect?.name ?? "healthy"}`);
  await cp(fixtureSource, source, { recursive: true });
  if (defect) {
    const path = join(source, "main.go");
    const code = await readFile(path, "utf8");
    expect(code.split(defect.from).length - 1, `${defect.name} replaces exactly one site`).toBe(1);
    await writeFile(path, code.replace(defect.from, defect.to));
  }
  const output = join(scratch, `reftui-${defect?.name ?? "healthy"}`);
  try {
    await exec("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", output, "."], {
      cwd: source,
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: "linux",
        GOARCH: "amd64",
        GOPROXY: "off",
        GOTOOLCHAIN: "local",
        GOFLAGS: "-mod=mod",
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        "The M5-09 acceptance builds fixtures/reference-tui with the host Go toolchain (go 1.22+ on PATH); go was not found",
      );
    throw error;
  }
  return output;
}

const sha256 = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

function action(id: string, operation: string, input: Json, timeoutMs?: number): PlanStep {
  return {
    id,
    kind: "action",
    operation,
    description: id,
    required: true,
    input,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  } as PlanStep;
}
function check(id: string, input: Json, predicate: string, value?: JsonValue): PlanStep {
  return {
    id,
    kind: "assertion",
    operation: "assert",
    description: id,
    required: true,
    input,
    expectation: { predicate, ...(value === undefined ? {} : { value: literal(value) }) },
  } as PlanStep;
}
function exited(id: string, step: string, codes: number[]): PlanStep {
  return {
    id,
    kind: "assertion",
    operation: "assert",
    description: id,
    required: true,
    input: { processStepId: step },
    expectation: { predicate: "exitCodeIn", values: codes },
  } as PlanStep;
}
function plan(name: string, steps: PlanStep[]): ExecutablePlan {
  return {
    schemaVersion: "1.0.0",
    kind: "executable",
    name,
    type: "cli",
    runner: "terminal",
    requirementRefs: [],
    steps,
  } as ExecutablePlan;
}

/** The suite: four pipe-mode tests and three PTY tests, each owning one behaviour of the program. */
function suite(artifactRef: string): Record<string, ExecutablePlan> {
  const program = { artifactRef };
  const open = [
    action("open-menu", "launch", { program, args: [], cols: 80, rows: 24 }),
    action(
      "menu-ready",
      "waitForText",
      { text: literal("selected: alpha"), deadlineMs: 8000 },
      10_000,
    ),
  ];
  const quit = [
    action("press-quit", "sendText", { text: literal("q") }),
    action("quit-exit", "waitForExit", { deadlineMs: 8000 }, 10_000),
    exited("menu-exit", "open-menu", [0]),
    check("no-leftovers", { processStepId: "open-menu" }, "noLingeringProcesses"),
  ];
  return {
    "cli-version": plan("cli-version", [
      action("version", "run", { program, args: [literal("--version")] }),
      exited("version-exit", "version", [0]),
      check(
        "version-text",
        { processStepId: "version", stream: "stdout" },
        "textContains",
        "reftui 1.2.3",
      ),
    ]),
    "cli-list": plan("cli-list", [
      action("list", "run", { program, args: [literal("--list")] }),
      exited("list-exit", "list", [0]),
      check(
        "list-count",
        { processStepId: "list", stream: "stdout", jsonPointer: "/count" },
        "jsonEquals",
        3,
      ),
      check(
        "list-warning",
        { processStepId: "list", stream: "stderr" },
        "textContains",
        "warning:",
      ),
      check(
        "list-clean",
        { processStepId: "list", stream: "stdout" },
        "textNotContains",
        "warning",
      ),
    ]),
    "cli-init": plan("cli-init", [
      action("init", "run", { program, args: [literal("--init")] }),
      exited("init-exit", "init", [0]),
      check("init-file", { file: { root: "workdir", path: ".reftui/project.json" } }, "fileExists"),
    ]),
    "cli-usage": plan("cli-usage", [
      action("bogus", "run", { program, args: [literal("--bogus")] }),
      exited("bogus-exit", "bogus", [2]),
      check(
        "bogus-text",
        { processStepId: "bogus", stream: "stderr" },
        "textContains",
        "unknown flag --bogus",
      ),
    ]),
    "tui-nav": plan("tui-nav", [
      ...open,
      action("move-down", "sendKeys", { keys: ["Down"] }),
      check("beta-row", { screen: { row: 2 } }, "textEquals", "> beta"),
      ...quit,
    ]),
    "tui-clipboard": plan("tui-clipboard", [
      ...open,
      action("copy", "sendKeys", { keys: ["Enter"] }),
      action("copied", "waitForText", { text: literal("copied: alpha"), deadlineMs: 8000 }, 10_000),
      check("clipboard", { clipboard: "osc52" }, "textEquals", "alpha"),
      ...quit,
    ]),
    "tui-resize": plan("tui-resize", [
      ...open,
      check("size-before", { screen: {} }, "textContains", "size: 80x24"),
      action("shrink", "resize", { cols: 60, rows: 15 }),
      check("size-after", { screen: {} }, "textContains", "size: 60x15"),
      ...quit,
    ]),
  };
}

async function importFixture(session: Journey, binary: string, name: string): Promise<string> {
  const imported = await session.command([
    "artifact",
    "import-fixture",
    binary,
    "--mime-type",
    "application/octet-stream",
    "--name",
    name,
  ]);
  expect(imported.contentHash).toBe(await sha256(binary));
  return text(imported.id);
}

async function createTest(session: Journey, value: ExecutablePlan, basename: string) {
  return text((await session.createTest(value, basename)).id);
}

interface Verdict {
  runId: string;
  outcome: string;
  reasonCode: string;
}
async function run(session: Journey, testId: string): Promise<Verdict> {
  const result = await session.start(["test", "run", testId, "--wait", "--timeout", "180"]).result;
  const value = object(data(result.json).run);
  return {
    runId: text(value.id),
    outcome: text(value.outcome),
    reasonCode: text(value.reasonCode),
  };
}

/** Runs the whole suite against one imported binary and returns each test's verdict. */
async function runSuite(session: Journey, artifactRef: string, label: string) {
  const verdicts: Record<string, Verdict> = {};
  for (const [name, value] of Object.entries(suite(artifactRef)))
    verdicts[name] = await run(session, await createTest(session, value, `${label}-${name}.json`));
  return verdicts;
}

it("M5-09 a real Go TUI passes its pipe and PTY tests and its evidence names the executed binary", async () => {
  await journey(
    "m5-terminal-reference-tui",
    async (session) => {
      const scratch = await mkdtemp(join(tmpdir(), "tm-reftui-"));
      try {
        const binary = await build(scratch);
        await session.init("http://127.0.0.1:9");
        const artifactRef = await importFixture(session, binary, "reftui");
        const verdicts = await runSuite(session, artifactRef, "healthy");
        for (const [name, verdict] of Object.entries(verdicts))
          expect(verdict, name).toMatchObject({
            outcome: "passed",
            reasonCode: "assertions_satisfied",
          });
        const version = await session.committed(text(verdicts["cli-version"]?.runId));
        const process = JSON.parse(
          await readFile(join(version.directory, "terminal/version.json"), "utf8"),
        ) as Json;
        expect(object(process.program).sha256).toBe(await sha256(binary));
        expect(process).toMatchObject({ exitCode: 0, timedOut: false, lingeringProcesses: 0 });
        const menu = await session.committed(text(verdicts["tui-clipboard"]?.runId));
        const kinds = new Set(menu.manifest.entries.map((entry) => entry.kind));
        for (const kind of ["terminal.process", "terminal.cast", "terminal.screen"])
          expect(kinds.has(kind), kind).toBe(true);
        const bundle = await session.command([
          "artifact",
          "get",
          text(verdicts["tui-clipboard"]?.runId),
        ]);
        expect(object(bundle.manifest).runId).toBe(verdicts["tui-clipboard"]?.runId);
        session.oracles.push({
          check: "referenceTuiHealthy",
          binarySha256: await sha256(binary),
          verdicts,
        });
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    metadata,
  );
}, 600_000);

it("M5-09 each defect planted in a throwaway copy fails only its matching test with failed/assertion_*", async () => {
  await journey(
    "m5-terminal-planted-defects",
    async (session) => {
      const scratch = await mkdtemp(join(tmpdir(), "tm-reftui-"));
      try {
        await session.init("http://127.0.0.1:9");
        const matrix: Json[] = [];
        for (const defect of defects) {
          const binary = await build(scratch, defect);
          const artifactRef = await importFixture(session, binary, `reftui-${defect.name}`);
          const verdicts = await runSuite(session, artifactRef, defect.name);
          const failing = Object.entries(verdicts)
            .filter(([, verdict]) => verdict.outcome !== "passed")
            .map(([name]) => name);
          expect(failing, defect.name).toEqual([defect.test]);
          const target = verdicts[defect.test];
          expect(target?.outcome, defect.name).toBe("failed");
          expect(target?.reasonCode, defect.name).toMatch(/^assertion_/);
          matrix.push({ defect: defect.name, failing, reasonCode: target?.reasonCode });
        }
        session.oracles.push({ check: "plantedDefectsFailOnlyTheirTest", matrix });
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    metadata,
  );
}, 900_000);

it("M5-09 a missing program blocks, a hung program times out with no process left, and a cancel kills the process tree", async () => {
  await journey(
    "m5-terminal-negatives",
    async (session) => {
      const scratch = await mkdtemp(join(tmpdir(), "tm-reftui-"));
      try {
        const binary = await build(scratch);
        await session.init("http://127.0.0.1:9");
        const artifactRef = await importFixture(session, binary, "reftui");
        const program = { artifactRef };
        const containers = async (runId: string) =>
          (
            await exec("docker", ["ps", "-a", "-q", "--filter", `label=io.testmaster.run=${runId}`])
          ).stdout.trim();

        const missing = await run(
          session,
          await createTest(
            session,
            plan("missing", [
              action("start", "run", { program: { path: "/usr/bin/reftui-missing" }, args: [] }),
              exited("start-exit", "start", [0]),
            ]),
            "missing.json",
          ),
        );
        expect(missing).toMatchObject({
          outcome: "inconclusive",
          reasonCode: "unsupported_capability",
        });
        const missingSteps = await session.command(["run", "steps", missing.runId]);
        const start = (missingSteps.steps as Json[])
          .map(object)
          .find((step) => step.planStepId === "start");
        expect(start).toMatchObject({ status: "blocked", reasonCode: "unsupported_capability" });
        expect(object(start?.error).code).toBe("ENOENT");

        const hung = await run(
          session,
          await createTest(
            session,
            plan("hung", [
              action("hang", "run", { program, args: [literal("--hang")] }, 3000),
              exited("hang-exit", "hang", [0]),
            ]),
            "hung.json",
          ),
        );
        expect(hung).toMatchObject({ outcome: "failed", reasonCode: "assertion_timeout" });
        const hungEvidence = await session.committed(hung.runId);
        const hangProcess = JSON.parse(
          await readFile(join(hungEvidence.directory, "terminal/hang.json"), "utf8"),
        ) as Json;
        expect(hangProcess).toMatchObject({
          timedOut: true,
          signal: "SIGKILL",
          lingeringProcesses: 0,
        });
        expect(await containers(hung.runId)).toBe("");

        const watchTest = await createTest(
          session,
          plan("cancel", [
            action("watch", "launch", { program, args: [literal("--watch")], cols: 80, rows: 24 }),
            action(
              "watching",
              "waitForText",
              { text: literal("watching child="), deadlineMs: 8000 },
              10_000,
            ),
            action("forever", "waitForExit", { deadlineMs: 100_000 }, 110_000),
            exited("watch-exit", "watch", [0]),
          ]),
          "cancel.json",
        );
        const waiting = session.start(["test", "run", watchTest, "--wait", "--timeout", "180"]);
        const listed = await eventually(
          () => session.command(["run", "list"]),
          (value) => (value.items as Json[]).map(object).some((row) => row.status === "running"),
        );
        const runId = text(
          (listed.items as Json[]).map(object).find((row) => row.status === "running")?.id,
        );
        // The program and its child are both alive inside the attempt container before the cancel.
        const tree = await eventually(
          async () => {
            const container = await containers(runId);
            if (!container) return [];
            const top = await exec("docker", ["top", container, "-eo", "pid,args"]);
            return top.stdout
              .split("\n")
              .filter((line) => line.includes("fixture-"))
              .map((line) => Number(line.trim().split(/\s+/)[0]));
          },
          (pids) => pids.length === 2,
        );
        await session.command(["run", "cancel", runId]);
        const finished = await waiting.result;
        expect(object(data(finished.json).run)).toMatchObject({
          id: runId,
          outcome: "cancelled",
          reasonCode: "user_cancelled",
        });
        expect(await containers(runId)).toBe("");
        for (const pid of tree)
          await expect(readFile(`/proc/${pid}/stat`, "utf8"), `pid ${pid}`).rejects.toThrow();
        session.oracles.push({
          check: "terminalNegatives",
          missing,
          hung,
          cancelled: { runId, killedHostPids: tree },
        });
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    metadata,
  );
}, 600_000);
