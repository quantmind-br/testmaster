import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Application } from "@testmaster/application";
import { postgresParity } from "@testmaster/persistence/testing";
import type { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCli, runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

interface Document {
  requestId?: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}
const cleanups: (() => Promise<void> | void)[] = [];
const originalExitCode = process.exitCode;
beforeEach(() => {
  vi.stubEnv("CI", "true");
  vi.stubEnv("TESTMASTER_API_KEY", undefined);
  vi.stubEnv("TESTMASTER_ENDPOINT", undefined);
  vi.stubEnv("TESTMASTER_PROFILE", undefined);
});
afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
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
  return { exit: process.exitCode ?? 0, document: JSON.parse(stdout) as Document, stdout };
}
async function emptyRoot() {
  const root = await mkdtemp(join(tmpdir(), "tm-cli-safety-"));
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
  expect(created.stdout).toContain('"data"');
  expect(created.exit).toBe(0);
  return { root, base };
}
/** Rows of the workspace's audit log written by CLI invocations, oldest first. */
async function cliAudit(root: string) {
  const app = await Application.open({ cwd: root });
  try {
    return app.database.all<{
      action: string;
      resource_id: string;
      request_id: string;
      actor: string;
    }>(
      "SELECT action,resource_id,request_id,actor FROM audit_events WHERE action LIKE 'cli.command.%' ORDER BY id",
    );
  } finally {
    app.close();
  }
}

it("refuses a --file path that reaches outside through a symbolic link, and a --out that would write through one", async () => {
  const { root, base } = await project();
  const outside = await mkdtemp(join(tmpdir(), "tm-cli-outside-"));
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "document.json"), "{}");
  await symlink(join(outside, "document.json"), join(root, "file-link.json"));
  await symlink(outside, join(root, "dir-link"));
  await writeFile(join(root, "plain.json"), "{}");

  const validate = (document: string) =>
    invoke([...base, "contract", "validate", "--schema", "ProjectConfig", "--document", document]);
  // Control: the same document through an ordinary path is read (the verdict is the contract's).
  const plain = await validate("plain.json");
  expect(plain.document.error?.code).not.toBe("FORBIDDEN");
  for (const path of ["file-link.json", "dir-link/document.json"]) {
    const refused = await validate(path);
    expect(refused.exit).toBe(3);
    expect(refused.document.error?.code).toBe("FORBIDDEN");
  }

  // The same refusal covers outputs: nothing is created at the link's target.
  const out = (path: string) =>
    invoke([...base, "contract", "schema", "ProjectConfig", "--out", path]);
  expect((await out("dir-link/schema.json")).document.error?.code).toBe("FORBIDDEN");
  await symlink(join(outside, "planted.json"), join(root, "dangling.json"));
  expect((await out("dangling.json")).document.error).toBeDefined();
  expect(await readdir(outside)).toEqual(["document.json"]);
  // Control: a plain new file is created, and an existing one is never replaced.
  expect((await out("schema.json")).exit).toBe(0);
  expect(JSON.parse(await readFile(join(root, "schema.json"), "utf8"))).toHaveProperty("type");
  expect((await out("schema.json")).document.error?.code).toBe("INVALID_ARGUMENT");
});

it("refuses an artifact get --out that goes through a symbolic link before the service runs", async () => {
  const { root, base } = await project();
  const outside = await mkdtemp(join(tmpdir(), "tm-cli-outside-"));
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, "link"));
  await symlink(join(outside, "planted"), join(root, "dangling"));
  // The run does not exist: the refusal is the path's, so it precedes the service's lookup.
  for (const path of ["link/evidence", "dangling"]) {
    const refused = await invoke([...base, "artifact", "get", "run_missing", "--out", path]);
    expect(refused.exit).toBe(3);
    expect(refused.document.error?.code).toBe("FORBIDDEN");
  }
  expect(await readdir(outside)).toEqual([]);
});

it("refuses a hard-linked input and a directory where a file is expected", async () => {
  const { root, base } = await project();
  await writeFile(join(root, "original.json"), "{}");
  await link(join(root, "original.json"), join(root, "second-name.json"));
  await mkdir(join(root, "folder"));
  for (const path of ["original.json", "folder"]) {
    const result = await invoke([
      ...base,
      "contract",
      "validate",
      "--schema",
      "ProjectConfig",
      "--document",
      path,
    ]);
    expect(result.document.error?.code, path).toBe("FORBIDDEN");
  }
});

it("a secret file read through a symbolic link is refused before any secret is stored", async () => {
  const { root, base } = await project();
  const outside = await mkdtemp(join(tmpdir(), "tm-cli-outside-"));
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "token"), "outside-secret\n");
  await symlink(join(outside, "token"), join(root, "token-link"));
  const refused = await invoke([
    ...base,
    "secret",
    "set",
    "api",
    "--file",
    "token-link",
    "--allowed-origin",
    "https://example.test",
  ]);
  expect(refused.document.error?.code).toBe("FORBIDDEN");
  expect((await invoke([...base, "secret", "list"])).document.data).toEqual([]);
});

interface Leaf {
  path: string[];
  command: Command;
}
function leaves(command: Command, path: string[] = []): Leaf[] {
  if (!command.commands.length) return [{ path, command }];
  return command.commands.flatMap((child) => leaves(child, [...path, child.name()]));
}
/** The smallest argument vector that satisfies commander for one command. */
function sampleArguments(leaf: Leaf): string[] {
  return [
    ...leaf.path,
    ...leaf.command.registeredArguments.map((argument) => argument.argChoices?.[0] ?? "x"),
    ...leaf.command.options
      .filter((option) => option.mandatory)
      .flatMap((option) =>
        option.isBoolean()
          ? [option.long as string]
          : [option.long as string, option.argChoices?.[0] ?? "1"],
      ),
  ];
}
/** Every row of every table, as a canonical string, for a before/after comparison. */
async function databaseDump(root: string): Promise<string> {
  const app = await Application.open({ cwd: root });
  try {
    const tables = app.database
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .map((row) => row.name);
    return JSON.stringify(
      tables.map((table) => [
        table,
        app.database
          .all(`SELECT * FROM "${table}"`)
          .map((row) => JSON.stringify(row))
          .sort(),
      ]),
    );
  } finally {
    app.close();
  }
}
async function tree(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true }))
    .filter((name) => !/-(wal|shm)$/.test(name))
    .sort();
}

it.skipIf(postgresParity)(
  "--dry-run on every command changes no row, creates no file, opens no application and calls no model",
  async () => {
    const { root } = await project();
    // The model double: a provider the workspace is configured to use, counting every request.
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.statusCode = 500;
      response.end("{}");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing provider address");
    const configDirectory = join(root, "home", ".config", "testmaster");
    await mkdir(configDirectory, { recursive: true });
    // Only the operator-owned user policy grants a provider.
    await writeFile(
      join(configDirectory, "policy.json"),
      JSON.stringify({ allowedModelProviders: ["double"] }),
    );
    await writeFile(
      join(configDirectory, "profiles.json"),
      JSON.stringify({
        defaultProfile: "double",
        profiles: {
          double: {
            modelProviders: [
              {
                id: "double",
                kind: "openai-compatible",
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                models: [
                  {
                    id: "double-model",
                    capabilities: { structuredJson: true, maxOutputTokens: 1024 },
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    // Control: this workspace does see the double as an allowed provider, so a command that did
    // call a model would reach it.
    const opened = await Application.open({ cwd: root });
    try {
      const projectId = (await opened.projects.list())[0]?.id as string;
      expect(opened.model.settings(projectId).providers).toMatchObject([
        { id: "double", allowedByProfile: true, models: ["double-model"] },
      ]);
    } finally {
      opened.close();
    }
    const dumpBefore = await databaseDump(root);
    const treeBefore = await tree(root);
    const open = vi.spyOn(Application, "open");
    const all = leaves(createCli(new Runtime()));
    expect(all.length).toBeGreaterThan(100);
    const ownFlag: string[] = [];
    const answers: string[] = [];
    for (const leaf of all) {
      if (leaf.command.options.some((option) => option.long === "--dry-run"))
        ownFlag.push(leaf.path.join(" "));
      const result = await invoke(["--cwd", root, "--dry-run", ...sampleArguments(leaf)]);
      // One JSON envelope each (a refusal of the sample arguments is an answer too), never a crash.
      expect(result.document.error?.code, leaf.path.join(" ")).not.toBe("INTERNAL");
      answers.push(leaf.path.join(" "));
    }
    expect(answers).toHaveLength(all.length);
    // Only a command with its own --dry-run (it lists work without doing it) opens the workspace.
    expect(ownFlag).toEqual(["worker reconcile"]);
    expect(open).toHaveBeenCalledTimes(ownFlag.length);
    expect(requests).toEqual([]);
    expect(await tree(root)).toEqual(treeBefore);
    expect(await databaseDump(root)).toBe(dumpBefore);
  },
  120_000,
);

it.skipIf(process.getuid?.() === 0)(
  "--dry-run does not read the credential that a real invocation reads",
  async () => {
    const root = await emptyRoot();
    const configDirectory = join(root, "home", ".config", "testmaster");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, "profiles.json"),
      JSON.stringify({
        schemaVersion: "1.0.0",
        profiles: {
          remote: {
            endpoint: "http://127.0.0.1:9",
            tokenFile: "remote.token",
            principalId: "usr_00000000-0000-4000-8000-000000000000",
            workspaceId: "ws_00000000-0000-4000-8000-000000000000",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    const tokenFile = join(configDirectory, "remote.token");
    await writeFile(tokenFile, "synthetic-token\n");
    await chmod(tokenFile, 0o000);
    const args = ["--cwd", root, "--profile", "remote", "source", "list"];
    // Control: a real invocation reads the token file and, unable to, reports no credential.
    expect((await invoke(args)).document.error?.code).toBe("UNAUTHENTICATED");
    const treeBefore = await tree(root);
    const dry = await invoke(["--dry-run", ...args]);
    expect(dry.exit).toBe(0);
    expect(dry.document.data).toMatchObject({ dryRun: true, validated: false });
    expect((await stat(tokenFile)).mode & 0o777).toBe(0);
    expect(await tree(root)).toEqual(treeBefore);
  },
);

it("appends one audit record per invocation, carrying the request id of the envelope", async () => {
  const { root, base } = await project();
  await writeFile(join(root, "payload.json"), "{}");
  await symlink(join(root, "payload.json"), join(root, "payload-link.json"));
  const before = await cliAudit(root);

  const succeeded = await invoke([...base, "source", "list"]);
  const failed = await invoke([
    ...base,
    "requirement",
    "approve",
    "req_00000000-0000-4000-8000-000000000000",
    "--expected-version",
    "1",
  ]);
  const refused = await invoke([
    ...base,
    "artifact",
    "import-fixture",
    "payload-link.json",
    "--mime-type",
    "application/json",
  ]);
  expect(succeeded.exit).toBe(0);
  expect(failed.document.error?.code).toBe("NOT_FOUND");
  expect(refused.document.error?.code).toBe("FORBIDDEN");
  const dry = await invoke([...base, "--dry-run", "source", "list"]);
  const unopened = await invoke([...base, "contract", "schema", "ProjectConfig"]);

  const rows = (await cliAudit(root)).slice(before.length);
  const principal = rows[0]?.actor as string;
  expect(rows).toEqual([
    {
      action: "cli.command.completed",
      resource_id: "source list",
      request_id: succeeded.document.requestId,
      actor: principal,
    },
    {
      action: "cli.command.failed",
      resource_id: "requirement approve",
      request_id: failed.document.requestId,
      actor: principal,
    },
    {
      action: "cli.command.denied",
      resource_id: "artifact import-fixture",
      request_id: refused.document.requestId,
      actor: principal,
    },
  ]);
  expect(principal).toBeTruthy();
  // A dry run changes nothing, and a command that never opened the workspace has none to record in.
  expect(rows.map((row) => row.request_id)).not.toContain(dry.document.requestId);
  expect(rows.map((row) => row.request_id)).not.toContain(unopened.document.requestId);
  // Every envelope's request id is distinct, so the record identifies one invocation.
  expect(new Set(rows.map((row) => row.request_id)).size).toBe(rows.length);
});

it("never records the arguments of a command in its audit record", async () => {
  const { root, base } = await project();
  const marker = "synthetic-argument-marker";
  await writeFile(join(root, "target.json"), "{}");
  await symlink(join(root, "target.json"), join(root, `${marker}.json`));
  await invoke([
    ...base,
    "artifact",
    "import-fixture",
    `${marker}.json`,
    "--mime-type",
    "text/plain",
  ]);
  const app = await Application.open({ cwd: root });
  try {
    const serialized = JSON.stringify(
      app.database.all("SELECT * FROM audit_events WHERE action LIKE 'cli.command.%'"),
    );
    expect(serialized).toContain("cli.command.denied");
    expect(serialized).not.toContain(marker);
  } finally {
    app.close();
  }
});
