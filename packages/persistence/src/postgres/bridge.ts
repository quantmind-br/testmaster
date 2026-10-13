/**
 * Synchronous PostgreSQL bridge (ADR-015).
 *
 * One worker thread owns one `pg.Client`. The calling thread posts a request over a MessageChannel,
 * blocks with `Atomics.wait` on a shared flag, then reads the reply with `receiveMessageOnPort`.
 * Every public method is synchronous, so the persistence API keeps its SQLite shape.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { ContractError } from "@testmaster/contracts";

export interface PostgresConfig {
  /** `postgres://user@host:port/database?sslmode=verify-full`; never contains a password. */
  url: string;
  /** File (mode 0600, owned by the current user) holding the password; `PGPASSWORD` is the fallback. */
  passwordFile?: string;
  /** PEM bundle that signs the server certificate; required for `sslmode=verify-full`. */
  caFile?: string;
  applicationName?: string;
}

export interface BridgeStep {
  sql: string;
  params?: readonly unknown[];
  result?: boolean;
}
export interface BridgeRequest {
  steps: readonly BridgeStep[];
  recover?: readonly string[];
  scope?: string;
  /** The caller has an open transaction; the worker refuses to continue on a fresh connection. */
  transaction?: boolean;
  timeoutMs?: number;
}
export interface BridgeRows {
  rows: Record<string, unknown>[];
  rowCount: number;
}
export interface BridgeOutcome {
  results: BridgeRows[];
  reconnected: boolean;
}

interface WorkerFailure {
  message: string;
  code?: string;
  detail?: string;
  constraint?: string;
  table?: string;
  column?: string;
  errno?: string | number;
  syscall?: string;
}
type WorkerReply =
  | { ok: true; ready?: boolean; results?: BridgeRows[]; reconnected?: boolean }
  | { ok: false; error: WorkerFailure; connectionLost?: boolean; reconnected?: boolean };

const loopbackHosts = ["localhost", "127.0.0.1", "::1", "[::1]"];
export const statementTimeoutMs = 30_000;

interface ResolvedConnection {
  host: string;
  port: number | undefined;
  user: string;
  password: string | undefined;
  database: string;
  ssl: boolean;
  caFile: string | undefined;
}

/** Validates the configuration and resolves the password file; never logs the password. */
export function resolveConnection(
  config: PostgresConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConnection {
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new ContractError("INVALID_ARGUMENT", "Database url is not a valid postgres:// URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    throw new ContractError("INVALID_ARGUMENT", "Database url must use the postgres:// scheme");
  if (url.password)
    throw new ContractError("INVALID_ARGUMENT", "Database url must not contain a password", {
      nextActions: ["Use database.passwordFile or PGPASSWORD"],
    });
  const socketDirectory = url.searchParams.get("host");
  const host = socketDirectory ?? decodeURIComponent(url.hostname);
  const unixSocket = host.startsWith("/");
  const loopback = loopbackHosts.includes(host.toLowerCase()) || unixSocket;
  const sslmode = url.searchParams.get("sslmode") ?? (loopback ? "disable" : "");
  if (!loopback && sslmode !== "verify-full")
    throw new ContractError(
      "PRECONDITION_FAILED",
      "Database connections to non-loopback hosts require sslmode=verify-full",
      { reasonCode: "database_tls_required" },
    );
  if (sslmode !== "disable" && sslmode !== "verify-full")
    throw new ContractError("INVALID_ARGUMENT", `Unsupported sslmode ${sslmode}`);
  const ssl = sslmode === "verify-full" && !unixSocket;
  if (ssl && !config.caFile)
    throw new ContractError("PRECONDITION_FAILED", "sslmode=verify-full requires database.caFile");
  if (config.caFile && !existsSync(config.caFile))
    throw new ContractError("PRECONDITION_FAILED", "database.caFile does not exist");
  let password: string | undefined;
  if (config.passwordFile) {
    const info = statSync(config.passwordFile);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
      throw new ContractError(
        "PRECONDITION_FAILED",
        "database.passwordFile must be a regular file with mode 0600 owned by the current user",
      );
    password = readFileSync(config.passwordFile, "utf8").replace(/\r?\n$/u, "");
  } else password = env.PGPASSWORD;
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (!database) throw new ContractError("INVALID_ARGUMENT", "Database url must name a database");
  return {
    host,
    port: url.port ? Number(url.port) : undefined,
    user: decodeURIComponent(url.username) || env.PGUSER || "postgres",
    password,
    database,
    ssl,
    caFile: config.caFile,
  };
}

function workerEntry(): URL {
  // Source runs (vitest, tsx) load the TypeScript worker; compiled output loads the JavaScript one.
  const compiled = new URL("./worker.js", import.meta.url);
  return existsSync(fileURLToPath(compiled)) ? compiled : new URL("./worker.ts", import.meta.url);
}

export class PostgresBridge {
  private worker: Worker | null;
  private port: MessageChannel["port1"] | null;
  private broken: ContractError | null = null;
  private closed = false;
  private constructor(
    private readonly flag: Int32Array,
    worker: Worker,
    port: MessageChannel["port1"],
  ) {
    this.worker = worker;
    this.port = port;
  }

  static open(config: PostgresConfig, options: { lockTimeoutMs?: number } = {}): PostgresBridge {
    const connection = resolveConnection(config);
    const channel = new MessageChannel();
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(workerEntry(), {
      // The worker must not inherit the parent's `-e`/`--import` flags: `node -e` would run the eval script again.
      execArgv: [],
      workerData: {
        port: channel.port2,
        flag,
        client: {
          host: connection.host,
          port: connection.port,
          user: connection.user,
          password: connection.password,
          database: connection.database,
          applicationName: config.applicationName ?? "testmaster",
          caFile: connection.caFile,
          servername: connection.host,
          ssl: connection.ssl,
          lockTimeoutMs: options.lockTimeoutMs ?? 5000,
          connectionTimeoutMs: 10_000,
        },
      },
      transferList: [channel.port2],
      stdout: false,
      stderr: false,
    });
    worker.unref();
    channel.port1.unref();
    const bridge = new PostgresBridge(flag, worker, channel.port1);
    worker.on("error", () => {});
    const reply = bridge.await(15_000 + 10_000);
    if (!reply.ok) throw bridge.failure(reply, "PostgreSQL connection failed");
    return bridge;
  }

  private await(timeoutMs: number): WorkerReply {
    const port = this.port as MessageChannel["port1"];
    const outcome = Atomics.wait(this.flag, 0, 0, timeoutMs);
    if (outcome === "timed-out") {
      this.breakBridge(
        new ContractError(
          "UNAVAILABLE",
          "PostgreSQL statement timed out; the connection was dropped",
          {
            reasonCode: "database_timeout",
            retryable: true,
          },
        ),
      );
      throw this.broken;
    }
    const received = receiveMessageOnPort(port);
    if (!received) throw new ContractError("INTERNAL", "PostgreSQL bridge lost a reply");
    return received.message as WorkerReply;
  }

  private breakBridge(error: ContractError): void {
    this.broken = error;
    const worker = this.worker;
    this.worker = null;
    void worker?.terminate();
    this.port?.close();
    this.port = null;
  }

  get isBroken(): boolean {
    return this.broken !== null;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Runs one batch of statements on the single connection and returns the result-bearing steps. */
  execute(request: BridgeRequest): BridgeOutcome {
    if (this.broken) throw this.broken;
    if (this.closed || !this.port)
      throw new ContractError("INTERNAL", "PostgreSQL database is closed");
    Atomics.store(this.flag, 0, 0);
    this.port.postMessage({
      steps: request.steps.map((step) => ({
        sql: step.sql,
        params: step.params ? this.checkParams(step.params) : undefined,
        result: step.result,
      })),
      recover: request.recover,
      scope: request.scope,
      transaction: request.transaction,
    });
    const reply = this.await(request.timeoutMs ?? statementTimeoutMs);
    if (!reply.ok) throw this.failure(reply, "PostgreSQL statement failed");
    return { results: reply.results ?? [], reconnected: reply.reconnected ?? false };
  }

  /** Error that keeps the PostgreSQL SQLSTATE in `code`, like the driver error it wraps. */
  failure(reply: Extract<WorkerReply, { ok: false }>, fallback: string): Error {
    const { error } = reply;
    const code = error.code;
    if (code === "55P03" || code === "40P01" || code === "40001")
      return new ContractError("UNAVAILABLE", "Database writer is busy; retry the operation", {
        reasonCode: "writer_contention",
        retryable: true,
      });
    const unavailable =
      reply.connectionLost ||
      (code !== undefined && (code.startsWith("08") || code.startsWith("57P"))) ||
      ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE"].includes(
        String(error.code),
      );
    if (unavailable)
      return new ContractError("UNAVAILABLE", `PostgreSQL is unavailable: ${error.message}`, {
        reasonCode: "database_unavailable",
        retryable: true,
        connectionLost: true,
      });
    const failure = new Error(error.message || fallback) as Error & Record<string, unknown>;
    if (error.code) failure.code = error.code;
    for (const key of ["detail", "constraint", "table", "column"] as const)
      if (error[key]) failure[key] = error[key];
    return failure;
  }

  private checkParams(params: readonly unknown[]): unknown[] {
    return params.map((value, index) => {
      if (value === null) return null;
      switch (typeof value) {
        case "string":
        case "number":
          return value;
        case "bigint":
          return value.toString();
        case "object":
          if (value instanceof Uint8Array) return value;
          break;
      }
      throw new TypeError(`Unsupported SQL parameter type at position ${index + 1}`);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const port = this.port;
    if (port && !this.broken) {
      try {
        Atomics.store(this.flag, 0, 0);
        port.postMessage({ close: true });
        Atomics.wait(this.flag, 0, 0, 5000);
      } catch {
        // Closing is best effort: the worker is terminated below either way.
      }
    }
    const worker = this.worker;
    this.worker = null;
    this.port = null;
    port?.close();
    void worker?.terminate();
  }
}
