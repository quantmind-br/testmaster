#!/usr/bin/env node
/**
 * Hosted proof of the TestMaster GitHub App against real GitHub.com (M4-07, J12).
 *
 * A throwaway PostgreSQL container, a TestMaster server-profile process and a tiny preview app run on this
 * machine. Two cloudflared quick tunnels expose the server (GitHub's webhooks) and the preview app (the
 * deployment's `environment_url`). The App is created through the real manifest flow, so one human has to
 * click "Create GitHub App" and "Install"; everything else is scripted through the `gh` CLI and the App JWT.
 *
 * The harness is a set of idempotent stages that share `state.json` in a 0700 work directory:
 *
 *   up                   PostgreSQL, server, tunnels, preview app, project, environment, test, repository
 *   setup                start `integrations github setup` and print the URL the human must open
 *   await-installation   wait for the real `installation` webhook, then enable the repository
 *   prove                pull request flow: green, redelivery, push, supersede, failing preview, late deployment
 *   uninstall            delete the installation with the App JWT and check that TestMaster revokes it
 *   collect              write the index of retained records
 *   down                 stop everything, remove containers and shred private material
 *
 * Usage: node validation/hosted/github-app-hosted.mjs <stage> [--work DIR] [--repo OWNER/NAME]
 * Raw records are written scrubbed to validation/results/m4-acceptance/hosted/NN-name/.
 */
import { execFile, spawn } from "node:child_process";
import { createSign, randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const cliEntry = join(root, "apps/cli/dist/main.js");
const evidenceRoot = join(root, "validation/results/m4-acceptance/hosted");

const args = process.argv.slice(2);
const stage = args[0];
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}
const work = resolve(option("work", process.env.TM_HOSTED_WORK ?? "/tmp/m4/hosted-w2c"));
const statePath = join(work, "state.json");
const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const repoName = option("repo", `quantmind-br/testmaster-m4-app-${today}`);

const log = (message) => console.error(`[hosted ${new Date().toISOString()}] ${message}`);
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
function save() {
  writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(statePath, 0o600);
}
function need(key) {
  if (state[key] === undefined) throw new Error(`state.${key} is missing: run the earlier stages`);
  return state[key];
}

// ------------------------------------------------------------------------------------ scrubbing
const secretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\btm_(?:api|op|local|wrk|rec)_[A-Za-z0-9_-]{20,}/g,
];
function secretValues() {
  return [
    state.apiToken,
    state.operatorToken,
    state.ownerPassword,
    state.ownerRecovery,
    state.pgAdminPassword,
  ]
    .filter((value) => typeof value === "string" && value.length >= 8)
    .concat(extraSecrets);
}
const extraSecrets = [];
export function scrub(text) {
  let out = text;
  for (const pattern of secretPatterns) out = out.replace(pattern, "[redacted]");
  for (const value of secretValues()) out = out.split(value).join("[redacted]");
  return out;
}

function evidenceDir(name) {
  const dir = join(evidenceRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
/**
 * The App was installed on every repository of the account (GitHub offered "all"), but only the disposable
 * repository is part of the proof: other repository names, some of them private, are never retained.
 */
function onlyProofRepository(value) {
  if (Array.isArray(value))
    return value.map((entry) =>
      entry && typeof entry === "object" && Array.isArray(entry.repositories)
        ? {
            ...entry,
            repositoryCount: entry.repositories.length,
            repositories: entry.repositories.filter(
              (repository) => repository.fullName === state.repo,
            ),
          }
        : entry,
    );
  return value;
}
function record(dirName, file, value) {
  const dir = evidenceDir(dirName);
  const text =
    typeof value === "string" ? value : `${JSON.stringify(onlyProofRepository(value), null, 2)}\n`;
  writeFileSync(join(dir, file), scrub(text));
}

// ------------------------------------------------------------------------------------ processes
function spawnDetached(command, argv, logFile, env = process.env, cwd = root) {
  const fd = openSync(logFile, "a", 0o600);
  const child = spawn(command, argv, { detached: true, stdio: ["ignore", fd, fd], env, cwd });
  child.unref();
  return child.pid;
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until(description, probe, { timeoutMs = 120_000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}${last ? `: ${last.message}` : ""}`);
}
async function freePort() {
  const probe = createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}
async function startTunnel(name, port) {
  const logFile = join(work, `tunnel-${name}.log`);
  rmSync(logFile, { force: true });
  const pid = spawnDetached(
    "cloudflared",
    ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
    logFile,
  );
  const origin = await until(
    `the ${name} tunnel URL`,
    () => /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(readFileSync(logFile, "utf8"))?.[0],
    { timeoutMs: 60_000 },
  );
  return { pid, origin };
}
async function reachable(url, accept) {
  return until(
    `${url} through the tunnel`,
    async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      return accept(response) ? response.status : false;
    },
    { timeoutMs: 240_000, intervalMs: 3000 },
  );
}

// ------------------------------------------------------------------------------------ TestMaster API
const local = () => `http://127.0.0.1:${need("serverPort")}`;
async function tm(method, path, { body, token = state.apiToken, headers = {}, cookie } = {}) {
  const response = await fetch(`${local()}/v1${path}`, {
    method,
    headers: {
      accept: "application/json",
      "x-forwarded-proto": "https",
      origin: need("serverOrigin"),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(method === "GET" ? {} : { "idempotency-key": crypto.randomUUID() }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, headers: response.headers, text, json };
}
async function tmOk(method, path, options) {
  const response = await tm(method, path, options);
  if (response.status >= 300)
    throw new Error(`${method} ${path} -> ${response.status} ${scrub(response.text)}`);
  return response.json?.data ?? response.json;
}
async function tmList(path) {
  const rows = [];
  let cursor = null;
  do {
    const joiner = path.includes("?") ? "&" : "?";
    const response = await tm(
      "GET",
      `${path}${joiner}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    if (response.status !== 200)
      throw new Error(`GET ${path} -> ${response.status} ${scrub(response.text)}`);
    rows.push(...(response.json.data?.items ?? []));
    cursor = response.json.data?.hasMore ? response.json.data.nextCursor : null;
  } while (cursor);
  return rows;
}
function findString(value, pattern) {
  if (typeof value === "string") return pattern.test(value) ? value : null;
  if (value && typeof value === "object")
    for (const member of Object.values(value)) {
      const found = findString(member, pattern);
      if (found) return found;
    }
  return null;
}

// ------------------------------------------------------------------------------------ GitHub
async function gh(argv, input) {
  const child = execFile("gh", argv, { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output.stderr += chunk;
  });
  if (input !== undefined)
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  const code = await new Promise((done) => child.on("close", done));
  if (code !== 0)
    throw new Error(`gh ${argv.join(" ")} failed: ${scrub(output.stderr || output.stdout)}`);
  return output.stdout;
}
async function ghApi(method, path, body) {
  const argv = ["api", "-X", method, "-H", "Accept: application/vnd.github+json", path];
  if (body !== undefined) argv.push("--input", "-");
  const text = await gh(argv, body);
  return text.trim() ? JSON.parse(text) : null;
}
/** App-authenticated GitHub API call with a short-lived JWT; the private key never leaves memory. */
let appKey = null;
async function appCredentials() {
  if (appKey) return appKey;
  const { Application, authenticateBearer } = await import("@testmaster/application");
  const server = JSON.parse(readFileSync(need("configPath"), "utf8"));
  const application = await Application.open({ cwd: work, server });
  try {
    const identity = authenticateBearer(application, need("apiToken"));
    const acting = application.forIdentity({
      ...identity,
      grants: [
        {
          resourceType: "secrets",
          actions: ["export"],
          projectIds: [],
          environmentIds: [],
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          grantedBy: identity.principalId,
        },
      ],
    });
    const integration = acting.integrations.list().find((entry) => entry.provider === "github");
    if (!integration) throw new Error("no GitHub integration yet");
    const settings = integration.settings;
    const revealed = await acting.secrets.reveal(settings.credentials.privateKeyRef);
    extraSecrets.push(revealed.value);
    appKey = { appId: settings.appId, pem: revealed.value, integrationId: integration.id };
    return appKey;
  } finally {
    application.close();
  }
}
const b64u = (value) => Buffer.from(value).toString("base64url");
async function appJwt() {
  const { appId, pem } = await appCredentials();
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64u(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(pem).toString("base64url");
  const jwt = `${unsigned}.${signature}`;
  extraSecrets.push(jwt);
  return jwt;
}
async function appApi(method, path, body) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${await appJwt()}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "testmaster-m4-hosted-proof",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let json = null;
  try {
    // Webhook delivery ids exceed 2^53; keep every 16+ digit integer exact by turning it into a string.
    json = JSON.parse(text.replace(/(:\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
  } catch {}
  return { status: response.status, json, text };
}

// ------------------------------------------------------------------------------------ stages: up
async function previewApp() {
  const port = Number(args[1]);
  const modeFile = join(work, "preview-mode");
  const hitsFile = join(work, "preview-hits.jsonl");
  createServer((request, response) => {
    const mode = existsSync(modeFile) ? readFileSync(modeFile, "utf8").trim() : "ok";
    appendFileSync(
      hitsFile,
      `${JSON.stringify({ at: new Date().toISOString(), method: request.method, url: request.url, mode, userAgent: request.headers["user-agent"] ?? null })}\n`,
    );
    const url = new URL(request.url ?? "/", "http://preview.local");
    if (url.pathname === "/health") {
      response.writeHead(mode === "ok" ? 200 : 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: mode === "ok" ? "ok" : "down" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  }).listen(port, "127.0.0.1");
}
const setPreviewMode = (mode) => writeFileSync(join(work, "preview-mode"), mode);

async function up() {
  mkdirSync(work, { recursive: true, mode: 0o700 });
  chmodSync(work, 0o700);
  const home = join(work, "home");
  for (const path of [home, join(work, "evidence"), join(work, "keys")])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  state.home = home;
  setPreviewMode("ok");

  log("starting the throwaway PostgreSQL container");
  const pgModule = await import(
    pathToFileURL(join(root, "packages/persistence/dist/testing/server.js")).href
  );
  const pg = await pgModule.startPostgresTestServer();
  state.pgAdminPassword = pg.adminPassword;
  state.pgInfo = {
    host: pg.host,
    port: pg.port,
    adminPassword: pg.adminPassword,
    ownerRole: pg.ownerRole,
    ownerPasswordFile: pg.ownerPasswordFile,
    template: pg.template,
  };
  state.pgContainer = (
    await exec("docker", ["ps", "--filter", `publish=${pg.port}`, "--format", "{{.Names}}"])
  ).stdout.trim();
  const database = await pgModule.createTestDatabaseOn(state.pgInfo);
  state.databaseConfig = database.config;
  save();

  state.serverPort = await freePort();
  state.previewPort = await freePort();
  state.previewPid = spawnDetached(
    process.execPath,
    [fileURLToPath(import.meta.url), "preview-app", String(state.previewPort), "--work", work],
    join(work, "preview.log"),
  );
  save();
  log("starting the quick tunnels");
  const [serverTunnel, previewTunnel] = await Promise.all([
    startTunnel("server", state.serverPort),
    startTunnel("preview", state.previewPort),
  ]);
  state.serverTunnel = serverTunnel;
  state.previewTunnel = previewTunnel;
  state.serverOrigin = serverTunnel.origin;
  state.previewOrigin = previewTunnel.origin;
  save();
  log(`server origin ${state.serverOrigin}, preview origin ${state.previewOrigin}`);
  await reachable(`${state.previewOrigin}/health`, (response) => response.status === 200);

  const keys = join(work, "keys");
  for (const name of ["master.key", "backup.key"]) {
    writeFileSync(join(keys, name), randomBytes(32), { mode: 0o600 });
    chmodSync(join(keys, name), 0o600);
  }
  const config = {
    mode: "server",
    database: { engine: "postgres", ...state.databaseConfig },
    storage: { kind: "filesystem", root: join(work, "evidence") },
    server: {
      listen: { host: "127.0.0.1", port: state.serverPort },
      publicOrigin: state.serverOrigin,
      trustedProxies: ["127.0.0.1"],
      origins: [state.serverOrigin],
    },
    security: {
      masterKeyFile: join(keys, "master.key"),
      backupKeyFile: join(keys, "backup.key"),
      atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
    },
  };
  state.configPath = join(work, "server.json");
  writeFileSync(state.configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(state.configPath, 0o600);
  state.env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    TESTMASTER_NO_TELEMETRY: "true",
    CI: "true",
  };
  for (const name of [
    "TESTMASTER_ENDPOINT",
    "TESTMASTER_PROFILE",
    "TESTMASTER_API_KEY",
    "TESTMASTER_DATA_DIR",
    "NODE_OPTIONS",
    "PGPASSWORD",
  ])
    delete state.env[name];
  const cli = async (...argv) => {
    const { stdout } = await exec(process.execPath, [cliEntry, ...argv, "--json"], {
      cwd: work,
      env: state.env,
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout).data;
  };
  await cli("db", "migrate", "--mode", "server", "--config", state.configPath);
  state.ownerLogin = `owner-${randomBytes(4).toString("hex")}`;
  const bootstrap = await cli(
    "server",
    "bootstrap",
    "--config",
    state.configPath,
    "--workspace-name",
    "M4 hosted proof",
    "--owner-login",
    state.ownerLogin,
  );
  state.ownerRecovery = findString(bootstrap, /^tm_rec_/);
  state.workspaceId = findString(bootstrap, /^ws_/);
  state.operatorToken = findString(
    await cli("server", "operator-token", "--config", state.configPath),
    /^tm_op_/,
  );
  save();

  log("starting the server profile");
  state.serverPid = spawnDetached(
    process.execPath,
    [cliEntry, "server", "start", "--mode", "server", "--config", state.configPath, "--json"],
    join(work, "server.log"),
    state.env,
    work,
  );
  save();
  await until(
    "the server to listen",
    () =>
      /"address"\s*:\s*"http:\/\/127\.0\.0\.1:\d+"/.test(
        readFileSync(join(work, "server.log"), "utf8"),
      ),
    { timeoutMs: 120_000 },
  );
  log("the server is up; checking the public tunnel");
  const livez = await reachable(
    `${state.serverOrigin}/v1/health/live`,
    (response) => response.status === 200,
  );
  log(`public /v1/health/live -> ${livez}`);

  state.ownerPassword = `Pw-${randomBytes(18).toString("base64url")}`;
  const recovered = await tm("POST", "/identity/recovery", {
    token: null,
    body: {
      principal: state.ownerLogin,
      recoveryToken: state.ownerRecovery,
      newPassword: state.ownerPassword,
    },
  });
  if (recovered.status !== 200) throw new Error(`recovery failed: ${scrub(recovered.text)}`);
  const login = await tm("POST", "/identity/login", {
    token: null,
    body: { principal: state.ownerLogin, password: state.ownerPassword },
  });
  if (login.status !== 200) throw new Error(`login failed: ${scrub(login.text)}`);
  const session = /__Host-tm_session=[^;]+/.exec(login.headers.get("set-cookie") ?? "")?.[0];
  const csrf = login.json.data.csrfToken;
  const created = await tm("POST", "/tokens", {
    token: null,
    cookie: session,
    headers: { "x-csrf-token": csrf },
    body: {
      name: "hosted-proof-harness",
      scopes: ["R", "W", "X", "A"],
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    },
  });
  if (created.status >= 300) throw new Error(`token creation failed: ${scrub(created.text)}`);
  state.apiToken = findString(created.json, /^tm_api_/);
  save();

  const project = await tmOk("POST", "/projects", { body: { name: "m4-hosted-proof" } });
  state.projectId = project.id;
  const environment = await tmOk("POST", `/projects/${project.id}/environments`, {
    body: { name: "hosted-base", baseUrl: state.previewOrigin, networkProfile: "public" },
  });
  state.environmentId = environment.id;
  const { scaffoldPlan } = await import("@testmaster/application");
  const test = await tmOk("POST", `/projects/${project.id}/tests`, {
    body: { origin: "manual", plan: scaffoldPlan("backend") },
  });
  state.testId = test.id;
  save();

  log(`creating the disposable repository ${repoName}`);
  const exists = await gh(["repo", "view", repoName, "--json", "name"]).then(
    () => true,
    () => false,
  );
  if (!exists)
    await gh([
      "repo",
      "create",
      repoName,
      "--public",
      "--add-readme",
      "--description",
      "Disposable repository for the TestMaster M4 GitHub App hosted proof",
    ]);
  state.repo = repoName;
  state.mainSha = (await ghApi("GET", `repos/${repoName}/git/ref/heads/main`)).object.sha;
  save();
  log("up: done");
}

// ------------------------------------------------------------------------------------ stage: setup
async function setup() {
  const slug = `TestMaster-M4-${today}-${randomBytes(2).toString("hex")}`;
  const logFile = join(work, "setup.log");
  rmSync(logFile, { force: true });
  const env = { ...need("env"), TM_HOSTED_TOKEN: need("apiToken") };
  state.setupPid = spawnDetached(
    process.execPath,
    [
      cliEntry,
      "integrations",
      "github",
      "setup",
      "--mode",
      "server",
      "--config",
      need("configPath"),
      "--token-env",
      "TM_HOSTED_TOKEN",
      "--project",
      need("projectId"),
      "--public-origin",
      need("serverOrigin"),
      "--name",
      slug,
      "--timeout",
      "7200",
    ],
    logFile,
    env,
    work,
  );
  state.appName = slug;
  save();
  const url = await until(
    "the setup page URL",
    () =>
      /Open (http:\/\/127\.0\.0\.1:\d+\/) in a browser/.exec(readFileSync(logFile, "utf8"))?.[1],
    { timeoutMs: 60_000 },
  );
  state.manifestUrl = url;
  save();
  // Verify the page serves the manifest form for GitHub before asking a human to open it.
  const page = await fetch(url);
  const html = await page.text();
  if (page.status !== 200 || !html.includes("https://github.com/settings/apps/new"))
    throw new Error(`manifest page is not ready: ${page.status}`);
  console.log(`MANIFEST_URL ${url}`);
  console.log(`REPO ${need("repo")}`);
}

// ------------------------------------------------------------------------------------ stage: installation
async function awaitInstallation() {
  const integrationId = await until(
    "the manifest conversion (App created)",
    async () => (await tmList("/integrations")).find((entry) => entry.provider === "github")?.id,
    { timeoutMs: 110 * 60_000, intervalMs: 5000 },
  );
  state.integrationId = integrationId;
  save();
  log(`App created; integration ${integrationId}`);
  const installation = await until(
    `an installation covering ${need("repo")}`,
    async () => {
      const rows = await tmList(`/integrations/${integrationId}/github/installations`);
      return rows.find(
        (row) =>
          row.state === "active" &&
          row.repositories.some((entry) => entry.fullName === need("repo")),
      );
    },
    { timeoutMs: 110 * 60_000, intervalMs: 5000 },
  );
  state.installationId = installation.installationId;
  state.repositoryId = installation.repositories.find(
    (entry) => entry.fullName === need("repo"),
  ).repositoryId;
  save();
  log(`installation ${state.installationId}, repository ${state.repositoryId}`);
  const patched = await tmOk(
    "PATCH",
    `/integrations/${integrationId}/github/repositories/${state.repositoryId}`,
    {
      body: {
        enabled: true,
        projectId: need("projectId"),
        baseEnvironmentId: need("environmentId"),
        preview: { provider: "github-deployments", environmentPattern: "*", timeoutMs: 1_800_000 },
      },
    },
  );
  record("01-app-and-installation", "repository-enabled.json", patched);
  const app = await appApi("GET", "/app");
  if (app.status !== 200) throw new Error(`GET /app -> ${app.status}`);
  state.appSlug = app.json.slug;
  state.appId = String(app.json.id);
  save();
  record("01-app-and-installation", "github-app.json", app.json);
  const installations = await appApi("GET", "/app/installations");
  record("01-app-and-installation", "github-installations.json", installations.json);
  record(
    "01-app-and-installation",
    "testmaster-installations.json",
    await tmList(`/integrations/${integrationId}/github/installations`),
  );
  record("01-app-and-installation", "testmaster-integrations.json", await tmList("/integrations"));
  await recordDeliveries("01-app-and-installation", "github-deliveries.json");
}

/**
 * The App is installed on every repository of the account: deliveries of other repositories keep
 * only their routing metadata, and installation webhooks keep only the proof repository and a count.
 */
function trimDelivery(detail) {
  if (
    detail?.repository_id != null &&
    String(detail.repository_id) !== String(state.repositoryId)
  ) {
    const { request: _request, response: _response, ...routing } = detail;
    return { ...routing, redacted: "delivery of another repository of the account" };
  }
  const payload = detail?.request?.payload;
  if (!payload || typeof payload !== "object") return detail;
  for (const key of ["repositories", "repositories_added", "repositories_removed"]) {
    if (!Array.isArray(payload[key])) continue;
    payload[`${key}_count`] = payload[key].length;
    payload[key] = payload[key].filter((repository) => repository.full_name === state.repo);
  }
  return detail;
}
async function recordDeliveries(dirName, file) {
  const list = await appApi("GET", "/app/hook/deliveries?per_page=100");
  if (list.status !== 200) throw new Error(`GET /app/hook/deliveries -> ${list.status}`);
  const detailed = [];
  for (const delivery of list.json) {
    const detail = await appApi("GET", `/app/hook/deliveries/${delivery.id}`);
    detailed.push(
      detail.status === 200
        ? trimDelivery(detail.json)
        : { id: delivery.id, status: detail.status },
    );
  }
  record(dirName, file, { list: list.json, deliveries: detailed });
  return { list: list.json, deliveries: detailed };
}

// ------------------------------------------------------------------------------------ stage: prove
const names = ["TestMaster / result", "TestMaster / required-gate"];
async function commit(branch, file, content, message) {
  const repo = need("repo");
  const existing = await ghApi("GET", `repos/${repo}/contents/${file}?ref=${branch}`).catch(
    () => null,
  );
  const response = await ghApi("PUT", `repos/${repo}/contents/${file}`, {
    message,
    content: Buffer.from(content).toString("base64"),
    branch,
    ...(existing ? { sha: existing.sha } : {}),
  });
  return response.commit.sha;
}
async function checkRuns(sha) {
  const response = await ghApi(
    "GET",
    `repos/${need("repo")}/commits/${sha}/check-runs?per_page=100`,
  );
  return {
    ...response,
    check_runs: response.check_runs.filter((run) => run.app?.slug === state.appSlug),
  };
}
const verdict = (runs) =>
  Object.fromEntries(
    runs.check_runs.map((run) => [
      run.name,
      run.status === "completed" ? run.conclusion : run.status,
    ]),
  );
async function waitChecks(sha, predicate, description, timeoutMs = 15 * 60_000) {
  return until(
    description,
    async () => {
      const runs = await checkRuns(sha);
      return predicate(verdict(runs), runs) ? runs : false;
    },
    { timeoutMs, intervalMs: 5000 },
  );
}
async function waitPull(sha) {
  return until(
    `TestMaster to know the pull request head ${sha.slice(0, 7)}`,
    async () =>
      (await tmList(`/integrations/${need("integrationId")}/github/pulls`)).find(
        (entry) => entry.headSha === sha,
      ),
    { timeoutMs: 180_000, intervalMs: 3000 },
  );
}
async function deploy(sha, description, environmentUrl) {
  const repo = need("repo");
  const deployment = await ghApi("POST", `repos/${repo}/deployments`, {
    ref: sha,
    environment: "preview",
    auto_merge: false,
    required_contexts: [],
    transient_environment: true,
    description,
  });
  const status = await ghApi("POST", `repos/${repo}/deployments/${deployment.id}/statuses`, {
    state: "success",
    environment: "preview",
    environment_url: environmentUrl,
    description: "Preview ready",
  });
  return { deployment, status };
}
async function snapshot(dirName, prefix) {
  const integrationId = need("integrationId");
  record(
    dirName,
    `${prefix}testmaster-pulls.json`,
    await tmList(`/integrations/${integrationId}/github/pulls`),
  );
  record(
    dirName,
    `${prefix}testmaster-checks.json`,
    await tmList(`/integrations/${integrationId}/github/checks`),
  );
  record(dirName, `${prefix}testmaster-runs.json`, await tmList("/runs"));
}
async function comments(prNumber) {
  return ghApi("GET", `repos/${need("repo")}/issues/${prNumber}/comments?per_page=100`);
}
const marker = (comment) => comment.body?.startsWith("<!-- testmaster:pr ");

function expectVerdict(actual, expected, label) {
  for (const [name, conclusion] of Object.entries(expected))
    if (actual[name] !== conclusion)
      throw new Error(`${label}: ${name} is ${actual[name]}, expected ${conclusion}`);
}

async function prove() {
  const repo = need("repo");
  const summary = {
    repo,
    appSlug: need("appSlug"),
    installationId: need("installationId"),
    serverOrigin: need("serverOrigin"),
    previewOrigin: need("previewOrigin"),
    steps: [],
  };
  const runsBefore = (await tmList("/runs")).length;
  const branch = `m4-proof-${today}-${randomBytes(2).toString("hex")}`;
  await ghApi("POST", `repos/${repo}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: need("mainSha"),
  });

  // ---- A: a healthy preview turns both checks green on its own SHA
  setPreviewMode("ok");
  const shaA = await commit(
    branch,
    "proof.txt",
    `commit A ${new Date().toISOString()}\n`,
    "Proof commit A",
  );
  const pr = await ghApi("POST", `repos/${repo}/pulls`, {
    title: `TestMaster M4 hosted proof ${today}`,
    head: branch,
    base: "main",
    body: "Disposable pull request for the TestMaster GitHub App hosted proof.",
  });
  summary.prNumber = pr.number;
  summary.shaA = shaA;
  record("02-pr-healthy", "pull.json", pr);
  await waitPull(shaA);
  const queuedA = await waitChecks(
    shaA,
    (v) => names.every((name) => v[name] === "queued"),
    "both checks queued on A",
    180_000,
  );
  record("02-pr-healthy", "check-runs-A-queued.json", queuedA);
  const deployA = await deploy(shaA, "Healthy preview for commit A", need("previewOrigin"));
  record("02-pr-healthy", "deployment-A.json", deployA);
  const doneA = await waitChecks(
    shaA,
    (v) => names.every((name) => v[name] === "success"),
    "both checks green on A",
  );
  record("02-pr-healthy", "check-runs-A.json", doneA);
  expectVerdict(
    verdict(doneA),
    { "TestMaster / result": "success", "TestMaster / required-gate": "success" },
    "A",
  );
  const commentsA = await comments(pr.number);
  record("02-pr-healthy", "comments-A.json", commentsA);
  if (commentsA.filter(marker).length !== 1)
    throw new Error("expected exactly one TestMaster comment after A");
  await snapshot("02-pr-healthy", "A-");
  const runsAfterA = await tmList("/runs");
  summary.steps.push({
    step: "healthy-preview",
    sha: shaA,
    verdict: verdict(doneA),
    runs: runsAfterA.length - runsBefore,
  });

  // ---- redelivery of the same webhook deliveries
  const deliveriesBefore = await recordDeliveries("03-redelivery", "deliveries-before.json");
  const redeliverable = deliveriesBefore.deliveries.filter(
    (delivery) => delivery.event === "pull_request" || delivery.event === "deployment_status",
  );
  const outcomesBefore = new Map(
    redeliverable.map((delivery) => [delivery.guid, delivery.status_code]),
  );
  const attempts = [];
  for (const delivery of redeliverable) {
    const response = await appApi("POST", `/app/hook/deliveries/${delivery.id}/attempts`);
    attempts.push({
      id: delivery.id,
      guid: delivery.guid,
      event: delivery.event,
      status: response.status,
    });
  }
  record("03-redelivery", "redelivery-attempts.json", attempts);
  await until(
    "redelivery attempts to be recorded",
    async () => {
      const list = await appApi("GET", "/app/hook/deliveries?per_page=100");
      return (
        list.json.filter((delivery) => delivery.redelivery === true).length >= redeliverable.length
      );
    },
    { timeoutMs: 120_000, intervalMs: 3000 },
  );
  await sleep(15_000);
  const deliveriesAfter = await recordDeliveries("03-redelivery", "deliveries-after.json");
  const redeliveredOutcomes = deliveriesAfter.deliveries
    .filter((delivery) => delivery.redelivery === true)
    .map((delivery) => ({
      guid: delivery.guid,
      event: delivery.event,
      statusCode: delivery.status_code,
    }));
  summary.steps.push({
    step: "redelivery",
    attempts: attempts.length,
    outcomesBefore: Object.fromEntries(outcomesBefore),
    redeliveredOutcomes,
  });
  await snapshot("03-redelivery", "after-");
  const commentsAfterRedelivery = await comments(pr.number);
  record("03-redelivery", "comments-after.json", commentsAfterRedelivery);
  const runsAfterRedelivery = await tmList("/runs");
  if (runsAfterRedelivery.length !== runsAfterA.length)
    throw new Error("a redelivery created a new Run");
  if (commentsAfterRedelivery.filter(marker).length !== 1)
    throw new Error("a redelivery duplicated the PR comment");
  record("03-redelivery", "check-runs-A-after.json", await checkRuns(shaA));

  // ---- B: a new push waits for its own preview, A keeps its verdict
  const shaB = await commit(
    branch,
    "proof.txt",
    `commit B ${new Date().toISOString()}\n`,
    "Proof commit B",
  );
  summary.shaB = shaB;
  await waitPull(shaB);
  const queuedB = await waitChecks(
    shaB,
    (v) => names.every((name) => v[name] === "queued"),
    "both checks queued on B",
    180_000,
  );
  record("04-push-waits", "check-runs-B-waiting.json", queuedB);
  const stillA = await checkRuns(shaA);
  record("04-push-waits", "check-runs-A-after-push.json", stillA);
  expectVerdict(
    verdict(stillA),
    { "TestMaster / result": "success", "TestMaster / required-gate": "success" },
    "A after push B",
  );
  await snapshot("04-push-waits", "B-waiting-");
  record("04-push-waits", "comments.json", await comments(pr.number));
  summary.steps.push({
    step: "push-waits-for-own-preview",
    sha: shaB,
    verdict: verdict(queuedB),
    previousVerdict: verdict(stillA),
  });

  // ---- C pushed while B still waits: B is superseded and cancelled on its own SHA
  setPreviewMode("fail");
  const shaC = await commit(
    branch,
    "proof.txt",
    `commit C ${new Date().toISOString()}\n`,
    "Proof commit C",
  );
  summary.shaC = shaC;
  await waitPull(shaC);
  const cancelledB = await waitChecks(
    shaB,
    (v) => names.every((name) => v[name] === "cancelled"),
    "B's checks to be cancelled (superseded)",
    180_000,
  );
  record("05-superseded", "check-runs-B-cancelled.json", cancelledB);
  const stillA2 = await checkRuns(shaA);
  record("05-superseded", "check-runs-A.json", stillA2);
  expectVerdict(
    verdict(stillA2),
    { "TestMaster / result": "success", "TestMaster / required-gate": "success" },
    "A after supersede",
  );
  summary.steps.push({
    step: "superseded",
    sha: shaB,
    supersededBy: shaC,
    verdict: verdict(cancelledB),
  });

  // ---- C: a failing preview concludes failure on both checks
  const deployC = await deploy(shaC, "Failing preview for commit C", need("previewOrigin"));
  record("06-failing-preview", "deployment-C.json", deployC);
  const doneC = await waitChecks(
    shaC,
    (v) => names.every((name) => v[name] === "failure"),
    "both checks failed on C",
  );
  record("06-failing-preview", "check-runs-C.json", doneC);
  expectVerdict(
    verdict(doneC),
    { "TestMaster / result": "failure", "TestMaster / required-gate": "failure" },
    "C",
  );
  const commentsC = await comments(pr.number);
  record("06-failing-preview", "comments-C.json", commentsC);
  if (commentsC.filter(marker).length !== 1)
    throw new Error("expected exactly one TestMaster comment after C");
  await snapshot("06-failing-preview", "C-");
  summary.steps.push({ step: "failing-preview", sha: shaC, verdict: verdict(doneC) });

  // ---- a deployment for the superseded SHA B arrives late: it must create nothing
  setPreviewMode("ok");
  const runsBeforeLate = (await tmList("/runs")).length;
  const lateB = await deploy(
    shaB,
    "Late deployment for superseded commit B",
    need("previewOrigin"),
  );
  record("07-late-deployment", "deployment-B-late.json", lateB);
  await sleep(45_000);
  const runsAfterLate = (await tmList("/runs")).length;
  const bAfterLate = await checkRuns(shaB);
  record("07-late-deployment", "check-runs-B-after-late-deployment.json", bAfterLate);
  record("07-late-deployment", "check-runs-C-after-late-deployment.json", await checkRuns(shaC));
  expectVerdict(
    verdict(bAfterLate),
    { "TestMaster / result": "cancelled", "TestMaster / required-gate": "cancelled" },
    "B after late deployment",
  );
  if (runsAfterLate !== runsBeforeLate)
    throw new Error("a deployment for a superseded SHA created a Run");
  await snapshot("07-late-deployment", "after-");
  summary.steps.push({
    step: "late-deployment",
    sha: shaB,
    runsBefore: runsBeforeLate,
    runsAfter: runsAfterLate,
    verdict: verdict(bAfterLate),
  });

  const allDeliveries = await recordDeliveries("08-deliveries", "deliveries.json");
  summary.deliveryCount = allDeliveries.deliveries.length;
  record(
    "08-deliveries",
    "preview-hits.jsonl",
    readFileSync(join(work, "preview-hits.jsonl"), "utf8"),
  );
  record("02-pr-healthy", "summary.json", summary);
  writeFileSync(join(work, "prove-summary.json"), JSON.stringify(summary, null, 2));
  Object.assign(state, { prNumber: pr.number, shaA, shaB, shaC, branch });
  save();
  console.log(JSON.stringify(summary, null, 2));
}

// ------------------------------------------------------------------------------------ stage: uninstall
async function uninstall() {
  const integrationId = need("integrationId");
  const installationId = need("installationId");
  const before = await tmList(`/integrations/${integrationId}/github/installations`);
  record("09-uninstall", "testmaster-installations-before.json", before);
  if (before.find((row) => row.installationId === installationId)?.state !== "active")
    throw new Error("installation is not active before uninstall");
  const runsBefore = await tmList("/runs");
  const pullsBefore = await tmList(`/integrations/${integrationId}/github/pulls`);
  const response = await appApi("DELETE", `/app/installations/${installationId}`);
  record("09-uninstall", "github-delete-installation.json", {
    status: response.status,
    body: response.json,
  });
  if (response.status !== 204) throw new Error(`DELETE installation -> ${response.status}`);
  const revoked = await until(
    "TestMaster to revoke the installation",
    async () =>
      (await tmList(`/integrations/${integrationId}/github/installations`)).find(
        (row) => row.installationId === installationId && row.state === "revoked",
      ),
    { timeoutMs: 180_000, intervalMs: 3000 },
  );
  record(
    "09-uninstall",
    "testmaster-installations-after.json",
    await tmList(`/integrations/${integrationId}/github/installations`),
  );
  record("09-uninstall", "testmaster-integrations-after.json", await tmList("/integrations"));
  const deliveries = await recordDeliveries("09-uninstall", "github-deliveries.json");
  const uninstallDelivery = deliveries.deliveries.find(
    (delivery) => delivery.event === "installation" && delivery.action === "deleted",
  );
  if (!uninstallDelivery) throw new Error("GitHub recorded no installation.deleted delivery");
  // Redeliver one earlier pull_request event: the revoked installation must create nothing.
  const earlier = deliveries.deliveries.find((delivery) => delivery.event === "pull_request");
  const redelivered = earlier
    ? await appApi("POST", `/app/hook/deliveries/${earlier.id}/attempts`)
    : null;
  await sleep(20_000);
  const runsAfter = await tmList("/runs");
  const pullsAfter = await tmList(`/integrations/${integrationId}/github/pulls`);
  record("09-uninstall", "post-uninstall-redelivery.json", {
    redelivery: redelivered ? { status: redelivered.status, guid: earlier.guid } : null,
    runsBefore: runsBefore.length,
    runsAfter: runsAfter.length,
    pullsBefore: pullsBefore.length,
    pullsAfter: pullsAfter.length,
  });
  record("09-uninstall", "testmaster-pulls-after.json", pullsAfter);
  record("09-uninstall", "testmaster-runs-after.json", runsAfter);
  if (runsAfter.length !== runsBefore.length)
    throw new Error("an event after uninstall created a Run");
  console.log(
    JSON.stringify({ revoked: revoked.state, revokedReason: revoked.revokedReason }, null, 2),
  );
}

// ------------------------------------------------------------------------------------ stage: down
async function down() {
  for (const key of ["setupPid", "serverPid", "previewPid"])
    if (state[key] && alive(state[key])) process.kill(state[key], "SIGTERM");
  for (const tunnel of [state.serverTunnel, state.previewTunnel])
    if (tunnel?.pid && alive(tunnel.pid)) process.kill(tunnel.pid, "SIGTERM");
  await sleep(2000);
  if (state.pgContainer) await exec("docker", ["rm", "-f", state.pgContainer]).catch(() => {});
  for (const path of [
    state.pgInfo?.ownerPasswordFile && dirname(state.pgInfo.ownerPasswordFile),
  ].filter(Boolean))
    rmSync(path, { recursive: true, force: true });
  // Shred private material, then remove the work directory.
  await exec("sh", [
    "-c",
    `find ${JSON.stringify(work)} -type f \\( -name '*.key' -o -name 'state.json' -o -name 'server.json' -o -name '*.password' \\) -exec shred -u {} +`,
  ]).catch(() => {});
  rmSync(work, { recursive: true, force: true });
  log("down: processes stopped, container removed, private material shredded");
}

/** Prints what GitHub knows about the App: installations and recent webhook deliveries (no secrets). */
async function diagnose() {
  const installations = await appApi("GET", "/app/installations");
  const deliveries = await appApi("GET", "/app/hook/deliveries?per_page=20");
  console.log(
    JSON.stringify(
      {
        installations:
          installations.status === 200
            ? installations.json.map((entry) => ({
                id: entry.id,
                account: entry.account?.login,
                selection: entry.repository_selection,
              }))
            : installations.status,
        deliveries:
          deliveries.status === 200
            ? deliveries.json.map((entry) => ({
                id: entry.id,
                event: entry.event,
                action: entry.action,
                status: entry.status,
                statusCode: entry.status_code,
                redelivery: entry.redelivery,
              }))
            : deliveries.status,
      },
      null,
      2,
    ),
  );
  for (const entry of deliveries.json?.slice(0, 2) ?? []) {
    const detail = await appApi("GET", `/app/hook/deliveries/${entry.id}`);
    console.log(detail.status, JSON.stringify(detail.json, null, 1).slice(0, 3000));
  }
}
/** Restarts the server process on the same database, port and tunnel (after a rebuild with a fix). */
async function restart() {
  if (state.serverPid && alive(state.serverPid)) process.kill(state.serverPid, "SIGTERM");
  await until("the old server to exit", () => !alive(state.serverPid), { timeoutMs: 30_000 });
  const logFile = join(work, "server.log");
  const before = readFileSync(logFile, "utf8").length;
  state.serverPid = spawnDetached(
    process.execPath,
    [cliEntry, "server", "start", "--mode", "server", "--config", need("configPath"), "--json"],
    logFile,
    need("env"),
    work,
  );
  save();
  await until(
    "the server to listen",
    () => /"address"/.test(readFileSync(logFile, "utf8").slice(before)),
    {
      timeoutMs: 120_000,
    },
  );
  await reachable(`${need("serverOrigin")}/v1/health/live`, (response) => response.status === 200);
  log("server restarted");
}

/**
 * Redelivers every delivery GitHub recorded as failed (non-2xx) and records the outcome. This proves a
 * failed webhook can be replayed after a fix without duplicating anything.
 */
async function redeliverFailed() {
  const dir = option("dir", "10-failed-push-redelivery");
  const wanted = Number(option("status", "0"));
  const before = await recordDeliveries(dir, "deliveries-before.json");
  const failed = before.deliveries.filter((delivery) =>
    wanted
      ? delivery.status_code === wanted
      : delivery.status_code >= 500 && delivery.redelivery === false,
  );
  const runsBefore = (await tmList("/runs")).length;
  const attempts = [];
  for (const delivery of failed) {
    const response = await appApi("POST", `/app/hook/deliveries/${delivery.id}/attempts`);
    attempts.push({
      id: delivery.id,
      guid: delivery.guid,
      event: delivery.event,
      status: response.status,
    });
  }
  record(dir, "redelivery-attempts.json", attempts);
  await sleep(20_000);
  const after = await recordDeliveries(dir, "deliveries-after.json");
  const replayed = after.deliveries.filter(
    (delivery) =>
      delivery.redelivery === true && failed.some((entry) => entry.guid === delivery.guid),
  );
  const runsAfter = (await tmList("/runs")).length;
  record(dir, "summary.json", {
    failedBefore: failed.map((delivery) => ({
      guid: delivery.guid,
      event: delivery.event,
      statusCode: delivery.status_code,
    })),
    replayed: replayed.map((delivery) => ({
      guid: delivery.guid,
      event: delivery.event,
      statusCode: delivery.status_code,
    })),
    runsBefore,
    runsAfter,
  });
  console.log(
    JSON.stringify({
      failed: failed.length,
      replayed: replayed.map((delivery) => delivery.status_code),
      runsBefore,
      runsAfter,
    }),
  );
}
/** Records the delivery list again after the post-uninstall replay, so the replay's answer is retained. */
async function afterReplay() {
  await recordDeliveries("09-uninstall", "github-deliveries-after-replay.json");
}

const stages = {
  up,
  setup,
  "await-installation": awaitInstallation,
  prove,
  uninstall,
  "after-replay": afterReplay,
  diagnose,
  restart,
  "redeliver-failed": redeliverFailed,
  down,
  "preview-app": previewApp,
};
if (!stages[stage]) {
  console.error(`unknown stage ${stage}; use ${Object.keys(stages).join(", ")}`);
  process.exit(2);
}
await stages[stage]();
if (stage !== "preview-app") process.exit(0);
