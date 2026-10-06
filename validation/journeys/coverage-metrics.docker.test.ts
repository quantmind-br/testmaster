import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validate } from "@testmaster/contracts";
import { checks } from "@testmaster/reference-shop/oracle";
import { expect, it } from "vitest";
import { controlledShop, healthPlan, journey, object, text } from "./harness.js";

it("exports separate coverage and monotonic runtime metrics through the built CLI against the real reference shop", async () => {
  await journey("coverage-metrics", async (session) => {
    const target = await controlledShop("healthy");
    try {
      await session.init(target.url);
      const test = await session.createTest(healthPlan());
      const response = await session.command([
        "test",
        "run",
        text(test.id),
        "--wait",
        "--timeout",
        "120",
      ]);
      const runId = text(object(response.receipt).runId);
      const path = join(session.cwd, "metrics.json");
      await session.command(["report", "export", runId, "--format", "json", "--out", path]);
      const report = object(JSON.parse(await readFile(path, "utf8")));
      const coverage = object(report.coverage),
        metrics = object(report.executionMetrics);
      validate("CoverageMetrics", coverage);
      validate("ExecutionMetrics", metrics);
      expect(Object.keys(coverage).sort()).toEqual([
        "code",
        "execution",
        "operation",
        "requirement",
        "route",
      ]);
      for (const name of ["route", "operation", "code", "requirement"])
        expect(object(coverage[name])).toMatchObject({
          denominator: null,
          value: null,
          denominatorState: "unknown",
        });
      expect(object(coverage.execution)).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
      expect(object(metrics.counts)).toMatchObject({
        requested: 1,
        expanded: 0,
        executed: 1,
        attempts: 1,
        duplicates: 0,
        retried: 0,
      });
      expect(object(object(metrics.rates).strictPassRate)).toMatchObject({
        numerator: 1,
        denominator: 1,
      });
      const runs = report.runs as Record<string, unknown>[];
      const timing = object(runs[0]?.timings);
      validate("RuntimeTiming", timing);
      expect(timing.source).toBe("monotonic");
      expect(timing.queueDuration).toBeGreaterThanOrEqual(0);
      expect(timing.preparationDuration).toBeGreaterThan(0);
      expect(timing.executionDuration).toBeGreaterThan(0);
      expect(timing.collectionDuration).toBeGreaterThanOrEqual(0);
      expect(timing.analysisDuration).toBeNull();
      expect(timing.analysisStatus).toBe("not_requested");
      expect(runs[0]?.durationMs).toBe(timing.executionDuration);
      for (const format of ["markdown", "html"]) {
        const output = await session.command(["report", "export", runId, "--format", format]);
        expect(text(output.content)).toContain("route: unknown");
        expect(text(output.content)).toContain("strictPassRate");
      }
      const oracle = await checks.serviceHealth(target.shop);
      expect(oracle.healthy).toBe(true);
      session.oracles.push(oracle, {
        check: "separateCoverageAndRuntimeMetrics",
        runId,
        observed: { coverage, executionMetrics: metrics, timings: timing },
      });
      const duplicate = await session.command([
        "test",
        "run",
        text(test.id),
        text(test.id),
        "--wait",
        "--timeout",
        "120",
      ]);
      const batchId = text(duplicate.batchId ?? object(duplicate.receipt).batchId);
      const batchExport = await session.command(["report", "export", batchId, "--format", "json"]);
      const batchReport = object(JSON.parse(text(batchExport.content)));
      const batchMetrics = object(batchReport.executionMetrics);
      expect(object(batchMetrics.counts)).toMatchObject({
        requested: 1,
        duplicates: 1,
        allMembers: 1,
        attempts: 1,
      });
      expect(object(object(batchMetrics.rates).terminalPassRate)).toMatchObject({
        numerator: 1,
        denominator: 1,
      });
      session.oracles.push({
        check: "duplicateBatchCellsDoNotInflateDenominator",
        observed: batchMetrics,
      });
    } finally {
      await target.close();
    }
  });
}, 180_000);
