// Operator-run probe: proves that the real pi and oh-my-pi loaders discover the files that
// `testmaster agent install --target pi|omp` writes, and stop discovering them after removal.
// Loader discovery only; no model request is made and agent compliance is not claimed.
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const piPackageDir =
  process.env.PI_PACKAGE_DIR ??
  join(homedir(), ".npm-global/lib/node_modules/@earendil-works/pi-coding-agent");
const ompBin = process.env.OMP_BIN ?? "omp";
const cli = join(repo, "apps/cli/dist/main.js");
const resultPath = join(repo, "validation/results/agent-target-loaders.json");
const PI_MARKER = "Read .pi/skills/testmaster/SKILL.md before planning";
const OMP_MARKER = "Read .omp/skills/testmaster/SKILL.md before planning";
const OMP_SKILL_HEADING = "# TestMaster CLI";

const tmp = await mkdtemp(join(tmpdir(), "tm-agent-loaders-"));
const ws = join(tmp, "repo");
const mismatches = [];
let result;

function run(command, args, options) {
  const done = spawnSync(command, args, { encoding: "utf8", ...options });
  if (done.error) throw done.error;
  return done;
}

function testmaster(...args) {
  const env = {
    ...process.env,
    HOME: join(tmp, "home"),
    XDG_CONFIG_HOME: join(tmp, "home/.config"),
    XDG_DATA_HOME: join(tmp, "home/.local/share"),
    TESTMASTER_DATA_DIR: join(ws, ".testmaster"),
    TESTMASTER_OFFLINE: "true",
    TESTMASTER_NO_TELEMETRY: "true",
  };
  for (const name of [
    "TESTMASTER_PROJECT_ID",
    "TESTMASTER_ENDPOINT",
    "TESTMASTER_PROFILE",
    "TESTMASTER_API_KEY",
    "TESTMASTER_MODEL_API_KEY",
  ])
    delete env[name];
  const done = run(process.execPath, [cli, ...args, "--output", "json", "--no-color"], {
    cwd: ws,
    env,
  });
  if (done.status !== 0)
    throw new Error(
      `testmaster ${args.join(" ")} exited ${done.status}\nstdout: ${done.stdout}\nstderr: ${done.stderr}`,
    );
}

async function probePi(projectTrusted) {
  const agentDir = join(tmp, "pi-agent");
  await mkdir(agentDir, { recursive: true });
  const { DefaultResourceLoader, SettingsManager } = await import(
    pathToFileURL(join(piPackageDir, "dist/index.js")).href
  );
  const loader = new DefaultResourceLoader({
    cwd: ws,
    agentDir,
    settingsManager: SettingsManager.inMemory({}, { projectTrusted }),
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  const expectedSkill = join(ws, ".pi/skills/testmaster/SKILL.md");
  return {
    skillLoaded: loader
      .getSkills()
      .skills.some(
        (skill) => skill.name === "testmaster" && resolve(skill.filePath) === expectedSkill,
      ),
    instructionsLoaded: loader.getAppendSystemPrompt().join("\n").includes(PI_MARKER),
  };
}

function ompSystemPrompt() {
  return new Promise((resolvePrompt, reject) => {
    const child = spawn(
      ompBin,
      ["--mode", "rpc", "--no-session", "--no-extensions", "--no-lsp", "--cwd", ws],
      { cwd: ws, env: process.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (failure, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      child.stdin.end();
      const kill = setTimeout(() => child.kill("SIGTERM"), 5000);
      child.once("exit", () => clearTimeout(kill));
      if (failure) reject(failure);
      else resolvePrompt(value);
    };
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`omp rpc timed out after 180 s\nstderr tail: ${stderr.slice(-4096)}`));
    }, 180_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf("\n");
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message?.id !== "tm-state" || message.type !== "response") continue;
        if (message.success !== true)
          return finish(new Error(`omp get_state failed: ${JSON.stringify(message)}`));
        const prompt = message.data?.systemPrompt;
        if (!Array.isArray(prompt))
          return finish(new Error("omp get_state returned no systemPrompt array"));
        return finish(undefined, prompt.join("\n"));
      }
    });
    child.on("error", (failure) => finish(failure));
    child.on("exit", (code) =>
      finish(
        new Error(`omp rpc exited ${code} before responding\nstderr tail: ${stderr.slice(-4096)}`),
      ),
    );
    child.stdin.write(`${JSON.stringify({ id: "tm-state", type: "get_state" })}\n`);
  });
}

async function probeOmp() {
  const prompt = await ompSystemPrompt();
  const read = run(ompBin, ["read", "skill://testmaster"], { cwd: ws, env: process.env });
  return {
    skillLoaded: read.status === 0 && read.stdout.includes(OMP_SKILL_HEADING),
    instructionsLoaded: prompt.includes(OMP_MARKER),
  };
}

function expect(agent, phase, observed, expected) {
  for (const field of ["skillLoaded", "instructionsLoaded"])
    if (observed[field] !== expected[field])
      mismatches.push({
        agent,
        phase,
        field,
        expected: expected[field],
        observed: observed[field],
      });
}

try {
  await mkdir(ws, { recursive: true });
  run("git", ["init", "-q"], { cwd: ws });
  const piVersion = JSON.parse(await readFile(join(piPackageDir, "package.json"), "utf8")).version;
  const ompVersion = run(ompBin, ["--version"], { env: process.env }).stdout.trim();
  const none = { skillLoaded: false, instructionsLoaded: false };
  const all = { skillLoaded: true, instructionsLoaded: true };

  testmaster("init", "--mode", "local");
  const pi = { beforeInstall: { trusted: await probePi(true) } };
  const omp = { beforeInstall: await probeOmp() };
  expect("pi", "beforeInstall.trusted", pi.beforeInstall.trusted, none);
  expect("omp", "beforeInstall", omp.beforeInstall, none);

  testmaster("agent", "install", "--target", "pi", "--yes");
  testmaster("agent", "install", "--target", "omp", "--yes");
  pi.installed = { trusted: await probePi(true), untrusted: await probePi(false) };
  omp.installed = await probeOmp();
  expect("pi", "installed.trusted", pi.installed.trusted, all);
  expect("pi", "installed.untrusted", pi.installed.untrusted, none);
  expect("omp", "installed", omp.installed, all);

  testmaster("agent", "remove", "--target", "pi", "--yes");
  testmaster("agent", "remove", "--target", "omp", "--yes");
  pi.afterRemove = { trusted: await probePi(true) };
  omp.afterRemove = await probeOmp();
  expect("pi", "afterRemove.trusted", pi.afterRemove.trusted, none);
  expect("omp", "afterRemove", omp.afterRemove, none);

  result = {
    schemaVersion: "1.0.0",
    observedAt: new Date().toISOString(),
    testmasterCommit: run("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim(),
    pi: { package: "@earendil-works/pi-coding-agent", version: piVersion, phases: pi },
    omp: { version: ompVersion, phases: omp },
    limitations: [
      "Loader discovery only; no model request was made and agent compliance is not claimed.",
      "pi used an empty temporary agent directory; omp used the operator's ~/.omp configuration.",
    ],
    passed: mismatches.length === 0,
    ...(mismatches.length > 0 ? { mismatches } : {}),
  };
} catch (failure) {
  result = {
    schemaVersion: "1.0.0",
    observedAt: new Date().toISOString(),
    passed: false,
    error: failure instanceof Error ? failure.message : String(failure),
    ...(mismatches.length > 0 ? { mismatches } : {}),
  };
} finally {
  await rm(tmp, { recursive: true, force: true });
}

await mkdir(dirname(resultPath), { recursive: true });
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.passed ? 0 : 1);
