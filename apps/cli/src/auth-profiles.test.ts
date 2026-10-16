import type * as ChildProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

// Hermetic: the encrypted file vault, never the host keyring.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: vi.fn(() => {
    throw Object.assign(new Error("Unavailable"), { code: "ENOENT" });
  }),
}));

const cleanups: (() => Promise<void> | void)[] = [];
const originalExitCode = process.exitCode;
const targetPassword = "cli-target-password-canary-5521";
beforeEach(() => {
  vi.stubEnv("CI", "true");
});
afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function invoke(args: string[]) {
  let stdout = "";
  let stderr = "";
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
      sink((text) => {
        stderr += text;
      }),
    ),
  );
  const exit = process.exitCode;
  return {
    stdout,
    stderr,
    exit,
    document: JSON.parse(stdout) as { data?: Record<string, unknown> & unknown; error?: unknown },
  };
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "tm-cli-auth-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "home"));
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "home", ".config"));
  const site: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        password?: string;
      };
      if (request.url === "/api/login" && body.password === targetPassword) {
        response.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "session=cli-issued-session-value; Path=/",
        });
        response.end("{}");
        return;
      }
      response.writeHead(401).end("{}");
    });
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => site.close(() => resolve())));
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const base = ["--cwd", root];
  const created = await invoke([...base, "init", "--name", "shop"]);
  expect(created.exit ?? 0).toBe(0);
  return { root, url, base };
}

it("REQ-018 SEC-023 M4-03 the CLI creates a profile, signs in and never prints a credential", async () => {
  const { root, url, base } = await workspace();
  vi.stubEnv("TM_TEST_USER", "alice");
  vi.stubEnv("TM_TEST_PASS", targetPassword);
  const user = await invoke([
    ...base,
    "secret",
    "set",
    "site-user",
    "--from-env",
    "TM_TEST_USER",
    "--allowed-origin",
    url,
  ]);
  const pass = await invoke([
    ...base,
    "secret",
    "set",
    "site-pass",
    "--from-env",
    "TM_TEST_PASS",
    "--allowed-origin",
    url,
  ]);
  const file = join(root, "profile.json");
  await writeFile(
    file,
    JSON.stringify({
      name: "site-login",
      kind: "form",
      originBindings: [url],
      secrets: { username: user.document.data?.id, password: pass.document.data?.id },
      config: {
        http: {
          loginUrl: `${url}/api/login`,
          contentType: "json",
          fields: { username: "username", password: "password" },
          success: { statusIn: [200], cookieNames: ["session"] },
        },
      },
    }),
  );
  const created = await invoke([...base, "auth-profile", "create", "--file", file]);
  expect(created.exit ?? 0).toBe(0);
  const id = String(created.document.data?.id);
  const environment = await invoke([
    ...base,
    "env",
    "create",
    "--name",
    "authenticated",
    "--base-url",
    url,
    "--network-profile",
    "local-loopback",
    "--auth-ref",
    id,
  ]);
  expect(environment.exit ?? 0).toBe(0);
  const tested = await invoke([
    ...base,
    "auth-profile",
    "test-login",
    id,
    "--environment",
    String(environment.document.data?.id),
  ]);
  expect(tested.document.data).toMatchObject({ outcome: "authenticated", draftsChanged: false });
  const shown = await invoke([...base, "auth-profile", "get", id]);
  expect(shown.document.data).toMatchObject({ session: { state: "authenticated" } });
  const revoked = await invoke([...base, "auth-profile", "revoke-session", id]);
  expect(revoked.exit ?? 0).toBe(0);
  const after = await invoke([...base, "auth-profile", "get", id]);
  expect(after.document.data).toMatchObject({ session: { state: "revoked" } });
  for (const result of [user, pass, created, environment, tested, shown, revoked, after]) {
    for (const canary of [targetPassword, "cli-issued-session-value", "alice"])
      expect(result.stdout + result.stderr).not.toContain(canary);
  }
  // Negative control: an unknown profile is not found and prints nothing sensitive.
  const missing = await invoke([
    ...base,
    "auth-profile",
    "get",
    "aup_00000000-0000-4000-8000-000000000000",
  ]);
  expect(missing.exit).not.toBe(0);
  expect(missing.document.error).toMatchObject({ code: "NOT_FOUND" });
});

it("SEC-022 the CLI exports a storage state only to a new private file and keeps it out of the output", async () => {
  const { root, url, base } = await workspace();
  const hostname = new URL(url).hostname;
  const statePath = join(root, "captured.json");
  await writeFile(
    statePath,
    JSON.stringify({
      cookies: [{ name: "session", value: "cli-export-cookie", domain: hostname, path: "/" }],
      origins: [],
    }),
  );
  const created = await invoke([
    ...base,
    "auth-profile",
    "create",
    "--file",
    await (async () => {
      const file = join(root, "manual.json");
      await writeFile(
        file,
        JSON.stringify({
          name: "manual-site",
          kind: "manual",
          originBindings: [url],
          secrets: {},
          config: { challenge: { kind: "captcha", resolution: "storage-state" } },
        }),
      );
      return file;
    })(),
  ]);
  const id = String(created.document.data?.id);
  const stored = await invoke([
    ...base,
    "secret",
    "set",
    "captured-state",
    "--file",
    statePath,
    "--allowed-origin",
    url,
  ]);
  const imported = await invoke([
    ...base,
    "auth-profile",
    "import-state",
    id,
    "--input-ref",
    String(stored.document.data?.id),
  ]);
  expect(imported.exit ?? 0).toBe(0);
  const out = join(root, "exported.json");
  const exported = await invoke([
    ...base,
    "auth-profile",
    "export-state",
    id,
    "--out",
    out,
    "--ttl",
    "120",
  ]);
  expect(exported.exit ?? 0).toBe(0);
  expect(exported.stdout).not.toContain("cli-export-cookie");
  expect(exported.document.data).toMatchObject({ sha256: expect.any(String) });
  expect((await stat(out)).mode & 0o777).toBe(0o600);
  expect(await readFile(out, "utf8")).toContain("cli-export-cookie");
  // Negative control: an existing file is never overwritten, and an unbounded lifetime is refused.
  const again = await invoke([...base, "auth-profile", "export-state", id, "--out", out]);
  expect(again.exit).not.toBe(0);
  const tooLong = await invoke([
    ...base,
    "auth-profile",
    "export-state",
    id,
    "--out",
    join(root, "long.json"),
    "--ttl",
    "901",
  ]);
  expect(tooLong.document.error).toMatchObject({ code: "INVALID_ARGUMENT" });
});

it("SEC-024 the CLI lists no checkpoints for a fresh project and validates dry runs without state", async () => {
  const { root, base } = await workspace();
  const listed = await invoke([...base, "auth-checkpoint", "list", "--state", "pending"]);
  expect(listed.document.data).toEqual([]);
  const bad = join(root, "bad.json");
  await writeFile(bad, "[]");
  const refused = await invoke([...base, "--dry-run", "auth-profile", "create", "--file", bad]);
  expect(refused.document.error).toMatchObject({ code: "INVALID_ARGUMENT" });
  const profiles = await invoke([...base, "auth-profile", "list"]);
  expect(profiles.document.data).toEqual([]);
});

it("the help of a command marks the options it cannot run without as required", async () => {
  const { base } = await workspace();
  const flat = async (args: string[]) =>
    String((await invoke([...base, ...args, "--help"])).document.data?.help).replace(/\s+/gu, " ");
  // test-login fails at call time without --environment, so its help must say so up front.
  expect(await flat(["auth-profile", "test-login"])).toContain(
    "--environment <id> Environment whose origins the login is bound to (required)",
  );
  // Negative control: the options around a required one stay unmarked.
  expect(await flat(["source", "add"])).toContain(
    "--role <role> (required) --name <name> --format <format>",
  );
});
