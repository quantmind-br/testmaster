#!/usr/bin/env node
// Phase 0 measurement (PLAN.md §2 "Ressalva metodológica", §8 Fase 0): for each agent target, run
// one session that does no work ("Reply with exactly: ready") with the TestMaster MCP server
// connected at the frozen A0 tools/list and the A0 skill installed, and record what of the MCP
// tools/list and of the skill reached the model request.
//
// Every agent runs with an isolated HOME (and XDG_*, CODEX_HOME, CLAUDE_CONFIG_DIR, ...) under a
// temporary directory; the real agent configuration is never read or written. The agent talks to
// QuantForge through the recording proxy (evals/surface/proxy.mjs), so the stored request body is
// exactly what the agent sent. No model call and no agent process has a timeout.
//
// Usage: QUANTFORGE_API_KEY=... node evals/surface/measure-targets.mjs [target ...] [--keep]
//   targets: omp pi claude codex cline copilot cursor antigravity (default: all)
//   --keep   keep the temporary workspace/home directories (their path is printed)
// The API key is read from the environment only and is never placed on an argv or in a file this
// script writes to evals/surface/targets/.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startProxy } from "./proxy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const cli = join(repo, "apps/cli/dist/main.js");
const a0 = join(here, "a0");
const targetsRoot = join(here, "targets");
const UPSTREAM = "https://api.quantforge.com.br";
const MODEL = "qwen3.8-flash";
const PROMPT = "Reply with exactly: ready";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const A0_SKILL_SHA256 = JSON.parse(readFileSync(join(a0, "manifest.json"), "utf8")).skill.sha256;
const a0Tools = JSON.parse(readFileSync(join(a0, "tools-list.json"), "utf8")).tools;

// Literal strings that tell which guidance reached the model request.
const MARKERS = {
  // Last-but-one skill sections: present only when the skill body was inlined.
  skillBody: [
    "Cleanup of data a browser step creates: a form that adds a project has no creating request step",
    "One-shot tests: a plan that sets",
  ],
  // Front matter of the skill: present when the skill is only advertised (name + description).
  skillDescription: "Uses TestMaster CLI or MCP to prepare sources, decide on test proposals",
  // Always-on instructions block that the installer writes (CLAUDE.md, AGENTS.md, ...).
  instructionsBlock: "drive the whole pipeline yourself with your own token scopes",
  // outputSchema ids of the A0 tools ("urn:testmaster:<tool>:output").
  outputSchemaId: "urn:testmaster:testmaster_save_test:output",
  // Input schema id of the A0 tools ("urn:testmaster:Mcp_<tool>").
  inputSchemaId: "urn:testmaster:Mcp_testmaster_",
};
const ALL_MARKERS = [
  ...MARKERS.skillBody,
  MARKERS.skillDescription,
  MARKERS.instructionsBlock,
  MARKERS.outputSchemaId,
  MARKERS.inputSchemaId,
];

// ---------------------------------------------------------------- agent adapters

/**
 * Each adapter describes how to run one agent with an isolated configuration.
 *   installTarget  name accepted by `testmaster agent install --target`
 *   version()      agent version string
 *   prepare(ctx)   writes the isolated configuration and returns { command, args, env }
 *   unmeasurable   optional async probe returning a reason string when the agent cannot be run
 * ctx: { home, ws, proxy (base URL, no path), mcp: {command, args}, dir, env, apiKeyEnv }
 */
const mcpServerJson = (mcp, extra = {}) => ({
  command: mcp.command,
  args: mcp.args,
  ...extra,
});

const adapters = {
  omp: {
    installTarget: "omp",
    binary: "omp",
    prepare(ctx) {
      const agentDir = join(ctx.home, ".omp/agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "models.yml"),
        [
          "providers:",
          "  quantforge-openai:",
          `    baseUrl: ${ctx.proxy}/v1`,
          "    api: openai-completions",
          `    apiKey: ${ctx.apiKeyEnv}`,
          "    models:",
          `    - id: ${MODEL}`,
          `      name: ${MODEL}`,
          "      reasoning: true",
          "      input: [text]",
          "      contextWindow: 262144",
          "      maxTokens: 32768",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(agentDir, "mcp.json"),
        JSON.stringify({ mcpServers: { testmaster: mcpServerJson(ctx.mcp) } }, null, 2),
      );
      return {
        command: "omp",
        args: [
          "-p",
          "--mode",
          "json",
          "--no-session",
          "--model",
          `quantforge-openai/${MODEL}`,
          "--auto-approve",
          PROMPT,
        ],
        env: {},
      };
    },
  },
  pi: {
    installTarget: "pi",
    binary: "pi",
    note: "Default MCP exposure is codemode (pi docs/mcp.md): server tools are never declared to the model, only the server name is listed under <mcp_servers>; pi connects the server in the background, so tools/list was answered after the first request here.",
    prepare(ctx) {
      const agentDir = join(ctx.home, ".pi/agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "models.json"),
        JSON.stringify(
          {
            providers: {
              quantforge: {
                baseUrl: `${ctx.proxy}/v1`,
                api: "openai-completions",
                apiKey: `$${ctx.apiKeyEnv}`,
                authHeader: true,
                name: "quantforge",
                // QuantForge rejects the "developer" role and reports streaming usage on request.
                compat: { supportsDeveloperRole: false, supportsUsageInStreaming: true },
                models: [{ id: MODEL, name: MODEL, reasoning: true, input: ["text"] }],
              },
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(agentDir, "mcp.json"),
        JSON.stringify({ mcpServers: { testmaster: mcpServerJson(ctx.mcp) } }, null, 2),
      );
      return {
        command: "pi",
        args: ["-p", "--approve", "--no-session", "--model", `quantforge/${MODEL}`, PROMPT],
        env: {},
      };
    },
  },
  claude: {
    installTarget: "claude",
    binary: "claude",
    prepare(ctx) {
      const configDir = join(ctx.home, ".claude");
      mkdirSync(configDir, { recursive: true });
      const mcpConfig = join(ctx.root, "claude-mcp.json");
      writeFileSync(
        mcpConfig,
        JSON.stringify(
          { mcpServers: { testmaster: mcpServerJson(ctx.mcp, { type: "stdio" }) } },
          null,
          2,
        ),
      );
      return {
        command: "claude",
        args: [
          "-p",
          "--strict-mcp-config",
          "--mcp-config",
          mcpConfig,
          "--model",
          MODEL,
          "--output-format",
          "stream-json",
          "--verbose",
          PROMPT,
        ],
        env: {
          CLAUDE_CONFIG_DIR: configDir,
          // Claude Code appends /v1/messages to the base URL.
          ANTHROPIC_BASE_URL: ctx.proxy,
          ANTHROPIC_API_KEY: ctx.env[ctx.apiKeyEnv],
          ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
          ANTHROPIC_SMALL_FAST_MODEL: MODEL,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
        },
      };
    },
  },
  codex: {
    installTarget: "codex",
    binary: "codex",
    prepare(ctx) {
      const codexHome = join(ctx.home, ".codex");
      mkdirSync(codexHome, { recursive: true });
      const tomlArray = (items) => `[${items.map((item) => JSON.stringify(item)).join(", ")}]`;
      writeFileSync(
        join(codexHome, "config.toml"),
        [
          `model = ${JSON.stringify(MODEL)}`,
          'model_provider = "quantforge"',
          "",
          "[model_providers.quantforge]",
          'name = "QuantForge"',
          `base_url = ${JSON.stringify(`${ctx.proxy}/v1`)}`,
          `env_key = ${JSON.stringify(ctx.apiKeyEnv)}`,
          'wire_api = "responses"',
          "",
          "[mcp_servers.testmaster]",
          `command = ${JSON.stringify(ctx.mcp.command)}`,
          `args = ${tomlArray(ctx.mcp.args)}`,
          // Codex starts MCP servers asynchronously: without this the first model request can be
          // sent before the server answered tools/list. A required server is awaited at startup.
          "required = true",
          "",
        ].join("\n"),
      );
      return {
        command: "codex",
        args: ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--json", PROMPT],
        env: { CODEX_HOME: codexHome },
      };
    },
  },
  cline: {
    installTarget: "cline",
    binary: "cline",
    prepare(ctx) {
      // With HOME isolated, Cline keeps its state in $HOME/.cline/data. It has no env-var option
      // for a provider key, so the isolated (temporary, deleted afterwards) providers.json holds it.
      const settings = join(ctx.home, ".cline/data/settings");
      mkdirSync(settings, { recursive: true });
      writeFileSync(
        join(settings, "providers.json"),
        JSON.stringify({
          version: 1,
          lastUsedProvider: "openai-compatible",
          modes: {},
          providers: {
            "openai-compatible": {
              settings: {
                provider: "openai-compatible",
                apiKey: ctx.env[ctx.apiKeyEnv],
                model: MODEL,
                baseUrl: `${ctx.proxy}/v1`,
              },
              updatedAt: new Date().toISOString(),
              tokenSource: "manual",
            },
          },
        }),
        { mode: 0o600 },
      );
      writeFileSync(
        join(settings, "cline_mcp_settings.json"),
        JSON.stringify({
          mcpServers: {
            testmaster: {
              transport: { type: "stdio", command: ctx.mcp.command, args: ctx.mcp.args },
            },
          },
        }),
      );
      return {
        command: "cline",
        args: ["-P", "openai-compatible", "-m", MODEL, "--json", PROMPT],
        env: {},
      };
    },
  },
  copilot: {
    installTarget: "copilot",
    binary: "copilot",
    prepare(ctx) {
      const copilotHome = join(ctx.home, ".copilot");
      mkdirSync(copilotHome, { recursive: true });
      writeFileSync(
        join(copilotHome, "mcp-config.json"),
        JSON.stringify(
          { mcpServers: { testmaster: mcpServerJson(ctx.mcp, { type: "local", tools: ["*"] }) } },
          null,
          2,
        ),
      );
      return {
        command: "copilot",
        args: ["-p", PROMPT, "--allow-all-tools", "--no-auto-update", "--no-color"],
        env: {
          COPILOT_HOME: copilotHome,
          COPILOT_PROVIDER_BASE_URL: `${ctx.proxy}/v1`,
          COPILOT_PROVIDER_TYPE: "openai",
          COPILOT_PROVIDER_API_KEY: ctx.env[ctx.apiKeyEnv],
          COPILOT_PROVIDER_WIRE_API: "completions",
          COPILOT_MODEL: MODEL,
          // BYOK needs no GitHub login; offline mode also keeps GitHub-side tools out of the prompt.
          COPILOT_OFFLINE: "true",
        },
      };
    },
  },
  // Cursor's agent talks to Cursor's own backend: the system prompt and tool list are assembled
  // server-side, and no setting retargets the model transport. The probe proves what is reachable.
  "cursor-agent": {
    installTarget: "cursor",
    binary: "cursor-agent",
    async unmeasurable({ dir, root }) {
      const help = run("cursor-agent", ["--help"], { env: { ...process.env, HOME: root } });
      const helpText = `${help.stdout ?? ""}${help.stderr ?? ""}`;
      const providerOptions = helpText
        .split("\n")
        .filter((line) =>
          /base[-_ ]?url|openai|anthropic|custom (model|provider)|byok/i.test(line),
        );
      const received = [];
      const stub = createHttpServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        received.push({
          method: request.method,
          url: request.url,
          contentType: request.headers["content-type"] ?? null,
          bodyBytes: body.length,
          bodyText: body.length <= 200 ? body.toString("utf8") : null,
        });
        response.writeHead(401, { "content-type": "application/json" });
        response.end("{}");
      });
      await new Promise((resolveListen) => stub.listen(0, "127.0.0.1", resolveListen));
      const endpoint = `http://127.0.0.1:${stub.address().port}`;
      const home = join(root, "cursor-home");
      mkdirSync(home, { recursive: true });
      // A syntactically fake credential: the probe must not authenticate to Cursor.
      // Asynchronous: the stub endpoint lives in this process and must keep answering.
      const attempt = await new Promise((resolveRun) => {
        const child = spawn(
          "cursor-agent",
          ["-p", "--endpoint", endpoint, "--output-format", "text", PROMPT],
          {
            env: {
              PATH: process.env.PATH,
              HOME: home,
              XDG_CONFIG_HOME: join(home, ".config"),
              CURSOR_API_KEY: "probe-not-a-credential",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const out = [];
        child.stdout.on("data", (chunk) => out.push(chunk));
        child.stderr.on("data", (chunk) => out.push(chunk));
        child.on("close", (code) =>
          resolveRun({ status: code, stdout: Buffer.concat(out).toString("utf8") }),
        );
      });
      await new Promise((resolveClose) => stub.close(resolveClose));
      const notLoggedIn = run("cursor-agent", ["status"], {
        env: { PATH: process.env.PATH, HOME: join(root, "cursor-status-home") },
      });
      const probe = {
        collectedAt: new Date().toISOString(),
        helpProviderOptions: providerOptions,
        helpEndpointOption: helpText
          .split("\n")
          .filter((line) => /--endpoint|CURSOR_API_ENDPOINT/.test(line)),
        statusWithoutLogin: `${notLoggedIn.stdout ?? ""}${notLoggedIn.stderr ?? ""}`.trim(),
        printModeWithFakeKeyAndStubEndpoint: {
          exitCode: attempt.status,
          output: `${attempt.stdout ?? ""}${attempt.stderr ?? ""}`.trim(),
          requestsReceivedByStub: received,
        },
      };
      writeFileSync(join(dir, "probe.json"), `${JSON.stringify(probe, null, 2)}\n`);
      return (
        "Not measurable without a Cursor account and not retargetable to QuantForge. " +
        "cursor-agent has no OpenAI/Anthropic-compatible base-URL option (--help matches for base url/openai/anthropic/custom model/byok: " +
        `${providerOptions.length}); --endpoint only retargets Cursor's own API: with a stub endpoint, a fake key and --print the only request was ` +
        `${received.map((r) => `${r.method} ${r.url}`).join(", ") || "none"} (Cursor auth exchange, answered 401), ` +
        "so no model request was ever sent; unauthenticated 'cursor-agent status' prints '" +
        probe.statusWithoutLogin +
        "'. [INFERENCE] Even when logged in, the prompt would go to Cursor's proprietary backend and not through a model endpoint the proxy can record."
      );
    },
  },
  // Antigravity is an Electron IDE (Google). The agent runs inside the IDE through a bundled
  // language_server that speaks Google's Cloud Code protocol; there is no headless prompt mode.
  antigravity: {
    installTarget: "antigravity",
    binary: "antigravity",
    // `antigravity --version` starts the GUI application, so the version comes from the package.
    version: () => run("pacman", ["-Q", "antigravity"]).stdout.trim() || null,
    async unmeasurable({ dir }) {
      const languageServer = "/opt/Antigravity/resources/bin/language_server";
      const help = run(languageServer, ["--help"]);
      const helpText = `${help.stdout ?? ""}${help.stderr ?? ""}`;
      const flags = helpText
        .split("\n")
        .filter((line) =>
          /-(cloud_code_endpoint|inference_api_server_url|model_api_client_type|headless|generative_service_addr|extension_server_port)=/.test(
            line,
          ),
        )
        .map((line) => line.trim());
      const probe = {
        collectedAt: new Date().toISOString(),
        executable: run("readlink", ["-f", "/usr/bin/antigravity"]).stdout.trim(),
        package: run("pacman", ["-Q", "antigravity"]).stdout.trim(),
        electronResources: existsSync("/opt/Antigravity/resources/app.asar"),
        languageServerFlags: flags,
        // Observed once by hand on 2026-10-18 with HOME=<empty temp dir>: the CLI entry point
        // starts the IDE instead of printing a version, and does not exit by itself. It is not
        // re-run by this script because it opens a GUI application.
        manualObservation: {
          command: "antigravity --version",
          output: [
            "DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<id>",
            "› [IDE Wizard] <HOME>/.gemini/antigravity not found — user was not migrated, skipping.",
            "› Starting app (v2.24.0) with dynamic port…",
            "› Host bridge server listening on http://127.0.0.1:<port>",
          ],
          exited: false,
        },
      };
      writeFileSync(join(dir, "probe.json"), `${JSON.stringify(probe, null, 2)}\n`);
      return (
        "Not measurable headlessly. Antigravity is an Electron IDE (package " +
        probe.package +
        "): its 'antigravity' entry point starts the GUI application (observed: 'Starting app (v2.24.0)', no exit, no prompt/print mode) " +
        "and its agent runs inside the IDE through a bundled language_server that needs a Google OAuth login and speaks Google's Cloud Code (ccpa) protocol; " +
        "the language_server has endpoint flags (--cloud_code_endpoint, --inference_api_server_url, --model_api_client_type=ccpa|gemini, --headless), but it is started and fed by the IDE's extension host; " +
        "running a session without the GUI would need a Google login or GUI automation, both outside the rules of this measurement (no vendor login, no editing real agent config)."
      );
    },
  },
};

// ---------------------------------------------------------------- harness

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function agentVersion(adapter) {
  if (adapter.version) return adapter.version();
  const binary = adapter.binary;
  const result = run(binary, ["--version"], { env: { ...process.env, HOME: tmpdir() } });
  return (
    `${result.stdout ?? ""}${result.stderr ?? ""}`
      .split("\n")
      .find(Boolean)
      ?.trim()
      .replace(/\.$/, "") ?? null
  );
}

/** Fresh TestMaster workspace with token and the installed (A0-bodied) skill. */
function prepareWorkspace(root, installTarget) {
  const ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  const tm = (...args) => run(process.execPath, [cli, "--cwd", ws, ...args], { encoding: "utf8" });
  const init = tm("init");
  if (init.status !== 0) throw new Error(`testmaster init failed: ${init.stderr}`);
  const tokenFile = join(root, "tm-token");
  const token = tm("token", "issue", "--token-file", tokenFile);
  if (token.status !== 0) throw new Error(`token issue failed: ${token.stderr}`);
  const install = tm("agent", "install", "--target", installTarget, "--yes");
  if (install.status !== 0) throw new Error(`agent install failed: ${install.stderr}`);
  return { ws, tokenFile, install: install.stdout };
}

/** Files the installer wrote, with hashes; replaces the installed skill body with A0's. */
function pinSkill(ws) {
  const skills = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".testmaster") walk(path);
      } else skills.push(path);
    }
  };
  walk(ws);
  const report = { files: [], skillReplaced: [] };
  for (const path of skills) {
    const relative = path.slice(ws.length + 1);
    if (relative === "testmaster.config.json") continue;
    const bytes = readFileSync(path);
    report.files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
    if (relative.endsWith("skills/testmaster/SKILL.md")) {
      report.skillReplaced.push({
        path: relative,
        installedSha256: sha256(bytes),
        a0Sha256: A0_SKILL_SHA256,
      });
      copyFileSync(join(a0, "SKILL.md"), path);
    }
  }
  return report;
}

function readNdjson(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** The provider tool definitions of a stored request body, in any of the three wire shapes. */
function toolDefinitions(body) {
  const out = [];
  const visit = (tool) => {
    // Codex groups an MCP server's tools in a { type: "namespace", tools: [...] } entry.
    if (Array.isArray(tool.tools)) {
      tool.tools.forEach(visit);
      return;
    }
    const fn = tool.function ?? tool;
    out.push({
      name: String(fn.name ?? tool.type ?? ""),
      text: JSON.stringify(tool),
      schema: fn.parameters ?? fn.input_schema ?? fn.inputSchema ?? null,
    });
  };
  (Array.isArray(body.tools) ? body.tools : []).forEach(visit);
  return out;
}

/** Every string of a request body split into lines: where tool lists and skill text live. */
function textLines(body) {
  const lines = [];
  const visit = (value) => {
    if (typeof value === "string") lines.push(...value.split("\n"));
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  const { tools: _tools, ...withoutTools } = body;
  visit(withoutTools);
  return lines;
}

/**
 * What of the TestMaster tools/list reached the request. A tool is "present" as a provider tool
 * definition or as lines of the prompt text that name it; its detail level is judged on that unit:
 * the description (summary), every input property name (input), the output-only required property
 * names or the output schema id (output).
 */
function classifyInjection(rawText, body, definitions) {
  const lines = textLines(body);
  const units = [];
  for (const a0 of a0Tools) {
    const definition = definitions.find((tool) => tool.name.includes(a0.name));
    const mentioned = definition ? [] : lines.filter((line) => line.includes(a0.name));
    if (!definition && mentioned.length === 0) continue;
    const text = definition ? definition.text : mentioned.join("\n");
    units.push({ a0, via: definition ? "tool-definition" : "prompt-text", text });
  }
  const properties = (a0) => Object.keys(a0.inputSchema.properties ?? {});
  const hasInput = ({ a0, text }) =>
    properties(a0).length > 0 && properties(a0).every((key) => text.includes(`"${key}"`));
  const hasOutput = ({ a0, text }) => {
    const required = (a0.outputSchema?.required ?? []).filter(
      (key) => !properties(a0).includes(key),
    );
    return (
      text.includes(`urn:testmaster:${a0.name}:output`) ||
      (required.length > 0 && required.every((key) => text.includes(`"${key}"`)))
    );
  };
  const hasDescription = ({ a0, text }) => text.includes(a0.description.slice(0, 40));
  const withInput = units.filter(hasInput).length;
  const withOutput = units.filter(hasOutput).length;
  const withDescription = units.filter(hasDescription).length;
  let injection = "none";
  if (withDescription > 0) injection = "summary";
  if (withInput > 0) injection = "input";
  if (withInput > 0 && withOutput > 0) injection = "input+output";
  const byDefinition = units.filter((unit) => unit.via === "tool-definition").length;
  return {
    count: units.length,
    injection,
    detail:
      units.length === 0
        ? "no TestMaster tool or tool name in the request"
        : injection === "none"
          ? "tool names only"
          : undefined,
    bytes: units.reduce((total, unit) => total + Buffer.byteLength(unit.text), 0),
    asToolDefinitions: byDefinition,
    asPromptText: units.length - byDefinition,
    withDescription,
    withInputSchema: withInput,
    withOutputSchema: withOutput,
    serverListedInPrompt: lines.filter((line) => /mcp[_-]+testmaster|testmaster__/i.test(line))
      .length,
    inputSchemaIdAnywhere: rawText.includes("urn:testmaster:Mcp_testmaster_"),
    outputSchemaIdAnywhere: rawText.includes("urn:testmaster:testmaster_"),
  };
}

function usageOf(record) {
  const usage = record?.usage ?? {};
  const pick = (...keys) =>
    keys.map((key) => usage[key]).find((value) => typeof value === "number");
  const cacheRead = pick("cache_read_input_tokens", "cache_read");
  const cacheWrite = pick("cache_creation_input_tokens") ?? 0;
  let promptTokens = pick("prompt_tokens");
  if (promptTokens === undefined) {
    const input = pick("input_tokens");
    promptTokens =
      input === undefined ? null : input + (cacheRead !== undefined ? cacheRead + cacheWrite : 0);
  }
  const reportedCached =
    pick("prompt_tokens_details.cached_tokens", "input_tokens_details.cached_tokens") ?? cacheRead;
  const cachedTokens = reportedCached ?? (promptTokens === null ? null : 0);
  return {
    cachedReported: reportedCached !== undefined,
    promptTokens,
    cachedTokens,
    uncachedTokens:
      promptTokens === null || cachedTokens === null ? null : promptTokens - cachedTokens,
    usage,
  };
}

async function runAgent({ command, args, env, cwd, dir }) {
  const stdoutPath = join(dir, "agent.stdout.txt");
  const stderrPath = join(dir, "agent.stderr.txt");
  const out = [];
  const err = [];
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => out.push(chunk));
  child.stderr.on("data", (chunk) => err.push(chunk));
  const exit = await new Promise((resolveExit) => {
    child.on("error", (error) => resolveExit({ code: null, error: String(error) }));
    child.on("close", (code, signal) => resolveExit({ code, signal }));
  });
  writeFileSync(stdoutPath, Buffer.concat(out));
  writeFileSync(stderrPath, Buffer.concat(err));
  return exit;
}

async function measure(target, { keep }) {
  const adapter = adapters[target];
  const dir = join(targetsRoot, target);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const entry = { target, agentVersion: agentVersion(adapter) };
  if (adapter.unmeasurable) {
    const probeRoot = mkdtempSync(join(tmpdir(), `tm-measure-${target}-probe-`));
    const reason = await adapter.unmeasurable({ dir, root: probeRoot });
    rmSync(probeRoot, { recursive: true, force: true });
    if (reason)
      return {
        ...entry,
        status: "unmeasurable",
        reason,
        evidenceFile: `targets/${target}/probe.json`,
      };
  }
  const apiKeyEnv = "QUANTFORGE_API_KEY";
  if (!process.env[apiKeyEnv]) throw new Error(`${apiKeyEnv} is required`);
  const root = mkdtempSync(join(tmpdir(), `tm-measure-${target}-`));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const { ws, tokenFile, install } = prepareWorkspace(root, adapter.installTarget);
  const pinned = pinSkill(ws);
  writeFileSync(join(dir, "workspace-files.json"), `${JSON.stringify(pinned, null, 2)}\n`);
  const proxy = await startProxy({ upstream: UPSTREAM, directory: dir, marker: ALL_MARKERS });
  const mcpLog = join(dir, "mcp.ndjson");
  const mcp = {
    command: process.execPath,
    args: [
      join(here, "mcp-proxy.mjs"),
      "--log",
      mcpLog,
      "--tools-list",
      join(a0, "tools-list.json"),
      "--",
      process.execPath,
      cli,
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
    ],
  };
  const baseEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local/state"),
    [apiKeyEnv]: process.env[apiKeyEnv],
    LANG: "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
  };
  const prepared = await adapter.prepare({
    home,
    ws,
    proxy: proxy.url,
    mcp,
    dir,
    env: baseEnv,
    apiKeyEnv,
    root,
  });
  writeFileSync(
    join(dir, "command.json"),
    `${JSON.stringify({ command: prepared.command, args: prepared.args, cwd: ws }, null, 2)}\n`,
  );
  const exit = await runAgent({
    command: prepared.command,
    args: prepared.args,
    env: { ...baseEnv, ...prepared.env },
    cwd: ws,
    dir,
  });
  await proxy.close();

  const records = readNdjson(join(dir, "model-requests.ndjson"));
  const mcpRecords = readNdjson(mcpLog);
  const toolsLists = mcpRecords.filter((record) => record.method === "tools/list");
  const toolCalls = mcpRecords.filter((record) => record.method === "tools/call");
  const evidence = {
    exit,
    installerPreviewBytes: install.length,
    skillReplaced: pinned.skillReplaced,
    modelRequests: records.length,
    modelRequestSummary: records.map((record) => ({
      seq: record.seq,
      path: record.path,
      status: record.status,
      requestBytes: record.requestBytes,
      toolCount: record.toolCount,
    })),
    mcpToolsListServed: toolsLists.length,
    mcpToolsListFromA0Snapshot: toolsLists.every((record) => record.fromSnapshot === true),
    mcpToolCalls: toolCalls.length,
  };
  if (records.length === 0) {
    return {
      ...entry,
      status: "unmeasurable",
      reason: `agent made no model request through the proxy (exit ${JSON.stringify(exit)})`,
      evidence,
      ...(keep ? { keptAt: root } : {}),
      _root: root,
    };
  }
  const rejected = records.filter((record) => record.status !== 200);
  if (rejected.length === records.length) {
    return {
      ...entry,
      status: "unmeasurable",
      reason: `provider rejected every model request (HTTP ${rejected.map((r) => r.status).join(",")}); see requests/ and agent.stdout.txt`,
      evidence,
      ...(keep ? { keptAt: root } : {}),
      _root: root,
    };
  }
  // The measured request is the first successful one that carries the most tools: the session's
  // first agent turn, not a later turn with tool results nor a title or summary call.
  const main = records
    .filter((record) => record.status === 200)
    .reduce((best, record) => (record.toolCount > best.toolCount ? record : best));
  // The A0 tools/list must have been answered before the measured request started; otherwise the
  // request cannot show the tools and the run is a race, not a measurement.
  evidence.mcpToolsListAnsweredBeforeMeasuredRequest = toolsLists.some(
    (record) => Date.parse(record.at) <= Date.parse(main.startedAt),
  );
  const body = JSON.parse(readFileSync(join(dir, "requests", `${main.seq}.json`), "utf8"));
  const raw = readFileSync(join(dir, "requests", `${main.seq}.json`), "utf8");
  const definitions = toolDefinitions(body);
  const testmasterTools = classifyInjection(raw, body, definitions);
  const bodyMarkers = MARKERS.skillBody.map((text) => main.markers[text]);
  let skillLoaded = false;
  if (bodyMarkers.every(Boolean)) skillLoaded = true;
  // Advertised without its body: a "- testmaster: <description>" list line in the prompt, or a
  // skill tool whose description ends with "Available skills: testmaster".
  const advertised = [
    ...textLines(body).filter((line) => /^\s*[-*] testmaster(\b|:)/.test(line)),
    ...(raw.match(/Available skills:[^"\\]*\btestmaster\b[^"\\]*/g) ?? []),
  ];
  if (!skillLoaded && (main.markers[MARKERS.skillDescription] || advertised.length > 0))
    skillLoaded = "on-demand";
  const usage = usageOf(main);
  return {
    ...entry,
    status: "measured",
    ...(adapter.note ? { note: adapter.note } : {}),
    cacheNote:
      "cachedTokens is the provider's prefix cache, warmed by earlier identical runs of this script; promptTokens (cached + uncached) is independent of it",
    mainRequestSeq: main.seq,
    requestPath: main.path,
    requestBytes: main.requestBytes,
    systemBytes: main.systemBytes,
    toolCount: main.toolCount,
    toolCountFlattened: definitions.length,
    toolBytes: main.toolBytes,
    testmasterTools,
    skillLoaded,
    skillEvidence: {
      bodyMarkers: Object.fromEntries(MARKERS.skillBody.map((text) => [text, main.markers[text]])),
      descriptionMarker: main.markers[MARKERS.skillDescription],
      advertisedLines: advertised.map((line) => line.trim().slice(0, 160)),
      instructionsBlockMarker: main.markers[MARKERS.instructionsBlock],
    },
    promptTokens: usage.promptTokens,
    cachedTokens: usage.cachedTokens,
    cachedTokensReported: usage.cachedReported,
    uncachedTokens: usage.uncachedTokens,
    reportedUsage: usage.usage,
    evidence,
    ...(keep ? { keptAt: root } : {}),
    _root: root,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const keep = argv.includes("--keep");
  const requested = argv.filter((arg) => !arg.startsWith("--"));
  const targets = requested.length > 0 ? requested : Object.keys(adapters);
  mkdirSync(targetsRoot, { recursive: true });
  const summaryPath = join(targetsRoot, "summary.json");
  const previous = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) : {};
  const results = { ...previous };
  for (const target of targets) {
    if (!adapters[target]) throw new Error(`unknown target ${target}`);
    process.stderr.write(`== ${target}\n`);
    const result = await measure(target, { keep });
    const root = result._root;
    delete result._root;
    results[target] = result;
    writeFileSync(join(targetsRoot, target, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    if (root && !keep) rmSync(root, { recursive: true, force: true });
    process.stderr.write(`   ${result.status} ${result.reason ?? ""}\n`);
  }
  writeFileSync(summaryPath, `${JSON.stringify(results, null, 2)}\n`);
}

await main();
