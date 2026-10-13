import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PersistenceDatabase } from "../../packages/persistence/src/index.js";
import { eventually } from "./harness.js";

/**
 * SEC-036: the reference deployment's PostgreSQL (deploy/compose: hostssl-only pg_hba.conf, TLS key
 * installed by pg-tls-entrypoint.sh) accepts a verify-full client that trusts its CA and refuses
 * everything else. It runs against whichever daemon DOCKER_HOST names (default and rootless).
 */
const exec = promisify(execFile);
const docker = (args: string[]) => exec("docker", args, { env: process.env, timeout: 120_000 });
const deploy = resolve(import.meta.dirname, "../../deploy/compose");
const image =
  "postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24";
const name = `tm-s2a-pgtls-${process.pid}`;
let directory = "";
let port = 0;
const password = randomBytes(12).toString("base64url");
const roleName = "tmtls";

const open = (options: { caFile: string; sslmode?: string; host?: string }) =>
  PersistenceDatabase.openPostgres({
    url: `postgres://${roleName}@${options.host ?? "127.0.0.1"}:${port}/tmtls?sslmode=${options.sslmode ?? "verify-full"}`,
    passwordFile: join(directory, "role.password"),
    caFile: options.caFile,
  });

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "tm-pgtls-"));
  await exec("bash", [join(deploy, "gen-tls.sh"), join(directory, "tls"), "2"]);
  await exec("bash", [join(deploy, "gen-tls.sh"), join(directory, "other-tls"), "2"]);
  await writeFile(join(directory, "role.password"), password, { mode: 0o600 });
  await docker([
    "run",
    "-d",
    "--name",
    name,
    "-e",
    "POSTGRES_PASSWORD=admin-only-for-the-test",
    "-e",
    "POSTGRES_INITDB_ARGS=--locale=C --encoding=UTF8",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,mode=0700,uid=70,gid=70",
    "--entrypoint",
    "/bin/sh",
    "-v",
    `${join(deploy, "pg_hba.conf")}:/etc/postgresql/pg_hba.conf:ro`,
    "-v",
    `${join(deploy, "pg-tls-entrypoint.sh")}:/usr/local/bin/pg-tls-entrypoint.sh:ro`,
    "-v",
    `${join(directory, "tls", "postgres")}:/etc/postgresql/tls:ro`,
    "-p",
    "127.0.0.1::5432",
    image,
    "/usr/local/bin/pg-tls-entrypoint.sh",
    "postgres",
    "-c",
    "ssl=on",
    "-c",
    "ssl_cert_file=/run/pg-tls/server.crt",
    "-c",
    "ssl_key_file=/run/pg-tls/server.key",
    "-c",
    "hba_file=/etc/postgresql/pg_hba.conf",
    "-c",
    "password_encryption=scram-sha-256",
  ]);
  port = Number(
    /:(\d+)\s*$/u.exec(
      (await docker(["port", name, "5432/tcp"])).stdout.trim().split("\n")[0] ?? "",
    )?.[1],
  );
  // The entrypoint's temporary initdb server listens on the socket only; wait for the real one.
  await eventually(
    async () =>
      (
        await docker([
          "exec",
          name,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "postgres",
          "-d",
          "postgres",
        ]).catch(() => ({ stdout: "" }))
      ).stdout,
    (output) => output.includes("accepting connections"),
    90_000,
  );
  // The `local` hba line trusts the container's own socket, which is how the role is provisioned.
  for (const statement of [
    `CREATE ROLE ${roleName} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`,
    `CREATE DATABASE tmtls OWNER ${roleName} TEMPLATE template0 LOCALE 'C' ENCODING 'UTF8'`,
  ])
    await docker(["exec", name, "psql", "-U", "postgres", "-d", "postgres", "-c", statement]);
}, 300_000);

afterAll(async () => {
  await docker(["rm", "-f", name]).catch(() => undefined);
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("SEC-036 PostgreSQL accepts a verify-full client that trusts its CA over TLS", () => {
  const database = open({ caFile: join(directory, "tls", "ca.crt") });
  try {
    expect(database.get("SELECT current_user AS who")?.who).toBe(roleName);
    // The connection really is TLS: pg_stat_ssl reports it for this backend.
    expect(database.get("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()")?.ssl).toBe(true);
  } finally {
    database.close();
  }
});

it("SEC-036 PostgreSQL refuses a client that trusts a different CA, and a plaintext client", () => {
  expect(() => open({ caFile: join(directory, "other-tls", "ca.crt") })).toThrow();
  // hostssl-only pg_hba.conf: a plaintext connection matches no rule and is rejected.
  expect(() => open({ caFile: join(directory, "tls", "ca.crt"), sslmode: "disable" })).toThrow();
});
