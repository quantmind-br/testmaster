import { describe, expect, it } from "vitest";
import {
  asRunId,
  type ComparisonResult,
  describeComparison,
  describeReason,
  displayValue,
  groupComparison,
} from "./comparison-view";

const hash = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

function result(
  comparability: ComparisonResult["comparability"],
  differences: ComparisonResult["differences"],
  reasons: readonly string[] = [],
): ComparisonResult {
  return { comparability, reasons, differences, nextCursor: null, comparisonIdentity: "cmp" };
}

describe("comparison wording", () => {
  it("UX-035 a partially comparable result lists each difference and keeps the verdict rows", () => {
    const differences = [
      { field: "revisionId", left: "rev_1", right: "rev_2" },
      { field: "outcome", left: "passed", right: "failed" },
      { field: "steps", left: [{ status: "passed" }], right: [{ status: "failed" }] },
    ];
    const comparison = result("partially_comparable", differences, ["revision-changed"]);
    const summary = describeComparison(comparison);
    expect(summary.meaningful).toBe(true);
    expect(summary.label).toBe("Partially comparable");
    expect(summary.hiddenVerdictRows).toBe(0);
    const groups = groupComparison(differences);
    expect(groups.map((group) => group.id)).toEqual(["revision", "outcome", "steps"]);
    expect(groups.find((group) => group.id === "outcome")?.rows).toEqual([
      { field: "Outcome", key: "outcome", left: "passed", right: "failed" },
    ]);
    expect(describeReason("revision-changed")).toBe("The test revision differs.");
  });

  it("UX-035 an incomparable result is not meaningful and drops the verdict rows from the diagnosis list", () => {
    const differences = [
      { field: "testId", left: "tst_1", right: "tst_2" },
      { field: "outcome", left: "passed", right: "failed" },
      { field: "gate", left: "passed", right: "failed" },
    ];
    const summary = describeComparison(result("incomparable", differences));
    expect(summary.meaningful).toBe(false);
    expect(summary.label).toBe("Not comparable");
    expect(summary.hiddenVerdictRows).toBe(2);
    expect(summary.notice).toContain("not comparable");
    const groups = groupComparison(differences, { hideVerdicts: true });
    expect(groups.map((group) => group.id)).toEqual(["revision"]);
    // Negative control: the same rows are all kept when the sides can be compared.
    expect(groupComparison(differences).map((group) => group.id)).toEqual(["revision", "outcome"]);
  });

  it("UX-035 a difference is described as a difference, never as a regression", () => {
    const comparable = describeComparison(
      result("comparable", [{ field: "outcome", left: "passed", right: "failed" }]),
    );
    expect(comparable.notice).toContain("not a regression");
    for (const verdict of ["comparable", "partially_comparable", "incomparable"] as const) {
      const summary = describeComparison(result(verdict, []));
      expect(`${summary.label} ${summary.explanation} ${summary.notice}`).not.toMatch(
        /regress(ed|ion detected)/i,
      );
    }
  });

  it("UX-035 a batch case present on one side only reads as not run, never as passed", () => {
    const differences = [
      { field: `member-${hash}`, left: "run_aaaaaaaa-0000-4000-8000-000000000000", right: null },
      { field: `${hash}-outcome`, left: "passed", right: "failed" },
      { field: "requestedCount", left: 3, right: 2 },
    ];
    const groups = groupComparison(differences);
    expect(groups.map((group) => group.id)).toEqual(["membership", "outcome", "counts"]);
    const membership = groups.find((group) => group.id === "membership");
    expect(membership?.rows[0]?.field).toBe("Case a1b2c3d4…: present on one side only");
    expect(displayValue(`member-${hash}`, null)).toEqual({
      text: "Not present: not run",
      absent: true,
    });
    expect(displayValue(`member-${hash}`, null).text).not.toMatch(/pass/i);
    // Negative control: a null on an ordinary field is "None", not "not run".
    expect(displayValue("generationModelCallId", null).text).toBe("None");
    expect(displayValue("outcome", "failed")).toEqual({ text: "failed", absent: false });
  });

  it("UX-035 revision and cell mismatches keep their own explicit wording", () => {
    expect(describeReason("environment-changed")).toContain("environment");
    expect(describeReason("execution-config-changed")).toContain("configuration");
    expect(describeReason("seed-changed")).toBe("Seed differs.");
    expect(describeReason("runnerImageDigest-changed")).toBe("Runner image digest differs.");
    expect(describeReason("member-added-or-removed")).toContain("not a pass");
  });

  it("UX-035 only an exact Run ID becomes a link target", () => {
    expect(asRunId("run_aaaaaaaa-0000-4000-8000-000000000000")).toBe(
      "run_aaaaaaaa-0000-4000-8000-000000000000",
    );
    expect(asRunId("run_1")).toBeNull();
    expect(asRunId('run_aaaaaaaa-0000-4000-8000-000000000000"><script>')).toBeNull();
    expect(asRunId(null)).toBeNull();
  });
});
