/**
 * PostgreSQL test harness (`@testmaster/persistence/testing`).
 *
 * `startPostgresTestServer` runs one pinned postgres:17-alpine container with a loopback-only port
 * and prepares a migrated template database owned by a non-superuser role. `createTestDatabase`
 * hands out fresh databases from that template, so every test gets its own migrated database
 * whose owner can neither bypass row-level security nor administer the cluster.
 */
import * as childProcess from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import pg from "pg";
import { PersistenceDatabase } from "../database.js";
import type { PostgresConfig } from "../postgres/bridge.js";

// Resolved at call time so tests that mock node:child_process can still import this module.
const exec = (file: string, args: string[]) => promisify(childProcess.execFile)(file, args);

export const postgresTestImage =
  "postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24";

/** Serializable description of the running test server, provided to vitest workers. */
export interface PostgresTestServerInfo {
  host: string;
  port: number;
  adminPassword: string;
  /** Non-superuser role that owns the template and every database cloned from it. */
  ownerRole: string;
  ownerPasswordFile: string;
  template: string;
}
export interface PostgresTestServer extends PostgresTestServerInfo {
  stop(): Promise<void>;
}
export interface TestDatabase {
  config: PostgresConfig;
  database: string;
  role: string;
  drop(): Promise<void>;
}

const identifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

async function admin<T>(
  info: PostgresTestServerInfo,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    host: info.host,
    port: info.port,
    user: "postgres",
    password: info.adminPassword,
    database: "postgres",
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function waitReady(
  info: Pick<PostgresTestServerInfo, "host" | "port" | "adminPassword">,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const client = new pg.Client({
      host: info.host,
      port: info.port,
      user: "postgres",
      password: info.adminPassword,
      database: "postgres",
      connectionTimeoutMillis: 1000,
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      await client.end().catch(() => {});
      await setTimeout(100);
    }
  }
  throw new Error("PostgreSQL test server did not become ready");
}

function configFor(
  info: PostgresTestServerInfo,
  database: string,
  role: string,
  passwordFile: string,
): PostgresConfig {
  return {
    url: `postgres://${role}@${info.host}:${info.port}/${database}`,
    passwordFile,
    applicationName: "testmaster-test",
  };
}

/** Starts the container, creates the owner role and a migrated template database. */
export async function startPostgresTestServer(): Promise<PostgresTestServer> {
  const name = `tm-pg-test-${process.pid}-${Date.now().toString(36)}`;
  const adminPassword = randomBytes(18).toString("base64url");
  await exec("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--label",
    "io.testmaster.test=postgres",
    "-e",
    `POSTGRES_PASSWORD=${adminPassword}`,
    "-e",
    "POSTGRES_INITDB_ARGS=--locale=C --encoding=UTF8",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,mode=0700,uid=70,gid=70",
    "-p",
    "127.0.0.1::5432",
    postgresTestImage,
    "-c",
    "fsync=off",
    "-c",
    "synchronous_commit=off",
    "-c",
    "full_page_writes=off",
    "-c",
    "max_connections=300",
  ]);
  const stopContainer = async (): Promise<void> => {
    await exec("docker", ["rm", "-f", name]).catch(() => {});
  };
  let directory: string | undefined;
  try {
    const mapping =
      (await exec("docker", ["port", name, "5432/tcp"])).stdout.trim().split("\n")[0] ?? "";
    const match = /^(127\.0\.0\.1):(\d+)$/u.exec(mapping);
    if (!match) throw new Error(`PostgreSQL test server must bind loopback only, got ${mapping}`);
    const base = { host: "127.0.0.1", port: Number(match[2]), adminPassword };
    await waitReady(base);
    directory = await mkdtemp(join(tmpdir(), "tm-pg-test-"));
    const ownerRole = `tm_owner_${randomBytes(6).toString("hex")}`;
    const ownerPassword = randomBytes(18).toString("base64url");
    const ownerPasswordFile = join(directory, "owner.password");
    await writeFile(ownerPasswordFile, ownerPassword, { mode: 0o600 });
    await chmod(ownerPasswordFile, 0o600);
    const info: PostgresTestServerInfo = {
      ...base,
      ownerRole,
      ownerPasswordFile,
      template: "tm_template",
    };
    await admin(info, async (client) => {
      await client.query(
        `CREATE ROLE ${identifier(ownerRole)} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${literal(ownerPassword)}`,
      );
      await client.query(
        `CREATE DATABASE ${identifier(info.template)} OWNER ${identifier(ownerRole)} TEMPLATE template0 LOCALE 'C' ENCODING 'UTF8'`,
      );
    });
    const template = PersistenceDatabase.openPostgres(
      configFor(info, info.template, ownerRole, ownerPasswordFile),
    );
    try {
      await template.migrate();
    } finally {
      template.close();
    }
    const directoryToRemove = directory;
    return {
      ...info,
      async stop() {
        await stopContainer();
        await rm(directoryToRemove, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stopContainer();
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Creates a fresh, migrated database. By default it is cloned from the migrated template and owned
 * by the run's non-superuser role. With `fresh` it gets its own new role and is migrated from
 * scratch, which is what the migration tests need.
 */
export async function createTestDatabaseOn(
  server: PostgresTestServerInfo,
  options: { fresh?: boolean; migrate?: boolean } = {},
): Promise<TestDatabase> {
  const database = `tm_t_${randomBytes(8).toString("hex")}`;
  let role = server.ownerRole;
  let passwordFile = server.ownerPasswordFile;
  let directory: string | undefined;
  if (options.fresh || options.migrate === false) {
    role = `tm_owner_${randomBytes(6).toString("hex")}`;
    const password = randomBytes(18).toString("base64url");
    directory = await mkdtemp(join(tmpdir(), "tm-pg-role-"));
    passwordFile = join(directory, "owner.password");
    await writeFile(passwordFile, password, { mode: 0o600 });
    await chmod(passwordFile, 0o600);
    await admin(server, async (client) => {
      await client.query(
        `CREATE ROLE ${identifier(role)} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${literal(password)}`,
      );
      await client.query(
        `CREATE DATABASE ${identifier(database)} OWNER ${identifier(role)} TEMPLATE template0 LOCALE 'C' ENCODING 'UTF8'`,
      );
    });
    if (options.migrate !== false) {
      const created = PersistenceDatabase.openPostgres(
        configFor(server, database, role, passwordFile),
      );
      try {
        await created.migrate();
      } finally {
        created.close();
      }
    }
  } else
    await admin(server, (client) =>
      client.query(
        `CREATE DATABASE ${identifier(database)} OWNER ${identifier(role)} TEMPLATE ${identifier(server.template)}`,
      ),
    );
  return {
    config: configFor(server, database, role, passwordFile),
    database,
    role,
    async drop() {
      await admin(server, async (client) => {
        await client.query(`DROP DATABASE IF EXISTS ${identifier(database)} WITH (FORCE)`);
        if (directory) await client.query(`DROP ROLE IF EXISTS ${identifier(role)}`);
      });
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
}

export { admin as withAdminConnection };
