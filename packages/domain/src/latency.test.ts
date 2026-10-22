import { expect, it } from "vitest";
import { minimumSamples, percentile, roundMillis, summarizeLatencies } from "./latency.js";

it("rounds measurements to microseconds and keeps absence", () => {
  expect(roundMillis(1.23456)).toBe(1.235);
  expect(roundMillis(null)).toBeNull();
});

it("reports a percentile only from the sample count the rule requires", () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1);
  expect(percentile(values, 95)).toBe(95);
  expect(summarizeLatencies(values).p95Ms).toBe(95);
  expect(minimumSamples(95)).toBe(values.length);
  expect(minimumSamples(99)).toBe(500);
});
