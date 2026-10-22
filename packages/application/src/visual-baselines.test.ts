import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError, type ExecutablePlan } from "@testmaster/contracts";
import { sha256, uuidV7IdGenerator, visualMaskHash } from "@testmaster/domain";
import { EntityRepository, PersistenceDatabase } from "@testmaster/persistence";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectsService, scaffoldPlan, TestsService } from "./authoring.js";
import type { ResolvedConfig } from "./config.js";
import { entity, type ServiceContext } from "./context.js";
import { readVisualBaselineBytes, VisualBaselinesService } from "./visual-baselines.js";
import { resolveVisualBaselines } from "./visual-cell.js";

const databases: PersistenceDatabase[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const digest = "d".repeat(64);
const otherDigest = "e".repeat(64);
const masks = [{ by: "testId", value: "clock" }] as const;

function failure(action: () => unknown): ContractError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractError);
    return error as ContractError;
  }
  throw new Error("Expected a ContractError");
}

/** A plan whose last step compares the page with the baseline named `home`, masking the clock. */
function visualPlan(): ExecutablePlan {
  const plan = scaffoldPlan("frontend");
  const step = plan.steps.at(-1);
  if (step?.kind !== "assertion") throw new Error("Expected an assertion scaffold");
  step.expectation = { predicate: "visualMatches", baseline: "home", masks: [...masks] };
  return plan;
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
  const contextFor = (principalId: string): ServiceContext =>
    ({
      database,
      entities,
      workspaceId,
      principalId,
      authorize() {},
      authorizeNamed() {},
    }) as unknown as ServiceContext;
  const creator = "usr_creator";
  const reviewer = "usr_reviewer";
  const ctx = contextFor(creator);
  const project = new ProjectsService(ctx).create({ name: "Shop" });
  const test = new TestsService(ctx).create({ projectId: project.id, plan: visualPlan() });
  const service = (principalId: string) =>
    new VisualBaselinesService(contextFor(principalId), {} as never, {} as never, {} as never);
  /** A baseline row as `create` leaves it, without a Run bundle to copy from. */
  const draft = (fields: Record<string, unknown> = {}) => {
    const baseline = entity(ctx, "vbl", {
      projectId: project.id,
      testId: test.id,
      name: "home",
      matrixDigest: digest,
      sourceRunId: uuidV7IdGenerator.next("run"),
      sourceStepId: "check-error",
      artifactId: uuidV7IdGenerator.next("art"),
      sha256: sha256(Buffer.from(uuidV7IdGenerator.next("art"))),
      width: 1280,
      height: 720,
      maskHash: visualMaskHash(masks),
      status: "draft",
      createdBy: creator,
      approvedBy: null,
      approvedAt: null,
      ...fields,
    });
    entities.insert("VisualBaseline", baseline);
    return baseline;
  };
  return { ctx, contextFor, project, test, service, draft, creator, reviewer, workspaceId };
}

describe("ADR-032 visual baselines", () => {
  it("the creator cannot approve their own draft and another principal can", async () => {
    const world = await setup();
    const baseline = world.draft();

    const refused = failure(() =>
      world.service(world.creator).approve(baseline.id, { expectedVersion: 1 }),
    );
    expect(refused.code).toBe("FORBIDDEN");
    expect(refused.details).toMatchObject({ reason: "self_approval" });
    expect(world.ctx.entities.get("VisualBaseline", world.workspaceId, baseline.id)).toMatchObject({
      status: "draft",
      approvedBy: null,
    });

    const approved = world.service(world.reviewer).approve(baseline.id, { expectedVersion: 1 });
    expect(approved).toMatchObject({
      status: "approved",
      approvedBy: world.reviewer,
      version: 2,
    });
    expect(approved.approvedAt).toEqual(expect.any(String));

    expect(
      failure(() => world.service(world.reviewer).approve(baseline.id, { expectedVersion: 2 }))
        .code,
    ).toBe("PRECONDITION_FAILED");
    const audited = world.ctx.database.all(
      "SELECT action FROM audit_events WHERE resource_id=?",
      baseline.id,
    );
    expect(audited.map((row) => String(row.action))).toEqual(["visual_baseline.approved"]);
  });

  it("approving a second draft of the same test, name and cell supersedes the first, which stays listed", async () => {
    const world = await setup();
    const first = world.draft();
    const second = world.draft();
    const otherCell = world.draft({ matrixDigest: otherDigest });
    const reviewer = world.service(world.reviewer);

    expect(
      failure(() => reviewer.approve(second.id, { expectedVersion: 7 })).code,
      "a stale version is a revision conflict",
    ).toBe("REVISION_CONFLICT");

    reviewer.approve(first.id, { expectedVersion: 1 });
    reviewer.approve(otherCell.id, { expectedVersion: 1 });
    reviewer.approve(second.id, { expectedVersion: 1 });

    const listed = reviewer.list({ projectId: world.project.id, testId: world.test.id });
    expect(Object.fromEntries(listed.map((item) => [item.id, item.status]))).toEqual({
      [first.id]: "superseded",
      [second.id]: "approved",
      [otherCell.id]: "approved",
    });
    expect(listed).toHaveLength(3);
    expect(
      reviewer.list({ projectId: world.project.id, testId: uuidV7IdGenerator.next("tst") }),
    ).toEqual([]);
  });

  it("a Run whose cell differs from the approved baseline's finds none, and other masks make it stale", async () => {
    const world = await setup();
    const baseline = world.draft();
    world.service(world.reviewer).approve(baseline.id, { expectedVersion: 1 });
    const plan = visualPlan();
    const stepId = String(plan.steps.at(-1)?.id);

    expect(resolveVisualBaselines(world.ctx, world.test.id, plan, digest)).toEqual({
      [stepId]: { state: "available", baselineId: baseline.id, sha256: baseline.sha256 },
    });
    expect(resolveVisualBaselines(world.ctx, world.test.id, plan, otherDigest)).toEqual({
      [stepId]: { state: "missing" },
    });
    expect(resolveVisualBaselines(world.ctx, world.test.id, plan, null)).toEqual({
      [stepId]: { state: "missing" },
    });

    const remasked = visualPlan();
    const step = remasked.steps.at(-1);
    if (step?.kind !== "assertion") throw new Error("Expected an assertion step");
    step.expectation = { predicate: "visualMatches", baseline: "home" };
    expect(resolveVisualBaselines(world.ctx, world.test.id, remasked, digest)).toEqual({
      [stepId]: { state: "stale", baselineId: baseline.id },
    });
  });

  it("a draft is not an effective baseline until it is approved", async () => {
    const world = await setup();
    world.draft();
    const plan = visualPlan();
    expect(Object.values(resolveVisualBaselines(world.ctx, world.test.id, plan, digest))).toEqual([
      { state: "missing" },
    ]);
  });

  it("stored bytes reach a runner only when they still hash to the approved sha256", async () => {
    const world = await setup();
    const dataDir = await mkdtemp(join(tmpdir(), "tm-visual-"));
    roots.push(dataDir);
    const config = { dataDir } as ResolvedConfig;
    const bytes = Buffer.from("not really a png, hashed all the same");
    const baseline = world.draft({ sha256: sha256(bytes) });
    const directory = join(dataDir, "visual-baselines", world.workspaceId, world.project.id);

    const missing = await readVisualBaselineBytes(world.ctx, config, baseline).catch(
      (error: unknown) => error as ContractError,
    );
    expect(missing).toMatchObject({
      code: "PRECONDITION_FAILED",
      details: { reason: "input_bytes_unavailable", baselineId: baseline.id },
    });

    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, sha256(bytes)), bytes);
    expect(await readVisualBaselineBytes(world.ctx, config, baseline)).toEqual(bytes);

    await writeFile(join(directory, sha256(bytes)), Buffer.from("tampered"));
    const tampered = await readVisualBaselineBytes(world.ctx, config, baseline).catch(
      (error: unknown) => error as ContractError,
    );
    expect(tampered).toMatchObject({
      code: "PRECONDITION_FAILED",
      details: { reason: "content_hash_mismatch", baselineId: baseline.id },
    });
  });
});
