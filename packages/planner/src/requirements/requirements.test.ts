import { ContractError } from "@testmaster/contracts";
import { expect, it } from "vitest";
import { EvidenceCatalog } from "../sources/evidence.js";
import type { SourceEvidenceRef } from "../sources/types.js";
import {
  type NormalizedRequirement,
  type NormalizedRequirements,
  type RequirementConflict,
  resolveConflictOutput,
  resolveNormalizationOutput,
  validateNormalization,
} from "./index.js";

const first: SourceEvidenceRef = { sourceRevisionId: "rev-a", contentHash: "hash-a" };
const second: SourceEvidenceRef = { sourceRevisionId: "rev-b", contentHash: "hash-b" };
const catalog = new EvidenceCatalog([first, second]);
const ungroundedRequirement = "Requirement references evidence outside supplied sources";
const ungroundedConflict = "Conflict evidence is not grounded";

const requirement = (key: string, overrides: Partial<NormalizedRequirement> = {}) => ({
  key,
  text: `Text of ${key}`,
  acceptanceCriteria: [`Criterion of ${key}`],
  sourceRefs: [first],
  originKind: "explicit" as const,
  confidence: null,
  reason: "Stated",
  ...overrides,
});
const conflict = (keys: string[], sourceRefs: SourceEvidenceRef[]): RequirementConflict => ({
  keys,
  reason: "Disagree",
  sourceRefs,
});
const state = (
  requirements: NormalizedRequirement[],
  conflicts: RequirementConflict[] = [],
): NormalizedRequirements => ({ requirements, conflicts, openQuestions: [] });
const cited = (key: string, evidenceIds: string[]) => ({
  key,
  text: `Text of ${key}`,
  acceptanceCriteria: [`Criterion of ${key}`],
  evidenceIds,
  originKind: "explicit",
  confidence: null,
  reason: "Stated",
});
/** The refusal a call throws; fails the test when it does not throw. */
function refusal(run: () => unknown): ContractError {
  try {
    run();
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw error;
  }
  throw new Error("Expected the call to be refused");
}

it("reports every unknown evidence handle of an extraction answer at its own position", () => {
  const error = refusal(() =>
    resolveNormalizationOutput(
      {
        requirements: [cited("a", ["E1"]), cited("b", ["E99"])],
        conflicts: [
          {
            keys: ["a", "b"],
            reason: "Disagree",
            evidenceIds: ["E1", "E98"],
          },
        ],
        openQuestions: [],
      },
      catalog,
    ),
  );
  expect(error).toMatchObject({
    code: "INVALID_ARGUMENT",
    message: ungroundedRequirement,
    details: {},
  });
  expect(error.issues).toEqual([
    {
      path: "/requirements/1/evidenceIds/0",
      rule: "evidenceGrounding",
      message: ungroundedRequirement,
    },
    { path: "/conflicts/0/evidenceIds/1", rule: "evidenceGrounding", message: ungroundedConflict },
  ]);
});

it("indexes an unknown handle in the original list and never repeats it in the message", () => {
  const error = refusal(() =>
    resolveNormalizationOutput(
      { requirements: [cited("a", ["E1", "E1", "E99"])], conflicts: [], openQuestions: [] },
      catalog,
    ),
  );
  expect(error.issues).toHaveLength(1);
  expect(error.issues[0]?.path).toBe("/requirements/0/evidenceIds/2");
  expect(error.issues[0]?.message).not.toContain("E99");
  expect(error.message).not.toContain("E99");
});

it("reports an unknown handle of a reconciliation answer at the conflict and handle position", () => {
  const error = refusal(() =>
    resolveConflictOutput(
      {
        conflicts: [
          { keys: ["a", "b"], reason: "Disagree", evidenceIds: ["E1", "E2"] },
          { keys: ["a", "b"], reason: "Disagree", evidenceIds: ["E1", "E99"] },
        ],
        openQuestions: [],
      },
      catalog,
    ),
  );
  expect(error).toMatchObject({ code: "INVALID_ARGUMENT", message: ungroundedConflict });
  expect(error.issues).toEqual([
    { path: "/conflicts/1/evidenceIds/1", rule: "evidenceGrounding", message: ungroundedConflict },
  ]);
});

it("resolves grounded handles to the supplied refs", () => {
  const resolved = resolveConflictOutput(
    {
      conflicts: [{ keys: ["a", "b"], reason: "Disagree", evidenceIds: ["E1", "E2", "E1"] }],
      openQuestions: ["Which one?"],
    },
    catalog,
  );
  expect(resolved.conflicts[0]?.sourceRefs).toEqual([first, second]);
  expect(resolved.openQuestions).toEqual(["Which one?"]);
});

it("reports a duplicate requirement key at the repeated requirement", () => {
  const error = refusal(() =>
    validateNormalization(state([requirement("a"), requirement("a")]), catalog.refs),
  );
  expect(error.issues).toEqual([
    {
      path: "/requirements/1/key",
      rule: "requirementKey",
      message: "Duplicate normalized requirement key",
    },
  ]);
});

it("reports an inferred requirement without confidence", () => {
  const error = refusal(() =>
    validateNormalization(
      state([requirement("a", { originKind: "inferred", confidence: null })]),
      catalog.refs,
    ),
  );
  expect(error.issues).toEqual([
    {
      path: "/requirements/0",
      rule: "inferenceBasis",
      message: "Inference requires confidence and reason",
    },
  ]);
});

it("reports a conflict that names an unknown requirement key", () => {
  const error = refusal(() =>
    validateNormalization(
      state([requirement("a")], [conflict(["a", "missing"], [first, second])]),
      catalog.refs,
    ),
  );
  expect(error.issues).toEqual([
    {
      path: "/conflicts/0/keys",
      rule: "conflictKeys",
      message: "Conflict references an unknown requirement",
    },
  ]);
});

it("reports a conflict that cites one source revision only", () => {
  const error = refusal(() =>
    validateNormalization(
      state([requirement("a"), requirement("b")], [conflict(["a", "b"], [first])]),
      catalog.refs,
    ),
  );
  expect(error).toMatchObject({
    code: "INVALID_ARGUMENT",
    message: "Conflict must preserve both source revisions",
  });
  expect(error.issues).toEqual([
    {
      path: "/conflicts/0/evidenceIds",
      rule: "conflictRevisions",
      message: "Conflict must preserve both source revisions",
    },
  ]);
});

it("reports every failing item and takes the error message from the first issue", () => {
  const outside: SourceEvidenceRef = { sourceRevisionId: "rev-c", contentHash: "hash-c" };
  const error = refusal(() =>
    validateNormalization(
      state(
        [requirement("a", { sourceRefs: [outside] }), requirement("a")],
        [conflict(["a", "missing"], [first, second])],
      ),
      catalog.refs,
    ),
  );
  expect(error.issues.map(({ path, rule }) => ({ path, rule }))).toEqual([
    { path: "/requirements/0/evidenceIds", rule: "evidenceGrounding" },
    { path: "/requirements/1/key", rule: "requirementKey" },
    { path: "/conflicts/0/keys", rule: "conflictKeys" },
  ]);
  expect(error.message).toBe(ungroundedRequirement);
  expect(error.details).toEqual({});
});

it("accepts a grounded state and returns it", () => {
  const grounded = state(
    [requirement("a"), requirement("b", { sourceRefs: [second] })],
    [conflict(["a", "b"], [first, second])],
  );
  expect(validateNormalization(grounded, catalog.refs)).toBe(grounded);
});
