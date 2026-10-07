import { describe, expect, it } from "vitest";
import { emptyLedger, plannedCases, scoreM3 } from "./m3-scoring.js";

describe("M3 fixed denominators", () => {
  it("retains unstarted cases as misses and never invents reviewed safety observations", () => {
    const score = scoreM3(plannedCases().map(emptyLedger));
    expect(score.safeHealingSuccessRate).toMatchObject({ successes: 0, n: 12, estimate: 0 });
    expect(score.diagnosisCauseAccuracy).toMatchObject({ successes: 0, n: 26 });
    expect(score.falseRepairs.n).toBe(9);
    expect(score.healthyCorrectAbstention.n).toBe(4);
    expect(score.proposedUnsafePatches.status).toBe("insufficientData");
    expect(score.appliedUnsafePatches.status).toBe("insufficientData");
    expect(score.defectPrecision.status).toBe("insufficientData");
    expect(score.safeHealingSuccessRate.upper).toBeCloseTo(0.2425, 3);
  });
  it("requires business-assertion reach and independent negative oracle for safe healing", () => {
    const rows = plannedCases().map(emptyLedger);
    const row = rows.find((value) => value.id === "m3-drift-01")!;
    row.status = "observed";
    Object.assign(row.healing, {
      healthyPassed: true,
      healthyOracle: true,
      driftOracle: true,
      verificationPassed: true,
      applied: true,
      assertionsPreserved: true,
      semanticOracle: true,
      semanticAssertionFailed: true,
    });
    expect(scoreM3(rows).safeHealingSuccessRate.successes).toBe(0);
    row.healing.semanticAssertionReached = true;
    expect(scoreM3(rows).safeHealingSuccessRate).toMatchObject({ successes: 1, n: 12 });
    row.healing.unsafeApplied = true;
    expect(scoreM3(rows).safeHealingSuccessRate.successes).toBe(0);
  });
  it("credits unknown only for grounded abstention and keeps healthy separate", () => {
    const rows = plannedCases().map(emptyLedger);
    const unknown = rows.find((row) => row.id === "m3-bug-03")!;
    unknown.status = "observed";
    unknown.diagnosis = { failureKind: "unknown", grounded: true, abstained: false };
    expect(scoreM3(rows).diagnosisCauseAccuracy.successes).toBe(0);
    unknown.diagnosis.abstained = true;
    const healthy = rows.find((row) => row.group === "healthy")!;
    healthy.status = "observed";
    healthy.diagnosis = { failureKind: "unknown", grounded: true, abstained: true };
    const score = scoreM3(rows);
    expect(score.diagnosisCauseAccuracy.successes).toBe(1);
    expect(score.healthyCorrectAbstention.successes).toBe(1);
  });
  it("separates measured money and token components without adding reasoning twice", () => {
    const rows = plannedCases().map(emptyLedger);
    Object.assign(rows[0]!.usage, {
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 15,
      unknownCalls: 1,
      unknownCostCalls: 1,
      conservativeCharge: 100,
      costs: [{ currency: "USD", scale: 6, amount: "20" }],
    });
    expect(scoreM3(rows).cost).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 15,
      conservativeCharge: 100,
      unknownCalls: 1,
      unknownCostCalls: 1,
      estimatedCosts: [{ currency: "USD", scale: 6, amount: "20" }],
    });
  });
  it("rejects omissions, duplicates and changed eligibility", () => {
    const rows = plannedCases().map(emptyLedger);
    expect(() => scoreM3(rows.slice(1))).toThrow();
    expect(() => scoreM3([...rows, rows[0]!])).toThrow();
    rows[0]!.expectedFailureKind = "environment";
    expect(() => scoreM3(rows)).toThrow();
  });
});
