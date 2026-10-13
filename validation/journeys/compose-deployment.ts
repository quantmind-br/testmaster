import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Application, readServerConfig } from "@testmaster/application";
import { eventually } from "./harness.js";
import { HttpsClient } from "./tls-proxy.js";

/**
 * The reference server-profile deployment of `deploy/compose` brought up for real: PostgreSQL 17
 * with TLS, the server image, Caddy with its internal CA, plus host-side CLI commands and workers
 * (ADR-016). It runs on whatever daemon `DOCKER_HOST` names; the rootless project points that at
 * the rootless daemon. Ports are allocated per run and every resource carries the project name
 * `tm-s2a-<random>`.
 */
const root = resolve(import.meta.dirname, "../..");
const composeDirectory = join(root, "deploy/compose");
const cli = join(root, "apps/cli/dist/main.js");
const postgresImage =
  "postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24";

export interface Spawned {
  readonly child: ChildProcessWithoutNullStreams;
  stdout(): string;
  stderr(): string;
  readonly exited: Promise<number | null>;
}

export interface ComposeDeployment {
  readonly directory: string;
  readonly project: string;
  readonly baseUrl: string;
  readonly caPem: string;
  readonly hostConfigPath: string;
  readonly workspaceId: string;
  readonly owner: { login: string; password: string; principalId: string };
  /** Signed-in owner client (cookie session plus CSRF) through Caddy. */
  readonly client: HttpsClient;
  anonymous(): HttpsClient;
  signIn(): Promise<HttpsClient>;
  /** `docker compose` against this deployment; resolves with stdout, rejects with stderr. */
  compose(...args: string[]): Promise<string>;
  /** Host-side CLI with the host configuration; resolves with the parsed `data` envelope. */
  cli(...args: string[]): Promise<unknown>;
  /** Long-running host process (a worker) with the daemon selection inherited. */
  spawn(...args: string[]): Spawned;
  /** Controller-scoped Application on the same database (host side), for assertions and seeding. */
  scope(): Promise<Application>;
  /** Stops the deployment and removes everything it created. */
  teardown(): Promise<void>;
}

function run(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolvePromise, reject) =>
    execFile(file, args, { ...options, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
      error
        ? reject(
            new Error(`${file} ${args.join(" ")} failed: ${stderr || stdout || error.message}`),
          )
        : resolvePromise(stdout),
    ),
  );
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port allocated");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

const secretValue = () =>
  randomBytes(18)
    .toString("base64url")
    .replace(/[^A-Za-z0-9]/gu, "x");

function findString(value: unknown, pattern: RegExp): string {
  if (typeof value === "string" && pattern.test(value)) return value;
  if (value && typeof value === "object")
    for (const child of Object.values(value)) {
      try {
        return findString(child, pattern);
      } catch {
        // keep looking
      }
    }
  throw new Error(`no value matching ${pattern} in ${JSON.stringify(value)}`);
}

export async function startComposeDeployment(): Promise<ComposeDeployment> {
  const directory = await mkdtemp(join(tmpdir(), "tm-s2a-dep-"));
  const project = `tm-s2a-${randomBytes(3).toString("hex")}`;
  const pgPort = await freePort();
  const publicPort = await freePort();
  const paths = {
    evidence: join(directory, "evidence"),
    keys: join(directory, "keys"),
    tls: join(directory, "tls"),
    pgdata: join(directory, "pgdata"),
    backups: join(directory, "backups"),
    home: join(directory, "home"),
    repo: join(directory, "repo"),
  };
  await Promise.all(
    Object.values(paths).map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  await chmod(directory, 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: paths.home,
    XDG_CONFIG_HOME: join(paths.home, ".config"),
    XDG_DATA_HOME: join(paths.home, ".local/share"),
    TESTMASTER_NO_TELEMETRY: "true",
    CI: "true",
    COMPOSE_ENV_FILES: join(directory, ".env"),
  };
  for (const name of [
    "TESTMASTER_ENDPOINT",
    "TESTMASTER_PROFILE",
    "TESTMASTER_API_KEY",
    "NODE_OPTIONS",
    "PGPASSWORD",
  ])
    delete env[name];
  const compose = (...args: string[]) =>
    run("docker", ["compose", ...args], { cwd: composeDirectory, env });
  const hostCli = async (...args: string[]) => {
    const out = await run(process.execPath, [cli, ...args, "--json"], { cwd: paths.repo, env });
    return (JSON.parse(out) as { data?: unknown }).data;
  };

  let application: Application | undefined;
  const teardown = async () => {
    application?.close();
    await compose("down", "-v", "--remove-orphans").catch(() => undefined);
    // Database files belong to a subordinate uid on a rootless daemon; hand them back first.
    await run(
      "docker",
      [
        "run",
        "--rm",
        "--entrypoint",
        "chown",
        "-v",
        `${paths.pgdata}:/d`,
        postgresImage,
        "-R",
        "0:0",
        "/d",
      ],
      { cwd: directory, env },
    ).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  };

  try {
    await run("bash", [join(composeDirectory, "gen-tls.sh"), paths.tls], { cwd: directory, env });
    for (const name of ["master.key", "backup.key"])
      await hostCli("server", "keygen", "--out", join(paths.keys, name));
    const adminPassword = join(directory, "pg-admin.password");
    const dbPassword = join(directory, "db.password");
    await writeFile(adminPassword, `${secretValue()}${secretValue()}\n`, { mode: 0o600 });
    await writeFile(dbPassword, `${secretValue()}${secretValue()}\n`, { mode: 0o600 });
    const publicOrigin = `https://localhost:${publicPort}`;
    const configuration = (kind: "server" | "host") => ({
      mode: "server",
      database: {
        engine: "postgres",
        url:
          kind === "server"
            ? "postgres://testmaster@postgres:5432/testmaster?sslmode=verify-full"
            : `postgres://testmaster@127.0.0.1:${pgPort}/testmaster?sslmode=verify-full`,
        passwordFile: kind === "server" ? "/run/testmaster/db.password" : dbPassword,
        caFile: kind === "server" ? "/etc/testmaster/tls/ca.crt" : join(paths.tls, "ca.crt"),
      },
      storage: { kind: "filesystem", root: paths.evidence },
      server: {
        listen: { host: "0.0.0.0", port: 7331 },
        publicOrigin,
        trustedProxies: ["172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"],
        origins: [publicOrigin],
      },
      security: {
        masterKeyFile: join(paths.keys, "master.key"),
        backupKeyFile: join(paths.keys, "backup.key"),
        atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
      },
    });
    const serverConfig = join(directory, "server.json");
    const hostConfig = join(directory, "host.json");
    await writeFile(serverConfig, JSON.stringify(configuration("server"), null, 2), {
      mode: 0o600,
    });
    await writeFile(hostConfig, JSON.stringify(configuration("host"), null, 2), { mode: 0o600 });
    await writeFile(
      join(directory, ".env"),
      Object.entries({
        TESTMASTER_COMPOSE_PROJECT: project,
        TESTMASTER_RUNTIME_DIR: root,
        TESTMASTER_CONFIG: serverConfig,
        TESTMASTER_DATA_DIR: paths.evidence,
        TESTMASTER_KEY_DIR: paths.keys,
        TESTMASTER_BACKUP_DIR: paths.backups,
        TESTMASTER_PG_DATA: paths.pgdata,
        TESTMASTER_TLS_DIR: paths.tls,
        TESTMASTER_PG_ADMIN_PASSWORD_FILE: adminPassword,
        TESTMASTER_DB_PASSWORD_FILE: dbPassword,
        TESTMASTER_PG_PORT: String(pgPort),
        TESTMASTER_PUBLIC_PORT: String(publicPort),
        TESTMASTER_PUBLIC_HOST: "localhost",
      })
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    );

    // The README sequence, verbatim: database first, then provisioning, migration, bootstrap.
    await compose("up", "-d", "--wait", "postgres");
    await run("bash", [join(composeDirectory, "provision-db.sh"), dbPassword], {
      cwd: composeDirectory,
      env,
    });
    await hostCli("db", "migrate", "--mode", "server", "--config", hostConfig);
    const ownerLogin = `owner-${randomBytes(4).toString("hex")}`;
    const bootstrap = await hostCli(
      "server",
      "bootstrap",
      "--config",
      hostConfig,
      "--workspace-name",
      "Compose Workspace",
      "--owner-login",
      ownerLogin,
    );
    const recoveryToken = findString(bootstrap, /^tm_rec_/u);
    const workspaceId = findString(bootstrap, /^ws_/u);
    await compose("up", "-d", "--build", "--wait", "server", "caddy");

    const caFile = join(directory, "caddy-root.crt");
    await compose("cp", "caddy:/data/caddy/pki/authorities/local/root.crt", caFile);
    const caPem = await readFile(caFile, "utf8");
    const anonymous = () => new HttpsClient(publicOrigin, caPem);
    await eventually(
      async () =>
        (
          await anonymous()
            .request("GET", "/v1/health/live")
            .catch(() => null)
        )?.status,
      (status) => status === 200,
      60_000,
    );

    const password = `Pw-${randomBytes(18).toString("base64url")}`;
    const recovered = await anonymous().request("POST", "/v1/identity/recovery", {
      body: { principal: ownerLogin, recoveryToken, newPassword: password },
      headers: { origin: publicOrigin, "idempotency-key": crypto.randomUUID() },
    });
    if (recovered.status !== 200)
      throw new Error(`recovery failed: ${recovered.status} ${recovered.text}`);
    const signIn = async () => {
      const client = anonymous();
      const response = await client.request("POST", "/v1/identity/login", {
        body: { principal: ownerLogin, password },
        headers: { origin: publicOrigin, "idempotency-key": crypto.randomUUID() },
      });
      if (response.status !== 200)
        throw new Error(`login failed: ${response.status} ${response.text}`);
      const receipt = response.json<{ data: { principalId: string; csrfToken: string } }>().data;
      client.csrfToken = receipt.csrfToken;
      return { client, principalId: receipt.principalId };
    };
    const session = await signIn();
    return {
      directory,
      project,
      baseUrl: publicOrigin,
      caPem,
      hostConfigPath: hostConfig,
      workspaceId,
      owner: { login: ownerLogin, password, principalId: session.principalId },
      client: session.client,
      anonymous,
      signIn: async () => (await signIn()).client,
      compose,
      cli: hostCli,
      spawn(...args: string[]): Spawned {
        const child = spawn(process.execPath, [cli, ...args], {
          cwd: paths.repo,
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
        return {
          child,
          stdout: () => stdout,
          stderr: () => stderr,
          exited: new Promise((done) => child.once("close", (code) => done(code))),
        };
      },
      async scope() {
        application ??= await Application.open({
          cwd: paths.repo,
          home: paths.home,
          env: {},
          server: await readServerConfig(hostConfig),
        });
        return application.controllerScope();
      },
      teardown,
    };
  } catch (error) {
    await teardown();
    throw error;
  }
}
