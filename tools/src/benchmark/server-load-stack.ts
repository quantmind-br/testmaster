import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  Agent,
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type Server,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Application, type ServerConfig } from "@testmaster/application";

const exec = promisify(execFile);

/** The pinned image the repository's PostgreSQL tests use; the benchmark runs it with default durability. */
export const benchmarkPostgresImage =
  "postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24";

/** Nominal public origin the server is configured with; nothing listens on it. */
const publicOrigin = "https://127.0.0.1:8443";

export interface HttpResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
  /** Wall time from request start to the last response byte. */
  readonly ms: number;
}

/**
 * Keep-alive HTTP client that presents itself the way a trusted TLS-terminating proxy would. With
 * `ca` it speaks HTTPS and trusts that certificate authority, for a deployment fronted by a real
 * TLS-terminating proxy.
 */
export class BenchClient {
  private agent: Agent | HttpsAgent;
  constructor(
    readonly baseUrl: URL,
    private readonly defaultToken: string | null = null,
    private readonly ca: string | null = null,
  ) {
    this.agent = this.createAgent();
  }

  private createAgent(): Agent | HttpsAgent {
    const options = { keepAlive: true, maxSockets: 512 };
    return this.ca ? new HttpsAgent({ ...options, ca: this.ca }) : new Agent(options);
  }

  headers(token: string | null, extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: "application/json",
      "x-forwarded-proto": "https",
      "x-forwarded-for": "127.0.0.1",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    };
  }

  call(
    method: string,
    path: string,
    options: {
      body?: unknown;
      token?: string | null;
      headers?: Record<string, string>;
      idempotent?: boolean;
    } = {},
  ): Promise<HttpResult> {
    const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const headers = this.headers(options.token === undefined ? this.defaultToken : options.token, {
      ...(payload
        ? { "content-type": "application/json", "content-length": String(payload.length) }
        : {}),
      ...(options.idempotent ? { "idempotency-key": crypto.randomUUID() } : {}),
      ...options.headers,
    });
    const started = performance.now();
    return new Promise<HttpResult>((resolve, reject) => {
      const call = (this.ca ? httpsRequest : request)(
        {
          host: this.baseUrl.hostname,
          port: this.baseUrl.port,
          path,
          method,
          headers,
          agent: this.agent,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
              ms: performance.now() - started,
            }),
          );
        },
      );
      call.on("error", reject);
      if (payload) call.write(payload);
      call.end();
    });
  }

  /** Opens a server-sent event stream; `onChunk` receives raw text as it arrives. */
  stream(
    path: string,
    token: string,
    onChunk: (text: string) => void,
    onOpen: (status: number) => void,
  ): { close(): void; closed: Promise<void> } {
    const { promise, resolve } = Promise.withResolvers<void>();
    const call = (this.ca ? httpsRequest : request)(
      {
        host: this.baseUrl.hostname,
        port: this.baseUrl.port,
        path,
        method: "GET",
        headers: this.headers(token, { accept: "text/event-stream" }),
        // A dedicated socket per stream, as separate browser tabs would use.
        agent: false,
        ...(this.ca ? { ca: this.ca } : {}),
      },
      (response: IncomingMessage) => {
        onOpen(response.statusCode ?? 0);
        response.setEncoding("utf8");
        response.on("data", onChunk);
        response.on("close", () => resolve());
        response.on("error", () => resolve());
      },
    );
    call.on("error", () => resolve());
    call.end();
    return { close: () => call.destroy(), closed: promise };
  }

  /**
   * Drops pooled sockets. The benchmark process blocks its own event loop while it seeds through
   * the synchronous database bridge, so it cannot notice that the server closed idle connections
   * (keep-alive timeout 65 s); reusing such a socket would fail the next request.
   */
  resetConnections(): void {
    this.agent.destroy();
    this.agent = this.createAgent();
  }

  close(): void {
    this.agent.destroy();
  }
}

export interface FixtureTarget {
  readonly url: string;
  requests(): number;
  close(): Promise<void>;
}

/** Local HTTP target for the Runs the benchmark admits; no external network is involved. */
export async function startFixtureTarget(): Promise<FixtureTarget> {
  let count = 0;
  const server: Server = createServer((incoming, outgoing) => {
    count++;
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(
      incoming.url?.startsWith("/health") ? '{"status":"ok"}' : '{"status":"ok","items":[]}',
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture target has no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: () => count,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const identifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export interface PostgresFacts {
  readonly image: string;
  readonly imageId: string;
  readonly serverVersion: string;
  readonly settings: Record<string, string>;
  readonly dataVolume: string;
  readonly container: string;
}

export interface Spawned {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<number | null>;
}

export function spawnCli(
  cli: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Spawned {
  const child = spawn(process.execPath, [cli, ...args, "--json"], { cwd, env, stdio: "pipe" });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("close", (code) => resolve(code)),
  );
  return { child, stdout: () => stdout, stderr: () => stderr, exited };
}

export function findString(value: unknown, pattern: RegExp): string | null {
  if (typeof value === "string") return pattern.test(value) ? value : null;
  if (Array.isArray(value))
    for (const member of value) {
      const found = findString(member, pattern);
      if (found) return found;
    }
  else if (value && typeof value === "object")
    for (const member of Object.values(value)) {
      const found = findString(member, pattern);
      if (found) return found;
    }
  return null;
}

export function expectString(value: unknown, pattern: RegExp, what: string): string {
  const found = findString(value, pattern);
  if (!found) throw new Error(`Expected ${what} in ${JSON.stringify(value).slice(0, 400)}`);
  return found;
}

export interface PrincipalBootstrap {
  readonly publicOrigin: string;
  readonly workspaceId: string;
  readonly ownerLogin: string;
  /** The one-time `tm_rec_` token `server bootstrap` printed for the owner. */
  readonly recoveryToken: string;
}

export interface Principals {
  readonly owner: BenchPrincipal;
  /** A call authenticated as the owner's browser session (cookie and CSRF token), for setup mutations. */
  ownerSession(method: string, path: string, body?: unknown): Promise<HttpResult>;
  /** Creates a `runner` member (read and execute) with its own bearer token. */
  addRunner(): Promise<BenchPrincipal>;
}

/**
 * Whether an answer says the owner's browser session lapsed. The server ends a session after 30
 * minutes without a request or 12 hours after login (`sessionPolicy` in packages/application/src/
 * identity.ts), and the benchmark's owner session is idle whenever the load runs on bearer tokens,
 * so a long run outlives it. Any other 401 (a revoked token, a bad credential) is not expiry and
 * must reach the caller unchanged.
 */
export function isSessionExpired(status: number, body: Buffer | string): boolean {
  if (status !== 401) return false;
  try {
    const error = (JSON.parse(body.toString()) as { error?: { code?: unknown; message?: unknown } })
      .error;
    return error?.code === "UNAUTHENTICATED" && error.message === "Session is invalid or expired";
  } catch {
    return false;
  }
}

/**
 * Adopts the owner from the bootstrap recovery token, issues the owner's bearer token and returns
 * the means to create runner principals. Setup calls share the server's per-address authentication
 * budget, so they wait for it to refill instead of failing.
 */
export async function bootstrapPrincipals(
  client: BenchClient,
  bootstrap: PrincipalBootstrap,
): Promise<Principals> {
  const { publicOrigin, workspaceId, ownerLogin, recoveryToken } = bootstrap;
  const baseHeaders = { origin: publicOrigin };
  const setupCall: BenchClient["call"] = async (method, path, callOptions) => {
    for (let waited = 0; ; waited += 2_000) {
      const response = await client.call(method, path, callOptions);
      if (response.status !== 429 || waited >= 120_000) return response;
      await sleep(2_000);
    }
  };
  const signIn = async (login: string, password: string) => {
    const response = await setupCall("POST", "/v1/identity/login", {
      body: { principal: login, password },
      headers: baseHeaders,
      idempotent: true,
      token: null,
    });
    if (response.status !== 200)
      throw new Error(`login for ${login} failed: ${response.status} ${response.body}`);
    const cookie = [response.headers["set-cookie"] ?? []]
      .flat()
      .map((value) => value.split(";")[0] ?? "")
      .find((value) => value.startsWith("__Host-tm_session="));
    const receipt = (
      JSON.parse(response.body.toString()) as {
        data: { principalId: string; csrfToken: string };
      }
    ).data;
    if (!cookie) throw new Error("login did not set a session cookie");
    return { principalId: receipt.principalId, csrfToken: receipt.csrfToken, cookie };
  };
  const adopt = async (login: string, token: string) => {
    const password = `Pw-${randomBytes(18).toString("base64url")}`;
    const recovered = await setupCall("POST", "/v1/identity/recovery", {
      body: { principal: login, recoveryToken: token, newPassword: password },
      headers: baseHeaders,
      idempotent: true,
      token: null,
    });
    if (recovered.status !== 200)
      throw new Error(`recovery for ${login} failed: ${recovered.status} ${recovered.body}`);
    return { ...(await signIn(login, password)), password };
  };

  let ownerSession = await adopt(ownerLogin, recoveryToken);
  const ownerPassword = ownerSession.password;
  let relogin: Promise<void> | null = null;
  const sessionCall = async (method: string, path: string, body?: unknown) => {
    const send = () =>
      setupCall(method, path, {
        body,
        token: null,
        idempotent: true,
        headers: {
          ...baseHeaders,
          cookie: ownerSession.cookie,
          "x-csrf-token": ownerSession.csrfToken,
        },
      });
    const response = await send();
    if (!isSessionExpired(response.status, response.body)) return response;
    // A call refused as unauthenticated changed nothing, so it is safe to repeat once on a fresh
    // session. Concurrent callers share one login.
    relogin ??= signIn(ownerLogin, ownerPassword)
      .then((fresh) => {
        ownerSession = { ...ownerSession, ...fresh };
      })
      .finally(() => {
        relogin = null;
      });
    await relogin;
    return send();
  };
  const issueToken = async (principalId: string, scopes: string[]): Promise<string> => {
    const issued = await sessionCall("POST", "/v1/tokens", {
      name: `bench-${randomBytes(3).toString("hex")}`,
      scopes,
      grants: [],
      principalId,
      expiresAt: new Date(Date.now() + 6 * 3_600_000).toISOString(),
    });
    if (issued.status !== 201 && issued.status !== 200)
      throw new Error(`token issue failed: ${issued.status} ${issued.body}`);
    return expectString(
      JSON.parse(issued.body.toString()),
      /^tm_(api|local|op|wrk)_/,
      "bearer token",
    );
  };
  const owner: BenchPrincipal = {
    login: ownerLogin,
    principalId: ownerSession.principalId,
    token: await issueToken(ownerSession.principalId, ["R", "W", "X", "A"]),
  };
  return {
    owner,
    ownerSession: sessionCall,
    async addRunner() {
      const login = `runner-${randomBytes(4).toString("hex")}`;
      const created = await sessionCall("POST", `/v1/workspaces/${workspaceId}/members`, {
        login,
        displayName: `Runner ${login}`,
        role: "runner",
        projectRestrictions: [],
      });
      if (created.status !== 201 && created.status !== 200)
        throw new Error(`member creation failed: ${created.status} ${created.body}`);
      const memberRecovery = expectString(
        JSON.parse(created.body.toString()),
        /^tm_rec_/,
        "member recovery token",
      );
      const member = await adopt(login, memberRecovery);
      return {
        login,
        principalId: member.principalId,
        token: await issueToken(member.principalId, ["R", "X"]),
      };
    },
  };
}
export interface BenchPrincipal {
  readonly login: string;
  readonly principalId: string;
  readonly token: string;
}

export interface BenchStack {
  readonly client: BenchClient;
  readonly workspaceId: string;
  readonly owner: BenchPrincipal;
  readonly serverPid: number;
  readonly workDirectory: string;
  readonly postgres: PostgresFacts;
  /** Creates a `runner` member (read and execute) with its own bearer token. */
  addRunner(): Promise<BenchPrincipal>;
  /** Controller-scoped Application on the same database, for seeding and event production. */
  scope(): Promise<Application>;
  startWorker(): Promise<void>;
  stopWorker(): Promise<void>;
  logs(): string;
  stop(): Promise<void>;
}

export interface BenchStackOptions {
  /** Directory for the evidence root, keys and the PostgreSQL data volume mount point. */
  readonly workDirectory: string;
  /** Path of the built CLI (`apps/cli/dist/main.js`). */
  readonly cli: string;
}

/**
 * A real server-profile deployment on loopback: a PostgreSQL container with the image's default
 * durability (fsync and synchronous_commit on) on a Docker volume, `db migrate`, `server bootstrap`
 * and `server start --mode server` from the built CLI as a child process. Requests reach the
 * server directly on loopback with `X-Forwarded-Proto: https` from a trusted proxy address, so TLS
 * termination and reverse-proxy cost are excluded.
 */
export async function startBenchStack(options: BenchStackOptions): Promise<BenchStack> {
  await mkdir(options.workDirectory, { recursive: true });
  const directory = await mkdtemp(join(options.workDirectory, "tm-s2b-bench-"));
  const home = join(directory, "home");
  const cwd = join(directory, "repo");
  const evidenceRoot = join(directory, "evidence");
  const keys = join(directory, "keys");
  await Promise.all(
    [home, cwd, evidenceRoot, keys].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  const masterKeyFile = join(keys, "master.key");
  const backupKeyFile = join(keys, "backup.key");
  for (const file of [masterKeyFile, backupKeyFile]) {
    await writeFile(file, randomBytes(32), { mode: 0o600 });
    await chmod(file, 0o600);
  }

  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const container = `tm-s2b-bench-pg-${suffix}`;
  const volume = `tm-s2b-bench-pgdata-${suffix}`;
  const adminPassword = randomBytes(18).toString("base64url");
  const ownerRole = `tm_owner_${randomBytes(6).toString("hex")}`;
  const ownerPassword = randomBytes(18).toString("base64url");
  const database = `tm_bench_${randomBytes(4).toString("hex")}`;
  const passwordFile = join(keys, "owner.password");
  await writeFile(passwordFile, ownerPassword, { mode: 0o600 });
  await chmod(passwordFile, 0o600);

  const spawned: Spawned[] = [];
  const closers: (() => Promise<void>)[] = [];
  const logLines: string[] = [];
  const cleanupDocker = async () => {
    await exec("docker", ["rm", "-f", container]).catch(() => undefined);
    await exec("docker", ["volume", "rm", "-f", volume]).catch(() => undefined);
  };
  closers.push(cleanupDocker);
  const psql = (sql: string) =>
    exec("docker", [
      "exec",
      container,
      "psql",
      "-U",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-c",
      sql,
    ]);

  const fail = async (error: unknown): Promise<never> => {
    for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  };

  try {
    await exec("docker", ["volume", "create", volume]);
    await exec("docker", [
      "run",
      "-d",
      "--name",
      container,
      "--label",
      "io.testmaster.benchmark=server-load",
      "-e",
      `POSTGRES_PASSWORD=${adminPassword}`,
      "-e",
      "POSTGRES_INITDB_ARGS=--locale=C --encoding=UTF8",
      "-v",
      `${volume}:/var/lib/postgresql/data`,
      "-p",
      "127.0.0.1::5432",
      benchmarkPostgresImage,
      "-c",
      "max_connections=100",
    ]);
    let ready = false;
    for (let attempt = 0; attempt < 300 && !ready; attempt++) {
      try {
        await psql("SELECT 1");
        ready = true;
      } catch {
        await sleep(200);
      }
    }
    if (!ready) throw new Error("PostgreSQL benchmark container did not become ready");
    // The first start runs initdb, then restarts the server: wait until it stays up.
    await sleep(1500);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await psql("SELECT 1");
        break;
      } catch {
        await sleep(200);
      }
    }
    const mapping =
      (await exec("docker", ["port", container, "5432/tcp"])).stdout.trim().split("\n")[0] ?? "";
    const match = /^127\.0\.0\.1:(\d+)$/u.exec(mapping);
    if (!match)
      throw new Error(`PostgreSQL benchmark container must bind loopback only, got ${mapping}`);
    await psql(
      `CREATE ROLE ${identifier(ownerRole)} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${literal(ownerPassword)}`,
    );
    await psql(
      `CREATE DATABASE ${identifier(database)} OWNER ${identifier(ownerRole)} TEMPLATE template0 LOCALE 'C' ENCODING 'UTF8'`,
    );
    const settings: Record<string, string> = {};
    for (const name of [
      "fsync",
      "synchronous_commit",
      "full_page_writes",
      "shared_buffers",
      "max_connections",
      "wal_level",
      "random_page_cost",
    ])
      settings[name] = (await psql(`SHOW ${name}`)).stdout.trim();
    const serverVersion = (await psql("SHOW server_version")).stdout.trim();
    const imageId = (
      await exec("docker", ["inspect", "--format", "{{.Image}}", container])
    ).stdout.trim();

    const config: ServerConfig = {
      mode: "server",
      database: {
        engine: "postgres",
        url: `postgres://${ownerRole}@127.0.0.1:${match[1]}/${database}`,
        passwordFile,
        applicationName: "testmaster-capacity-benchmark",
      },
      storage: { kind: "filesystem", root: evidenceRoot },
      server: {
        listen: { host: "127.0.0.1", port: 0 },
        publicOrigin,
        trustedProxies: ["127.0.0.1"],
        origins: [publicOrigin],
      },
      security: {
        masterKeyFile,
        backupKeyFile,
        atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
      },
    };
    const configPath = join(directory, "server.json");
    await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    await chmod(configPath, 0o600);

    const env: NodeJS.ProcessEnv = {
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
      delete env[name];

    const run = async (args: string[]): Promise<unknown> => {
      const command = spawnCli(options.cli, args, env, cwd);
      const code = await command.exited;
      logLines.push(`$ testmaster ${args.join(" ")}\n${command.stderr()}`);
      if (code !== 0)
        throw new Error(
          `testmaster ${args.join(" ")} exited ${code}: ${command.stderr()} ${command.stdout()}`,
        );
      return (JSON.parse(command.stdout()) as { data?: unknown }).data;
    };

    await run(["db", "migrate", "--mode", "server", "--config", configPath]);
    const ownerLogin = `owner-${randomBytes(4).toString("hex")}`;
    const bootstrap = await run([
      "server",
      "bootstrap",
      "--config",
      configPath,
      "--workspace-name",
      "Capacity Benchmark Workspace",
      "--owner-login",
      ownerLogin,
    ]);
    const recoveryToken = expectString(bootstrap, /^tm_rec_/, "owner recovery token");
    const workspaceId = expectString(bootstrap, /^ws_/, "workspace id");

    const server = spawnCli(
      options.cli,
      ["server", "start", "--mode", "server", "--config", configPath],
      env,
      cwd,
    );
    spawned.push(server);
    closers.push(async () => {
      server.child.kill("SIGTERM");
      await server.exited;
    });
    let port = 0;
    for (let waited = 0; waited < 120_000 && !port; waited += 100) {
      const found = /"address"\s*:\s*"http:\/\/127\.0\.0\.1:(\d+)"/.exec(server.stdout());
      if (found?.[1]) port = Number(found[1]);
      else if (server.child.exitCode !== null)
        throw new Error(`server start exited: ${server.stderr()} ${server.stdout()}`);
      else await sleep(100);
    }
    if (!port) throw new Error(`server start did not report an address: ${server.stderr()}`);
    const serverPid = server.child.pid;
    if (!serverPid) throw new Error("Server process has no PID");
    const client = new BenchClient(new URL(`http://127.0.0.1:${port}`));
    const principals = await bootstrapPrincipals(client, {
      publicOrigin,
      workspaceId,
      ownerLogin,
      recoveryToken,
    });
    const owner = principals.owner;

    let application: Application | null = null;
    let worker: Spawned | null = null;
    const stack: BenchStack = {
      client,
      workspaceId,
      owner,
      serverPid,
      workDirectory: directory,
      postgres: {
        image: benchmarkPostgresImage,
        imageId,
        serverVersion,
        settings,
        dataVolume: volume,
        container,
      },
      addRunner: () => principals.addRunner(),
      async scope() {
        application ??= await Application.open({ cwd, home, env, server: config });
        return application.controllerScope();
      },
      async startWorker() {
        if (worker) return;
        worker = spawnCli(
          options.cli,
          ["worker", "start", "--mode", "server", "--config", configPath],
          env,
          cwd,
        );
        spawned.push(worker);
      },
      async stopWorker() {
        const current = worker;
        worker = null;
        if (!current) return;
        current.child.kill("SIGTERM");
        await current.exited;
      },
      logs: () =>
        [...logLines, ...spawned.map((entry) => entry.stderr() + entry.stdout())]
          .join("\n")
          .replace(/tm_(?:api|local|wrk|op|rec)_[A-Za-z0-9_-]{20,}/g, "tm_<redacted>"),
      async stop() {
        await stack.stopWorker().catch(() => undefined);
        for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
        application?.close();
        client.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
    return stack;
  } catch (error) {
    return fail(error);
  }
}
