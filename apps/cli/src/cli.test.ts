import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Application, scaffoldPlan } from "@testmaster/application";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

const roots: string[] = [];
const originalExitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function invoke(args: string[], nodeVersion?: string) {
  let stdout = "";
  let stderr = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      stdout += String(chunk);
      callback();
    },
  });
  const diagnostics = new Writable({
    write(chunk, _encoding, callback) {
      stderr += String(chunk);
      callback();
    },
  });
  await runCli(args, new Runtime(output, diagnostics), nodeVersion);
  return {
    stdout,
    stderr,
    exit: process.exitCode,
    document: JSON.parse(stdout) as Record<string, unknown>,
  };
}

describe("CLI machine output and offline authoring", () => {
  it("returns one JSON error with validation exit for commander input failures", async () => {
    const result = await invoke(["--json", "test", "unknown", "--inline-key", "never-echo-this"]);
    expect(result.exit).toBe(5);
    expect(result.document.error).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stdout + result.stderr).not.toContain("never-echo-this");
  });
  it("names a missing required option or argument without echoing typed values", async () => {
    const option = await invoke(["--json", "source", "add", "README.md"]);
    expect(option.exit).toBe(5);
    expect(option.document.error).toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining("--role"),
      details: { reason: "commander.missingMandatoryOptionValue" },
    });
    const value = await invoke(["--json", "artifact", "import-fixture", "bin/tool", "--name"]);
    expect(value.document.error).toMatchObject({
      message: expect.stringContaining("--name"),
      details: { reason: "commander.optionMissingArgument" },
    });
    // An invalid choice echoes the typed token in commander's text, so it keeps the generic message.
    const choice = await invoke([
      "--json",
      "source",
      "add",
      "a.md",
      "--role",
      "prd",
      "--format",
      "never-echo-this",
    ]);
    expect(choice.document.error).toMatchObject({ message: "Invalid command arguments" });
    expect(choice.stdout).not.toContain("never-echo-this");
  });
  it("validates bad dry-run input without creating application state", async () => {
    const root = await mkdtemp(join(tmpdir(), "testmaster-cli-"));
    roots.push(root);
    await writeFile(join(root, "bad.json"), '{"schemaVersion":"1.0.0"}');
    const result = await invoke([
      "--json",
      "--cwd",
      root,
      "test",
      "create",
      "--plan",
      "bad.json",
      "--dry-run",
    ]);
    expect(result.exit).toBe(5);
    expect(result.document.error).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await readdir(root)).toEqual(["bad.json"]);
  });
  it("scaffolds a reusable plan and validates it offline without a database", async () => {
    const root = await mkdtemp(join(tmpdir(), "testmaster-cli-"));
    roots.push(root);
    const scaffold = await invoke([
      "--json",
      "--cwd",
      root,
      "test",
      "scaffold",
      "--type",
      "backend",
    ]);
    expect(scaffold.exit).toBe(0);
    expect(scaffold.document.data).toMatchObject({ kind: "executable", type: "backend" });
    await writeFile(join(root, "plan.json"), JSON.stringify(scaffold.document.data));
    const dry = await invoke([
      "--json",
      "--cwd",
      root,
      "test",
      "create",
      "--plan",
      "plan.json",
      "--dry-run",
    ]);
    expect(dry.exit).toBe(0);
    expect(dry.document.data).toEqual({
      dryRun: true,
      validated: true,
      operations: [],
      unresolvedPreconditions: [],
    });
    expect(await readdir(root)).toEqual(["plan.json"]);
  });
  it("scaffolds a terminal plan that validates offline and refuses an unknown scaffold type", async () => {
    const root = await mkdtemp(join(tmpdir(), "testmaster-cli-"));
    roots.push(root);
    const scaffold = await invoke(["--json", "--cwd", root, "test", "scaffold", "--type", "cli"]);
    expect(scaffold.exit).toBe(0);
    expect(scaffold.document.data).toMatchObject({
      kind: "executable",
      type: "cli",
      runner: "terminal",
    });
    await writeFile(join(root, "plan.json"), JSON.stringify(scaffold.document.data));
    const lint = await invoke(["--json", "--cwd", root, "test", "lint", "--plan", "plan.json"]);
    expect(lint.exit).toBe(0);
    const unknown = await invoke([
      "--json",
      "--cwd",
      root,
      "test",
      "scaffold",
      "--type",
      "integration",
    ]);
    expect(unknown.exit).toBe(5);
    expect(unknown.document.error).toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "Type must be frontend, backend or cli",
    });
  });
  it("writes the GitHub workflow to an explicit file without colliding with the output format", async () => {
    const root = await mkdtemp(join(tmpdir(), "testmaster-cli-"));
    roots.push(root);
    const result = await invoke([
      "--json",
      "--cwd",
      root,
      "ci",
      "init",
      "github",
      "--action-ref",
      `quantmind-br/testmaster@${"a".repeat(40)}`,
      "--setup-script",
      "ci/setup.sh",
      "--runtime-repo",
      "quantmind-br/testmaster",
      "--runtime-tag",
      "runtime-test",
      "--runtime-assets",
      JSON.stringify([
        "manifest.json",
        "manifest.json.sig",
        "runtime.tar.gz",
        "testmaster-runner.tar.gz.part-0000",
        "testmaster-runner-python.tar.gz.part-0000",
      ]),
      "--runtime-manifest-sha256",
      "b".repeat(64),
      "--target-url",
      "http://127.0.0.1:18080",
      "--workflow-file",
      "workflows/custom.yml",
    ]);
    expect(result.exit).toBe(0);
    expect(result.document.data).toMatchObject({ path: join(root, "workflows/custom.yml") });
    const workflow = JSON.parse(await readFile(join(root, "workflows/custom.yml"), "utf8"));
    expect(Object.keys(workflow.jobs)).toEqual(["execute", "publish"]);
  });
  it("does not turn future capabilities into success even in dry-run", async () => {
    const result = await invoke(["--json", "tunnel", "start", "--dry-run"]);
    expect(result.exit).toBe(8);
    expect(result.document.error).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      details: { capability: "tunnels", milestone: "M5" },
    });
  });
  it("rejects inline secret argv without echoing the secret", async () => {
    const result = await invoke([
      "--json",
      "secret",
      "set",
      "TOKEN",
      "--value",
      "sensitive-canary",
    ]);
    expect(result.exit).toBe(5);
    expect(result.stdout + result.stderr).not.toContain("sensitive-canary");
  });
  it("validates timeout units before opening state", async () => {
    const result = await invoke(["--json", "run", "wait", "run_missing", "--timeout", "-1"]);
    expect(result.exit).toBe(5);
    expect(result.document.error).toMatchObject({ code: "INVALID_ARGUMENT" });
  });
  it("refuses every command on an unsupported Node major before any state is opened", async () => {
    const root = await mkdtemp(join(tmpdir(), "testmaster-cli-"));
    roots.push(root);
    for (const version of ["25.0.0", "22.12.0", "not-a-version"]) {
      const refused = await invoke(["--json", "--cwd", root, "init", "--name", "shop"], version);
      expect(refused.exit).toBe(6);
      expect(refused.document.error).toMatchObject({
        code: "PRECONDITION_FAILED",
        details: { reasonCode: "unsupported_node", required: ">=24 <25", actual: version },
      });
      expect(await readdir(root)).toEqual([]);
    }
    const supported = await invoke(["--json", "--cwd", root, "config", "show"], "24.21.0");
    expect(supported.exit).toBe(0);
  });
  it("init opens no network listener", async () => {
    const root = await mkdtemp(join(tmpdir(), "testmaster-cli-"));
    roots.push(root);
    await mkdir(join(root, "home"));
    vi.stubEnv("HOME", join(root, "home"));
    vi.stubEnv("XDG_CONFIG_HOME", join(root, "home", ".config"));
    const listen = vi.spyOn(net.Server.prototype, "listen");
    const result = await invoke(["--json", "--cwd", root, "init", "--name", "shop"]);
    expect(result.exit).toBe(0);
    expect(result.document.data).toMatchObject({ projectId: expect.any(String) });
    expect(listen).not.toHaveBeenCalled();
  });
  it("init writes the given base URL into the configuration file it creates", async () => {
    const root = await mkdtemp(join(tmpdir(), "testmaster-cli-"));
    roots.push(root);
    await mkdir(join(root, "home"));
    vi.stubEnv("HOME", join(root, "home"));
    vi.stubEnv("XDG_CONFIG_HOME", join(root, "home", ".config"));
    const base = ["--json", "--cwd", root];
    const result = await invoke([
      ...base,
      "init",
      "--name",
      "tool",
      "--base-url",
      "http://127.0.0.1:9",
    ]);
    expect(result.exit).toBe(0);
    const written = JSON.parse(await readFile(join(root, "testmaster.config.json"), "utf8"));
    expect(written.environment).toMatchObject({ baseUrl: "http://127.0.0.1:9" });
    // The reopened configuration and the stored environment agree on the origin.
    const shown = await invoke([...base, "config", "show"]);
    expect(JSON.stringify(shown.document.data)).toContain('"baseUrl":"http://127.0.0.1:9"');
    expect(JSON.stringify(shown.document.data)).not.toContain("127.0.0.1:3000");
  });
  it("preserves partial receipt ownership in one signal envelope", async () => {
    let stdout = "";
    const output = new Writable({
      write(chunk, _encoding, callback) {
        stdout += String(chunk);
        callback();
      },
    });
    const runtime = new Runtime(
      output,
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    );
    runtime.output = "json";
    runtime.receipts.push({ runId: "run_partial", ownership: "ephemeral" });
    runtime.interrupt("SIGTERM");
    runtime.fail(runtime.interrupted());
    runtime.fail(new Error("must not emit twice"));
    expect(process.exitCode).toBe(143);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout)).toMatchObject({
      error: {
        details: {
          signal: "SIGTERM",
          runId: "run_partial",
          receipts: [{ ownership: "ephemeral" }],
        },
      },
    });
  });
});

it("run analyze renders useful text while JSON and read-only analysis preserve the stored record", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-cli-diagnosis-"));
  roots.push(root);
  const app = await Application.open({ cwd: root, home: join(root, "home"), env: {} });
  try {
    const init = await app.init();
    const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
    const run = app.runs.resolve({ testId: test.id, environmentId: init.environmentId });
    Object.assign(run, { phase: "completed", status: "failed", outcome: "failed", gate: "failed" });
    app.context.entities.insert("Run", run);
    const call = async (args: string[]) => {
      let stdout = "";
      let stderr = "";
      const runtime = new Runtime(
        new Writable({
          write(chunk, _encoding, callback) {
            stdout += String(chunk);
            callback();
          },
        }),
        new Writable({
          write(chunk, _encoding, callback) {
            stderr += String(chunk);
            callback();
          },
        }),
      );
      vi.spyOn(runtime, "app").mockResolvedValue(app);
      await runCli(args, runtime);
      return { stdout, stderr, exit: process.exitCode };
    };
    const analyzed = await call(["run", "analyze", run.id]);
    expect(analyzed.exit).toBe(0);
    expect(analyzed.stdout).toContain("Diagnosis\nFailure:");
    expect(analyzed.stdout).toContain("Conclusion:");
    expect(analyzed.stdout).toContain("Next step:");
    expect(analyzed.stdout).toContain("Automatic healing:");
    const stored = app.analysis.get(run.id);
    const before = app.database.all("SELECT * FROM analyses");
    const json = await call(["--output", "json", "run", "analyze", run.id]);
    const envelope = JSON.parse(json.stdout);
    expect(envelope.data).toEqual(stored);
    expect(Object.keys(envelope).sort()).toEqual([
      "data",
      "requestId",
      "schemaVersion",
      "warnings",
    ]);
    expect(envelope).not.toHaveProperty("text");
    const read = await call(["run", "analysis", run.id]);
    expect(read.stdout).toBe(analyzed.stdout);
    expect(app.database.all("SELECT * FROM analyses")).toEqual(before);
    const missingRun = app.runs.resolve({ testId: test.id, environmentId: init.environmentId });
    app.context.entities.insert("Run", missingRun);
    const missing = await call(["--json", "run", "analysis", missingRun.id]);
    expect(JSON.parse(missing.stdout).error.code).toBe("NOT_FOUND");
    expect(app.database.all("SELECT * FROM analyses")).toEqual(before);
  } finally {
    app.close();
  }
});
