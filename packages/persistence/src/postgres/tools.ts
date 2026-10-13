/**
 * `pg_dump` / `pg_restore` process helpers for server-profile backups (ADR-019).
 *
 * The tools are run as child processes that stream the dump through stdout/stdin, so a backup is
 * encrypted before it touches the disk. The executable is an argv prefix (`["pg_dump"]` by
 * default); an operator without the PostgreSQL client installed can supply a wrapper such as
 * `["docker","run","--rm","-i","--network","host","-e","PGPASSWORD","-e","PGOPTIONS","postgres:17-alpine","pg_dump"]`.
 *
 * Constraints measured against PostgreSQL 17:
 * - `--serializable-deferrable` cannot be combined with `--snapshot`, so the dump takes its own
 *   snapshot and callers never share one with a second exporter.
 * - Row-level security applies to the dump (`--enable-row-security`); the controller scope
 *   `testmaster.workspace=*` is set through `PGOPTIONS` so every tenant's rows are included.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { ContractError } from "@testmaster/contracts";
import { type PostgresConfig, resolveConnection } from "./bridge.js";

export interface PgTools {
  /** Argv prefix that starts `pg_dump`. */
  pgDump: readonly string[];
  /** Argv prefix that starts `pg_restore`. */
  pgRestore: readonly string[];
}
export const defaultPgTools: PgTools = { pgDump: ["pg_dump"], pgRestore: ["pg_restore"] };

/** A running client tool; `done` rejects when it exits non-zero or cannot start. */
export interface PgProcess {
  readonly stdout: Readable;
  readonly stdin: Writable;
  readonly done: Promise<void>;
  kill(): void;
}

const passthrough = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "DOCKER_HOST", "XDG_RUNTIME_DIR"];
const maxStderr = 8192;

/** The environment a client tool needs; carries the password only through `PGPASSWORD`. */
export function pgToolEnvironment(
  config: PostgresConfig,
  base: NodeJS.ProcessEnv = process.env,
): { url: string; env: NodeJS.ProcessEnv } {
  const connection = resolveConnection(config, base);
  const env: NodeJS.ProcessEnv = {};
  for (const name of passthrough) if (base[name] !== undefined) env[name] = base[name];
  if (connection.password !== undefined) env.PGPASSWORD = connection.password;
  if (connection.ssl) {
    env.PGSSLMODE = "verify-full";
    if (connection.caFile) env.PGSSLROOTCERT = connection.caFile;
  }
  env.PGOPTIONS = "-c testmaster.workspace=*";
  env.PGAPPNAME = config.applicationName ?? "testmaster-backup";
  return { url: config.url, env };
}

function start(
  tool: string,
  prefix: readonly string[],
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  secret: string | undefined,
): PgProcess {
  const [command, ...leading] = prefix;
  if (!command) throw new ContractError("INVALID_ARGUMENT", `No command configured for ${tool}`);
  const child: ChildProcess = spawn(command, [...leading, ...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < maxStderr) stderr += chunk.toString("utf8");
  });
  const done = new Promise<void>((resolveDone, reject) => {
    child.on("error", (error) =>
      reject(
        new ContractError("UNAVAILABLE", `${tool} could not start: ${error.message}`, {
          tool,
          reasonCode: "pg_tool_unavailable",
        }),
      ),
    );
    child.on("close", (code, signal) => {
      if (code === 0) resolveDone();
      else {
        const text = secret ? stderr.split(secret).join("***") : stderr;
        reject(
          new ContractError("INTERNAL", `${tool} failed (${code ?? signal})`, {
            tool,
            exitCode: code,
            stderr: text.slice(0, maxStderr),
          }),
        );
      }
    });
  });
  // The caller always awaits `done`; this keeps an early failure from surfacing as unhandled.
  done.catch(() => undefined);
  const { stdout, stdin } = child;
  if (!stdout || !stdin) throw new ContractError("INTERNAL", `${tool} has no standard streams`);
  stdin.on("error", () => undefined);
  return { stdout, stdin, done, kill: () => void child.kill("SIGKILL") };
}

/** Starts a consistent, serializable-deferrable custom-format dump that streams to stdout. */
export function startPgDump(config: PostgresConfig, tools: PgTools = defaultPgTools): PgProcess {
  const { url, env } = pgToolEnvironment(config);
  return start(
    "pg_dump",
    tools.pgDump,
    [
      "--format=custom",
      "--serializable-deferrable",
      "--enable-row-security",
      "--no-owner",
      "--no-privileges",
      "--dbname",
      url,
    ],
    env,
    env.PGPASSWORD,
  );
}

/** Starts `pg_restore` reading a custom-format archive from stdin into the configured database. */
export function startPgRestore(config: PostgresConfig, tools: PgTools = defaultPgTools): PgProcess {
  const { url, env } = pgToolEnvironment(config);
  return start(
    "pg_restore",
    tools.pgRestore,
    ["--no-owner", "--no-privileges", "--exit-on-error", "--dbname", url],
    env,
    env.PGPASSWORD,
  );
}

/**
 * Starts `pg_restore` that renders selected tables' data as plain SQL on stdout without touching a
 * database; used to read artifact references out of an archive.
 */
export function startPgRestoreDataExport(
  tables: readonly string[],
  tools: PgTools = defaultPgTools,
): PgProcess {
  const env: NodeJS.ProcessEnv = {};
  for (const name of passthrough)
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return start(
    "pg_restore",
    tools.pgRestore,
    ["--data-only", "-n", "public", ...tables.flatMap((table) => ["-t", table]), "-f", "-"],
    env,
    undefined,
  );
}

/** Starts `pg_restore --list` over an archive on stdin (verification without a database). */
export function startPgRestoreList(tools: PgTools = defaultPgTools): PgProcess {
  const env: NodeJS.ProcessEnv = {};
  for (const name of passthrough)
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return start("pg_restore", tools.pgRestore, ["--list"], env, undefined);
}

/** Row of a `COPY … FROM stdin` block: column name to decoded text, `null` for `\N`. */
export interface CopyRow {
  table: string;
  values: Record<string, string | null>;
}

const copyEscapes: Record<string, string> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

/** Decodes one COPY text-format field (backslash escapes). */
export function decodeCopyField(field: string): string | null {
  if (field === "\\N") return null;
  if (!field.includes("\\")) return field;
  let out = "";
  for (let index = 0; index < field.length; index += 1) {
    const char = field[index] as string;
    if (char !== "\\") {
      out += char;
      continue;
    }
    index += 1;
    const next = field[index] as string;
    if (next in copyEscapes) out += copyEscapes[next];
    else if (next === "x" && /^[0-9a-fA-F]{1,2}/u.test(field.slice(index + 1, index + 3))) {
      const hex = /^[0-9a-fA-F]{1,2}/u.exec(field.slice(index + 1, index + 3)) as RegExpExecArray;
      out += String.fromCharCode(Number.parseInt(hex[0], 16));
      index += hex[0].length;
    } else if (/[0-7]/u.test(next)) {
      const octal = /^[0-7]{1,3}/u.exec(field.slice(index, index + 3)) as RegExpExecArray;
      out += String.fromCharCode(Number.parseInt(octal[0], 8));
      index += octal[0].length - 1;
    } else out += next;
  }
  return out;
}

/** Parses the plain-SQL data output of `pg_restore --data-only` into table rows. */
export async function* parseCopyRows(lines: AsyncIterable<string>): AsyncGenerator<CopyRow> {
  let table: string | null = null;
  let columns: string[] = [];
  for await (const line of lines) {
    if (table === null) {
      const header = /^COPY (\S+) \((.*)\) FROM stdin;$/u.exec(line);
      if (header) {
        table = (header[1] as string).replace(/^public\./u, "").replaceAll('"', "");
        columns = (header[2] as string).split(", ").map((column) => column.replaceAll('"', ""));
      }
      continue;
    }
    if (line === "\\.") {
      table = null;
      continue;
    }
    const fields = line.split("\t");
    if (fields.length !== columns.length)
      throw new ContractError("INTERNAL", "Unexpected COPY row shape in backup archive");
    const values: Record<string, string | null> = {};
    for (const [index, column] of columns.entries())
      values[column] = decodeCopyField(fields[index] as string);
    yield { table, values };
  }
}
