import { type ExecutablePlan, validate } from "@testmaster/contracts";
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

const planWith = (locator: unknown): ExecutablePlan =>
  validate<ExecutablePlan>("ExecutablePlan", {
    schemaVersion: "1.0.0",
    kind: "executable",
    name: "Delete the second row",
    type: "frontend",
    runner: "playwright",
    requirementRefs: [],
    steps: [
      {
        id: "delete",
        kind: "action",
        operation: "click",
        description: "Delete",
        input: { locator },
      },
      {
        id: "confirm",
        kind: "assertion",
        operation: "assert",
        description: "The list is shown",
        input: { locator: { by: "role", role: "list" } },
        expectation: { predicate: "visible" },
      },
    ],
  });
const healTo = (base: ExecutablePlan, value: unknown) =>
  applyHealingPatch(base, {
    changes: [{ stepId: "delete", path: "/input/locator", value }],
    evidenceHandles: ["E1"],
    explanation: "The control was renamed",
  });
it("never replaces a locator that selects by nth, nor produces one", () => {
  const renamed = { by: "role", role: "button", name: "Remove", exact: true };
  const positional = { by: "role", role: "button", name: "Delete", exact: true, nth: 1 };
  // Control: a locator without nth is replaced.
  expect(() => healTo(planWith({ ...renamed, name: "Delete" }), renamed)).not.toThrow();
  expect(() => healTo(planWith(positional), renamed)).toThrow(
    "Healing never produces or replaces a locator that selects by nth",
  );
  expect(() => healTo(planWith(renamed), positional)).toThrow(
    "Healing never produces or replaces a locator that selects by nth",
  );
  expect(() =>
    healTo(planWith({ by: "css", value: "li", container: { by: "css", value: "ul", nth: 0 } }), {
      by: "css",
      value: "li",
    }),
  ).toThrow("Healing never produces or replaces a locator that selects by nth");
});
