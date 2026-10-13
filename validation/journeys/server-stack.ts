import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Application, type ServerConfig } from "@testmaster/application";
import { createTestDatabase } from "@testmaster/persistence/testing";
import { cli, eventually } from "./harness.js";
import {
  createTestCa,
  HttpsClient,
  startTlsProxy,
  type TestCa,
  type TlsProxy,
} from "./tls-proxy.js";

/**
 * A real server-profile deployment for journeys (contract C7): a fresh PostgreSQL database and
 * owner role, `db migrate`, `server bootstrap`, `server start --mode server` from the built CLI as
 * a child process, all behind an in-process TLS-terminating proxy with a generated CA. Cookies
 * (`__Host-`, `Secure`), CSRF/Origin checks and the `tls_required` rule therefore behave as in
 * production. Nothing here talks to the network beyond loopback.
 */
export interface StackUser {
  readonly login: string;
  readonly password: string;
  readonly principalId: string;
  readonly workspaceId: string;
}

export interface StackWorkspace {
  readonly workspaceId: string;
  readonly owner: StackUser;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface ServerStackOptions {
  /** Workspaces to create; the first comes from `server bootstrap`, the rest from the operator API. */
  readonly workspaces?: number;
  /** Also run `worker start --mode server`. */
  readonly worker?: boolean;
  readonly config?: DeepPartial<ServerConfig>;
  /** Files written under the stack's HOME before anything starts (for example `.config/testmaster/profiles.json`). */
  readonly homeFiles?: Readonly<Record<string, string>>;
  /** User policy written to `<home>/.config/testmaster/policy.json` before the server starts. */
  readonly userPolicy?: unknown;
  /** Model profiles written to `<home>/.config/testmaster/profiles.json` before the server starts. */
  readonly profiles?: unknown;
  /** Extra environment for every spawned TestMaster process (for example a fake provider key). */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

export interface ServerStack {
  /** `https://127.0.0.1:<port>` of the TLS proxy: the only origin a browser or client may use. */
  readonly baseUrl: string;
  readonly ca: TestCa;
  readonly proxy: TlsProxy;
  readonly configPath: string;
  readonly workspaceId: string;
  /** Repository directory the server process runs in (project root for discovery and sources). */
  readonly cwd: string;
  /** HOME of the server process; user policy and model profiles live under `.config/testmaster`. */
  readonly home: string;
  readonly owner: StackUser;
  readonly workspaces: readonly StackWorkspace[];
  readonly operatorToken: string;
  /** Signed-in HTTPS client for a workspace owner (cookie session plus CSRF), index 0 by default. */
  ownerClient(workspace?: number): HttpsClient;
  addMember(
    role: string,
    options?: { workspace?: number; login?: string; projectRestrictions?: string[] },
  ): Promise<StackUser>;
  /** Bearer token for a member, issued through `POST /v1/tokens` by the workspace owner. */
  issueToken(
    principalId: string,
    scopes: ("R" | "W" | "X" | "A")[],
    grants?: unknown[],
    workspace?: number,
  ): Promise<string>;
  /** Controller-scoped Application on the same database, for seeding and assertions. */
  scope(): Promise<Application>;
  /** Fresh anonymous client that trusts only the stack CA. */
  anonymous(): HttpsClient;
  logs(): string;
  stop(): Promise<void>;
}

function merge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    result[key] =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current &&
      typeof current === "object"
        ? merge(current, value as DeepPartial<typeof current>)
        : value;
  }
  return result as T;
}

function findString(value: unknown, pattern: RegExp): string | null {
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

function expectString(value: unknown, pattern: RegExp, what: string): string {
  const found = findString(value, pattern);
  if (!found) throw new Error(`Expected ${what} in ${JSON.stringify(value)}`);
  return found;
}

interface Spawned {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<number | null>;
}

function spawnCli(args: string[], env: NodeJS.ProcessEnv, cwd: string): Spawned {
  const child = spawn(process.execPath, [cli, ...args, "--json"], {
    cwd,
    env,
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("close", (code) => resolve(code)),
  );
  return { child, stdout: () => stdout, stderr: () => stderr, exited };
}

function randomPassword(): string {
  return `Pw-${randomBytes(18).toString("base64url")}`;
}

export async function startServerStack(options: ServerStackOptions = {}): Promise<ServerStack> {
  const directory = await mkdtemp(join(tmpdir(), "tm-stack-"));
  const home = join(directory, "home");
  const cwd = join(directory, "repo");
  const evidenceRoot = join(directory, "evidence");
  const keys = join(directory, "keys");
  await Promise.all(
    [home, cwd, evidenceRoot, keys].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  for (const [relative, content] of Object.entries(options.homeFiles ?? {})) {
    const target = join(home, relative);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { mode: 0o600 });
  }
  const masterKeyFile = join(keys, "master.key");
  const backupKeyFile = join(keys, "backup.key");
  for (const file of [masterKeyFile, backupKeyFile]) {
    await writeFile(file, randomBytes(32), { mode: 0o600 });
    await chmod(file, 0o600);
  }

  const database = await createTestDatabase();
  const ca = await createTestCa(join(directory, "ca"));
  let upstreamPort = 0;
  const proxy = await startTlsProxy({ ca, upstreamPort: () => upstreamPort });

  const config = merge<ServerConfig>(
    {
      mode: "server",
      database: { engine: "postgres", ...database.config },
      storage: { kind: "filesystem", root: evidenceRoot },
      server: {
        listen: { host: "127.0.0.1", port: 0 },
        publicOrigin: proxy.origin,
        trustedProxies: ["127.0.0.1"],
        origins: [proxy.origin],
      },
      security: {
        masterKeyFile,
        backupKeyFile,
        atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
      },
    },
    options.config,
  );
  const configPath = join(directory, "server.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(configPath, 0o600);
  if (options.userPolicy !== undefined || options.profiles !== undefined) {
    const settings = join(home, ".config", "testmaster");
    await mkdir(settings, { recursive: true, mode: 0o700 });
    if (options.userPolicy !== undefined)
      await writeFile(join(settings, "policy.json"), JSON.stringify(options.userPolicy), {
        mode: 0o600,
      });
    if (options.profiles !== undefined)
      await writeFile(join(settings, "profiles.json"), JSON.stringify(options.profiles), {
        mode: 0o600,
      });
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    TESTMASTER_NO_TELEMETRY: "true",
    CI: "true",
    ...options.extraEnv,
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

  const spawned: Spawned[] = [];
  const closers: (() => Promise<void>)[] = [];
  const logLines: string[] = [];

  async function run(args: string[]): Promise<unknown> {
    const command = spawnCli(args, env, cwd);
    const code = await command.exited;
    logLines.push(`$ testmaster ${args.join(" ")}\n${redact(command.stderr())}`);
    if (code !== 0)
      throw new Error(
        `testmaster ${args.join(" ")} exited ${code}: ${command.stderr()} ${command.stdout()}`,
      );
    return (JSON.parse(command.stdout()) as { data?: unknown }).data;
  }

  const stack: Partial<ServerStack> = {};
  try {
    await run(["db", "migrate", "--mode", "server", "--config", configPath]);
    const ownerLogin0 = `owner-${randomBytes(4).toString("hex")}`;
    const bootstrap = await run([
      "server",
      "bootstrap",
      "--config",
      configPath,
      "--workspace-name",
      "Stack Workspace 1",
      "--owner-login",
      ownerLogin0,
    ]);
    const bootstrapRecovery = expectString(bootstrap, /^tm_rec_/, "owner recovery token");
    const bootstrapWorkspace = expectString(bootstrap, /^ws_/, "workspace id");
    const operatorToken = expectString(
      await run(["server", "operator-token", "--config", configPath]),
      /^tm_op_/,
      "operator token",
    );

    const server = spawnCli(
      ["server", "start", "--mode", "server", "--config", configPath],
      env,
      cwd,
    );
    spawned.push(server);
    closers.push(async () => {
      server.child.kill("SIGTERM");
      await server.exited;
    });
    const ready = await eventually(
      async () => server.stdout(),
      (output) =>
        /"address"\s*:\s*"http:\/\/127\.0\.0\.1:\d+"/.test(output) ||
        server.child.exitCode !== null,
      120_000,
    );
    const address = /"address"\s*:\s*"http:\/\/127\.0\.0\.1:(\d+)"/.exec(ready);
    if (!address?.[1])
      throw new Error(`server start did not report an address: ${server.stderr()} ${ready}`);
    upstreamPort = Number(address[1]);

    if (options.worker) {
      const worker = spawnCli(
        ["worker", "start", "--mode", "server", "--config", configPath],
        env,
        cwd,
      );
      spawned.push(worker);
      closers.push(async () => {
        worker.child.kill("SIGTERM");
        await worker.exited;
      });
    }

    const anonymous = () => new HttpsClient(proxy.origin, ca.caPem);
    const clients = new Map<number, HttpsClient>();
    const workspaces: StackWorkspace[] = [];

    async function adopt(
      workspaceId: string,
      login: string,
      recoveryToken: string,
    ): Promise<StackUser> {
      const password = randomPassword();
      const recovered = await anonymous().request("POST", "/v1/identity/recovery", {
        body: { principal: login, recoveryToken, newPassword: password },
        headers: { origin: proxy.origin, "idempotency-key": crypto.randomUUID() },
      });
      if (recovered.status !== 200)
        throw new Error(`recovery for ${login} failed: ${recovered.status} ${recovered.text}`);
      const user = await signIn(login, password);
      return { login, password, principalId: user.principalId, workspaceId };
    }

    async function signIn(login: string, password: string) {
      const client = anonymous();
      const response = await client.request("POST", "/v1/identity/login", {
        body: { principal: login, password },
        headers: { origin: proxy.origin, "idempotency-key": crypto.randomUUID() },
      });
      if (response.status !== 200)
        throw new Error(`login for ${login} failed: ${response.status} ${response.text}`);
      const receipt = response.json<{ data: { principalId: string; csrfToken: string } }>().data;
      client.csrfToken = receipt.csrfToken;
      return { client, principalId: receipt.principalId };
    }

    const first = await adopt(bootstrapWorkspace, ownerLogin0, bootstrapRecovery);
    workspaces.push({ workspaceId: bootstrapWorkspace, owner: first });
    clients.set(0, (await signIn(first.login, first.password)).client);

    for (let index = 1; index < (options.workspaces ?? 1); index++) {
      const login = `owner-${randomBytes(4).toString("hex")}`;
      const created = await anonymous().request("POST", "/v1/workspaces", {
        body: {
          name: `Stack Workspace ${index + 1}`,
          ownerLogin: login,
          ownerDisplayName: `Owner ${index + 1}`,
        },
        headers: {
          origin: proxy.origin,
          authorization: `Bearer ${operatorToken}`,
          "idempotency-key": crypto.randomUUID(),
        },
        cookies: false,
      });
      if (created.status !== 201 && created.status !== 200)
        throw new Error(`workspace creation failed: ${created.status} ${created.text}`);
      const body = created.json<{
        data: { workspace: { id: string }; ownerRecoveryToken: string };
      }>().data;
      const owner = await adopt(body.workspace.id, login, body.ownerRecoveryToken);
      workspaces.push({ workspaceId: body.workspace.id, owner });
      clients.set(index, (await signIn(owner.login, owner.password)).client);
    }

    const ownerClient = (workspace = 0): HttpsClient => {
      const client = clients.get(workspace);
      if (!client) throw new Error(`No workspace ${workspace} in this stack`);
      return client;
    };
    let application: Application | null = null;

    Object.assign(stack, {
      baseUrl: proxy.origin,
      cwd,
      home,
      ca,
      proxy,
      configPath,
      workspaceId: bootstrapWorkspace,
      owner: first,
      workspaces,
      operatorToken,
      ownerClient,
      anonymous,
      async addMember(role, memberOptions = {}) {
        const workspace = memberOptions.workspace ?? 0;
        const login =
          memberOptions.login ?? `${role.replace(/_/g, "-")}-${randomBytes(4).toString("hex")}`;
        const workspaceId = (workspaces[workspace] as StackWorkspace).workspaceId;
        const created = await ownerClient(workspace).mutate(
          "POST",
          `/v1/workspaces/${workspaceId}/members`,
          {
            login,
            displayName: `${role} ${login}`,
            role,
            projectRestrictions: memberOptions.projectRestrictions ?? [],
          },
        );
        if (created.status !== 201 && created.status !== 200)
          throw new Error(`member creation failed: ${created.status} ${created.text}`);
        const token = expectString(created.json(), /^tm_rec_/, "member recovery token");
        const member = await adopt(
          (workspaces[workspace] as StackWorkspace).workspaceId,
          login,
          token,
        );
        return member;
      },
      async issueToken(principalId, scopes, grants = [], workspace = 0) {
        const issued = await ownerClient(workspace).mutate("POST", "/v1/tokens", {
          name: `stack-${randomBytes(3).toString("hex")}`,
          scopes,
          grants,
          principalId,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
        if (issued.status !== 201 && issued.status !== 200)
          throw new Error(`token issue failed: ${issued.status} ${issued.text}`);
        return expectString(issued.json(), /^tm_(api|local|op|wrk)_/, "bearer token");
      },
      async scope() {
        application ??= await Application.open({ cwd, home, env, server: config });
        return application.controllerScope();
      },
      logs: () =>
        redact(
          [...logLines, ...spawned.map((entry) => entry.stderr() + entry.stdout())].join("\n"),
        ),
      async stop() {
        for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
        application?.close();
        await proxy.close();
        await database.drop();
        await rm(directory, { recursive: true, force: true });
      },
    } satisfies Partial<ServerStack>);
    return stack as ServerStack;
  } catch (error) {
    for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
    await proxy.close().catch(() => undefined);
    await database.drop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Journey logs may be attached to results: bearer, recovery and operator tokens never are. */
function redact(text: string): string {
  return text.replace(/tm_(?:api|local|wrk|op|rec)_[A-Za-z0-9_-]{20,}/g, "tm_<redacted>");
}
