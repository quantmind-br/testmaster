import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertOutputsConfined, runAction } from "./main.js";

const base: NodeJS.ProcessEnv = {
  GITHUB_REPOSITORY: "owner/repo",
  GITHUB_SHA: "a".repeat(40),
  "INPUT_RUNTIME-MANIFEST": `/private/manifest.json#${"b".repeat(64)}`,
  INPUT_ENVIRONMENT: "ci",
  INPUT_ALL: "true",
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("refuses CI output paths that escape the invocation output directory", () => {
  const output = join(tmpdir(), "invocation", "output");
  expect(() =>
    assertOutputsConfined(
      {
        report: join(output, "report.json"),
        junit: join(output, "nested", "junit.xml"),
        summary: null,
      },
      output,
    ),
  ).not.toThrow();
  for (const escaped of [
    join(output, "..", "report.json"),
    "/etc/passwd",
    output,
    `${output}-evil/report.json`,
  ])
    expect(() => assertOutputsConfined({ junit: null, report: escaped }, output)).toThrow(
      expect.objectContaining({ code: "POLICY_DENIED" }),
    );
});

it("refuses a fork pull request before runtime installation", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tm-action-")));
  directories.push(directory);
  const eventPath = join(directory, "event.json");
  const runnerTemp = join(directory, "runner");
  await mkdir(runnerTemp);
  const env = (name: string): NodeJS.ProcessEnv => ({
    ...base,
    GITHUB_EVENT_NAME: name,
    GITHUB_EVENT_PATH: eventPath,
    RUNNER_TEMP: runnerTemp,
    GITHUB_WORKSPACE: directory,
  });
  for (const event of [
    { pull_request: { head: { repo: { full_name: "fork/repo" } } } },
    { pull_request: { head: { repo: null } } },
    { pull_request: { head: { repo: { full_name: "owner/repo-evil" } } } },
    { pull_request: {} },
    {},
  ]) {
    await writeFile(eventPath, JSON.stringify(event));
    await expect(runAction(env("pull_request"))).rejects.toMatchObject({
      code: "POLICY_DENIED",
      message: "Fork execution is denied before runtime installation",
    });
  }
  await expect(runAction(env("push"))).rejects.toMatchObject({
    code: "POLICY_DENIED",
    message: "Action requires workflow_dispatch or a same-repository pull request",
  });
  // Refusal happens before the per-invocation directory is created or any runtime is installed.
  expect(await readdir(runnerTemp)).toEqual([]);
});
