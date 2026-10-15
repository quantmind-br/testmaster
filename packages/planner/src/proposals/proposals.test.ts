import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { EvidenceCatalog } from "../sources/evidence.js";
import {
  inspectGeneratedProposals,
  resolveGeneratedProposals,
  validateProposalPlan,
} from "./index.js";

async function fixture(name: string): Promise<unknown> {
  const bytes = await readFile(
    new URL(`../../../contracts/fixtures/valid/${name}.json`, import.meta.url),
    "utf8",
  );
  return JSON.parse(bytes).value;
}

it("refuses terminal plans as proposals, edits or refinements before judging their assertions", async () => {
  const plan = await fixture("cli");
  expect(() => validateProposalPlan(plan)).toThrow(
    expect.objectContaining({
      code: "CAPABILITY_UNAVAILABLE",
      message:
        "Terminal plans cannot be generated, edited or refined as proposals; author them as executable plans",
    }),
  );
  // Positive control: an HTTP plan with a business assertion is still accepted.
  expect(validateProposalPlan(await fixture("backend")).runner).toBe("http");
});

const requirementId = () => `req_${randomUUID()}`;

it("accepts a model output that declines every requirement and keeps the reasons", () => {
  const [first, second] = [requirementId(), requirementId()];
  const resolved = resolveGeneratedProposals(
    {
      proposals: [],
      unsupported: [
        { requirementId: first, reason: "exit status of a CLI command" },
        { requirementId: second, reason: "terminal UI startup" },
      ],
    },
    [first, second],
    new EvidenceCatalog([]),
  );
  expect(resolved.proposals).toEqual([]);
  expect(resolved.unsupported.map((item) => item.requirementId)).toEqual([first, second]);
  // Negative control: an output that neither proposes nor declines anything is refused.
  expect(() =>
    resolveGeneratedProposals({ proposals: [] }, [first], new EvidenceCatalog([])),
  ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
});

it("rejects declines that are unselected, repeated or shaped outside the schema", () => {
  const [selected, other] = [requirementId(), requirementId()];
  const resolve = (output: unknown) =>
    resolveGeneratedProposals(output, [selected], new EvidenceCatalog([]));
  const decline = (id: string) => ({ requirementId: id, reason: "not observable" });
  expect(resolve({ proposals: [], unsupported: [decline(selected)] }).unsupported).toHaveLength(1);
  expect(() => resolve({ proposals: [], unsupported: [decline(other)] })).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
      message: "A declined requirement is not a selected one",
    }),
  );
  expect(() =>
    resolve({ proposals: [], unsupported: [decline(selected), decline(selected)] }),
  ).toThrow(expect.objectContaining({ message: "A requirement is declined more than once" }));
  expect(() =>
    resolve({ proposals: [], unsupported: [{ requirementId: selected, reason: "" }] }),
  ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  expect(() => resolve({ error: "cannot generate" })).toThrow(
    expect.objectContaining({ code: "INVALID_ARGUMENT" }),
  );
});

it("keeps terminal plans out of the model-facing proposal schema even next to a decline", async () => {
  const id = requirementId();
  const terminal = await fixture("cli");
  expect(() =>
    resolveGeneratedProposals(
      {
        proposals: [{ plan: terminal, requirementRefs: [id], evidenceIds: ["E1"], warnings: [] }],
        unsupported: [],
      },
      [id],
      new EvidenceCatalog([]),
    ),
  ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
});

it("inspection collects every refused proposal with its position and reason instead of stopping at the first", async () => {
  const [first, second] = [requirementId(), requirementId()];
  const plan = await fixture("backend");
  const proposal = (id: string, evidenceIds: string[]) => ({
    plan,
    requirementRefs: [id],
    evidenceIds,
    warnings: [],
  });
  const output = { proposals: [proposal(first, ["E9"]), proposal(second, ["E9"])] };
  const inspected = inspectGeneratedProposals(output, [first, second], new EvidenceCatalog([]));
  expect(inspected.accepted).toEqual([]);
  expect(
    inspected.refused.map(({ index, requirementIds, reasonCode }) => ({
      index,
      requirementIds,
      reasonCode,
    })),
  ).toEqual([
    { index: 0, requirementIds: [first], reasonCode: "evidence_not_grounded" },
    { index: 1, requirementIds: [second], reasonCode: "evidence_not_grounded" },
  ]);
  // The throwing entry point keeps its behavior: the first refusal rejects the output.
  expect(() => resolveGeneratedProposals(output, [first, second], new EvidenceCatalog([]))).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
      message: "Proposal evidence is not grounded",
    }),
  );
});
