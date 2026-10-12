import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

// Orchestrator-only: run after committing the complete release candidate. No network install or model key.
// Usage: node reproduce-clean-checkout.mjs [source repository] [record directory]
// Records are write-once evidence (VAL-054): <commit>.json for a pass, <commit>.failed-<UTC time>.json for
// a failure. A passing record for a commit is never replaced and a failure never overwrites a pass.
const source = resolve(process.argv[2] ?? ".");
const outputDirectory = resolve(
  process.argv[3] ?? join(source, "validation/results/clean-checkout"),
);
if (outputDirectory.endsWith(".json"))
  throw new Error("The output argument is a record directory; records are named by commit");
const git = async (...args) =>
  (await promisify(execFile)("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: source }))
    .stdout;
// The clone below contains HEAD only, so tracked changes would make the recorded commit a false claim.
if ((await git("status", "--porcelain", "--untracked-files=no")).trim() !== "")
  throw new Error(
    "Clean-checkout reproduction requires a committed tree; commit tracked changes first",
  );
const sourceCommit = (await git("rev-parse", "HEAD")).trim();
const passedRecord = join(outputDirectory, `${sourceCommit}.json`);
if (
  await readFile(passedRecord).then(
    () => true,
    () => false,
  )
)
  throw new Error(`Clean-checkout reproduction already recorded for ${sourceCommit}`);
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
  if (commit !== sourceCommit)
    throw new Error("Cloned HEAD differs from the audited source commit");
  // Reuse dependency bytes and registry metadata, never operator config or credentials.
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
  const cache = process.env.XDG_CACHE_HOME
    ? join(process.env.XDG_CACHE_HOME, "pnpm")
    : join(process.env.HOME, ".cache", "pnpm");
  await run("pnpm", [
    "install",
    "--frozen-lockfile",
    "--offline",
    "--store-dir",
    store.trim(),
    `--config.cache-dir=${cache}`,
  ]);
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
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    passedRecord,
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
    { flag: "wx" },
  );
} catch (failure) {
  error = failure;
  const observedAt = new Date().toISOString();
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    join(outputDirectory, `${sourceCommit}.failed-${observedAt.replace(/[:.]/g, "-")}.json`),
    JSON.stringify(
      {
        schemaVersion: "1.0.0",
        passed: false,
        commit: sourceCommit,
        observedAt,
        error: String(failure),
        commands,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
if (error) throw error;
