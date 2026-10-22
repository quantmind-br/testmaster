import {
  ContractError,
  type EnvironmentRevision,
  type ExecutablePlan,
} from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { EntityRepository, PersistenceDatabase } from "@testmaster/persistence";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalsService, planRiskActions } from "./approvals.js";
import {
  EnvironmentsService,
  ProjectsService,
  RevisionsService,
  scaffoldPlan,
  TestsService,
} from "./authoring.js";
import type { ServiceContext } from "./context.js";

const databases: PersistenceDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
async function setup(plan?: ExecutablePlan) {
  const database = PersistenceDatabase.memory();
  databases.push(database);
  await database.migrate();
  const entities = new EntityRepository(database);
  const workspaceId = uuidV7IdGenerator.next("ws");
  const principalId = uuidV7IdGenerator.next("usr");
  entities.insert("Workspace", {
    id: workspaceId,
    workspaceId,
    name: "Local",
    mode: "single-user",
    settingsVersion: 1,
    quotaPolicyId: "local",
  });
  entities.insert("Principal", {
    id: principalId,
    workspaceId,
    kind: "human",
    displayName: "Owner",
    disabledAt: null,
  });
  const ctx: ServiceContext = {
    database,
    entities,
    workspaceId,
    principalId,
    authorize() {},
    authorizeNamed() {},
  };
  const project = new ProjectsService(ctx).create({ name: "Shop" });
  const environment = new EnvironmentsService(ctx).create({
    projectId: project.id,
    name: "production",
    baseUrl: "https://example.com",
    production: true,
  });
  const test = new TestsService(ctx).create({ projectId: project.id, plan: plan ?? riskyPlan() });
  const revision = new RevisionsService(ctx).get(test.activeRevisionId as string);
  const env = entities.get(
    "EnvironmentRevision",
    workspaceId,
    environment.activeRevisionId,
  ) as EnvironmentRevision;
  const run = {
    testId: test.id,
    revisionId: revision.id,
    environmentRevisionId: env.id,
    gatePolicy: { policyHash: "a".repeat(64) },
  };
  const input = {
    actionSet: ["destructive"],
    revisionHash: revision.contentHash,
    environmentRevisionId: env.id,
    originSet: ["https://example.com"],
    policyHash: "a".repeat(64),
    reason: "Approved by the production change review",
  };
  return {
    ctx,
    project,
    environment,
    test,
    revision,
    env,
    run,
    input,
    approvals: new ApprovalsService(ctx),
  };
}
function riskyPlan(): ExecutablePlan {
  const plan = scaffoldPlan("backend");
  const request = plan.steps[0];
  if (request?.operation !== "request") throw new Error("Expected request scaffold");
  request.risk = "read";
  request.description = "Delete the owned test account";
  request.input.pathSegments = [{ literal: "delete" }, { literal: "account" }];
  return plan;
}
function code(action: () => unknown, expected: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).code).toBe(expected);
    return;
  }
  throw new Error(`Expected ${expected}`);
}

describe("bound production approvals", () => {
  it("denies a destructive GET declared read, binds approval and consumes it once", async () => {
    const { approvals, run, test, env, input, ctx } = await setup();
    code(() => approvals.verify(run, test, env), "POLICY_DENIED");
    const approval = approvals.create(input);
    expect(approval.actorId).toBe(ctx.principalId);
    expect(approvals.verify(run, test, env)?.id).toBe(approval.id);
    expect(approvals.get(approval.id).revokedAt).not.toBeNull();
    code(() => approvals.verify(run, test, env), "POLICY_DENIED");
    expect(
      ctx.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM audit_events")?.count,
    ).toBeGreaterThanOrEqual(3);
  });
  it("does not consume approvals when admission transaction rolls back", async () => {
    const { approvals, run, test, env, input, ctx } = await setup();
    const approval = approvals.create(input);
    expect(() =>
      ctx.database.withTx(() => {
        approvals.verify(run, test, env);
        throw new Error("Admission failed");
      }),
    ).toThrow("Admission failed");
    expect(approvals.get(approval.id).revokedAt).toBeNull();
    expect(approvals.verify(run, test, env)?.id).toBe(approval.id);
  });
  it("rejects changes to policy, actor, revision and environment", async () => {
    const { approvals, run, test, env, input, ctx, environment } = await setup();
    approvals.create(input);
    code(
      () => approvals.verify({ ...run, gatePolicy: { policyHash: "b".repeat(64) } }, test, env),
      "POLICY_DENIED",
    );
    code(
      () => approvals.verify({ ...run, actorId: uuidV7IdGenerator.next("usr") }, test, env),
      "POLICY_DENIED",
    );
    const plan = riskyPlan();
    const request = plan.steps[0];
    if (request?.operation !== "request") throw new Error("Missing request");
    request.input.body = { kind: "json", value: { literal: { amount: 999 } } };
    const candidate = new RevisionsService(ctx).create(test.id, plan, run.revisionId);
    code(() => approvals.verify({ ...run, revisionId: candidate.id }, test, env), "POLICY_DENIED");
    const updated = new EnvironmentsService(ctx).update(
      environment.id,
      { baseUrl: "https://other.example.com" },
      environment.version as number,
    );
    const nextEnv = ctx.entities.get(
      "EnvironmentRevision",
      ctx.workspaceId,
      updated.activeRevisionId,
    ) as EnvironmentRevision;
    code(
      () => approvals.verify({ ...run, environmentRevisionId: nextEnv.id }, test, nextEnv),
      "POLICY_DENIED",
    );
    expect(approvals.verify(run, test, env)).not.toBeNull();
  });
  it("refuses changed effective limits without consuming the approval", async () => {
    const { approvals, input, run, test, env } = await setup();
    const approval = approvals.create(input);
    code(
      () => approvals.verify({ ...run, matrixCell: { limits: { timeoutMs: 1 } } }, test, env),
      "PRECONDITION_FAILED",
    );
    expect(approvals.get(approval.id).revokedAt).toBeNull();
    expect(approvals.verify(run, test, env)?.id).toBe(approval.id);
  });
  it("refuses credential rotation after approval without consuming it", async () => {
    const { ctx, approvals, input, run, test, env } = await setup();
    const id = uuidV7IdGenerator.next("sec");
    const secret = {
      id,
      workspaceId: ctx.workspaceId,
      version: 1,
      createdAt: new Date().toISOString(),
      provider: "vault",
      locator: "api",
      secretVersion: 1,
      allowedOrigins: ["https://example.com"],
    };
    ctx.entities.insert("SecretReference", secret);
    const plan = riskyPlan();
    const request = plan.steps[0];
    if (request?.operation !== "request") throw new Error("Missing request");
    request.input.headers = { Authorization: { secretRef: id } };
    const revision = new RevisionsService(ctx).create(test.id, plan, run.revisionId);
    const approval = approvals.create({ ...input, revisionHash: String(revision.contentHash) });
    ctx.entities.update("SecretReference", ctx.workspaceId, id, 1, {
      ...secret,
      version: 2,
      secretVersion: 2,
    });
    code(
      () => approvals.verify({ ...run, revisionId: revision.id }, test, env),
      "PRECONDITION_FAILED",
    );
    expect(approvals.get(approval.id).revokedAt).toBeNull();
  });
  it("requires complete origin and action scopes and supports explicit revocation", async () => {
    const { approvals, run, test, env, input } = await setup();
    const wrongAction = approvals.create({ ...input, actionSet: ["write"] });
    code(() => approvals.verify(run, test, env), "POLICY_DENIED");
    approvals.revoke(wrongAction.id);
    const wrongOrigin = approvals.create({ ...input, originSet: ["https://other.example.com"] });
    code(() => approvals.verify(run, test, env), "POLICY_DENIED");
    approvals.revoke(wrongOrigin.id);
    const valid = approvals.create(input);
    approvals.revoke(valid.id);
    code(() => approvals.verify(run, test, env), "POLICY_DENIED");
    expect(approvals.list()).toHaveLength(3);
  });
  it("rejects expired approval and spoofed reviewer", async () => {
    const { approvals, input } = await setup();
    code(
      () => approvals.create({ ...input, expiresAt: new Date(Date.now() - 1).toISOString() }),
      "INVALID_ARGUMENT",
    );
    code(
      () =>
        approvals.create({ ...input, expiresAt: new Date(Date.now() + 31 * 60_000).toISOString() }),
      "INVALID_ARGUMENT",
    );
    code(
      () => approvals.create({ ...input, reviewerId: uuidV7IdGenerator.next("usr") }),
      "FORBIDDEN",
    );
  });
  it("an enabled service principal is accepted as the reviewer of an execution approval", async () => {
    const { input, ctx } = await setup();
    const principalId = uuidV7IdGenerator.next("svc");
    ctx.entities.insert("Principal", {
      id: principalId,
      workspaceId: ctx.workspaceId,
      kind: "service",
      displayName: "Automation",
      disabledAt: null,
    });
    const approval = new ApprovalsService({ ...ctx, principalId }).create(input);
    expect(approval).toMatchObject({ reviewerId: principalId, actorId: principalId });
    expect(approval.revokedAt).toBeNull();
  });
  it("defaults an execution approval to a 30-minute window", async () => {
    const { approvals, input } = await setup();
    // A frozen clock: with a real one, a millisecond between reading it and creating the approval
    // makes the window look one millisecond too long.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const before = Date.now();
      const approval = approvals.create(input);
      expect(Date.parse(approval.expiresAt) - before).toBe(30 * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });
  it("requires a non-empty reason and stores it on the approval", async () => {
    const { approvals, run, test, env, input, ctx } = await setup();
    code(() => approvals.create({ ...input, reason: "" }), "INVALID_ARGUMENT");
    code(() => approvals.create({ ...input, reason: "   " }), "INVALID_ARGUMENT");
    code(() => approvals.create({ ...input, reason: "r".repeat(201) }), "INVALID_ARGUMENT");
    const { reason: _omitted, ...withoutReason } = input;
    code(() => approvals.create(withoutReason as typeof input), "INVALID_ARGUMENT");
    expect(approvals.list()).toHaveLength(0);
    const approval = approvals.create({ ...input, reason: "r".repeat(200) });
    expect(approvals.get(approval.id).reason).toBe("r".repeat(200));
    // Rows stored before the reason field existed stay readable and usable.
    const { reason: _legacy, ...legacy } = approval;
    ctx.entities.update(
      "Approval",
      ctx.workspaceId,
      approval.id,
      approval.version as number,
      legacy,
    );
    expect(approvals.get(approval.id).reason).toBeUndefined();
    expect(approvals.verify(run, test, env)?.id).toBe(approval.id);
  });
  it("permits read-only production without approval and denies cross-project bindings", async () => {
    const { approvals, run, test, env, ctx } = await setup(scaffoldPlan("backend"));
    expect(approvals.verify(run, test, env)).toBeNull();
    const other = new ProjectsService(ctx).create({ name: "Other" });
    const otherTest = new TestsService(ctx).create({
      projectId: other.id,
      plan: scaffoldPlan("backend"),
    });
    code(
      () =>
        approvals.verify(
          { ...run, testId: otherTest.id, revisionId: otherTest.activeRevisionId as string },
          otherTest,
          env,
        ),
      "INVALID_ARGUMENT",
    );
    const denied = new ApprovalsService({
      ...ctx,
      authorize() {
        throw new ContractError("FORBIDDEN", "Denied");
      },
    });
    code(() => denied.list(), "FORBIDDEN");
    code(() => denied.verify(run, test, env), "FORBIDDEN");
  });
  it("SEC-042 a Run through a tunnel needs a bound approval naming that tunnel even outside production", async () => {
    const { approvals, test, revision, ctx } = await setup(scaffoldPlan("backend"));
    const staging = new EnvironmentsService(ctx).create({
      projectId: test.projectId,
      name: "laptop",
      baseUrl: "http://127.0.0.1:8080",
      production: false,
    });
    const env = ctx.entities.get(
      "EnvironmentRevision",
      ctx.workspaceId,
      staging.activeRevisionId,
    ) as EnvironmentRevision;
    const tunnelId = uuidV7IdGenerator.next("tun");
    const direct = {
      testId: test.id,
      revisionId: revision.id,
      environmentRevisionId: env.id,
      gatePolicy: { policyHash: "a".repeat(64) },
    };
    // Control: the same Run without the tunnel needs no approval outside production.
    expect(approvals.verify(direct, test, env)).toBeNull();

    const tunnelled = { ...direct, matrixCell: { tunnelId } };
    const binding = {
      revisionHash: revision.contentHash,
      environmentRevisionId: env.id,
      originSet: ["http://127.0.0.1:8080"],
      policyHash: "a".repeat(64),
      reason: "Reach the laptop's API through the tunnel",
    };
    code(() => approvals.verify(tunnelled, test, env), "POLICY_DENIED");
    approvals.create({ ...binding, actionSet: ["read"] });
    approvals.create({ ...binding, actionSet: [`tunnel:${uuidV7IdGenerator.next("tun")}`] });
    code(() => approvals.verify(tunnelled, test, env), "POLICY_DENIED");

    const named = approvals.create({ ...binding, actionSet: [`tunnel:${tunnelId}`] });
    expect(approvals.verify(tunnelled, test, env)?.id).toBe(named.id);
    // The approval is consumed: the next Run through the tunnel needs a new one.
    code(() => approvals.verify(tunnelled, test, env), "POLICY_DENIED");
  });
  it("rejects approval expiry and disabled reviewers at admission", async () => {
    const { approvals, run, test, env, input, ctx } = await setup();
    const expired = approvals.create(input);
    ctx.entities.update("Approval", ctx.workspaceId, expired.id, expired.version as number, {
      ...expired,
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    code(() => approvals.verify(run, test, env), "POLICY_DENIED");
    approvals.create(input);
    const reviewer = ctx.entities.get("Principal", ctx.workspaceId, ctx.principalId);
    if (!reviewer) throw new Error("Missing reviewer");
    ctx.entities.update("Principal", ctx.workspaceId, reviewer.id, reviewer.version as number, {
      ...reviewer,
      disabledAt: new Date().toISOString(),
    });
    code(() => approvals.verify(run, test, env), "POLICY_DENIED");
  });
  it("re-evaluates mutating click and HTTP method risks, ignoring read declarations", () => {
    const frontend = scaffoldPlan("frontend");
    expect(planRiskActions(frontend).find((action) => action.stepId === "submit-login")?.risk).toBe(
      "write",
    );
    const backend = scaffoldPlan("backend");
    const request = backend.steps[0];
    if (request?.operation !== "request") throw new Error("Expected request scaffold");
    request.input.method = "DELETE";
    request.risk = "read";
    expect(planRiskActions(backend)[0]?.risk).toBe("destructive");
  });
  it("explains every risk class by the declaration, operation, method or word that set it", () => {
    const frontend = scaffoldPlan("frontend");
    const locator = { by: "testId" as const, value: "target" };
    frontend.steps = [
      {
        id: "menu",
        kind: "action",
        operation: "hover",
        description: "Open menu",
        input: { locator },
      },
      {
        id: "open",
        kind: "action",
        operation: "click",
        description: "Open item",
        input: { locator },
      },
      {
        id: "trash",
        kind: "action",
        operation: "click",
        description: "Remove the row",
        input: { locator },
      },
      {
        id: "probe_login",
        kind: "action",
        operation: "hover",
        description: "Probe the login form",
        input: { locator },
      },
      {
        id: "declared",
        kind: "action",
        operation: "hover",
        description: "Open menu",
        risk: "destructive",
        input: { locator },
      },
    ];
    expect(planRiskActions(frontend)).toEqual([
      { stepId: "menu", risk: "read", basis: 'read-only operation "hover"' },
      { stepId: "open", risk: "write", basis: 'operation "click"' },
      { stepId: "trash", risk: "destructive", basis: 'text mentions "remove"' },
      { stepId: "probe_login", risk: "securityProbe", basis: 'text mentions "probe"' },
      { stepId: "declared", risk: "destructive", basis: 'declared risk "destructive"' },
    ]);
    const backend = scaffoldPlan("backend");
    const request = backend.steps[0];
    if (request?.operation !== "request") throw new Error("Expected request scaffold");
    request.input.method = "DELETE";
    request.risk = "read";
    expect(planRiskActions(backend)[0]).toMatchObject({
      risk: "destructive",
      basis: "HTTP method DELETE",
    });
  });
  it("lists a cleanup lookup as a read next to the destructive delete it guards", () => {
    const backend = scaffoldPlan("backend");
    backend.cleanup = [
      {
        resourceRef: "submit-project",
        operation: "request",
        find: {
          resourceType: "project",
          lookup: { method: "GET", pathSegments: [{ literal: "projects" }] },
          itemsPointer: "/items",
          keyPointer: "/name",
          equals: { literal: "Run 42" },
          handlePointer: "/id",
          ownerProofPointer: "/owner",
        },
        input: {
          method: "DELETE",
          pathSegments: [{ literal: "projects" }, { variableRef: "submit-project.handle" }],
        },
        successPredicate: { predicate: "statusIn", values: [204] },
        deadlineMs: 1000,
        required: true,
      },
    ];
    expect(planRiskActions(backend).slice(-2)).toEqual([
      {
        stepId: "cleanup:submit-project",
        risk: "destructive",
        basis: "cleanup HTTP method DELETE",
      },
      {
        stepId: "cleanup-find:submit-project",
        risk: "read",
        basis: "cleanup lookup HTTP method GET",
      },
    ]);
  });
});
