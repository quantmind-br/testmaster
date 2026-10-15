import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AttemptClock } from "./attempt-clock.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(() => {
  vi.useRealTimers();
});

it("fires the deadline after its budget of attempt time when nothing is pending (control)", async () => {
  const clock = new AttemptClock();
  const expired = vi.fn();
  clock.deadline(1000, expired);
  await vi.advanceTimersByTimeAsync(999);
  expect(expired).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(expired).toHaveBeenCalledTimes(1);
});

it("does not count the time of a pending wait and fires after the remaining attempt time", async () => {
  const clock = new AttemptClock();
  const expired = vi.fn();
  clock.deadline(1000, expired);
  await vi.advanceTimersByTimeAsync(400);
  const resume = clock.pause();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(expired).not.toHaveBeenCalled();
  resume();
  await vi.advanceTimersByTimeAsync(599);
  expect(expired).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(expired).toHaveBeenCalledTimes(1);
});

it("stays paused until the last of several overlapping waits settles", async () => {
  const clock = new AttemptClock();
  const expired = vi.fn();
  clock.deadline(500, expired);
  const first = clock.pause();
  await vi.advanceTimersByTimeAsync(100);
  const second = clock.pause();
  first();
  first();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(expired).not.toHaveBeenCalled();
  second();
  await vi.advanceTimersByTimeAsync(499);
  expect(expired).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(expired).toHaveBeenCalledTimes(1);
});

it("applies a deadline armed while the clock is paused only after the resume", async () => {
  const clock = new AttemptClock();
  const resume = clock.pause();
  const expired = vi.fn();
  clock.deadline(300, expired);
  await vi.advanceTimersByTimeAsync(5000);
  expect(expired).not.toHaveBeenCalled();
  resume();
  await vi.advanceTimersByTimeAsync(300);
  expect(expired).toHaveBeenCalledTimes(1);
});

it("releases the clock when the waited operation rejects and lets a cancelled deadline stay silent", async () => {
  const clock = new AttemptClock();
  const expired = vi.fn();
  const cancelled = vi.fn();
  clock.deadline(200, expired);
  clock.deadline(100, cancelled)();
  await expect(
    clock.during(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      throw new Error("provider failed");
    }),
  ).rejects.toThrow("provider failed");
  expect(expired).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(expired).toHaveBeenCalledTimes(1);
  expect(cancelled).not.toHaveBeenCalled();
});

it("measures a stopwatch in attempt time, excluding waits", async () => {
  const clock = new AttemptClock();
  const watch = clock.stopwatch();
  await vi.advanceTimersByTimeAsync(100);
  const resume = clock.pause();
  await vi.advanceTimersByTimeAsync(900);
  expect(watch.elapsed()).toBe(100);
  resume();
  await vi.advanceTimersByTimeAsync(50);
  expect(watch.elapsed()).toBe(150);
  const later = clock.stopwatch();
  await vi.advanceTimersByTimeAsync(10);
  expect(later.elapsed()).toBe(10);
});
