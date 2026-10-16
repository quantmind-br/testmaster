import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { lintPlan, scaffoldPlan } from "@testmaster/application";
import { validate } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

interface Document {
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}
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

async function invoke(args: string[], format: "--json" | "--output=text" = "--json") {
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
    [format, ...args],
    new Runtime(
      sink((text) => {
        stdout += text;
      }),
      sink((text) => {
        stderr += text;
      }),
    ),
  );
  return {
    stdout,
    stderr,
    exit: process.exitCode ?? 0,
    document: (format === "--json" ? JSON.parse(stdout) : {}) as Document,
  };
}
async function emptyRoot() {
  const root = await mkdtemp(join(tmpdir(), "tm-cli-dry-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "home"));
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "home", ".config"));
  return root;
}
async function project() {
  const root = await emptyRoot();
  const base = ["--cwd", root];
  const created = await invoke([...base, "init", "--name", "shop"]);
  expect(created.exit).toBe(0);
  return { root, base };
}
const requirementId = uuidV7IdGenerator.next("req");

it("REQ-029 requirement approve --dry-run reports the operation it would perform and creates no state", async () => {
  const root = await emptyRoot();
  const result = await invoke([
    "--cwd",
    root,
    "--dry-run",
    "requirement",
    "approve",
    requirementId,
    "--expected-version",
    "3",
  ]);
  expect(result.exit).toBe(0);
  expect(result.document.data).toMatchObject({
    dryRun: true,
    validated: true,
    operations: [
      {
        operation: "requirement.approve",
        requirementId,
        expectedVersion: 3,
        resultingVersion: 4,
      },
    ],
  });
  expect(result.document.data?.unresolvedPreconditions).toEqual(
    expect.arrayContaining([expect.stringContaining("version 3")]),
  );
  expect(await readdir(root)).toEqual(["home"]);
});

it("REQ-029 plan generate --dry-run validates its selection, reports the paid operation and sends nothing", async () => {
  const root = await emptyRoot();
  const valid = await invoke([
    "--cwd",
    root,
    "--dry-run",
    "plan",
    "generate",
    "--type",
    "auto",
    "--requirement",
    requirementId,
    "--model",
    "m1",
    "--provider",
    "p1",
  ]);
  expect(valid.exit).toBe(0);
  expect(valid.document.data).toMatchObject({
    dryRun: true,
    validated: true,
    operations: [
      {
        operation: "proposals.generate",
        type: "auto",
        requirements: [requirementId],
        model: "p1/m1",
        costsModelBudget: true,
      },
    ],
  });
  expect(await readdir(root)).toEqual(["home"]);
  // The same flags with a duplicated requirement are refused, and the verdict says so.
  const invalid = await invoke([
    "--cwd",
    root,
    "--dry-run",
    "plan",
    "generate",
    "--requirement",
    requirementId,
    "--requirement",
    requirementId,
  ]);
  expect(invalid.exit).toBe(5);
  expect(invalid.document.error?.code).toBe("INVALID_ARGUMENT");
  expect(invalid.document.data).toMatchObject({ dryRun: true, validated: false, operations: [] });
  expect(await readdir(root)).toEqual(["home"]);
});

it("REQ-029 a command with no local validation answers validated false instead of claiming a check", async () => {
  const root = await emptyRoot();
  const result = await invoke(["--cwd", root, "--dry-run", "source", "list"]);
  expect(result.exit).toBe(0);
  expect(result.document.data).toMatchObject({
    dryRun: true,
    validated: false,
    operations: [],
    unresolvedPreconditions: [expect.stringContaining("no local dry-run validation")],
  });
  expect(await readdir(root)).toEqual(["home"]);
});

it("REQ-029 a command that declares its own --dry-run option implements it instead of the global receipt", async () => {
  const { base } = await project();
  const result = await invoke([...base, "worker", "reconcile", "--dry-run"]);
  expect(result.exit).toBe(0);
  expect(result.document.data).toMatchObject({ dryRun: true });
  expect(result.document.data).not.toHaveProperty("validated");
});

it("M8 source add stores an OpenAPI 3.2 document as ready and carries QUERY and additional operations", async () => {
  const { root, base } = await project();
  await writeFile(
    join(root, "api32.json"),
    JSON.stringify({
      openapi: "3.2.0",
      info: { title: "T", version: "1" },
      paths: {
        "/events": {
          get: {
            responses: {
              "200": {
                description: "Stream",
                content: { "application/jsonl": { itemSchema: { type: "object" } } },
              },
            },
          },
          query: { responses: { "200": { description: "ok" } } },
        },
      },
    }),
  );
  const result = await invoke([
    ...base,
    "source",
    "add",
    "api32.json",
    "--role",
    "api-spec",
    "--format",
    "openapi",
  ]);
  expect(result.exit).toBe(0);
  expect(result.document.data).toMatchObject({ revision: { status: "ready" } });
});

it("M8 source add exits 5 with the diagnostics when the source ends invalid", async () => {
  const { root, base } = await project();
  await writeFile(
    join(root, "api33.json"),
    JSON.stringify({ openapi: "3.3.0", info: { title: "T", version: "1" }, paths: {} }),
  );
  const args = [
    ...base,
    "source",
    "add",
    "api33.json",
    "--role",
    "api-spec",
    "--format",
    "openapi",
  ];
  const json = await invoke(args);
  expect(json.exit).toBe(5);
  expect(json.document.error?.code).toBe("INVALID_ARGUMENT");
  expect(json.document.error?.details).toMatchObject({
    reasonCode: "unsupported_openapi",
    status: "invalid",
    diagnostics: [{ code: "unsupported_openapi" }],
  });
  process.exitCode = originalExitCode;
  const text = await invoke(args, "--output=text");
  expect(text.exit).toBe(5);
  expect(text.stderr).toContain("INVALID_ARGUMENT");
  expect(text.stderr).toContain("unsupported_openapi: ");
});

it("test lint in text output names the path, message and rule of each plan issue", async () => {
  const root = await emptyRoot();
  const { requirementRefs: _dropped, ...plan } = scaffoldPlan("backend");
  await writeFile(join(root, "plan.json"), JSON.stringify(plan));
  const args = ["--cwd", root, "test", "lint", "--plan", "plan.json"];
  const json = await invoke(args);
  expect(json.exit).toBe(5);
  expect(json.document.error?.details?.issues).toEqual([
    { path: "", rule: "required", message: "must have required property 'requirementRefs'" },
  ]);
  process.exitCode = originalExitCode;
  const text = await invoke(args, "--output=text");
  expect(text.exit).toBe(5);
  expect(text.stderr).toBe(
    "INVALID_ARGUMENT: Invalid ExecutablePlan\n  /: must have required property 'requirementRefs' (required)\n",
  );
});

it("m1 test export lists the format choices and names the --out rule when it refuses a destination", async () => {
  const { root, base } = await project();
  const help = await invoke([...base, "test", "export", "--help"]);
  const text = String(help.document.data?.help).replace(/\s+/gu, " ");
  expect(text).toContain('choices: "playwright", "pytest"');
  expect(text).toContain("inside the workspace");
  process.exitCode = originalExitCode;
  await writeFile(join(root, "plan.json"), JSON.stringify(scaffoldPlan("backend")));
  const created = await invoke([...base, "test", "create", "--plan", "plan.json"]);
  const testId = String(created.document.data?.id);
  process.exitCode = originalExitCode;
  const refused = await invoke([
    ...base,
    "test",
    "export",
    testId,
    "--format",
    "playwright",
    "--out",
    "../outside",
  ]);
  expect(refused.exit).toBe(5);
  expect(refused.document.error?.message).toContain("inside the workspace");
});
it("m2 --example answers before required options are checked and prints a complete input contract", async () => {
  const root = await emptyRoot();
  const result = await invoke(["--cwd", root, "requirement", "approve", "--example"]);
  expect(result.exit).toBe(0);
  expect(result.document.data).toMatchObject({
    example: true,
    dryRun: false,
    command: "requirement approve",
    fixture: {
      usage: expect.stringContaining("testmaster requirement approve"),
      arguments: [{ name: "id", required: true }],
      options: expect.arrayContaining([
        expect.objectContaining({ flags: "--expected-version <version>", required: true }),
      ]),
    },
  });
  expect(await readdir(root)).toEqual(["home"]);
});

it("m7 auth-profile create --example prints a file that parses as AuthProfileInput", async () => {
  const root = await emptyRoot();
  const result = await invoke(["--cwd", root, "auth-profile", "create", "--example"]);
  expect(result.exit).toBe(0);
  const fixture = result.document.data?.fixture as {
    input: { option: string; format: string; content: Record<string, unknown> };
  };
  expect(fixture.input.option).toBe("--file");
  const projectId = uuidV7IdGenerator.next("prj");
  expect(() => validate("AuthProfileInput", { ...fixture.input.content, projectId })).not.toThrow();
  expect(fixture.input.content).toMatchObject({
    kind: "form",
    config: {
      http: { contentType: "json", success: { cookieNames: ["session"] } },
    },
  });
  // The same file is accepted by the dry-run of the command that reads it.
  await writeFile(join(root, "profile.json"), JSON.stringify(fixture.input.content));
  const dry = await invoke([
    "--cwd",
    root,
    "--dry-run",
    "auth-profile",
    "create",
    "--file",
    "profile.json",
  ]);
  expect(dry.document.data).toMatchObject({ dryRun: true, validated: true });
});

it("m2 --example for a plan command prints a plan that lints", async () => {
  const root = await emptyRoot();
  const result = await invoke(["--cwd", root, "test", "create", "--example"]);
  const fixture = result.document.data?.fixture as { input: { content: unknown } };
  expect(() => lintPlan(JSON.stringify(fixture.input.content))).not.toThrow();
});

it("m4 discover prints a bounded receipt, --full prints everything, and partial features carry a reason", async () => {
  const { root, base } = await project();
  const repo = join(root, "repo");
  await mkdir(repo);
  await writeFile(
    join(repo, "server.ts"),
    "import express from 'express'; const app = express(); app.get('/health', (req,res) => res.json({ok:true}));",
  );
  for (let index = 0; index < 60; index++)
    await writeFile(join(repo, `key-${index}.pem`), "-----BEGIN PRIVATE KEY-----");
  const receipt = await invoke([...base, "discover", "--root", "repo"]);
  expect(receipt.exit).toBe(0);
  const data = receipt.document.data as Record<string, unknown> & {
    skippedFiles: unknown[];
    featureStatuses: Array<{ status: string; errors: string[] }>;
  };
  expect(data.skippedFileCount).toBe(60);
  expect(data.skippedFiles).toHaveLength(50);
  expect(data.omittedSkippedFiles).toBe(10);
  expect(data).not.toHaveProperty("summary");
  expect(data.featureStatuses.length).toBeGreaterThan(0);
  for (const entry of data.featureStatuses) {
    expect(["partial", "needs_input"]).toContain(entry.status);
    expect(entry.errors.length).toBeGreaterThan(0);
  }
  process.exitCode = originalExitCode;
  const full = await invoke([...base, "discover", "--root", "repo", "--full"]);
  const detail = full.document.data as {
    codeSnapshot: { skippedFiles: unknown[] };
    summary: unknown;
  };
  expect(detail.codeSnapshot.skippedFiles).toHaveLength(60);
  expect(detail.summary).toBeDefined();
});
