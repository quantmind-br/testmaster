import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Application } from "./application.js";

const directories: string[] = [];
const applications: Application[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of applications.splice(0)) app.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tm-workspace-root-"));
  directories.push(directory);
  return directory;
}
async function open(options: Parameters<typeof Application.open>[0]): Promise<Application> {
  const app = await Application.open(options);
  applications.push(app);
  return app;
}
function release(app: Application): void {
  app.close();
  applications.splice(applications.indexOf(app), 1);
}
/** An initialized workspace root with a subdirectory that holds no TestMaster state. */
async function initialized() {
  const base = await temporary();
  const home = join(base, "home");
  const root = join(base, "repo");
  const sub = join(root, "packages", "web");
  await mkdir(home);
  await mkdir(sub, { recursive: true });
  const app = await open({ cwd: root, home, env: {} });
  await app.init();
  release(app);
  expect(existsSync(join(root, "testmaster.config.json"))).toBe(true);
  return { base, home, root, sub };
}
/** The process working directory is what an implicit workspace resolves from. */
function workFrom(directory: string): void {
  vi.spyOn(process, "cwd").mockReturnValue(directory);
}

it("refuses an implicit workspace inside an initialized tree, naming the root and creating nothing", async () => {
  const { home, root, sub } = await initialized();
  workFrom(sub);
  const refusal = await Application.open({ home, env: {} }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(refusal).toMatchObject({
    name: "ContractError",
    code: "PRECONDITION_FAILED",
    message: expect.stringContaining(
      `${sub} is inside the TestMaster workspace initialized at ${root}`,
    ),
    details: {
      reasonCode: "outside_workspace_root",
      workspaceRoot: root,
      nextActions: expect.arrayContaining([expect.stringContaining(`--cwd ${root}`)]),
    },
  });
  expect((refusal as Error).message).toContain(`--cwd ${root}`);
  expect(existsSync(join(sub, ".testmaster"))).toBe(false);
});

it("refuses from a deeper descendant and still names the nearest initialized ancestor", async () => {
  const { home, root, sub } = await initialized();
  const deep = join(sub, "src", "components");
  await mkdir(deep, { recursive: true });
  workFrom(deep);
  await expect(Application.open({ home, env: {} })).rejects.toMatchObject({
    details: { reasonCode: "outside_workspace_root", workspaceRoot: root },
  });
  expect(existsSync(join(deep, ".testmaster"))).toBe(false);
});

it("opens the initialized root itself from the process working directory", async () => {
  const { home, root } = await initialized();
  workFrom(root);
  const app = await open({ home, env: {} });
  expect(app.config.cwd).toBe(root);
});

it("an explicit cwd bypasses the refusal", async () => {
  const { home, sub } = await initialized();
  workFrom(sub);
  const app = await open({ cwd: sub, home, env: {} });
  expect(app.config.cwd).toBe(sub);
  expect(existsSync(join(sub, ".testmaster", "testmaster.db"))).toBe(true);
});

it("TESTMASTER_DATA_DIR bypasses the refusal", async () => {
  const { base, home, sub } = await initialized();
  workFrom(sub);
  const dataDir = join(base, "data");
  const app = await open({ home, env: { TESTMASTER_DATA_DIR: dataDir } });
  expect(app.config.dataDir).toBe(dataDir);
  expect(existsSync(join(sub, ".testmaster"))).toBe(false);
});

it("a subdirectory that already holds its own database or configuration still opens", async () => {
  const { home, root, sub } = await initialized();
  const withDatabase = join(sub, "nested-db");
  await mkdir(withDatabase);
  release(await open({ cwd: withDatabase, home, env: {} }));
  workFrom(withDatabase);
  expect((await open({ home, env: {} })).config.cwd).toBe(withDatabase);

  const withConfig = join(sub, "nested-config");
  await mkdir(withConfig);
  await copyFile(join(root, "testmaster.config.json"), join(withConfig, "testmaster.config.json"));
  workFrom(withConfig);
  expect((await open({ home, env: {} })).config.cwd).toBe(withConfig);
});

it("opens as before when no ancestor is initialized", async () => {
  const base = await temporary();
  const home = join(base, "home");
  const lonely = join(base, "plain", "nested");
  await mkdir(home);
  await mkdir(lonely, { recursive: true });
  workFrom(lonely);
  const app = await open({ home, env: {} });
  expect(app.config.cwd).toBe(lonely);
  expect(existsSync(join(lonely, ".testmaster", "testmaster.db"))).toBe(true);
});

it("init may deliberately start a nested workspace", async () => {
  const { home, root, sub } = await initialized();
  workFrom(sub);
  const app = await open({ home, env: {}, allowNestedWorkspace: true });
  const result = await app.init();
  expect(result.projectId).toEqual(expect.any(String));
  expect(existsSync(join(sub, "testmaster.config.json"))).toBe(true);
  expect(existsSync(join(sub, ".testmaster", "testmaster.db"))).toBe(true);
  expect(existsSync(join(root, ".testmaster", "testmaster.db"))).toBe(true);
});
