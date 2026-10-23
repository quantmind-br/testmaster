import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, readFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  statfs,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ContractError, validate } from "@testmaster/contracts";
import { ensureControlPlaneReserve, releaseControlPlaneReserve } from "./disk-reserve.js";
import {
  type BridgeRequest,
  type BridgeRows,
  type BridgeStep,
  PostgresBridge,
  type PostgresConfig,
} from "./postgres/bridge.js";
import { isReadStatement, splitStatements, translateSql } from "./postgres/dialect.js";
import { restorePendingMessage, restorePendingTable } from "./postgres/restore.js";
import { applyRestoreTightening } from "./restore-tightening.js";

export type SqlRow = Record<string, unknown>;
/**
 * How long one statement of a synchronous caller (a CLI command, an HTTP or MCP request) waits
 * inside SQLite for another connection's writer lock before the typed `writer_contention` refusal.
 * The wait blocks the whole process (node:sqlite is synchronous), and runs executing in the same
 * process renew their attempt lease every 10 s on that event loop: the bound keeps one blocked
 * statement from starving those renewals, while still absorbing ordinary overlap with another
 * process's short transactions.
 */
export const sqliteBusyTimeoutMs = 5000;
/**
 * The writer-lock wait of a transaction started inside {@link withYieldingWriterWait}: a loop that
 * can await (`retryWriterContention`) gives the event loop back between short attempts instead of
 * blocking it, and has no total deadline.
 */
export const sqliteYieldingBusyTimeoutMs = 50;
const yieldingWriterWait = new AsyncLocalStorage<true>();
/**
 * Runs `operation` so that every `withTx` it starts, across its awaits, waits for the writer lock
 * only {@link sqliteYieldingBusyTimeoutMs} before refusing with `writer_contention`. Used by the
 * asynchronous retry loop, which then sleeps without blocking timers, heartbeats or cancellation.
 */
export function withYieldingWriterWait<T>(operation: () => T): T {
  return yieldingWriterWait.run(true, operation);
}

/** True for SQLite BUSY or LOCKED (primary result codes 5 and 6, extended codes included). */
function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ("errcode" in error && typeof error.errcode === "number") {
    const primary = error.errcode & 0xff;
    return primary === 5 || primary === 6;
  }
  return /database is locked|SQLITE_BUSY/.test(error.message);
}
export interface MigrationStatus {
  version: number;
  name: string;
  appliedAt: string;
  checksum: string;
}
export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}
export interface DatabaseStatus {
  currentVersion: number;
  migrations: MigrationStatus[];
  pending: number[];
}
export class MigrationChecksumError extends Error {
  constructor(
    public readonly version: number,
    expected: string,
    actual: string,
  ) {
    super(`Migration ${version} checksum mismatch (expected ${expected}, found ${actual})`);
  }
}
export function loadMigrationsSync(
  engine: DatabaseEngine = "sqlite",
  directory = fileURLToPath(new URL(`../migrations/${engine}/`, import.meta.url)),
): Migration[] {
  const names = readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  const result: Migration[] = [];
  for (const name of names) {
    const match = /^(\d{4})_(.+)\.sql$/u.exec(name);
    if (!match?.[1] || !match[2]) continue;
    const sql = readFileSync(join(directory, name), "utf8");
    const version = Number(match[1]);
    if (version !== result.length + 1)
      throw new Error("Migration versions must be contiguous and unique");
    result.push({
      version,
      name: match[2],
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }
  if (!result.length) throw new Error("No database migrations available");
  return result;
}
export async function loadMigrations(
  engine: DatabaseEngine = "sqlite",
  directory?: string,
): Promise<Migration[]> {
  return loadMigrationsSync(engine, directory);
}
export type DatabaseEngine = "sqlite" | "postgres";
export type TxDatabase = PersistenceDatabase;

/** Advisory lock that serializes every PostgreSQL write transaction (ADR-015). */
const writerLockKey = 7_340_041;
/** Advisory lock that serializes PostgreSQL schema migrations (ADR-015). */
const migrationLockKey = 7_340_042;
/**
 * SQLite migrations that rebuild a table other tables reference (create new, copy, drop, rename).
 * They run with foreign keys off, as SQLite requires for that recipe, and the migration is rolled
 * back if the copy leaves a dangling reference.
 */
const tableRebuildMigrations = [
  "authored_code_artifacts",
  "terminal_runner",
  "probe_runner",
  "trackers",
];
const migrationTimeoutMs = 600_000;
const bypassRefusal = "Database role bypasses row-level security";

interface SqliteCore {
  engine: "sqlite";
  db: DatabaseSync;
  path: string;
  migrations: Migration[];
}
interface PostgresCore {
  engine: "postgres";
  bridge: PostgresBridge;
  path: string;
  migrations: Migration[];
  inTransaction: boolean;
  /** Scope the open transaction was started with. */
  transactionScope: string | null;
}
type Core = SqliteCore | PostgresCore;

function unavailable(capability: string): ContractError {
  return new ContractError(
    "CAPABILITY_UNAVAILABLE",
    `${capability} is not available on the PostgreSQL engine`,
    { capability },
  );
}

/** A backup that no longer matches what was written; restoring it is refused, never repaired. */
function backupIntegrity(message: string, relativePath?: string): ContractError {
  return new ContractError(
    "PRECONDITION_FAILED",
    relativePath === undefined ? message : `${message}: ${relativePath}`,
    {
      reasonCode: "backup_integrity",
      ...(relativePath === undefined ? {} : { relativePath }),
      nextActions: ["verify_backup_source", "use_another_backup"],
    },
  );
}

async function readBackupJson(directory: string, name: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(directory, name), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw backupIntegrity("Backup file is missing", name);
    if (error instanceof SyntaxError) throw backupIntegrity("Backup file is not valid JSON", name);
    throw error;
  }
}

export class PersistenceDatabase {
  private constructor(
    private readonly core: Core,
    /** Workspace scope applied to PostgreSQL statements; `"*"` is the controller scope. */
    private readonly scope: string,
    private readonly owner: boolean,
  ) {}
  get engine(): DatabaseEngine {
    return this.core.engine;
  }
  get path(): string {
    return this.core.path;
  }
  get inTransaction(): boolean {
    return this.core.engine === "sqlite" ? this.core.db.isTransaction : this.core.inTransaction;
  }
  get isOpen(): boolean {
    return this.core.engine === "sqlite"
      ? this.core.db.isOpen
      : !this.core.bridge.isBroken && !this.core.bridge.isClosed;
  }
  static async open(
    path: string,
    options: { migrate?: boolean; migrationsDir?: string } = {},
  ): Promise<PersistenceDatabase> {
    const actual = resolve(path);
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 });
    const filesystem = await statfs(dirname(actual));
    if ([0x6969, 0xff534d42, 0xfe534d42, 0x65735546].includes(Number(filesystem.type) >>> 0))
      throw new ContractError("PRECONDITION_FAILED", "SQLite requires compatible local storage");
    try {
      const info = await lstat(actual);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new Error("Database must be a regular private file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Number(filesystem.bavail) * Number(filesystem.bsize) > 8 * 1024 * 1024)
      ensureControlPlaneReserve(actual);
    const db = new DatabaseSync(actual);
    try {
      await chmod(actual, 0o600);
      db.exec(
        `PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${sqliteBusyTimeoutMs}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`,
      );
      const journal = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
      const locking = db.prepare("PRAGMA locking_mode").get()?.locking_mode;
      if (journal !== "wal" || locking !== "normal")
        throw new ContractError(
          "PRECONDITION_FAILED",
          "SQLite storage must support WAL with normal locking",
        );
      const instance = new PersistenceDatabase(
        { engine: "sqlite", db, path: actual, migrations: [] },
        "*",
        true,
      );
      if (options.migrate !== false) await instance.migrate(options.migrationsDir);
      else instance.verifyCompatibility(await loadMigrations("sqlite", options.migrationsDir));
      return instance;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  static memory(): PersistenceDatabase {
    const db = new DatabaseSync(":memory:");
    db.exec(
      `PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${sqliteBusyTimeoutMs}; PRAGMA synchronous=FULL;`,
    );
    return new PersistenceDatabase(
      { engine: "sqlite", db, path: ":memory:", migrations: [] },
      "*",
      true,
    );
  }
  /**
   * Opens a PostgreSQL database through the synchronous bridge (ADR-015). The returned instance has
   * the controller scope (`"*"`); request handlers narrow it with `forWorkspace`. Opening verifies
   * the connecting role cannot bypass row-level security, the byte-order collation and the
   * compatibility of the applied schema, but never migrates: run `testmaster db migrate`. A database
   * with an unfinished restore refuses to open unless `restore` is set (only the restore tool does).
   */
  static openPostgres(
    config: PostgresConfig,
    options: { migrationsDir?: string; restore?: boolean } = {},
  ): PersistenceDatabase {
    const bridge = PostgresBridge.open(config);
    const core: PostgresCore = {
      engine: "postgres",
      bridge,
      path: "postgres",
      migrations: [],
      inTransaction: false,
      transactionScope: null,
    };
    const instance = new PersistenceDatabase(core, "*", true);
    try {
      const role = instance.get<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      );
      if (!role || role.rolsuper || role.rolbypassrls)
        throw new ContractError("PRECONDITION_FAILED", bypassRefusal, {
          reasonCode: "database_role_bypasses_rls",
        });
      const collation = String(
        instance.get("SELECT datcollate FROM pg_database WHERE datname=current_database()")
          ?.datcollate,
      );
      if (!["C", "POSIX", "C.UTF-8", "C.utf8"].includes(collation))
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Database collation must be a byte-order collation (C) so ordering matches SQLite",
          { reasonCode: "database_collation", collation },
        );
      if (!options.restore && instance.tableExists(restorePendingTable))
        throw new ContractError("PRECONDITION_FAILED", restorePendingMessage, {
          reasonCode: "restore_incomplete",
        });
      instance.verifyCompatibility(loadMigrationsSync("postgres", options.migrationsDir));
      return instance;
    } catch (error) {
      bridge.close();
      throw error;
    }
  }
  /**
   * A view over the same connection restricted to one workspace (`"*"` for controller loops).
   * On PostgreSQL the scope is applied lazily through `set_config` and enforced by row-level
   * security; on SQLite the view has no extra effect.
   */
  forWorkspace(workspaceId: string): PersistenceDatabase {
    if (!workspaceId) throw new ContractError("INTERNAL", "Workspace scope must not be empty");
    return new PersistenceDatabase(this.core, workspaceId, false);
  }
  close(): void {
    if (!this.owner) return;
    if (this.core.engine === "sqlite") this.core.db.close();
    else this.core.bridge.close();
  }
  private sqlite(capability: string): DatabaseSync {
    if (this.core.engine !== "sqlite") throw unavailable(capability);
    return this.core.db;
  }
  private postgres(): PostgresCore {
    const core = this.core;
    if (core.engine !== "postgres")
      throw new ContractError("INTERNAL", "Not a PostgreSQL database");
    return core;
  }
  /** Runs one batch on the PostgreSQL connection, tracking connection loss inside a transaction. */
  private bridge(core: PostgresCore, request: BridgeRequest): BridgeRows[] {
    try {
      return core.bridge.execute({ ...request, scope: this.scope, transaction: core.inTransaction })
        .results;
    } catch (error) {
      if (error instanceof ContractError && error.details.connectionLost)
        core.inTransaction = false;
      throw error;
    }
  }
  private pgQuery(sql: string, params: readonly unknown[]): BridgeRows {
    const core = this.postgres();
    const translated = translateSql(sql);
    if (translated.parameters !== params.length)
      throw new ContractError(
        "INTERNAL",
        `SQL expects ${translated.parameters} parameters but received ${params.length}`,
      );
    const statement: BridgeStep = { sql: translated.sql, params, result: true };
    const read = isReadStatement(translated.sql);
    let request: BridgeRequest;
    if (core.inTransaction) {
      if (core.transactionScope !== this.scope)
        throw new ContractError("INTERNAL", "Workspace scope switch inside a transaction");
      // SQLite aborts only the failing statement; a savepoint gives PostgreSQL the same behaviour.
      request = read
        ? { steps: [statement] }
        : {
            steps: [
              { sql: "SAVEPOINT tm_statement" },
              statement,
              { sql: "RELEASE SAVEPOINT tm_statement" },
            ],
            recover: ["ROLLBACK TO SAVEPOINT tm_statement", "RELEASE SAVEPOINT tm_statement"],
          };
    } else if (read) request = { steps: [statement] };
    else
      request = {
        steps: [
          { sql: "BEGIN" },
          { sql: `SELECT pg_advisory_xact_lock(${writerLockKey})` },
          statement,
          { sql: "COMMIT" },
        ],
        recover: ["ROLLBACK"],
      };
    const [result] = this.bridge(core, request);
    return result as BridgeRows;
  }
  private begin(): void {
    const core = this.postgres();
    if (core.inTransaction) throw new Error("cannot start a transaction within a transaction");
    this.bridge(core, {
      steps: [{ sql: "BEGIN" }, { sql: `SELECT pg_advisory_xact_lock(${writerLockKey})` }],
      recover: ["ROLLBACK"],
    });
    core.inTransaction = true;
    core.transactionScope = this.scope;
  }
  private finish(sql: "COMMIT" | "ROLLBACK"): void {
    const core = this.postgres();
    if (!core.inTransaction) return;
    try {
      this.bridge(core, { steps: [{ sql }], recover: ["ROLLBACK"] });
    } finally {
      core.inTransaction = false;
      core.transactionScope = null;
    }
  }
  withTx<T>(fn: (db: PersistenceDatabase) => T): T {
    if (this.core.engine === "postgres") {
      this.begin();
      try {
        const value = fn(this);
        if (value instanceof Promise) throw new Error("withTx callback must be synchronous");
        this.finish("COMMIT");
        return value;
      } catch (error) {
        this.finish("ROLLBACK");
        throw error;
      }
    }
    const { db } = this.core;
    // Inside withYieldingWriterWait the BEGIN waits only briefly; the connection's own wait (the
    // default, or an operator's override) is restored afterwards.
    const restoreBusyMs =
      yieldingWriterWait.getStore() === true
        ? Number((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout)
        : undefined;
    try {
      if (restoreBusyMs !== undefined)
        db.exec(`PRAGMA busy_timeout=${sqliteYieldingBusyTimeoutMs}`);
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      // BEGIN IMMEDIATE is the only statement that waits for the writer lock, so a busy error
      // here means the transaction never started and the caller can retry safely.
      if (isSqliteBusy(error))
        throw new ContractError("UNAVAILABLE", "Local writer is busy; retry the operation", {
          reasonCode: "writer_contention",
          retryable: true,
        });
      throw error;
    } finally {
      if (restoreBusyMs !== undefined) db.exec(`PRAGMA busy_timeout=${restoreBusyMs}`);
    }
    try {
      const value = fn(this);
      if (value instanceof Promise) throw new Error("withTx callback must be synchronous");
      db.exec("COMMIT");
      return value;
    } catch (error) {
      if (error instanceof Error && /database or disk is full|SQLITE_FULL/.test(error.message))
        releaseControlPlaneReserve(this.core.path);
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
  get<T = SqlRow>(sql: string, ...params: unknown[]): T | undefined {
    if (this.core.engine === "postgres") return this.pgQuery(sql, params).rows[0] as T | undefined;
    return this.core.db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined;
  }
  all<T = SqlRow>(sql: string, ...params: unknown[]): T[] {
    if (this.core.engine === "postgres") return this.pgQuery(sql, params).rows as T[];
    return this.core.db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
  }
  run(sql: string, ...params: unknown[]): { changes: number } {
    if (this.core.engine === "postgres") return { changes: this.pgQuery(sql, params).rowCount };
    const outcome = this.core.db.prepare(sql).run(...(params as SQLInputValue[]));
    return { changes: Number(outcome.changes) };
  }
  /** Runs a script of statements without parameters, e.g. DDL and transaction control in tests. */
  exec(script: string): void {
    if (this.core.engine === "sqlite") {
      this.core.db.exec(script);
      return;
    }
    for (const statement of splitStatements(script)) {
      if (/^(begin|start\s+transaction)\b/iu.test(statement)) this.begin();
      else if (/^(commit|end)\b/iu.test(statement)) this.finish("COMMIT");
      else if (/^rollback\s*$/iu.test(statement)) this.finish("ROLLBACK");
      else this.pgQuery(statement, []);
    }
  }
  tableExists(name: string): boolean {
    return Boolean(
      this.core.engine === "sqlite"
        ? this.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name)
        : this.get(
            "SELECT 1 AS present FROM pg_tables WHERE schemaname=current_schema() AND tablename=?",
            name,
          ),
    );
  }
  private verifyCompatibility(available: Migration[]): void {
    const applied = this.tableExists("schema_migrations")
      ? this.all<{ version: number; name: string; checksum: string }>(
          "SELECT version,name,checksum FROM schema_migrations ORDER BY version",
        )
      : [];
    for (const [index, row] of applied.entries()) {
      const migration = available[row.version - 1];
      if (!migration || row.version !== index + 1)
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Controller is incompatible with database schema",
          {
            reasonCode: "schema_ahead",
            databaseVersion: row.version,
            supportedVersion: available.length,
          },
        );
      if (migration.name !== row.name || migration.checksum !== row.checksum)
        throw new MigrationChecksumError(row.version, row.checksum, migration.checksum);
    }
    this.core.migrations = available;
  }
  /** Refuses to continue while migrations are pending; PostgreSQL never migrates implicitly. */
  assertCurrent(): void {
    const status = this.status();
    if (status.pending.length)
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Database schema is behind; run testmaster db migrate",
        { reasonCode: "schema_behind", pending: status.pending },
      );
  }
  /**
   * Where the applied schema stands against the migrations this build ships. A controller or worker
   * whose build is older than the database (`ahead`) must not write or claim work, one whose build
   * is newer (`behind`) must wait for `testmaster db migrate`; only `current` may do either.
   */
  schemaCompatibility(): {
    databaseVersion: number;
    supportedVersion: number;
    state: "current" | "behind" | "ahead";
  } {
    const databaseVersion = this.tableExists("schema_migrations")
      ? Number(
          this.get("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations")?.version,
        )
      : 0;
    const supportedVersion = this.core.migrations.length;
    return {
      databaseVersion,
      supportedVersion,
      state:
        databaseVersion === supportedVersion
          ? "current"
          : databaseVersion > supportedVersion
            ? "ahead"
            : "behind",
    };
  }
  /**
   * PostgreSQL tenant isolation facts (ADR-015): whether the connected role can bypass row-level
   * security and which tenant tables lack a forced `tenant_isolation` policy. SQLite has one tenant.
   */
  tenantIsolation(): { roleBypassesRls: boolean; unprotectedTables: string[] } {
    if (this.core.engine !== "postgres") return { roleBypassesRls: false, unprotectedTables: [] };
    const role = this.get<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    );
    // The translator refuses `oid`, so tables, flags and policies come from three oid-free views.
    const tenantTables = this.all<{ name: string }>(
      "SELECT table_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND column_name='workspace_id'",
    ).map((row) => row.name);
    const flags = this.all<{ name: string; enabled: boolean; forced: boolean }>(
      "SELECT relname AS name, relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE relkind='r'",
    );
    const policies = new Set(
      this.all<{ name: string }>(
        "SELECT tablename AS name FROM pg_policies WHERE schemaname=current_schema() AND policyname='tenant_isolation'",
      ).map((row) => row.name),
    );
    const unprotected = tenantTables
      .filter(
        (name) =>
          !policies.has(name) ||
          flags.filter((row) => row.name === name).some((row) => !row.enabled || !row.forced),
      )
      .sort();
    return {
      roleBypassesRls: !role || Boolean(role.rolsuper) || Boolean(role.rolbypassrls),
      unprotectedTables: unprotected,
    };
  }
  async migrate(directory?: string): Promise<void> {
    const available = await loadMigrations(this.core.engine, directory);
    if (this.core.engine === "postgres") {
      this.migratePostgres(available);
      return;
    }
    const sqlite = this.core.db;
    if (sqlite.isTransaction) throw new Error("Database migrations require their own transaction");
    this.verifyCompatibility(available);
    const currentVersion =
      this.core.migrations.length &&
      this.get("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
        ? Number(
            this.get("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations")?.version,
          )
        : 0;
    if (currentVersion === available.length) return;
    const rebuildsTables = available.some(
      (migration) =>
        migration.version > currentVersion && tableRebuildMigrations.includes(migration.name),
    );
    if (rebuildsTables) sqlite.exec("PRAGMA foreign_keys=OFF");
    sqlite.exec("PRAGMA busy_timeout=0");
    try {
      try {
        sqlite.exec("BEGIN EXCLUSIVE");
      } catch {
        throw new ContractError("PRECONDITION_FAILED", "Another instance owns the migration lock");
      }
      this.verifyCompatibility(available);
      sqlite.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)",
      );
      const applied = Number(this.get("SELECT COUNT(*) AS n FROM schema_migrations")?.n);
      for (const migration of available.slice(applied)) {
        sqlite.exec(migration.sql);
        sqlite
          .prepare(
            "INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)",
          )
          .run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      }
      if (rebuildsTables && this.all("PRAGMA foreign_key_check").length)
        throw new Error("Migration produced a foreign key violation");
      sqlite.exec("COMMIT");
    } catch (error) {
      if (sqlite.isTransaction) sqlite.exec("ROLLBACK");
      throw error;
    } finally {
      sqlite.exec(`PRAGMA busy_timeout=${sqliteBusyTimeoutMs}`);
      if (rebuildsTables) sqlite.exec("PRAGMA foreign_keys=ON");
    }
  }
  /**
   * PostgreSQL migrations: a session advisory lock serializes migrators, each migration file runs
   * in its own transaction and records its checksum, and migrations always run with the controller
   * scope because they may move rows across workspaces.
   */
  private migratePostgres(available: Migration[]): void {
    const core = this.postgres();
    if (core.inTransaction) throw new Error("Database migrations require their own transaction");
    const migrator = new PersistenceDatabase(core, "*", false);
    const request = (steps: BridgeStep[], recover?: string[]): BridgeRows[] =>
      migrator.bridge(core, {
        steps,
        ...(recover ? { recover } : {}),
        timeoutMs: migrationTimeoutMs,
      });
    request([
      { sql: "SET lock_timeout='60s'" },
      { sql: `SELECT pg_advisory_lock(${migrationLockKey})` },
      { sql: "RESET lock_timeout" },
    ]);
    try {
      request([
        {
          sql: "CREATE TABLE IF NOT EXISTS schema_migrations(version BIGINT PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)",
        },
      ]);
      migrator.verifyCompatibility(available);
      const applied = Number(migrator.get("SELECT COUNT(*) AS n FROM schema_migrations")?.n);
      for (const migration of available.slice(applied))
        request(
          [
            { sql: "BEGIN" },
            { sql: migration.sql },
            {
              sql: "INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES($1,$2,$3,$4)",
              params: [
                migration.version,
                migration.name,
                migration.checksum,
                new Date().toISOString(),
              ],
            },
            { sql: "COMMIT" },
          ],
          ["ROLLBACK"],
        );
    } finally {
      try {
        request([{ sql: `SELECT pg_advisory_unlock(${migrationLockKey})` }]);
      } catch {
        // The session lock disappears with the connection if the unlock cannot be delivered.
      }
    }
  }
  status(): DatabaseStatus {
    const rows = this.tableExists("schema_migrations")
      ? this.all<MigrationStatus>(
          "SELECT version,name,checksum,applied_at AS appliedAt FROM schema_migrations ORDER BY version",
        )
      : [];
    const currentVersion = rows.at(-1)?.version ?? 0;
    return {
      currentVersion,
      migrations: rows,
      pending: this.core.migrations
        .filter((migration) => migration.version > currentVersion)
        .map((migration) => migration.version),
    };
  }
  async backup(destinationDir: string, options: BackupOptions = {}): Promise<BackupManifest> {
    const destination = resolve(destinationDir);
    await mkdir(destination, { mode: 0o700 });
    const dbPath = join(destination, "testmaster.db");
    await backup(this.sqlite("Backup and restore of the metadata database (use pg_dump)"), dbPath, {
      rate: 100,
    });
    await chmod(dbPath, 0o600);
    const snapshot = new DatabaseSync(dbPath, { readOnly: true });
    let index: EvidenceIndex;
    let databaseVersion: number;
    const metadataFiles: BackupManifestFile[] = [];
    try {
      const refs = snapshot
        .prepare(
          "SELECT workspace_id,id,run_id,attempt_id,snapshot_id,storage_key,hash,bytes,state FROM artifacts ORDER BY workspace_id,id",
        )
        .all();
      if (
        snapshot
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fixture_inputs'")
          .get()
      ) {
        refs.push(
          ...snapshot
            .prepare(
              "SELECT workspace_id,id,NULL AS run_id,NULL AS attempt_id,NULL AS snapshot_id,storage_key,content_hash AS hash,size_bytes AS bytes,CASE WHEN EXISTS(SELECT 1 FROM operational_state d WHERE d.key='retention:artifact:' || f.workspace_id || ':' || f.id OR d.key='retention:deletion:' || f.workspace_id || ':' || f.id) THEN 'expired' ELSE 'available' END AS state FROM fixture_inputs f ORDER BY workspace_id,id",
            )
            .all(),
        );
      }
      databaseVersion = Number(
        snapshot.prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations").get()
          ?.version,
      );
      index = {
        exportVersion: "1.0.0",
        createdAt: new Date().toISOString(),
        artifactRefs: refs,
        missingObjects: refs
          .filter((row) => row.state !== "available")
          .map((row) => String(row.id)),
        complete: false,
        configDigests: options.configDigests ?? [],
        keyIds: options.keyIds ?? [],
      };
      // Database/index backup intentionally does not claim that evidence blobs were copied.
      index.complete = refs.length === 0;
      if (options.evidenceRoot) {
        for (const row of refs) {
          const key = String(row.storage_key);
          if (
            key.startsWith("/") ||
            key.split(/[\\/]/u).some((part) => part === ".." || part === "." || !part)
          )
            throw new Error("Unsafe evidence storage key");
          if (row.state !== "available") continue;
          const source = join(resolve(options.evidenceRoot), key);
          try {
            const info = await lstat(source);
            if (
              !info.isFile() ||
              info.isSymbolicLink() ||
              info.nlink !== 1 ||
              info.size !== Number(row.bytes) ||
              (await fileSha256(source)) !== row.hash
            )
              throw new Error("Evidence object unavailable or corrupt");
            const target = join(destination, "evidence", key);
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await copyFile(source, target);
            if ((await fileSha256(target)) !== row.hash)
              throw new Error("Copied evidence hash mismatch");
            await chmod(target, 0o600);
          } catch {
            index.missingObjects.push(String(row.id));
          }
        }
        const snapshots = snapshot
          .prepare("SELECT workspace_id,run_id,attempt_id FROM snapshots ORDER BY workspace_id,id")
          .all();
        for (const row of snapshots) {
          for (const name of ["manifest.json", "meta.json"]) {
            const key = `runs/${String(row.workspace_id)}/${String(row.run_id)}/${String(row.attempt_id)}/${name}`;
            try {
              const source = join(resolve(options.evidenceRoot), key);
              const info = await lstat(source);
              if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
                throw new Error("Unsafe snapshot metadata");
              const target = join(destination, "evidence", key);
              await mkdir(dirname(target), { recursive: true, mode: 0o700 });
              await copyFile(source, target);
              metadataFiles.push({
                relativePath: `evidence/${key}`,
                sizeBytes: info.size,
                sha256: await fileSha256(target),
              });
            } catch {
              index.missingObjects.push(key);
            }
          }
        }
        index.complete = index.missingObjects.length === 0;
      }
    } finally {
      snapshot.close();
    }
    const indexPath = join(destination, "evidence-index.json");
    await writeAtomic(indexPath, JSON.stringify(index));
    const files: BackupManifestFile[] = [...metadataFiles];
    for (const relativePath of ["testmaster.db", "evidence-index.json"]) {
      const path = join(destination, relativePath);
      files.push({
        relativePath,
        sizeBytes: (await lstat(path)).size,
        sha256: await fileSha256(path),
      });
    }
    if (options.evidenceRoot)
      for (const ref of index.artifactRefs) {
        const id = String(ref.id);
        if (index.missingObjects.includes(id)) continue;
        const relativePath = `evidence/${String(ref.storage_key)}`;
        if (files.some((file) => file.relativePath === relativePath)) continue;
        files.push({ relativePath, sizeBytes: Number(ref.bytes), sha256: String(ref.hash) });
      }
    const manifest = validate<BackupManifest>("BackupManifest", {
      schemaVersion: "1.0.0",
      createdAt: index.createdAt,
      files,
      databaseVersion,
      secretIncluded: false,
      keyIds: options.keyIds ?? [],
      configDigests: options.configDigests ?? [],
      missingObjects: index.missingObjects,
    });
    for (const file of files) {
      const fd = await open(join(destination, file.relativePath), "r");
      try {
        await fd.sync();
      } finally {
        await fd.close();
      }
    }
    await writeAtomic(join(destination, "manifest.json"), JSON.stringify(manifest));
    return manifest;
  }
  static async restore(
    backupDir: string,
    destinationDir: string,
    options: {
      revocations?: SqlRow[];
      tombstones?: SqlRow[];
      /** Approval rows revoked in the live ledger after the backup was taken. */
      approvalRevocations?: SqlRow[];
      /** False when the caller could not read the post-backup ledger; the restore stays suspended and says so. */
      ledgerAvailable?: boolean;
      /** Keep the backup's schema version instead of migrating forward (older-release rollback). */
      keepSchema?: boolean;
    } = {},
  ): Promise<RestoreResult> {
    const source = resolve(backupDir);
    const destination = resolve(destinationDir);
    const manifest = validate<BackupManifest>(
      "BackupManifest",
      await readBackupJson(source, "manifest.json"),
    );
    const available = await loadMigrations();
    if (manifest.databaseVersion > available.length)
      throw new ContractError("PRECONDITION_FAILED", "Backup database version is unsupported", {
        reasonCode: "backup_version_unsupported",
        databaseVersion: manifest.databaseVersion,
        supportedVersion: available.length,
        nextActions: ["use_newer_release"],
      });
    const paths: Record<string, true> = {};
    for (const file of manifest.files) {
      if (paths[file.relativePath])
        throw backupIntegrity("Duplicate backup file", file.relativePath);
      paths[file.relativePath] = true;
      const path = join(source, file.relativePath);
      const info = await lstat(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw backupIntegrity("Backup file is missing", file.relativePath);
        throw error;
      });
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size !== file.sizeBytes ||
        (await fileSha256(path)) !== file.sha256
      )
        throw backupIntegrity("Backup integrity failure", file.relativePath);
    }
    if (!paths["testmaster.db"] || !paths["evidence-index.json"])
      throw backupIntegrity("Backup requires database and evidence index");
    const index = (await readBackupJson(source, "evidence-index.json")) as EvidenceIndex | null;
    if (typeof index !== "object" || index === null || typeof index.complete !== "boolean")
      throw backupIntegrity("Backup evidence index is malformed", "evidence-index.json");
    await mkdir(destination, { mode: 0o700 });
    // From here the destination exists because this call created it, so every failure removes it.
    let restored: PersistenceDatabase | undefined;
    try {
      for (const file of manifest.files) {
        const target = join(destination, file.relativePath);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await copyFile(join(source, file.relativePath), target);
        await chmod(target, 0o600);
      }
      try {
        restored = await PersistenceDatabase.open(join(destination, "testmaster.db"), {
          migrate: false,
        });
        if (
          restored.get("PRAGMA integrity_check")?.integrity_check !== "ok" ||
          restored.all("PRAGMA foreign_key_check").length
        )
          throw backupIntegrity("Restored database integrity check failed");
        if (restored.status().currentVersion !== manifest.databaseVersion)
          throw backupIntegrity("Backup database schema version mismatch");
      } catch (error) {
        // A file with a valid hash that SQLite cannot read is a corrupt backup; other errors keep their type.
        if ((error as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR")
          throw backupIntegrity("Restored database cannot be read", "testmaster.db");
        throw error;
      }
      if (!options.keepSchema) await restored.migrate();
      const ledgerAvailable = options.ledgerAvailable !== false;
      const database = restored;
      database.withTx(() =>
        applyRestoreTightening(database, { ...options, evidenceComplete: index.complete }),
      );
      return {
        database,
        manifest,
        evidenceComplete: index.complete,
        postBackupLedger: ledgerAvailable ? "replayed" : "unavailable",
        exclusionsGuaranteed: ledgerAvailable,
        requiresOperatorReview: true,
      };
    } catch (error) {
      restored?.close();
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }
}
export interface BackupManifestFile {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}
export interface BackupManifest {
  schemaVersion: "1.0.0";
  createdAt: string;
  files: BackupManifestFile[];
  databaseVersion: number;
  secretIncluded: false;
  keyIds?: string[];
  configDigests?: string[];
  missingObjects?: string[];
  /** Server-profile (ADR-019) backups: engine, id, encryption parameters and manifest MAC. */
  engine?: "sqlite" | "postgres";
  backupId?: string;
  encryption?: { algorithm: "aes-256-gcm-chunked"; keyId: string; chunkBytes: number };
  mac?: string;
}
export interface BackupOptions {
  evidenceRoot?: string;
  configDigests?: string[];
  keyIds?: string[];
}
export interface EvidenceIndex {
  exportVersion: string;
  createdAt: string;
  artifactRefs: SqlRow[];
  missingObjects: string[];
  complete: boolean;
  configDigests: string[];
  keyIds: string[];
}
export interface RestoreResult {
  database: PersistenceDatabase;
  manifest: BackupManifest;
  evidenceComplete: boolean;
  /** `unavailable` when the caller could not read the live post-backup ledger. */
  postBackupLedger: "replayed" | "unavailable";
  /** False when revocations and tombstones made after the snapshot cannot be guaranteed. */
  exclusionsGuaranteed: boolean;
  requiresOperatorReview: true;
}
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.partial`;
  const fd = await open(temporary, "wx", 0o600);
  try {
    await fd.writeFile(text);
    await fd.sync();
  } finally {
    await fd.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
