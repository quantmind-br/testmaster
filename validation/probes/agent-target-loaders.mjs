// Operator-run probe: proves that real agents discover the files that `testmaster agent install`
// writes, and stop discovering them after removal.
// - pi and omp: their loaders are asked directly; no model request is made.
// - crush, goose, jcode, opencode, forge and hermes: each agent runs one turn against a local
//   OpenAI-compatible stub (or, with --quantforge <agent>, the QuantForge recording proxy), and the
//   chat completion request bodies show whether the managed instructions and the skill description
//   reached the model.
// Agent compliance is not claimed.
//
// Usage: node validation/probes/agent-target-loaders.mjs [agent ...] [--quantforge <agent>]...

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startProxy } from "../../evals/surface/proxy.mjs";
import { STUB_MODEL, startStubUpstream } from "./stub-upstream.mjs";

const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cli = join(repo, "apps/cli/dist/main.js");
const resultPath = join(repo, "validation/results/agent-target-loaders.json");
const OMP_SKILL_HEADING = "# TestMaster CLI";
// The skill marker is this many leading characters of the installed skill's description.
const SKILL_MARKER_CHARS = 100;
// The only credential an agent holds; the QuantForge proxy substitutes the real key upstream.
const STUB_API_KEY = "tm-stub-placeholder";
const PROMPT = "Reply with exactly: ready";
const QUANTFORGE_UPSTREAM = "https://api.quantforge.com.br";
const QUANTFORGE_MODEL = "gemini-3.8-flash-high";
const PHASES = ["beforeInstall", "installed", "afterRemove"];

/** Request-level agents: the TestMaster target installed for them and the expected installed result. */
const REQUEST_AGENTS = {
  crush: { target: "crush", installed: { instructionsLoaded: true, skillLoaded: true } },
  goose: { target: "goose", installed: { instructionsLoaded: true, skillLoaded: true } },
  jcode: { target: "jcode", installed: { instructionsLoaded: true, skillLoaded: true } },
  // opencode reads AGENTS.md and advertises skills from .agents/skills.
  opencode: { target: "codex", installed: { instructionsLoaded: true, skillLoaded: true } },
  // forge reads AGENTS.md; its project skills come only from .forge/skills.
  forge: { target: "codex", installed: { instructionsLoaded: true, skillLoaded: false } },
  // hermes reads AGENTS.md; project .agents/skills needs a trusted directory, and the isolated
  // HOME trusts none.
  hermes: { target: "codex", installed: { instructionsLoaded: true, skillLoaded: false } },
};
const LOADER_AGENTS = ["pi", "omp"];
const ALL_AGENTS = [...LOADER_AGENTS, ...Object.keys(REQUEST_AGENTS)];
const USAGE = `usage: node validation/probes/agent-target-loaders.mjs [${ALL_AGENTS.join("|")} ...] [--quantforge <agent>]...`;

function usageError(message) {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

const selected = [];
const quantforge = new Set();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--quantforge") {
    const agent = process.argv[++index];
    if (!agent || !(agent in REQUEST_AGENTS))
      usageError(`--quantforge needs a request-level agent, got ${agent ?? "nothing"}`);
    quantforge.add(agent);
  } else if (ALL_AGENTS.includes(argument)) {
    if (!selected.includes(argument)) selected.push(argument);
  } else usageError(`unknown argument: ${argument}`);
}
const agents = selected.length > 0 ? selected : ALL_AGENTS;
for (const agent of quantforge)
  if (!agents.includes(agent))
    usageError(`--quantforge ${agent} names an agent that is not probed`);
const quantforgeKey = process.env.QUANTFORGE_API_KEY;
if (quantforge.size > 0 && !quantforgeKey)
  usageError("--quantforge needs QUANTFORGE_API_KEY in the environment");
// Request-level agents run in their own process group, and their daemons are found through /proc.
if (process.platform !== "linux" && agents.some((agent) => agent in REQUEST_AGENTS))
  usageError(
    `request-level agents (${Object.keys(REQUEST_AGENTS).join(", ")}) need Linux /proc; on ${process.platform} probe only ${LOADER_AGENTS.join(" and ")}`,
  );

const piPackageDir =
  process.env.PI_PACKAGE_DIR ??
  join(homedir(), ".npm-global/lib/node_modules/@earendil-works/pi-coding-agent");
const binary = (agent) => process.env[`${agent.toUpperCase()}_BIN`] ?? agent;

const tmp = await mkdtemp(join(tmpdir(), "tm-agent-loaders-"));
const mismatches = [];
/** The agent run in progress, so that cancelling the probe also stops it and its daemons. */
let activeRun = null;
let cancelled = false;
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
])
  process.once(signal, async () => {
    // Set before any await: the sweep below ends the agent, and the next phase must not start
    // another one while the probe is shutting down.
    cancelled = true;
    // The agent is detached, so the terminal's signal never reaches its process group.
    if (activeRun) await sweep(activeRun.run, activeRun.group).catch(() => {});
    await rm(tmp, { recursive: true, force: true });
    process.exit(code);
  });
let result;

function run(command, args, options) {
  const done = spawnSync(command, args, { encoding: "utf8", ...options });
  if (done.error) throw done.error;
  return done;
}

/** Runs the built TestMaster CLI in `ws` and returns its parsed JSON envelope. */
function testmaster(ws, home, ...args) {
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
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
  return JSON.parse(done.stdout);
}

/** Creates a git workspace initialised for TestMaster and returns its paths. */
async function workspace(name) {
  const ws = join(tmp, name, "repo");
  const home = join(tmp, name, "home");
  await mkdir(ws, { recursive: true });
  await mkdir(join(home, "tmp"), { recursive: true });
  run("git", ["init", "-q"], { cwd: ws });
  testmaster(ws, home, "init", "--mode", "local");
  return { ws, home };
}

/** Each target's skill path, as `agent list` reports it. */
function skillPaths(ws, home) {
  const listing = testmaster(ws, home, "agent", "list");
  return Object.fromEntries(listing.data.map((item) => [item.target, item.skillPath]));
}

const instructionsMarker = (skillPath) => `Read ${skillPath} before planning`;

/** The version an agent binary reports, or null when the binary does not exist. */
function binaryVersion(command) {
  const done = spawnSync(command, ["--version"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: homedir(), LANG: process.env.LANG ?? "C.UTF-8" },
  });
  if (done.error?.code === "ENOENT") return null;
  if (done.error) throw done.error;
  if (done.status !== 0)
    throw new Error(`${command} --version exited ${done.status}\nstderr: ${done.stderr}`);
  return (done.stdout.trim() || done.stderr.trim()).split("\n")[0].trim();
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

// ---------------------------------------------------------------------------------------------
// pi and omp: loader checks.

async function probePi(ws, agentDir, skillPath, projectTrusted) {
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
  const expectedSkill = join(ws, skillPath);
  return {
    skillLoaded: loader
      .getSkills()
      .skills.some(
        (skill) => skill.name === "testmaster" && resolve(skill.filePath) === expectedSkill,
      ),
    instructionsLoaded: loader
      .getAppendSystemPrompt()
      .join("\n")
      .includes(instructionsMarker(skillPath)),
  };
}

function ompSystemPrompt(ompBin, ws) {
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
      child.stdin.end();
      // The answer is in; give omp a moment to exit on stdin EOF before stopping it.
      const kill = setTimeout(() => child.kill("SIGTERM"), 5000);
      child.once("exit", () => clearTimeout(kill));
      if (failure) reject(failure);
      else resolvePrompt(value);
    };
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

async function probeOmp(ompBin, ws, skillPath) {
  const prompt = await ompSystemPrompt(ompBin, ws);
  const read = run(ompBin, ["read", "skill://testmaster"], { cwd: ws, env: process.env });
  return {
    skillLoaded: read.status === 0 && read.stdout.includes(OMP_SKILL_HEADING),
    instructionsLoaded: prompt.includes(instructionsMarker(skillPath)),
  };
}

async function probeLoaders(entries) {
  const { ws, home } = await workspace("loaders");
  const paths = skillPaths(ws, home);
  const none = { skillLoaded: false, instructionsLoaded: false };
  const all = { skillLoaded: true, instructionsLoaded: true };
  const piAgentDir = join(tmp, "loaders", "pi-agent");
  const ompBin = binary("omp");
  const failed = new Set();
  // Runs one loader check: stores the observation and compares it. A failure is recorded against
  // that agent alone, and its later checks are skipped so it cannot pass with missing phases.
  const observe = async (agent, phase, work, expected) => {
    if (!entries[agent] || failed.has(agent)) return;
    const [name, mode] = phase.split(".");
    try {
      const observed = await work();
      if (mode) entries[agent].phases[name] = { ...entries[agent].phases[name], [mode]: observed };
      else entries[agent].phases[name] = observed;
      expect(agent, phase, observed, expected);
    } catch (failure) {
      failed.add(agent);
      mismatches.push({
        agent,
        phase,
        field: "error",
        observed: String(failure?.message ?? failure),
      });
    }
  };
  const pi = (trusted) => () => probePi(ws, piAgentDir, paths.pi, trusted);
  const omp = () => probeOmp(ompBin, ws, paths.omp);

  await observe("pi", "beforeInstall.trusted", pi(true), none);
  await observe("omp", "beforeInstall", omp, none);

  for (const target of Object.keys(entries))
    testmaster(ws, home, "agent", "install", "--target", target, "--yes");
  await observe("pi", "installed.trusted", pi(true), all);
  await observe("pi", "installed.untrusted", pi(false), none);
  await observe("omp", "installed", omp, all);

  for (const target of Object.keys(entries))
    testmaster(ws, home, "agent", "remove", "--target", target, "--yes");
  await observe("pi", "afterRemove.trusted", pi(true), none);
  await observe("omp", "afterRemove", omp, none);
}

// ---------------------------------------------------------------------------------------------
// Request-level agents: one turn against the stub (or the QuantForge proxy) per phase.

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function put(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/** Writes the agent's isolated configuration and returns its extra environment and argv. */
const RECIPES = {
  async crush({ home, base, model }) {
    await put(
      join(home, ".config/crush/crush.json"),
      json({
        providers: {
          tmstub: {
            type: "openai-compat",
            base_url: base,
            api_key: "$TM_STUB_API_KEY",
            models: [
              {
                id: model,
                name: model,
                context_window: 128000,
                default_max_tokens: 1024,
                can_reason: false,
                supports_attachments: false,
                cost_per_1m_in: 0,
                cost_per_1m_out: 0,
              },
            ],
          },
        },
        models: {
          large: { provider: "tmstub", model },
          small: { provider: "tmstub", model },
        },
        options: { disable_provider_auto_update: true, disable_metrics: true },
      }),
    );
    return {
      env: {
        CRUSH_GLOBAL_CONFIG: join(home, ".config/crush"),
        CRUSH_GLOBAL_DATA: join(home, ".local/share/crush"),
        CRUSH_DISABLE_PROVIDER_AUTO_UPDATE: "1",
        CRUSH_DISABLE_DEFAULT_PROVIDERS: "1",
        CRUSH_DISABLE_METRICS: "1",
        DO_NOT_TRACK: "1",
      },
      args: ["run", "-q", PROMPT],
    };
  },
  async goose({ home, base, model }) {
    await put(
      join(home, "goose/config/custom_providers/tmstub.json"),
      json({
        name: "tmstub",
        engine: "openai",
        display_name: "tmstub",
        description: "TestMaster probe stub",
        api_key_env: "TM_STUB_API_KEY",
        base_url: base.replace(/\/v1$/, ""),
        requires_auth: true,
        dynamic_models: false,
        models: [
          {
            name: model,
            context_limit: 128000,
            input_token_cost: null,
            output_token_cost: null,
            currency: null,
            reasoning: false,
          },
        ],
      }),
    );
    return {
      env: {
        GOOSE_PATH_ROOT: join(home, "goose"),
        GOOSE_DISABLE_KEYRING: "1",
        GOOSE_PROVIDER: "tmstub",
        GOOSE_MODEL: model,
      },
      args: ["run", "--no-session", "--provider", "tmstub", "--model", model, "-t", PROMPT, "-q"],
    };
  },
  async jcode({ home, base, model }) {
    await put(
      join(home, ".jcode/config.toml"),
      [
        "[providers.tmstub]",
        'type = "openai-compatible"',
        `base_url = ${JSON.stringify(base)}`,
        'auth = "bearer"',
        'api_key_env = "TM_STUB_API_KEY"',
        `default_model = ${JSON.stringify(model)}`,
        "requires_api_key = true",
        "",
        "[[providers.tmstub.models]]",
        `id = ${JSON.stringify(model)}`,
        "context_window = 128000",
        "",
      ].join("\n"),
    );
    await mkdir(join(home, "run"), { recursive: true });
    return {
      env: {
        JCODE_HOME: join(home, ".jcode"),
        JCODE_RUNTIME_DIR: join(home, "run"),
        JCODE_SOCKET: join(home, "run/jcode.sock"),
        JCODE_NO_AUTO_UPDATE: "1",
        JCODE_NO_TELEMETRY: "1",
        JCODE_NON_INTERACTIVE: "1",
      },
      args: ["--provider-profile", "tmstub", "-m", model, "--no-update", "run", PROMPT],
    };
  },
  async opencode({ home, base, model }) {
    const config = join(home, ".config/opencode/opencode.json");
    await put(
      config,
      json({
        $schema: "https://opencode.ai/config.json",
        provider: {
          tmstub: {
            npm: "@ai-sdk/openai-compatible",
            name: "tmstub",
            options: { baseURL: base, apiKey: "{env:TM_STUB_API_KEY}" },
            models: { [model]: { name: model } },
          },
        },
        model: `tmstub/${model}`,
      }),
    );
    return {
      env: {
        OPENCODE_CONFIG: config,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
      },
      args: ["run", "--standalone", "-m", `tmstub/${model}`, PROMPT],
    };
  },
  async forge({ home, base, model }) {
    await put(
      join(home, ".forge/.forge.toml"),
      [
        "[session]",
        'provider_id = "tmstub"',
        `model_id = ${JSON.stringify(model)}`,
        "",
        "[updates]",
        "auto_update = false",
        "",
      ].join("\n"),
    );
    await put(
      join(home, ".forge/provider.json"),
      json([
        {
          id: "tmstub",
          auth_methods: ["api_key"],
          url_param_vars: [],
          response_type: "OpenAI",
          url: `${base}/chat/completions`,
          models: [
            {
              id: model,
              name: model,
              description: "stub",
              context_length: 128000,
              tools_supported: true,
              supports_parallel_tool_calls: false,
              supports_reasoning: false,
              input_modalities: ["text"],
            },
          ],
        },
      ]),
    );
    // Forge no longer reads API keys from environment variables: a provider is available only
    // with a credential in <base>/.credentials.json (forge_repo provider_repo.rs create_provider).
    await put(
      join(home, ".forge/.credentials.json"),
      json([{ id: "tmstub", auth_details: { api_key: STUB_API_KEY } }]),
    );
    return { env: { FORGE_CONFIG: join(home, ".forge") }, args: ["-p", PROMPT] };
  },
  async hermes({ home, base, model }) {
    await put(
      join(home, ".hermes/config.yaml"),
      [
        "model:",
        "  provider: tmstub",
        `  default: ${JSON.stringify(model)}`,
        "providers:",
        "  tmstub:",
        `    api: ${JSON.stringify(base)}`,
        "    transport: chat_completions",
        "    key_env: TM_STUB_API_KEY",
        `    default_model: ${JSON.stringify(model)}`,
        "    discover_models: false",
        "    models:",
        `      ${JSON.stringify(model)}:`,
        "        context_length: 128000",
        "auxiliary:",
        "  title_generation:",
        "    enabled: false",
        "",
      ].join("\n"),
    );
    return {
      env: { HERMES_HOME: join(home, ".hermes") },
      args: ["-z", PROMPT, "-m", model, "--provider", "tmstub"],
    };
  },
};

/** Processes whose environment carries `TM_PROBE_RUN=<run>`. */
async function taggedProcesses(run) {
  const tag = `TM_PROBE_RUN=${run}`;
  const found = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let environ;
    try {
      environ = await readFile(join("/proc", entry, "environ"), "latin1");
    } catch {
      continue;
    }
    if (environ.split("\0").includes(tag)) found.push(Number(entry));
  }
  return found;
}

/** Kills every process the agent left behind, including daemons that left its process group. */
async function sweep(run, group) {
  try {
    process.kill(-group, "SIGKILL");
  } catch {
    // The group is already empty.
  }
  for (;;) {
    const left = await taggedProcesses(run);
    if (left.length === 0) return;
    for (const pid of left) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (failure) {
        // ESRCH: it exited between the scan and the kill. EPERM never clears, so report it.
        if (failure?.code === "EPERM") throw new Error(`cannot kill probe process ${pid} (EPERM)`);
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

/** Runs the agent once in `ws` and resolves when it and everything it started are gone. */
function runAgent(command, args, { ws, env }) {
  return new Promise((resolveRun, reject) => {
    // The probe is exiting; it never resolves, so no later phase runs.
    if (cancelled) return;
    const child = spawn(command, args, {
      cwd: ws,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const stdout = [];
    const stderr = [];
    let exit;
    let swept;
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (failure) => {
      activeRun = null;
      reject(failure);
    });
    if (child.pid !== undefined) activeRun = { run: env.TM_PROBE_RUN, group: child.pid };
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      swept = sweep(env.TM_PROBE_RUN, child.pid);
    });
    // Resolve only once the agent, its daemons and its pipes are all gone. After a spawn error
    // there is no exit, and the error already rejected.
    child.on("close", () =>
      swept?.then(
        () => {
          activeRun = null;
          resolveRun({
            exitCode: exit.code,
            signal: exit.signal,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        },
        (failure) => {
          activeRun = null;
          reject(failure);
        },
      ),
    );
  });
}

/** Every string value of a parsed JSON body, or the raw text when it is not JSON. */
function bodyText(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const strings = [];
  const walk = (value) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(parsed);
  return strings.join("\n");
}

/** Starts the upstream for one phase and returns `{ base, close, requests() }`. */
async function upstream(agent, phase) {
  if (!quantforge.has(agent)) {
    const stub = await startStubUpstream();
    return { base: stub.base, close: stub.close, requests: async () => stub.requests };
  }
  const directory = join(tmp, agent, `${phase}-proxy`);
  const proxy = await startProxy({
    upstream: QUANTFORGE_UPSTREAM,
    directory,
    apiKey: quantforgeKey,
  });
  return {
    base: `${proxy.url}/v1`,
    close: proxy.close,
    requests: async () => {
      let log = "";
      try {
        log = await readFile(proxy.log, "utf8");
      } catch {
        return [];
      }
      const records = log
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      return Promise.all(
        records.map(async (record) => ({
          method: record.method,
          path: new URL(record.path ?? "/", "http://proxy").pathname,
          raw: await readFile(join(directory, "requests", `${record.seq}.json`), "utf8"),
        })),
      );
    },
  };
}

async function probeRequestAgent(agent, entry) {
  const { target } = REQUEST_AGENTS[agent];
  const command = binary(agent);
  const model = quantforge.has(agent) ? QUANTFORGE_MODEL : STUB_MODEL;
  const { ws, home } = await workspace(agent);
  const skillPath = skillPaths(ws, home)[target];
  const bodies = {};
  let skillMarker;

  for (const phase of PHASES) {
    if (phase === "installed") {
      testmaster(ws, home, "agent", "install", "--target", target, "--yes");
      const skill = await readFile(join(ws, skillPath), "utf8");
      const description = /^description:\s*(.+)$/m
        .exec(skill)?.[1]
        ?.trim()
        .replace(/^(['"])(.*)\1$/, "$2");
      if (!description) throw new Error(`${skillPath} has no description line`);
      // jcode clips skill descriptions to 120 characters in its prompt, so only a prefix is
      // guaranteed to reach the model verbatim.
      skillMarker = description.slice(0, SKILL_MARKER_CHARS);
    }
    if (phase === "afterRemove")
      testmaster(ws, home, "agent", "remove", "--target", target, "--yes");
    const up = await upstream(agent, phase);
    let outcome;
    try {
      const recipe = await RECIPES[agent]({ home, base: up.base, model });
      const env = {
        PATH: process.env.PATH ?? "",
        LANG: process.env.LANG ?? "C.UTF-8",
        TERM: "dumb",
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local/share"),
        XDG_STATE_HOME: join(home, ".local/state"),
        XDG_CACHE_HOME: join(home, ".cache"),
        TMPDIR: join(home, "tmp"),
        TM_STUB_API_KEY: STUB_API_KEY,
        TM_PROBE_RUN: randomUUID(),
        ...recipe.env,
      };
      outcome = await runAgent(command, recipe.args, { ws, env });
    } finally {
      await up.close();
    }
    const requests = await up.requests();
    bodies[phase] = requests
      .filter((request) => request.method === "POST" && request.path.endsWith("/chat/completions"))
      .map((request) => bodyText(request.raw));
    entry.phases[phase] = {
      exitCode: outcome.exitCode,
      ...(outcome.signal ? { signal: outcome.signal } : {}),
      requests: requests.length,
      completionRequests: bodies[phase].length,
    };
    if (phase === "installed" && agent === "crush") {
      let ignore = "";
      try {
        ignore = await readFile(join(ws, ".crush/.gitignore"), "utf8");
      } catch {
        // crush did not create its data directory.
      }
      entry.observations = { crushDataDirIgnored: ignore.split("\n").includes("*") };
    }
    if (outcome.exitCode !== 0 || bodies[phase].length < 1)
      mismatches.push({
        agent,
        phase,
        field: "run",
        expected: { exitCode: 0, completionRequests: ">= 1" },
        observed: {
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          completionRequests: bodies[phase].length,
        },
        stderrTail: outcome.stderr.slice(-4096),
      });
  }

  const instructions = instructionsMarker(skillPath);
  const none = { instructionsLoaded: false, skillLoaded: false };
  for (const phase of PHASES) {
    const observed = {
      instructionsLoaded: bodies[phase].some((text) => text.includes(instructions)),
      skillLoaded: bodies[phase].some((text) => text.includes(skillMarker)),
    };
    Object.assign(entry.phases[phase], observed);
    expect(agent, phase, observed, phase === "installed" ? REQUEST_AGENTS[agent].installed : none);
  }
}

// ---------------------------------------------------------------------------------------------

const entries = {};
try {
  for (const agent of agents) {
    const requestLevel = agent in REQUEST_AGENTS;
    let version;
    if (agent === "pi") {
      try {
        version = JSON.parse(await readFile(join(piPackageDir, "package.json"), "utf8")).version;
      } catch (failure) {
        if (failure?.code !== "ENOENT")
          mismatches.push({ agent, phase: "version", field: "error", observed: String(failure) });
        version = null;
      }
    } else {
      try {
        version = binaryVersion(binary(agent));
      } catch (failure) {
        // A broken binary makes only this agent unavailable; the others are still probed.
        mismatches.push({
          agent,
          phase: "version",
          field: "error",
          observed: String(failure?.message ?? failure),
        });
        version = null;
      }
    }
    entries[agent] = {
      target: requestLevel ? REQUEST_AGENTS[agent].target : agent,
      status: version === null ? "unavailable" : "probed",
      version,
      method: requestLevel ? "model-request" : "loader",
      upstream: requestLevel ? (quantforge.has(agent) ? "quantforge" : "stub") : null,
      phases: {},
    };
  }

  const loaders = Object.fromEntries(
    LOADER_AGENTS.filter((agent) => entries[agent]?.status === "probed").map((agent) => [
      agent,
      entries[agent],
    ]),
  );
  if (Object.keys(loaders).length > 0) {
    try {
      await probeLoaders(loaders);
    } catch (failure) {
      for (const agent of Object.keys(loaders))
        mismatches.push({
          agent,
          phase: "probe",
          field: "error",
          observed: String(failure?.message ?? failure),
        });
    }
  }
  for (const agent of agents) {
    if (!(agent in REQUEST_AGENTS) || entries[agent].status !== "probed") continue;
    try {
      await probeRequestAgent(agent, entries[agent]);
    } catch (failure) {
      mismatches.push({
        agent,
        phase: "probe",
        field: "error",
        observed: String(failure?.message ?? failure),
      });
    }
  }
  for (const [agent, entry] of Object.entries(entries))
    entry.passed =
      entry.status === "probed" && !mismatches.some((mismatch) => mismatch.agent === agent);

  result = {
    schemaVersion: "2.0.0",
    observedAt: new Date().toISOString(),
    testmasterCommit: run("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim(),
    agents: entries,
    limitations: [
      "pi and omp: loader discovery only; no model request was made. pi used an empty temporary agent directory; omp used the operator's ~/.omp configuration.",
      "Request-level agents ran one turn each with an isolated HOME and an environment built from scratch, against a local OpenAI-compatible stub unless upstream is quantforge.",
      `Request-level instructionsLoaded means the managed instructions marker reached a chat completion request; skillLoaded means the installed skill's description reached the model, matched on its first ${SKILL_MARKER_CHARS} characters because jcode clips skill descriptions to 120.`,
      "opencode, forge and hermes were probed with the codex target (AGENTS.md, .agents/skills). forge advertises project skills only from .forge/skills, and hermes reads project .agents/skills only in a trusted directory, so skillLoaded is expected false for both.",
      "Agent compliance is not claimed.",
    ],
    passed:
      mismatches.length === 0 && Object.values(entries).every((entry) => entry.status === "probed"),
    ...(mismatches.length > 0 ? { mismatches } : {}),
  };
} catch (failure) {
  result = {
    schemaVersion: "2.0.0",
    observedAt: new Date().toISOString(),
    agents: entries,
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
