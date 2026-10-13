import { createIncident, seedDeadLetter, seedFiringAlerts } from "../operations-support.js";
import type { SweepSeed } from "./types.js";

/**
 * Seeds for the operations pages: one open incident for `/operations/incidents/:incidentId`, a
 * firing alert for the alerts page and a dead-lettered job for the DLQ page.
 */
const seed: SweepSeed = {
  params: {
    async incidentId(context) {
      const cached = context.recall("incidentId");
      if (cached) return cached;
      const id = await createIncident(context.client, { title: "Sweep incident" });
      context.remember("incidentId", id);
      return id;
    },
  },
  routes: {
    "/operations/alerts": (context) => seedFiringAlerts(context.stack),
    "/operations/dlq": async (context) => {
      await seedDeadLetter(context.stack);
    },
  },
};

export default seed;
