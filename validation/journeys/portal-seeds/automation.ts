import { type AutomationWorld, seedAutomationWorld } from "../automation-world.js";
import type { SweepContext, SweepSeed } from "./types.js";

/**
 * Seeds for the list and schedule pages: two projects with a `staging` environment each, a
 * dynamic list over both and a cron schedule over that list, all created through `/v1`.
 * `suiteId` and `scheduleId` are the route parameters these pages share.
 */
const worlds = new WeakMap<object, Promise<AutomationWorld>>();

function world(context: SweepContext): Promise<AutomationWorld> {
  let existing = worlds.get(context.stack);
  if (!existing) {
    existing = seedAutomationWorld(context.client);
    worlds.set(context.stack, existing);
  }
  return existing;
}

async function create(context: SweepContext, path: string, body: unknown): Promise<string> {
  const created = await context.client.mutate("POST", path, body);
  if (created.status !== 201)
    throw new Error(`${path} seed failed: ${created.status} ${created.text}`);
  return created.json<{ data: { id: string } }>().data.id;
}

async function suiteId(context: SweepContext): Promise<string> {
  const cached = context.recall("suiteId");
  if (cached) return cached;
  const seeded = await world(context);
  const id = await create(context, "/v1/suites", {
    name: "Sweep list",
    selection: {
      kind: "dynamic",
      projects: [
        { projectId: seeded.a.projectId, environmentId: seeded.a.environmentId },
        { projectId: seeded.b.projectId, environmentId: seeded.b.environmentId },
      ],
    },
  });
  context.remember("suiteId", id);
  return id;
}

const seed: SweepSeed = {
  params: {
    suiteId,
    async scheduleId(context) {
      const cached = context.recall("scheduleId");
      if (cached) return cached;
      const id = await create(context, "/v1/schedules", {
        name: "Sweep schedule",
        selection: { kind: "suite", suiteId: await suiteId(context) },
        trigger: { kind: "cron", cron: "30 2 * * 1-5", timezone: "America/New_York" },
      });
      context.remember("scheduleId", id);
      return id;
    },
  },
  routes: {
    // The lists page and the schedule form both need a list to exist before they are visited.
    async "/lists"(context) {
      await suiteId(context);
    },
    async "/schedules/new"(context) {
      await suiteId(context);
    },
  },
};

export default seed;
