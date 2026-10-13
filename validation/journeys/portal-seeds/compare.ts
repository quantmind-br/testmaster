import { type CompareFixture, seedCompareFixture } from "../compare-fixture.js";
import type { ServerStack } from "../server-stack.js";
import type { SweepContext, SweepSeed } from "./types.js";

/**
 * Seeds for the comparison, batch matrix and flake study pages (S5a): one project with two
 * environments, Runs of two revisions, finished and running batches and flake studies. The data
 * is created once per sweep stack, on first use, by whichever resolver is asked first.
 */
const fixtures = new WeakMap<ServerStack, Promise<CompareFixture>>();

function fixtureFor(context: SweepContext): Promise<CompareFixture> {
  const cached = fixtures.get(context.stack);
  if (cached) return cached;
  const created = context.stack.scope().then((scope) =>
    seedCompareFixture(scope.forWorkspaceSystem(context.stack.workspaceId), {
      projectName: "Sweep compare project",
      bulk: false,
    }),
  );
  fixtures.set(context.stack, created);
  return created;
}

const seed: SweepSeed = {
  params: {
    async batchId(context) {
      return (await fixtureFor(context)).incompleteBatch;
    },
    async studyId(context) {
      return (await fixtureFor(context)).finishedStudy;
    },
  },
  journeySteps: {
    async comparison(context) {
      const fixture = await fixtureFor(context);
      return `/compare?left=${fixture.passedRevisionOne}&right=${fixture.failedRevisionTwo}`;
    },
  },
};

export default seed;
