import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { PersistenceDatabase } from "@testmaster/persistence";
import { createTestDatabase, type TestDatabase } from "@testmaster/persistence/testing";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

const cleanups: (() => Promise<void> | void)[] = [];
const originalExitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExitCode;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const password = "correct horse battery staple";
/** The fields of the `/v1` envelope these tests read. */
interface Envelope {
  data: {
    ownerRecoveryToken?: string;
    token?: string;
    recoveryToken?: string;
    address?: string;
    membership?: { role: string };
  };
  error?: { code: string; details?: { reason?: string } };
}

async function deployment(): Promise<{ path: string; database: TestDatabase }> {
  const database = await createTestDatabase();
  cleanups.push(() => database.drop());
  const root = await mkdtemp(join(tmpdir(), "tm-cli-server-pg-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "server.json");
  await writeFile(
    path,
    JSON.stringify({
      mode: "server",
      database: { engine: "postgres", ...database.config },
      storage: { kind: "filesystem", root: join(root, "evidence") },
      server: {
        listen: { host: "127.0.0.1", port: 0 },
        publicOrigin: "https://tm.example",
        trustedProxies: ["127.0.0.1"],
        origins: ["https://tm.example"],
      },
      security: {
        masterKeyFile: join(root, "master.key"),
        backupKeyFile: join(root, "backup.key"),
        atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
      },
    }),
  );
  await chmod(path, 0o600);
  return { path, database };
}
function sink(append: (text: string) => void): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      append(String(chunk));
      callback();
    },
  });
}
async function invoke(args: string[]) {
  let stdout = "";
  await runCli(
    ["--json", ...args],
    new Runtime(
      sink((text) => {
        stdout += text;
      }),
      sink(() => {}),
    ),
  );
  return { exit: process.exitCode, data: JSON.parse(stdout) as Envelope };
}

it("ADR-017 bootstraps once, mints operator and recovery tokens, and serves sign-in over a CLI-started server", async () => {
  const { path } = await deployment();
  const boot = await invoke([
    "server",
    "bootstrap",
    "--config",
    path,
    "--workspace-name",
    "Acme",
    "--owner-login",
    "acme-owner",
  ]);
  expect(boot.data.data.ownerRecoveryToken).toMatch(/^tm_rec_/);
  const again = await invoke([
    "server",
    "bootstrap",
    "--config",
    path,
    "--workspace-name",
    "Acme",
    "--owner-login",
    "other-owner",
  ]);
  expect(again.data.error).toMatchObject({ code: "PRECONDITION_FAILED" });
  const operator = await invoke(["server", "operator-token", "--config", path]);
  expect(operator.data.data.token).toMatch(/^tm_op_/);
  const recovery = await invoke([
    "identity",
    "recovery-token",
    "--config",
    path,
    "--login",
    "acme-owner",
  ]);
  expect(recovery.data.data.recoveryToken).toMatch(/^tm_rec_/);
  const unknown = await invoke([
    "identity",
    "recovery-token",
    "--config",
    path,
    "--login",
    "ghost",
  ]);
  expect(unknown.data.error).toMatchObject({ code: "NOT_FOUND" });

  // Start the server from the CLI and use it as a browser behind the trusted proxy.
  let stdout = "";
  let stopped: Promise<unknown> = Promise.resolve();
  const listening = new Promise<void>((resolve) => {
    const runtime = new Runtime(
      sink((text) => {
        stdout += text;
        if (stdout.includes("address")) resolve();
      }),
      sink(() => {}),
    );
    cleanups.push(async () => {
      runtime.interrupt("SIGTERM");
      await stopped;
    });
    stopped = runCli(["--json", "server", "start", "--mode", "server", "--config", path], runtime);
  });
  await listening;
  const address = String((JSON.parse(stdout.split("\n")[0] as string) as Envelope).data.address);
  const secure = { "x-forwarded-proto": "https", "content-type": "application/json" };
  const write = () => ({ ...secure, "idempotency-key": randomUUID() });
  expect((await fetch(`${address}/v1/health/live`)).status).toBe(200);
  const plain = await fetch(`${address}/v1/me`);
  expect(plain.status).toBe(403);
  expect(((await plain.json()) as Envelope).error?.details?.reason).toBe("tls_required");
  const recovered = await fetch(`${address}/v1/identity/recovery`, {
    method: "POST",
    headers: write(),
    body: JSON.stringify({
      principal: "acme-owner",
      recoveryToken: recovery.data.data.recoveryToken,
      newPassword: password,
    }),
  });
  expect(recovered.status).toBe(200);
  const login = await fetch(`${address}/v1/identity/login`, {
    method: "POST",
    headers: { ...write(), origin: "https://tm.example" },
    body: JSON.stringify({ principal: "acme-owner", password }),
  });
  expect(login.status).toBe(200);
  const cookie = String(login.headers.get("set-cookie")).split(";")[0] as string;
  const me = await fetch(`${address}/v1/me`, { headers: { ...secure, cookie } });
  expect(((await me.json()) as Envelope).data.membership?.role).toBe("org_owner");
  expect((await fetch(`${address}/v1/me`, { headers: secure })).status).toBe(401);
});

it("ADR-017 runs one worker loop per workspace under worker start --mode server", async () => {
  const { path, database } = await deployment();
  await invoke([
    "server",
    "bootstrap",
    "--config",
    path,
    "--workspace-name",
    "Acme",
    "--owner-login",
    "acme-owner",
  ]);
  const runtime = new Runtime(
    sink(() => {}),
    sink(() => {}),
  );
  const stopped = runCli(
    ["--json", "worker", "start", "--mode", "server", "--config", path],
    runtime,
  );
  const observer = PersistenceDatabase.openPostgres(database.config);
  cleanups.push(() => observer.close());
  await vi.waitFor(
    () => {
      expect(observer.get("SELECT state FROM workers WHERE state='ready'")?.state).toBe("ready");
    },
    { timeout: 20000, interval: 200 },
  );
  runtime.interrupt("SIGTERM");
  await stopped;
  expect(observer.get("SELECT COUNT(*) AS n FROM workers WHERE state='ready'")?.n).toBe(0);
});
