import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

const cleanups: (() => Promise<void> | void)[] = [];
const originalExitCode = process.exitCode;
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
  process.exitCode = undefined;
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
  const document: { data?: unknown; error?: unknown } = JSON.parse(stdout);
  return { stderr, exit: process.exitCode, document };
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "tm-cli-env-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "home"));
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "home", ".config"));
  const base = ["--cwd", root];
  expect((await invoke([...base, "init", "--name", "shop"])).exit ?? 0).toBe(0);
  return base;
}

interface EnvironmentData {
  id: string;
  version: number;
}
function isEnvironment(value: unknown): value is EnvironmentData {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "version" in value &&
    typeof value.version === "number"
  );
}
function environmentOf(result: { document: { data?: unknown; error?: unknown } }): EnvironmentData {
  const data = result.document.data;
  if (!isEnvironment(data))
    throw new Error(
      `The command did not return an environment: ${JSON.stringify(result.document)}`,
    );
  return data;
}
/** `additionalOrigins` of every revision of the environment, newest first. */
async function revisionOrigins(base: string[], id: string): Promise<string[][]> {
  const listed = (await invoke([...base, "env", "revisions", id])).document.data;
  if (!Array.isArray(listed)) throw new Error("env revisions did not return a list");
  return listed.map((revision) => revision.additionalOrigins);
}

it("env create and update manage exact additional origins, and env revisions lists them", async () => {
  const base = await workspace();
  const created = await invoke([
    ...base,
    "env",
    "create",
    "--name",
    "staging",
    "--base-url",
    "https://app.example.test",
    "--network-profile",
    "public",
    "--additional-origin",
    "https://flagcdn.com",
    "--additional-origin",
    "https://fonts.example.test",
  ]);
  expect(created.exit ?? 0).toBe(0);
  const environment = environmentOf(created);
  expect(await revisionOrigins(base, environment.id)).toEqual([
    ["https://flagcdn.com", "https://fonts.example.test"],
  ]);

  const update = async (current: EnvironmentData, ...flags: string[]) => {
    const result = await invoke([
      ...base,
      "env",
      "update",
      environment.id,
      "--expected-version",
      String(current.version),
      ...flags,
    ]);
    expect(result.exit ?? 0).toBe(0);
    return environmentOf(result);
  };
  // The flag replaces the list.
  const replaced = await update(environment, "--additional-origin", "https://cdn.example.test");
  // Omitting the flag keeps the list.
  const relocalized = await update(replaced, "--locale", "pt-BR");
  await update(relocalized, "--clear-additional-origins");

  expect(await revisionOrigins(base, environment.id)).toEqual([
    [],
    ["https://cdn.example.test"],
    ["https://cdn.example.test"],
    ["https://flagcdn.com", "https://fonts.example.test"],
  ]);
});

it("env update refuses combining --additional-origin with --clear-additional-origins and invalid origins", async () => {
  const base = await workspace();
  const created = await invoke([
    ...base,
    "env",
    "create",
    "--name",
    "staging",
    "--base-url",
    "https://app.example.test",
    "--network-profile",
    "public",
  ]);
  const environment = environmentOf(created);
  expect(await revisionOrigins(base, environment.id)).toEqual([[]]);
  for (const flags of [
    ["--additional-origin", "https://flagcdn.com", "--clear-additional-origins"],
    ["--additional-origin", "https://flagcdn.com/assets"],
    ["--additional-origin", "https://*.example.test"],
  ]) {
    const result = await invoke([
      ...base,
      "env",
      "update",
      environment.id,
      "--expected-version",
      String(environment.version),
      ...flags,
    ]);
    expect(result.exit).not.toBe(0);
    expect(result.document.error).toMatchObject({ code: "INVALID_ARGUMENT" });
  }
  expect(await revisionOrigins(base, environment.id)).toEqual([[]]);
  expect(environmentOf(await invoke([...base, "env", "get", environment.id])).version).toBe(
    environment.version,
  );
});
