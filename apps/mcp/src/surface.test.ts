import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Application, entity, scaffoldPlan } from "@testmaster/application";
import { ajv } from "@testmaster/contracts";
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

it("report resources are blob pages with the paging in _meta", async () => {
  const f = await fixture();
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const run = f.app.runs.resolve({ testId: test.id, environmentId: f.init.environmentId });
  Object.assign(run, { phase: "completed", status: "passed", outcome: "passed", gate: "passed" });
  f.app.context.entities.insert("Run", run);
  const document = JSON.stringify({ filler: "x".repeat(70000) });
  vi.spyOn(Object.getPrototypeOf(f.app.reports), "export").mockResolvedValue({
    content: document,
  } as never);
  const uri = `testmaster://runs/${run.id}/report`;
  const page = await f.client.readResource({ uri });
  const content = page.contents[0] as Record<string, unknown>;
  expect(content.mimeType).toBe("application/json");
  expect(content).not.toHaveProperty("text");
  const meta = content._meta as Record<string, unknown>;
  expect(meta["testmaster:sizeBytes"]).toBe(Buffer.byteLength(document));
  expect(meta["testmaster:offset"]).toBe(0);
  const head = Buffer.from(String(content.blob), "base64");
  expect(head.byteLength).toBeLessThanOrEqual(65536);
  const next = meta["testmaster:next"];
  expect(typeof next).toBe("string");
  // Following next reaches the end of the document, and the concatenated pages are the document.
  const tail = (await f.client.readResource({ uri: String(next) })).contents[0] as Record<
    string,
    unknown
  >;
  expect((tail._meta as Record<string, unknown>)["testmaster:next"]).toBeNull();
  expect(Buffer.concat([head, Buffer.from(String(tail.blob), "base64")]).toString("utf8")).toBe(
    document,
  );
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
  expect(Array.isArray(analyzed.body.featureRefs)).toBe(true);
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

it("generate_tests forwards budget.deadlineMs and refuses an out-of-range deadline at validation", async () => {
  const f = await fixture();
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const revisionIds = [String(test.activeRevisionId)];
  const generate = vi
    .spyOn(Object.getPrototypeOf(f.app.codeGeneration), "generate")
    .mockResolvedValue({ requested: 1, candidates: [], validationErrors: [] });
  const forwarded = await f.call("testmaster_generate_tests", {
    revisionIds,
    budget: { modelCalls: 3, deadlineMs: 450000 },
  });
  expect(forwarded.isError).toBe(false);
  expect(generate.mock.calls[0]?.[0]).toMatchObject({
    budget: { modelCalls: 3, deadlineMs: 450000 },
  });
  for (const deadlineMs of [0, 600001]) {
    const refused = await f.call("testmaster_generate_tests", {
      revisionIds,
      budget: { deadlineMs },
    });
    expect(refused.error?.code).toBe("INVALID_ARGUMENT");
    expect(JSON.stringify(refused.error?.details.issues)).toContain("deadlineMs");
  }
  // Only the accepted call reached the service.
  expect(generate).toHaveBeenCalledTimes(1);
  generate.mockRestore();
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
  // Control: a known tool still answers with a result.
  const known = await f.call("testmaster_capabilities", {});
  expect(known.isError).toBe(false);
});
