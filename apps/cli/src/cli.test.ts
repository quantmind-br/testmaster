import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

const roots: string[] = [];
const originalExitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExitCode;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function invoke(args: string[]) {
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
  await runCli(args, new Runtime(output, diagnostics));
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
  it("does not turn future capabilities into success even in dry-run", async () => {
    const result = await invoke(["--json", "plan", "generate", "--dry-run"]);
    expect(result.exit).toBe(8);
    expect(result.document.error).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      details: { capability: "plan", milestone: "M2" },
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
