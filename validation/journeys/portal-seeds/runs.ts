import {
  artifactPaths,
  createRunsScope,
  createTest,
  type RunsScope,
  seedArtifactRun,
  seedRetryRun,
} from "../runs-fixtures.js";
import type { SweepContext, SweepSeed } from "./types.js";

/** Its own project and environment, so these Runs never depend on another seed's data. */
async function runsScope(context: SweepContext): Promise<RunsScope> {
  const system = (await context.stack.scope()).forWorkspaceSystem(context.stack.workspaceId);
  const projectId = context.recall("runsProjectId");
  const environmentId = context.recall("runsEnvironmentId");
  if (projectId && environmentId)
    return { system, workspaceId: context.stack.workspaceId, projectId, environmentId };
  const created = await createRunsScope(system, context.stack.workspaceId, "Runs sweep");
  context.remember("runsProjectId", created.projectId);
  context.remember("runsEnvironmentId", created.environmentId);
  return created;
}

/**
 * Run detail pages (UX-026..UX-034): a passed Run with every artifact family, and a Run whose
 * retry passed behind a failed first Attempt.
 */
const seed: SweepSeed = {
  params: {
    async runId(context) {
      const known = context.recall("runId");
      if (known) return known;
      const scope = await runsScope(context);
      const seeded = await seedArtifactRun(scope, String(createTest(scope).id));
      context.remember("runId", seeded.runId);
      return seeded.runId;
    },
  },
  journeySteps: {
    async runDetail(context) {
      const scope = await runsScope(context);
      const seeded = await seedRetryRun(scope, String(createTest(scope).id));
      return `/runs/${seeded.runId}`;
    },
    /** The log is larger than the preview, so the page shows truncated text with its notice. */
    async textualArtifact(context) {
      const scope = await runsScope(context);
      const seeded = await seedArtifactRun(scope, String(createTest(scope).id));
      const log = seeded.artifacts.find((artifact) => artifact.relativePath === artifactPaths.log);
      if (!log) throw new Error("the seeded Run has no log artifact");
      return `/runs/${seeded.runId}?artifact=${encodeURIComponent(log.id)}`;
    },
  },
};

export default seed;
