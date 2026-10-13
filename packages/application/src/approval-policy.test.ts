import {
  ContractError,
  type EnvironmentRevision,
  type ExecutablePlan,
} from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { EntityRepository, PersistenceDatabase } from "@testmaster/persistence";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalsService } from "./approvals.js";
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

function riskyPlan(): ExecutablePlan {
  const plan = scaffoldPlan("backend");
  const request = plan.steps[0];
  if (request?.operation !== "request") throw new Error("Expected request scaffold");
  request.risk = "read";
  request.description = "Delete the owned test account";
  request.input.pathSegments = [{ literal: "delete" }, { literal: "account" }];
  return plan;
}
function failure(action: () => unknown): ContractError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractError);
    return error as ContractError;
  }
  throw new Error("Expected a ContractError");
}

async function setup() {
  const database = PersistenceDatabase.memory();
  databases.push(database);
  await database.migrate();
  const entities = new EntityRepository(database);
  const workspaceId = uuidV7IdGenerator.next("ws");
  entities.insert("Workspace", {
    id: workspaceId,
    workspaceId,
    name: "Team",
    mode: "single-user",
    settingsVersion: 1,
    quotaPolicyId: "local",
  });
  const human = (displayName: string): string => {
    const id = uuidV7IdGenerator.next("usr");
    entities.insert("Principal", {
      id,
      workspaceId,
      kind: "human",
      displayName,
      disabledAt: null,
    });
    return id;
  };
  const requesterId = human("Requester");
  const firstId = human("First reviewer");
  const secondId = human("Second reviewer");
  const contextFor = (principalId: string): ServiceContext => ({
    database,
    entities,
    workspaceId,
    principalId,
    authorize() {},
    authorizeNamed() {},
  });
  const as = (principalId: string) => new ApprovalsService(contextFor(principalId));
  const ctx = contextFor(requesterId);
  const project = new ProjectsService(ctx).create({ name: "Shop" });
  const environment = new EnvironmentsService(ctx).create({
    projectId: project.id,
    name: "production",
    baseUrl: "https://example.com",
    production: true,
  });
  const test = new TestsService(ctx).create({ projectId: project.id, plan: riskyPlan() });
  const revision = new RevisionsService(ctx).get(test.activeRevisionId as string);
  const env = entities.get(
    "EnvironmentRevision",
    workspaceId,
    environment.activeRevisionId,
  ) as EnvironmentRevision;
  const run = {
    id: uuidV7IdGenerator.next("run"),
    actorId: requesterId,
    testId: test.id,
    revisionId: revision.id,
    environmentRevisionId: env.id,
    gatePolicy: { policyHash: "a".repeat(64) },
  };
  const input = {
    actorId: requesterId,
    actionSet: ["destructive"],
    revisionHash: revision.contentHash,
    environmentRevisionId: env.id,
    originSet: ["https://example.com"],
    policyHash: "a".repeat(64),
    reason: "Approved by the production change review",
  };
  const setPolicy = (value: { requiredApprovers: 1 | 2; separationOfDuties: boolean }) => {
    const stored = entities.get("Project", workspaceId, project.id);
    return as(requesterId).setPolicy(project.id, value, Number(stored?.version));
  };
  const executor = as(requesterId);
  return {
    ctx,
    database,
    entities,
    project,
    test,
    env,
    run,
    input,
    requesterId,
    firstId,
    secondId,
    as,
    executor,
    setPolicy,
    human,
    contextFor,
  };
}
const dual = { requiredApprovers: 2, separationOfDuties: true } as const;

interface Storage {
  database: PersistenceDatabase;
  entities: EntityRepository;
  ctx: { workspaceId: string };
}
/** Stores another approval row, with its execution binding, the way a legacy writer could have. */
function cloneApproval(
  world: Storage,
  source: { id: string },
  overrides: Record<string, unknown> = {},
) {
  const stored = world.entities.get("Approval", world.ctx.workspaceId, source.id);
  const clone = { ...stored, ...overrides, id: uuidV7IdGenerator.next("apr"), version: 1 };
  world.entities.insert("Approval", clone as never);
  const key = (id: string) => `approval:binding:${world.ctx.workspaceId}:${id}`;
  const binding = world.database.get(
    "SELECT value FROM operational_state WHERE key=?",
    key(source.id),
  );
  world.database.run(
    "INSERT INTO operational_state(key,value) VALUES(?,?)",
    key(clone.id),
    String(binding?.value),
  );
  return clone as { id: string };
}

describe("approval policy and separation of duties", () => {
  it("SEC-039 two independent approvers: one approval, a repeat and the requester never admit the action", async () => {
    const world = await setup();
    world.setPolicy(dual);
    const first = world.as(world.firstId).create(world.input);
    // One independent approval is not enough and nothing is consumed by the refusal.
    const short = failure(() => world.executor.verify(world.run, world.test, world.env));
    expect(short.code).toBe("POLICY_DENIED");
    expect(short.details).toMatchObject({
      reasonCode: "approval_required",
      requiredApprovers: 2,
      separationOfDuties: true,
    });
    expect(world.executor.get(first.id).revokedAt).toBeNull();
    // The same person cannot count twice.
    const repeat = failure(() => world.as(world.firstId).create(world.input));
    expect(repeat.code).toBe("FORBIDDEN");
    expect(repeat.details).toMatchObject({ reason: "duplicate_approver" });
    // The requester cannot approve their own request.
    const self = failure(() => world.as(world.requesterId).create(world.input));
    expect(self.code).toBe("FORBIDDEN");
    expect(self.details).toMatchObject({ reason: "separation_of_duties" });
    expect(world.executor.list()).toHaveLength(1);
    // Two distinct humans, both different from the requester, admit the action once.
    const second = world.as(world.secondId).create(world.input);
    const admitted = world.executor.verify(world.run, world.test, world.env);
    expect([first.id, second.id]).toContain(admitted?.id);
    expect(world.executor.get(first.id).revokedAt).not.toBeNull();
    expect(world.executor.get(second.id).revokedAt).not.toBeNull();
    // Both approvals were consumed: the same pair cannot authorise a second Run.
    const reused = failure(() => world.executor.verify(world.run, world.test, world.env));
    expect(reused.code).toBe("POLICY_DENIED");
    const consumed = world.database.all(
      "SELECT resource_id FROM audit_events WHERE action='approval.consumed' ORDER BY resource_id",
    );
    expect(consumed.map((row) => row.resource_id)).toEqual([first.id, second.id].sort());
  });

  it("SEC-039 separation of duties alone keeps one independent approver sufficient", async () => {
    const world = await setup();
    world.setPolicy({ requiredApprovers: 1, separationOfDuties: true });
    failure(() => world.as(world.requesterId).create(world.input));
    // A legacy self approval stored before the policy tightened no longer satisfies it.
    const legacy = {
      ...world.input,
      id: uuidV7IdGenerator.next("apr"),
      workspaceId: world.ctx.workspaceId,
      reviewerId: world.requesterId,
      version: 1,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      revokedAt: null,
    };
    world.entities.insert("Approval", legacy);
    expect(
      failure(() => world.executor.verify(world.run, world.test, world.env)).details,
    ).toMatchObject({ requiredApprovers: 1, separationOfDuties: true });
    world.as(world.firstId).create(world.input);
    // The self approval is skipped, never consumed; the independent one admits the action.
    expect(world.executor.verify(world.run, world.test, world.env)).not.toBeNull();
    expect(world.executor.get(legacy.id).revokedAt).toBeNull();
  });

  it("SEC-039 duplicate rows and a disabled second reviewer never satisfy two approvers", async () => {
    const world = await setup();
    const open = world.as(world.firstId).create(world.input);
    // Default policy: a single approval keeps working exactly as before the policy existed.
    expect(world.executor.verify(world.run, world.test, world.env)?.id).toBe(open.id);
    world.setPolicy(dual);
    const first = world.as(world.firstId).create(world.input);
    // A second row by the same reviewer, written around the service, still counts once.
    cloneApproval(world, first);
    expect(
      failure(() => world.executor.verify(world.run, world.test, world.env)).details,
    ).toMatchObject({ requiredApprovers: 2, separationOfDuties: true });
    // The second reviewer is disabled before admission: refused, and neither approval is consumed.
    const second = world.as(world.secondId).create(world.input);
    const reviewer = world.entities.get("Principal", world.ctx.workspaceId, world.secondId);
    world.entities.update(
      "Principal",
      world.ctx.workspaceId,
      world.secondId,
      Number(reviewer?.version),
      { ...reviewer, disabledAt: new Date().toISOString() },
    );
    expect(failure(() => world.executor.verify(world.run, world.test, world.env)).code).toBe(
      "POLICY_DENIED",
    );
    expect(world.executor.get(first.id).revokedAt).toBeNull();
    expect(world.executor.get(second.id).revokedAt).toBeNull();
  });

  it("SEC-039 cleanup compensation needs the same independent approvals", async () => {
    const world = await setup();
    world.setPolicy(dual);
    const digest = "d".repeat(64);
    const cleanup = {
      resourceId: "res_1",
      digest,
      origins: ["https://example.com"],
      policyHash: "a".repeat(64),
    };
    const asCleanup = { actionSet: ["cleanup:res_1"], revisionHash: digest };
    const first = cloneApproval(world, world.as(world.firstId).create(world.input), asCleanup);
    // One independent approval does not authorise the compensation and is not consumed.
    const short = failure(() =>
      world.executor.verify(world.run, world.test, world.env, { ...cleanup, approvalId: first.id }),
    );
    expect(short.code).toBe("POLICY_DENIED");
    expect(short.details).toMatchObject({ reasonCode: "approval_required" });
    expect(world.executor.get(first.id).revokedAt).toBeNull();
    // The requester's own cleanup approval never counts as the second approver.
    const own = cloneApproval(world, first, {
      ...asCleanup,
      reviewerId: world.requesterId,
    });
    expect(
      failure(() =>
        world.executor.verify(world.run, world.test, world.env, {
          ...cleanup,
          approvalId: first.id,
        }),
      ).code,
    ).toBe("POLICY_DENIED");
    expect(world.executor.get(own.id).revokedAt).toBeNull();
    // A second distinct human completes the pair and both approvals are consumed.
    const second = cloneApproval(world, world.as(world.secondId).create(world.input), asCleanup);
    const approved = world.executor.verify(world.run, world.test, world.env, {
      ...cleanup,
      approvalId: first.id,
    });
    expect(approved?.id).toBe(first.id);
    expect(world.executor.get(first.id).revokedAt).not.toBeNull();
    expect(world.executor.get(second.id).revokedAt).not.toBeNull();
    expect(world.executor.get(own.id).revokedAt).toBeNull();
  });

  it("SEC-039 policy is validated, versioned, audited and defaults to a single approver", async () => {
    const world = await setup();
    expect(world.executor.policy(world.project.id)).toMatchObject({
      projectId: world.project.id,
      requiredApprovers: 1,
      separationOfDuties: false,
    });
    expect(
      failure(() => world.setPolicy({ requiredApprovers: 2, separationOfDuties: false })).code,
    ).toBe("INVALID_ARGUMENT");
    expect(failure(() => world.executor.setPolicy(world.project.id, dual, 999)).code).toBe(
      "REVISION_CONFLICT",
    );
    const set = world.setPolicy(dual);
    expect(set).toMatchObject({ requiredApprovers: 2, separationOfDuties: true });
    expect(world.executor.policy(world.project.id)).toMatchObject({ requiredApprovers: 2 });
    const events = world.database.all(
      "SELECT actor, resource_id FROM audit_events WHERE action='approval.policy.set'",
    );
    expect(events).toEqual([{ actor: world.requesterId, resource_id: world.project.id }]);
    const denied = new ApprovalsService({
      ...world.ctx,
      authorize() {
        throw new ContractError("FORBIDDEN", "Denied");
      },
    });
    expect(failure(() => denied.setPolicy(world.project.id, dual, 1)).code).toBe("FORBIDDEN");
  });
});
