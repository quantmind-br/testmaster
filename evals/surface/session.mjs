// One agent session of the surface experiment (PLAN.md §10). It prepares a fresh workspace and a
// fresh HOME, connects the arm's surface (MCP at the frozen A0 catalog, MCP at the current catalog,
// or none) and the arm's skill, runs the driving agent (omp, headless) with no deadline, and keeps
// every log the metrics are computed from:
//   model/model-requests.ndjson  each model request the agent sent and the usage the provider reported
//   mcp.ndjson                    each tools/list and tools/call exchange with the TestMaster MCP server
//   cli.ndjson + cli/             each `testmaster` invocation, its stdout and stderr
//   events.jsonl                  the agent's own event stream (turns, tool calls, tool results)
//   session.json                  the session record: spec, hashes, timing, exit
// Nothing here stops a session: the agent runs until it ends its turn (premise 1).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startBroker } from "./broker.mjs";
import { startProxy } from "./proxy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const repo = resolve(here, "../..");
export const realCli = join(repo, "apps/cli/dist/main.js");
const UPSTREAM = "https://api.quantforge.com.br";
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
// The agent's PATH holds only the CLI collector and system directories, so the driving agent is
// resolved here, from the harness's own PATH.
const OMP =
  process.env.SURFACE_OMP ??
  (process.env.PATH ?? "")
    .split(":")
    .map((directory) => join(directory, "omp"))
    .find((candidate) => existsSync(candidate));
if (!OMP) throw new Error("omp is not on PATH; set SURFACE_OMP");
/** Every regular file of a directory tree as `{path (relative), sha256, bytes}`, sorted. */
export function treeManifest(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const bytes = readFileSync(path);
        files.push({ path: relative(root, path), sha256: sha256(bytes), bytes: bytes.length });
      }
    }
  };
  walk(root);
  return files;
}

/** The hash of a tree manifest: one line `sha256  path` per file. */
export const treeHash = (files) =>
  sha256(files.map((file) => `${file.sha256}  ${file.path}`).join("\n"));

/** Runs a harness command; asynchronous because this process also hosts the proxies. */
function run(command, args, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", fail);
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      if (code === 0) return done(stdout);
      fail(
        new Error(`${command} ${args.join(" ")} exited ${code}: ${Buffer.concat(err) || stdout}`),
      );
    });
  });
}

/** The environment of a user whose HOME is `home`: system PATH, no machine-wide configuration. */
export function userEnv(home) {
  return {
    PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "dumb",
    QUANTFORGE_API_KEY: process.env.QUANTFORGE_API_KEY,
    // Docker and the browser runtime come from the machine, as for any user.
    ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
    PLAYWRIGHT_BROWSERS_PATH:
      process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright"),
  };
}

/**
 * Runs the real CLI as the session's user (harness work, not an agent call: nothing is logged)
 * and returns its parsed JSON envelope with the exit code. No deadline.
 */
export function sessionCli(session, args) {
  // Asynchronous: the proxies serving the target and the model live in this process.
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [realCli, "--cwd", session.workspace, ...args, "--output", "json"],
      {
        cwd: session.workspace,
        env: userEnv(session.home),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", fail);
    child.on("close", (code) => {
      let envelope = null;
      try {
        envelope = JSON.parse(Buffer.concat(out).toString("utf8"));
      } catch {
        // Not an envelope: the exit code and stderr say what happened.
      }
      done({ exit: code, envelope, stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

/** The agent's provider: the recording proxy in front of QuantForge, one model. */
function modelsYml(proxyUrl, model) {
  return [
    "providers:",
    "  surface:",
    `    baseUrl: ${proxyUrl}/v1`,
    "    api: openai-completions",
    "    apiKey: QUANTFORGE_API_KEY",
    "    models:",
    `      - id: ${model}`,
    `        name: "${model}"`,
    "        reasoning: true",
    "        input: [text]",
    "        contextWindow: 1000000",
    "        maxTokens: 65536",
    "        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
    "",
  ].join("\n");
}

/**
 * Runs one session. `spec`:
 *   { id, arm: {id, mcp: "a0"|"current"|"none", skillDir}, model, app: {name, repo, commit?,
 *     source? (a directory copied instead of cloned), targetUrl, envFile?, secretsFile?},
 *     prompt (text), internal: {provider, model}, a0ToolsList }
 * `directory` is the session directory, created fresh.
 */
export async function runSession(spec, directory) {
  if (existsSync(directory) && readdirSync(directory).length > 0)
    throw new Error(`Session directory ${directory} is not empty`);
  // The session's /tmp is a bind mount over the host's: a directory below /tmp would vanish.
  if (resolve(directory).startsWith("/tmp/"))
    throw new Error(`Session directory ${directory} must not be below /tmp`);
  const home = join(directory, "home");
  const ws = join(directory, "ws", spec.app.name);
  const bin = join(directory, "bin");
  for (const path of [home, dirname(ws), bin, join(directory, "cli")])
    mkdirSync(path, { recursive: true });

  // Workspace: the target repository at its frozen commit (or a copied fixture), nothing else.
  if (spec.app.source) {
    const excluded = new Set(spec.app.sourceExclude ?? []);
    cpSync(spec.app.source, ws, {
      recursive: true,
      filter: (path) => !excluded.has(relative(spec.app.source, path).split("/")[0]),
    });
  } else {
    // A shallow copy of the frozen commit: no alternates pointing back into the source checkout,
    // which the agent's sandbox hides.
    await run("git", ["init", "--quiet", ws]);
    await run("git", [
      "-C",
      ws,
      "fetch",
      "--quiet",
      "--depth",
      "1",
      spec.app.repo,
      spec.app.commit,
    ]);
    await run("git", ["-C", ws, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  }

  // HOME: the TestMaster model profile and policy (no key: `apiKeyEnv` names the variable), the
  // agent provider, and the MCP registration of the arm.
  const configHome = join(home, ".config", "testmaster");
  mkdirSync(configHome, { recursive: true });
  writeFileSync(join(configHome, "profiles.json"), JSON.stringify(spec.internal.profiles, null, 2));
  writeFileSync(join(configHome, "policy.json"), JSON.stringify(spec.internal.policy));
  const agentHome = join(home, ".omp", "agent");
  mkdirSync(agentHome, { recursive: true });

  // `testmaster` on PATH (and the MCP server command) is the broker client: the command runs
  // outside the agent's sandbox, which hides this checkout (see broker-client.mjs).
  const tmp = join(directory, "tmp");
  mkdirSync(tmp, { recursive: true });
  const client = join(bin, "broker-client.mjs");
  cpSync(join(here, "broker-client.mjs"), client);
  const user = userEnv(home);
  const env = {
    ...user,
    TMPDIR: tmp,
    PATH: `${bin}:${user.PATH}`,
    ...(spec.app.env ?? {}),
  };
  // Outside the sandbox, a command still sees the session's /tmp at /tmp, as the agent does.
  const privateTmp = (cwd, command) => [
    "--dev-bind",
    "/",
    "/",
    "--bind",
    tmp,
    "/tmp",
    "--chdir",
    cwd,
    "--",
    process.execPath,
    ...command,
  ];
  const collector = {
    SURFACE_REAL_CLI: realCli,
    SURFACE_CLI_LOG: join(directory, "cli.ndjson"),
    SURFACE_CLI_CAPTURE: join(directory, "cli"),
    ...(spec.app.secretsFile ? { SURFACE_SECRETS: spec.app.secretsFile } : {}),
  };
  let mcpServe = null;
  const broker = await startBroker((header) => {
    if (header.kind === "cli")
      return {
        command: "bwrap",
        args: privateTmp(header.cwd, [join(here, "cli-wrapper.mjs"), ...header.argv]),
        env: { ...header.env, ...collector },
      };
    if (header.kind === "mcp" && mcpServe)
      return { command: "bwrap", args: privateTmp(ws, mcpServe), env };
    throw new Error(`no ${header.kind} surface in this session`);
  });
  const wrapper = join(bin, "testmaster");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec "${process.execPath}" "${client}" "${broker.socket}" cli "$@"\n`,
  );
  chmodSync(wrapper, 0o755);

  // Setup identical in every arm: the workspace is initialized for the target, and a token exists
  // for the MCP server. Not logged as agent calls (the CLI is run directly).
  const setup = (args) => run(process.execPath, [realCli, "--cwd", ws, ...args], { env, cwd: ws });
  await setup([
    "init",
    "--mode",
    "local",
    "--name",
    spec.app.name,
    "--base-url",
    spec.app.targetUrl,
  ]);
  const tokenFile = join(home, ".local", "share", "testmaster", "session.token");
  mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
  await setup(["token", "issue", "--token-file", tokenFile]);

  if (spec.arm.mcp !== "none") {
    mcpServe = [
      join(here, "mcp-proxy.mjs"),
      "--log",
      join(directory, "mcp.ndjson"),
      ...(spec.arm.mcp === "a0" ? ["--tools-list", spec.a0ToolsList] : []),
      "--",
      process.execPath,
      realCli,
      "--cwd",
      ws,
      "mcp",
      "serve",
      "--transport",
      "stdio",
      "--root",
      ws,
      "--token-file",
      tokenFile,
    ];
    writeFileSync(
      join(agentHome, "mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            testmaster: {
              command: process.execPath,
              args: [client, broker.socket, "mcp"],
              timeout: 0,
              enabled: true,
            },
          },
        },
        null,
        2,
      ),
    );
  }

  // The arm's skill, as a project skill of the workspace.
  const skillTarget = join(ws, ".omp", "skills", "testmaster");
  mkdirSync(skillTarget, { recursive: true });
  cpSync(spec.arm.skillDir, skillTarget, { recursive: true });
  const skill = treeManifest(skillTarget);

  const promptFile = join(directory, "task.md");
  writeFileSync(promptFile, spec.prompt);

  const proxy = await startProxy({ upstream: UPSTREAM, directory: join(directory, "model") });
  writeFileSync(join(agentHome, "models.yml"), modelsYml(proxy.url, spec.model));

  const record = {
    id: spec.id,
    arm: spec.arm.id,
    model: spec.model,
    app: spec.app.name,
    seed: spec.seed,
    targetUrl: spec.app.targetUrl,
    skill: { files: skill, sha256: treeHash(skill) },
    promptSha256: sha256(spec.prompt),
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(directory, "session.json"), JSON.stringify(record, null, 2));

  const events = createWriteStream(join(directory, "events.jsonl"));
  const stderr = createWriteStream(join(directory, "agent.stderr"));
  const args = [
    "-p",
    "--mode",
    "json",
    "--no-session",
    "--no-title",
    "--no-lsp",
    "--auto-approve",
    "--model",
    `surface/${spec.model}`,
    ...(spec.thinking ? ["--thinking", spec.thinking] : []),
    `@${promptFile}`,
  ];
  const started = Date.now();
  // The agent's sandbox: the host's home is an empty tmpfs except the session's own HOME,
  // workspace, PATH directory and /tmp, so neither this checkout, the harness state of other
  // sessions, nor the operator's configuration can inform (or contaminate) a session. A private
  // /tmp per session: agents write scratch files to fixed /tmp paths, which would leak between
  // sessions. It is the session's own `tmp/`, also its TMPDIR, so paths TestMaster hands to
  // Docker exist on the host too.
  const child = spawn(
    "bwrap",
    [
      "--dev-bind",
      "/",
      "/",
      "--tmpfs",
      homedir(),
      "--ro-bind",
      OMP,
      OMP,
      ...[home, join(directory, "ws"), bin, tmp].flatMap((path) => ["--bind", path, path]),
      "--bind",
      tmp,
      "/tmp",
      "--chdir",
      ws,
      "--",
      OMP,
      ...args,
    ],
    { cwd: ws, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.pipe(events);
  child.stderr.pipe(stderr);
  const exit = await new Promise((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal })),
  );
  await broker.close();
  await proxy.close();
  await Promise.all([events, stderr].map((stream) => new Promise((r) => stream.end(r))));

  Object.assign(record, {
    endedAt: new Date().toISOString(),
    wallClockMs: Date.now() - started,
    agentExit: exit,
    agentVersion: (await run(OMP, ["--version"], { env })).trim(),
    workspace: ws,
    home,
  });
  writeFileSync(join(directory, "session.json"), JSON.stringify(record, null, 2));
  return record;
}
