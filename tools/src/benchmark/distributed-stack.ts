import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { openS3Store } from "@testmaster/application";
import {
  BenchClient,
  type BenchPrincipal,
  benchmarkPostgresImage,
  bootstrapPrincipals,
  expectString,
  type HttpResult,
  type Principals,
  type Spawned,
  spawnCli,
} from "./server-load-stack.js";

/**
 * The distributed-profile reference deployment of `deploy/compose/compose.distributed.yaml` brought
 * up for real on the default Docker daemon, the way `validation/journeys/distributed-deployment.ts`
 * does it for the journeys: PostgreSQL 17 with TLS, MinIO with TLS, two controllers and Caddy in
 * front of both. Remote workers run as host processes, as they would on their own hosts. The
 * benchmark client talks to Caddy over HTTPS, so TLS termination, round-robin and the controllers'
 * relaying are part of what is measured. Every resource carries the project name `tm-cap-<random>`.
 *
 * This is a copy of the journey helper's bootstrap rather than an import because the tools package
 * builds from its own `src` only and the journey helper pulls in the test framework.
 */
const composeFile = "compose.distributed.yaml";
const REGION = "us-east-1";
/** Bucket names the benchmark deployment creates; the evidence bucket is what storage growth measures. */
export const evidenceBucket = "tm-evidence";
const backupBucket = "tm-backups";
/** Controllers are live while their heartbeat is younger than this (ADR-035). */
const LIVE_MS = 30_000;

export const controllerNames = ["server", "server-2"] as const;
export type ControllerName = (typeof controllerNames)[number];

export interface LiveController {
  readonly id: string;
  readonly name: ControllerName;
  readonly internalOrigin: string;
  readonly heartbeatAt: string;
}

export interface RemoteWorker {
  readonly name: string;
  readonly workerId: string;
  readonly slots: number;
  readonly process: Spawned;
}

export interface DistributedBenchOptions {
  /** Repository root: the compose files and the built CLI are read from it. */
  readonly root: string;
  /** Directory for keys, TLS material, the PostgreSQL and MinIO data directories. */
  readonly workDirectory: string;
}

/** The read side of the evidence bucket that the benchmark needs; the S3 object store satisfies it. */
export interface EvidenceReader {
  /** null when the object is absent; throws when the store cannot answer. */
  head(key: string): Promise<{ sizeBytes: number } | null>;
  /** null when the object is absent. */
  get(key: string): Promise<AsyncIterable<Uint8Array> | null>;
  /** Every key under `prefix`, any depth. */
  list(prefix: string): AsyncIterable<{ key: string; sizeBytes: number; modifiedAt: Date }>;
}

export interface DistributedBenchStack {
  readonly project: string;
  readonly directory: string;
  /** The public origin of Caddy; every client call goes through it. */
  readonly publicOrigin: string;
  readonly workspaceId: string;
  readonly client: BenchClient;
  readonly principals: Principals;
  readonly owner: BenchPrincipal;
  /**
   * The evidence bucket read through the S3 API with the deployment's own evidence credential, the
   * way a controller reads it; the on-disk layout of MinIO is never consulted.
   */
  readonly evidence: EvidenceReader;
  /** Shell command that removes what `--keep-stack-on-failure` left behind. */
  readonly removalCommand: string;
  /** `docker compose -f compose.distributed.yaml` against this deployment. */
  compose(...args: string[]): Promise<string>;
  /** Runs a read-only statement as the PostgreSQL superuser and returns its rows. */
  sql<T>(statement: string): Promise<T[]>;
  /** Runs a statement that changes state; only the backpressure phase uses it, to fake worker presence. */
  execSql(statement: string): Promise<void>;
  /** Id of the running container of a compose service, or null when it has none. */
  containerId(service: string): Promise<string | null>;
  liveControllers(): Promise<LiveController[]>;
  startWorker(name: string, slots: number): Promise<RemoteWorker>;
  stopWorker(worker: RemoteWorker, signal?: NodeJS.Signals): Promise<void>;
  logs(service: string): Promise<string>;
  teardown(): Promise<void>;
}

/** Reads `path` out of parsed JSON without trusting its shape; undefined when any step is missing. */
export function jsonAt(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** The `data` member of an API envelope body. */
export function dataOf(result: HttpResult): unknown {
  return jsonAt(JSON.parse(result.body.toString()), "data");
}

const execFileAsync = promisify(execFile);

async function run(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<string> {
  try {
    return (await execFileAsync(file, args, { ...options, maxBuffer: 256 * 1024 * 1024 })).stdout;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const output = jsonAt(failure, "stderr") || jsonAt(failure, "stdout") || failure.message;
    throw new Error(`${file} ${args.join(" ")} failed: ${String(output)}`);
  }
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

export async function startDistributedBenchStack(
  options: DistributedBenchOptions,
): Promise<DistributedBenchStack> {
  const composeDirectory = join(options.root, "deploy/compose");
  const cli = join(options.root, "apps/cli/dist/main.js");
  await readFile(cli).catch(() => {
    throw new Error(`The built CLI ${cli} is missing; run pnpm build first`);
  });
  await mkdir(options.workDirectory, { recursive: true });
  const directory = await mkdtemp(join(options.workDirectory, "tm-cap-dist-"));
  const project = `tm-cap-${randomBytes(3).toString("hex")}`;
  const [pgPort, publicPort, s3Port, port1, port2] = [
    await freePort(),
    await freePort(),
    await freePort(),
    await freePort(),
    await freePort(),
  ];
  const paths = {
    keys: join(directory, "keys"),
    backupKeys: join(directory, "backup-keys"),
    tls: join(directory, "tls"),
    pgdata: join(directory, "pgdata"),
    minio: join(directory, "minio"),
    staging: join(directory, "staging"),
    staging2: join(directory, "staging-2"),
    hostStaging: join(directory, "host-staging"),
    secrets: join(directory, "secrets"),
    home: join(directory, "home"),
    repo: join(directory, "repo"),
  };
  await Promise.all(
    Object.values(paths).map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  await chmod(directory, 0o755);
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
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
    "TESTMASTER_DATA_DIR",
    "NODE_OPTIONS",
    "PGPASSWORD",
  ])
    delete env[name];
  const compose = (...args: string[]) =>
    run("docker", ["compose", "-f", composeFile, ...args], { cwd: composeDirectory, env });
  const hostCli = async (...args: string[]) => {
    const out = await run(process.execPath, [cli, ...args, "--json"], {
      cwd: paths.repo,
      env,
    });
    return (JSON.parse(out) as { data?: unknown }).data;
  };

  let evidenceStore: { close(): void } | undefined;
  const spawned: Spawned[] = [];
  const stop = async (process: Spawned, signal: NodeJS.Signals) => {
    if (process.child.exitCode !== null || process.child.signalCode !== null) return;
    // A frozen process ignores SIGTERM until it is continued.
    process.child.kill("SIGCONT");
    process.child.kill(signal);
    const kill = setTimeout(() => process.child.kill("SIGKILL"), 60_000);
    await process.exited;
    clearTimeout(kill);
  };
  const teardown = async () => {
    for (const child of spawned.splice(0)) await stop(child, "SIGTERM");
    evidenceStore?.close();
    await compose("down", "-v", "--remove-orphans").catch(() => undefined);
    // PostgreSQL's files belong to its own uid; hand them back before removing the directory.
    await run(
      "docker",
      [
        "run",
        "--rm",
        "--entrypoint",
        "chown",
        "-v",
        `${paths.pgdata}:/d`,
        benchmarkPostgresImage,
        "-R",
        `${uid}:${gid}`,
        "/d",
      ],
      { cwd: directory, env },
    ).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  };

  try {
    await run("bash", [join(composeDirectory, "gen-tls.sh"), paths.tls], {
      cwd: directory,
      env,
    });
    for (const [dir, name] of [
      [paths.keys, "master.key"],
      [paths.backupKeys, "backup.key"],
    ] as const)
      await hostCli("server", "keygen", "--out", join(dir, name));
    const secretFile = async (name: string, value: string) => {
      const path = join(paths.secrets, name);
      await writeFile(path, `${value}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
      return path;
    };
    const files = {
      pgAdmin: await secretFile("pg-admin.password", `${secretValue()}${secretValue()}`),
      db: await secretFile("db.password", `${secretValue()}${secretValue()}`),
      minioUser: await secretFile("minio-root-user", `root${secretValue()}`),
      minioPassword: await secretFile("minio-root-password", `${secretValue()}${secretValue()}`),
      evidenceId: await secretFile("s3-evidence-id", `ev${secretValue()}`),
      evidenceSecret: await secretFile("s3-evidence-secret", `${secretValue()}${secretValue()}`),
      backupId: await secretFile("s3-backup-id", `bk${secretValue()}`),
      backupSecret: await secretFile("s3-backup-secret", `${secretValue()}${secretValue()}`),
    };
    const caFile = join(paths.tls, "ca.crt");

    const publicOrigin = `https://localhost:${publicPort}`;
    const s3Endpoint = { container: "https://minio:9000", host: `https://localhost:${s3Port}` };
    const databaseUrl = (host: string) =>
      `postgres://testmaster@${host}/testmaster?sslmode=verify-full`;
    const common = (where: "container" | "host") => ({
      database: {
        engine: "postgres",
        url: databaseUrl(where === "container" ? "postgres:5432" : `127.0.0.1:${pgPort}`),
        passwordFile: where === "container" ? "/run/testmaster/db.password" : files.db,
        caFile: where === "container" ? "/etc/testmaster/tls/ca.crt" : caFile,
      },
      storage: {
        kind: "s3",
        endpoint: where === "container" ? s3Endpoint.container : s3Endpoint.host,
        region: REGION,
        bucket: evidenceBucket,
        forcePathStyle: true,
        accessKeyIdFile:
          where === "container" ? "/run/testmaster/s3-access-key-id" : files.evidenceId,
        secretAccessKeyFile:
          where === "container" ? "/run/testmaster/s3-secret-access-key" : files.evidenceSecret,
        caFile: where === "container" ? "/etc/testmaster/tls/ca.crt" : caFile,
        capacityBytes: 50 * 1024 ** 3,
        stagingRoot: where === "container" ? "/var/lib/testmaster/staging" : paths.hostStaging,
      },
      security: {
        masterKeyFile:
          where === "container"
            ? "/etc/testmaster/keys/master.key"
            : join(paths.keys, "master.key"),
        // Only the backup agent's host holds the backup key; the controllers never mount it.
        backupKeyFile:
          where === "container"
            ? "/etc/testmaster/keys/backup.key"
            : join(paths.backupKeys, "backup.key"),
        atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
      },
    });
    const trustedProxies = ["172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"];
    const controllerBackup = {
      destination: {
        kind: "s3",
        endpoint: s3Endpoint.container,
        region: REGION,
        bucket: backupBucket,
        forcePathStyle: true,
        accessKeyIdFile: "/etc/testmaster-backup/s3-access-key-id",
        secretAccessKeyFile: "/etc/testmaster-backup/s3-secret-access-key",
        caFile: "/etc/testmaster/tls/ca.crt",
      },
      schedule: "disabled",
      retention: { daily: 7, weekly: 4, monthly: 3 },
    };
    const controllerConfig = (name: ControllerName) => ({
      mode: "distributed",
      ...common("container"),
      backup: controllerBackup,
      server: {
        listen: { host: "0.0.0.0", port: 7331 },
        publicOrigin,
        internalOrigin: `http://${name}:7331`,
        expectedControllers: 2,
        trustedProxies,
        origins: [publicOrigin],
      },
    });
    const hostConfig = {
      mode: "distributed",
      ...common("host"),
      server: {
        listen: { host: "127.0.0.1", port: 7331 },
        publicOrigin,
        internalOrigin: "http://127.0.0.1:7331",
        expectedControllers: 2,
        trustedProxies,
        origins: [publicOrigin],
      },
    };
    const writeConfig = async (name: string, value: unknown) => {
      const path = join(directory, name);
      await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
      await chmod(path, 0o600);
      return path;
    };
    const config1 = await writeConfig("server-1.json", controllerConfig("server"));
    const config2 = await writeConfig("server-2.json", controllerConfig("server-2"));
    const hostConfigPath = await writeConfig("host.json", hostConfig);
    await writeFile(
      join(directory, ".env"),
      Object.entries({
        TESTMASTER_COMPOSE_PROJECT: project,
        TESTMASTER_RUNTIME_DIR: options.root,
        TESTMASTER_CONFIG: config1,
        TESTMASTER_CONFIG_2: config2,
        TESTMASTER_STAGING_DIR: paths.staging,
        TESTMASTER_STAGING_DIR_2: paths.staging2,
        TESTMASTER_KEY_DIR: paths.keys,
        TESTMASTER_PG_DATA: paths.pgdata,
        TESTMASTER_MINIO_DATA: paths.minio,
        TESTMASTER_TLS_DIR: paths.tls,
        TESTMASTER_PG_ADMIN_PASSWORD_FILE: files.pgAdmin,
        TESTMASTER_DB_PASSWORD_FILE: files.db,
        TESTMASTER_MINIO_ROOT_USER_FILE: files.minioUser,
        TESTMASTER_MINIO_ROOT_PASSWORD_FILE: files.minioPassword,
        TESTMASTER_S3_EVIDENCE_ID_FILE: files.evidenceId,
        TESTMASTER_S3_EVIDENCE_SECRET_FILE: files.evidenceSecret,
        TESTMASTER_S3_BACKUP_ID_FILE: files.backupId,
        TESTMASTER_S3_BACKUP_SECRET_FILE: files.backupSecret,
        TESTMASTER_S3_BUCKET: evidenceBucket,
        TESTMASTER_S3_BACKUP_BUCKET: backupBucket,
        TESTMASTER_BACKUP_LOCK_DAYS: "1",
        TESTMASTER_PG_PORT: String(pgPort),
        TESTMASTER_S3_PORT: String(s3Port),
        TESTMASTER_CONTROLLER_PORT: String(port1),
        TESTMASTER_CONTROLLER_PORT_2: String(port2),
        TESTMASTER_PUBLIC_PORT: String(publicPort),
        TESTMASTER_PUBLIC_HOST: "localhost",
        TESTMASTER_CONTAINER_USER: `${uid}:${gid}`,
      })
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    );

    // The README sequence: database and object store first, provisioning, migration, bootstrap, then
    // the controllers and the proxy.
    await compose("up", "-d", "--wait", "postgres", "minio");
    await run("bash", [join(composeDirectory, "provision-db.sh"), files.db], {
      cwd: composeDirectory,
      env: { ...env, COMPOSE_FILE: composeFile },
    });
    await compose("run", "--rm", "minio-init");
    await hostCli("db", "migrate", "--mode", "server", "--config", hostConfigPath);
    const ownerLogin = `owner-${randomBytes(4).toString("hex")}`;
    const bootstrap = await hostCli(
      "server",
      "bootstrap",
      "--config",
      hostConfigPath,
      "--workspace-name",
      "Distributed Capacity Workspace",
      "--owner-login",
      ownerLogin,
    );
    const recoveryToken = expectString(bootstrap, /^tm_rec_/u, "owner recovery token");
    const workspaceId = expectString(bootstrap, /^ws_/u, "workspace id");
    await compose("up", "-d", "--build", "--wait", "server", "server-2", "caddy");

    const caddyRoot = join(directory, "caddy-root.crt");
    await compose("cp", "caddy:/data/caddy/pki/authorities/local/root.crt", caddyRoot);
    const caddyPem = await readFile(caddyRoot, "utf8");
    const client = new BenchClient(new URL(publicOrigin), null, caddyPem);
    let healthy = false;
    for (let waited = 0; waited < 60_000 && !healthy; waited += 500) {
      healthy = await client.call("GET", "/v1/health/live", { token: null }).then(
        (result) => result.status === 200,
        () => false,
      );
      if (!healthy) await sleep(500);
    }
    if (!healthy) throw new Error("Caddy did not answer /v1/health/live within 60 s");
    const principals = await bootstrapPrincipals(client, {
      publicOrigin,
      workspaceId,
      ownerLogin,
      recoveryToken,
    });

    const sql = async <T>(statement: string): Promise<T[]> => {
      const out = await compose(
        "exec",
        "-T",
        "postgres",
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "testmaster",
        "-At",
        "-c",
        `SELECT coalesce(json_agg(t), '[]'::json) FROM (${statement}) t`,
      );
      return JSON.parse(out.trim()) as T[];
    };

    const evidence = await openS3Store({
      endpoint: s3Endpoint.host,
      region: REGION,
      bucket: evidenceBucket,
      forcePathStyle: true,
      accessKeyIdFile: files.evidenceId,
      secretAccessKeyFile: files.evidenceSecret,
      caFile,
    });
    evidenceStore = evidence;

    const stack: DistributedBenchStack = {
      project,
      directory,
      publicOrigin,
      workspaceId,
      client,
      principals,
      owner: principals.owner,
      evidence,
      removalCommand: `COMPOSE_ENV_FILES=${join(directory, ".env")} docker compose -f ${join(composeDirectory, composeFile)} down -v --remove-orphans && docker run --rm --entrypoint chown -v ${paths.pgdata}:/d ${benchmarkPostgresImage} -R ${uid}:${gid} /d && rm -rf ${directory}`,
      compose,
      sql,
      async execSql(statement) {
        await compose(
          "exec",
          "-T",
          "postgres",
          "psql",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          "postgres",
          "-d",
          "testmaster",
          "-c",
          statement,
        );
      },
      async containerId(service) {
        const id = (await compose("ps", "-q", service)).trim().split("\n")[0];
        return id ? id : null;
      },
      async liveControllers() {
        const rows = await sql<{ id: string; internal_origin: string; heartbeat_at: string }>(
          "SELECT id,internal_origin,heartbeat_at FROM controller_instances WHERE stopped_at IS NULL ORDER BY started_at",
        );
        const latest = new Map<ControllerName, LiveController>();
        for (const row of rows) {
          if (Date.now() - Date.parse(row.heartbeat_at) > LIVE_MS) continue;
          const name = controllerNames.find(
            (candidate) => `http://${candidate}:7331` === row.internal_origin,
          );
          if (name)
            latest.set(name, {
              id: row.id,
              name,
              internalOrigin: row.internal_origin,
              heartbeatAt: row.heartbeat_at,
            });
        }
        return [...latest.values()];
      },
      async startWorker(name, slots) {
        const enrolled = await principals.ownerSession("POST", "/v1/workers", {
          name: `${name}-${randomBytes(4).toString("hex")}`,
        });
        if (enrolled.status >= 300)
          throw new Error(`worker enrollment failed: ${enrolled.status} ${enrolled.body}`);
        const data = dataOf(enrolled);
        const workerId = jsonAt(data, "worker", "id");
        if (typeof workerId !== "string")
          throw new Error(`worker enrollment returned no worker id: ${enrolled.body}`);
        const token = expectString(data, /^tm_wrk_/u, "worker enrollment token");
        const workerDirectory = join(paths.repo, ".workers", name);
        await mkdir(workerDirectory, { recursive: true, mode: 0o700 });
        const tokenFile = join(workerDirectory, "enroll.token");
        const workerCa = join(workerDirectory, "ca.pem");
        await writeFile(tokenFile, token, { mode: 0o600 });
        await writeFile(workerCa, caddyPem, { mode: 0o600 });
        const process = spawnCli(
          cli,
          [
            "worker",
            "start",
            "--mode",
            "remote",
            "--controller",
            publicOrigin,
            "--ca-file",
            workerCa,
            "--enroll-token-file",
            tokenFile,
            "--data-dir",
            join(workerDirectory, "data"),
            "--slots",
            String(slots),
          ],
          env,
          paths.repo,
        );
        spawned.push(process);
        for (let waited = 0; waited < 120_000; waited += 250) {
          if (/"event"\s*:\s*"worker\.ready"/u.test(process.stderr())) break;
          if (process.child.exitCode !== null)
            throw new Error(`remote worker ${name} exited: ${process.stderr()}`);
          await sleep(250);
        }
        if (!/"event"\s*:\s*"worker\.ready"/u.test(process.stderr()))
          throw new Error(`remote worker ${name} did not become ready: ${process.stderr()}`);
        return { name, workerId, slots, process };
      },
      stopWorker: (worker, signal = "SIGTERM") => stop(worker.process, signal),
      logs: (service) => compose("logs", "--no-color", "--no-log-prefix", service),
      teardown,
    };
    return stack;
  } catch (error) {
    await teardown();
    throw error;
  }
}
