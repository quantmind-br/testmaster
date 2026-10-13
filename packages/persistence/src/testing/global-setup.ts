import { type PostgresTestServerInfo, startPostgresTestServer } from "./server.js";

/** Vitest global setup for the `postgres` and `postgres-parity` projects: one container per run. */
export default async function setup(project: {
  provide(key: "postgresTestServer", value: PostgresTestServerInfo): void;
}): Promise<() => Promise<void>> {
  const { stop, ...info } = await startPostgresTestServer();
  project.provide("postgresTestServer", info);
  return stop;
}
