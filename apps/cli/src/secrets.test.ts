import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Application } from "@testmaster/application";
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
  const cwd = await mkdtemp(join(tmpdir(), "tm-cli-secret-"));
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
    const sink = new Writable({
      write(chunk, _encoding, done) {
        stdout += String(chunk);
        done();
      },
    });
    const runtime = new Runtime(sink, sink);
    runtime.app = async () => app;
    process.exitCode = 0;
    await runCli(["--json", "--cwd", cwd, ...args], runtime);
    const document = JSON.parse(stdout) as { data?: { id: string }; error?: { code: string } };
    return { exit: process.exitCode ?? 0, document };
  };
  const stored = async (name: string): Promise<string> =>
    (await app.secrets.release(name)).resolve();
  return { app, cwd, invoke, stored };
}

const origin = "https://app.example.test";

it("secret set --file and rotate --file drop exactly one trailing line terminator", async () => {
  const { cwd, invoke, stored } = await fixture();
  await writeFile(join(cwd, "lf.txt"), "hunter2-password\n");
  await writeFile(join(cwd, "crlf.txt"), "crlf-password\r\n");
  await writeFile(join(cwd, "inner.txt"), "line-one\nline-two\n\n");
  await writeFile(join(cwd, "bare.txt"), "no-terminator");

  const set = async (name: string, file: string) => {
    const result = await invoke("secret", "set", name, "--file", file, "--allowed-origin", origin);
    expect(result.exit).toBe(0);
  };
  await set("lf", "lf.txt");
  await set("crlf", "crlf.txt");
  await set("inner", "inner.txt");
  await set("bare", "bare.txt");
  expect(await stored("lf")).toBe("hunter2-password");
  expect(await stored("crlf")).toBe("crlf-password");
  // An inner newline is part of the value; only the last terminator is removed.
  expect(await stored("inner")).toBe("line-one\nline-two\n");
  // Positive control: a file without a terminator is stored unchanged.
  expect(await stored("bare")).toBe("no-terminator");

  await writeFile(join(cwd, "next.txt"), "rotated-password\n");
  const rotated = await invoke("secret", "rotate", "lf", "--file", "next.txt");
  expect(rotated.exit).toBe(0);
  expect(await stored("lf")).toBe("rotated-password");
});
