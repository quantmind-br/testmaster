import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, entity, issueLocalToken, scaffoldPlan } from "@testmaster/application";
import type { ExecutablePlan } from "@testmaster/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./server.js";

/** The authoring endpoints over HTTP: envelopes, status codes, authorization and conflict handling. */
let cwd = "";
let application: Application;
let server: ReturnType<typeof createServer>;
let projectId = "";
let writer = "";
let reader = "";
let requirementId = "";

function seedRequirement(): string {
  const { context } = application;
  const requirement = entity(context, "req", {
    text: "The health endpoint reports ok",
    acceptanceCriteria: ["Health reports ok"],
    sourceRefs: [],
    originKind: "user_spec",
    confidence: null,
    approval: null,
    extensions: { "testmaster:projectId": projectId, "testmaster:key": "A" },
  });
  context.entities.insert("Requirement", requirement, { projectId });
  context.database.run(
    "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    `requirements:${context.workspaceId}:${projectId}`,
    JSON.stringify({
      requirements: [requirement],
      conflicts: [],
      openQuestions: [],
      version: 1,
      fingerprint: "seeded",
    }),
  );
  application.requirements.approve(requirement.id, 1);
  return requirement.id;
}

function seedBatch(names: readonly string[]): { batchId: string; proposalIds: string[] } {
  const { context } = application;
  const batch = entity(context, "pbt", {
    projectId,
    sourceSnapshotId: application.requirements.snapshot(projectId).fingerprint,
    state: "proposed",
    extensions: {},
  });
  context.entities.insert("ProposalBatch", batch);
  const proposalIds = names.map((name) => {
    const plan = scaffoldPlan("backend");
    plan.name = name;
    plan.requirementRefs = [requirementId];
    const proposal = entity(context, "pro", {
      batchId: batch.id,
      plan,
      requirementRefs: [requirementId],
      evidenceRefs: [],
      warnings: [],
      state: "proposed",
      validation: "valid",
      extensions: { "testmaster:authorship": { kind: "llm", modelCallId: "seed" } },
    });
    context.entities.insert("Proposal", proposal);
    return proposal.id;
  });
  return { batchId: batch.id, proposalIds };
}

const call = (
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  options: { token?: string; body?: unknown; ifMatch?: number } = {},
) =>
  server.inject({
    method,
    url: `/v1${url}`,
    headers: {
      authorization: `Bearer ${options.token ?? writer}`,
      ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }),
      ...(options.ifMatch === undefined ? {} : { "if-match": `"${options.ifMatch}"` }),
    },
    ...(options.body === undefined ? {} : { payload: options.body as object }),
  });

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "tm-s4b-http-"));
  const home = join(cwd, "home");
  await mkdir(home);
  application = await Application.open({ cwd, home, env: {} });
  projectId = (await application.init()).projectId;
  writer = (await issueLocalToken(application)).token;
  reader = (await issueLocalToken(application, { scopes: ["R"], tokenPath: join(home, "r.token") }))
    .token;
  server = createServer({ application, mcp: false });
  requirementId = seedRequirement();
});

afterAll(async () => {
  await server?.close();
  application?.close();
  await rm(cwd, { recursive: true, force: true });
});

describe("authoring endpoints", () => {
  it("UX-015 UX-016 lists batch summaries and previews what accepting would create, and refuses an unknown proposal", async () => {
    const { batchId, proposalIds } = seedBatch(["Alpha", "Beta"]);
    const listed = await call("GET", `/projects/${projectId}/proposal-batches`);
    expect(listed.statusCode, listed.body).toBe(200);
    const summary = (
      listed.json().data.items as { id: string; counts: Record<string, number> }[]
    ).find((item) => item.id === batchId);
    expect(summary?.counts).toEqual({ proposed: 2, accepted: 0, rejected: 0 });

    const preview = await call("POST", `/proposal-batches/${batchId}/preview`, {
      body: { proposalIds },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const data = preview.json().data;
    expect(data.policy).toMatchObject({ channel: "interactive", canAccept: true });
    expect(data.items).toHaveLength(2);
    expect(data.items[0]).toMatchObject({
      selectable: true,
      revision: { action: "create_test", ordinal: 1 },
    });

    const unknown = await call("POST", `/proposal-batches/${batchId}/preview`, {
      body: { proposalIds: [`pro_${randomUUID()}`] },
    });
    expect(unknown.statusCode).toBeGreaterThanOrEqual(400);
    expect(unknown.statusCode).toBeLessThan(500);
  });

  it("UX-019 a read-only token previews but is told it cannot accept, and cannot refine", async () => {
    const { batchId, proposalIds } = seedBatch(["Gamma"]);
    const preview = await call("POST", `/proposal-batches/${batchId}/preview`, {
      token: reader,
      body: { proposalIds },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().data.policy.canAccept).toBe(false);
    const refine = await call("POST", `/proposals/${proposalIds[0]}/refinements`, {
      token: reader,
      body: { message: "Add a header check", expectedVersion: 1 },
    });
    expect(refine.statusCode).toBe(403);
  });

  it("UX-022 plan validation names the failing field and step, and offers a run only when the plan is clean", async () => {
    const clean = await call("POST", `/projects/${projectId}/plan-validations`, {
      body: { plan: scaffoldPlan("backend") },
    });
    expect(clean.statusCode, clean.body).toBe(200);
    expect(clean.json().data).toMatchObject({ valid: true, issues: [] });

    const broken = scaffoldPlan("backend") as unknown as {
      steps: { id: string; kind: string; input?: { headers: Record<string, unknown> } }[];
    };
    const request = broken.steps.find((step) => step.id === "get-health");
    if (!request?.input) throw new Error("Unexpected scaffold");
    request.input.headers = {
      "x-api-key": { secretRef: "sec_00000000-0000-4000-8000-000000000000" },
    };
    const rejected = await call("POST", `/projects/${projectId}/plan-validations`, {
      body: { plan: broken as unknown as ExecutablePlan },
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    const result = rejected.json().data;
    expect(result.valid).toBe(false);
    expect(result.runnable).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ severity: "error", stepId: "get-health" }),
    );
  });

  it("UX-023 UX-024 a draft is saved, conflicts on a stale version, and is discarded; history lists the revision", async () => {
    const plan = scaffoldPlan("backend");
    plan.name = "Drafted";
    plan.requirementRefs = [requirementId];
    const test = application.tests.create({ projectId, plan });
    const revisionId = test.activeRevisionId as string;

    const missing = await call("GET", `/tests/${test.id}/draft`);
    expect(missing.statusCode).toBe(404);

    const saved = await call("PUT", `/tests/${test.id}/draft`, {
      body: { baseRevisionId: revisionId, plan },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data).toMatchObject({ version: 1, baseSuperseded: false });

    const stale = await call("PUT", `/tests/${test.id}/draft`, {
      body: { baseRevisionId: revisionId, plan, expectedVersion: 7 },
    });
    expect(stale.statusCode).toBe(412);
    expect((await call("GET", `/tests/${test.id}/draft`)).json().data.version).toBe(1);

    const discarded = await call("DELETE", `/tests/${test.id}/draft`);
    expect(discarded.statusCode, discarded.body).toBe(200);
    expect((await call("GET", `/tests/${test.id}/draft`)).statusCode).toBe(404);

    const history = await call("GET", `/tests/${test.id}/history`);
    expect(history.statusCode, history.body).toBe(200);
    const entries = history.json().data.items as { id: string; changeKinds: string[] }[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: revisionId, changeKinds: ["initial"] });

    const forbidden = await call("PUT", `/tests/${test.id}/draft`, {
      token: reader,
      body: { baseRevisionId: revisionId, plan },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("REQ-054 an untouched refinement thread is empty and a refinement of an unknown subject is refused", async () => {
    const { proposalIds } = seedBatch(["Delta"]);
    const thread = await call("GET", `/proposals/${proposalIds[0]}/refinements`);
    expect(thread.statusCode, thread.body).toBe(200);
    expect(thread.json().data).toMatchObject({
      subject: { kind: "proposal", id: proposalIds[0] },
      turns: [],
      proposal: null,
    });
    const unknown = await call("POST", `/proposals/pro_${randomUUID()}/refinements`, {
      body: { message: "Add a check", expectedVersion: 1 },
    });
    expect(unknown.statusCode).toBe(404);
  });
});
