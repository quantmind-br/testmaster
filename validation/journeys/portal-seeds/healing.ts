import { type FixtureScope, newScenario } from "../healing-fixtures.js";
import type { SweepContext, SweepSeed } from "./types.js";

/** A system-scoped Application plus its own project and environment for healing fixtures. */
async function healingScope(context: SweepContext): Promise<FixtureScope> {
  const system = (await context.stack.scope()).forWorkspaceSystem(context.stack.workspaceId);
  const known = context.recall("healingProjectId");
  const projectId = known ?? String(system.projects.create({ name: "Healing sweep project" }).id);
  const environmentId =
    context.recall("healingEnvironmentId") ??
    String(
      system.environments.create({
        projectId,
        name: "staging",
        baseUrl: "http://127.0.0.1:9",
      }).id,
    );
  context.remember("healingProjectId", projectId);
  context.remember("healingEnvironmentId", environmentId);
  return { system, workspaceId: context.stack.workspaceId, projectId, environmentId };
}

/**
 * Healing review pages (UX-039, UX-040): a proposed, never-approved candidate whose failed Run
 * is real, so the page shows the diff, the assertion check and the accept/reject decision.
 */
const seed: SweepSeed = {
  params: {
    async proposalId(context) {
      const known = context.recall("proposalId");
      if (known) return known;
      const { proposalId } = await newScenario(await healingScope(context));
      context.remember("proposalId", proposalId);
      return proposalId;
    },
  },
  journeySteps: {
    async healing(context) {
      const { proposalId } = await newScenario(await healingScope(context));
      return `/healing-proposals/${proposalId}`;
    },
  },
};

export default seed;
