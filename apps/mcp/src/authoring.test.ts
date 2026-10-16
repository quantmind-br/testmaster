import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Application, entity, scaffoldPlan } from "@testmaster/application";
import { uuidV7IdGenerator } from "@testmaster/domain";
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
// biome-ignore lint/suspicious/noExplicitAny: tests read nested fields of structured content
type Data = Record<string, any>;

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-mcp-authoring-"));
  const app = await Application.open({ cwd, home: join(cwd, "home"), env: {} });
  const init = await app.init();
  // No run executes: the worker is reported live so admission never starts one, as in lists.test.ts.
  vi.spyOn(Application.prototype, "preflight").mockResolvedValue();
  vi.spyOn(Object.getPrototypeOf(app.worker), "live").mockReturnValue(true);
  cleanups.push(async () => {
    app.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const connect = async (principalId = init.principalId, scopes: Scope[] = ["R", "W", "X"]) => {
    const server = createMcpServer({
      application: app.forIdentity({ principalId, scopes }),
      roots: [cwd],
    });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(right);
    const client = new Client({ name: "authoring-test", version: "1" });
    await client.connect(left);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const body = JSON.parse(String((result.content as { text: string }[])[0]?.text)) as Record<
        string,
        unknown
      >;
      return {
        isError: result.isError === true,
        body,
        data: result.structuredContent as Data | undefined,
        error: body.error as Failure | undefined,
      };
    };
    return { client, call };
  };
  return { app, init, connect };
}

it("MCP authoring tools are annotated by what they change", async () => {
  const f = await fixture();
  const { client } = await f.connect();
  const tools = (await client.listTools()).tools;
  const annotations = (name: string) => tools.find((tool) => tool.name === name)?.annotations;
  expect(annotations("testmaster_save_test")).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
  });
  expect(annotations("testmaster_approve_execution")).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
  });
  for (const name of [
    "testmaster_edit_plan",
    "testmaster_promote_revision",
    "testmaster_save_suite",
  ])
    expect(annotations(name), name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
});

it("edit_plan replaces a proposed plan at its expected version and refuses a stale or invalid one", async () => {
  const f = await fixture();
  const { call } = await f.connect();
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
    state: "proposed",
    validation: "valid",
  });
  f.app.context.entities.insert("Proposal", proposal);
  const edited = await call("testmaster_edit_plan", {
    proposalId: proposal.id,
    plan: { ...scaffoldPlan("backend"), name: "Edited by the agent" },
    expectedVersion: 1,
  });
  expect(edited.isError).toBe(false);
  expect(edited.data).toMatchObject({ id: proposal.id, version: 2 });
  expect(edited.data?.plan.name).toBe("Edited by the agent");
  expect(edited.data?.extensions["testmaster:edits"]).toHaveLength(1);
  const stale = await call("testmaster_edit_plan", {
    proposalId: proposal.id,
    plan: scaffoldPlan("backend"),
    expectedVersion: 1,
  });
  expect(stale.error?.code).toBe("REVISION_CONFLICT");
  const invalid = await call("testmaster_edit_plan", {
    proposalId: proposal.id,
    plan: { kind: "executable" },
    expectedVersion: 2,
  });
  expect(invalid.error?.code).toBe("INVALID_ARGUMENT");
  expect(f.app.proposals.detail(batch.id).proposals[0]?.version).toBe(2);
});

it("save_test stores a new test as active, keeps a new revision a candidate and promote_revision activates it", async () => {
  const f = await fixture();
  const { call } = await f.connect();
  const created = await call("testmaster_save_test", {
    projectId: f.init.projectId,
    plan: scaffoldPlan("backend"),
    name: "Saved by the agent",
    tags: ["agent"],
    justification: "Hand-written plan",
  });
  expect(created.isError).toBe(false);
  const test = created.data?.test;
  expect(test).toMatchObject({ name: "Saved by the agent", tags: ["agent"] });
  expect(created.data?.active).toBe(true);
  expect(test.activeRevisionId).toBe(created.data?.revision.id);
  expect(created.data?.nextActions).toEqual([]);

  const candidate = await call("testmaster_save_test", {
    testId: test.id,
    plan: { ...scaffoldPlan("backend"), name: "Revised plan" },
    parentRevisionId: test.activeRevisionId,
  });
  expect(candidate.isError).toBe(false);
  expect(candidate.data?.active).toBe(false);
  expect(candidate.data?.revision).toMatchObject({ testId: test.id, ordinal: 2 });
  // Runs keep using the first revision until the candidate is promoted, and the receipt says how.
  expect(f.app.tests.get(test.id).activeRevisionId).toBe(test.activeRevisionId);
  const next = String(candidate.data?.nextActions[0]);
  expect(next).toContain("testmaster_promote_revision");
  expect(next).toContain(`revisionId ${candidate.data?.revision.id}`);
  expect(next).toContain(`expectedVersion ${candidate.data?.test.version}`);

  const stale = await call("testmaster_promote_revision", {
    revisionId: candidate.data?.revision.id,
    expectedVersion: Number(candidate.data?.test.version) + 1,
  });
  expect(stale.error?.code).toBe("REVISION_CONFLICT");
  const promoted = await call("testmaster_promote_revision", {
    revisionId: candidate.data?.revision.id,
    expectedVersion: candidate.data?.test.version,
  });
  expect(promoted.isError).toBe(false);
  expect(promoted.data?.activeRevisionId).toBe(candidate.data?.revision.id);
  expect(f.app.tests.get(test.id).activeRevisionId).toBe(candidate.data?.revision.id);
});

it("save_test needs exactly one of projectId and testId and keeps test fields off revisions", async () => {
  const f = await fixture();
  const { call } = await f.connect();
  const plan = scaffoldPlan("backend");
  const test = f.app.tests.create({ projectId: f.init.projectId, plan });
  const both = await call("testmaster_save_test", {
    plan,
    projectId: f.init.projectId,
    testId: test.id,
  });
  expect(both.error?.code).toBe("INVALID_ARGUMENT");
  const neither = await call("testmaster_save_test", { plan });
  expect(neither.error?.code).toBe("INVALID_ARGUMENT");
  const renamed = await call("testmaster_save_test", { plan, testId: test.id, name: "Other" });
  expect(renamed.error?.code).toBe("INVALID_ARGUMENT");
  expect(renamed.error?.message).toContain("name");
  const parent = await call("testmaster_save_test", {
    plan,
    projectId: f.init.projectId,
    parentRevisionId: test.activeRevisionId,
  });
  expect(parent.error?.code).toBe("INVALID_ARGUMENT");
  expect(f.app.revisions.list(test.id)).toHaveLength(1);
  expect(f.app.tests.list(f.init.projectId)).toHaveLength(1);
  const reader = await f.connect(f.init.principalId, ["R"]);
  const denied = await reader.call("testmaster_save_test", { plan, testId: test.id });
  expect(denied.error?.code).toBe("FORBIDDEN");
});

it("run_tests with revisionId runs that exact revision and refuses it with several tests or a list", async () => {
  const f = await fixture();
  const { call } = await f.connect();
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const other = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const candidate = f.app.revisions.create(
    test.id,
    { ...scaffoldPlan("backend"), name: "Candidate" },
    String(test.activeRevisionId),
  );
  const runOf = (data: Data | undefined) => f.app.runs.get(String(data?.memberRuns[0].runId));
  // Positive control: without revisionId the active revision runs.
  const active = await call("testmaster_run_tests", {
    testIds: [test.id],
    environmentId: f.init.environmentId,
    mode: "replay",
  });
  expect(active.isError).toBe(false);
  expect(runOf(active.data).revisionId).toBe(test.activeRevisionId);
  const pinned = await call("testmaster_run_tests", {
    testIds: [test.id],
    environmentId: f.init.environmentId,
    revisionId: candidate.id,
    mode: "replay",
  });
  expect(pinned.isError).toBe(false);
  expect(runOf(pinned.data).revisionId).toBe(candidate.id);
  expect(f.app.tests.get(test.id).activeRevisionId).toBe(test.activeRevisionId);

  const many = await call("testmaster_run_tests", {
    testIds: [test.id, other.id],
    environmentId: f.init.environmentId,
    revisionId: candidate.id,
    mode: "replay",
  });
  expect(many.error?.code).toBe("INVALID_ARGUMENT");
  const foreign = await call("testmaster_run_tests", {
    testIds: [other.id],
    environmentId: f.init.environmentId,
    revisionId: candidate.id,
    mode: "replay",
  });
  expect(foreign.error?.code).toBe("PRECONDITION_FAILED");
  const suite = f.app.suites.create({
    name: "nightly",
    selection: {
      kind: "dynamic",
      projects: [{ projectId: f.init.projectId, environmentId: f.init.environmentId }],
    },
  });
  const listed = await call("testmaster_run_tests", {
    suiteId: suite.id,
    revisionId: candidate.id,
    mode: "replay",
  });
  expect(listed.error?.code).toBe("INVALID_ARGUMENT");
  expect(f.app.runs.list()).toHaveLength(2);
});

it("save_suite creates a fixed list, adds and removes members at the expected version and refuses misuse", async () => {
  const f = await fixture();
  const { call } = await f.connect();
  const first = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const second = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const member = (test: { id: string; activeRevisionId: string | null }) => ({
    testId: test.id,
    revisionId: String(test.activeRevisionId),
    environmentId: f.init.environmentId,
  });
  const created = await call("testmaster_save_suite", {
    name: "smoke",
    description: "Agent smoke list",
    addMembers: [member(first)],
  });
  expect(created.isError).toBe(false);
  expect(created.data).toMatchObject({
    name: "smoke",
    version: 1,
    state: "active",
    selection: { kind: "fixed", members: [member(first)] },
  });
  const suiteId = String(created.data?.id);
  const added = await call("testmaster_save_suite", {
    suiteId,
    expectedVersion: 1,
    addMembers: [member(second)],
  });
  expect(added.data?.version).toBe(2);
  expect(added.data?.selection.members).toEqual([member(first), member(second)]);
  const removed = await call("testmaster_save_suite", {
    suiteId,
    expectedVersion: 2,
    removeMembers: [{ testId: first.id }],
  });
  expect(removed.data?.version).toBe(3);
  expect(removed.data?.selection.members).toEqual([member(second)]);

  const stale = await call("testmaster_save_suite", {
    suiteId,
    expectedVersion: 2,
    name: "renamed",
  });
  expect(stale.error?.code).toBe("REVISION_CONFLICT");
  const unmatched = await call("testmaster_save_suite", {
    suiteId,
    expectedVersion: 3,
    removeMembers: [{ testId: first.id }],
  });
  expect(unmatched.error?.code).toBe("INVALID_ARGUMENT");
  expect(unmatched.error?.details).toMatchObject({ unmatched: [{ testId: first.id }] });
  const withoutVersion = await call("testmaster_save_suite", { suiteId, name: "renamed" });
  expect(withoutVersion.error?.code).toBe("INVALID_ARGUMENT");
  const empty = await call("testmaster_save_suite", { suiteId, expectedVersion: 3 });
  expect(empty.error?.code).toBe("INVALID_ARGUMENT");
  const unnamed = await call("testmaster_save_suite", { addMembers: [member(first)] });
  expect(unnamed.error?.code).toBe("INVALID_ARGUMENT");
  expect(f.app.suites.get(suiteId).version).toBe(3);

  // A dynamic list has no members to add to or remove from; its selection is replaced instead.
  const dynamic = await call("testmaster_save_suite", {
    name: "everything",
    selection: {
      kind: "dynamic",
      projects: [{ projectId: f.init.projectId, environmentId: f.init.environmentId }],
    },
  });
  expect(dynamic.isError).toBe(false);
  const misuse = await call("testmaster_save_suite", {
    suiteId: dynamic.data?.id,
    expectedVersion: 1,
    addMembers: [member(first)],
  });
  expect(misuse.error?.code).toBe("PRECONDITION_FAILED");
  const replaced = await call("testmaster_save_suite", {
    suiteId: dynamic.data?.id,
    expectedVersion: 1,
    selection: { kind: "fixed", members: [member(first)] },
  });
  expect(replaced.data?.selection.kind).toBe("fixed");
});

it("a token principal approves a refused production run through approve_execution and the run is then admitted", async () => {
  const f = await fixture();
  const service = uuidV7IdGenerator.next("svc");
  f.app.context.entities.insert("Principal", {
    id: service,
    workspaceId: f.init.workspaceId,
    kind: "service",
    displayName: "Coding agent",
    disabledAt: null,
  });
  // An API-token principal acts through its role like anyone else: no human kind, no special grant.
  f.app.context.entities.insert("Membership", {
    id: uuidV7IdGenerator.next("mem"),
    workspaceId: f.init.workspaceId,
    principalId: service,
    role: "maintainer",
    projectRestrictions: [],
  });
  const production = f.app.environments.create({
    projectId: f.init.projectId,
    name: "production",
    baseUrl: "https://example.com",
    production: true,
  });
  const plan = scaffoldPlan("backend");
  const request = plan.steps[0];
  if (request?.operation !== "request") throw new Error("Expected request scaffold");
  request.input.method = "DELETE";
  request.description = "Delete the owned test account";
  const test = f.app.tests.create({ projectId: f.init.projectId, plan });
  const { call } = await f.connect(service, ["R", "W", "X"]);
  const run = {
    testIds: [test.id],
    environmentId: production.id,
    mode: "replay",
  };
  const refused = await call("testmaster_run_tests", run);
  expect(refused.error?.code).toBe("POLICY_DENIED");
  expect(refused.error?.details.reasonCode).toBe("approval_required");
  const binding = refused.error?.details.binding as Record<string, unknown>;
  expect(binding).toMatchObject({ actorId: service, originSet: ["https://example.com"] });

  const approved = await call("testmaster_approve_execution", {
    ...binding,
    reason: "Agent reviewed the destructive step against the production fixture",
  });
  expect(approved.error).toBeUndefined();
  expect(approved.data).toMatchObject({ reviewerId: service, actorId: service, revokedAt: null });
  const audited = f.app.database.get(
    "SELECT actor FROM audit_events WHERE action='approval.created' AND resource_id=?",
    String(approved.data?.id),
  );
  expect(audited?.actor).toBe(service);

  const admitted = await call("testmaster_run_tests", run);
  expect(admitted.isError).toBe(false);
  expect(f.app.runs.list()).toHaveLength(1);
  // The approval is single-use: a second run needs a new decision.
  const again = await call("testmaster_run_tests", run);
  expect(again.error?.code).toBe("POLICY_DENIED");
});

it("approve_execution refuses a missing reason, a foreign reviewer and a caller without write scope", async () => {
  const f = await fixture();
  const revision = f.app.tests.create({
    projectId: f.init.projectId,
    plan: scaffoldPlan("backend"),
  });
  const environment = f.app.environments.get(f.init.environmentId);
  const binding = {
    actionSet: ["write"],
    revisionHash: f.app.revisions.get(String(revision.activeRevisionId)).contentHash,
    environmentRevisionId: environment.activeRevisionId,
    originSet: ["https://example.com"],
    policyHash: "a".repeat(64),
  };
  const { call } = await f.connect();
  const blank = await call("testmaster_approve_execution", { ...binding, reason: "" });
  expect(blank.error?.code).toBe("INVALID_ARGUMENT");
  const missing = await call("testmaster_approve_execution", binding);
  expect(missing.error?.code).toBe("INVALID_ARGUMENT");
  const reader = await f.connect(f.init.principalId, ["R"]);
  const denied = await reader.call("testmaster_approve_execution", { ...binding, reason: "ok" });
  expect(denied.error?.code).toBe("FORBIDDEN");
  expect(f.app.approvals.list()).toHaveLength(0);
});

it("get_evidence says why a run is stale and treats the run of a candidate revision as current", async () => {
  const f = await fixture();
  const { call } = await f.connect();
  vi.spyOn(Object.getPrototypeOf(f.app.artifacts), "get").mockImplementation((async (
    runId: string,
  ) => {
    const run = f.app.runs.get(runId);
    return {
      manifest: {
        schemaVersion: "1.0.0",
        runId,
        attemptId: "att_019bf434-20c0-7000-8000-000000000001",
        revisionId: run.revisionId,
        snapshotId: "snp_019bf434-20c0-7000-8000-000000000001",
        entries: [],
      },
    };
  }) as never);
  const test = f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") });
  const first = String(test.activeRevisionId);
  const candidate = f.app.revisions.create(
    test.id,
    { ...scaffoldPlan("backend"), name: "Candidate" },
    first,
  );
  const passed = (revisionId: string) => {
    const run = f.app.runs.resolve({
      testId: test.id,
      environmentId: f.init.environmentId,
      revisionId,
    });
    Object.assign(run, { phase: "completed", status: "passed", outcome: "passed", gate: "passed" });
    f.app.context.entities.insert("Run", run);
    return String(run.id);
  };
  const baseline = passed(first);
  const underTest = passed(candidate.id);
  const current = await call("testmaster_get_evidence", { runId: underTest });
  expect(current.data).toMatchObject({
    freshness: "current",
    staleReasons: [],
    verificationEligible: true,
  });
  expect((await call("testmaster_get_evidence", { runId: baseline })).data?.freshness).toBe(
    "current",
  );

  f.app.revisions.promote(candidate.id, Number(f.app.tests.get(test.id).version));
  const superseded = await call("testmaster_get_evidence", { runId: baseline });
  expect(superseded.data).toMatchObject({ freshness: "stale", verificationEligible: false });
  expect(superseded.data?.staleReasons).toEqual([
    {
      code: "revision_superseded",
      message: expect.stringContaining(`${first} (#1)`),
    },
  ]);
  expect(superseded.data?.staleReasons[0].message).toContain(`${candidate.id} (#2)`);
  expect((await call("testmaster_get_evidence", { runId: underTest })).data?.freshness).toBe(
    "current",
  );

  const environment = f.app.environments.get(f.init.environmentId);
  f.app.environments.update(
    environment.id,
    { baseUrl: "http://127.0.0.1:4010" },
    Number(environment.version),
  );
  const moved = await call("testmaster_get_evidence", { runId: underTest });
  expect(moved.data?.freshness).toBe("stale");
  expect(moved.data?.staleReasons.map((reason: { code: string }) => reason.code)).toEqual([
    "environment_revision_changed",
  ]);
});
