import { describe, expect, it } from "vitest";
import {
  AUTOMATED_SCAN_ONLY,
  type AxeResults,
  type AxeRuleResult,
  summarizeAccessibility,
  WCAG22_AA_CRITERIA,
} from "./accessibility.js";

function rule(id: string, impact: string | null, tags: string[], elements: number): AxeRuleResult {
  return {
    id,
    impact,
    tags,
    nodes: Array.from({ length: elements }, (_, index) => ({ target: [`#n${index}`] })),
  };
}
function results(partial: Partial<AxeResults>): AxeResults {
  return {
    testEngine: { name: "axe-core", version: "4.14.0" },
    violations: [],
    incomplete: [],
    passes: [],
    ...partial,
  };
}

describe("accessibilityViolations verdict", () => {
  it("ADR-032 counts serious and critical violating elements against maximum, inclusive", () => {
    const scan = results({
      violations: [
        rule("label", "critical", ["wcag2a", "wcag412"], 2),
        rule("color-contrast", "serious", ["wcag2aa", "wcag143"], 1),
        rule("region", "moderate", ["best-practice"], 5),
        rule("heading-order", "minor", ["best-practice"], 4),
      ],
    });
    expect(summarizeAccessibility(scan, 3, ["wcag2a"])).toMatchObject({
      counted: 3,
      passed: true,
    });
    expect(summarizeAccessibility(scan, 2, ["wcag2a"])).toMatchObject({
      counted: 3,
      passed: false,
    });
    expect(summarizeAccessibility(results({}), 0, ["wcag2a"])).toMatchObject({
      counted: 0,
      passed: true,
    });
  });
  it("ADR-032 always reports the automated-scan limitation and the criteria no rule judged", () => {
    const scan = summarizeAccessibility(
      results({
        passes: [rule("document-title", null, ["wcag2a", "wcag242"], 1)],
        incomplete: [rule("color-contrast", "serious", ["wcag2aa", "wcag143"], 1)],
        violations: [rule("target-size", "serious", ["wcag22aa", "wcag258"], 1)],
      }),
      5,
      ["wcag2a", "wcag2aa", "wcag22aa"],
    );
    expect(scan.passed).toBe(true);
    expect(scan.limitations).toEqual([AUTOMATED_SCAN_ONLY]);
    expect(scan.exercisedCriteria).toEqual(["1.4.3", "2.4.2", "2.5.8"]);
    expect(scan.notVerified).toHaveLength(WCAG22_AA_CRITERIA.length - 3);
    expect(scan.notVerified).toContain("2.1.1");
    expect(scan.notVerified).not.toContain("2.4.2");
    expect(summarizeAccessibility(results({}), 0, ["wcag2a"]).notVerified).toEqual([
      ...WCAG22_AA_CRITERIA,
    ]);
  });
});
