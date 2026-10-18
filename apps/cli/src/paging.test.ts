import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Application, SignedCursorCodec, scaffoldPlan } from "@testmaster/application";
import { afterEach, expect, it } from "vitest";
import { entity } from "../../../packages/application/src/context.js";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

const cleanups: (() => Promise<void>)[] = [];
const originalExit = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExit;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Envelope {
  data?: unknown;
  error?: { code: string; message: string };
}
interface Page {
  total: number;
  returned: number;
  items: { id: string }[];
  nextCursor: string | null;
}
interface Fixture {
  app: Application;
  cwd: string;
  init: { projectId: string; environmentId: string };
  invoke(args: string[]): Promise<{ exit: number; envelope: Envelope }>;
  data<T>(args: string[]): Promise<T>;
}

async function fixture(): Promise<Fixture> {
  const cwd = await mkdtemp(join(tmpdir(), "tm-cli-paging-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const app = await Application.open({ cwd, home, env: {} });
  cleanups.push(async () => {
    app.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const init = await app.init();
  /** One invocation at a time: the exit code is the process's. */
  const invoke = async (args: string[]) => {
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
    return { exit: process.exitCode ?? 0, envelope: JSON.parse(stdout) as Envelope };
  };
  /** The data of a command that must succeed. */
  const data = async <T>(args: string[]): Promise<T> => {
    const result = await invoke(args);
    expect(result.envelope.error, JSON.stringify(result.envelope)).toBeUndefined();
    return result.envelope.data as T;
  };
  return { app, cwd, init, invoke, data };
}

/** Every page of a walk: the first asks `--limit`, the next ones only `--cursor`. */
async function walk(f: Fixture, command: string[], limit: number) {
  const pages: Page[] = [];
  let cursor: string | null = null;
  do {
    pages.push(
      await f.data<Page>([
        ...command,
        ...(cursor ? ["--cursor", cursor] : ["--limit", String(limit)]),
      ]),
    );
    cursor = pages.at(-1)?.nextCursor ?? null;
  } while (cursor);
  return pages;
}

async function seedLists(f: Fixture) {
  for (let index = 0; index < 6; index++)
    f.app.environments.create({
      projectId: f.init.projectId,
      name: `staging-${index}`,
      baseUrl: "https://shop.example.test",
    });
  for (let index = 0; index < 5; index++) {
    await writeFile(
      join(f.cwd, `prd-${index}.md`),
      `# Product ${index}\n\nThe shop sells item ${index}.\n`,
    );
    await f.data(["source", "add", `prd-${index}.md`, "--role", "prd"]);
  }
  for (let index = 0; index < 5; index++)
    f.app.context.entities.insert(
      "ProposalBatch",
      entity(f.app.context, "pbt", {
        projectId: f.init.projectId,
        sourceSnapshotId: `snapshot-${index}`,
        state: "proposed",
      }),
    );
  for (const key of [
    "route:GET:/a",
    "route:GET:/b",
    "endpoint:GET:/api/a",
    "route:GET:/c",
    "route:GET:/d",
  ])
    f.app.context.entities.insert(
      "Feature",
      entity(f.app.context, "fea", {
        projectId: f.init.projectId,
        stableKey: key,
        routeRefs: [],
        endpointRefs: [],
        requirementRefs: [],
      }),
    );
}

const lists: Array<{ name: string; command: string[]; limit: number }> = [
  { name: "env list", command: ["env", "list"], limit: 3 },
  { name: "source list", command: ["source", "list"], limit: 2 },
  { name: "plan list", command: ["plan", "list"], limit: 2 },
  { name: "feature list", command: ["feature", "list"], limit: 2 },
  { name: "feature list --match", command: ["feature", "list", "--match", "ROUTE:get"], limit: 3 },
];

for (const list of lists) {
  it(`${list.name} --limit walks every item exactly once, in the unpaged order, and ends with a null nextCursor`, async () => {
    const f = await fixture();
    await seedLists(f);
    const unpaged = await f.data<{ id: string }[]>(list.command);
    expect(unpaged.length).toBeGreaterThan(list.limit);
    const pages = await walk(f, list.command, list.limit);
    expect(pages.flatMap((page) => page.items)).toEqual(unpaged);
    expect(pages.map((page) => page.total)).toEqual(pages.map(() => unpaged.length));
    expect(pages.map((page) => page.returned)).toEqual(pages.map((page) => page.items.length));
    // A continuation with only --cursor keeps the size the walk began with.
    expect(pages.slice(0, -1).map((page) => page.items.length)).toEqual(
      pages.slice(0, -1).map(() => list.limit),
    );
    expect(pages.slice(0, -1).every((page) => page.nextCursor !== null)).toBe(true);
    expect(pages.at(-1)?.nextCursor).toBeNull();
  });
}

it("a page that holds everything says there is no more, and --cursor with another --limit changes the size", async () => {
  const f = await fixture();
  await seedLists(f);
  const whole = await f.data<Page>(["env", "list", "--limit", "100"]);
  expect(whole).toMatchObject({ total: 7, returned: 7, nextCursor: null });
  const first = await f.data<Page>(["env", "list", "--limit", "2"]);
  const second = await f.data<Page>([
    "env",
    "list",
    "--cursor",
    String(first.nextCursor),
    "--limit",
    "4",
  ]);
  expect(second.items).toHaveLength(4);
  const rest = await f.data<Page>(["env", "list", "--cursor", String(second.nextCursor)]);
  expect([...first.items, ...second.items, ...rest.items]).toEqual(whole.items);
  expect(rest.nextCursor).toBeNull();
});

it("plan get --limit pages the proposals of one batch and repeats the batch on every page", async () => {
  const f = await fixture();
  const batch = entity(f.app.context, "pbt", {
    projectId: f.init.projectId,
    sourceSnapshotId: "seeded",
    state: "proposed",
  });
  f.app.context.entities.insert("ProposalBatch", batch);
  for (let index = 0; index < 7; index++)
    f.app.context.entities.insert(
      "Proposal",
      entity(f.app.context, "pro", {
        batchId: batch.id,
        plan: { ...scaffoldPlan("backend"), name: `Proposal ${index}` },
        requirementRefs: [],
        evidenceRefs: [],
        warnings: [],
        state: "proposed",
        validation: "valid",
      }),
    );
  interface ProposalPage {
    batch: { id: string };
    total: number;
    returned: number;
    proposals: { id: string }[];
    nextCursor: string | null;
  }
  const unpaged = await f.data<{ batch: { id: string }; proposals: { id: string }[] }>([
    "plan",
    "get",
    batch.id,
  ]);
  const pages: ProposalPage[] = [];
  let cursor: string | null = null;
  do {
    pages.push(
      await f.data<ProposalPage>([
        "plan",
        "get",
        batch.id,
        ...(cursor ? ["--cursor", cursor] : ["--limit", "3"]),
      ]),
    );
    cursor = pages.at(-1)?.nextCursor ?? null;
  } while (cursor);
  expect(pages.map((page) => page.proposals.length)).toEqual([3, 3, 1]);
  expect(pages.flatMap((page) => page.proposals)).toEqual(unpaged.proposals);
  expect(pages.every((page) => page.batch.id === batch.id && page.total === 7)).toBe(true);
});

it("a cursor is refused for another list, another filter, another batch, a forged signature and once expired", async () => {
  const f = await fixture();
  await seedLists(f);
  const envPage = await f.data<Page>(["env", "list", "--limit", "2"]);
  const cursor = String(envPage.nextCursor);
  const featurePage = await f.data<Page>(["feature", "list", "--limit", "2"]);

  const otherList = await f.invoke(["source", "list", "--cursor", cursor]);
  expect(otherList.exit).toBe(5);
  expect(otherList.envelope.error?.code).toBe("INVALID_ARGUMENT");
  const otherFilter = await f.invoke([
    "feature",
    "list",
    "--match",
    "route",
    "--cursor",
    String(featurePage.nextCursor),
  ]);
  expect(otherFilter.envelope.error?.code).toBe("INVALID_ARGUMENT");
  const forged = await f.invoke(["env", "list", "--cursor", `${cursor.slice(0, -2)}xx`]);
  expect(forged.envelope.error?.code).toBe("INVALID_ARGUMENT");
  const garbage = await f.invoke(["env", "list", "--cursor", "not-a-cursor"]);
  expect(garbage.envelope.error?.code).toBe("INVALID_ARGUMENT");

  // A cursor that was valid and has expired is refused, never read as "start over".
  const expired = new SignedCursorCodec(f.app, -1).encode({
    binding: `cli:environments:${f.init.projectId}:${f.app.context.principalId}`,
    id: "2",
    createdAt: "",
    cutoff: "2",
  });
  const late = await f.invoke(["env", "list", "--cursor", expired]);
  expect(late.envelope.error?.code).toBe("CURSOR_EXPIRED");

  for (const limit of ["0", "-1", "1.5", "many"]) {
    const refused = await f.invoke(["env", "list", "--limit", limit]);
    expect(refused.envelope.error?.code, `--limit ${limit}`).toBe("INVALID_ARGUMENT");
  }
});

it("plan get --out writes the whole batch byte for byte as the unpaged data, prints only the receipt, and never replaces a file", async () => {
  const f = await fixture();
  const batch = entity(f.app.context, "pbt", {
    projectId: f.init.projectId,
    sourceSnapshotId: "seeded",
    state: "proposed",
  });
  f.app.context.entities.insert("ProposalBatch", batch);
  for (let index = 0; index < 4; index++)
    f.app.context.entities.insert(
      "Proposal",
      entity(f.app.context, "pro", {
        batchId: batch.id,
        plan: { ...scaffoldPlan("backend"), name: `Proposal ${index}` },
        requirementRefs: [],
        evidenceRefs: [],
        warnings: [],
        state: "proposed",
        validation: "valid",
      }),
    );
  const unpaged = await f.data<unknown>(["plan", "get", batch.id]);
  const receipt = await f.data<{ path: string; bytes: number; sha256: string }>([
    "plan",
    "get",
    batch.id,
    "--out",
    "batch.json",
  ]);
  expect(Object.keys(receipt).sort()).toEqual(["bytes", "path", "sha256"]);
  const file = await readFile(join(f.cwd, "batch.json"));
  expect(receipt.path).toBe(join(f.cwd, "batch.json"));
  expect(file.toString()).toBe(`${JSON.stringify(unpaged)}\n`);
  expect(receipt.bytes).toBe(file.length);
  expect(receipt.sha256).toBe(createHash("sha256").update(file).digest("hex"));

  const again = await f.invoke(["plan", "get", batch.id, "--out", "batch.json"]);
  expect(again.envelope.error?.code).toBe("INVALID_ARGUMENT");
  expect(await readFile(join(f.cwd, "batch.json"))).toEqual(file);
  const both = await f.invoke(["plan", "get", batch.id, "--out", "other.json", "--limit", "1"]);
  expect(both.envelope.error?.code).toBe("INVALID_ARGUMENT");
  expect((await readdir(f.cwd)).includes("other.json")).toBe(false);
});

it("discover --out writes the whole stored discovery and prints the bounded receipt with the file's digest", async () => {
  const f = await fixture();
  const repo = join(f.cwd, "repo");
  await mkdir(repo);
  await writeFile(
    join(repo, "server.ts"),
    "import express from 'express'; const app = express(); app.get('/health', (req,res) => res.json({ok:true}));",
  );
  for (let index = 0; index < 60; index++)
    await writeFile(join(repo, `key-${index}.pem`), "-----BEGIN PRIVATE KEY-----");
  const receipt = await f.data<{
    job: { id: string };
    skippedFileCount: number;
    out: { path: string; bytes: number; sha256: string };
  }>(["discover", "--root", "repo", "--out", "discovery.json"]);
  const file = await readFile(join(f.cwd, "discovery.json"));
  expect(receipt.out).toEqual({
    path: join(f.cwd, "discovery.json"),
    bytes: file.length,
    sha256: createHash("sha256").update(file).digest("hex"),
  });
  expect(receipt.skippedFileCount).toBe(60);
  // The file is the stored discovery the receipt summarizes: every skipped file, not the 50 of the receipt.
  const stored = await f.data<unknown>([
    "discover",
    "--resume",
    receipt.job.id,
    "--root",
    "repo",
    "--full",
  ]);
  expect(file.toString()).toBe(`${JSON.stringify(stored)}\n`);
  const written: { codeSnapshot: { skippedFiles: unknown[] } } = JSON.parse(file.toString());
  expect(written.codeSnapshot.skippedFiles).toHaveLength(60);

  const conflict = await f.invoke(["discover", "--root", "repo", "--full", "--out", "again.json"]);
  expect(conflict.envelope.error?.code).toBe("INVALID_ARGUMENT");
  await expect(stat(join(f.cwd, "again.json"))).rejects.toThrow();
});

it("test export --out writes every file as the unpaged export has it and prints only each file's path, bytes and sha256", async () => {
  const f = await fixture();
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const unpaged = await f.data<{ files: Record<string, string>; revisionId: string }>([
    "test",
    "export",
    test.id,
    "--format",
    "playwright",
  ]);
  expect(Object.keys(unpaged.files).length).toBeGreaterThan(0);
  const receipt = await f.data<{
    revisionId: string;
    out: string;
    files: { path: string; bytes: number; sha256: string }[];
  }>(["test", "export", test.id, "--format", "playwright", "--out", "exported"]);
  expect(JSON.stringify(receipt)).not.toContain(
    Object.values(unpaged.files)[0]?.slice(0, 60) ?? "",
  );
  expect(receipt.revisionId).toBe(unpaged.revisionId);
  expect(receipt.files.map((file) => file.path).sort()).toEqual(Object.keys(unpaged.files).sort());
  for (const file of receipt.files) {
    const written = await readFile(join(f.cwd, "exported", file.path));
    expect(written.toString()).toBe(unpaged.files[file.path]);
    expect(file.bytes).toBe(written.length);
    expect(file.sha256).toBe(createHash("sha256").update(written).digest("hex"));
  }
});
