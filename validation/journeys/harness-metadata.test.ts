import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { journey, root } from "./harness.js";

it("records automatic method reviewer and limitations without claiming a human or unopened UI", async () => {
  await journey(
    "journey-manifest-metadata",
    async (session) => {
      session.oracles.push({ check: "manifest-field-acceptance", passed: true });
    },
    {
      class: "manifest-contract",
      runner: "node-filesystem",
      externalDependency: "none",
      limitations: ["Manifest serialization only; no UI, browser or target exercised."],
    },
  );
  const result = JSON.parse(
    await readFile(join(root, "validation/results/journey-manifest-metadata.json"), "utf8"),
  );
  expect(result).toMatchObject({
    method: "automatic",
    reviewer: "testmaster-automated-acceptance",
    runner: "node-filesystem",
    passed: true,
    limitations: ["Manifest serialization only; no UI, browser or target exercised."],
  });
  expect(result.reviewLimitations).toContain(
    "Automated oracle only; no independent human sign-off implied.",
  );
  expect(result.oracleVerdicts).toEqual([{ check: "manifest-field-acceptance", passed: true }]);
});
