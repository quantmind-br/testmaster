import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

const roots: string[] = [];
const originalExitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExitCode;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function invoke(args: string[]) {
  let stdout = "";
  const sink = (append: (text: string) => void) =>
    new Writable({
      write(chunk, _encoding, callback) {
        append(String(chunk));
        callback();
      },
    });
  await runCli(
    ["--json", ...args],
    new Runtime(
      sink((text) => {
        stdout += text;
      }),
      sink(() => {}),
    ),
  );
  return { exit: process.exitCode, document: JSON.parse(stdout) as Record<string, unknown> };
}
const deployment = (storage: unknown) => ({
  mode: "server",
  database: { engine: "postgres", url: "postgres://testmaster@127.0.0.1:5432/testmaster" },
  storage,
  server: {
    listen: { host: "127.0.0.1", port: 0 },
    publicOrigin: "https://tm.example",
    trustedProxies: ["127.0.0.1"],
    origins: ["https://tm.example"],
  },
  security: {
    masterKeyFile: "/etc/testmaster/master.key",
    backupKeyFile: "/etc/testmaster/backup.key",
    atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
  },
});
async function configFile(storage?: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tm-cli-server-"));
  roots.push(root);
  const path = join(root, "server.json");
  await writeFile(
    path,
    JSON.stringify(deployment(storage ?? { kind: "filesystem", root: join(root, "evidence") })),
    { mode: 0o600 },
  );
  return path;
}

it("ADR-016 the server commands need the deployment file named by --config", async () => {
  for (const args of [
    ["server", "start", "--mode", "server"],
    ["server", "bootstrap", "--workspace-name", "Acme", "--owner-login", "owner-one"],
    ["server", "operator-token"],
    ["identity", "recovery-token", "--login", "owner-one"],
    ["worker", "start", "--mode", "server"],
  ]) {
    const result = await invoke(args);
    expect(result.exit, args.join(" ")).toBe(5);
    expect(result.document.error, args.join(" ")).toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "--config is required",
    });
  }
});

it("ADR-016 the CLI refuses S3 storage before it touches any database", async () => {
  const path = await configFile({ kind: "s3" });
  for (const args of [
    ["server", "start", "--mode", "server"],
    ["server", "operator-token"],
    ["worker", "start", "--mode", "server"],
  ]) {
    const result = await invoke([...args, "--config", path]);
    expect(result.document.error, args.join(" ")).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      details: { capability: "s3-storage", milestone: "M5" },
    });
  }
});

it("ADR-017 the identity commands reject a missing login and a group-readable deployment file", async () => {
  const path = await configFile();
  const missing = await invoke(["identity", "recovery-token", "--config", path]);
  expect(missing.document.error).toMatchObject({
    code: "INVALID_ARGUMENT",
    message: "--login is required",
  });
  const loose = await configFile();
  await chmod(loose, 0o644);
  const refused = await invoke(["server", "operator-token", "--config", loose]);
  expect(refused.document.error).toMatchObject({ code: "POLICY_DENIED" });
});
