import { describe, expect, it } from "vitest";
import { flakeStatistics } from "./foundations.js";

describe("strict flake statistics", () => {
  it.each([0, 1, 30, 100, 299, 300])(
    "reports exact zero-failure bounds for n=%i without invented confirmation",
    (n) => {
      const result = flakeStatistics({
        nPlanned: n,
        nPass: n,
        nFail: 0,
        nBlocked: 0,
        nCancelled: 0,
        nInconclusive: 0,
      });
      expect(result.counts.nValid).toBe(n);
      expect(result.classification).toBe(n < 2 ? "insufficient_data" : "passing_observed");
      expect(result.zeroFailureUpper95).toBe(n ? 1 - 0.05 ** (1 / n) : null);
      if (!n) expect(result.wilson95).toBeNull();
      else expect(result.wilson95).toMatchObject({ low: 0, high: expect.any(Number) });
      if (n === 299) expect(result.zeroFailureUpper95).toBeLessThanOrEqual(0.01);
      if (n === 300) expect(result.zeroFailureUpper95).toBeLessThan(0.01);
    },
  );
  it("keeps excluded observations out of the conditional denominator and never auto-confirms mixed outcomes", () => {
    const result = flakeStatistics({
      nPlanned: 100,
      nPass: 40,
      nFail: 40,
      nBlocked: 5,
      nCancelled: 5,
      nInconclusive: 5,
    });
    expect(result.counts).toMatchObject({ nValid: 80, nInFlight: 5 });
    expect(result.failureRate).toBe(0.5);
    expect(result.zeroFailureUpper95).toBeNull();
    expect(result.classification).toBe("suspected_flaky");
    expect(result.limitations.length).toBeGreaterThan(0);
    expect(
      flakeStatistics({
        nPlanned: 10,
        nPass: 0,
        nFail: 10,
        nBlocked: 0,
        nCancelled: 0,
        nInconclusive: 0,
      }).classification,
    ).toBe("deterministic_failure");
  });
  it("does not report passing_observed when half the terminal samples were blocked", () => {
    const result = flakeStatistics({
      nPlanned: 6,
      nPass: 3,
      nFail: 0,
      nBlocked: 3,
      nCancelled: 0,
      nInconclusive: 0,
    });
    expect(result.classification).toBe("unstable_infrastructure");
    expect(result.counts).toMatchObject({ nValid: 3, nBlocked: 3 });
    expect(result.limitations).toContain(
      "3 of 6 terminal samples were blocked or inconclusive and are outside the failure estimate; they point at the environment, not at the test",
    );
  });
  it("counts inconclusive samples with blocked ones and keeps a minority share as a limitation", () => {
    const base = { nFail: 0, nCancelled: 0 };
    expect(
      flakeStatistics({ ...base, nPlanned: 4, nPass: 2, nBlocked: 1, nInconclusive: 1 })
        .classification,
    ).toBe("unstable_infrastructure");
    const minority = flakeStatistics({
      ...base,
      nPlanned: 10,
      nPass: 9,
      nBlocked: 1,
      nInconclusive: 0,
    });
    expect(minority.classification).toBe("passing_observed");
    expect(minority.limitations).toContain(
      "1 of 10 terminal samples were blocked or inconclusive and are outside the failure estimate; they point at the environment, not at the test",
    );
  });
  it("keeps a failure observed next to blocked samples instead of hiding it as infrastructure", () => {
    expect(
      flakeStatistics({
        nPlanned: 8,
        nPass: 0,
        nFail: 2,
        nBlocked: 6,
        nCancelled: 0,
        nInconclusive: 0,
      }).classification,
    ).toBe("deterministic_failure");
  });
  it("rejects invalid counts rather than manufacturing a statistical interval", () => {
    expect(() =>
      flakeStatistics({
        nPlanned: 1,
        nPass: 2,
        nFail: 0,
        nBlocked: 0,
        nCancelled: 0,
        nInconclusive: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      flakeStatistics({
        nPlanned: 1,
        nPass: 0.5,
        nFail: 0,
        nBlocked: 0,
        nCancelled: 0,
        nInconclusive: 0,
      }),
    ).toThrow(RangeError);
  });
});
