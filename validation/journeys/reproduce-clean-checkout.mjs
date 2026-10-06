import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Orchestrator-only: run after committing the complete release candidate. No network install or model key.
const source = resolve(process.argv[2] ?? ".");
const output = resolve(process.argv[3] ?? "validation/results/clean-checkout-no-key.json");
const temporary = await mkdtemp(join(tmpdir(), "tm-clean-checkout-"));
const checkout = join(temporary, "checkout");
const home = join(temporary, "home");
await mkdir(home);
const env = {
  ...process.env,
  HOME: home,
  TESTMASTER_OFFLINE: "true",
  TESTMASTER_NO_TELEMETRY: "true",
  CI: "true",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};
for (const name of Object.keys(env))
  if (
    /API_KEY|TOKEN|SECRET|PASSWORD/.test(name) ||
    [
      "NODE_OPTIONS",
      "TESTMASTER_PROFILE",
      "TESTMASTER_PROJECT_ID",
      "TESTMASTER_ENDPOINT",
      "TESTMASTER_DATA_DIR",
    ].includes(name)
  )
    delete env[name];
const commands = [];
async function run(binary, args, cwd = checkout) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const started = performance.now();
  const child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (bytes) => {
    stdout = (stdout + String(bytes)).slice(-65536);
  });
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + String(bytes)).slice(-65536);
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    commands.push({
      argv: [binary, ...args],
      exitCode: code,
      signal,
      durationMs: performance.now() - started,
      stdout,
      stderr,
    });
    code === 0 ? resolve(stdout) : reject(new Error(`${binary} failed with ${code}`));
  });
  return promise;
}
let error;
try {
  await run("git", ["clone", "--no-local", source, checkout], source);
  const commit = (await run("git", ["rev-parse", "HEAD"])).trim();
  // Reuse the operator's populated pnpm store, not its config, credentials or HOME.
  const storeEnv = { ...env, HOME: process.env.HOME };
  const { promise, resolve: done, reject } = Promise.withResolvers();
  const storeCommand = spawn("pnpm", ["store", "path"], {
    cwd: source,
    env: storeEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let store = "";
  storeCommand.stdout.on("data", (bytes) => {
    store += String(bytes);
  });
  storeCommand.stderr.resume();
  storeCommand.once("error", reject);
  storeCommand.once("exit", (code) =>
    code === 0 ? done() : reject(new Error("Cannot locate offline store")),
  );
  await promise;
  await run("pnpm", ["install", "--frozen-lockfile", "--offline", "--store-dir", store.trim()]);
  await run("pnpm", ["build"]);
  await run("pnpm", ["test"]);
  const cli = join(checkout, "apps/cli/dist/main.js");
  for (const args of [
    ["--output", "json", "capabilities"],
    ["--output", "json", "test", "scaffold", "--type", "backend"],
    ["--output", "json", "init", "--name", "reproduction", "--base-url", "http://127.0.0.1:7339"],
  ]) {
    const response = JSON.parse(await run(process.execPath, [cli, ...args]));
    if (!response.data || response.error)
      throw new Error("CLI smoke did not return successful canonical JSON");
  }
  const lock = JSON.parse(await readFile(join(checkout, "containers/images.lock.json"), "utf8"));
  await mkdir(join(output, ".."), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        schemaVersion: "1.0.0",
        method: "automatic",
        reviewer: "orchestrator-clean-checkout",
        observedAt: new Date().toISOString(),
        passed: true,
        commit,
        noModelKey: true,
        install: "frozen offline",
        commands,
        images: lock,
        limitations: [
          "Local populated pnpm cache required. Does not certify license/publication, other operating systems or Docker acceptance.",
        ],
      },
      null,
      2,
    ),
  );
} catch (failure) {
  error = failure;
  await mkdir(join(output, ".."), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        schemaVersion: "1.0.0",
        passed: false,
        observedAt: new Date().toISOString(),
        error: String(failure),
        commands,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
if (error) throw error;
