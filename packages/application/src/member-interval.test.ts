import { expect, it } from "vitest";
import { type MemberIntervalState, memberIntervalReady } from "./member-interval.js";

const start = Date.parse("2026-10-18T12:00:00.000Z");
const state = (overrides: Partial<MemberIntervalState>): MemberIntervalState => ({
  intervalMs: 500,
  predecessorStartedAt: new Date(start).toISOString(),
  predecessorCompleted: false,
  now: start,
  ...overrides,
});

it("REQ-034 a member starts only once the interval has passed since its predecessor started, to the millisecond", () => {
  expect(memberIntervalReady(state({ now: start }))).toBe(false);
  expect(memberIntervalReady(state({ now: start + 499 }))).toBe(false);
  expect(memberIntervalReady(state({ now: start + 500 }))).toBe(true);
  expect(memberIntervalReady(state({ now: start + 10_000 }))).toBe(true);
});

it("REQ-034 a member without pacing, or whose pacing is 0, never waits", () => {
  expect(memberIntervalReady(state({ intervalMs: undefined }))).toBe(true);
  expect(memberIntervalReady(state({ intervalMs: 0 }))).toBe(true);
  expect(memberIntervalReady(state({ intervalMs: 0, predecessorStartedAt: null }))).toBe(true);
});

it("REQ-034 a predecessor that has not started holds its successor, and one that ended without an attempt releases it", () => {
  expect(memberIntervalReady(state({ predecessorStartedAt: null }))).toBe(false);
  expect(
    memberIntervalReady(state({ predecessorStartedAt: null, predecessorCompleted: true })),
  ).toBe(true);
  // A started predecessor is judged by its start, not by whether it has finished.
  expect(memberIntervalReady(state({ predecessorCompleted: true, now: start + 100 }))).toBe(false);
});
