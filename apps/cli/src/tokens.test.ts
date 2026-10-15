import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Application, authenticateBearer } from "@testmaster/application";
import { afterEach, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

const cleanups: (() => Promise<void>)[] = [];
const originalExit = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExit;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-cli-token-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const app = await Application.open({ cwd, home, env: {} });
  cleanups.push(async () => {
    app.close();
    await rm(cwd, { recursive: true, force: true });
  });
  await app.init();
  const invoke = async (...args: string[]) => {
    let stdout = "";
    let stderr = "";
    const sink = (append: (text: string) => void) =>
      new Writable({
        write(chunk, _encoding, done) {
          append(String(chunk));
          done();
        },
      });
    const runtime = new Runtime(
      sink((text) => {
        stdout += text;
      }),
      sink((text) => {
        stderr += text;
      }),
    );
    runtime.app = async () => app;
    process.exitCode = 0;
    await runCli(["--json", "--cwd", cwd, ...args], runtime);
    const document = JSON.parse(stdout) as {
      data?: { tokenPath: string; scopes: string[]; expiresAt: string };
      error?: { code: string };
    };
    return { exit: process.exitCode ?? 0, stdout, stderr, document };
  };
  return { app, cwd, invoke };
}

it("token issue mints a private token file, reuses it and never prints the token", async () => {
  const { app, cwd, invoke } = await fixture();
  const tokenPath = join(cwd, "agent.token");
  const issued = await invoke("token", "issue", "--token-file", "agent.token");
  expect(issued.exit).toBe(0);
  expect(issued.document.data).toMatchObject({ tokenPath, scopes: ["R", "W", "X"] });
  expect(Number.isFinite(Date.parse(issued.document.data?.expiresAt ?? ""))).toBe(true);
  expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
  const token = (await readFile(tokenPath, "utf8")).trim();
  expect(token.length).toBeGreaterThan(16);
  expect(`${issued.stdout}${issued.stderr}`).not.toContain(token);
  // The stored record authenticates with exactly the requested scopes: no implicit admin.
  expect(authenticateBearer(app, token).scopes).toEqual(["R", "W", "X"]);

  const again = await invoke("token", "issue", "--token-file", "agent.token");
  expect(again.exit).toBe(0);
  expect(again.document.data?.expiresAt).toBe(issued.document.data?.expiresAt);
  expect((await readFile(tokenPath, "utf8")).trim()).toBe(token);
});

it("token issue honors repeated --scope and refuses a token file with different scopes", async () => {
  const { app, cwd, invoke } = await fixture();
  const admin = await invoke(
    "token",
    "issue",
    "--token-file",
    "admin.token",
    "--scope",
    "A",
    "--scope",
    "R",
  );
  expect(admin.exit).toBe(0);
  expect(admin.document.data?.scopes).toEqual(["R", "A"]);
  const adminToken = (await readFile(join(cwd, "admin.token"), "utf8")).trim();
  expect(authenticateBearer(app, adminToken).scopes).toEqual(["R", "A"]);

  const mismatch = await invoke("token", "issue", "--token-file", "admin.token");
  expect(mismatch.exit).toBe(6);
  expect(mismatch.document.error?.code).toBe("PRECONDITION_FAILED");
  // The refusal leaves the existing token untouched and does not print it.
  expect((await readFile(join(cwd, "admin.token"), "utf8")).trim()).toBe(adminToken);
  expect(`${mismatch.stdout}${mismatch.stderr}`).not.toContain(adminToken);
});

it("token issue requires --token-file and a valid scope", async () => {
  const { cwd, invoke } = await fixture();
  const missing = await invoke("token", "issue");
  expect(missing.exit).toBe(5);
  expect(missing.document.error?.code).toBe("INVALID_ARGUMENT");
  // The message names the flag as typed, not the camelCase option key.
  expect(missing.stdout).toContain("--token-file is required");
  expect(missing.stdout).not.toContain("--tokenFile");
  const invalid = await invoke("token", "issue", "--token-file", "x.token", "--scope", "Z");
  expect(invalid.exit).toBe(5);
  expect(invalid.document.error?.code).toBe("INVALID_ARGUMENT");
  await expect(stat(join(cwd, "x.token"))).rejects.toThrow();
});
