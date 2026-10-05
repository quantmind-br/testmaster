import { jsonSchema, validateAgainstSchema } from "@testmaster/contracts";
import { canonicalJson } from "@testmaster/domain";
import { expect, it } from "vitest";
import { compactPromptSchema } from "./schema-prompt.js";

it("shares repeated generated executable schema nodes without widening validation", () => {
  const original = jsonSchema("AIProposalsOutput");
  const compact = compactPromptSchema(original) as Record<string, unknown>;
  compact.$id = "urn:testmaster:AIProposalsOutput:compact-test";
  expect(Buffer.byteLength(canonicalJson(compact))).toBeLessThan(100000);
  const valid = {
    proposals: [
      {
        plan: {
          schemaVersion: "1.0.0",
          kind: "executable",
          name: "Health",
          type: "backend",
          runner: "http",
          requirementRefs: [],
          steps: [
            {
              id: "read",
              kind: "action",
              operation: "request",
              description: "Read health",
              input: { method: "GET", pathSegments: [{ literal: "health" }] },
            },
            {
              id: "status",
              kind: "assertion",
              operation: "assert",
              description: "Expect HTTP 200",
              input: { responseStepId: "read" },
              expectation: { predicate: "statusIn", values: [200] },
            },
          ],
        },
        requirementRefs: ["req_01900000-0000-7000-8000-000000000001"],
        evidenceRefs: [{ sourceRevisionId: "svr_01900000-0000-7000-8000-000000000001" }],
        warnings: [],
      },
    ],
  };
  expect(validateAgainstSchema(original, valid)).toBe(valid);
  expect(validateAgainstSchema(compact as Record<string, unknown>, valid)).toBe(valid);
  const invalid = {
    proposals: [
      {
        plan: { schemaVersion: "1.0.0", kind: "executable", steps: [] },
        requirementRefs: [],
        evidenceRefs: [],
        warnings: [],
      },
    ],
  };
  expect(() => validateAgainstSchema(original, invalid)).toThrow();
  expect(() => validateAgainstSchema(compact as Record<string, unknown>, invalid)).toThrow();
});
