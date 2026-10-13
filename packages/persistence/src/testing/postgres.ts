/**
 * PostgreSQL test harness entry point (`@testmaster/persistence/testing`), for use inside vitest
 * projects whose global setup started the server (see `global-setup.ts`).
 */
import { inject } from "vitest";
import {
  createTestDatabaseOn,
  type PostgresTestServerInfo,
  type TestDatabase,
  withAdminConnection,
} from "./server.js";

export {
  type PostgresTestServerInfo,
  postgresTestImage,
  type TestDatabase,
} from "./server.js";

declare module "vitest" {
  export interface ProvidedContext {
    postgresTestServer: PostgresTestServerInfo;
  }
}

function currentServer(): PostgresTestServerInfo {
  const info = inject("postgresTestServer");
  if (!info)
    throw new Error("PostgreSQL test server is not running; use the vitest postgres projects");
  return info;
}

/**
 * Creates a fresh, migrated database. By default it is cloned from the migrated template and owned
 * by the run's non-superuser role. With `fresh` it gets its own new role and is migrated from
 * scratch; with `migrate: false` it is left empty (the migration tests need that).
 */
export function createTestDatabase(
  options: { fresh?: boolean; migrate?: boolean } = {},
): Promise<TestDatabase> {
  return createTestDatabaseOn(currentServer(), options);
}

/** Runs `work` on a superuser connection, for tests that must observe the cluster as an administrator. */
export function withAdminClient<T>(work: Parameters<typeof withAdminConnection<T>>[1]): Promise<T> {
  return withAdminConnection(currentServer(), work);
}

/** Connection details of the running test server, e.g. to start a second process against it. */
export const postgresTestServer = (): PostgresTestServerInfo => currentServer();

/**
 * True when the test file runs in the `postgres-parity` project. Tests whose subject is the SQLite
 * file format, a SQLite pragma or the SQLite backup API use `it.skipIf(postgresParity)` and name
 * the reason in a comment, so each one stays visible and runs in the default `unit` project.
 */
export const postgresParity = inject("postgresTestServer") !== undefined;
