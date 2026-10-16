import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ExecutablePlan } from "@testmaster/contracts";
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

type Step = ExecutablePlan["steps"][number];
const assertion = (id: string, input: Record<string, unknown>, expectation: unknown): Step =>
  ({
    id,
    kind: "assertion",
    operation: "assert",
    description: id,
    required: true,
    input,
    expectation,
  }) as Step;
// The real generated login test: it passed on a blank page because it asserted only the URL and
// the absence of the login fields.
const loginPlan = async (after: Step[]): Promise<ExecutablePlan> => {
  const plan = (await fixture("frontend")) as ExecutablePlan;
  return { ...plan, steps: [...plan.steps.filter((step) => step.kind === "action"), ...after] };
};
const urlOnly = [
  assertion(
    "url",
    { url: "/dashboard" },
    { predicate: "urlEquals", value: { literal: "/dashboard" } },
  ),
  assertion("gone", { locator: { by: "label", value: "Password" } }, { predicate: "hidden" }),
];

it("refuses a browser plan that acts and then asserts only the URL and the absence of elements", async () => {
  const plan = await loginPlan(urlOnly);
  expect(() => validateProposalPlan(plan)).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
      details: { reasonCode: "browser_postcondition_missing" },
    }),
  );
  const catalog = new EvidenceCatalog([
    {
      sourceRevisionId: "svr_01900000-0000-7000-8000-000000000001",
      contentHash: `sha256:${"a".repeat(64)}`,
    },
  ]);
  const id = requirementId();
  const inspected = inspectGeneratedProposals(
    { proposals: [{ plan, requirementRefs: [id], evidenceIds: ["E1"], warnings: [] }] },
    [id],
    catalog,
  );
  expect(inspected.refused.map(({ reasonCode }) => reasonCode)).toEqual([
    "browser_postcondition_missing",
  ]);
});

it("accepts a browser plan whose last action is followed by a positive assertion on rendered content", async () => {
  const heading = { by: "role", role: "heading", name: "Dashboard", exact: true };
  for (const positive of [
    assertion("heading", { locator: heading }, { predicate: "visible" }),
    assertion(
      "greeting",
      { locator: heading },
      { predicate: "textContains", value: { literal: "Dashboard" } },
    ),
    assertion("rows", { locator: heading }, { predicate: "countEquals", value: 1 }),
  ])
    expect(
      validateProposalPlan(await loginPlan([...urlOnly.slice(0, 1), positive, ...urlOnly.slice(1)]))
        .runner,
    ).toBe("playwright");
  // Negative controls: a positive assertion before the last action, an optional one and an empty
  // count do not observe the final page.
  const early = await loginPlan(urlOnly);
  early.steps = [
    assertion("early", { locator: heading }, { predicate: "visible" }),
    ...early.steps,
  ];
  const optional = assertion("heading", { locator: heading }, { predicate: "visible" });
  optional.required = false;
  for (const weak of [
    early,
    await loginPlan([...urlOnly, optional]),
    await loginPlan([
      ...urlOnly,
      assertion("none", { locator: heading }, { predicate: "countEquals", value: 0 }),
    ]),
  ])
    expect(() => validateProposalPlan(weak)).toThrow(
      expect.objectContaining({ details: { reasonCode: "browser_postcondition_missing" } }),
    );
});

it("refuses a browser plan whose absence checks run before any positive check of the page", async () => {
  const heading = { by: "role", role: "heading", name: "Dashboard", exact: true };
  const positive = assertion("heading", { locator: heading }, { predicate: "visible" });
  // The real generated login plan: URL, fields gone, then the authenticated UI.
  const vacuous = await loginPlan([...urlOnly, positive]);
  expect(() => validateProposalPlan(vacuous)).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
      details: expect.objectContaining({ reasonCode: "negative_before_render" }),
      issues: [
        expect.objectContaining({ rule: "negativeBeforeRender", path: "/steps/3/expectation" }),
      ],
    }),
  );
  const id = requirementId();
  const inspected = inspectGeneratedProposals(
    { proposals: [{ plan: vacuous, requirementRefs: [id], evidenceIds: ["E1"], warnings: [] }] },
    [id],
    new EvidenceCatalog([
      {
        sourceRevisionId: "svr_01900000-0000-7000-8000-000000000001",
        contentHash: `sha256:${"a".repeat(64)}`,
      },
    ]),
  );
  expect(inspected.refused.map(({ reasonCode }) => reasonCode)).toEqual(["negative_before_render"]);
  // Positive control: the check of the page first.
  const settled = await loginPlan([...urlOnly.slice(0, 1), positive, ...urlOnly.slice(1)]);
  expect(validateProposalPlan(settled).runner).toBe("playwright");
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
