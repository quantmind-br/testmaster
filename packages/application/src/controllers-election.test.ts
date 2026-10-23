import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Application } from "./application.js";
import { liveControllers } from "./controller-instances.js";
import { ControllerRegistry, runControllers } from "./controllers.js";

let root: string;
let first: Application;
let second: Application;
const stops: AbortController[] = [];
const runs: Promise<void>[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tm-election-"));
  const home = join(root, "home");
  first = await Application.open({ cwd: root, home });
  await first.init();
  // A second Application on the same data directory is a second controller process.
  second = await Application.open({ cwd: root, home });
});
afterEach(async () => {
  for (const stop of stops.splice(0)) stop.abort();
  await Promise.all(runs.splice(0));
  first.close();
  second.close();
  await rm(root, { recursive: true, force: true });
});

const leaseMs = 300;
function start(application: Application, registry: ControllerRegistry): AbortController {
  const stop = new AbortController();
  stops.push(stop);
  runs.push(
    runControllers(application, registry, { profile: "server", signal: stop.signal, leaseMs }),
  );
  return stop;
}
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(20);
  }
}

it("runs an elected loop on one controller and a plain loop on every controller", async () => {
  const electedBy = new Set<string>();
  const plainBy = new Set<string>();
  const registry = new ControllerRegistry();
  registry.register({
    name: "probe-elected",
    intervalMs: 20,
    elected: true,
    run: (scope) => void electedBy.add(scope.controllerIdentity.id),
  });
  registry.register({
    name: "probe-plain",
    intervalMs: 20,
    run: (scope) => void plainBy.add(scope.controllerIdentity.id),
  });
  start(first, registry);
  start(second, registry);
  await until(() => plainBy.size === 2, "both controllers to run the plain loop");
  // Real lease terms are under test: leadership must stay put for several terms, which only elapsed time shows.
  await delay(3 * leaseMs);
  expect(electedBy.size).toBe(1);
  expect(liveControllers(first.controllerScope().database)).toHaveLength(2);
});

it("moves an elected loop to the survivor as soon as its holder stops", async () => {
  const electedBy: string[] = [];
  const registry = new ControllerRegistry();
  registry.register({
    name: "probe-elected",
    intervalMs: 20,
    elected: true,
    run: (scope) => void electedBy.push(scope.controllerIdentity.id),
  });
  const stopFirst = start(first, registry);
  await until(() => electedBy.length > 0, "the first controller to lead");
  start(second, registry);
  stopFirst.abort();
  await until(
    () => electedBy.includes(second.controllerIdentity.id),
    "the second controller to take over",
  );
  const lease = first
    .controllerScope()
    .database.get("SELECT holder,fence FROM controller_leases WHERE name='probe-elected'");
  expect(lease).toMatchObject({ holder: second.controllerIdentity.id });
  expect(Number(lease?.fence)).toBeGreaterThanOrEqual(2);
});

it("aborts a running elected tick when another controller took the lease", async () => {
  let started = false;
  let aborted = false;
  const registry = new ControllerRegistry();
  registry.register({
    name: "probe-slow",
    intervalMs: 3_600_000,
    elected: true,
    run: async (_scope, signal) => {
      started = true;
      const gone = Promise.withResolvers<void>();
      if (signal.aborted) gone.resolve();
      signal.addEventListener("abort", () => gone.resolve(), { once: true });
      await gone.promise;
      aborted = true;
    },
  });
  start(first, registry);
  await until(() => started, "the tick to start");
  first
    .controllerScope()
    .database.run(
      "UPDATE controller_leases SET holder='ctl_usurper',fence=fence+1,expires_at=? WHERE name='probe-slow'",
      "2099-01-01T00:00:00.000Z",
    );
  await until(() => aborted, "the tick to stop acting");
});
