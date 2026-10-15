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
        evidenceIds: ["E1"],
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
        evidenceIds: [],
        warnings: [],
      },
    ],
  };
  expect(() => validateAgainstSchema(original, invalid)).toThrow();
  expect(() => validateAgainstSchema(compact as Record<string, unknown>, invalid)).toThrow();
});

it("lets the prompted proposal schema decline a requirement without widening it", () => {
  const original = {
    ...jsonSchema("AIProposalsOutput"),
    $id: "urn:testmaster:AIProposalsOutput:original-decline-test",
  };
  const compact = compactPromptSchema(original) as Record<string, unknown>;
  compact.$id = "urn:testmaster:AIProposalsOutput:compact-decline-test";
  const requirementId = "req_01900000-0000-7000-8000-000000000001";
  const decline = { proposals: [], unsupported: [{ requirementId, reason: "CLI exit status" }] };
  expect(validateAgainstSchema(original, decline)).toBe(decline);
  expect(validateAgainstSchema(compact, decline)).toBe(decline);
  for (const invalid of [
    { error: "cannot generate" },
    { ...decline, error: "cannot generate" },
    { proposals: [], unsupported: [{ requirementId, reason: "" }] },
    { proposals: [], unsupported: [{ requirementId: "not-an-id", reason: "CLI exit status" }] },
    { proposals: [], unsupported: [{ requirementId, reason: "x", extra: true }] },
  ]) {
    expect(() => validateAgainstSchema(original, invalid)).toThrow();
    expect(() => validateAgainstSchema(compact, invalid)).toThrow();
  }
});
