import { setTimeout as delay } from "node:timers/promises";
import { PersistenceDatabase } from "@testmaster/persistence";
import { createTestDatabase, type TestDatabase } from "@testmaster/persistence/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  liveControllers,
  newControllerIdentity,
  registerController,
} from "./controller-instances.js";
import { acquireLease, databaseClock, renewLease } from "./controller-leases.js";

let test: TestDatabase;
/** Two connections stand for two controller processes on one PostgreSQL database. */
let first: PersistenceDatabase;
let second: PersistenceDatabase;
beforeEach(async () => {
  test = await createTestDatabase();
  first = PersistenceDatabase.openPostgres(test.config);
  second = PersistenceDatabase.openPostgres(test.config);
});
afterEach(async () => {
  vi.useRealTimers();
  first.close();
  second.close();
  await test.drop();
});

const hour = 3_600_000;

it("judges lease expiry on the database clock, so a controller whose clock runs ahead cannot take a live lease", () => {
  expect(acquireLease(first, "alerts", "ctl_a", 30_000)).toEqual({ fence: 1 });
  const real = Date.now();
  // This process's wall clock jumps an hour ahead, as a skewed controller host's would.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(real + hour);
  expect(Math.abs(databaseClock(second) - real)).toBeLessThan(60_000);
  expect(acquireLease(second, "alerts", "ctl_b", 30_000)).toBeNull();
  expect(renewLease(second, "alerts", "ctl_b", 1, 30_000)).toBe(false);
  expect(acquireLease(first, "alerts", "ctl_a", 30_000)).toEqual({ fence: 1 });
});

it("lets a survivor with a clock far behind take a lease that really expired", async () => {
  expect(acquireLease(first, "alerts", "ctl_a", 100)).toEqual({ fence: 1 });
  await delay(250);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() - hour);
  expect(acquireLease(second, "alerts", "ctl_b", 30_000)).toEqual({ fence: 2 });
});

it("decides controller liveness on the database clock too", () => {
  const a = newControllerIdentity();
  registerController(first, a);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + hour);
  expect(liveControllers(second).map((controller) => controller.id)).toEqual([a.id]);
});
