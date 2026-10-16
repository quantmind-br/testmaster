import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Application, entity, HealingService, scaffoldPlan } from "@testmaster/application";
import { ajv, ContractError } from "@testmaster/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpServer } from "./server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Scope = "R" | "W" | "X";
interface Failure {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

async function fixture(scopes: Scope[] = ["R", "W", "X"]) {
  const cwd = await mkdtemp(join(tmpdir(), "tm-mcp-surface-"));
  const app = await Application.open({ cwd, home: join(cwd, "home"), env: {} });
  const init = await app.init();
  const server = createMcpServer({
    application: app.forIdentity({ principalId: init.principalId, scopes }),
    roots: [cwd],
  });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  const client = new Client({ name: "surface-test", version: "1" });
  await client.connect(left);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    app.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = String((result.content as { text: string }[])[0]?.text);
    const body = JSON.parse(text) as Record<string, unknown>;
    return {
      isError: result.isError === true,
      body,
      error: body.error as Failure | undefined,
      result,
    };
  };
  return { app, cwd, init, server, client, call };
}

const missingRun = "run_019bf434-20c0-7000-8000-000000000001";

it("resources answer JSON-RPC -32002 when unknown or missing and -32602 when malformed", async () => {
  const f = await fixture();
  await expect(f.client.readResource({ uri: "testmaster://nowhere/x" })).rejects.toMatchObject({
    code: -32002,
  });
  await expect(
    f.client.readResource({ uri: `testmaster://runs/${missingRun}/result` }),
  ).rejects.toMatchObject({ code: -32002 });
  await expect(f.client.readResource({ uri: "not a uri" })).rejects.toMatchObject({ code: -32602 });
  // Positive control: an existing resource is still served.
  const project = await f.client.readResource({ uri: `testmaster://projects/${f.init.projectId}` });
  expect(JSON.parse(String(project.contents[0]?.text))).toMatchObject({ id: f.init.projectId });
});

it("resources/list exposes project ids next to runs", async () => {
  const f = await fixture();
  const listed = (await f.client.listResources()).resources.map((resource) => resource.uri);
  expect(listed).toContain(`testmaster://projects/${f.init.projectId}`);
});

it("tools/list advertises unique output ids, described inputs and the annotation classes", async () => {
  const f = await fixture();
  const tools = (await f.client.listTools()).tools;
  const ids = tools.map((tool) => String(tool.outputSchema?.$id));
  expect(new Set(ids).size).toBe(tools.length);
  // A client that compiles every output schema in one validator must not meet a duplicate id.
  const compiled: string[] = [];
  try {
    for (const tool of tools) {
      ajv.compile(tool.outputSchema as Record<string, unknown>);
      compiled.push(String(tool.outputSchema?.$id));
    }
  } finally {
    for (const id of compiled) ajv.removeSchema(id);
  }
  expect(compiled).toHaveLength(tools.length);
  const undescribed = tools.flatMap((tool) =>
    Object.entries(tool.inputSchema.properties ?? {})
      .filter(([, schema]) => !(schema as { description?: string }).description)
      .map(([property]) => `${tool.name}.${property}`),
  );
  expect(undescribed).toEqual([]);
  const annotations = (name: string) => tools.find((tool) => tool.name === name)?.annotations;
  expect(annotations("testmaster_get_run")).toMatchObject({
    readOnlyHint: true,
    destructiveHint: false,
  });
  expect(annotations("testmaster_analyze_code")).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
  });
  expect(annotations("testmaster_bootstrap")).toMatchObject({
    destructiveHint: false,
    idempotentHint: true,
  });
  expect(annotations("testmaster_run_tests")).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
  });
  expect(annotations("testmaster_cancel_run")).toMatchObject({ destructiveHint: true });
});

it("argument errors name the tool, list each issue once and name the allowed values", async () => {
  const f = await fixture();
  const badMode = await f.call("testmaster_run_tests", {
    testIds: [],
    environmentId: f.init.environmentId,
    mode: "explore",
  });
  expect(badMode.error?.code).toBe("INVALID_ARGUMENT");
  expect(badMode.error?.message).toContain("testmaster_run_tests");
  const issues = badMode.error?.details.issues as { path: string; message: string }[];
  expect(issues).toHaveLength(1);
  expect(issues[0]?.path).toBe("/mode");
  expect(issues[0]?.message).toContain("replay");
  expect(issues[0]?.message).toContain("agent");
  // generate_tests needs proposalIds or revisionIds; neither is refused with the rule spelled out.
  const neither = await f.call("testmaster_generate_tests", {});
  expect(neither.error?.code).toBe("INVALID_ARGUMENT");
  expect(JSON.stringify(neither.error?.details.issues)).toContain("proposalIds or revisionIds");
  // Positive control: a selection passes validation and fails later, on the missing proposal.
  const selected = await f.call("testmaster_generate_tests", {
    proposalIds: ["pro_019bf434-20c0-7000-8000-000000000001"],
  });
  expect(selected.error?.code).toBe("NOT_FOUND");
});

it("path refusals carry the approved roots", async () => {
  const f = await fixture();
  const outside = await f.call("testmaster_analyze_code", {
    projectId: f.init.projectId,
    root: tmpdir(),
  });
  expect(outside.error?.code).toBe("FORBIDDEN");
  expect(outside.error?.details.approvedRoots).toEqual([await realpath(f.cwd)]);
});

it("bootstrap binds each root to one project and refuses clashes and bad targets", async () => {
  const f = await fixture();
  const bootstrap = (projectRoot: string, extra: Record<string, unknown> = {}) =>
    f.call("testmaster_bootstrap", {
      projectRoot,
      target: "http://127.0.0.1:3000",
      scope: ["codebase"],
      mode: "replay",
      ...extra,
    });
  const initRoot = await bootstrap(f.cwd);
  expect(initRoot.isError).toBe(false);
  expect(initRoot.body.projectId).toBe(f.init.projectId);
  expect(f.app.projects.list()).toHaveLength(1);
  expect(initRoot.body.config).toMatchObject({
    environment: { baseUrl: "http://127.0.0.1:3000", networkProfile: "local-loopback" },
    execution: { mode: "replay" },
  });
  expect(initRoot.body.preflight).toContainEqual({ check: "approved_root", passed: true });

  await mkdir(join(f.cwd, "sub"));
  const first = await bootstrap(join(f.cwd, "sub"));
  const second = await bootstrap(join(f.cwd, "sub"));
  expect(first.isError).toBe(false);
  expect(second.body.projectId).toBe(first.body.projectId);
  expect(first.body.projectId).not.toBe(f.init.projectId);
  expect(f.app.projects.list()).toHaveLength(2);

  // A project that already owns the slug but is bound to no root is a conflict, never a silent adopt.
  const other = f.app.projects.create({ name: "other" });
  await mkdir(join(f.cwd, "other"));
  const clash = await bootstrap(join(f.cwd, "other"));
  expect(clash.error?.code).toBe("PRECONDITION_FAILED");
  expect(clash.error?.details.projectId).toBe(other.id);
  expect(f.app.projects.list()).toHaveLength(3);
  // Control: a root whose name is free is created.
  await mkdir(join(f.cwd, "fresh"));
  expect((await bootstrap(join(f.cwd, "fresh"))).isError).toBe(false);
  expect(f.app.projects.list()).toHaveLength(4);

  for (const target of ["ftp://example.test", "http://user:secret@example.test", "not a url"]) {
    const refused = await bootstrap(f.cwd, { target });
    expect(refused.error?.code, target).toBe("INVALID_ARGUMENT");
  }
  expect((await bootstrap(f.cwd, { scope: ["R"] })).error?.code).toBe("INVALID_ARGUMENT");
  expect(f.app.projects.list()).toHaveLength(4);
});

it("report resources are text pages with the paging in _meta", async () => {
  const f = await fixture();
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const run = f.app.runs.resolve({ testId: test.id, environmentId: f.init.environmentId });
  Object.assign(run, { phase: "completed", status: "passed", outcome: "passed", gate: "passed" });
  f.app.context.entities.insert("Run", run);
  // "é" takes two bytes and the prefix is 11 bytes, so a 65536-byte page ends inside a character
  // unless pages are cut on character boundaries.
  const document = JSON.stringify({ filler: "é".repeat(40000) });
  vi.spyOn(Object.getPrototypeOf(f.app.reports), "export").mockResolvedValue({
    content: document,
  } as never);
  const pages: string[] = [];
  let first: Record<string, unknown> | undefined;
  let next: string | null = `testmaster://runs/${run.id}/report`;
  while (next) {
    const content = (await f.client.readResource({ uri: next })).contents[0] as Record<
      string,
      unknown
    >;
    const meta = content._meta as Record<string, unknown>;
    first ??= content;
    expect(content.mimeType).toBe("application/json");
    expect(content).not.toHaveProperty("blob");
    const text = String(content.text);
    expect(text).not.toContain("\uFFFD");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(65536);
    expect(meta["testmaster:offset"]).toBe(Buffer.byteLength(pages.join("")));
    expect(meta["testmaster:sizeBytes"]).toBe(Buffer.byteLength(document));
    pages.push(text);
    next = meta["testmaster:next"] as string | null;
  }
  expect(first).toBeDefined();
  expect(pages.length).toBeGreaterThan(1);
  // The concatenated pages are the document, and it parses.
  expect(pages.join("")).toBe(document);
  expect(JSON.parse(pages.join(""))).toEqual(JSON.parse(document));
});

it("artifact pages are text for textual media types, cut on character boundaries, and blob for binary ones", async () => {
  const f = await fixture();
  // The server works on its own identity view of the application: spy on the shared prototype.
  const serve = (bytes: Buffer, mimeType: string, pageBytes: number) =>
    vi.spyOn(Object.getPrototypeOf(f.app.artifacts), "read").mockImplementation((async (
      _runId: string,
      _path: string,
      options: { offset?: number } = {},
    ) => {
      const offset = options.offset ?? 0;
      const page = bytes.subarray(offset, offset + pageBytes);
      return {
        bytes: page,
        entry: { relativePath: "a", mimeType, sizeBytes: bytes.length },
        nextOffset: offset + page.length < bytes.length ? offset + page.length : null,
      };
    }) as never);
  const uri = `testmaster://runs/${missingRun}/artifacts/${encodeURIComponent("a")}`;
  const readPages = async () => {
    const pages: Record<string, unknown>[] = [];
    let next: string | null = uri;
    while (next) {
      const content = (await f.client.readResource({ uri: next })).contents[0] as Record<
        string,
        unknown
      >;
      pages.push(content);
      next = (content._meta as Record<string, unknown>)["testmaster:next"] as string | null;
    }
    return pages;
  };

  // 7-byte pages over multi-byte text end inside 2-, 3- and 4-byte characters.
  const original = '{"k":"héllo wörld ✓ 日本語 😀 end"}';
  serve(Buffer.from(original), "application/json", 7);
  const pages = await readPages();
  expect(pages.length).toBeGreaterThan(3);
  for (const page of pages) {
    expect(page).not.toHaveProperty("blob");
    expect(page.mimeType).toBe("application/json");
    expect(String(page.text)).not.toContain("\uFFFD");
  }
  expect(pages.map((page) => String(page.text)).join("")).toBe(original);

  for (const mimeType of [
    "text/plain",
    "text/html; charset=utf-8",
    "text/markdown",
    "application/x-ndjson",
    "application/vnd.api+json",
    "application/xml",
  ]) {
    serve(Buffer.from("{}\n"), mimeType, 1024);
    const [page] = await readPages();
    expect(page?.text, mimeType).toBe("{}\n");
    expect(page, mimeType).not.toHaveProperty("blob");
  }

  // Binary media types stay base64, byte for byte (0x89 and 0xff are not valid UTF-8).
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
  for (const mimeType of [
    "image/png",
    "application/zip",
    "video/webm",
    "application/octet-stream",
  ]) {
    serve(binary, mimeType, 1024);
    const [page] = await readPages();
    expect(page, mimeType).not.toHaveProperty("text");
    expect(Buffer.from(String(page?.blob), "base64"), mimeType).toEqual(binary);
    expect(page?.mimeType).toBe(mimeType);
  }
});

it("analyze_code returns the snapshot with its scan summary", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, "server.ts"), "const app = {}; app.get('/health', () => {});");
  const analyzed = await f.call("testmaster_analyze_code", {
    projectId: f.init.projectId,
    root: f.cwd,
  });
  expect(analyzed.isError, JSON.stringify(analyzed.body)).toBe(false);
  expect(analyzed.body.codeSnapshot).toMatchObject({ manifestHash: expect.any(String) });
  expect(analyzed.body.scannedFileCount).toBeGreaterThanOrEqual(1);
  expect(Array.isArray(analyzed.body.skippedFiles)).toBe(true);
  expect(Array.isArray(analyzed.body.warnings)).toBe(true);
  expect(analyzed.body.features).toContainEqual({
    id: expect.stringMatching(/^fea_/),
    stableKey: "endpoint:GET:/health",
  });
  expect(analyzed.body.featureCount).toBe(1);
});

it("analyze_code on a large repository returns a bounded receipt with counts instead of the full lists", async () => {
  const f = await fixture();
  const routes = Array.from({ length: 130 }, (_, i) => `app.get('/r${i}', () => {});`);
  await writeFile(join(f.cwd, "server.ts"), `const app = {};\n${routes.join("\n")}\n`);
  for (let i = 0; i < 70; i++) await writeFile(join(f.cwd, `note${i}.txt`), `note ${i}`);
  const analyzed = await f.call("testmaster_analyze_code", {
    projectId: f.init.projectId,
    root: f.cwd,
  });
  expect(analyzed.isError, JSON.stringify(analyzed.body)).toBe(false);
  const body = analyzed.body as {
    codeSnapshot: Record<string, unknown>;
    skippedFileCount: number;
    skippedByReason: { reason: string; count: number }[];
    skippedFiles: { path: string; reason: string }[];
    omittedSkippedFiles: number;
    featureCount: number;
    features: { id: string; stableKey: string }[];
    omittedFeatures: number;
    featuresResource: string;
  };
  // The unbounded receipt of a 1291-feature repository was 440 KB; this one carries 130 features
  // and 70+ skipped files and must stay well under the 32 KiB inline threshold.
  expect(Buffer.byteLength(JSON.stringify(analyzed.body))).toBeLessThan(32768);
  expect(analyzed.body).not.toHaveProperty("featureRefs");
  // The skipped list is not duplicated inside the snapshot.
  expect(body.codeSnapshot).not.toHaveProperty("skippedFiles");
  expect(body.skippedFileCount).toBeGreaterThanOrEqual(70);
  expect(body.skippedFiles).toHaveLength(50);
  expect(body.omittedSkippedFiles).toBe(body.skippedFileCount - 50);
  expect(body.skippedByReason.reduce((sum, item) => sum + item.count, 0)).toBe(
    body.skippedFileCount,
  );
  expect(body.featureCount).toBe(130);
  expect(body.features).toHaveLength(100);
  expect(body.omittedFeatures).toBe(30);
  expect(body.featuresResource).toBe(`testmaster://projects/${f.init.projectId}/features`);
  const keys = body.features.map((feature) => feature.stableKey);
  expect(keys).toEqual([...keys].sort());
  const stored = f.app.context.entities.get(
    "Feature",
    f.app.context.workspaceId,
    String(body.features[0]?.id),
  );
  expect(stored?.stableKey).toBe(body.features[0]?.stableKey);
});

it("the features resource maps stable keys to ids, filters by substring and pages", async () => {
  const f = await fixture();
  const ids: Record<string, string> = {};
  const add = (stableKey: string, projectId = f.init.projectId) => {
    const feature = entity(f.app.context, "fea", {
      projectId,
      stableKey,
      routeRefs: [],
      endpointRefs: [],
      requirementRefs: [],
    });
    f.app.context.entities.insert("Feature", feature);
    ids[stableKey] = feature.id;
  };
  for (const key of ["route:GET:/login", "route:GET:/logout", "endpoint:POST:/api/login"]) add(key);
  for (let i = 0; i < 120; i++) add(`route:GET:/bulk/${i}`);
  const other = f.app.projects.create({ name: "elsewhere" });
  add("route:GET:/login-of-another-project", other.id);
  const read = async (uri: string) =>
    JSON.parse(String((await f.client.readResource({ uri })).contents[0]?.text)) as {
      projectId: string;
      match?: string;
      total: number;
      features: { id: string; stableKey: string }[];
      next: string | null;
    };
  const base = `testmaster://projects/${f.init.projectId}/features`;

  // A stable key resolves to its id; matching ignores case and never leaves the project.
  const login = await read(`${base}?match=${encodeURIComponent("ROUTE:get:/login")}`);
  expect(login.features).toEqual([{ id: ids["route:GET:/login"], stableKey: "route:GET:/login" }]);
  expect(login.total).toBe(1);
  expect((await read(`${base}?match=login`)).features.map((feature) => feature.stableKey)).toEqual([
    "endpoint:POST:/api/login",
    "route:GET:/login",
  ]);
  // LIKE wildcards in the match are literal text.
  expect((await read(`${base}?match=${encodeURIComponent("/bulk/1%")}`)).total).toBe(0);
  expect((await read(`${base}?match=${encodeURIComponent("/bulk/_")}`)).total).toBe(0);
  // Keys containing "/bulk/1": 1, 10-19 and 100-119.
  expect((await read(`${base}?match=${encodeURIComponent("/bulk/1")}`)).total).toBe(31);
  expect((await read(`${base}?match=nothing-like-this`)).features).toEqual([]);

  // Without a match every feature is reachable, 100 per page, in key order, each exactly once.
  const seen: string[] = [];
  let next: string | null = base;
  let pages = 0;
  while (next) {
    const page = await read(next);
    expect(page.total).toBe(123);
    expect(page.features.length).toBeLessThanOrEqual(100);
    seen.push(...page.features.map((feature) => feature.stableKey));
    next = page.next;
    pages++;
  }
  expect(pages).toBe(2);
  expect(seen).toHaveLength(123);
  expect(new Set(seen).size).toBe(123);
  expect(seen).toEqual([...seen].sort());
  // A cursor follows its own filter: reusing it with another match is refused.
  const filtered = await read(`${base}?match=bulk`);
  expect(filtered.next).not.toBeNull();
  const cursor = new URL(String(filtered.next)).searchParams.get("cursor");
  await expect(
    f.client.readResource({
      uri: `${base}?match=login&cursor=${encodeURIComponent(String(cursor))}`,
    }),
  ).rejects.toMatchObject({ code: -32602 });
  // Unknown projects are unknown resources.
  await expect(
    f.client.readResource({
      uri: "testmaster://projects/prj_019bf434-20c0-7000-8000-000000000001/features",
    }),
  ).rejects.toMatchObject({ code: -32002 });
});

it("no tool input is a top-level combinator, generate_tests shows every property and normalize takes a provider", async () => {
  const f = await fixture();
  const tools = (await f.client.listTools()).tools;
  expect(tools).toHaveLength(30);
  for (const tool of tools) {
    for (const keyword of ["anyOf", "oneOf", "allOf", "not"])
      expect(tool.inputSchema, `${tool.name} ${keyword}`).not.toHaveProperty(keyword);
  }
  const input = (name: string) => tools.find((tool) => tool.name === name)?.inputSchema;
  expect(Object.keys(input("testmaster_generate_tests")?.properties ?? {}).sort()).toEqual([
    "budget",
    "model",
    "proposalIds",
    "provider",
    "revisionIds",
  ]);
  expect(input("testmaster_generate_tests")?.required ?? []).toEqual([]);
  expect(Object.keys(input("testmaster_normalize_requirements")?.properties ?? {})).toContain(
    "provider",
  );
});

it("generate_tests requires proposalIds or revisionIds at runtime and accepts either with model options", async () => {
  const f = await fixture();
  const neither = await f.call("testmaster_generate_tests", { provider: "p", model: "m" });
  expect(neither.error?.code).toBe("INVALID_ARGUMENT");
  expect(neither.error?.message).toContain("proposalIds or revisionIds");
  expect(JSON.stringify(neither.error?.details.issues)).toContain("proposalIds or revisionIds");
  // Control: revisionIds with provider, model and budget passes validation and fails on the unknown revision.
  const withRevisions = await f.call("testmaster_generate_tests", {
    revisionIds: ["rev_019bf434-20c0-7000-8000-000000000001"],
    provider: "p",
    model: "m",
    budget: { modelCalls: 2 },
  });
  expect(withRevisions.error?.code).toBe("NOT_FOUND");
});

it("normalize_requirements forwards provider and model to the service", async () => {
  const f = await fixture();
  const normalize = vi
    .spyOn(Object.getPrototypeOf(f.app.requirements), "normalize")
    .mockResolvedValue({
      requirements: [],
      conflicts: [],
      fingerprint: "fingerprint-1",
      version: 1,
    } as never);
  const normalized = await f.call("testmaster_normalize_requirements", {
    projectId: f.init.projectId,
    sourceRevisionIds: ["svr_019bf434-20c0-7000-8000-000000000001"],
    provider: "gateway",
    model: "m1",
  });
  expect(normalized.isError, JSON.stringify(normalized.body)).toBe(false);
  expect(normalized.body.sourceSnapshotId).toBe("fingerprint-1");
  expect(normalize).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "gateway", model: "m1" }),
  );
});

async function commitRepo(cwd: string) {
  const git = promisify(execFile);
  const run = (args: string[]) =>
    git("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args]);
  const commit = async (message: string) => {
    await run(["add", "server.ts", "other.ts", "notes.txt"]);
    await run([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      message,
    ]);
    return (await run(["rev-parse", "HEAD"])).stdout.trim();
  };
  await run(["init"]);
  await writeFile(join(cwd, "server.ts"), "const app = {}; app.get('/base', () => {});");
  await writeFile(join(cwd, "other.ts"), "export const unrelated = 1;");
  await writeFile(join(cwd, "notes.txt"), "base notes");
  const base = await commit("base");
  await writeFile(join(cwd, "server.ts"), "const app = {}; app.get('/head', () => {});");
  await writeFile(join(cwd, "notes.txt"), "head notes");
  const head = await commit("head");
  return { base, head };
}

it("analyze_code refuses a dirty or base-only request instead of scanning the whole codebase", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, "server.ts"), "const app = {}; app.get('/health', () => {});");
  const args = { projectId: f.init.projectId, root: f.cwd };
  const dirty = await f.call("testmaster_analyze_code", { ...args, dirty: true });
  expect(dirty.isError).toBe(true);
  expect(dirty.error?.code).toBe("PRECONDITION_FAILED");
  // head is not defaulted: a base alone is as incomplete as a dirty request without base.
  const baseOnly = await f.call("testmaster_analyze_code", { ...args, base: "HEAD" });
  expect(baseOnly.isError).toBe(true);
  expect(baseOnly.error?.code).toBe("PRECONDITION_FAILED");
  // Control: no refs and no dirty flag is the explicit whole-codebase request.
  const whole = await f.call("testmaster_analyze_code", args);
  expect(whole.isError, JSON.stringify(whole.body)).toBe(false);
  expect(whole.body).not.toHaveProperty("diff");
});

it("analyze_code on a diff lists the changed paths and what the analysis kept or dropped", async () => {
  const f = await fixture();
  const { base, head } = await commitRepo(f.cwd);
  const args = { projectId: f.init.projectId, root: f.cwd, base };
  const pinned = await f.call("testmaster_analyze_code", { ...args, head });
  expect(pinned.isError, JSON.stringify(pinned.body)).toBe(false);
  const diff = pinned.body.diff as {
    baseSha: string;
    headSha: string;
    includeWorkingTree: boolean;
    changes: { status: string; path: string }[];
    impact: { selectedFiles: string[]; excludedFiles: { path: string; reason: string }[] };
  };
  expect(diff).toMatchObject({ baseSha: base, headSha: head, includeWorkingTree: false });
  expect(diff.changes.map((change) => [change.status, change.path]).sort()).toEqual([
    ["M", "notes.txt"],
    ["M", "server.ts"],
  ]);
  // Changed files are selected whether or not they were analyzed; analyzed files the change cannot
  // reach are reported as excluded.
  expect(diff.impact.selectedFiles).toEqual(expect.arrayContaining(["server.ts", "notes.txt"]));
  expect(diff.impact.selectedFiles).not.toContain("other.ts");
  expect(diff.impact.excludedFiles.map((file) => file.path)).toContain("other.ts");

  // base..working tree is the other diff form.
  await writeFile(join(f.cwd, "server.ts"), "const app = {}; app.get('/dirty', () => {});");
  const dirty = await f.call("testmaster_analyze_code", { ...args, dirty: true });
  expect(dirty.isError, JSON.stringify(dirty.body)).toBe(false);
  expect((dirty.body.diff as typeof diff).includeWorkingTree).toBe(true);
});

it("analyze_run model reading: an invalid choice fails before work and an unavailable model abstains as rules", async () => {
  const f = await fixture();
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const run = f.app.runs.resolve({ testId: test.id, environmentId: f.init.environmentId });
  Object.assign(run, { phase: "completed", status: "failed", outcome: "failed", gate: "failed" });
  f.app.context.entities.insert("Run", run);

  const unknown = await f.call("testmaster_analyze_run", {
    runId: run.id,
    model: true,
    provider: "missing",
  });
  expect(unknown.error?.code).toBe("CAPABILITY_UNAVAILABLE");
  expect(unknown.error?.details).toMatchObject({ reasonCode: "provider_unavailable" });
  // A choice without the model switch is refused instead of silently running rules only.
  const orphan = await f.call("testmaster_analyze_run", { runId: run.id, provider: "any" });
  expect(orphan.error?.code).toBe("INVALID_ARGUMENT");
  expect(f.app.analysis.get(run.id)).toBeNull();
  // `model` also carries the model id; the old `modelId` argument no longer exists.
  const renamed = await f.call("testmaster_analyze_run", { runId: run.id, model: "any-model" });
  expect(renamed.error?.code).toBe("CAPABILITY_UNAVAILABLE");
  expect(renamed.error?.details).toMatchObject({ reasonCode: "provider_unavailable" });
  const old = await f.call("testmaster_analyze_run", {
    runId: run.id,
    model: true,
    modelId: "any-model",
  });
  expect(old.error?.code).toBe("INVALID_ARGUMENT");
  expect(f.app.analysis.get(run.id)).toBeNull();

  // No model is configured, so the reading abstains and must not claim to be model output.
  const abstained = await f.client.callTool({
    name: "testmaster_analyze_run",
    arguments: { runId: run.id, model: true },
  });
  expect(abstained.isError).not.toBe(true);
  expect(abstained.structuredContent).toMatchObject({
    source: "rules",
    modelCallId: null,
    parentId: null,
    limitations: expect.arrayContaining([expect.stringContaining("Model enrichment abstained")]),
  });
  // The abstention is explicit: a structured status and a line of the text content.
  expect(abstained.structuredContent).toMatchObject({
    modelStatus: {
      state: "unavailable",
      reasonCode: "model_not_configured",
      modelCallId: null,
      message: expect.any(String),
    },
  });
  const texts = (abstained.content as { type: string; text: string }[]).map((entry) => entry.text);
  expect(
    texts.some((text) => text.includes("Model reading: unavailable (model_not_configured)")),
  ).toBe(true);
  // Control: a rules-only call carries no model status.
  const rulesOnly = await f.client.callTool({
    name: "testmaster_analyze_run",
    arguments: { runId: run.id },
  });
  expect(rulesOnly.structuredContent).not.toHaveProperty("modelStatus");
});

it("explore refuses an unknown model before it creates a job", async () => {
  const f = await fixture();
  const args = {
    projectId: f.init.projectId,
    envId: f.init.environmentId,
    featureIds: [],
    budget: { steps: 5, modelCalls: 5, timeMs: 60000 },
  };
  const refused = await f.call("testmaster_explore", { ...args, provider: "missing" });
  expect(refused.error?.code).toBe("CAPABILITY_UNAVAILABLE");
  expect(refused.error?.details).toMatchObject({ reasonCode: "provider_unavailable" });
  expect(f.app.database.get("SELECT COUNT(*) AS n FROM discovery_jobs")?.n ?? 0).toBe(0);
});

it("explore forwards approved mutationActions and refuses an invalid or non-form step", async () => {
  const f = await fixture();
  const fill = {
    id: "approved-email",
    description: "Fill the email",
    kind: "action",
    operation: "fill",
    input: {
      locator: { by: "label", value: "Email", exact: true },
      value: { literal: "a@b.test" },
    },
  };
  const args = {
    projectId: f.init.projectId,
    envId: f.init.environmentId,
    featureIds: [],
    budget: { steps: 5, modelCalls: 5, timeMs: 60000 },
  };
  const stop = new Error("stop before any browser work");
  const begin = vi.spyOn(Object.getPrototypeOf(f.app.explore), "begin").mockImplementation(() => {
    throw stop;
  });
  await f.call("testmaster_explore", { ...args, mutationActions: [fill] });
  expect(begin.mock.calls[0]?.[0]).toMatchObject({ mutationActions: [fill] });
  // Control: without the argument nothing is forwarded.
  await f.call("testmaster_explore", args);
  expect(begin.mock.calls[1]?.[0]).not.toHaveProperty("mutationActions");
  begin.mockRestore();

  // The schema refuses a malformed step and more than 20 steps before the service runs.
  const malformed = await f.call("testmaster_explore", {
    ...args,
    mutationActions: [{ id: "bad", kind: "action", operation: "explode" }],
  });
  expect(malformed.error?.code).toBe("INVALID_ARGUMENT");
  const tooMany = await f.call("testmaster_explore", {
    ...args,
    mutationActions: Array.from({ length: 21 }, () => fill),
  });
  expect(tooMany.error?.code).toBe("INVALID_ARGUMENT");
  // A well-formed step that is not a form action is refused by the service, before the job exists.
  const navigate = await f.call("testmaster_explore", {
    ...args,
    mutationActions: [
      {
        id: "go",
        description: "Leave",
        kind: "action",
        operation: "navigate",
        input: { path: "/elsewhere" },
      },
    ],
  });
  expect(navigate.error?.code).toBe("POLICY_DENIED");
  expect(f.app.database.get("SELECT COUNT(*) AS n FROM discovery_jobs")?.n ?? 0).toBe(0);
});

it("generate_tests forwards the chosen provider and model and refuses an unknown one before any model call", async () => {
  const f = await fixture();
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const args = {
    revisionIds: [String(test.activeRevisionId)],
    provider: "chosen-provider",
    model: "chosen-model",
  };
  const generate = vi
    .spyOn(Object.getPrototypeOf(f.app.codeGeneration), "generate")
    .mockResolvedValue({ requested: 1, candidates: [], validationErrors: [] });
  const forwarded = await f.call("testmaster_generate_tests", args);
  expect(forwarded.isError).toBe(false);
  expect(forwarded.body).toMatchObject({ requested: 1, candidates: [], validationErrors: [] });
  expect(generate.mock.calls[0]?.[0]).toMatchObject({
    projectId: f.init.projectId,
    revisionIds: args.revisionIds,
    provider: "chosen-provider",
    model: "chosen-model",
  });
  // Control: without a choice nothing is forwarded, so the profile default applies.
  await f.call("testmaster_generate_tests", { revisionIds: args.revisionIds });
  expect(generate.mock.calls[1]?.[0]).not.toHaveProperty("provider");
  expect(generate.mock.calls[1]?.[0]).not.toHaveProperty("model");

  // The real service refuses the unknown provider before it reads a plan or calls a model.
  generate.mockRestore();
  const refused = await f.call("testmaster_generate_tests", args);
  expect(refused.error?.code).toBe("CAPABILITY_UNAVAILABLE");
  expect(refused.error?.details).toMatchObject({ reasonCode: "provider_unavailable" });
  expect(f.app.database.get("SELECT COUNT(*) AS n FROM model_calls")?.n ?? 0).toBe(0);
});

it("normalize returns the snapshot fingerprint, announces progress with a total and links a large snapshot", async () => {
  const f = await fixture();
  let count = 2;
  const requirement = (index: number) =>
    entity(f.app.context, "req", {
      text: `Requirement ${index} ${"x".repeat(400)}`,
      acceptanceCriteria: [],
      sourceRefs: [],
      originKind: "explicit",
      confidence: null,
      approval: null,
    });
  vi.spyOn(Object.getPrototypeOf(f.app.requirements), "normalize").mockImplementation(
    async (input: {
      onProgress?: (step: { completed: number; total: number; message: string }) => void;
    }) => {
      input.onProgress?.({ completed: 0, total: 2, message: "Starting" });
      input.onProgress?.({ completed: 2, total: 2, message: "Done" });
      return {
        requirements: Array.from({ length: count }, (_, index) => requirement(index)),
        conflicts: [],
        openQuestions: [],
        version: 3,
        fingerprint: "fingerprint-under-test",
      };
    },
  );
  const args = {
    projectId: f.init.projectId,
    sourceRevisionIds: ["svr_019bf434-20c0-7000-8000-000000000001"],
  };
  const steps: { progress: number; total?: number }[] = [];
  const small = await f.client.callTool(
    { name: "testmaster_normalize_requirements", arguments: args },
    undefined,
    { onprogress: (step) => steps.push(step) },
  );
  expect(small.structuredContent).toMatchObject({
    sourceSnapshotId: "fingerprint-under-test",
    version: 3,
    resource: `testmaster://requirements/${f.init.projectId}`,
  });
  expect(steps.map((step) => [step.progress, step.total])).toEqual([
    [0, 2],
    [2, 2],
  ]);
  // Small results keep the complete JSON as text.
  const text = (small.content as { type: string; text?: string }[])[0]?.text;
  expect(JSON.parse(String(text))).toEqual(small.structuredContent);

  count = 120;
  const large = await f.client.callTool({
    name: "testmaster_normalize_requirements",
    arguments: args,
  });
  const content = large.content as { type: string; uri?: string; text?: string }[];
  expect(content.map((entry) => entry.type)).toEqual(["text", "resource_link"]);
  expect(content[1]?.uri).toBe(`testmaster://requirements/${f.init.projectId}`);
  expect(String(content[0]?.text).length).toBeLessThan(1000);
  // structuredContent stays complete.
  expect((large.structuredContent as { requirements: unknown[] }).requirements).toHaveLength(120);
});

it("drain resolves immediately when idle and only after in-flight calls answered", async () => {
  const f = await fixture();
  await f.server.drain();
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const prepared = f.app.runs.prepare({
    testId: test.id,
    environmentId: f.init.environmentId,
    mode: "replay",
  });
  const receipt = f.app.database.withTx(() => f.app.runs.insert(prepared, "drain-test-key-0001"));
  const started = Promise.withResolvers<void>();
  const slow = f.client.callTool(
    {
      name: "testmaster_get_run",
      arguments: { runId: receipt.runId, wait: true, timeoutMs: 600 },
    },
    undefined,
    { onprogress: () => started.resolve() },
  );
  await started.promise;
  let drained = false;
  const draining = f.server.drain().then(() => {
    drained = true;
  });
  await delay(100);
  expect(drained).toBe(false);
  const answered = await slow;
  await draining;
  expect(drained).toBe(true);
  expect(answered.isError).toBe(true);
});

it("propose_healing names its run runId and no longer accepts failedRunId", async () => {
  const f = await fixture();
  const old = await f.call("testmaster_propose_healing", { failedRunId: missingRun });
  expect(old.error?.code).toBe("INVALID_ARGUMENT");
  // The renamed argument passes validation and reaches the service, which does not know the run.
  const renamed = await f.call("testmaster_propose_healing", { runId: missingRun });
  expect(renamed.error?.code).toBe("NOT_FOUND");
});

it("a healing abstention is a normal MCP result while a not-indicated refusal is an error", async () => {
  const f = await fixture();
  const abstention = {
    abstained: true,
    failedRunId: missingRun,
    reasonCode: "model_abstained",
    reason: "The model found no safe test-only repair.",
    jobId: "job_01900000-0000-7000-8000-000000000001",
    modelCallId: "mdl_01900000-0000-7000-8000-000000000002",
    nextAction: "Repair the test by hand.",
  };
  vi.spyOn(HealingService.prototype, "propose").mockResolvedValueOnce(abstention);
  const settled = await f.client.callTool({
    name: "testmaster_propose_healing",
    arguments: { runId: missingRun },
  });
  expect(settled.isError).not.toBe(true);
  expect(settled.structuredContent).toEqual(abstention);
  expect((settled.content as { text: string }[])[0]?.text).toContain(
    "Healing abstained (model_abstained): The model found no safe test-only repair.",
  );
  // Control: a refusal before any model call stays an error that names its reason code.
  vi.spyOn(HealingService.prototype, "propose").mockRejectedValueOnce(
    new ContractError("PRECONDITION_FAILED", "Healing is not indicated", {
      reasonCode: "healing_not_indicated",
    }),
  );
  const refused = await f.call("testmaster_propose_healing", { runId: missingRun });
  expect(refused.isError).toBe(true);
  expect(refused.error).toMatchObject({
    code: "PRECONDITION_FAILED",
    details: { reasonCode: "healing_not_indicated" },
  });
});

it("a generated-code revision has no plan resource and names how to read its code", async () => {
  const f = await fixture();
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const base = f.app.revisions.get(String(test.activeRevisionId));
  // Positive control: a plan revision is served.
  const served = await f.client.readResource({ uri: `testmaster://revisions/${base.id}/plan` });
  expect(JSON.parse(String(served.contents[0]?.text))).not.toBeNull();
  const { id: _id, ...fields } = base;
  const generated = entity(f.app.context, "rev", {
    ...fields,
    ordinal: 2,
    plan: null,
    origin: "generated",
    contentHash: "b".repeat(64),
    parentId: base.id,
  });
  f.app.context.entities.insert("TestRevision", generated);
  await expect(
    f.client.readResource({ uri: `testmaster://revisions/${generated.id}/plan` }),
  ).rejects.toMatchObject({
    code: -32002,
    message: expect.stringContaining("generated code"),
  });
  await expect(
    f.client.readResource({ uri: `testmaster://revisions/${generated.id}/plan` }),
  ).rejects.toMatchObject({
    message: expect.stringContaining(
      `testmaster test export ${test.id} --revision ${generated.id}`,
    ),
  });
});

it("an unknown tool is a JSON-RPC invalid-params error, not a failed tool result", async () => {
  const f = await fixture();
  await expect(
    f.client.callTool({ name: "testmaster_no_such_tool", arguments: {} }),
  ).rejects.toMatchObject({ code: -32602 });
  expect(
    f.app.database.all("SELECT actor,resource_id FROM audit_events WHERE action='mcp.tool.denied'"),
  ).toEqual([{ actor: f.app.context.principalId, resource_id: "testmaster_no_such_tool" }]);
  // Control: a known tool still answers with a result.
  const known = await f.call("testmaster_capabilities", {});
  expect(known.isError).toBe(false);
});
