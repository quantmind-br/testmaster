import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Application, entity, HealingService, scaffoldPlan } from "@testmaster/application";
import { ContractError, jsonSchema, mcpToolCatalog, schemaCatalog } from "@testmaster/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpServer, listedTools } from "./server.js";

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

it("tools/list advertises described inputs and the annotation classes", async () => {
  const f = await fixture();
  const tools = (await f.client.listTools()).tools;
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

// The catalog size lock: the `tools/list` payload is one JSON-RPC response, so a client with a
// message limit or one that forwards it whole to a model pays every byte. The ceiling only goes
// down: lower it to the measured value (`node tools/surface-size.mjs`) after each shrink.
const TOOLS_LIST_CEILING_BYTES = 48_080;

it("tools/list serves the measured catalog and stays under the catalog size ceiling", async () => {
  const f = await fixture();
  const served = (await f.client.listTools()).tools;
  expect(served).toEqual(listedTools());
  const wireBytes = Buffer.byteLength(JSON.stringify({ tools: listedTools() }));
  expect(wireBytes).toBeLessThanOrEqual(TOOLS_LIST_CEILING_BYTES);
});

/** Every object node of a JSON Schema document. */
function* schemaNodes(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) yield* schemaNodes(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  yield node;
  for (const child of Object.values(node)) yield* schemaNodes(child);
}

it("no announced schema inlines the ExecutablePlan contract and none exceeds 12 KB", () => {
  // The plan contract is served as a resource (tool-rules.ts); inlining it adds about 254 KB to
  // every schema that reaches it. Its fingerprint is its exact set of top-level properties.
  const plan = (schemaCatalog.ExecutablePlan as { properties: Record<string, unknown> }).properties;
  const fingerprint = Object.keys(plan).sort().join(",");
  const offenders = listedTools().flatMap((tool) =>
    Object.entries(tool)
      .filter(([key]) => key.endsWith("Schema"))
      .flatMap(([key, schema]) => {
        const bytes = Buffer.byteLength(JSON.stringify(schema));
        const inlined = [...schemaNodes(schema)].some(
          (node) =>
            node.properties !== null &&
            typeof node.properties === "object" &&
            Object.keys(node.properties).sort().join(",") === fingerprint,
        );
        return [
          ...(inlined ? [`${tool.name}.${key} inlines ExecutablePlan`] : []),
          ...(bytes > 12 * 1024 ? [`${tool.name}.${key} is ${bytes} bytes`] : []),
        ];
      }),
  );
  expect(offenders).toEqual([]);
});

it("a tool's rules page names its result contract, and that contract is served as a schema", async () => {
  const f = await fixture();
  const read = async (uri: string) =>
    String((await f.client.readResource({ uri })).contents[0]?.text);
  const rules = await read("testmaster://tools/testmaster_capabilities");
  expect(rules).toContain(
    "is a `CapabilityManifest`: its JSON Schema is testmaster://schemas/CapabilityManifest.",
  );
  const schema = JSON.parse(await read("testmaster://schemas/CapabilityManifest"));
  expect(schema).toEqual(jsonSchema("CapabilityManifest"));
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
  expect(initRoot.body.proposedConfig).toMatchObject({
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

it("init binds its root, so bootstrap finds that project without the config file, and init again writes the file", async () => {
  const f = await fixture();
  const configFile = join(await realpath(f.cwd), "testmaster.config.json");
  const bootstrap = () =>
    f.call("testmaster_bootstrap", {
      projectRoot: f.cwd,
      target: "http://127.0.0.1:3000",
      scope: ["codebase"],
      mode: "replay",
    });
  await rm(configFile);
  const found = await bootstrap();
  expect(found.body.projectId).toBe(f.init.projectId);
  expect(f.app.projects.list()).toHaveLength(1);
  expect(found.body.preflight).toContainEqual({ check: "config_file_present", passed: false });
  expect(JSON.stringify(found.body.nextActions)).toContain(`Write proposedConfig as ${configFile}`);
  // A repeated init writes the missing file for the same project, with its environment's origin.
  expect(await f.app.init()).toMatchObject({
    projectId: f.init.projectId,
    environmentId: f.init.environmentId,
    configWritten: true,
  });
  expect(JSON.parse(await readFile(configFile, "utf8"))).toMatchObject({
    project: { id: f.init.projectId },
    environment: { baseUrl: "http://127.0.0.1:3000" },
  });
  // Control: an existing file is kept, and bootstrap then finds it.
  expect((await f.app.init()).configWritten).toBe(false);
  expect((await bootstrap()).body.preflight).toContainEqual({
    check: "config_file_present",
    passed: true,
  });
});

it("bootstrap reports an environment aimed at another origin with the exact update call and never retargets it", async () => {
  const f = await fixture();
  const target = "http://127.0.0.1:20311";
  const bootstrap = (url: string) =>
    f.call("testmaster_bootstrap", {
      projectRoot: f.cwd,
      target: url,
      scope: ["codebase"],
      mode: "replay",
    });
  const environment = f.app.environments.get(f.init.environmentId);
  const moved = await bootstrap(target);
  expect(moved.isError).toBe(false);
  expect(moved.body.preflight).toContainEqual({
    check: "environment_targets_target",
    passed: false,
  });
  expect(moved.body).not.toHaveProperty("environment");
  // The receipt's config is a proposal for testmaster.config.json, not the stored environment: it
  // names the requested target while the environment (and the file) keep their own origin.
  expect(moved.body).not.toHaveProperty("config");
  expect(moved.body.proposedConfig).toMatchObject({ environment: { baseUrl: target } });
  expect(JSON.stringify(moved.body.nextActions)).toContain(
    `testmaster_update_environment {environmentId: ${environment.id}, expectedVersion: ${environment.version}, baseUrl: ${target}}`,
  );
  const revisions = f.app.environments.revisions(environment.id);
  expect(revisions).toHaveLength(1);
  expect(revisions[0]?.targetOrigins).toEqual(["http://127.0.0.1:3000"]);
  expect(f.app.environments.list(f.init.projectId)).toHaveLength(1);
  // Control: the origin the environment does target passes and names that environment.
  const same = await bootstrap("http://127.0.0.1:3000");
  expect(same.body.preflight).toContainEqual({
    check: "environment_targets_target",
    passed: true,
  });
  expect(same.body.environment).toMatchObject({ id: environment.id, created: false });
});

it("bootstrap gives a project without an environment one for the target, once", async () => {
  const f = await fixture();
  const target = "http://127.0.0.1:20311";
  await mkdir(join(f.cwd, "bare"));
  const bootstrap = () =>
    f.call("testmaster_bootstrap", {
      projectRoot: join(f.cwd, "bare"),
      target,
      scope: ["codebase"],
      mode: "replay",
    });
  const first = await bootstrap();
  expect(first.isError).toBe(false);
  const projectId = String(first.body.projectId);
  const [created] = f.app.environments.list(projectId);
  expect(created).toBeDefined();
  expect(first.body.environment).toMatchObject({ id: created?.id, name: "local", created: true });
  expect(first.body.preflight).toContainEqual({
    check: "environment_targets_target",
    passed: true,
  });
  expect(f.app.environments.revisions(String(created?.id))[0]?.targetOrigins).toEqual([target]);
  expect(f.app.projects.get(projectId).defaultEnvironmentId).toBe(created?.id);
  const second = await bootstrap();
  expect(second.body.environment).toMatchObject({ id: created?.id, created: false });
  expect(f.app.environments.list(projectId)).toHaveLength(1);
});

it("an unknown resource names the URI and the template that reads what was meant", async () => {
  const f = await fixture();
  const guessed =
    "testmaster://tests/tst_019bf434-20c0-7000-8000-000000000001/revisions/rev_019bf434-20c0-7000-8000-000000000001";
  await expect(f.client.readResource({ uri: guessed })).rejects.toMatchObject({
    code: -32002,
    message: expect.stringContaining(guessed),
  });
  await expect(f.client.readResource({ uri: guessed })).rejects.toMatchObject({
    message: expect.stringContaining("testmaster://revisions/{id}"),
  });
  // The requirements of a project are not under projects/{id}.
  await expect(
    f.client.readResource({
      uri: `testmaster://projects/${f.init.projectId}/requirements`,
    }),
  ).rejects.toMatchObject({
    code: -32002,
    message: expect.stringContaining("testmaster://requirements/{projectId}"),
  });
  // The echoed URI is bounded.
  const long = `testmaster://nowhere/${"x".repeat(5000)}`;
  const error = await f.client.readResource({ uri: long }).catch((caught: Error) => caught);
  expect(error).toMatchObject({ code: -32002 });
  expect((error as Error).message.length).toBeLessThan(800);
});

it("report resources are text pages with the paging in _meta", async () => {
  const f = await fixture();
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const run = f.app.runs.resolve({ testId: test.id, environmentId: f.init.environmentId });
  Object.assign(run, { phase: "completed", status: "passed", outcome: "passed", gate: "passed" });
  f.app.context.entities.insert("Run", run);
  // "é" takes two bytes and the prefix is 11 bytes, so a 32768-byte page ends inside a character
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
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32768);
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

it("an artifact resource reads the same bytes whether the path has plain slashes or encoded ones, and confines the lookup", async () => {
  const f = await fixture();
  const manifest: Record<string, Buffer> = {
    "browser/steps/x.json": Buffer.from('{"k":"plain and encoded"}'),
    "a.json": Buffer.from('{"top":true}'),
  };
  const asked: string[] = [];
  vi.spyOn(Object.getPrototypeOf(f.app.artifacts), "read").mockImplementation((async (
    _runId: string,
    path: string,
    options: { offset?: number } = {},
  ) => {
    asked.push(path);
    // The service looks the path up by exact match in the manifest, so no other path reads anything.
    const bytes = manifest[path];
    if (!bytes) throw new ContractError("NOT_FOUND", "Artifact is unavailable");
    const offset = options.offset ?? 0;
    const page = bytes.subarray(offset, offset + 10);
    return {
      bytes: page,
      entry: { relativePath: path, mimeType: "application/json", sizeBytes: bytes.length },
      nextOffset: offset + page.length < bytes.length ? offset + page.length : null,
    };
  }) as never);
  const base = `testmaster://runs/${missingRun}/artifacts`;
  const read = async (uri: string) =>
    (await f.client.readResource({ uri })).contents[0] as Record<string, unknown>;

  const encoded = await read(`${base}/${encodeURIComponent("browser/steps/x.json")}`);
  const plain = await read(`${base}/browser/steps/x.json`);
  expect(plain.text).toBe(encoded.text);
  expect(plain.text).toBe('{"k":"plai'); // the first 10 bytes: the mock serves 10-byte pages
  expect(asked).toEqual(["browser/steps/x.json", "browser/steps/x.json"]);
  // The page link keeps the encoded form whichever form was asked.
  const link = (plain._meta as Record<string, string>)["testmaster:next"];
  expect(link).toContain(`/artifacts/${encodeURIComponent("browser/steps/x.json")}?`);
  expect(String((await read(String(link))).text)).toBe("n and enco");
  // A one-segment path still reads.
  expect((await read(`${base}/a.json`)).text).toBe('{"top":tru');

  // Traversal and empty segments find nothing, in either form.
  for (const refused of [
    `${base}/browser%2F..%2F..%2Fa.json`,
    `${base}/browser/steps/..%2Fsteps%2Fx.json`,
    `${base}/browser//steps/x.json`,
    `${base}/browser/steps/x.json/`,
    `${base}/%2E%2E%2Fa.json`,
  ])
    await expect(read(refused), refused).rejects.toMatchObject({ code: -32002 });
  // The bare collection is no resource.
  await expect(read(base)).rejects.toMatchObject({ code: -32002 });
});

it("the artifact and code-file templates are advertised with reserved expansion", async () => {
  const f = await fixture();
  const templates = (await f.client.listResourceTemplates()).resourceTemplates.map(
    (template) => template.uriTemplate,
  );
  expect(templates).toContain("testmaster://runs/{id}/artifacts/{+path}{?attemptId,offset}");
  expect(templates).toContain("testmaster://revisions/{id}/code/{+path}{?format,offset}");
  expect(templates).toContain("testmaster://schemas/{name}{?offset}");
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

it("the features resource lists the features of the latest full analysis and keeps the others stored", async () => {
  const f = await fixture();
  const analyze = async (paths: string[]) => {
    const routes = paths.map((path) => `app.get('${path}', () => {});`);
    await writeFile(join(f.cwd, "server.ts"), `const app = {};\n${routes.join("\n")}\n`);
    const analyzed = await f.call("testmaster_analyze_code", {
      projectId: f.init.projectId,
      root: f.cwd,
    });
    expect(analyzed.isError, JSON.stringify(analyzed.body)).toBe(false);
    return analyzed.body as { features: { id: string; stableKey: string }[] };
  };
  const base = `testmaster://projects/${f.init.projectId}/features`;
  const read = async (uri: string) =>
    JSON.parse(String((await f.client.readResource({ uri })).contents[0]?.text)) as {
      total: number;
      features: { id: string; stableKey: string }[];
    };
  const keys = (page: { features: { stableKey: string }[] }) =>
    page.features.map((feature) => feature.stableKey);

  const first = await analyze(["/a", "/b"]);
  const a = first.features.find((feature) => feature.stableKey === "endpoint:GET:/a");
  expect(keys(await read(base))).toEqual(["endpoint:GET:/a", "endpoint:GET:/b"]);

  // A later full analysis finds /b and /c: /a is no longer listed, /b keeps its id.
  const second = await analyze(["/b", "/c"]);
  const listed = await read(base);
  expect(keys(listed)).toEqual(["endpoint:GET:/b", "endpoint:GET:/c"]);
  expect(listed.total).toBe(2);
  expect(listed.features).toEqual(
    second.features.slice().sort((x, y) => x.stableKey.localeCompare(y.stableKey)),
  );
  expect(keys(await read(`${base}?match=endpoint:get:/b`))).toEqual(["endpoint:GET:/b"]);
  expect(keys(await read(`${base}?match=/a`))).toEqual([]);

  // The stale feature is hidden, not deleted: requirements and explorations still cite its id.
  expect(a).toBeDefined();
  expect(
    f.app.context.entities.get("Feature", f.app.context.workspaceId, String(a?.id))?.stableKey,
  ).toBe("endpoint:GET:/a");

  // A feature that comes back is listed again under its original id.
  const third = await analyze(["/a"]);
  expect(third.features).toEqual([a]);
  expect(keys(await read(base))).toEqual(["endpoint:GET:/a"]);
});

it("no tool input is a top-level combinator, generate_tests shows every property and normalize takes a provider", async () => {
  const f = await fixture();
  const tools = (await f.client.listTools()).tools;
  expect(tools).toHaveLength(mcpToolCatalog.length);
  for (const tool of tools) {
    for (const keyword of ["anyOf", "oneOf", "allOf", "not"])
      expect(tool.inputSchema, `${tool.name} ${keyword}`).not.toHaveProperty(keyword);
  }
  const input = (name: string) => tools.find((tool) => tool.name === name)?.inputSchema;
  expect(Object.keys(input("testmaster_generate_tests")?.properties ?? {}).sort()).toEqual([
    "model",
    "proposalIds",
    "provider",
    "revisionIds",
    "runId",
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
  // Control: revisionIds with provider and model passes validation and fails on the unknown revision.
  const withRevisions = await f.call("testmaster_generate_tests", {
    revisionIds: ["rev_019bf434-20c0-7000-8000-000000000001"],
    provider: "p",
    model: "m",
  });
  expect(withRevisions.error?.code).toBe("NOT_FOUND");
  // runId repairs one failed candidate alone; with revisionIds it is refused before any lookup.
  const mixed = await f.call("testmaster_generate_tests", {
    runId: "run_019bf434-20c0-7000-8000-000000000001",
    revisionIds: ["rev_019bf434-20c0-7000-8000-000000000001"],
  });
  expect(mixed.error?.code).toBe("INVALID_ARGUMENT");
  expect(mixed.error?.details.issues).toEqual([expect.objectContaining({ path: "/runId" })]);
  // Control: runId alone passes validation and fails on the unknown run.
  const repair = await f.call("testmaster_generate_tests", {
    runId: "run_019bf434-20c0-7000-8000-000000000001",
  });
  expect(repair.error?.code).toBe("NOT_FOUND");
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

it("generate_plan advertises provider and forwards provider and model to the service", async () => {
  const f = await fixture();
  const properties = (await f.client.listTools()).tools.find(
    (tool) => tool.name === "testmaster_generate_plan",
  )?.inputSchema.properties;
  expect(Object.keys(properties ?? {})).toEqual(expect.arrayContaining(["provider", "model"]));
  const generate = vi
    .spyOn(Object.getPrototypeOf(f.app.proposals), "generate")
    .mockRejectedValue(new ContractError("PRECONDITION_FAILED", "stop here"));
  await f.call("testmaster_generate_plan", {
    projectId: f.init.projectId,
    sourceSnapshotId: "fingerprint-1",
    type: "backend",
    provider: "gateway",
    model: "m1",
  });
  expect(generate).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "gateway", model: "m1" }),
  );
});

it("generate_plan returns the location of the proposals next to the batch, and that location serves them", async () => {
  const f = await fixture();
  const batch = entity(f.app.context, "pbt", {
    projectId: f.init.projectId,
    sourceSnapshotId: "fingerprint-1",
    version: 1,
    state: "proposed",
  });
  f.app.context.entities.insert("ProposalBatch", batch);
  const proposal = entity(f.app.context, "pro", {
    batchId: batch.id,
    plan: scaffoldPlan("backend"),
    requirementRefs: [],
    evidenceRefs: [],
    warnings: [],
    state: "proposed",
  });
  f.app.context.entities.insert("Proposal", proposal);
  vi.spyOn(Object.getPrototypeOf(f.app.proposals), "generate").mockResolvedValue(batch as never);
  const planned = await f.call("testmaster_generate_plan", {
    projectId: f.init.projectId,
    sourceSnapshotId: "fingerprint-1",
    type: "backend",
  });
  expect(planned.isError, JSON.stringify(planned.body)).toBe(false);
  expect(planned.body).toMatchObject({
    id: batch.id,
    version: 1,
    state: "proposed",
    resource: `testmaster://plan-batches/${batch.id}`,
  });
  const served = await readJson<{ proposals: { id: string }[] }>(f, String(planned.body.resource));
  expect(served.proposals.map((item) => item.id)).toEqual([proposal.id]);
  const description =
    (await f.client.listTools()).tools.find((tool) => tool.name === "testmaster_generate_plan")
      ?.description ?? "";
  expect(description).toContain("testmaster://plan-batches/{batchId}");
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
    budget: { steps: 5, timeMs: 60000 },
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
    budget: { steps: 5, timeMs: 60000 },
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

it("generate_tests names the test and the proposal of every candidate it returns", async () => {
  const f = await fixture();
  const alpha = f.app.tests.create({
    projectId: f.init.projectId,
    plan: scaffoldPlan("backend"),
    name: "Alpha",
  });
  const beta = f.app.tests.create({
    projectId: f.init.projectId,
    plan: scaffoldPlan("backend"),
    name: "Beta",
  });
  const alphaRevision = String(alpha.activeRevisionId);
  const betaRevision = String(beta.activeRevisionId);
  const batch = entity(f.app.context, "pbt", {
    projectId: f.init.projectId,
    sourceSnapshotId: "snapshot-fingerprint",
    version: 1,
    state: "proposed",
  });
  f.app.context.entities.insert("ProposalBatch", batch);
  const proposal = entity(f.app.context, "pro", {
    batchId: batch.id,
    plan: scaffoldPlan("backend"),
    requirementRefs: [],
    evidenceRefs: [{ relativePath: "spec.md" }],
    warnings: [],
    state: "accepted",
    validation: "valid",
    extensions: { "testmaster:candidateRevisionId": alphaRevision },
  });
  f.app.context.entities.insert("Proposal", proposal);
  const created = (id: string, testId: string, parentId: string) => ({
    id,
    workspaceId: f.init.workspaceId,
    testId,
    parentId,
  });
  vi.spyOn(Object.getPrototypeOf(f.app.codeGeneration), "generate").mockResolvedValue({
    requested: 2,
    candidates: [
      created("rev_019bf434-20c0-7000-8000-0000000000a1", alpha.id, alphaRevision),
      created("rev_019bf434-20c0-7000-8000-0000000000b2", beta.id, betaRevision),
    ],
    validationErrors: [],
  });
  const generated = await f.call("testmaster_generate_tests", {
    proposalIds: [proposal.id],
    revisionIds: [betaRevision],
  });
  expect(generated.isError, generated.text).toBe(false);
  // One entry per candidate: the test it belongs to and, when it came from one, the proposal.
  expect(generated.body.candidates).toEqual([
    {
      id: "rev_019bf434-20c0-7000-8000-0000000000a1",
      testId: alpha.id,
      testName: "Alpha",
      sourceRevisionId: alphaRevision,
      proposalId: proposal.id,
      code: "testmaster://revisions/rev_019bf434-20c0-7000-8000-0000000000a1/code",
    },
    {
      id: "rev_019bf434-20c0-7000-8000-0000000000b2",
      testId: beta.id,
      testName: "Beta",
      sourceRevisionId: betaRevision,
      code: "testmaster://revisions/rev_019bf434-20c0-7000-8000-0000000000b2/code",
    },
  ]);
  // The code of each candidate is also a resource link, so a client lists where to read it.
  const links = (generated.result.content as { type: string; uri?: string; name?: string }[])
    .filter((entry) => entry.type === "resource_link")
    .map(({ uri, name }) => [uri, name]);
  expect(links).toEqual([
    [
      "testmaster://revisions/rev_019bf434-20c0-7000-8000-0000000000a1/code",
      "Generated code of Alpha",
    ],
    [
      "testmaster://revisions/rev_019bf434-20c0-7000-8000-0000000000b2/code",
      "Generated code of Beta",
    ],
  ]);
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

it("get_run names the test, revision, environment revision, mode and origin of the run it summarizes", async () => {
  const f = await fixture();
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const prepared = f.app.runs.prepare({
    testId: test.id,
    environmentId: f.init.environmentId,
    mode: "replay",
    origin: "verification",
  });
  const receipt = f.app.database.withTx(() =>
    f.app.runs.insert(prepared, "get-run-identity-key-01"),
  );
  const recorded = f.app.runs.get(receipt.runId);
  const summary = await f.call("testmaster_get_run", { runId: receipt.runId });
  expect(summary.isError).toBe(false);
  expect(summary.body).toMatchObject({
    runId: receipt.runId,
    testId: test.id,
    revisionId: recorded.revisionId,
    environmentRevisionId: recorded.environmentRevisionId,
    mode: "replay",
    origin: "verification",
  });
  expect(summary.body).not.toHaveProperty("steps");
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
    message: expect.stringContaining(`testmaster://revisions/${generated.id}/code`),
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

it("audits a tool error of an admitted call as failed and a refused call as denied", async () => {
  const f = await fixture();
  const missing = await f.call("testmaster_get_analysis", {
    runId: "run_01900000-0000-7000-8000-000000000001",
  });
  expect(missing.isError).toBe(true);
  const malformed = await f.call("testmaster_capabilities", { command: "touch denied" });
  expect(malformed.isError).toBe(true);
  expect(
    f.app.database.all(
      "SELECT action,resource_id FROM audit_events WHERE action LIKE 'mcp.tool.%' ORDER BY rowid",
    ),
  ).toEqual([
    { action: "mcp.tool.failed", resource_id: "testmaster_get_analysis" },
    { action: "mcp.tool.denied", resource_id: "testmaster_capabilities" },
  ]);
});

async function readJson<T>(f: { client: Client }, uri: string): Promise<T> {
  return JSON.parse(String((await f.client.readResource({ uri })).contents[0]?.text)) as T;
}
/** Every page of a list resource, following `next` from the first URI. */
async function readPages<Page extends { next: string | null }>(
  f: { client: Client },
  uri: string,
): Promise<Page[]> {
  const pages: Page[] = [];
  for (let next: string | null = uri; next; ) {
    const page: Page = await readJson<Page>(f, next);
    pages.push(page);
    next = page.next;
  }
  return pages;
}

it("the revision resources serve the revision and every file of its code as text pages", async () => {
  const f = await fixture();
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const revisionId = String(test.activeRevisionId);
  const revision = await readJson<Record<string, unknown>>(
    f,
    `testmaster://revisions/${revisionId}`,
  );
  expect(revision).toMatchObject({
    id: revisionId,
    testId: test.id,
    resources: {
      plan: `testmaster://revisions/${revisionId}/plan`,
      code: `testmaster://revisions/${revisionId}/code`,
    },
  });

  const exported = await f.app.codeExport.export(test.id, { format: "playwright", revisionId });
  const index = await readJson<{
    testId: string;
    revisionId: string;
    format: string;
    files: {
      path: string;
      sizeBytes: number;
      sha256: string;
      resource: string;
      content: string | null;
    }[];
    inlineLimitBytes: number;
  }>(f, `testmaster://revisions/${revisionId}/code`);
  expect(index).toMatchObject({ testId: test.id, revisionId, format: "playwright" });
  expect(index.files.map((entry) => entry.path).sort()).toEqual(Object.keys(exported.files).sort());
  // A file carries its text while the listing still fits one resource page; any other file is
  // read through its resource below.
  for (const entry of index.files)
    if (entry.content !== null) expect(entry.content, entry.path).toBe(exported.files[entry.path]);
  // Each listed file reads back, page by page, as exactly the bytes the export holds.
  for (const entry of index.files) {
    let text = "";
    for (let next: string | null = entry.resource; next; ) {
      const page = (await f.client.readResource({ uri: next })).contents[0] as Record<
        string,
        unknown
      >;
      expect(page.mimeType).toBe("text/plain");
      expect(Buffer.byteLength(String(page.text))).toBeLessThanOrEqual(32768);
      text += String(page.text);
      next = (page._meta as Record<string, string | null>)["testmaster:next"] ?? null;
    }
    expect(text, entry.path).toBe(exported.files[entry.path]);
    expect(Buffer.byteLength(text), entry.path).toBe(entry.sizeBytes);
    expect(createHash("sha256").update(text).digest("hex"), entry.path).toBe(entry.sha256);
  }

  // A plan revision exports to either framework; an unknown one and an unknown file are refused.
  const pytest = await readJson<{ format: string; metadata: { entrypoint: string } }>(
    f,
    `testmaster://revisions/${revisionId}/code?format=pytest`,
  );
  expect(pytest.format).toBe("pytest");
  expect(pytest.metadata.entrypoint).toMatch(/\.py$/);
  await expect(
    f.client.readResource({ uri: `testmaster://revisions/${revisionId}/code?format=ruby` }),
  ).rejects.toMatchObject({ code: -32602 });
  await expect(
    f.client.readResource({
      uri: `testmaster://revisions/${revisionId}/code/${encodeURIComponent("no-such-file.txt")}`,
    }),
  ).rejects.toMatchObject({ code: -32002 });
  await expect(
    f.client.readResource({
      uri: "testmaster://revisions/rev_019bf434-20c0-7000-8000-000000000001/code",
    }),
  ).rejects.toMatchObject({ code: -32002 });
});

it("the code listing carries file text only while it fits one resource page and links the rest", async () => {
  const f = await fixture();
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const revisionId = String(test.activeRevisionId);
  const files = { "a.ts": "a".repeat(20000), "b.ts": "b".repeat(20000), "c.ts": "tiny" };
  vi.spyOn(Object.getPrototypeOf(f.app.codeExport), "export").mockResolvedValue({
    testId: test.id,
    revisionId,
    format: "playwright",
    files,
    metadata: { entrypoint: "a.ts" },
  } as never);
  const uri = `testmaster://revisions/${revisionId}/code`;
  const text = String((await f.client.readResource({ uri })).contents[0]?.text);
  const index = JSON.parse(text) as {
    inlineLimitBytes: number;
    files: { path: string; content: string | null; resource: string }[];
  };
  expect(index.inlineLimitBytes).toBe(32768);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32768);
  // The second file would pass the page: it is linked, and the small one after it still fits.
  expect(index.files.map((entry) => [entry.path, entry.content?.length ?? null])).toEqual([
    ["a.ts", 20000],
    ["b.ts", null],
    ["c.ts", 4],
  ]);
  expect(index.files[1]?.resource).toContain(encodeURIComponent("b.ts"));
});

it("a revision code file reads the same text whether the path has plain slashes or encoded ones, and confines the lookup", async () => {
  const f = await fixture();
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const revisionId = String(test.activeRevisionId);
  vi.spyOn(Object.getPrototypeOf(f.app.codeExport), "export").mockResolvedValue({
    testId: test.id,
    revisionId,
    format: "playwright",
    files: { "tests/nested/a.spec.ts": "export const nested = 1;\n", "b.ts": "top" },
    metadata: { entrypoint: "b.ts" },
  } as never);
  const read = async (uri: string) =>
    (await f.client.readResource({ uri })).contents[0] as Record<string, unknown>;
  const base = `testmaster://revisions/${revisionId}/code`;

  const encoded = await read(`${base}/${encodeURIComponent("tests/nested/a.spec.ts")}`);
  const plain = await read(`${base}/tests/nested/a.spec.ts`);
  expect(plain.text).toBe("export const nested = 1;\n");
  expect({ text: plain.text, mimeType: plain.mimeType, meta: plain._meta }).toEqual({
    text: encoded.text,
    mimeType: encoded.mimeType,
    meta: encoded._meta,
  });
  expect((await read(`${base}/b.ts`)).text).toBe("top");

  for (const refused of [
    `${base}/tests%2F..%2Fb.ts`,
    `${base}/tests/nested/..%2F..%2Fb.ts`,
    `${base}/tests//nested/a.spec.ts`,
    `${base}/tests/nested/a.spec.ts/`,
  ])
    await expect(read(refused), refused).rejects.toMatchObject({ code: -32002 });
});

it("the steps resource pages the steps of a run, narrows to one attempt and binds its cursor", async () => {
  const f = await fixture();
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const run = f.app.runs.resolve({ testId: test.id, environmentId: f.init.environmentId });
  f.app.context.entities.insert("Run", run);
  await expect(
    f.client.readResource({ uri: `testmaster://runs/${missingRun}/steps` }),
  ).rejects.toMatchObject({ code: -32002 });

  const steps = Array.from({ length: 120 }, (_, index) => ({ id: `step-${index}`, index }));
  const asked: (string | undefined)[] = [];
  vi.spyOn(Object.getPrototypeOf(f.app.runs), "steps").mockImplementation(((
    _id: string,
    attemptId?: string,
  ) => {
    asked.push(attemptId);
    return attemptId ? steps.slice(0, 3) : steps;
  }) as never);
  type Page = { total: number; steps: { id: string }[]; next: string | null; attemptId?: string };
  const base = `testmaster://runs/${run.id}/steps`;
  const pages = await readPages<Page>(f, base);
  expect(pages.map((page) => page.steps.length)).toEqual([50, 50, 20]);
  expect(pages.every((page) => page.total === 120)).toBe(true);
  expect(pages.flatMap((page) => page.steps.map((step) => step.id))).toEqual(
    steps.map((step) => step.id),
  );
  // One attempt: the id reaches the service, is echoed and the list is that attempt's.
  const attempt = await readJson<Page>(f, `${base}?attemptId=att_one`);
  expect(asked.at(-1)).toBe("att_one");
  expect(attempt).toMatchObject({ total: 3, attemptId: "att_one", next: null });
  // A cursor belongs to the list it was issued for.
  const first = await readJson<Page>(f, base);
  await expect(
    f.client.readResource({
      uri: `${base}?attemptId=att_one&cursor=${encodeURIComponent(String(new URL(String(first.next)).searchParams.get("cursor")))}`,
    }),
  ).rejects.toMatchObject({ code: -32602 });
});

it("the report resource serves junit, markdown and html as text and refuses allure and unknown formats", async () => {
  const f = await fixture();
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const run = f.app.runs.resolve({ testId: test.id, environmentId: f.init.environmentId });
  Object.assign(run, { phase: "completed", status: "passed", outcome: "passed", gate: "passed" });
  f.app.context.entities.insert("Run", run);
  // "é" takes two bytes: the junit document needs several pages, each cut on a character boundary.
  const documents: Record<string, string> = {
    json: JSON.stringify({ report: "json" }),
    junit: `<testsuites>${"é".repeat(70000)}</testsuites>`,
    markdown: "# Report",
    html: "<html></html>",
  };
  const exported = vi
    .spyOn(Object.getPrototypeOf(f.app.reports), "export")
    .mockImplementation((async (_id: string, format: string) => ({
      content: documents[format],
    })) as never);
  const base = `testmaster://runs/${run.id}/report`;
  const text = async (uri: string) =>
    (await f.client.readResource({ uri })).contents[0] as Record<string, unknown>;

  expect((await text(base)).mimeType).toBe("application/json");
  expect(exported).toHaveBeenLastCalledWith(run.id, "json");
  const markdown = await text(`${base}?format=markdown`);
  expect(markdown).toMatchObject({ mimeType: "text/markdown", text: "# Report" });
  expect((await text(`${base}?format=html`)).mimeType).toBe("text/html");

  const pages: string[] = [];
  let next: string | null = `${base}?format=junit`;
  while (next) {
    const page = await text(next);
    expect(page.mimeType).toBe("application/xml");
    expect(String(page.text)).not.toContain("\uFFFD");
    pages.push(String(page.text));
    next = (page._meta as Record<string, string | null>)["testmaster:next"] ?? null;
  }
  expect(exported).toHaveBeenLastCalledWith(run.id, "junit");
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.join("")).toBe(documents.junit);

  // Allure is a directory of files and an unknown format has no document: both are refused.
  for (const format of ["allure", "docx"])
    await expect(text(`${base}?format=${format}`)).rejects.toMatchObject({ code: -32602 });
  // A cursor belongs to the format it was issued for.
  const junit = await text(`${base}?format=junit`);
  const cursor = new URL(
    String((junit._meta as Record<string, string>)["testmaster:next"]),
  ).searchParams.get("cursor");
  await expect(
    text(`${base}?format=markdown&cursor=${encodeURIComponent(String(cursor))}`),
  ).rejects.toMatchObject({ code: -32602 });
});

it("open_report names each format's size and its paging rule, and offset pages concatenate to the exported document", async () => {
  const f = await fixture();
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const run = f.app.runs.resolve({ testId: test.id, environmentId: f.init.environmentId });
  Object.assign(run, { phase: "completed", status: "passed", outcome: "passed", gate: "passed" });
  f.app.context.entities.insert("Run", run);
  // "é" takes two bytes: json and junit each need several pages, and cuts land on boundaries.
  const documents: Record<string, string> = {
    json: JSON.stringify({ report: "é".repeat(40000), end: "json" }),
    junit: `<testsuites>${"é".repeat(70000)}</testsuites>`,
    markdown: "# Report",
    html: "<html></html>",
  };
  vi.spyOn(Object.getPrototypeOf(f.app.reports), "export").mockImplementation((async (
    _id: string,
    format: string,
  ) => ({ content: documents[format] })) as never);
  const base = `testmaster://runs/${run.id}/report`;
  const read = async (uri: string) =>
    (await f.client.readResource({ uri })).contents[0] as Record<string, unknown>;

  const opened = await f.call("testmaster_open_report", { runId: run.id });
  expect(opened.isError).toBe(false);
  const receipt = opened.body as {
    location: string;
    formats: Record<string, string>;
    sizes: Record<string, number>;
    paging: { pageBytes: number; rule: string };
  };
  expect(receipt.location).toBe(base);
  expect(receipt.formats.junit).toBe(`${base}?format=junit`);
  expect(receipt.sizes).toEqual({
    json: Buffer.byteLength(documents.json as string),
    markdown: 8,
    html: 13,
    junit: Buffer.byteLength(documents.junit as string),
  });
  expect(receipt.sizes.junit).toBeGreaterThan(receipt.paging.pageBytes);
  expect(receipt.paging.pageBytes).toBe(32768);
  expect(receipt.paging.rule).toContain("offset=0");
  expect(receipt.paging.rule).toContain("sizes[format]");

  // The rule, followed from the text alone: offset 0, then plus the bytes of the page read.
  for (const format of ["json", "junit"] as const) {
    const uri = (offset: number) =>
      `${receipt.formats[format]}${format === "json" ? "?" : "&"}offset=${offset}`;
    let text = "";
    let offset = 0;
    let pages = 0;
    while (offset < (receipt.sizes[format] as number)) {
      const page = await read(uri(offset));
      const bytes = Buffer.byteLength(String(page.text));
      expect(bytes, format).toBeGreaterThan(0);
      expect(bytes, format).toBeLessThanOrEqual(receipt.paging.pageBytes);
      expect((page._meta as Record<string, unknown>)["testmaster:sha256"], format).toBe(
        createHash("sha256")
          .update(documents[format] as string)
          .digest("hex"),
      );
      text += String(page.text);
      offset += bytes;
      pages++;
    }
    expect(pages, format).toBeGreaterThan(1);
    expect(text, format).toBe(documents[format]);
    expect(offset, format).toBe(receipt.sizes[format]);
    // At the size the document is read to its end.
    const end = await read(uri(offset));
    expect(end.text).toBe("");
    expect((end._meta as Record<string, unknown>)["testmaster:next"]).toBeNull();
    // Past the size, a negative or a non-numeric offset are refused.
    for (const bad of [String(offset + 1), "-1", "1.5", "abc"])
      await expect(
        read(`${receipt.formats[format]}${format === "json" ? "?" : "&"}offset=${bad}`),
      ).rejects.toMatchObject({ code: -32602 });
  }

  // A page link built from offset reads the next offset page without a cursor expiry.
  const first = await read(`${base}?format=junit&offset=0`);
  const link = new URL(String((first._meta as Record<string, unknown>)["testmaster:next"]));
  expect(link.searchParams.get("offset")).toBe(String(Buffer.byteLength(String(first.text))));
  expect(link.searchParams.get("format")).toBe("junit");
  expect(link.searchParams.has("expires")).toBe(false);
  expect(link.searchParams.has("cursor")).toBe(false);
  // The cursor still pages a report, and offset and cursor are not sent together.
  const viaCursor = await read(`${base}?format=junit`);
  const cursorLink = new URL(
    String((viaCursor._meta as Record<string, unknown>)["testmaster:next"]),
  );
  expect(cursorLink.searchParams.has("cursor")).toBe(true);
  await expect(read(`${cursorLink.href}&offset=0`)).rejects.toMatchObject({ code: -32602 });
  // A document within one page reads whole.
  expect((await read(`${base}?format=markdown&offset=0`)).text).toBe("# Report");
});

it("the tests resource lists a project's tests, narrows them like test list and pages", async () => {
  const f = await fixture();
  const plan = scaffoldPlan("backend");
  const make = (name: string, extra: { tags?: string[]; priority?: "critical" } = {}) =>
    f.app.tests.create({ projectId: f.init.projectId, plan, name, ...extra });
  const login = make("login", { tags: ["smoke"], priority: "critical" });
  const old = make("old", { tags: ["smoke"] });
  f.app.tests.archive(old.id, old.version);
  for (let index = 0; index < 100; index++) make(`bulk-${index}`);
  const other = f.app.projects.create({ name: "elsewhere" });
  f.app.tests.create({ projectId: other.id, plan, name: "of-another-project" });

  type Page = { total: number; tests: { id: string }[]; next: string | null };
  const base = `testmaster://projects/${f.init.projectId}/tests`;
  const pages = await readPages<Page>(f, base);
  // A page holds at most 100 tests and fits 32 KiB; together the pages hold every test once.
  expect(pages.length).toBeGreaterThan(1);
  for (const page of pages) {
    expect(page.tests.length).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(32768);
  }
  const ids = pages.flatMap((page) => page.tests.map((test) => test.id));
  expect(new Set(ids).size).toBe(102);
  expect(ids).toContain(login.id);

  const idsOf = async (query: string) =>
    (await readJson<Page>(f, `${base}?${query}`)).tests.map((test) => test.id).sort();
  expect(await idsOf("tag=smoke")).toEqual([login.id, old.id].sort());
  expect(await idsOf("tag=smoke&status=active")).toEqual([login.id]);
  expect(await idsOf("status=archived")).toEqual([old.id]);
  expect(await idsOf("priority=critical")).toEqual([login.id]);
  expect(await idsOf("tag=nothing-like-this")).toEqual([]);
  for (const query of ["priority=urgent", "status=deleted"])
    await expect(f.client.readResource({ uri: `${base}?${query}` })).rejects.toMatchObject({
      code: -32602,
    });
  // A cursor follows its own filter, and an unknown project is an unknown resource.
  const cursor = new URL(String(pages[0]?.next)).searchParams.get("cursor");
  await expect(
    f.client.readResource({
      uri: `${base}?status=active&cursor=${encodeURIComponent(String(cursor))}`,
    }),
  ).rejects.toMatchObject({ code: -32602 });
  await expect(
    f.client.readResource({
      uri: "testmaster://projects/prj_019bf434-20c0-7000-8000-000000000001/tests",
    }),
  ).rejects.toMatchObject({ code: -32002 });
});

it("the test and revision list resources show which revision is active and keep plans out", async () => {
  const f = await fixture();
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const candidate = f.app.revisions.create(test.id, {
    ...scaffoldPlan("backend"),
    name: "Candidate revision",
  });
  expect(await readJson(f, `testmaster://tests/${test.id}`)).toMatchObject({
    id: test.id,
    activeRevisionId: test.activeRevisionId,
  });
  const listed = await readJson<{
    activeRevisionId: string;
    testVersion: number;
    total: number;
    revisions: Record<string, unknown>[];
  }>(f, `testmaster://tests/${test.id}/revisions`);
  expect(listed).toMatchObject({ activeRevisionId: test.activeRevisionId, total: 2 });
  // The promote expectedVersion is the test's, not a revision's own `version` (always 1).
  const current = f.app.tests.get(test.id);
  expect(listed.testVersion).toBe(current.version);
  expect(await readJson(f, `testmaster://tests/${test.id}`)).toMatchObject({
    version: listed.testVersion,
  });
  expect(listed.revisions.every((revision) => revision.version === 1)).toBe(true);
  expect(
    listed.revisions.map((revision) => [revision.id, revision.active, revision.hasPlan]),
  ).toEqual([
    [test.activeRevisionId, true, true],
    [candidate.id, false, true],
  ]);
  expect(listed.revisions.some((revision) => "plan" in revision)).toBe(false);
  await expect(
    f.client.readResource({
      uri: "testmaster://tests/tst_019bf434-20c0-7000-8000-000000000001/revisions",
    }),
  ).rejects.toMatchObject({ code: -32002 });
});

it("the schemas resource serves the JSON Schema of a public contract as byte pages and refuses an unknown name", async () => {
  const f = await fixture();
  const read = async (uri: string) =>
    (await f.client.readResource({ uri })).contents[0] as Record<string, unknown>;
  const whole = JSON.stringify(jsonSchema("ExecutablePlan"));
  const wholeSha = createHash("sha256").update(whole).digest("hex");
  const first = await read("testmaster://schemas/ExecutablePlan");
  const meta = first._meta as Record<string, unknown>;
  expect(first.mimeType).toBe("application/json");
  // The plan contract is far larger than one page, and a client that cuts a read does not show it:
  // a read without offset is a small pointer document, never the schema cut short.
  expect(Buffer.byteLength(whole)).toBeGreaterThan(32768);
  expect(Buffer.byteLength(String(first.text))).toBeLessThan(4096);
  const pointer = JSON.parse(String(first.text)) as {
    name: string;
    sizeBytes: number;
    sha256: string;
    textPages: { first: string; pageBytes: number };
  };
  expect(pointer).toMatchObject({
    name: "ExecutablePlan",
    sizeBytes: Buffer.byteLength(whole),
    sha256: wholeSha,
    textPages: { pageBytes: 32768 },
  });
  expect(pointer).not.toHaveProperty("$defs");
  expect(meta["testmaster:sizeBytes"]).toBe(Buffer.byteLength(whole));
  expect(meta["testmaster:textPages"]).toBe(pointer.textPages.first);
  const parts: string[] = [];
  for (let next: string | null = pointer.textPages.first; next; ) {
    const page = await read(next);
    const pageMeta = page._meta as Record<string, unknown>;
    expect(Buffer.byteLength(String(page.text))).toBeLessThanOrEqual(32768);
    expect(pageMeta["testmaster:sha256"]).toBe(wholeSha);
    parts.push(String(page.text));
    next = pageMeta["testmaster:next"] as string | null;
  }
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.join("")).toBe(whole);
  expect(JSON.parse(parts.join(""))).toMatchObject({ type: "object" });
  expect(createHash("sha256").update(parts.join("")).digest("hex")).toBe(pointer.sha256);
  // A contract of one page stays whole, with no pointer.
  const config = await readJson<Record<string, unknown>>(f, "testmaster://schemas/ProjectConfig");
  expect(config).toEqual(jsonSchema("ProjectConfig"));

  // The names are listed across pages, and an unknown or mistyped one is refused with the names near it.
  const listed: { name: string; resource: string }[] = [];
  for (let uri: string | null = "testmaster://schemas"; uri; ) {
    const page: { schemas: { name: string; resource: string }[]; next: string | null } =
      await readJson(f, uri);
    listed.push(...page.schemas);
    uri = page.next;
  }
  expect(listed.map((entry) => entry.name)).toEqual(Object.keys(schemaCatalog).sort());
  expect(listed).toContainEqual({
    name: "ExecutablePlan",
    resource: "testmaster://schemas/ExecutablePlan",
  });
  await expect(read("testmaster://schemas/executableplan")).rejects.toMatchObject({
    code: -32002,
    message: expect.stringContaining("similar names are ExecutablePlan"),
  });
  await expect(read("testmaster://schemas/NoSuchContract")).rejects.toMatchObject({
    code: -32002,
    message: expect.stringContaining("testmaster://schemas"),
  });
  await expect(read("testmaster://schemas/ExecutablePlan/Step")).rejects.toMatchObject({
    code: -32002,
  });
});

it("the source resources list a project's sources and read one without its chunks", async () => {
  const f = await fixture();
  await writeFile(
    join(f.cwd, "prd.md"),
    "# Login\n\nUsers sign in with an email and a password.\n",
  );
  const detail = await f.app.sources.add({
    projectId: f.init.projectId,
    role: "prd",
    path: join(f.cwd, "prd.md"),
  });
  const listed = await readJson<{
    total: number;
    sources: { id: string; resource: string }[];
    next: string | null;
  }>(f, `testmaster://projects/${f.init.projectId}/sources`);
  expect(listed).toMatchObject({ total: 1, next: null });
  expect(listed.sources[0]).toMatchObject({
    id: detail.source.id,
    resource: `testmaster://sources/${detail.source.id}`,
  });
  const read = await readJson<{
    source: { id: string };
    revision: Record<string, unknown>;
    chunkCount: number;
    diagnostics: unknown[];
  }>(f, `testmaster://sources/${detail.source.id}`);
  expect(read.source.id).toBe(detail.source.id);
  expect(read.revision.id).toBe(detail.revision.id);
  expect(read.chunkCount).toBe(detail.revision.chunks.length);
  expect(read.chunkCount).toBeGreaterThan(0);
  expect(read.revision).not.toHaveProperty("chunks");
  expect(Array.isArray(read.diagnostics)).toBe(true);
  await expect(
    f.client.readResource({
      uri: "testmaster://sources/src_019bf434-20c0-7000-8000-000000000001",
    }),
  ).rejects.toMatchObject({ code: -32002 });
});

it("the environment resource lists a project's environments with the default and what each active revision targets", async () => {
  const f = await fixture();
  const staging = f.app.environments.create({
    projectId: f.init.projectId,
    name: "staging",
    baseUrl: "http://127.0.0.1:4100",
    additionalOrigins: ["http://127.0.0.1:4200"],
  });
  const moved = f.app.environments.update(staging.id, { locale: "pt-BR" }, Number(staging.version));
  const elsewhere = f.app.projects.create({ name: "elsewhere" });
  f.app.environments.create({
    projectId: elsewhere.id,
    name: "other",
    baseUrl: "http://127.0.0.1:4300",
  });
  type Listed = {
    total: number;
    next: string | null;
    environments: {
      id: string;
      version: number;
      default: boolean;
      activeRevision: {
        id: string;
        targetOrigins: string[];
        additionalOrigins: string[];
        locale: string;
      };
    }[];
  };
  const listed = await readJson<Listed>(
    f,
    `testmaster://projects/${f.init.projectId}/environments`,
  );
  // Another project's environment is not listed.
  expect(listed).toMatchObject({ total: 2, next: null });
  const byId = new Map(listed.environments.map((item) => [item.id, item]));
  expect(byId.get(f.init.environmentId)?.default).toBe(true);
  // The active revision is the updated one, and version is what an update expects next.
  expect(byId.get(staging.id)).toMatchObject({
    default: false,
    version: moved.version,
    activeRevision: {
      id: moved.activeRevisionId,
      targetOrigins: ["http://127.0.0.1:4100"],
      additionalOrigins: ["http://127.0.0.1:4200"],
      locale: "pt-BR",
    },
  });
  expect(JSON.stringify(listed)).not.toContain("variables");
  await expect(
    f.client.readResource({
      uri: "testmaster://projects/prj_019bf434-20c0-7000-8000-000000000001/environments",
    }),
  ).rejects.toMatchObject({ code: -32002 });
});

it("the plan batch resources list a project's batches and page the proposals of one", async () => {
  const f = await fixture();
  const batchOf = (projectId: string) => {
    const batch = entity(f.app.context, "pbt", {
      projectId,
      sourceSnapshotId: "snapshot-fingerprint",
      version: 1,
      state: "proposed",
    });
    f.app.context.entities.insert("ProposalBatch", batch);
    return batch;
  };
  const batch = batchOf(f.init.projectId);
  for (let index = 0; index < 12; index++)
    f.app.context.entities.insert(
      "Proposal",
      entity(f.app.context, "pro", {
        batchId: batch.id,
        plan: { ...scaffoldPlan("backend"), name: `Proposal ${index}` },
        requirementRefs: [],
        evidenceRefs: [{ relativePath: "spec.md" }],
        warnings: [],
        state: "proposed",
        validation: "valid",
      }),
    );
  batchOf(f.app.projects.create({ name: "elsewhere" }).id);

  const listed = await readJson<{
    total: number;
    batches: { id: string; resource: string }[];
  }>(f, `testmaster://projects/${f.init.projectId}/plan-batches`);
  expect(listed.total).toBe(1);
  expect(listed.batches[0]).toMatchObject({
    id: batch.id,
    resource: `testmaster://plan-batches/${batch.id}`,
  });

  type Page = {
    batch: { id: string; version: number };
    total: number;
    returned: number;
    proposals: { id: string; version: number; plan: { name: string } }[];
    next: string | null;
  };
  const pages = await readPages<Page>(f, `testmaster://plan-batches/${batch.id}`);
  expect(pages.map((page) => page.proposals.length)).toEqual([10, 2]);
  expect(pages.every((page) => page.total === 12 && page.batch.version === 1)).toBe(true);
  // Each page says how many of the 12 it holds and whether another follows.
  expect(pages.map((page) => [page.returned, page.next === null])).toEqual([
    [10, false],
    [2, true],
  ]);
  const proposals = pages.flatMap((page) => page.proposals);
  expect(new Set(proposals.map((proposal) => proposal.id)).size).toBe(12);
  expect(proposals.every((proposal) => proposal.version === 1)).toBe(true);
  expect(proposals.map((proposal) => proposal.plan.name)).toContain("Proposal 11");
  await expect(
    f.client.readResource({
      uri: "testmaster://plan-batches/pbt_019bf434-20c0-7000-8000-000000000001",
    }),
  ).rejects.toMatchObject({ code: -32002 });
  await expect(
    f.client.readResource({
      uri: "testmaster://projects/prj_019bf434-20c0-7000-8000-000000000001/plan-batches",
    }),
  ).rejects.toMatchObject({ code: -32002 });
});

it("a plan batch page stays within 32 KiB, and a proposal larger than that reads as byte pages", async () => {
  const f = await fixture();
  const batch = { id: "pbt_019bf434-20c0-7000-8000-000000000009", version: 3 };
  // "é" is two bytes, so a 6,000-byte proposal holds 3,000 of them.
  const proposal = (index: number, bytes: number) => ({
    id: `pro_${index}`,
    version: 1,
    plan: { name: `Proposal ${index}`, notes: "é".repeat(bytes / 2) },
  });
  const proposals = [0, 1, 2, 3, 4].map((index) => proposal(index, 6000));
  proposals.push(proposal(5, 40000), proposal(6, 6000));
  vi.spyOn(Object.getPrototypeOf(f.app.proposals), "detail").mockReturnValue({
    batch,
    proposals,
  } as never);
  const read = async (uri: string) =>
    (await f.client.readResource({ uri })).contents[0] as Record<string, unknown>;
  type Page = {
    textPages?: { first: string; pageBytes: number; rule: string };
    proposals: { id: string }[];
    next: string | null;
  };
  const contents: Record<string, unknown>[] = [];
  for (let next: string | null = `testmaster://plan-batches/${batch.id}`; next; ) {
    const content = await read(next);
    contents.push(content);
    next = (JSON.parse(String(content.text)) as Page).next;
  }
  const texts = contents.map((content) => String(content.text));
  const pages = texts.map((text) => JSON.parse(text) as Page);
  // Ten 6 KB proposals would pass 32 KiB: a page ends before it would, and the 40 KB one is alone.
  expect(pages.map((page) => page.proposals.map((item) => item.id))).toEqual([
    ["pro_0", "pro_1", "pro_2", "pro_3", "pro_4"],
    ["pro_5"],
    ["pro_6"],
  ]);
  expect(Buffer.byteLength(texts[0] as string)).toBeLessThanOrEqual(32768);
  expect(Buffer.byteLength(texts[2] as string)).toBeLessThanOrEqual(32768);
  expect(pages[0]).not.toHaveProperty("textPages");

  // The oversized page still holds its proposal, and its first field says where its byte pages are.
  const oversized = texts[1] as string;
  expect(Buffer.byteLength(oversized)).toBeGreaterThan(32768);
  expect(Object.keys(pages[1] as Page)[0]).toBe("textPages");
  const pointer = pages[1]?.textPages;
  expect(pointer).toMatchObject({ pageBytes: 32768 });
  expect(pointer?.first).toContain("offset=0");
  expect(new URL(String(pointer?.first)).searchParams.get("cursor")).toBe(
    new URL(pages[0]?.next as string).searchParams.get("cursor"),
  );
  expect((contents[1] as { _meta: Record<string, unknown> })._meta["testmaster:textPages"]).toBe(
    pointer?.first,
  );

  // Its byte pages fit 32 KiB each, never split a character, and concatenate to the page.
  const parts: string[] = [];
  for (let next: string | null = String(pointer?.first); next; ) {
    const page = await read(next);
    const text = String(page.text);
    const meta = page._meta as Record<string, unknown>;
    expect(page.mimeType).toBe("application/json");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32768);
    expect(text).not.toContain("\uFFFD");
    expect(meta["testmaster:offset"]).toBe(Buffer.byteLength(parts.join("")));
    expect(meta["testmaster:sizeBytes"]).toBe(Buffer.byteLength(oversized));
    parts.push(text);
    next = meta["testmaster:next"] as string | null;
  }
  expect(parts.length).toBe(2);
  expect(parts.join("")).toBe(oversized);
  await expect(read(`testmaster://plan-batches/${batch.id}?offset=-1`)).rejects.toMatchObject({
    code: -32602,
  });

  // The byte pages expire with the page's cursors, and no client can push that expiry further out.
  const withExpiry = (expires: number) => {
    const link = new URL(String(pointer?.first));
    link.searchParams.set("expires", String(expires));
    return link.href;
  };
  await expect(read(withExpiry(Date.now() + 600000))).rejects.toMatchObject({ code: -32602 });
  await expect(read(withExpiry(Date.now() - 1))).rejects.toMatchObject({
    code: -32602,
    message: expect.stringContaining("expired"),
  });
});

it("the list and document resources refuse a caller without the read scope", async () => {
  const f = await fixture(["W"]);
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const run = f.app.runs.resolve({ testId: test.id, environmentId: f.init.environmentId });
  f.app.context.entities.insert("Run", run);
  const revisionId = String(test.activeRevisionId);
  const uris = [
    `testmaster://projects/${f.init.projectId}/tests`,
    `testmaster://projects/${f.init.projectId}/sources`,
    `testmaster://projects/${f.init.projectId}/environments`,
    `testmaster://projects/${f.init.projectId}/plan-batches`,
    `testmaster://tests/${test.id}`,
    `testmaster://tests/${test.id}/revisions`,
    `testmaster://revisions/${revisionId}`,
    `testmaster://revisions/${revisionId}/code`,
    `testmaster://revisions/${revisionId}/code/package.json`,
    `testmaster://runs/${run.id}/steps`,
    `testmaster://runs/${run.id}/report?format=junit`,
  ];
  for (const uri of uris)
    await expect(f.client.readResource({ uri }), uri).rejects.toThrow(
      "Session scope is insufficient",
    );
  // Positive control: the same resources are served to a reader.
  const reader = await fixture(["R"]);
  expect(
    await readJson(reader, `testmaster://projects/${reader.init.projectId}/tests`),
  ).toMatchObject({ total: 0 });
});
