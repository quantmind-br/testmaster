import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Application, readServerConfig } from "@testmaster/application";
import { S3ObjectStore } from "../../packages/evidence/src/object-store.js";
import { findString, freePort, run, secretValue } from "./compose-deployment.js";
import { eventually } from "./harness.js";
import { type Spawned, spawnCli } from "./server-stack.js";
import { createTestCa, HttpsClient, startTlsProxy, type TlsProxy } from "./tls-proxy.js";

/**
 * The distributed-profile reference deployment of `deploy/compose/compose.distributed.yaml` brought
 * up for real on the default (rootful) Docker daemon: PostgreSQL 17 with TLS, MinIO with TLS and
 * its bootstrap, two controllers (`server`, `server-2`) and Caddy in front of both. Host-side
 * processes (CLI, backup agent, remote workers, tunnel agents) reach it like operators would.
 *
 * Each controller also has its own loopback TLS front owned by the journey: it terminates TLS with
 * a journey CA and relays to that controller's published loopback port, so a worker or an agent can
 * be pinned to one controller while the public Caddy origin keeps round-robining. Every resource
 * carries the project name `tm-dist-<random>`; ports are allocated per run.
 */
const root = resolve(import.meta.dirname, "../..");
const composeDirectory = join(root, "deploy/compose");
const cli = join(root, "apps/cli/dist/main.js");
const composeFile = "compose.distributed.yaml";
const postgresImage =
  "postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24";
const REGION = "us-east-1";
const EVIDENCE_BUCKET = "tm-evidence";
const BACKUP_BUCKET = "tm-backups";
/** Controllers are live while their heartbeat is younger than this (ADR-035). */
const LIVE_MS = 30_000;

export type ControllerName = "server" | "server-2";
export const controllerNames: readonly ControllerName[] = ["server", "server-2"];

export interface Controller {
  readonly name: ControllerName;
  /** Published loopback port of the container. */
  readonly port: number;
  /** TLS front pinned to this controller (journey CA, `caPem` of the deployment). */
  readonly front: TlsProxy;
  readonly internalOrigin: string;
}

export interface LiveController {
  readonly id: string;
  readonly name: ControllerName;
  readonly internalOrigin: string;
  readonly heartbeatAt: string;
}

export interface S3Credential {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface DistributedDeployment {
  readonly directory: string;
  readonly project: string;
  /** The public origin of Caddy. */
  readonly baseUrl: string;
  /** Caddy's internal CA. */
  readonly caPem: string;
  /** CA of the journey's controller fronts. */
  readonly frontCaPem: string;
  readonly frontCaFile: string;
  readonly caFile: string;
  readonly hostConfigPath: string;
  readonly agentConfigPath: string;
  readonly workspaceId: string;
  readonly owner: { login: string; password: string; principalId: string };
  readonly controllers: readonly Controller[];
  readonly s3: {
    readonly endpoint: string;
    readonly evidenceBucket: string;
    readonly backupBucket: string;
    readonly evidence: S3Credential;
    readonly backup: S3Credential;
    readonly root: S3Credential;
  };
  readonly databaseUrl: string;
  /** Signed-in owner client through Caddy. */
  readonly client: HttpsClient;
  /** Signed-in owner client pinned to one controller (through its front). */
  clientVia(name: ControllerName): Promise<HttpsClient>;
  anonymous(): HttpsClient;
  signIn(): Promise<HttpsClient>;
  /** Bearer token for the owner, issued through `POST /v1/tokens`. */
  issueToken(scopes: ("R" | "W" | "X" | "A")[]): Promise<string>;
  /** `docker compose -f compose.distributed.yaml` against this deployment. */
  compose(...args: string[]): Promise<string>;
  /** Host-side CLI with the host configuration; resolves with the parsed `data` envelope. */
  cli(...args: string[]): Promise<unknown>;
  /** Long-running host process (`--json`); stopped with the deployment. */
  spawn(args: string[], env?: Readonly<Record<string, string>>): Spawned;
  /** Same as `spawn`, but `cwd` is the host working directory of the deployment's repository. */
  readonly cwd: string;
  /** Controller-scoped Application on the same database and bucket (host side). */
  scope(): Promise<Application>;
  /** The evidence bucket opened with the evidence credential. */
  evidenceStore(): S3ObjectStore;
  /** A bucket opened with any credential: `bucket` and `credential` default to the evidence ones. */
  s3Store(bucket: string, credential: S3Credential): S3ObjectStore;
  /** Live controllers by their registration, newest row per internal origin. */
  liveControllers(): Promise<LiveController[]>;
  /** Waits until both controllers are live and returns them. */
  bothLive(timeoutMs?: number): Promise<LiveController[]>;
  /** Container log of one service. */
  logs(service: string): Promise<string>;
  /** Replaces the PostgreSQL database with an empty one of the same name and owner. */
  recreateDatabase(): Promise<void>;
  teardown(): Promise<void>;
}

const sh = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  run(command, args, { cwd, env });

export async function startDistributedDeployment(): Promise<DistributedDeployment> {
  const directory = await mkdtemp(join(tmpdir(), "tm-dist-dep-"));
  const project = `tm-dist-${randomBytes(3).toString("hex")}`;
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
    sh("docker", ["compose", "-f", composeFile, ...args], composeDirectory, env);
  const hostCli = async (...args: string[]) => {
    const out = await sh(process.execPath, [cli, ...args, "--json"], paths.repo, env);
    return (JSON.parse(out) as { data?: unknown }).data;
  };

  const spawned: Spawned[] = [];
  const fronts: TlsProxy[] = [];
  let application: Application | undefined;
  let evidenceStore: S3ObjectStore | undefined;
  const stores: S3ObjectStore[] = [];
  const teardown = async () => {
    for (const child of spawned.splice(0)) {
      if (child.child.exitCode === null && child.child.signalCode === null) {
        child.child.kill("SIGTERM");
        const kill = setTimeout(() => child.child.kill("SIGKILL"), 20_000);
        await child.exited;
        clearTimeout(kill);
      }
    }
    application?.close();
    for (const store of stores) store.close();
    for (const front of fronts) await front.close().catch(() => undefined);
    await compose("down", "-v", "--remove-orphans").catch(() => undefined);
    // PostgreSQL's files belong to its own uid; hand them back before removing the directory.
    await sh(
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
        `${uid}:${gid}`,
        "/d",
      ],
      directory,
      env,
    ).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  };

  try {
    await sh("bash", [join(composeDirectory, "gen-tls.sh"), paths.tls], directory, env);
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
    const read = async (path: string) => (await readFile(path, "utf8")).trim();
    const caFile = join(paths.tls, "ca.crt");
    const caPem = await readFile(caFile, "utf8");
    const credentials = {
      root: {
        accessKeyId: await read(files.minioUser),
        secretAccessKey: await read(files.minioPassword),
      },
      evidence: {
        accessKeyId: await read(files.evidenceId),
        secretAccessKey: await read(files.evidenceSecret),
      },
      backup: {
        accessKeyId: await read(files.backupId),
        secretAccessKey: await read(files.backupSecret),
      },
    };

    // Each controller's own TLS front, started first: its origin is an allowed browser origin.
    const frontCa = await createTestCa(join(directory, "fronts-ca"));
    const frontCaFile = join(directory, "fronts-ca.pem");
    await writeFile(frontCaFile, frontCa.caPem, { mode: 0o600 });
    const ports: Record<ControllerName, number> = { server: port1, "server-2": port2 };
    const controllers: Controller[] = [];
    for (const name of controllerNames) {
      const front = await startTlsProxy({ ca: frontCa, upstreamPort: () => ports[name] });
      fronts.push(front);
      controllers.push({
        name,
        port: ports[name],
        front,
        internalOrigin: `http://${name}:7331`,
      });
    }

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
        bucket: EVIDENCE_BUCKET,
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
    const origins = [publicOrigin, ...controllers.map((controller) => controller.front.origin)];
    // A controller names the backup destination so it can request a backup, but the credential files
    // are on the backup agent's host only: the paths do not exist in a controller's container, and
    // `assertBackupSeparation` refuses to start a controller that can read them.
    const controllerBackup = {
      destination: {
        kind: "s3",
        endpoint: s3Endpoint.container,
        region: REGION,
        bucket: BACKUP_BUCKET,
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
        origins,
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
        origins,
      },
    };
    const pgTool = (tool: string) => [
      "docker",
      "run",
      "--rm",
      "-i",
      "--network",
      "host",
      "-v",
      `${caFile}:${caFile}:ro`,
      "-e",
      "PGPASSWORD",
      "-e",
      "PGSSLROOTCERT",
      "-e",
      "PGOPTIONS",
      "-e",
      "PGAPPNAME",
      postgresImage,
      tool,
    ];
    const agentConfig = {
      ...hostConfig,
      backup: {
        destination: {
          kind: "s3",
          endpoint: s3Endpoint.host,
          region: REGION,
          bucket: BACKUP_BUCKET,
          forcePathStyle: true,
          accessKeyIdFile: files.backupId,
          secretAccessKeyFile: files.backupSecret,
          caFile,
        },
        schedule: "disabled",
        retention: { daily: 7, weekly: 4, monthly: 3 },
        pgDump: pgTool("pg_dump"),
        pgRestore: pgTool("pg_restore"),
        // The agent runs as the operator on this host and holds the credential the controllers cannot read.
        allowSharedAccess: true,
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
    const agentConfigPath = await writeConfig("agent.json", agentConfig);
    await writeFile(
      join(directory, ".env"),
      Object.entries({
        TESTMASTER_COMPOSE_PROJECT: project,
        TESTMASTER_RUNTIME_DIR: root,
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
        TESTMASTER_S3_BUCKET: EVIDENCE_BUCKET,
        TESTMASTER_S3_BACKUP_BUCKET: BACKUP_BUCKET,
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
    await sh("bash", [join(composeDirectory, "provision-db.sh"), files.db], composeDirectory, {
      ...env,
      COMPOSE_FILE: composeFile,
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
      "Distributed Workspace",
      "--owner-login",
      ownerLogin,
    );
    const recoveryToken = findString(bootstrap, /^tm_rec_/u);
    const workspaceId = findString(bootstrap, /^ws_/u);
    await compose("up", "-d", "--build", "--wait", "server", "server-2", "caddy");

    const caddyRoot = join(directory, "caddy-root.crt");
    await compose("cp", "caddy:/data/caddy/pki/authorities/local/root.crt", caddyRoot);
    const caddyPem = await readFile(caddyRoot, "utf8");
    const anonymous = () => new HttpsClient(publicOrigin, caddyPem);
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
    const login = async (client: HttpsClient, origin: string) => {
      const response = await client.request("POST", "/v1/identity/login", {
        body: { principal: ownerLogin, password },
        headers: { origin, "idempotency-key": crypto.randomUUID() },
      });
      if (response.status !== 200)
        throw new Error(`login failed: ${response.status} ${response.text}`);
      const receipt = response.json<{ data: { principalId: string; csrfToken: string } }>().data;
      client.csrfToken = receipt.csrfToken;
      return { client, principalId: receipt.principalId };
    };
    const session = await login(anonymous(), publicOrigin);
    const s3Store = (bucket: string, credential: S3Credential) => {
      const store = new S3ObjectStore({
        endpoint: s3Endpoint.host,
        region: REGION,
        bucket,
        forcePathStyle: true,
        accessKeyId: credential.accessKeyId,
        secretAccessKey: credential.secretAccessKey,
        caPem,
      });
      stores.push(store);
      return store;
    };

    const stack: DistributedDeployment = {
      directory,
      project,
      baseUrl: publicOrigin,
      caPem: caddyPem,
      frontCaPem: frontCa.caPem,
      frontCaFile,
      caFile,
      hostConfigPath,
      agentConfigPath,
      workspaceId,
      owner: { login: ownerLogin, password, principalId: session.principalId },
      controllers,
      s3: {
        endpoint: s3Endpoint.host,
        evidenceBucket: EVIDENCE_BUCKET,
        backupBucket: BACKUP_BUCKET,
        ...credentials,
      },
      databaseUrl: databaseUrl(`127.0.0.1:${pgPort}`),
      client: session.client,
      async clientVia(name) {
        const front = controllers.find((controller) => controller.name === name)?.front;
        if (!front) throw new Error(`no controller ${name}`);
        return (await login(new HttpsClient(front.origin, frontCa.caPem), front.origin)).client;
      },
      anonymous,
      signIn: async () => (await login(anonymous(), publicOrigin)).client,
      async issueToken(scopes) {
        const issued = await session.client.mutate("POST", "/v1/tokens", {
          name: `dist-${randomBytes(3).toString("hex")}`,
          scopes,
          grants: [],
          principalId: session.principalId,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
        if (issued.status >= 300)
          throw new Error(`token issue failed: ${issued.status} ${issued.text}`);
        return findString(issued.json(), /^tm_(api|local|op|wrk)_/u);
      },
      compose,
      cli: hostCli,
      spawn(args, extra = {}) {
        const child = spawnCli(args, { ...env, ...extra }, paths.repo);
        spawned.push(child);
        return child;
      },
      cwd: paths.repo,
      async scope() {
        application ??= await Application.open({
          cwd: paths.repo,
          home: paths.home,
          env: {},
          server: await readServerConfig(hostConfigPath),
        });
        return application.controllerScope();
      },
      evidenceStore() {
        evidenceStore ??= s3Store(EVIDENCE_BUCKET, credentials.evidence);
        return evidenceStore;
      },
      s3Store,
      async liveControllers() {
        const database = (await stack.scope()).database;
        const rows = database.all<{
          id: string;
          internal_origin: string;
          heartbeat_at: string;
        }>(
          "SELECT id,internal_origin,heartbeat_at FROM controller_instances WHERE stopped_at IS NULL ORDER BY started_at",
        );
        const latest = new Map<string, LiveController>();
        for (const row of rows) {
          if (Date.now() - Date.parse(row.heartbeat_at) > LIVE_MS) continue;
          const name = controllers.find((c) => c.internalOrigin === row.internal_origin)?.name;
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
      async bothLive(timeoutMs = 90_000) {
        return eventually(
          () => stack.liveControllers(),
          (live) => live.length === controllerNames.length,
          timeoutMs,
        );
      },
      logs: (service) => compose("logs", "--no-color", "--no-log-prefix", service),
      async recreateDatabase() {
        const psql = (statement: string) =>
          compose(
            "exec",
            "-T",
            "postgres",
            "psql",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-c",
            statement,
          );
        application?.close();
        application = undefined;
        await psql("DROP DATABASE testmaster WITH (FORCE)");
        await psql(
          "CREATE DATABASE testmaster OWNER testmaster TEMPLATE template0 LOCALE 'C' ENCODING 'UTF8'",
        );
      },
      teardown,
    };
    return stack;
  } catch (error) {
    await teardown();
    throw error;
  }
}
