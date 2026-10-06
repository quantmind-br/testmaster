import { ContractError } from "@testmaster/contracts";
import { semanticHash, uuidV7IdGenerator } from "@testmaster/domain";
import { EntityRepository, PersistenceDatabase } from "@testmaster/persistence";
import { afterEach, describe, expect, it } from "vitest";
import {
  dryRunPlan,
  EnvironmentsService,
  lintPlan,
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
async function context(): Promise<ServiceContext> {
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
  return { database, entities, workspaceId, principalId, authorize() {}, authorizeNamed() {} };
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

describe("authoring services", () => {
  it("creates manual active revisions and promotes candidates using test CAS", async () => {
    const ctx = await context();
    const projects = new ProjectsService(ctx);
    const project = projects.create({ name: "Shop" });
    const tests = new TestsService(ctx);
    const test = tests.create({ plan: scaffoldPlan("backend") });
    expect(test.projectId).toBe(project.id);
    expect(test.activeRevisionId).not.toBeNull();
    const revisions = new RevisionsService(ctx);
    const initial = revisions.get(test.activeRevisionId as string);
    expect(initial.origin).toBe("manual");
    expect(initial.contentHash).toBe(semanticHash(initial.plan, "plan"));
    const plan = scaffoldPlan("backend");
    plan.name = "Updated health check";
    const candidate = revisions.create(test.id, plan, initial.id);
    plan.steps.splice(0);
    expect(revisions.get(candidate.id).plan?.steps).toHaveLength(3);
    expect(tests.get(test.id).activeRevisionId).toBe(initial.id);
    expect(revisions.list(test.id).map((revision) => revision.ordinal)).toEqual([1, 2]);
    const promoted = revisions.promote(candidate.id, test.version as number);
    expect(promoted.activeRevisionId).toBe(candidate.id);
    code(() => revisions.promote(initial.id, test.version as number), "REVISION_CONFLICT");
    expect(revisions.get(initial.id)).toEqual(initial);
    code(
      () => ctx.entities.update("TestRevision", ctx.workspaceId, initial.id, 1, initial),
      "POLICY_DENIED",
    );
  });
  it("creates immutable environment snapshots and rolls back stale updates", async () => {
    const ctx = await context();
    const projects = new ProjectsService(ctx);
    const project = projects.create({ name: "Shop" });
    const environments = new EnvironmentsService(ctx);
    const env = environments.create({
      projectId: project.id,
      name: "local",
      baseUrl: "http://127.0.0.1:3000",
    });
    const initial = ctx.entities.get("EnvironmentRevision", ctx.workspaceId, env.activeRevisionId);
    const next = environments.update(
      env.id,
      { baseUrl: "https://example.com", production: true },
      env.version as number,
    );
    expect(next.activeRevisionId).not.toBe(env.activeRevisionId);
    expect(ctx.entities.get("EnvironmentRevision", ctx.workspaceId, env.activeRevisionId)).toEqual(
      initial,
    );
    expect(
      ctx.entities.get("EnvironmentRevision", ctx.workspaceId, next.activeRevisionId)?.production,
    ).toBe(true);
    const count = ctx.database.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM environment_revisions",
    )?.count;
    code(
      () => environments.update(env.id, { locale: "pt-BR" }, env.version as number),
      "REVISION_CONFLICT",
    );
    expect(
      ctx.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM environment_revisions")
        ?.count,
    ).toBe(count);
    const updatedProject = environments.setDefault(project.id, env.id, project.version as number);
    expect(updatedProject.defaultEnvironmentId).toBe(env.id);
    code(() => environments.archive(env.id, next.version as number), "PRECONDITION_FAILED");
    code(
      () =>
        environments.create({
          projectId: project.id,
          name: "local",
          baseUrl: "https://example.com",
        }),
      "INVALID_ARGUMENT",
    );
  });
  it("rejects cross-project defaults and cross-test revision parents", async () => {
    const ctx = await context();
    const projects = new ProjectsService(ctx);
    const first = projects.create({ name: "First" });
    const second = projects.create({ name: "Second" });
    const env = new EnvironmentsService(ctx).create({
      projectId: second.id,
      name: "remote",
      baseUrl: "https://example.com",
    });
    code(
      () => projects.update(first.id, { defaultEnvironmentId: env.id }, first.version as number),
      "INVALID_ARGUMENT",
    );
    const tests = new TestsService(ctx);
    code(() => tests.create({ plan: scaffoldPlan("backend") }), "INVALID_ARGUMENT");
    const a = tests.create({ projectId: first.id, plan: scaffoldPlan("backend") });
    const b = tests.create({ projectId: second.id, plan: scaffoldPlan("backend") });
    code(
      () =>
        new RevisionsService(ctx).create(
          a.id,
          scaffoldPlan("backend"),
          b.activeRevisionId as string,
        ),
      "INVALID_ARGUMENT",
    );
  });
  it("preserves history on archive and denies new authored work", async () => {
    const ctx = await context();
    const projects = new ProjectsService(ctx);
    const project = projects.create({ name: "Shop" });
    const tests = new TestsService(ctx);
    const test = tests.create({ projectId: project.id, plan: scaffoldPlan("backend") });
    tests.archive(test.id, test.version as number);
    expect(new RevisionsService(ctx).list(test.id)).toHaveLength(1);
    code(
      () => new RevisionsService(ctx).create(test.id, scaffoldPlan("backend")),
      "PRECONDITION_FAILED",
    );
    projects.archive(project.id, project.version as number);
    code(
      () => tests.create({ projectId: project.id, plan: scaffoldPlan("backend") }),
      "PRECONDITION_FAILED",
    );
    code(() => projects.purge(project.id, project.id), "CAPABILITY_UNAVAILABLE");
  });
  it("returns not-found and authorizes public entry points", async () => {
    const ctx = await context();
    code(() => new TestsService(ctx).get(uuidV7IdGenerator.next("tst")), "NOT_FOUND");
    const denied = {
      ...ctx,
      authorize() {
        throw new ContractError("FORBIDDEN", "Denied");
      },
    };
    code(() => new ProjectsService(denied).list(), "FORBIDDEN");
    code(() => new EnvironmentsService(denied).list(), "FORBIDDEN");
    code(() => new TestsService(denied).create({ plan: scaffoldPlan("backend") }), "FORBIDDEN");
    code(() => new RevisionsService(denied).get(uuidV7IdGenerator.next("rev")), "FORBIDDEN");
  });
  it("confines reads to the workspace and filters project grants", async () => {
    const ctx = await context();
    const projects = new ProjectsService(ctx);
    const allowed = projects.create({ name: "Allowed" });
    const hidden = projects.create({ name: "Hidden" });
    const tests = new TestsService(ctx);
    tests.create({ projectId: allowed.id, plan: scaffoldPlan("backend") });
    const hiddenTest = tests.create({ projectId: hidden.id, plan: scaffoldPlan("backend") });
    const restricted = {
      ...ctx,
      authorize(_scope: string, projectId?: string) {
        if (projectId === hidden.id) throw new ContractError("FORBIDDEN", "Denied");
      },
    };
    expect(new TestsService(restricted).list()).toHaveLength(1);
    code(() => new TestsService(restricted).get(hiddenTest.id), "FORBIDDEN");
    const other = { ...ctx, workspaceId: uuidV7IdGenerator.next("ws") };
    code(() => new ProjectsService(other).get(allowed.id), "NOT_FOUND");
  });
});

describe("local plan tools", () => {
  it("validates both complete declarative examples and describes dry-run without a verdict", () => {
    for (const type of ["frontend", "backend"] as const) {
      const plan = scaffoldPlan(type);
      const result = dryRunPlan(JSON.stringify(plan));
      expect(result.dryRun).toBe(true);
      expect(result.validated).toBe(true);
      expect(result.operations).toEqual([]);
      expect(result.unresolvedPreconditions).toEqual([]);
      expect(result).not.toHaveProperty("outcome");
      expect(result.plan).toEqual(plan);
    }
  });
  it("shares strict parsing and semantics including byte bounds and missing assertions", () => {
    const plan = scaffoldPlan("backend");
    code(() => lintPlan(JSON.stringify({ ...plan, unknown: true })), "INVALID_ARGUMENT");
    code(() => lintPlan(JSON.stringify({ ...plan, steps: [plan.steps[0]] })), "INVALID_ARGUMENT");
    code(
      () =>
        lintPlan(JSON.stringify({ ...plan, steps: [plan.steps[0], plan.steps[0], plan.steps[1]] })),
      "INVALID_ARGUMENT",
    );
    code(() => lintPlan(new Uint8Array([0xff])), "INVALID_ARGUMENT");
    code(() => dryRunPlan(" ".repeat(1_048_577)), "PAYLOAD_TOO_LARGE");
    const implicit = {
      ...plan,
      tags: undefined,
      priority: undefined,
      cleanup: undefined,
      dependsOn: undefined,
      steps: plan.steps.map(({ required: _required, timeoutMs: _timeoutMs, ...step }) => step),
    };
    expect(semanticHash(lintPlan(JSON.stringify(implicit)), "plan")).toBe(
      semanticHash(plan, "plan"),
    );
  });
});
