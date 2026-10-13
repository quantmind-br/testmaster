import { describe, expect, it } from "vitest";
import { type FlakeForm, flakeStudyBody, validateFlakeForm } from "./flake-form";

const valid: FlakeForm = {
  testId: "tst_1",
  revisionId: "rev_0190a1b2-c3d4-7e5f-8a6b-0123456789ab",
  environmentId: "env_0190a1b2-c3d4-7e5f-8a6b-0123456789ab",
  n: "10",
  seed: "0",
};

describe("flake study form", () => {
  it("UX-037 accepts a comparable cohort definition and builds the request body", () => {
    expect(validateFlakeForm(valid)).toEqual([]);
    expect(flakeStudyBody({ ...valid, n: " 12 ", seed: "-3" })).toEqual({
      testRevision: valid.revisionId,
      environment: valid.environmentId,
      n: 12,
      seed: -3,
    });
  });

  it("UX-037 refuses a sample too small to estimate flakiness", () => {
    for (const n of ["1", "0", "-4", "101", "2.5", "", "ten"]) {
      const issues = validateFlakeForm({ ...valid, n });
      expect(
        issues.map((issue) => issue.field),
        n,
      ).toEqual(["n"]);
    }
    expect(validateFlakeForm({ ...valid, n: "2" })).toEqual([]);
    expect(validateFlakeForm({ ...valid, n: "100" })).toEqual([]);
  });

  it("UX-037 requires a test, one revision, one environment and a whole-number seed", () => {
    const issues = validateFlakeForm({
      testId: "",
      revisionId: "latest",
      environmentId: "",
      n: "10",
      seed: "1.5",
    });
    expect(issues.map((issue) => issue.field)).toEqual([
      "testId",
      "revisionId",
      "environmentId",
      "seed",
    ]);
  });
});
