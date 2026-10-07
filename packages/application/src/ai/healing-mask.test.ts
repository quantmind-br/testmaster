import { expect, it } from "vitest";
import { scaffoldPlan } from "../authoring.js";
import { applyHealingPatch } from "./healing-patch.js";

it("refuses an otherwise schema-valid request method change outside the healing path allowlist", () => {
  const base = scaffoldPlan("backend");
  const request = base.steps[0];
  if (!request) throw new Error("Missing request control fixture");
  expect(request.operation).toBe("request");
  expect(() =>
    applyHealingPatch(base, {
      changes: [{ stepId: request.id, path: "/input/method", value: "POST" }],
      evidenceHandles: ["E1"],
      explanation: "Observed setup change cannot authorize a new effect",
    }),
  ).toThrow("Healing patch path is not authorized");
});
