import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Application, scaffoldPlan } from "@testmaster/application";
import { afterEach, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

const cleanups: (() => Promise<void>)[] = [];
const originalExit = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExit;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-cli-revision-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const app = await Application.open({ cwd, home, env: {} });
  cleanups.push(async () => {
    app.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const init = await app.init();
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  await writeFile(
    join(cwd, "next.json"),
    JSON.stringify({ ...scaffoldPlan("backend"), name: "Read service health again" }),
  );
  const invoke = async (args: string[], json = true) => {
    let stdout = "";
    let stderr = "";
    const sink = (append: (text: string) => void) =>
      new Writable({
        write(chunk, _encoding, done) {
          append(String(chunk));
          done();
        },
      });
    const runtime = new Runtime(
      sink((text) => {
        stdout += text;
      }),
      sink((text) => {
        stderr += text;
      }),
    );
    runtime.app = async () => app;
    process.exitCode = 0;
    await runCli([...(json ? ["--json"] : []), "--cwd", cwd, ...args], runtime);
    return { exit: process.exitCode ?? 0, stdout, stderr };
  };
  return { app, test, invoke };
}

interface RevisionReceipt {
  data: { id: string; active: boolean; nextActions: string[] };
  warnings: string[];
}

it("test revision create says the new revision is inactive and gives the exact promote command", async () => {
  const { app, test, invoke } = await fixture();
  const created = await invoke(["test", "revision", "create", test.id, "--plan", "next.json"]);
  expect(created.exit).toBe(0);
  const receipt = JSON.parse(created.stdout) as RevisionReceipt;
  const revisionId = receipt.data.id;
  expect(receipt.data.active).toBe(false);
  expect(app.tests.get(test.id).activeRevisionId).not.toBe(revisionId);
  const command = `testmaster test revision promote ${revisionId} --expected-version ${app.tests.get(test.id).version}`;
  expect(receipt.data.nextActions).toEqual([command]);
  expect(receipt.warnings).toHaveLength(1);
  expect(receipt.warnings[0]).toContain(command);

  // Following the advertised command activates the revision.
  const promoted = await invoke([
    "test",
    "revision",
    "promote",
    revisionId,
    "--expected-version",
    String(app.tests.get(test.id).version),
  ]);
  expect(promoted.exit).toBe(0);
  expect(app.tests.get(test.id).activeRevisionId).toBe(revisionId);

  // Text output carries the same command on stderr, next to the receipt on stdout.
  const text = await invoke(["test", "revision", "create", test.id, "--plan", "next.json"], false);
  expect(text.exit).toBe(0);
  expect(text.stderr).toContain("testmaster test revision promote rev_");
  expect(text.stderr).toContain(`--expected-version ${app.tests.get(test.id).version}`);
});

it("test revision promote --reason records the reason on the test", async () => {
  const { app, test, invoke } = await fixture();
  const created = await invoke(["test", "revision", "create", test.id, "--plan", "next.json"]);
  const revisionId = (JSON.parse(created.stdout) as RevisionReceipt).data.id;
  const promoted = await invoke([
    "test",
    "revision",
    "promote",
    revisionId,
    "--expected-version",
    String(app.tests.get(test.id).version),
    "--reason",
    "Candidate replay passed",
  ]);
  expect(promoted.exit).toBe(0);
  expect(app.revisionHistory.list(test.id).find((entry) => entry.id === revisionId)).toMatchObject({
    states: ["current"],
    promotion: { reason: "Candidate replay passed", actorId: app.context.principalId },
  });
});
