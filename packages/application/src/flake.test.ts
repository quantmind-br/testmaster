import type { Run } from "@testmaster/contracts";
import { describe, expect, it } from "vitest";
import { runMatrixCell } from "./comparisons.js";
import { flakeIdentity } from "./flake.js";

function sample(): Run {
  return {
    testId: "test",
    revisionId: "revision",
    environmentRevisionId: "environment",
    matrixCell: {
      seed: 7,
      fixtureHash: "fixture-one",
      repetitionIndex: 0,
      admissionSnapshot: {
        repository: { commitSha: "a".repeat(40), checkoutSha: "a".repeat(40), binding: "verified" },
        requiredCapabilities: ["playwright"],
        runnerImageDigest: "sha256:runner",
        runtimeIdentity: {
          nodeVersion: "v24",
          playwrightVersion: "1.55",
          browserVersion: "140",
          imageId: "sha256:runner",
        },
      },
    },
  } as unknown as Run;
}
describe("flake cohort identity", () => {
  it("retains fixed source, fixture, environment and runtime identity while excluding repetition/run IDs", () => {
    const left = sample();
    const right = sample();
    right.id = "distinct-run";
    runMatrixCell(right).repetitionIndex = 9;
    expect(flakeIdentity(left)).toEqual(flakeIdentity(right));
    for (const change of ["fixtureHash", "seed"] as const) {
      const changed = sample();
      runMatrixCell(changed)[change] = change === "seed" ? 8 : "fixture-two";
      expect(flakeIdentity(changed).identityHash).not.toBe(flakeIdentity(left).identityHash);
    }
    const environment = sample();
    environment.environmentRevisionId = "changed-environment";
    expect(flakeIdentity(environment).identityHash).not.toBe(flakeIdentity(left).identityHash);
    const snapshot = runMatrixCell(right).admissionSnapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
      throw new Error("Missing fixture snapshot");
    snapshot.runtimeIdentity = {
      nodeVersion: "v24",
      playwrightVersion: "1.55",
      browserVersion: "141",
      imageId: "sha256:runner",
    };
    expect(flakeIdentity(right).identityHash).not.toBe(flakeIdentity(left).identityHash);
  });
  it("never treats absent source or measured browser identity as comparable cohort proof", () => {
    const missing = sample();
    delete runMatrixCell(missing).admissionSnapshot;
    expect(flakeIdentity(missing).limitations).toEqual(
      expect.arrayContaining(["source-binding-unavailable", "runtime-identity-unavailable"]),
    );
  });
});
