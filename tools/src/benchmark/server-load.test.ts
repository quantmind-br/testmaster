import { minimumSamples, percentile, summarizeLatencies } from "@testmaster/domain";
import { describe, expect, it } from "vitest";
import {
  closedLoop,
  evaluateTargets,
  exceedanceSamples,
  judgeUpperBound,
  type Nfr006Target,
  nfr006Targets,
  type OperationResult,
  parseArguments,
  type Sample,
  summarizeOperation,
} from "./server-load.js";

const ramp = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

function level(
  operation: string,
  concurrency: number,
  latencies: readonly number[],
  errors = 0,
): OperationResult {
  const samples: Sample[] = [
    ...latencies.map((ms) => ({ label: operation, ms, ok: true, status: 200 as const })),
    ...Array.from({ length: errors }, () => ({
      label: operation,
      ms: 1,
      ok: false,
      status: 500 as const,
    })),
  ];
  return summarizeOperation(operation, concurrency, samples.length, {
    samples,
    iterations: samples.length,
    wallMs: 1000,
    truncated: false,
  });
}

describe("OPS-034 percentile statistics", () => {
  it("OPS-034 uses the nearest-rank definition", () => {
    const hundred = ramp(100);
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 99)).toBe(99);
    expect(percentile(hundred, 100)).toBe(100);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 95)).toBeNull();
    expect(() => percentile(hundred, 0)).toThrow(RangeError);
    expect(() => percentile(hundred, 101)).toThrow(RangeError);
  });

  it("OPS-034 summarizes unsorted samples without mutating the input", () => {
    const input = [30, 10, 20, 40];
    const summary = summarizeLatencies(input);
    expect(input).toEqual([30, 10, 20, 40]);
    expect(summary).toEqual({
      count: 4,
      minMs: 10,
      meanMs: 25,
      p50Ms: 20,
      p95Ms: 40,
      p99Ms: 40,
      maxMs: 40,
    });
    expect(summarizeLatencies([])).toEqual({
      count: 0,
      minMs: null,
      meanMs: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      maxMs: null,
    });
  });

  it("OPS-034 requires five samples beyond the percentile before reporting it as a measurement", () => {
    expect(minimumSamples(95)).toBe(100);
    expect(minimumSamples(99)).toBe(500);
    expect(minimumSamples(50)).toBe(10);
    expect(() => minimumSamples(100)).toThrow(RangeError);
  });

  it("OPS-034 keeps errors out of the latency percentiles and flags thin samples", () => {
    const thin = level("run_detail", 1, ramp(99), 3);
    expect(thin.errors).toBe(3);
    expect(thin.statusCounts).toEqual({ "200": 99, "500": 3 });
    expect(thin.latency.count).toBe(99);
    expect(thin.p95Supported).toBe(false);
    const thick = level("run_detail", 1, ramp(100));
    expect(thick.p95Supported).toBe(true);
    expect(thick.p99Supported).toBe(false);
    expect(thick.throughputPerSecond).toBe(100);
  });
});

describe("OPS-034 verdicts", () => {
  it("OPS-034 never turns missing, thin or erroring data into a pass", () => {
    expect(judgeUpperBound(1500, 2000, true)).toBe("met");
    expect(judgeUpperBound(2000, 2000, true)).toBe("met");
    expect(judgeUpperBound(2001, 2000, true)).toBe("not met");
    expect(judgeUpperBound(10, 2000, false)).toBe("not measured");
    expect(judgeUpperBound(null, 2000, true)).toBe("not measured");
    expect(judgeUpperBound(10, 2000, true, 1)).toBe("not met");
    expect(judgeUpperBound(null, 2000, false, 0, true)).toBe("not met");
  });

  const target: Nfr006Target = {
    id: "T",
    item: "item",
    source: "source",
    proposedTarget: { metric: "p95", limit: 2, unit: "s", condition: "condition" },
    operations: ["op"],
  };

  it("OPS-034 judges the worst reference concurrency and ignores stress levels", () => {
    const results = [
      level(
        "op",
        1,
        ramp(100).map((value) => value * 10),
      ),
      level(
        "op",
        4,
        ramp(100).map((value) => value * 15),
      ),
      level(
        "op",
        8,
        ramp(100).map((value) => value * 20),
      ),
      level(
        "op",
        32,
        ramp(100).map((value) => value * 90),
      ),
    ];
    const [row] = evaluateTargets([target], results, [1, 4, 8], 10_000);
    expect(row?.verdict).toBe("met");
    expect(row?.measured?.concurrency).toBe(8);
    expect(row?.measured?.valueMs).toBe(1900);
    expect(row?.proposedTarget.limit).toBe(2);
    const [stressed] = evaluateTargets([target], results, [1, 4, 8, 32], 10_000);
    expect(stressed?.verdict).toBe("not met");
    expect(stressed?.measured?.concurrency).toBe(32);
  });

  it("OPS-034 reports not met even when another level lacks samples", () => {
    const results = [
      level(
        "op",
        1,
        ramp(100).map((value) => value * 30),
      ),
      level("op", 4, ramp(10)),
    ];
    const [row] = evaluateTargets([target], results, [1, 4], 10_000);
    expect(row?.verdict).toBe("not met");
  });

  it("OPS-034 reports not measured when a reference level is absent, thin or has errors above target", () => {
    const missing = evaluateTargets([target], [level("op", 1, ramp(100))], [1, 4], 10_000);
    expect(missing[0]?.verdict).toBe("not measured");
    const thin = evaluateTargets([target], [level("op", 1, ramp(50))], [1], 10_000);
    expect(thin[0]?.verdict).toBe("not measured");
    const failing = evaluateTargets([target], [level("op", 1, ramp(100), 5)], [1], 10_000);
    expect(failing[0]?.verdict).toBe("not met");
  });

  it("OPS-034 proves not met from a thin series only when every attempt exceeded the limit", () => {
    const slow = level("op", 1, [3000, 3100, 3200, 3300, 3400]);
    expect(slow.p95Supported).toBe(false);
    expect(evaluateTargets([target], [slow], [1], 10_000)[0]?.verdict).toBe("not met");
    const oneFast = level("op", 1, [100, 3100, 3200, 3300, 3400]);
    expect(evaluateTargets([target], [oneFast], [1], 10_000)[0]?.verdict).toBe("not measured");
    const fewer = level("op", 1, [3000, 3100, 3200, 3300]);
    expect(evaluateTargets([target], [fewer], [1], 10_000)[0]?.verdict).toBe("not measured");
    const timedOut = level("op", 1, [], 5);
    expect(evaluateTargets([target], [timedOut], [1], 10_000)[0]?.verdict).toBe("not met");
    expect(exceedanceSamples).toBe(5);
  });

  it("OPS-034 does not claim dataset-bound targets on a smaller dataset", () => {
    const bound = { ...target, minimumDatasetRuns: 10_000 };
    const [row] = evaluateTargets([bound], [level("op", 1, ramp(100))], [1], 9_999);
    expect(row?.verdict).toBe("not measured");
    expect(row?.measured).toBeNull();
    expect(row?.reason).toContain("10000");
  });

  it("OPS-034 leaves targets that need executed Runs as not measured", () => {
    const rows = evaluateTargets(nfr006Targets, [], [1, 4, 8], 10_000);
    const orchestration = rows.find((row) => row.id === "NFR-006/orchestration-overhead");
    expect(orchestration?.verdict).toBe("not measured");
    expect(orchestration?.measured).toBeNull();
    expect(orchestration?.proposedTarget).toEqual({
      metric: "p95",
      limit: 2,
      unit: "s",
      condition: "local warm dispatch",
    });
    expect(rows.every((row) => row.verdict === "not measured")).toBe(true);
  });
});

describe("OPS-034 closed-loop load", () => {
  it("OPS-034 never exceeds the configured concurrency and runs every iteration", async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await closedLoop({ concurrency: 4, iterations: 40, maxMs: 60_000 }, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((done) => setImmediate(done));
      inFlight--;
      return [{ label: "x", ms: 1, ok: true, status: 200 }];
    });
    expect(peak).toBe(4);
    expect(result.iterations).toBe(40);
    expect(result.samples).toHaveLength(40);
    expect(result.truncated).toBe(false);
  });

  it("OPS-034 stops at the time limit and says so", async () => {
    let clock = 0;
    const result = await closedLoop(
      { concurrency: 1, iterations: 1000, maxMs: 50 },
      async () => {
        clock += 10;
        return [{ label: "x", ms: 10, ok: true, status: 200 }];
      },
      () => clock,
    );
    expect(result.iterations).toBe(5);
    expect(result.truncated).toBe(true);
  });
});

describe("OPS-034 command line", () => {
  it("OPS-034 requires --out and rejects unknown flags", () => {
    expect(() => parseArguments([])).toThrow("--out");
    expect(() => parseArguments(["--out", "x.json", "--bogus", "1"])).toThrow("--bogus");
    expect(() => parseArguments(["--out", "x.json", "--runs", "0"])).toThrow("positive");
  });

  it("OPS-034 defaults to 20 projects, 1000 tests, 10000 Runs and concurrency 1/4/8/32", () => {
    const options = parseArguments(["--out", "x.json"]);
    expect(options.projects * options.testsPerProject).toBe(1000);
    expect(options.runs).toBe(10_000);
    expect(options.concurrency).toEqual([1, 4, 8, 32]);
    expect(options.referenceSeries).toEqual([1, 4, 8]);
    expect(parseArguments(["--out", "x.json", "--concurrency", "2,6"]).concurrency).toEqual([2, 6]);
  });
});
