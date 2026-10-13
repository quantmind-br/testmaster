import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ContractError } from "@testmaster/contracts";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, MigrationChecksumError, PersistenceDatabase } from "./database.js";
import { PostgresBridge } from "./postgres/bridge.js";
import { LeaseRepository } from "./repositories.js";
import {
  createTestDatabase,
  postgresTestServer,
  type TestDatabase,
  withAdminClient,
} from "./testing/postgres.js";
import { seedQueuedRun } from "./testing/seed.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const persistenceDist = pathToFileURL(
  resolve(repositoryRoot, "packages/persistence/dist/index.js"),
).href;
const cliMain = resolve(repositoryRoot, "apps/cli/dist/main.js");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function database(options?: { fresh?: boolean; migrate?: boolean }): Promise<TestDatabase> {
  const created = await createTestDatabase(options);
  cleanups.push(() => created.drop());
  return created;
}

function open(created: TestDatabase): PersistenceDatabase {
  const db = PersistenceDatabase.openPostgres(created.config);
  cleanups.push(() => {
    if (db.isOpen) db.close();
  });
  return db;
}

function passwordFileOf(created: TestDatabase): string {
  const file = created.config.passwordFile;
  if (!file) throw new Error("test database has no password file");
  return file;
}

/** A plain driver connection as the test database's owner role, outside the PersistenceDatabase bridge. */
async function ownerClient(created: TestDatabase): Promise<pg.Client> {
  const url = new URL(created.config.url);
  const client = new pg.Client({
    host: url.hostname,
    port: Number(url.port),
    user: decodeURIComponent(url.username),
    password: (await readFile(passwordFileOf(created), "utf8")).trim(),
    database: created.database,
  });
  await client.connect();
  cleanups.push(() => client.end());
  return client;
}

/** Connection settings for the cluster superuser, which PersistenceDatabase must refuse. */
async function administratorConfig(
  database: string,
): Promise<{ url: string; passwordFile: string }> {
  const server = postgresTestServer();
  const directory = await mkdtemp(join(tmpdir(), "tm-pg-admin-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const passwordFile = join(directory, "password");
  await writeFile(passwordFile, server.adminPassword, { mode: 0o600 });
  return { url: `postgres://postgres@${server.host}:${server.port}/${database}`, passwordFile };
}

interface Envelope {
  data: { engine: string; currentVersion: number; pending: number[] };
}

interface Child {
  waitFor(text: string): Promise<void>;
  kill(signal: NodeJS.Signals): void;
  exited: Promise<{ code: number | null; out: string; err: string }>;
}

/** Runs a Node ES-module script in another OS process against the built packages. */
function startChild(
  script: string,
  args: string[],
  executable = process.execPath,
  prefix = ["--input-type=module", "-e"],
): Child {
  const child = spawn(executable, [...prefix, script, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  const waiters: Array<{ text: string; resolve: () => void }> = [];
  child.stdout.on("data", (chunk) => {
    out += String(chunk);
    for (const waiter of waiters.splice(0)) {
      if (out.includes(waiter.text)) waiter.resolve();
      else waiters.push(waiter);
    }
  });
  child.stderr.on("data", (chunk) => {
    err += String(chunk);
  });
  const { promise, resolve: done } = Promise.withResolvers<{
    code: number | null;
    out: string;
    err: string;
  }>();
  child.on("exit", (code) => done({ code, out, err }));
  cleanups.push(() => {
    child.kill("SIGKILL");
  });
  return {
    exited: promise,
    kill(signal) {
      child.kill(signal);
    },
    waitFor(text) {
      if (out.includes(text)) return Promise.resolve();
      const { promise: seen, resolve } = Promise.withResolvers<void>();
      waiters.push({ text, resolve });
      void promise.then(() => {
        if (!out.includes(text)) resolve();
      });
      return seen.then(() => {
        if (!out.includes(text)) throw new Error(`child exited before printing ${text}: ${err}`);
      });
    },
  };
}

function holdWriterScript(): string {
  return `import { PersistenceDatabase } from ${JSON.stringify(persistenceDist)};
const db = PersistenceDatabase.openPostgres(JSON.parse(process.argv[1]));
db.withTx(() => {
  db.run("INSERT INTO operational_state(key,value) VALUES('lock-holder','held')");
  console.log("locked");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[2]));
});
console.log("released");
db.close();`;
}

const tenantTables = `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND EXISTS (
    SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id' AND NOT a.attisdropped)
  ORDER BY c.relname`;

async function tablesMissingTenantRls(client: pg.Client): Promise<string[]> {
  const result = await client.query<{ name: string }>(`SELECT t.name FROM (${tenantTables}) t
    JOIN pg_class c ON c.relname=t.name AND c.relnamespace='public'::regnamespace
    WHERE NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR NOT EXISTS (
      SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation')
    ORDER BY t.name`);
  return result.rows.map((row) => row.name);
}

describe("PostgreSQL engine", () => {
  it("OPS-005 applies checksummed contiguous migrations, never implicitly, and refuses altered bytes", async () => {
    const created = await database({ migrate: false });
    const db = open(created);
    expect(db.engine).toBe("postgres");
    expect(db.status().currentVersion).toBe(0);
    expect(() => db.assertCurrent()).toThrowError(
      expect.objectContaining({
        code: "PRECONDITION_FAILED",
        message: "Database schema is behind; run testmaster db migrate",
      }),
    );
    await db.migrate();
    const available = await loadMigrations("postgres");
    expect(db.status().currentVersion).toBe(available.length);
    expect(db.status().pending).toEqual([]);
    expect(db.status().migrations.map((row) => row.checksum)).toEqual(
      available.map((row) => row.checksum),
    );
    expect(() => db.assertCurrent()).not.toThrow();
    await db.migrate();
    expect(db.status().currentVersion).toBe(available.length);

    const directory = await mkdtemp(join(tmpdir(), "tm-pg-migrations-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const first = available[0];
    if (!first) throw new Error("missing migration");
    await writeFile(join(directory, "0001_initial.sql"), `${first.sql}\n-- changed`);
    await expect(db.migrate(directory)).rejects.toBeInstanceOf(MigrationChecksumError);
    await writeFile(join(directory, "0001_initial.sql"), first.sql);
    await writeFile(join(directory, "0003_gap.sql"), "SELECT 1");
    await expect(db.migrate(directory)).rejects.toThrow(
      "Migration versions must be contiguous and unique",
    );
  });

  it("OPS-005 rolls back a migration that fails after DDL and keeps earlier migrations", async () => {
    const created = await database({ migrate: false });
    const db = open(created);
    const directory = await mkdtemp(join(tmpdir(), "tm-pg-migrations-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, "0001_base.sql"), "CREATE TABLE kept(a INTEGER)");
    await writeFile(
      join(directory, "0002_broken.sql"),
      "CREATE TABLE transient(a INTEGER); SELECT 1/0",
    );
    await expect(db.migrate(directory)).rejects.toThrow("division by zero");
    expect(db.get("SELECT to_regclass('transient') AS found")?.found).toBeNull();
    expect(db.get("SELECT to_regclass('kept') AS found")?.found).toBe("kept");
    expect(db.get("SELECT COUNT(*) AS n FROM schema_migrations")?.n).toBe(1);
    expect(db.inTransaction).toBe(false);
  });

  it("OPS-005 serializes two concurrent migrators on the advisory lock and applies each migration once", async () => {
    const created = await database({ migrate: false });
    const holder = await ownerClient(created);
    await holder.query("SELECT pg_advisory_lock(7340042)");
    const arguments_ = [
      "db",
      "migrate",
      "--json",
      "--database-url",
      created.config.url,
      "--password-file",
      passwordFileOf(created),
    ];
    const migrators = [
      startChild(cliMain, arguments_, process.execPath, []),
      startChild(cliMain, arguments_, process.execPath, []),
    ];
    // Both migrators are blocked on the advisory lock once two advisory lock requests are waiting.
    let blocked = 0;
    while (blocked < 2) {
      const waiting = await holder.query(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted",
      );
      blocked = Number(waiting.rows[0]?.n);
    }
    const waiting = await holder.query("SELECT to_regclass('schema_migrations') AS found");
    expect(waiting.rows[0]?.found).toBeNull();
    await holder.query("SELECT pg_advisory_unlock(7340042)");
    const results = await Promise.all(migrators.map((migrator) => migrator.exited));
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    const total = (await loadMigrations("postgres")).length;
    for (const result of results) {
      const envelope: Envelope = JSON.parse(result.out);
      expect(envelope.data).toMatchObject({
        engine: "postgres",
        currentVersion: total,
        pending: [],
      });
    }
    const rows = await holder.query("SELECT version FROM schema_migrations ORDER BY version");
    expect(rows.rows.map((row) => Number(row.version))).toEqual(
      Array.from({ length: total }, (_, index) => index + 1),
    );
  });

  it("OPS-005 testmaster db status reports a pending PostgreSQL schema and refuses a bypassing role", async () => {
    const created = await database({ migrate: false });
    const status = startChild(
      cliMain,
      [
        "db",
        "status",
        "--json",
        "--database-url",
        created.config.url,
        "--password-file",
        passwordFileOf(created),
      ],
      process.execPath,
      [],
    );
    const result = await status.exited;
    expect(result.code).toBe(0);
    const total = (await loadMigrations("postgres")).length;
    const envelope: Envelope = JSON.parse(result.out);
    const data = envelope.data;
    expect(data.currentVersion).toBe(0);
    expect(data.pending).toHaveLength(total);

    const administrator = await administratorConfig(created.database);
    const refused = startChild(
      cliMain,
      [
        "db",
        "migrate",
        "--json",
        "--database-url",
        administrator.url,
        "--password-file",
        administrator.passwordFile,
      ],
      process.execPath,
      [],
    );
    const failure = await refused.exited;
    expect(failure.code).not.toBe(0);
    expect(failure.out + failure.err).toContain("Database role bypasses row-level security");
  });

  it("OPS-005 refuses superuser and BYPASSRLS roles because they would ignore tenant isolation", async () => {
    const created = await database();
    const server = postgresTestServer();
    const directory = await mkdtemp(join(tmpdir(), "tm-pg-roles-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const role = `tm_bypass_${Date.now().toString(36)}`;
    await withAdminClient(async (client) => {
      await client.query(`CREATE ROLE ${role} LOGIN BYPASSRLS PASSWORD 'bypass-secret'`);
    });
    cleanups.push(() =>
      withAdminClient(async (client) => {
        await client.query(`DROP ROLE IF EXISTS ${role}`);
      }),
    );
    const superuserFile = join(directory, "super");
    const bypassFile = join(directory, "bypass");
    await writeFile(superuserFile, server.adminPassword, { mode: 0o600 });
    await writeFile(bypassFile, "bypass-secret", { mode: 0o600 });
    for (const [user, passwordFile] of [
      ["postgres", superuserFile],
      [role, bypassFile],
    ] as const) {
      const attempt = () =>
        PersistenceDatabase.openPostgres({
          url: `postgres://${user}@${server.host}:${server.port}/${created.database}`,
          passwordFile,
        });
      expect(attempt).toThrowError(
        expect.objectContaining({
          code: "PRECONDITION_FAILED",
          message: "Database role bypasses row-level security",
        }),
      );
    }
    expect(() => open(created)).not.toThrow();
  });

  it("OPS-005 enforces row-level security so a scoped connection never reads another workspace", async () => {
    const created = await database();
    const db = open(created);
    const a = seedQueuedRun(db);
    const b = seedQueuedRun(db);
    const viewA = db.forWorkspace(a.ws);
    const viewB = db.forWorkspace(b.ws);

    expect(viewA.all("SELECT id FROM runs").map((row) => row.id)).toEqual([a.run]);
    expect(viewA.all("SELECT id FROM runs WHERE workspace_id=?", b.ws)).toEqual([]);
    expect(viewA.get("SELECT id FROM runs WHERE id=?", b.run)).toBeUndefined();
    expect(viewB.all("SELECT id FROM runs").map((row) => row.id)).toEqual([b.run]);
    expect(db.all("SELECT id FROM runs ORDER BY id")).toHaveLength(2);

    const client = await ownerClient(created);
    const tables = (await client.query<{ name: string }>(tenantTables)).rows.map((row) => row.name);
    expect(tables.length).toBeGreaterThan(40);
    for (const table of tables) {
      const own = viewA.get(`SELECT COUNT(*) AS n FROM ${table}`)?.n;
      const foreign = viewA.get(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id=?`, b.ws)?.n;
      const mine = viewA.get(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id=?`, a.ws)?.n;
      expect(foreign, table).toBe(0);
      expect(own, table).toBe(mine);
    }

    // The same session, once more, without any workspace scope: default deny.
    const unscoped = await client.query("SELECT COUNT(*)::int AS n FROM runs");
    expect(unscoped.rows[0]?.n).toBe(0);
    await client.query("SELECT set_config('testmaster.workspace', $1, false)", [a.ws]);
    expect((await client.query("SELECT id FROM runs")).rows).toEqual([{ id: a.run }]);
  });

  it("OPS-005 row-level security rejects cross-workspace writes and leaves foreign rows untouched", async () => {
    const created = await database();
    const db = open(created);
    const a = seedQueuedRun(db);
    const b = seedQueuedRun(db);
    const viewA = db.forWorkspace(a.ws);
    expect(viewA.run("UPDATE runs SET status='cancelled' WHERE id=?", b.run).changes).toBe(0);
    expect(viewA.run("DELETE FROM runs WHERE id=?", b.run).changes).toBe(0);
    expect(() =>
      viewA.run("INSERT INTO operational_state(key,value) VALUES('probe','x')"),
    ).not.toThrow();
    expect(() => viewA.run("UPDATE runs SET workspace_id=? WHERE id=?", b.ws, a.run)).toThrowError(
      expect.objectContaining({ code: "42501" }),
    );
    expect(db.get("SELECT status FROM runs WHERE id=?", b.run)?.status).toBe("queued");
    expect(db.get("SELECT workspace_id FROM runs WHERE id=?", a.run)?.workspace_id).toBe(a.ws);
  });

  it("OPS-005 refuses a workspace scope switch inside an open transaction", async () => {
    const created = await database();
    const db = open(created);
    const a = seedQueuedRun(db);
    expect(() => db.withTx((tx) => tx.forWorkspace(a.ws).get("SELECT 1 AS one"))).toThrowError(
      expect.objectContaining({
        code: "INTERNAL",
        message: "Workspace scope switch inside a transaction",
      }),
    );
    expect(db.inTransaction).toBe(false);
    expect(db.forWorkspace(a.ws).withTx((tx) => tx.get("SELECT COUNT(*) AS n FROM runs")?.n)).toBe(
      1,
    );
  });

  it("OPS-005 requires row-level security and the tenant policy on every table with a workspace_id", async () => {
    const created = await database();
    const client = await ownerClient(created);
    const tables = (await client.query<{ name: string }>(tenantTables)).rows.map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining(["workspaces", "runs", "audit_events", "artifacts", "server_tokens"]),
    );
    expect(await tablesMissingTenantRls(client)).toEqual([]);
    const policy = await client.query<{ qual: string; with_check: string }>(
      "SELECT qual, with_check FROM pg_policies WHERE tablename='runs' AND policyname='tenant_isolation'",
    );
    expect(policy.rows[0]?.qual).toContain("testmaster.workspace");
    expect(policy.rows[0]?.with_check).toContain("testmaster.workspace");
    // Negative control: a later migration that forgets RLS on a new tenant table is caught.
    await client.query("CREATE TABLE tm_forgotten(workspace_id TEXT NOT NULL, id TEXT)");
    expect(await tablesMissingTenantRls(client)).toEqual(["tm_forgotten"]);
    await client.query("ALTER TABLE tm_forgotten ENABLE ROW LEVEL SECURITY");
    expect(await tablesMissingTenantRls(client)).toEqual(["tm_forgotten"]);
  });

  it("OPS-005 keeps PostgreSQL DDL equivalent to the SQLite schema for tables, columns, keys, indexes and triggers", async () => {
    const created = await database();
    const client = await ownerClient(created);
    const directory = await mkdtemp(join(tmpdir(), "tm-pg-ddl-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const sqlite = await PersistenceDatabase.open(join(directory, "testmaster.db"));
    cleanups.push(() => sqlite.close());

    const sqliteTables = sqlite
      .all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .map((row) => String(row.name));
    const postgresTables = (
      await client.query<{ name: string }>(
        "SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
      )
    ).rows.map((row) => row.name);
    expect(postgresTables).toEqual(sqliteTables);

    const typeFamily: Record<string, string> = {
      TEXT: "text",
      INTEGER: "bigint",
      REAL: "double precision",
      BLOB: "bytea",
    };
    const sqliteColumns = new Map<string, string>();
    for (const table of sqliteTables)
      for (const column of sqlite.all(
        `SELECT name, type, "notnull" AS required, pk FROM pragma_table_info('${table}')`,
      )) {
        const type = String(column.type).toUpperCase();
        sqliteColumns.set(
          `${table}.${column.name}`,
          `${Object.hasOwn(typeFamily, type) ? typeFamily[type] : type} ${column.required === 1 || Number(column.pk) > 0 ? "required" : "nullable"}`,
        );
      }
    const postgresColumns = new Map<string, string>();
    const columns = await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public'",
    );
    for (const column of columns.rows)
      postgresColumns.set(
        `${column.table_name}.${column.column_name}`,
        `${column.data_type} ${column.is_nullable === "NO" ? "required" : "nullable"}`,
      );
    expect([...postgresColumns].sort()).toEqual([...sqliteColumns].sort());

    const sqlitePrimary = sqliteTables.map(
      (table) =>
        `${table}:${sqlite
          .all(`SELECT name FROM pragma_table_info('${table}') WHERE pk > 0 ORDER BY pk`)
          .map((row) => row.name)
          .join(",")}`,
    );
    const primary = await client.query<{ table_name: string; columns: string }>(
      `SELECT c.conrelid::regclass::text AS table_name,
        COALESCE((SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum), '') AS columns
       FROM pg_constraint c WHERE c.contype='p' AND c.connamespace='public'::regnamespace`,
    );
    const postgresPrimary = new Map(primary.rows.map((row) => [row.table_name, row.columns]));
    expect(sqliteTables.map((table) => `${table}:${postgresPrimary.get(table) ?? ""}`)).toEqual(
      sqlitePrimary,
    );

    const sqliteForeign = sqlite
      .all(
        `SELECT m.name AS tbl, f.id AS id, f."table" AS ref, f."from" AS col, f.seq AS seq
         FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type='table' ORDER BY m.name, f.id, f.seq`,
      )
      .reduce((groups, row) => {
        const key = `${row.tbl}#${row.id}`;
        const group = groups.get(key) ?? {
          tbl: String(row.tbl),
          ref: String(row.ref),
          cols: [] as string[],
        };
        group.cols.push(String(row.col));
        groups.set(key, group);
        return groups;
      }, new Map<string, { tbl: string; ref: string; cols: string[] }>());
    const foreign = await client.query<{ tbl: string; ref: string; cols: string }>(
      `SELECT c.conrelid::regclass::text AS tbl, c.confrelid::regclass::text AS ref,
        (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum) AS cols
       FROM pg_constraint c WHERE c.contype='f' AND c.connamespace='public'::regnamespace`,
    );
    expect(sqliteForeign.size).toBeGreaterThan(20);
    expect(foreign.rows.map((row) => `${row.tbl}(${row.cols})->${row.ref}`).sort()).toEqual(
      [...sqliteForeign.values()]
        .map((row) => `${row.tbl}(${row.cols.join(",")})->${row.ref}`)
        .sort(),
    );

    const sqliteIndexes = sqlite
      .all(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name",
      )
      .map((row) => String(row.name));
    const indexes = await client.query<{ name: string }>(
      "SELECT indexname AS name FROM pg_indexes WHERE schemaname='public' AND indexname NOT IN (SELECT conname FROM pg_constraint WHERE contype IN ('p','u')) ORDER BY indexname",
    );
    expect(indexes.rows.map((row) => row.name)).toEqual(sqliteIndexes);

    const sqliteUnique = sqliteTables
      .flatMap((table) =>
        sqlite
          .all(`SELECT name FROM pragma_index_list('${table}') WHERE "unique"=1 AND origin='u'`)
          .map(
            (index) =>
              `${table}:${sqlite
                .all(`SELECT name FROM pragma_index_info('${index.name}') ORDER BY seqno`)
                .map((column) => column.name)
                .join(",")}`,
          ),
      )
      .sort();
    const unique = await client.query<{ table_name: string; columns: string }>(
      `SELECT c.conrelid::regclass::text AS table_name,
        (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum) AS columns
       FROM pg_constraint c WHERE c.contype='u' AND c.connamespace='public'::regnamespace`,
    );
    expect(unique.rows.map((row) => `${row.table_name}:${row.columns}`).sort()).toEqual(
      sqliteUnique,
    );

    // SQLite needs one trigger per statement kind; PostgreSQL folds them into one trigger per table,
    // so the guarded tables are compared rather than the trigger names.
    const sqliteGuarded = sqlite
      .all(
        "SELECT DISTINCT tbl_name AS name FROM sqlite_master WHERE type='trigger' AND name NOT LIKE 'contract_%' ORDER BY tbl_name",
      )
      .map((row) => String(row.name));
    const guarded = await client.query<{ name: string }>(
      "SELECT DISTINCT tgrelid::regclass::text AS name FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1",
    );
    expect(sqliteGuarded.length).toBeGreaterThan(5);
    expect(guarded.rows.map((row) => row.name)).toEqual(sqliteGuarded);
    // SQLite enforces the generated contract constraints with triggers; PostgreSQL uses CHECK constraints.
    const sqliteContract = sqlite
      .all(
        "SELECT DISTINCT tbl_name AS name FROM sqlite_master WHERE type='trigger' AND name LIKE 'contract_%' ORDER BY tbl_name",
      )
      .map((row) => String(row.name));
    const checked = await client.query<{ name: string }>(
      "SELECT DISTINCT conrelid::regclass::text AS name FROM pg_constraint WHERE contype='c' AND connamespace='public'::regnamespace ORDER BY 1",
    );
    expect(sqliteContract.length).toBeGreaterThan(20);
    expect(sqliteContract.filter((name) => !checked.rows.some((row) => row.name === name))).toEqual(
      [],
    );
  });

  it("OPS-005 keeps a failed statement inside a transaction from aborting the transaction, as SQLite does", async () => {
    const created = await database();
    const db = open(created);
    db.withTx(() => {
      db.run("INSERT INTO operational_state(key,value) VALUES('a','1')");
      expect(() => db.run("INSERT INTO operational_state(key,value) VALUES('a','2')")).toThrowError(
        expect.objectContaining({ code: "23505" }),
      );
      db.run("INSERT INTO operational_state(key,value) VALUES('b','1')");
    });
    expect(
      db.all("SELECT key, value FROM operational_state WHERE key IN ('a','b','c') ORDER BY key"),
    ).toEqual([
      { key: "a", value: "1" },
      { key: "b", value: "1" },
    ]);
    expect(() =>
      db.withTx(() => {
        db.run("INSERT INTO operational_state(key,value) VALUES('c','1')");
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(db.get("SELECT key FROM operational_state WHERE key='c'")).toBeUndefined();
  });

  it("OPS-005 makes a write wait for another process's writer transaction while reads stay available", async () => {
    const created = await database();
    const db = open(created);
    const holder = startChild(holdWriterScript(), [JSON.stringify(created.config), "2500"]);
    await holder.waitFor("locked");
    const readStarted = Date.now();
    expect(db.get("SELECT value FROM operational_state WHERE key='lock-holder'")).toBeUndefined();
    expect(Date.now() - readStarted).toBeLessThan(1000);
    const started = Date.now();
    db.withTx(() => db.run("INSERT INTO operational_state(key,value) VALUES('after-holder','ok')"));
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect((await holder.exited).out).toContain("released");
    expect(
      db
        .all(
          "SELECT key FROM operational_state WHERE key IN ('after-holder','lock-holder') ORDER BY key",
        )
        .map((row) => row.key),
    ).toEqual(["after-holder", "lock-holder"]);
  });

  it("OPS-005 bounds writer contention with a typed retryable error and recovers once the writer commits", async () => {
    const created = await database();
    const db = open(created);
    const holder = startChild(holdWriterScript(), [JSON.stringify(created.config), "8500"]);
    await holder.waitFor("locked");
    const started = Date.now();
    let ran = false;
    let error: unknown;
    try {
      db.withTx(() => {
        ran = true;
      });
    } catch (caught) {
      error = caught;
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(4000);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(error).toBeInstanceOf(ContractError);
    expect(error).toMatchObject({
      code: "UNAVAILABLE",
      details: { reasonCode: "writer_contention", retryable: true },
    });
    expect(ran).toBe(false);
    expect(db.inTransaction).toBe(false);
    await holder.exited;
    db.withTx(() =>
      db.run("INSERT INTO operational_state(key,value) VALUES('contention-probe','ok')"),
    );
    expect(db.get("SELECT value FROM operational_state WHERE key='contention-probe'")?.value).toBe(
      "ok",
    );
  });

  it("OPS-005 releases the writer lock and discards uncommitted rows when a writer process is SIGKILLed mid-transaction", async () => {
    const created = await database();
    const db = open(created);
    const holder = startChild(holdWriterScript(), [JSON.stringify(created.config), "60000"]);
    await holder.waitFor("locked");
    holder.kill("SIGKILL");
    const result = await holder.exited;
    expect(result.out).not.toContain("released");
    // The server rolls back the dead session's transaction, so the lock frees without waiting for the holder's timeout.
    db.withTx(() => db.run("INSERT INTO operational_state(key,value) VALUES('survivor','ok')"));
    expect(db.get("SELECT value FROM operational_state WHERE key='survivor'")?.value).toBe("ok");
    expect(db.get("SELECT value FROM operational_state WHERE key='lock-holder'")).toBeUndefined();
  });

  it("OPS-005 lets exactly one of two OS processes claim the same queued job", async () => {
    const created = await database();
    const db = open(created);
    const seeded = seedQueuedRun(db);
    const script = `import { PersistenceDatabase, LeaseRepository } from ${JSON.stringify(persistenceDist)};
const db = PersistenceDatabase.openPostgres(JSON.parse(process.argv[1]));
const result = new LeaseRepository(db).claim({ workspaceId: process.argv[2], owner: process.argv[3], queue: "http" });
console.log(result ? "winner" : "empty");
db.close();`;
    const children = ["A", "B"].map((owner) =>
      startChild(script, [JSON.stringify(created.config), seeded.ws, owner]),
    );
    const results = await Promise.all(children.map((child) => child.exited));
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(results.filter((result) => result.out.includes("winner"))).toHaveLength(1);
    expect(db.all("SELECT * FROM attempts")).toHaveLength(1);
    expect(
      new LeaseRepository(db).claim({ workspaceId: seeded.ws, owner: "C", queue: "http" }),
    ).toBeNull();
  });

  it("OPS-005 reconnects after the server drops an idle connection and never commits a transaction that lost its connection", async () => {
    const created = await database();
    const db = open(created);
    const administrator = PostgresBridge.open(await administratorConfig("postgres"));
    cleanups.push(() => administrator.close());
    const terminate = (pid: number): void => {
      administrator.execute({ steps: [{ sql: "SELECT pg_terminate_backend($1)", params: [pid] }] });
    };
    const pid = Number(db.get("SELECT pg_backend_pid() AS pid")?.pid);
    terminate(pid);
    expect(db.get("SELECT 1 AS one")?.one).toBe(1);
    expect(Number(db.get("SELECT pg_backend_pid() AS pid")?.pid)).not.toBe(pid);

    let failure: unknown;
    try {
      db.withTx(() => {
        db.run("INSERT INTO operational_state(key,value) VALUES('lost','x')");
        terminate(Number(db.get("SELECT pg_backend_pid() AS pid")?.pid));
        db.run("INSERT INTO operational_state(key,value) VALUES('lost2','x')");
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "UNAVAILABLE",
      details: { reasonCode: "database_unavailable", connectionLost: true },
    });
    expect(db.inTransaction).toBe(false);
    expect(db.all("SELECT key FROM operational_state WHERE key IN ('lost','lost2')")).toEqual([]);
    db.withTx(() => db.run("INSERT INTO operational_state(key,value) VALUES('after','ok')"));
    expect(db.get("SELECT value FROM operational_state WHERE key='after'")?.value).toBe("ok");
  });

  it("OPS-005 drops a connection whose statement exceeds the deadline and marks the database broken", async () => {
    const created = await database();
    const bridge = PostgresBridge.open(created.config);
    cleanups.push(() => bridge.close());
    expect(
      bridge.execute({ steps: [{ sql: "SELECT 1 AS one", result: true }] }).results[0]?.rows,
    ).toEqual([{ one: 1 }]);
    const started = Date.now();
    let error: unknown;
    try {
      bridge.execute({ steps: [{ sql: "SELECT pg_sleep(30)" }], timeoutMs: 400 });
    } catch (caught) {
      error = caught;
    }
    expect(Date.now() - started).toBeLessThan(5000);
    expect(error).toMatchObject({
      code: "UNAVAILABLE",
      details: { reasonCode: "database_timeout", retryable: true },
    });
    expect(bridge.isBroken).toBe(true);
    expect(() => bridge.execute({ steps: [{ sql: "SELECT 1" }] })).toThrowError(
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    // The backend is gone, not left running the abandoned statement.
    let remaining = 1;
    while (remaining > 0) {
      const activity = await withAdminClient((client) =>
        client.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND query LIKE '%pg_sleep(30)%'",
          [created.database],
        ),
      );
      remaining = Number(activity.rows[0]?.n);
    }
    expect(remaining).toBe(0);
  });

  it("OPS-005 refuses to open a database whose collation is not byte-ordered", async () => {
    const created = await database();
    await withAdminClient(async (client) => {
      const name = `tm_collate_${Date.now().toString(36)}`;
      await client
        .query(
          `CREATE DATABASE ${name} OWNER ${created.role} TEMPLATE template0 LOCALE 'en_US.UTF-8' ENCODING 'UTF8'`,
        )
        .catch(() => null);
      const exists = await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]);
      cleanups.push(() =>
        withAdminClient(async (admin) => {
          await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        }),
      );
      if (exists.rowCount === 0) return;
      expect(() =>
        PersistenceDatabase.openPostgres({
          ...created.config,
          url: created.config.url.replace(created.database, name),
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "PRECONDITION_FAILED",
          details: expect.objectContaining({ reasonCode: "database_collation" }),
        }),
      );
    });
  });
});
