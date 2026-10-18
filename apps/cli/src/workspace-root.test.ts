import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
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

async function invoke(args: string[]) {
  let stdout = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      stdout += String(chunk);
      callback();
    },
  });
  const diagnostics = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  process.exitCode = 0;
  await runCli(["--json", ...args], new Runtime(output, diagnostics));
  return {
    exit: process.exitCode ?? 0,
    stdout,
    document: JSON.parse(stdout) as {
      data?: Record<string, unknown>;
      error?: { code: string; message: string; details: Record<string, unknown> };
    },
  };
}
/** An initialized repository with a subdirectory, run from that subdirectory as a shell would. */
async function initializedRepository() {
  const base = await mkdtemp(join(tmpdir(), "testmaster-cli-root-"));
  roots.push(base);
  const root = join(base, "repo");
  const sub = join(root, "work");
  await mkdir(join(base, "home"));
  await mkdir(sub, { recursive: true });
  vi.stubEnv("HOME", join(base, "home"));
  vi.stubEnv("XDG_CONFIG_HOME", join(base, "home", ".config"));
  const created = await invoke(["--cwd", root, "init", "--name", "shop"]);
  expect(created.exit).toBe(0);
  vi.spyOn(process, "cwd").mockReturnValue(sub);
  return { root, sub };
}

it("a command run from a subdirectory of an initialized repository is refused and creates nothing", async () => {
  const { root, sub } = await initializedRepository();
  const refused = await invoke(["project", "list"]);
  expect(refused.exit).toBe(6);
  expect(refused.document.error).toMatchObject({
    code: "PRECONDITION_FAILED",
    message: expect.stringContaining(`initialized at ${root}`),
    details: { reasonCode: "outside_workspace_root", workspaceRoot: root },
  });
  expect(existsSync(join(sub, ".testmaster"))).toBe(false);
});

it("--cwd addresses the initialized root from the subdirectory", async () => {
  const { root, sub } = await initializedRepository();
  const listed = await invoke(["--cwd", root, "project", "list"]);
  expect(listed.exit).toBe(0);
  expect(existsSync(join(sub, ".testmaster"))).toBe(false);
});

it("init in a subdirectory of an initialized repository still creates its own workspace", async () => {
  const { sub } = await initializedRepository();
  const nested = await invoke(["init", "--name", "nested"]);
  expect(nested.exit).toBe(0);
  expect(nested.document.data).toMatchObject({ projectId: expect.any(String) });
  expect(existsSync(join(sub, "testmaster.config.json"))).toBe(true);
  expect(existsSync(join(sub, ".testmaster", "testmaster.db"))).toBe(true);
  // The nested workspace now exists, so its own commands open it.
  const listed = await invoke(["project", "list"]);
  expect(listed.exit).toBe(0);
});
