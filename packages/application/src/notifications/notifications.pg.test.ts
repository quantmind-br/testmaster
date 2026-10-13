import { createTestDatabase, type TestDatabase } from "@testmaster/persistence/testing";
import { afterEach, expect, it } from "vitest";
import {
  createNotificationHarness,
  type NotificationHarness,
} from "../testing/notification-harness.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function harness(): Promise<NotificationHarness> {
  const database: TestDatabase = await createTestDatabase();
  cleanups.push(() => database.drop());
  const created = await createNotificationHarness({ postgres: database.config });
  cleanups.push(() => created.close());
  return created;
}

it("INT-026 OPS-011 PostgreSQL: a second dispatcher never sends a delivery the first one holds and the retry keeps one delivery ID", async () => {
  const h = await harness();
  const receiver = await h.receiver();
  const inFlight = Promise.withResolvers<void>();
  receiver.behave((_request, count) => {
    if (count === 1) {
      inFlight.resolve();
      return { hang: true };
    }
    return { status: 200 };
  });
  await h.webhook(receiver);
  h.completedRun({ outcome: "failed" });
  const second = await h.dispatcher();

  // The first dispatcher is mid-request and holds the delivery's lease.
  const first = h.service.tick();
  await inFlight.promise;
  const raced = await second.tick();
  expect(raced.attempted).toBe(0);
  expect(receiver.requests).toHaveLength(1);

  // The request timed out after it was sent: uncertain, retried later under the same IDs.
  await first;
  await h.settle();
  expect(receiver.requests).toHaveLength(2);
  expect(new Set(receiver.requests.map((r) => r.headers["testmaster-delivery-id"])).size).toBe(1);
  const [delivery] = h.service.list();
  if (!delivery) throw new Error("Missing delivery");
  expect(delivery).toMatchObject({ state: "delivered", attempts: 2 });
  expect(h.service.get(delivery.id).attemptLog[0]).toMatchObject({ uncertain: true });
});

it("INT-026 OPS-011 PostgreSQL: fan-out from two dispatchers creates one delivery per event and integration", async () => {
  const h = await harness();
  const receiver = await h.receiver();
  await h.webhook(receiver);
  h.completedRun({ outcome: "failed" });
  h.completedRun({ outcome: "failed" });
  const second = await h.dispatcher();
  // Both scan the same outbox rows on their own connections; the unique key keeps one delivery each.
  const created = [h.service.fanOut(), second.fanOut(), second.fanOut(), h.service.fanOut()];
  expect(created).toEqual([2, 0, 0, 0]);
  await h.settle();
  expect(h.service.list()).toHaveLength(2);
  expect(receiver.requests).toHaveLength(2);
  expect(new Set(receiver.requests.map((r) => r.headers["testmaster-delivery-id"])).size).toBe(2);
});

it("INT-003 ARCH-004 OPS-037 PostgreSQL: a destination outage dead-letters visibly and leaves the Run, the gate and the Run count untouched", async () => {
  const h = await harness();
  const receiver = await h.receiver();
  receiver.behave(() => ({ status: 503 }));
  const integration = await h.webhook(receiver);
  const { runId } = h.completedRun({ outcome: "failed" });
  const runRow = () =>
    h.app.database.get(
      "SELECT outcome,gate,phase,status FROM runs WHERE workspace_id=? AND id=?",
      h.workspaceId,
      runId,
    );
  const runCount = () =>
    Number(
      h.app.database.get("SELECT COUNT(*) AS n FROM runs WHERE workspace_id=?", h.workspaceId)?.n,
    );
  const before = runRow();
  const runs = runCount();

  await h.settle(60);

  const [delivery] = h.service.list({ integrationId: integration.id });
  expect(delivery).toMatchObject({ state: "dead_letter", attempts: 10 });
  expect(receiver.requests).toHaveLength(10);
  expect(runRow()).toEqual(before);
  expect(runCount()).toBe(runs);
  // The dead letter is visible to operators and can be requeued once the destination recovers.
  receiver.behave(() => ({ status: 200 }));
  if (!delivery) throw new Error("Missing delivery");
  expect(
    h.app.operations
      .dlq()
      .filter((entry) => entry.source === "notification")
      .map((entry) => entry.id),
  ).toEqual([delivery.id]);
  h.app.operations.requeue({ source: "notification", id: delivery.id });
  await h.settle();
  expect(h.service.get(delivery.id)).toMatchObject({ state: "delivered" });
  expect(runRow()).toEqual(before);
});
