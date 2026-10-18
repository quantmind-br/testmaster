import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Application } from "@testmaster/application";
import { exitCodeForError } from "@testmaster/domain";
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

interface Envelope {
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

/** A host that resolves nowhere: contacting it would fail, so a request to it cannot go unnoticed. */
const TARGET = "http://bootstrap-target.invalid:8080";

async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "tm-cli-bootstrap-")));
  const home = join(cwd, "home");
  await mkdir(home);
  const app = await Application.open({ cwd, home, env: {} });
  const outside = await realpath(await mkdtemp(join(tmpdir(), "tm-cli-bootstrap-outside-")));
  cleanups.push(async () => {
    app.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const init = await app.init();
  const invoke = async (args: string[]) => {
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
    process.exitCode = 0;
    await runCli(["--json", "--cwd", cwd, "bootstrap", ...args], runtime);
    return { exit: process.exitCode ?? 0, body: JSON.parse(stdout) as Envelope };
  };
  const tree = async (directory: string) =>
    (await readdir(directory, { recursive: true, withFileTypes: true }))
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
  return { app, init, cwd, outside, invoke, tree };
}

it("is idempotent: the same root finds its project and environment instead of creating more", async () => {
  const f = await fixture();
  await mkdir(join(f.cwd, "shop"));
  const args = ["--root", "shop", "--target-url", TARGET];
  const first = await f.invoke(args);
  expect(first.exit).toBe(0);
  expect(first.body.data?.environment).toMatchObject({ created: true });
  const projects = f.app.projects.list().length;
  const environments = f.app.environments.list(String(first.body.data?.projectId)).length;

  const second = await f.invoke(args);
  expect(second.exit).toBe(0);
  expect(second.body.data?.projectId).toBe(first.body.data?.projectId);
  expect(second.body.data?.environment).toEqual({
    ...first.body.data?.environment,
    created: false,
  });
  expect(second.body.data?.proposedConfig).toEqual(first.body.data?.proposedConfig);
  expect(f.app.projects.list()).toHaveLength(projects);
  expect(f.app.environments.list(String(first.body.data?.projectId))).toHaveLength(environments);
  // The project is new: it is not the one `init` made for the workspace directory.
  expect(first.body.data?.projectId).not.toBe(f.init.projectId);
});

it("finds the workspace project for the workspace directory by default", async () => {
  const f = await fixture();
  const result = await f.invoke(["--target-url", "http://127.0.0.1:3000"]);
  expect(result.body.data?.projectId).toBe(f.init.projectId);
  expect(result.body.data?.preflight).toContainEqual({
    check: "config_matches_project",
    passed: true,
  });
  expect(f.app.projects.list()).toHaveLength(1);
});

it("never writes a file in the root and never contacts the target", async () => {
  const f = await fixture();
  await mkdir(join(f.cwd, "shop"));
  const requests = vi.spyOn(globalThis, "fetch");
  const connections = vi.spyOn(net.Socket.prototype, "connect");
  const rootBefore = await f.tree(join(f.cwd, "shop"));
  const workspaceBefore = (await f.tree(f.cwd)).filter((path) => !path.includes(".testmaster"));

  const result = await f.invoke(["--root", "shop", "--target-url", TARGET, "--mode", "agent"]);
  expect(result.exit).toBe(0);
  expect(await f.tree(join(f.cwd, "shop"))).toEqual(rootBefore);
  expect((await f.tree(f.cwd)).filter((path) => !path.includes(".testmaster"))).toEqual(
    workspaceBefore,
  );
  expect(requests).not.toHaveBeenCalled();
  expect(connections.mock.calls.filter((call) => JSON.stringify(call).includes("invalid"))).toEqual(
    [],
  );
  // The config is only proposed: it names the project, the target and the requested mode.
  const data = result.body.data ?? {};
  expect(data.proposedConfig).toMatchObject({
    project: { id: data.projectId },
    environment: { baseUrl: TARGET, networkProfile: "public" },
    execution: { mode: "agent" },
  });
  expect(data.preflight).toContainEqual({ check: "config_file_present", passed: false });
  expect(data.nextActions).toContainEqual(expect.stringContaining("bootstrap never writes a file"));
});

it("refuses a root outside the workspace, through a path or a symlink, without creating a project", async () => {
  const f = await fixture();
  await symlink(f.outside, join(f.cwd, "escape"));
  const projects = f.app.projects.list().length;
  for (const root of [f.outside, "..", "escape"]) {
    const result = await f.invoke(["--root", root, "--target-url", TARGET]);
    expect(result.body.error?.code, root).toBe("FORBIDDEN");
    expect(result.exit, root).toBe(exitCodeForError("FORBIDDEN"));
    expect(result.body.error?.details?.approvedRoots, root).toEqual([f.cwd]);
  }
  expect(f.app.projects.list()).toHaveLength(projects);
  expect(await readdir(f.outside)).toEqual([]);
});

it("refuses a target that is not an http(s) URL without credentials, and a bad scope, before storing anything", async () => {
  const f = await fixture();
  await mkdir(join(f.cwd, "shop"));
  const projects = f.app.projects.list().length;
  for (const target of ["ftp://example.test", "http://user:secret@example.test", "not a url"]) {
    const result = await f.invoke(["--root", "shop", "--target-url", target]);
    expect(result.body.error?.code, target).toBe("INVALID_ARGUMENT");
    expect(JSON.stringify(result.body), target).not.toContain("secret");
  }
  for (const scope of [
    ["--scope", "everything"],
    ["--scope", "diff", "--scope", "diff"],
  ]) {
    const result = await f.invoke(["--root", "shop", "--target-url", TARGET, ...scope]);
    expect(result.body.error?.code, scope.join(" ")).toBe("INVALID_ARGUMENT");
  }
  expect(f.app.projects.list()).toHaveLength(projects);
});

it("reports an environment aimed at another origin with the exact update command and never retargets it", async () => {
  const f = await fixture();
  const before = f.app.environments.list(f.init.projectId);
  const result = await f.invoke(["--target-url", "http://127.0.0.1:20311", "--scope", "diff"]);
  expect(result.exit).toBe(0);
  expect(result.body.data?.environment).toBeUndefined();
  expect(result.body.data?.preflight).toContainEqual({
    check: "environment_targets_target",
    passed: false,
  });
  const [stale] = before;
  expect(result.body.data?.nextActions).toContainEqual(
    expect.stringContaining(
      `testmaster env update ${stale?.id} --expected-version ${stale?.version} --base-url http://127.0.0.1:20311`,
    ),
  );
  expect(f.app.environments.list(f.init.projectId)).toEqual(before);
});

it("the global dry run validates the input and stores nothing", async () => {
  const f = await fixture();
  await mkdir(join(f.cwd, "shop"));
  const projects = f.app.projects.list().length;
  const dry = await f.invoke(["--dry-run", "--root", "shop", "--target-url", TARGET]);
  expect(dry.exit).toBe(0);
  expect(dry.body.data).toMatchObject({ dryRun: true, validated: true });
  expect(f.app.projects.list()).toHaveLength(projects);
  const refused = await f.invoke([
    "--dry-run",
    "--root",
    "shop",
    "--target-url",
    TARGET,
    "--scope",
    "x",
  ]);
  expect(refused.body.error?.code).toBe("INVALID_ARGUMENT");
});
