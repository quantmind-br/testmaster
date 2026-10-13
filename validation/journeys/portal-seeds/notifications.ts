import { seedNotifications, seedReadyWorker } from "../notifications-fixtures.js";
import type { SweepContext, SweepSeed } from "./types.js";

/**
 * Seeds for the S8 pages: the workers pool, the notification integrations with their delivery
 * history, and one delivery's detail page. One webhook integration carries a dead letter, a dead
 * letter whose outcome is uncertain, a pending delivery and a delivered one, so the sweep sees
 * every state badge and the Requeue control. Nothing here reaches the network: the destination is
 * an unresolvable `.invalid` host.
 */
async function ensureNotifications(context: SweepContext): Promise<string> {
  const cached = context.recall("notificationsDeadLetterId");
  if (cached) return cached;
  const seeded = await seedNotifications(context.stack, { integrationName: "Sweep webhook" });
  context.remember("notificationsDeadLetterId", seeded.deadLetter.id);
  return seeded.deadLetter.id;
}

const seed: SweepSeed = {
  params: {
    deliveryId: ensureNotifications,
  },
  routes: {
    async "/settings/workers"(context) {
      await seedReadyWorker(context.stack, "sweep-worker-1", { pool: "sweep" });
    },
    async "/settings/notifications"(context) {
      await ensureNotifications(context);
    },
  },
};

export default seed;
