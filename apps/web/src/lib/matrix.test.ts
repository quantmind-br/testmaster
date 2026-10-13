import { describe, expect, it } from "vitest";
import { type BatchReceiptLike, buildMatrix } from "./matrix";
import type { RunRecord, Verdict } from "./run-types";

let sequence = 0;
function run(testId: string, environment: string, outcome: Verdict | null): RunRecord {
  sequence += 1;
  const id = `run_${String(sequence).padStart(8, "0")}-0000-4000-8000-000000000000`;
  return {
    id,
    testId,
    revisionId: "rev_1",
    environmentRevisionId: `evr_${environment}`,
    batchId: "bat_1",
    mode: "replay",
    phase: outcome === null ? "running" : "completed",
    status: outcome ?? "running",
    outcome,
    origin: "api",
    gate: "pending",
    cleanupOutcome: "not_required",
    analysisStatus: "not_requested",
    createdAt: `2026-10-13T00:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
    version: 1,
    matrixCell: { environmentId: `env_${environment}`, environmentName: environment },
  };
}

function receipt(
  runs: readonly RunRecord[],
  overrides: Partial<BatchReceiptLike> = {},
): BatchReceiptLike {
  return {
    batchId: "bat_1",
    requested: runs.length,
    accepted: runs.length,
    notDispatched: [],
    allMembers: runs.map((entry) => entry.id),
    counts: { passed: 0, failed: 0, blocked: 0, cancelled: 0, inconclusive: 0, inFlight: 0 },
    gate: "passed",
    ...overrides,
  };
}

describe("batch matrix completeness", () => {
  it("UX-036 a batch whose every member has a loaded Run is complete and reads its gate", () => {
    const runs = [
      run("t1", "chromium", "passed"),
      run("t1", "firefox", "passed"),
      run("t2", "chromium", "passed"),
      run("t2", "firefox", "passed"),
    ];
    const matrix = buildMatrix(receipt(runs), runs);
    expect(matrix.completeness).toBe("complete");
    expect(matrix.missingRuns).toBe(0);
    expect(matrix.headline).toBe("4 Runs, gate passed.");
    expect(matrix.columns).toEqual(["chromium", "firefox"]);
  });

  it("UX-036 a member without a loaded Run makes the batch incomplete instead of green", () => {
    const runs = [
      run("t1", "chromium", "passed"),
      run("t1", "firefox", "passed"),
      run("t2", "chromium", "passed"),
    ];
    const missing = {
      ...receipt(runs),
      allMembers: [...runs.map((entry) => entry.id), "run_missing"],
    };
    const matrix = buildMatrix(missing, runs);
    expect(matrix.completeness).toBe("incomplete");
    expect(matrix.missingRuns).toBe(1);
    expect(matrix.headline).toMatch(
      /^Incomplete: 0 member\(s\) were not dispatched and 1 Run\(s\) are not loaded/,
    );
    // The pair with no Run has no cell: the page renders it as "Not run", never as an empty pass.
    expect(matrix.rows.find((row) => row.testId === "t2")?.cells.firefox).toBeUndefined();
    expect(matrix.rows.find((row) => row.testId === "t2")?.cells.chromium?.runs).toHaveLength(1);
  });

  it("UX-036 a member that was not dispatched keeps its reason code and makes the batch incomplete", () => {
    const runs = [run("t1", "chromium", "passed")];
    const matrix = buildMatrix(
      receipt(runs, {
        requested: 2,
        notDispatched: [{ memberKey: "1:tst_missing", reasonCode: "upstream_failed" }],
        gate: "failed",
      }),
      runs,
    );
    expect(matrix.completeness).toBe("incomplete");
    expect(matrix.notDispatched).toEqual([
      { memberKey: "1:tst_missing", reasonCode: "upstream_failed" },
    ]);
    expect(matrix.headline).toContain("1 member(s) were not dispatched");
  });

  it("UX-036 a failure in one environment stays in its own cell and is not folded into a pass", () => {
    const failing = run("t1", "firefox", "failed");
    const runs = [run("t1", "chromium", "passed"), failing, run("t1", "webkit", "passed")];
    const matrix = buildMatrix(receipt(runs, { gate: "failed" }), runs);
    const row = matrix.rows[0];
    expect(row?.cells.firefox?.runs.map((entry) => entry.outcome)).toEqual(["failed"]);
    expect(row?.cells.chromium?.runs.map((entry) => entry.outcome)).toEqual(["passed"]);
    expect(matrix.summary.failed).toBe(1);
    expect(matrix.summary.passed).toBe(2);
  });

  it("UX-036 a Run that has not finished is counted as in flight, never as zero failures", () => {
    const runs = [run("t1", "chromium", null), run("t1", "firefox", "passed")];
    const matrix = buildMatrix(receipt(runs, { gate: "pending" }), runs);
    expect(matrix.summary.inFlight).toBe(1);
    expect(matrix.summary.failed).toBe(0);
    expect(matrix.rows[0]?.cells.chromium?.runs[0]?.outcome).toBeNull();
  });

  it("UX-036 repetitions of one test and environment are all listed in order", () => {
    const first = run("t1", "chromium", "passed");
    const second = run("t1", "chromium", "failed");
    const third = run("t1", "chromium", "passed");
    first.matrixCell = { ...first.matrixCell, repetitionIndex: 2 };
    second.matrixCell = { ...second.matrixCell, repetitionIndex: 0 };
    third.matrixCell = { ...third.matrixCell, repetitionIndex: 1 };
    const matrix = buildMatrix(receipt([first, second, third]), [first, second, third]);
    expect(matrix.rows[0]?.cells.chromium?.runs.map((entry) => entry.id)).toEqual([
      second.id,
      third.id,
      first.id,
    ]);
  });
});
