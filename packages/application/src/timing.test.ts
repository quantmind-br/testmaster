import { validate } from "@testmaster/contracts";
import { expect, it } from "vitest";
import { RuntimeTimer, timingBoundary } from "./timing.js";

it("records all runtime boundaries while wall UTC jumps backward and forward", () => {
  let monotonic = 10,
    wall = Date.parse("2026-10-05T12:00:00Z");
  const clock = { utcNow: () => new Date(wall).toISOString(), monotonicMs: () => monotonic };
  const queued = { clockDomain: "test-boot", boundary: timingBoundary("queued", clock) };
  monotonic = 30;
  const timer = new RuntimeTimer(clock, "test-boot", queued);
  wall -= 3_600_000;
  monotonic = 80;
  timer.mark("running");
  wall += 7_200_000;
  monotonic = 180;
  timer.mark("collecting");
  wall -= 86_400_000;
  monotonic = 210;
  timer.mark("analyzing");
  monotonic = 250;
  timer.mark("completed");
  const timing = timer.snapshot();
  validate("RuntimeTiming", timing);
  expect(timing).toMatchObject({
    queueDuration: 20,
    preparationDuration: 50,
    executionDuration: 100,
    collectionDuration: 30,
    analysisDuration: 40,
    wallClockDuration: 240,
    analysisStatus: "measured",
  });
  const first = timing.boundaries[0];
  const last = timing.boundaries.at(-1);
  if (!first || !last) throw new Error("Expected runtime boundaries");
  expect(Date.parse(last.occurredAt) - Date.parse(first.occurredAt)).toBeLessThan(0);
});
it("does not subtract monotonic timestamps across a reboot or invent unrequested analysis time", () => {
  const clock = { utcNow: () => "2026-10-05T12:00:00Z", monotonicMs: () => 40 };
  const timer = new RuntimeTimer(clock, "new-boot", {
    clockDomain: "old-boot",
    boundary: { phase: "queued", occurredAt: clock.utcNow(), monotonicMs: 9000 },
  });
  timer.mark("completed");
  expect(timer.snapshot()).toMatchObject({
    queueDuration: null,
    wallClockDuration: null,
    executionDuration: null,
    analysisDuration: null,
    analysisStatus: "not_requested",
  });
});
