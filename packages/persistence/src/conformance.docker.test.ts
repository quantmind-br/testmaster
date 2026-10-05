import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "pg";
import { expect, it } from "vitest";
import { constraintErrorClass, constraintFixtures, constraintSeed } from "./constraint-fixtures.js";
import { loadMigrations, PersistenceDatabase } from "./database.js";

export const POSTGRES_CONFORMANCE_IMAGE =
  "postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24";
const exec = promisify(execFile);
it("PostgreSQL and SQLite enforce identical constraint fixtures", async () => {
  const name = `tm-pg-conformance-${process.pid}-${Date.now()}`;
  const password = "local-conformance-only";
  const sqlite = PersistenceDatabase.memory();
  let client: Client | undefined;
  try {
    await sqlite.migrate();
    await exec("docker", [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "io.testmaster.test=postgres-conformance",
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-p",
      "127.0.0.1::5432",
      POSTGRES_CONFORMANCE_IMAGE,
    ]);
    const inspect = await exec("docker", ["inspect", name]);
    const facts = JSON.parse(inspect.stdout) as Array<{
      NetworkSettings: { Ports: Record<string, Array<{ HostIp: string; HostPort: string }>> };
    }>;
    const mapping = facts[0]?.NetworkSettings.Ports["5432/tcp"]?.[0];
    if (mapping?.HostIp !== "127.0.0.1")
      throw new Error("Postgres conformance must bind loopback only");
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = new Client({
        host: "127.0.0.1",
        port: Number(mapping.HostPort),
        user: "postgres",
        password,
        database: "postgres",
        connectionTimeoutMillis: 1000,
      });
      try {
        await candidate.connect();
        client = candidate;
        break;
      } catch {
        await candidate.end().catch(() => {});
        await delay(100);
      }
    }
    if (!client) throw new Error("Postgres did not become ready");
    for (const migration of await loadMigrations("postgres")) await client.query(migration.sql);
    await client.query("BEGIN");
    for (const statement of constraintSeed) await client.query(statement);
    await client.query("COMMIT");
    sqlite.withTx(() => {
      for (const statement of constraintSeed) sqlite.db.exec(statement);
    });
    for (const fixture of constraintFixtures) {
      let sqliteClass = "accept";
      let pgClass = "accept";
      sqlite.db.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of fixture.statements) sqlite.db.exec(statement);
        sqlite.db.exec("PRAGMA defer_foreign_keys=OFF");
        const errors = sqlite.all("PRAGMA foreign_key_check");
        if (errors.length) throw new Error("foreign key constraint violation");
      } catch (error) {
        sqliteClass = constraintErrorClass(error);
      } finally {
        sqlite.db.exec("ROLLBACK");
      }
      await client.query("BEGIN");
      try {
        for (const statement of fixture.statements) await client.query(statement);
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      } catch (error) {
        pgClass = constraintErrorClass(error);
      } finally {
        await client.query("ROLLBACK");
      }
      expect({ sqlite: sqliteClass, postgres: pgClass }, fixture.name).toEqual({
        sqlite: fixture.expected,
        postgres: fixture.expected,
      });
    }
  } finally {
    sqlite.close();
    if (client) await client.end();
    await exec("docker", ["rm", "-f", name]).catch(() => {});
  }
}, 120000);
