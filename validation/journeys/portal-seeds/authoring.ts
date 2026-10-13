import { type Application, entity, scaffoldPlan } from "@testmaster/application";
import core from "./core.js";
import type { SweepContext, SweepSeed } from "./types.js";

/**
 * Seeds for the authoring pages (S4b): a proposal batch with two pending proposals, one test with
 * a published revision, and the J16 `review` step. The sweep stack has no model provider, so the
 * seed writes the entities a generation would have produced straight into the workspace.
 */
async function project(context: SweepContext): Promise<string> {
  const resolve = core.params?.projectId;
  if (!resolve) throw new Error("The core seed no longer resolves projectId");
  return resolve(context);
}

/** One approved requirement, written the way normalization would store it. */
function seedRequirement(application: Application, projectId: string): string {
  const context = application.context;
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

async function seedBatch(context: SweepContext): Promise<string> {
  const cached = context.recall("authoring.batchId");
  if (cached) return cached;
  const projectId = await project(context);
  const application = (await context.stack.application()).forWorkspaceSystem(
    context.stack.workspaceId,
  );
  const requirementId = seedRequirement(application, projectId);
  const batch = entity(application.context, "pbt", {
    projectId,
    sourceSnapshotId: application.requirements.snapshot(projectId).fingerprint,
    state: "proposed",
    extensions: {},
  });
  application.context.entities.insert("ProposalBatch", batch);
  for (const name of ["Health reports ok", "Health reports a version"]) {
    const plan = scaffoldPlan("backend");
    plan.name = name;
    plan.requirementRefs = [requirementId];
    application.context.entities.insert(
      "Proposal",
      entity(application.context, "pro", {
        batchId: batch.id,
        plan,
        requirementRefs: [requirementId],
        evidenceRefs: [],
        warnings: [],
        state: "proposed",
        validation: "valid",
        extensions: { "testmaster:authorship": { kind: "llm", modelCallId: "sweep" } },
      }),
    );
  }
  context.remember("authoring.batchId", batch.id);
  return batch.id;
}

async function seedTest(context: SweepContext): Promise<string> {
  const cached = context.recall("authoring.testId");
  if (cached) return cached;
  const projectId = await project(context);
  const application = (await context.stack.application()).forWorkspaceSystem(
    context.stack.workspaceId,
  );
  const plan = scaffoldPlan("backend");
  plan.name = "Health reports ok";
  const test = application.tests.create({ projectId, plan });
  context.remember("authoring.testId", test.id);
  return test.id;
}

const seed: SweepSeed = {
  params: {
    proposalBatchId: seedBatch,
    testId: seedTest,
  },
  journeySteps: {
    async review(context) {
      return `/proposal-batches/${await seedBatch(context)}`;
    },
  },
};

export default seed;
