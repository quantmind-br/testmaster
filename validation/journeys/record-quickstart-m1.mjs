// Run from the repository root after the final build and runner-image build:
// node validation/journeys/record-quickstart-m1.mjs
// Writes only this invocation's observed transcript to validation/results/quickstart-m1.md.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startShop } from "@testmaster/reference-shop";
import { checks } from "@testmaster/reference-shop/oracle";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = await mkdtemp(join(tmpdir(), "testmaster-quickstart-"));
const repo = join(temporary, "repo");
const home = join(temporary, "home");
await mkdir(repo);
await mkdir(home);
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local/share"),
  TESTMASTER_DATA_DIR: join(repo, ".testmaster"),
  TESTMASTER_OFFLINE: "true",
  TESTMASTER_NO_TELEMETRY: "true",
  CI: "true",
};
for (const key of [
  "TESTMASTER_ENDPOINT",
  "TESTMASTER_PROJECT_ID",
  "TESTMASTER_PROFILE",
  "TESTMASTER_API_KEY",
  "TESTMASTER_MODEL_API_KEY",
  "NODE_OPTIONS",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
])
  delete env[key];
const shop = await startShop({ port: 0 });
const commands = [];
let oracle;
let failure;
async function command(args, expectedExit = 0) {
  const argv = [join(root, "apps/cli/dist/main.js"), ...args, "--output", "json", "--no-color"];
  const child = spawn(process.execPath, argv, { cwd: repo, env, stdio: "pipe" });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completion = Promise.withResolvers();
  child.once("error", completion.reject);
  child.once("close", (exitCode, signal) => completion.resolve({ exitCode, signal }));
  const result = {
    argv: [process.execPath, ...argv],
    ...(await completion.promise),
    stdout,
    stderr,
  };
  commands.push(result);
  if (result.exitCode !== expectedExit)
    throw new Error(`Unexpected exit ${result.exitCode} for ${args.join(" ")}`);
  const envelope = JSON.parse(stdout);
  return envelope.data;
}
try {
  await command(["init", "--mode", "local", "--name", "M1 quickstart", "--base-url", shop.url]);
  await command(["doctor"]);
  const plan = {
    schemaVersion: "1.0.0",
    kind: "executable",
    name: "Reference shop HTTP health",
    type: "backend",
    runner: "http",
    requirementRefs: [],
    steps: [
      {
        id: "health",
        description: "Read the real service health",
        kind: "action",
        operation: "request",
        input: { method: "GET", pathSegments: [{ literal: "health" }] },
      },
      {
        id: "status",
        description: "HTTP 200",
        kind: "assertion",
        operation: "assert",
        input: { responseStepId: "health" },
        expectation: { predicate: "statusIn", values: [200] },
      },
      {
        id: "body",
        description: "Healthy service state",
        kind: "assertion",
        operation: "assert",
        input: { responseStepId: "health", jsonPointer: "/status" },
        expectation: { predicate: "jsonEquals", value: { literal: "ok" } },
      },
    ],
  };
  await writeFile(join(repo, "health.plan.json"), JSON.stringify(plan));
  await command(["test", "lint", "--plan", "health.plan.json"]);
  const test = await command(["test", "create", "--plan", "health.plan.json"]);
  const execution = await command(["test", "run", test.id, "--wait", "--timeout", "180"]);
  const runId = execution.receipt.runId;
  await command(["run", "get", runId]);
  await command(["artifact", "get", runId, "--out", join(repo, "evidence")]);
  const report = join(repo, "report.json");
  await command(["report", "export", runId, "--format", "json", "--out", report]);
  JSON.parse(await readFile(report, "utf8"));
  const backup = join(temporary, "backup");
  await command(["backup", "create", "--out", backup]);
  await command(["backup", "restore", backup, "--out", join(temporary, "restore")]);
  oracle = await checks.serviceHealth(shop);
  if (!oracle.healthy)
    throw new Error("Independent reference shop health oracle rejected baseline");
  const mutant = await startShop({ port: 0, mutant: "health-degraded" });
  try {
    const project = (await command(["project", "list"]))[0];
    const environment = (await command(["env", "list", "--project", project.id]))[0];
    await command([
      "env",
      "update",
      environment.id,
      "--base-url",
      mutant.url,
      "--expected-version",
      String(environment.version),
    ]);
    const replay = await command(["test", "rerun", test.id, "--wait", "--timeout", "180"], 1);
    if (replay.run.outcome !== "failed")
      throw new Error("Mutant replay did not preserve assertion failure");
    const mutantOracle = await checks.serviceHealth(mutant);
    if (mutantOracle.healthy) throw new Error("Independent oracle did not detect mutant");
    oracle = { baseline: oracle, mutant: mutantOracle, runId: replay.run.id };
  } finally {
    await mutant.close();
  }
} catch (error) {
  failure = String(error);
  process.exitCode = 1;
} finally {
  await mkdir(join(root, "validation/results"), { recursive: true });
  const transcript = [
    "# M1 quickstart — observed manual transcript",
    "",
    `Recorded: ${new Date().toISOString()}`,
    "",
    "Built CLI executed against a real local reference-shop using an isolated repository, HOME and Docker runner. No LLM or external SaaS exercised. Temporary execution directories were removed after capture.",
    "",
    ...commands.flatMap((entry) => [
      "```text",
      `$ ${entry.argv.join(" ")}`,
      `exitCode=${entry.exitCode} signal=${entry.signal ?? "none"}`,
      "stdout:",
      entry.stdout.trimEnd(),
      "stderr:",
      entry.stderr.trimEnd(),
      "```",
      "",
    ]),
    ...(oracle
      ? ["Independent oracle:", "```json", JSON.stringify(oracle, null, 2), "```", ""]
      : []),
    ...(failure ? ["Observed failure:", "```text", failure, "```", ""] : []),
  ].join("\n");
  await writeFile(join(root, "validation/results/quickstart-m1.md"), transcript);
  await shop.close();
  await rm(temporary, { recursive: true, force: true });
}
