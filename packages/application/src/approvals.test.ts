import {
  ContractError,
  type EnvironmentRevision,
  type ExecutablePlan,
} from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { EntityRepository, PersistenceDatabase } from "@testmaster/persistence";
import { afterEach, describe, expect, it } from "vitest";
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
    plan.name = "Changed request body";
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
  it("rejects expired approval and service reviewer/spoofed reviewer", async () => {
    const { approvals, input, ctx } = await setup();
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
    const principalId = uuidV7IdGenerator.next("svc");
    ctx.entities.insert("Principal", {
      id: principalId,
      workspaceId: ctx.workspaceId,
      kind: "service",
      displayName: "Automation",
      disabledAt: null,
    });
    code(() => new ApprovalsService({ ...ctx, principalId }).create(input), "FORBIDDEN");
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
});
