/**
 * Worker-thread side of the synchronous PostgreSQL bridge (ADR-015).
 *
 * The worker owns exactly one `pg.Client`. The main thread posts one request at a time over a
 * dedicated MessageChannel and blocks on a shared flag; this thread posts the reply, then stores
 * the flag and notifies. The file is run directly by Node (type stripping when loaded from source,
 * plain JavaScript from `dist`), so it must stay self-contained and use erasable syntax only.
 */
import { readFileSync } from "node:fs";
import { type MessagePort, workerData } from "node:worker_threads";
import pg from "pg";

interface Step {
  sql: string;
  params?: unknown[];
  result?: boolean;
}
interface Request {
  steps: Step[];
  recover?: string[];
  /** Workspace scope the session must hold before the first step runs. */
  scope?: string;
  /** The caller has an open transaction, which a reconnect would silently lose. */
  transaction?: boolean;
}
interface WorkerData {
  port: MessagePort;
  flag: Int32Array;
  client: {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    applicationName?: string;
    caFile?: string;
    servername?: string;
    ssl: boolean;
    lockTimeoutMs: number;
    connectionTimeoutMs: number;
  };
}

const data = workerData as WorkerData;
const { port, flag } = data;

function wide(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)))
    throw new RangeError(`Numeric value ${value} exceeds the safe integer range`);
  return parsed;
}
pg.types.setTypeParser(20, wide);
pg.types.setTypeParser(1700, wide);

let client: pg.Client | null = null;
let appliedScope: string | null = null;

async function connect(): Promise<void> {
  const settings = data.client;
  const next = new pg.Client({
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: settings.password,
    database: settings.database,
    application_name: settings.applicationName,
    connectionTimeoutMillis: settings.connectionTimeoutMs,
    options: `-c lock_timeout=${settings.lockTimeoutMs} -c client_min_messages=warning`,
    ssl: settings.ssl
      ? {
          ca: settings.caFile ? readFileSync(settings.caFile, "utf8") : undefined,
          rejectUnauthorized: true,
          servername: settings.servername,
        }
      : undefined,
  });
  next.on("error", () => {
    if (client === next) client = null;
  });
  next.on("end", () => {
    if (client === next) client = null;
  });
  await next.connect();
  client = next;
  appliedScope = null;
}

function serializeError(error: unknown): Record<string, unknown> {
  const source = (error ?? {}) as Record<string, unknown>;
  return {
    message: error instanceof Error ? error.message : String(error),
    code: typeof source.code === "string" ? source.code : undefined,
    detail: source.detail,
    constraint: source.constraint,
    table: source.table,
    column: source.column,
    severity: source.severity,
    errno: source.errno,
    syscall: source.syscall,
  };
}

function bind(values: readonly unknown[] | undefined): unknown[] | undefined {
  return values?.map((value) =>
    value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value) : value,
  );
}

function reply(message: unknown): void {
  port.postMessage(message);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
}

async function handle(request: Request): Promise<void> {
  let reconnected = false;
  try {
    if (!client) {
      await connect();
      reconnected = true;
      if (request.transaction)
        throw Object.assign(new Error("PostgreSQL connection was lost inside a transaction"), {
          code: "08006",
        });
    }
    const active = client as pg.Client;
    if (request.scope !== undefined && request.scope !== appliedScope) {
      await active.query("SELECT set_config('testmaster.workspace', $1, false)", [request.scope]);
      appliedScope = request.scope;
    }
    const results: Array<{ rows: Record<string, unknown>[]; rowCount: number }> = [];
    for (const step of request.steps) {
      const query: pg.QueryConfig | string = step.params
        ? { text: step.sql, values: bind(step.params) as unknown[] }
        : step.sql;
      const outcome = await active.query(query);
      if (step.result)
        results.push({
          rows: outcome.rows as Record<string, unknown>[],
          rowCount: outcome.rowCount ?? 0,
        });
    }
    reply({ ok: true, results, reconnected });
  } catch (error) {
    const lost = client === null;
    if (client) {
      for (const statement of request.recover ?? []) {
        try {
          await client.query(statement);
        } catch {
          // Recovery is best effort; a failure here leaves the original error as the cause.
        }
      }
    }
    reply({ ok: false, error: serializeError(error), connectionLost: lost, reconnected });
  }
}

port.on("message", (message: Request | { close: true }) => {
  if ("close" in message) {
    const active = client;
    client = null;
    void (active ? active.end() : Promise.resolve()).finally(() => {
      port.close();
      reply({ ok: true, results: [], reconnected: false });
    });
    return;
  }
  void handle(message);
});

// Handshake: connect eagerly so configuration errors surface when the database is opened.
connect().then(
  () => reply({ ok: true, ready: true }),
  (error: unknown) => reply({ ok: false, error: serializeError(error), connectionLost: true }),
);
