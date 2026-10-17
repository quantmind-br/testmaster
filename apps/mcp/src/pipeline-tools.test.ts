import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Application, entity, requirementRejection } from "@testmaster/application";
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

interface World {
  app: Application;
  cwd: string;
  init: { projectId: string; workspaceId: string; environmentId: string };
  call: (name: string, args: Record<string, unknown>) => Promise<Outcome>;
}
interface Outcome {
  isError: boolean;
  body: Record<string, unknown>;
  text: string;
  error: Failure | undefined;
  result: CallToolResult;
}
/** The text of every text content entry, in order. */
function texts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((entry) =>
    entry && typeof entry === "object" && "text" in entry ? [String(entry.text)] : [],
  );
}
function firstText(content: unknown): string {
  return texts(content)[0] ?? "";
}

async function fixture(scopes: Scope[] = ["R", "W", "X"]) {
  const cwd = await mkdtemp(join(tmpdir(), "tm-mcp-pipeline-"));
  const app = await Application.open({ cwd, home: join(cwd, "home"), env: {} });
  const init = await app.init();
  const server = createMcpServer({
    application: app.forIdentity({ principalId: init.principalId, scopes }),
    roots: [cwd],
  });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  const client = new Client({ name: "pipeline-test", version: "1" });
  await client.connect(left);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    app.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const call = async (name: string, args: Record<string, unknown>): Promise<Outcome> => {
    const result = await client.callTool({ name, arguments: args });
    const body: Record<string, unknown> = JSON.parse(firstText(result.content));
    const failure: unknown = body.error;
    return {
      isError: result.isError === true,
      body,
      text: texts(result.content).join("\n"),
      error: failure ? (failure as Failure) : undefined,
      result,
    };
  };
  const world: World = { app, cwd, init, call };
  return { ...world, client };
}

const origin = "https://app.example.test";
const pipelineTools = [
  "testmaster_add_source",
  "testmaster_review_requirements",
  "testmaster_set_secret",
  "testmaster_rotate_secret",
  "testmaster_save_auth_profile",
  "testmaster_update_environment",
];

it("the pipeline tools are listed with schemas, annotations and no inline secret value", async () => {
  const f = await fixture();
  const tools = (await f.client.listTools()).tools;
  const byName = (name: string) => {
    const tool = tools.find((item) => item.name === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool;
  };
  for (const name of pipelineTools) {
    const tool = byName(name);
    expect(tool.inputSchema.type, name).toBe("object");
    expect(tool.outputSchema?.type, name).toBe("object");
    expect(tool.description?.length ?? 0, name).toBeLessThanOrEqual(250);
  }
  expect(byName("testmaster_add_source").annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
  });
  expect(byName("testmaster_set_secret").annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
  });
  for (const name of [
    "testmaster_archive_source",
    "testmaster_review_requirements",
    "testmaster_save_auth_profile",
    "testmaster_rotate_secret",
    "testmaster_update_environment",
  ])
    expect(byName(name).annotations, name).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  // A secret value is never an argument: only a file or an environment variable names it.
  const secret = byName("testmaster_set_secret").inputSchema;
  expect(Object.keys(secret.properties ?? {}).sort()).toEqual([
    "allowedOrigins",
    "fromEnv",
    "name",
    "valueFile",
  ]);
  expect([...(secret.required ?? [])].sort()).toEqual(["allowedOrigins", "name"]);
  expect([...(byName("testmaster_add_source").inputSchema.required ?? [])].sort()).toEqual([
    "path",
    "projectId",
    "role",
  ]);
  expect([...(byName("testmaster_review_requirements").inputSchema.required ?? [])].sort()).toEqual(
    ["expectedVersion", "projectId"],
  );
});

it("every pipeline tool needs the write scope", async () => {
  const f = await fixture(["R"]);
  await writeFile(join(f.cwd, "prd.md"), "# Health\nThe health endpoint must report ok.\n");
  const { source } = await f.app.sources.add({
    projectId: f.init.projectId,
    path: "prd.md",
    role: "prd",
  });
  const calls: [string, Record<string, unknown>][] = [
    ["testmaster_add_source", { projectId: f.init.projectId, path: "prd.md", role: "prd" }],
    ["testmaster_review_requirements", { projectId: f.init.projectId, expectedVersion: 1 }],
    ["testmaster_set_secret", { name: "A", fromEnv: "X", allowedOrigins: [origin] }],
    ["testmaster_rotate_secret", { secret: "A", fromEnv: "X" }],
    [
      "testmaster_save_auth_profile",
      { profileId: "aup_019bf434-20c0-7000-8000-000000000001", expectedVersion: 1, name: "n" },
    ],
    [
      "testmaster_update_environment",
      { environmentId: f.init.environmentId, expectedVersion: 1, name: "n" },
    ],
    ["testmaster_archive_source", { sourceId: source.id, expectedVersion: source.version }],
  ];
  for (const [name, args] of calls) {
    const denied = await f.call(name, args);
    expect(denied.isError, name).toBe(true);
    expect(denied.error?.code, name).toBe("FORBIDDEN");
  }
  // A reader cannot archive a source: it keeps its active revision.
  expect(f.app.sources.get(String(source.id)).source.activeRevisionId).not.toBeNull();
});

it("add_source imports a file, versions it and returns an invalid source as an error with its diagnostics", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, "prd.md"), "# Health\nThe health endpoint must report ok.\n");
  const added = await f.call("testmaster_add_source", {
    projectId: f.init.projectId,
    path: "prd.md",
    role: "prd",
  });
  expect(added.isError, added.text).toBe(false);
  const [source] = f.app.sources.list(f.init.projectId);
  if (!source) throw new Error("Missing source");
  const firstRevisionId = f.app.sources.get(source.id).revision.id;
  expect(added.body).toMatchObject({
    source: { role: "prd", displayName: "prd.md" },
    revision: { id: firstRevisionId, status: "ready", parentId: null },
    diagnostics: [],
  });
  // The receipt is bounded: chunks and the inventory stay out, only their count is reported.
  expect(added.body.revision).not.toHaveProperty("chunks");
  expect(added.body).toMatchObject({ chunkCount: expect.any(Number) });
  expect(Number(added.body.chunkCount)).toBeGreaterThan(0);

  await writeFile(join(f.cwd, "prd.md"), "# Health\nThe health endpoint must report ok, fast.\n");
  const revised = await f.call("testmaster_add_source", {
    projectId: f.init.projectId,
    path: "prd.md",
    role: "prd",
    sourceId: String(source.id),
    expectedVersion: Number(source.version),
  });
  expect(revised.isError, revised.text).toBe(false);
  expect(revised.body.revision).toMatchObject({ parentId: firstRevisionId });
  // A revision without sourceId, and a stale version, are refused.
  const orphan = await f.call("testmaster_add_source", {
    projectId: f.init.projectId,
    path: "prd.md",
    role: "prd",
    expectedVersion: 1,
  });
  expect(orphan.error?.code).toBe("INVALID_ARGUMENT");
  const stale = await f.call("testmaster_add_source", {
    projectId: f.init.projectId,
    path: "prd.md",
    role: "prd",
    sourceId: String(source.id),
    expectedVersion: Number(source.version),
  });
  expect(stale.error?.code).toBe("REVISION_CONFLICT");

  // An OpenAPI version the parser does not support is an error that explains itself.
  await writeFile(
    join(f.cwd, "api.json"),
    JSON.stringify({ openapi: "9.9.9", info: { title: "x", version: "1" }, paths: {} }),
  );
  const invalid = await f.call("testmaster_add_source", {
    projectId: f.init.projectId,
    path: "api.json",
    role: "api-spec",
  });
  expect(invalid.isError).toBe(true);
  expect(invalid.error?.code).toBe("INVALID_ARGUMENT");
  expect(invalid.error?.details.diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "unsupported_openapi" })]),
  );

  // Files outside the approved roots and credential files never become sources.
  const outside = await f.call("testmaster_add_source", {
    projectId: f.init.projectId,
    path: tmpdir(),
    role: "prd",
  });
  expect(outside.error?.code).toBe("FORBIDDEN");
  await writeFile(join(f.cwd, ".env"), "TOKEN=1\n");
  const credential = await f.call("testmaster_add_source", {
    projectId: f.init.projectId,
    path: ".env",
    role: "prd",
  });
  expect(credential.error?.code).toBe("POLICY_DENIED");
});

/** A stored snapshot with two requirements that disagree, as `normalize` leaves it. */
async function seedSnapshot(f: World) {
  await writeFile(join(f.cwd, "prd.md"), "# Health\nThe health endpoint must report ok.\n");
  await f.call("testmaster_add_source", {
    projectId: f.init.projectId,
    path: "prd.md",
    role: "prd",
  });
  const [source] = f.app.sources.list(f.init.projectId);
  const sourceId = String(source?.id);
  const ref = f.app.sources.get(sourceId).chunks[0]?.evidenceRef;
  const requirement = (key: string, text: string) => {
    const value = entity(f.app.context, "req", {
      text,
      acceptanceCriteria: ["Health reports ok"],
      sourceRefs: [ref],
      originKind: "user_spec",
      confidence: null,
      approval: null,
      extensions: {
        "testmaster:projectId": f.init.projectId,
        "testmaster:key": key,
        "testmaster:reason": "PRD",
      },
    });
    f.app.context.entities.insert("Requirement", value, { projectId: f.init.projectId });
    return value;
  };
  const first = requirement("health-ok", "Health reports ok");
  const second = requirement("health-fast", "Health reports ok within 50 ms");
  const snapshot = {
    requirements: [first, second],
    conflicts: [
      {
        id: "conflict-1",
        requirementIds: [first.id, second.id],
        reason: "The two statements disagree on latency",
        sourceRefs: [ref, ref],
        resolution: null,
      },
    ],
    openQuestions: [],
    version: 2,
    fingerprint: "seed-fingerprint",
  };
  f.app.database.run(
    "INSERT INTO operational_state(key,value) VALUES(?,?)",
    `requirements:${f.init.workspaceId}:${f.init.projectId}`,
    JSON.stringify(snapshot),
  );
  return { first: first.id, second: second.id, ref };
}

it("review_requirements decides at the snapshot version and returns the fingerprint generate_plan accepts", async () => {
  const f = await fixture();
  const seeded = await seedSnapshot(f);
  const base = { projectId: f.init.projectId };

  // A snapshot that moved since it was read is refused with where it stands now.
  const stale = await f.call("testmaster_review_requirements", {
    ...base,
    expectedVersion: 1,
    approve: [seeded.first],
  });
  expect(stale.error?.code).toBe("REVISION_CONFLICT");
  expect(stale.error?.details).toMatchObject({ expectedVersion: 1, currentVersion: 2 });

  // Approval waits for the conflict decision: the refusal is reported per item, nothing changes.
  const early = await f.call("testmaster_review_requirements", {
    ...base,
    expectedVersion: 2,
    approve: [seeded.first],
  });
  expect(early.isError, early.text).toBe(false);
  expect(early.body.results).toEqual([
    {
      action: "approve",
      id: seeded.first,
      ok: false,
      error: { code: "PRECONDITION_FAILED", message: expect.any(String) },
    },
  ]);
  expect(early.body).toMatchObject({
    sourceSnapshotId: "seed-fingerprint",
    version: 2,
    unresolvedConflictIds: ["conflict-1"],
    pendingApprovalIds: [seeded.first, seeded.second],
  });
  // generate_plan refuses the requirement whose conflict is not decided yet, naming the conflict
  // (approving it is blocked until then too).
  const premature = await f.call("testmaster_generate_plan", {
    ...base,
    sourceSnapshotId: "seed-fingerprint",
    type: "backend",
    requirementIds: [seeded.first],
  });
  expect(premature.error?.code).toBe("PRECONDITION_FAILED");
  expect(premature.error?.details).toMatchObject({
    reasonCode: "requirement_conflict_unresolved",
    requirementId: seeded.first,
    conflictId: "conflict-1",
  });

  const reviewed = await f.call("testmaster_review_requirements", {
    ...base,
    expectedVersion: 2,
    update: [
      { requirementId: seeded.first, text: "Health reports ok within 200 ms" },
      { requirementId: seeded.second, acceptanceCriteria: [] },
      { requirementId: seeded.first },
    ],
    adjudicate: [
      {
        conflictId: "conflict-1",
        selectedRequirementId: seeded.first,
        reason: "200 ms is the contract",
      },
    ],
    approve: [seeded.first, "req_019bf434-20c0-7000-8000-000000000001"],
  });
  expect(reviewed.isError, reviewed.text).toBe(false);
  expect(reviewed.body.results).toEqual([
    { action: "update", id: seeded.first, ok: true, error: null },
    { action: "update", id: seeded.second, ok: true, error: null },
    {
      action: "update",
      id: seeded.first,
      ok: false,
      error: { code: "INVALID_ARGUMENT", message: expect.any(String) },
    },
    { action: "adjudicate", id: "conflict-1", ok: true, error: null },
    { action: "approve", id: seeded.first, ok: true, error: null },
    {
      action: "approve",
      id: "req_019bf434-20c0-7000-8000-000000000001",
      ok: false,
      error: { code: "NOT_FOUND", message: expect.any(String) },
    },
  ]);
  const snapshot = f.app.requirements.snapshot(base.projectId);
  expect(reviewed.body.sourceSnapshotId).toBe(snapshot.fingerprint);
  expect(reviewed.body.version).toBe(snapshot.version);
  expect(snapshot.fingerprint).not.toBe("seed-fingerprint");
  // The loser of the conflict is superseded, so it is not left waiting for an approval.
  expect(reviewed.body).toMatchObject({ pendingApprovalIds: [], unresolvedConflictIds: [] });
  expect(f.app.requirements.get(seeded.first)).toMatchObject({
    text: "Health reports ok within 200 ms",
    approval: expect.stringMatching(/^apr_/),
  });

  // The fingerprint it returned is the one generate_plan accepts; the old one is stale.
  const stalePlan = await f.call("testmaster_generate_plan", {
    ...base,
    sourceSnapshotId: "seed-fingerprint",
    type: "backend",
    requirementIds: [seeded.first],
  });
  expect(stalePlan.error?.details).toMatchObject({ reasonCode: "requirement_snapshot_mismatch" });
  const plan = await f.call("testmaster_generate_plan", {
    ...base,
    sourceSnapshotId: String(reviewed.body.sourceSnapshotId),
    type: "backend",
    requirementIds: [seeded.first],
  });
  // No model is configured here, so the call stops at the provider, after the approval checks.
  expect(plan.error?.details?.reasonCode).not.toBe("requirement_snapshot_mismatch");
  expect(plan.error?.message ?? "").not.toMatch(/approval|superseded/);

  // Approving again changes nothing, so the fingerprint stays valid.
  const again = await f.call("testmaster_review_requirements", {
    ...base,
    expectedVersion: snapshot.version,
    approve: [seeded.first],
  });
  expect(again.body.results).toEqual([
    { action: "approve", id: seeded.first, ok: true, error: null },
  ]);
  expect(again.body.sourceSnapshotId).toBe(snapshot.fingerprint);
});

it("review_requirements takes empty decision lists, so a call can only adjudicate", async () => {
  const f = await fixture();
  const seeded = await seedSnapshot(f);
  const decided = await f.call("testmaster_review_requirements", {
    projectId: f.init.projectId,
    expectedVersion: 2,
    update: [],
    adjudicate: [
      { conflictId: "conflict-1", selectedRequirementId: seeded.first, reason: "The contract" },
    ],
    reject: [],
    approve: [],
  });
  expect(decided.isError, decided.text).toBe(false);
  expect(decided.body.results).toEqual([
    { action: "adjudicate", id: "conflict-1", ok: true, error: null },
  ]);
  expect(decided.body).toMatchObject({
    unresolvedConflictIds: [],
    pendingApprovalIds: [seeded.first],
  });
});

it("the requirements resource states each requirement's decision as one status", async () => {
  const f = await fixture();
  const seeded = await seedSnapshot(f);
  const statuses = async () => {
    const read = async (uri: string) =>
      JSON.parse(String((await f.client.readResource({ uri })).contents[0]?.text));
    const snapshot = (await read(`testmaster://requirements/${f.init.projectId}`)) as {
      requirements: { id: string; status: string }[];
    };
    const byId = Object.fromEntries(snapshot.requirements.map((item) => [item.id, item.status]));
    // One requirement read by id agrees with the snapshot.
    const single = (await read(`testmaster://requirements/${seeded.second}`)) as { status: string };
    expect(single.status).toBe(byId[seeded.second]);
    return [byId[seeded.first], byId[seeded.second]];
  };
  const base = { projectId: f.init.projectId };

  expect(await statuses()).toEqual(["pending", "pending"]);
  // The conflict decision approves one requirement and supersedes the other.
  await f.call("testmaster_review_requirements", {
    ...base,
    expectedVersion: 2,
    adjudicate: [
      { conflictId: "conflict-1", selectedRequirementId: seeded.first, reason: "First wins" },
    ],
    approve: [seeded.first],
  });
  expect(await statuses()).toEqual(["approved", "superseded"]);
  // A rejection is final and outranks the supersession it came after.
  const version = f.app.requirements.snapshot(f.init.projectId).version;
  const rejected = await f.call("testmaster_review_requirements", {
    ...base,
    expectedVersion: version,
    reject: [{ requirementId: seeded.second, reason: "Out of scope" }],
  });
  expect(rejected.body.results).toEqual([
    { action: "reject", id: seeded.second, ok: true, error: null },
  ]);
  expect(await statuses()).toEqual(["approved", "rejected"]);
});

it("review_requirements records one reason on the approved requirement and the resource shows it", async () => {
  const f = await fixture();
  const seeded = await seedSnapshot(f);
  const base = { projectId: f.init.projectId, expectedVersion: 2 };
  const read = async (id: string) => {
    const resource = await f.client.readResource({ uri: `testmaster://requirements/${id}` });
    return JSON.parse(String(resource.contents[0]?.text)) as {
      extensions?: Record<string, unknown>;
    };
  };
  const adjudicate = [
    { conflictId: "conflict-1", selectedRequirementId: seeded.first, reason: "First wins" },
  ];

  // A blank reason refuses the approval, reported for the item; nothing is approved.
  const blank = await f.call("testmaster_review_requirements", {
    ...base,
    adjudicate,
    approve: [seeded.first],
    reason: "   ",
  });
  expect(blank.body.results).toContainEqual(
    expect.objectContaining({ action: "approve", id: seeded.first, ok: false }),
  );
  expect(f.app.requirements.get(seeded.first).approval).toBeNull();

  const reason = "Matches the signed-off acceptance criteria";
  const decided = await f.call("testmaster_review_requirements", {
    projectId: f.init.projectId,
    expectedVersion: f.app.requirements.snapshot(f.init.projectId).version,
    approve: [seeded.first],
    reason,
  });
  expect(decided.isError, decided.text).toBe(false);
  expect((await read(seeded.first)).extensions?.["testmaster:decision"]).toEqual({
    action: "approved",
    reason,
    actorId: f.app.context.principalId,
    decidedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
  });
});

it("review_requirements rejects a requirement with a mandatory reason and keeps the snapshot fingerprint", async () => {
  const f = await fixture();
  const seeded = await seedSnapshot(f);
  const base = { projectId: f.init.projectId, expectedVersion: 2 };

  const blank = await f.call("testmaster_review_requirements", {
    ...base,
    reject: [{ requirementId: seeded.second, reason: "" }],
  });
  expect(blank.error?.code).toBe("INVALID_ARGUMENT");
  // One call cannot approve and reject the same requirement.
  const both = await f.call("testmaster_review_requirements", {
    ...base,
    approve: [seeded.second],
    reject: [{ requirementId: seeded.second, reason: "Out of scope" }],
  });
  expect(both.error?.code).toBe("INVALID_ARGUMENT");
  expect(f.app.requirements.snapshot(f.init.projectId).version).toBe(2);

  const decided = await f.call("testmaster_review_requirements", {
    ...base,
    reject: [{ requirementId: seeded.second, reason: "Latency is not part of this release" }],
  });
  expect(decided.isError, decided.text).toBe(false);
  expect(decided.body.results).toEqual([
    { action: "reject", id: seeded.second, ok: true, error: null },
  ]);
  // Rejecting changes the version, not the fingerprint, and the requirement is no longer pending.
  expect(decided.body).toMatchObject({
    sourceSnapshotId: "seed-fingerprint",
    version: 3,
    pendingApprovalIds: [seeded.first],
  });
  expect(requirementRejection(f.app.requirements.get(seeded.second))).toMatchObject({
    reason: "Latency is not part of this release",
  });

  // A rejected requirement cannot be approved, and planning it is refused with the reason.
  const approve = await f.call("testmaster_review_requirements", {
    projectId: f.init.projectId,
    expectedVersion: 3,
    approve: [seeded.second],
  });
  expect(approve.body.results).toEqual([
    {
      action: "approve",
      id: seeded.second,
      ok: false,
      error: { code: "PRECONDITION_FAILED", message: expect.stringContaining("rejected") },
    },
  ]);
  const plan = await f.call("testmaster_generate_plan", {
    projectId: f.init.projectId,
    sourceSnapshotId: "seed-fingerprint",
    type: "backend",
    requirementIds: [seeded.second],
  });
  expect(plan.error?.code).toBe("PRECONDITION_FAILED");
  expect(plan.error?.details).toMatchObject({ reasonCode: "requirement_rejected" });
});

it("set_secret stores the trimmed file value or variable, echoes only metadata and refuses inline or unsafe sources", async () => {
  const f = await fixture();
  const set = vi.spyOn(Object.getPrototypeOf(f.app.secrets), "set");
  await writeFile(join(f.cwd, "token.txt"), "s3cr3t-token-value\n");
  const stored = await f.call("testmaster_set_secret", {
    name: "API_TOKEN",
    valueFile: "token.txt",
    allowedOrigins: [origin],
  });
  expect(stored.isError, stored.text).toBe(false);
  expect(stored.body).toMatchObject({
    id: expect.stringMatching(/^sec_/),
    locator: "API_TOKEN",
    allowedOrigins: [origin],
  });
  expect(JSON.stringify(stored.result)).not.toContain("s3cr3t-token-value");
  // The service received the value without the one trailing line terminator, and it reads back so.
  expect(set.mock.calls[0]?.[1]).toBe("s3cr3t-token-value");
  expect(await (await f.app.secrets.release("API_TOKEN")).resolve()).toBe("s3cr3t-token-value");

  await writeFile(join(f.cwd, "crlf.txt"), "line one\r\nline two\n\n");
  await f.call("testmaster_set_secret", {
    name: "TWO_LINES",
    valueFile: "crlf.txt",
    allowedOrigins: [origin],
  });
  // Exactly one terminator goes: inner and further trailing newlines are part of the value.
  expect(set.mock.calls[1]?.[1]).toBe("line one\r\nline two\n");

  vi.stubEnv("TM_PIPELINE_SECRET", "from-the-environment");
  const fromEnv = await f.call("testmaster_set_secret", {
    name: "FROM_ENV",
    fromEnv: "TM_PIPELINE_SECRET",
    allowedOrigins: [origin],
  });
  expect(fromEnv.isError, fromEnv.text).toBe(false);
  expect(set.mock.calls[2]?.[1]).toBe("from-the-environment");
  vi.unstubAllEnvs();

  const calls = set.mock.calls.length;
  const both = await f.call("testmaster_set_secret", {
    name: "BOTH",
    valueFile: "token.txt",
    fromEnv: "TM_PIPELINE_SECRET",
    allowedOrigins: [origin],
  });
  const neither = await f.call("testmaster_set_secret", { name: "NONE", allowedOrigins: [origin] });
  const inline = await f.call("testmaster_set_secret", {
    name: "INLINE",
    value: "inline-secret",
    fromEnv: "TM_PIPELINE_SECRET",
    allowedOrigins: [origin],
  });
  const unset = await f.call("testmaster_set_secret", {
    name: "UNSET",
    fromEnv: "TM_PIPELINE_SECRET_UNSET",
    allowedOrigins: [origin],
  });
  const missing = await f.call("testmaster_set_secret", {
    name: "MISSING",
    valueFile: "absent.txt",
    allowedOrigins: [origin],
  });
  const outside = await f.call("testmaster_set_secret", {
    name: "OUTSIDE",
    valueFile: join(tmpdir(), "outside-root.txt"),
    allowedOrigins: [origin],
  });
  const noOrigins = await f.call("testmaster_set_secret", {
    name: "NO_ORIGIN",
    valueFile: "token.txt",
    allowedOrigins: [],
  });
  const duplicate = await f.call("testmaster_set_secret", {
    name: "API_TOKEN",
    valueFile: "token.txt",
    allowedOrigins: [origin],
  });
  expect(
    [both, neither, inline, unset, missing, outside, noOrigins, duplicate].map(
      (outcome) => outcome.error?.code,
    ),
  ).toEqual([
    "INVALID_ARGUMENT",
    "INVALID_ARGUMENT",
    "INVALID_ARGUMENT",
    "INVALID_ARGUMENT",
    "NOT_FOUND",
    "FORBIDDEN",
    "INVALID_ARGUMENT",
    "REVISION_CONFLICT",
  ]);
  // Refusals before the service never reach it, and no refusal echoes a value.
  expect(set.mock.calls.length).toBe(calls + 1);
  expect(JSON.stringify([both, neither, inline, unset, duplicate].map((o) => o.body))).not.toMatch(
    /s3cr3t-token-value|inline-secret|from-the-environment/,
  );
});

it("rotate_secret stores a new value of a taken name without an inline value; set_secret names the secret to rotate", async () => {
  const f = await fixture();
  vi.stubEnv("TM_ROTATE_FIRST", "first-value");
  vi.stubEnv("TM_ROTATE_SECOND", "second-value");
  const stored = await f.call("testmaster_set_secret", {
    name: "LOGIN_PASSWORD",
    fromEnv: "TM_ROTATE_FIRST",
    allowedOrigins: [origin],
  });
  expect(stored.isError, stored.text).toBe(false);
  const taken = await f.call("testmaster_set_secret", {
    name: "LOGIN_PASSWORD",
    fromEnv: "TM_ROTATE_SECOND",
    allowedOrigins: [origin],
  });
  expect(taken.error).toMatchObject({
    code: "REVISION_CONFLICT",
    details: { secretId: stored.body.id, name: "LOGIN_PASSWORD" },
  });
  expect(taken.error?.message).toContain("testmaster_rotate_secret");
  const rotated = await f.call("testmaster_rotate_secret", {
    secret: "LOGIN_PASSWORD",
    fromEnv: "TM_ROTATE_SECOND",
  });
  expect(rotated.isError, rotated.text).toBe(false);
  expect(rotated.body).toMatchObject({
    id: stored.body.id,
    locator: "LOGIN_PASSWORD",
    allowedOrigins: [origin],
    secretVersion: 2,
  });
  expect(JSON.stringify(rotated.result)).not.toContain("second-value");
  expect(await (await f.app.secrets.release("LOGIN_PASSWORD")).resolve()).toBe("second-value");
  // By id too; an inline value or an unknown secret is refused and changes nothing.
  await writeFile(join(f.cwd, "third.txt"), "third-value\n");
  const byId = await f.call("testmaster_rotate_secret", {
    secret: stored.body.id,
    valueFile: "third.txt",
  });
  expect(byId.body).toMatchObject({ secretVersion: 3 });
  const inline = await f.call("testmaster_rotate_secret", {
    secret: "LOGIN_PASSWORD",
    value: "inline-secret",
  });
  const unknown = await f.call("testmaster_rotate_secret", {
    secret: "NOT_A_SECRET",
    fromEnv: "TM_ROTATE_FIRST",
  });
  expect([inline.error?.code, unknown.error?.code]).toEqual(["INVALID_ARGUMENT", "NOT_FOUND"]);
  expect(await (await f.app.secrets.release("LOGIN_PASSWORD")).resolve()).toBe("third-value");
  vi.unstubAllEnvs();
});

it("save_auth_profile creates and updates a profile and update_environment binds it", async () => {
  const f = await fixture();
  const environment = f.app.environments.get(f.init.environmentId);
  const [target] = f.app.environments.revisions(environment.id)[0]?.targetOrigins ?? [];
  if (!target) throw new Error("Missing target origin");
  await writeFile(join(f.cwd, "token.txt"), "bearer-value\n");
  const secret = await f.call("testmaster_set_secret", {
    name: "BEARER",
    valueFile: "token.txt",
    allowedOrigins: [target],
  });
  const secretId = String(secret.body.id);

  // Creating needs the whole profile; the refusal names what is missing.
  const partial = await f.call("testmaster_save_auth_profile", {
    projectId: f.init.projectId,
    name: "api",
  });
  expect(partial.error?.code).toBe("INVALID_ARGUMENT");
  expect(partial.error?.details.missing).toEqual(["kind", "originBindings", "secrets", "config"]);

  const created = await f.call("testmaster_save_auth_profile", {
    projectId: f.init.projectId,
    name: "api",
    kind: "bearer",
    originBindings: [target],
    secrets: { token: secretId },
    config: {},
  });
  expect(created.isError, created.text).toBe(false);
  const [profile] = f.app.authProfiles.list(f.init.projectId);
  if (!profile) throw new Error("Missing profile");
  expect(profile.secrets).toEqual({ token: secretId });
  expect(JSON.stringify(created.result)).not.toContain("bearer-value");

  // The kind never changes, a version is required and a stale one is refused.
  const kind = await f.call("testmaster_save_auth_profile", {
    profileId: profile.id,
    expectedVersion: profile.version,
    kind: "basic",
  });
  const unversioned = await f.call("testmaster_save_auth_profile", {
    profileId: profile.id,
    name: "renamed",
  });
  const stale = await f.call("testmaster_save_auth_profile", {
    profileId: profile.id,
    expectedVersion: profile.version + 5,
    name: "renamed",
  });
  expect([kind, unversioned, stale].map((outcome) => outcome.error?.code)).toEqual([
    "INVALID_ARGUMENT",
    "INVALID_ARGUMENT",
    "REVISION_CONFLICT",
  ]);
  const renamed = await f.call("testmaster_save_auth_profile", {
    profileId: profile.id,
    expectedVersion: profile.version,
    name: "renamed",
  });
  expect(renamed.isError, renamed.text).toBe(false);
  expect(renamed.body).toMatchObject({ id: profile.id, name: "renamed", version: 2 });

  // An environment can only use a profile bound to its target origin.
  const elsewhereSecret = await f.call("testmaster_set_secret", {
    name: "ELSEWHERE",
    valueFile: "token.txt",
    allowedOrigins: ["https://elsewhere.example.test"],
  });
  const other = await f.call("testmaster_save_auth_profile", {
    projectId: f.init.projectId,
    name: "elsewhere",
    kind: "bearer",
    originBindings: ["https://elsewhere.example.test"],
    secrets: { token: String(elsewhereSecret.body.id) },
    config: {},
  });
  expect(other.isError, other.text).toBe(false);
  const unbound = await f.call("testmaster_update_environment", {
    environmentId: environment.id,
    expectedVersion: Number(environment.version),
    authRefs: [String(other.body.id)],
  });
  expect(unbound.error?.code).toBe("PRECONDITION_FAILED");
  expect(unbound.error?.details).toMatchObject({ reasonCode: "security_precondition_failed" });

  const bound = await f.call("testmaster_update_environment", {
    environmentId: environment.id,
    expectedVersion: Number(environment.version),
    authRefs: [profile.id],
    additionalOrigins: ["https://cdn.example.test"],
  });
  expect(bound.isError, bound.text).toBe(false);
  const updated = f.app.environments.get(environment.id);
  expect(updated.version).toBe(2);
  expect(bound.body).toMatchObject({
    environment: { id: environment.id, version: 2 },
    revision: {
      id: updated.activeRevisionId,
      authProfileRefs: [profile.id],
      additionalOrigins: ["https://cdn.example.test"],
    },
  });
  expect(f.app.environments.revisions(environment.id)[0]?.authProfileRefs).toEqual([profile.id]);

  // A stale version and an empty patch are refused.
  const outdated = await f.call("testmaster_update_environment", {
    environmentId: environment.id,
    expectedVersion: Number(environment.version),
    locale: "pt-BR",
  });
  const empty = await f.call("testmaster_update_environment", {
    environmentId: environment.id,
    expectedVersion: Number(updated.version),
  });
  expect([outdated.error?.code, empty.error?.code]).toEqual([
    "REVISION_CONFLICT",
    "INVALID_ARGUMENT",
  ]);
  // Control: a patch of one field keeps the bindings it did not mention.
  const relocated = await f.call("testmaster_update_environment", {
    environmentId: environment.id,
    expectedVersion: Number(updated.version),
    locale: "pt-BR",
  });
  expect(relocated.body.revision).toMatchObject({
    locale: "pt-BR",
    authProfileRefs: [profile.id],
    additionalOrigins: ["https://cdn.example.test"],
  });
});

it("save_auth_profile takes the username as a plain value, says it is not masked and refuses a plain password", async () => {
  const f = await fixture();
  const [target] = f.app.environments.revisions(f.init.environmentId)[0]?.targetOrigins ?? [];
  if (!target) throw new Error("Missing target origin");
  await writeFile(join(f.cwd, "password.txt"), "pw-value\n");
  const secret = await f.call("testmaster_set_secret", {
    name: "PASSWORD",
    valueFile: "password.txt",
    allowedOrigins: [target],
  });
  const passwordId = String(secret.body.id);
  const tool = (await f.client.listTools()).tools.find(
    (item) => item.name === "testmaster_save_auth_profile",
  );
  const schema = tool?.inputSchema as
    | { properties?: Record<string, { description?: string }> }
    | undefined;
  expect(schema?.properties?.username?.description).toContain("NOT masked");
  expect(tool?.description).toContain("unmasked");

  const created = await f.call("testmaster_save_auth_profile", {
    projectId: f.init.projectId,
    name: "basic-plain",
    kind: "basic",
    originBindings: [target],
    secrets: { password: passwordId },
    username: "root",
    config: {},
  });
  expect(created.isError, created.text).toBe(false);
  expect(created.body).toMatchObject({ username: "root", secrets: { password: passwordId } });

  // A plain value in `secrets` is refused, and the refusal names the role.
  const refused = await f.call("testmaster_save_auth_profile", {
    projectId: f.init.projectId,
    name: "basic-plain-password",
    kind: "basic",
    originBindings: [target],
    secrets: { password: "hunter2-plain" },
    username: "root",
    config: {},
  });
  expect(refused.error?.code).toBe("INVALID_ARGUMENT");
  expect(refused.text).toContain("password");
  expect(f.app.authProfiles.list(f.init.projectId).map((item) => item.name)).toEqual([
    "basic-plain",
  ]);
});

it("save_auth_profile advertises the config keys per kind and rejects a malformed config naming its fields", async () => {
  const f = await fixture();
  type Node = { properties?: Record<string, Node>; required?: string[] };
  const input = (await f.client.listTools()).tools.find(
    (tool) => tool.name === "testmaster_save_auth_profile",
  )?.inputSchema as Node | undefined;
  const config = input?.properties?.config;
  expect(Object.keys(config?.properties ?? {})).toEqual(
    expect.arrayContaining(["http", "browser", "adapter", "issuer", "redirectUris", "header"]),
  );
  const http = config?.properties?.http;
  expect([...(http?.required ?? [])].sort()).toEqual([
    "contentType",
    "fields",
    "loginUrl",
    "success",
  ]);
  expect(http?.properties?.success?.required).toEqual(["statusIn"]);

  const rejected = await f.call("testmaster_save_auth_profile", {
    projectId: f.init.projectId,
    name: "login",
    kind: "form",
    originBindings: ["http://127.0.0.1:20311"],
    secrets: {},
    config: {
      http: {
        loginUrl: "http://127.0.0.1:20311/auth/login",
        contentType: "xml",
        fields: { username: "username" },
        success: {},
      },
    },
  });
  expect(rejected.error?.code).toBe("INVALID_ARGUMENT");
  const issues = (rejected.error?.details.issues ?? []) as { path: string; message: string }[];
  expect(issues.map((issue) => issue.path)).toEqual(
    expect.arrayContaining([
      "/config/http/contentType",
      "/config/http/fields",
      "/config/http/success",
    ]),
  );
  expect(issues.find((issue) => issue.path === "/config/http/contentType")?.message).toContain(
    "form, json",
  );
});

it("normalize keeps each conflict's id, reason and requirements and counts one conflict in the singular", async () => {
  const f = await fixture();
  const ref = { sourceRevisionId: "svr_019bf434-20c0-7000-8000-000000000001" };
  const requirement = entity(f.app.context, "req", {
    text: "x".repeat(8000),
    acceptanceCriteria: Array.from({ length: 5 }, () => "y".repeat(8000)),
    sourceRefs: [],
    originKind: "explicit",
    confidence: null,
    approval: null,
  });
  const conflict = {
    id: "conflict-1",
    requirementIds: [requirement.id],
    reason: "Implementation inference requires reconciliation",
    sourceRefs: [ref, ref],
    resolution: null,
  };
  const normalize = vi
    .spyOn(Object.getPrototypeOf(f.app.requirements), "normalize")
    .mockResolvedValue({
      requirements: [requirement],
      conflicts: [conflict],
      openQuestions: [],
      version: 4,
      fingerprint: "fingerprint-under-test",
    } as never);
  const args = {
    projectId: f.init.projectId,
    sourceRevisionIds: ["svr_019bf434-20c0-7000-8000-000000000001"],
  };
  const result = await f.client.callTool({
    name: "testmaster_normalize_requirements",
    arguments: args,
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    conflicts: [
      {
        id: "conflict-1",
        reason: conflict.reason,
        requirementIds: [requirement.id],
        left: ref,
        right: ref,
      },
    ],
  });
  // The snapshot is large, so the text is a summary: one requirement, one conflict, no plural.
  expect(firstText(result.content)).toContain(
    "Normalized 1 requirement and 1 conflict (snapshot version 4)",
  );
  // Control: other counts are plural.
  normalize.mockResolvedValue({
    requirements: [requirement, requirement],
    conflicts: [],
    openQuestions: [],
    version: 5,
    fingerprint: "fingerprint-under-test",
  } as never);
  const plural = await f.client.callTool({
    name: "testmaster_normalize_requirements",
    arguments: args,
  });
  expect(firstText(plural.content)).toContain("Normalized 2 requirements and 0 conflicts");
});

it("test_auth_login signs in with a profile bound to the environment, reports a blocked one and needs the execution scope", async () => {
  const f = await fixture();
  const environment = f.app.environments.get(f.init.environmentId);
  const [target] = f.app.environments.revisions(environment.id)[0]?.targetOrigins ?? [];
  if (!target) throw new Error("Missing target origin");
  await writeFile(join(f.cwd, "token.txt"), "bearer-value-under-test\n");
  const profileFor = async (name: string, origin: string) => {
    const secret = await f.call("testmaster_set_secret", {
      name: name.toUpperCase(),
      valueFile: "token.txt",
      allowedOrigins: [origin],
    });
    const created = await f.call("testmaster_save_auth_profile", {
      projectId: f.init.projectId,
      name,
      kind: "bearer",
      originBindings: [origin],
      secrets: { token: String(secret.body.id) },
      config: {},
    });
    expect(created.isError, created.text).toBe(false);
    return String(created.body.id);
  };
  const bound = await profileFor("api", target);
  const signedIn = await f.call("testmaster_test_auth_login", {
    profileId: bound,
    environmentId: environment.id,
  });
  expect(signedIn.isError, signedIn.text).toBe(false);
  expect(signedIn.body).toMatchObject({
    profileId: bound,
    environmentId: environment.id,
    outcome: "authenticated",
    credentialRoles: ["token"],
    draftsChanged: false,
  });
  expect(signedIn.text).not.toContain("bearer-value-under-test");

  // A profile bound to another origin cannot sign in to this environment: a receipt, not a throw.
  const elsewhere = await profileFor("elsewhere", "https://elsewhere.example.test");
  const blocked = await f.call("testmaster_test_auth_login", {
    profileId: elsewhere,
    environmentId: environment.id,
  });
  expect(blocked.isError, blocked.text).toBe(false);
  expect(blocked.body).toMatchObject({
    outcome: "blocked",
    reasonCode: "security_precondition_failed",
  });

  // Like the CLI command, the call needs the execution scope: reading and writing are not enough.
  const writer = await fixture(["R", "W"]);
  const denied = await writer.call("testmaster_test_auth_login", {
    profileId: bound,
    environmentId: environment.id,
  });
  expect(denied.isError).toBe(true);
  expect(denied.error?.code).toBe("FORBIDDEN");
});
