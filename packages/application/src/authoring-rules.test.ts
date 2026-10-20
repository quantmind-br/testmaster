import { readFileSync } from "node:fs";
import {
  ContractError,
  type ExecutablePlan,
  type ValidationIssue,
  validate,
  validateDocument,
} from "@testmaster/contracts";
import { validateProposalPlan } from "@testmaster/planner";
import { describe, expect, it } from "vitest";
import { lintPlan } from "./authoring.js";

type Step = ExecutablePlan["steps"][number];
type Json = Record<string, unknown>;

const fixture = (name: string): ExecutablePlan =>
  JSON.parse(
    readFileSync(new URL(`../../contracts/fixtures/valid/${name}.json`, import.meta.url), "utf8"),
  ).value;

const assertion = (id: string, input: Json, expectation: Json): Step =>
  ({
    id,
    kind: "assertion",
    operation: "assert",
    description: id,
    required: true,
    input,
    expectation,
  }) as Step;

const loginPlan = (after: Step[]): ExecutablePlan => {
  const plan = fixture("frontend");
  return { ...plan, steps: [...plan.steps.filter((step) => step.kind === "action"), ...after] };
};
const url = assertion(
  "url",
  { url: "/dashboard" },
  { predicate: "urlEquals", value: { literal: "/dashboard" } },
);
const gone = assertion(
  "gone",
  { locator: { by: "label", value: "Password" } },
  { predicate: "hidden" },
);
const heading = assertion(
  "heading",
  { locator: { by: "role", role: "heading", name: "Dashboard", exact: true } },
  { predicate: "visible" },
);

const create = (resource?: Json): Step =>
  ({
    id: "create",
    kind: "action",
    operation: "request",
    description: "Create the item",
    required: true,
    input: {
      method: "POST",
      pathSegments: [{ literal: "items" }],
      ...(resource
        ? { resource: { resourceType: "item", correlationKey: { literal: "k" }, ...resource } }
        : {}),
    },
  }) as Step;
const read: Step = {
  id: "read",
  kind: "action",
  operation: "request",
  description: "Read the item",
  required: true,
  input: {
    method: "GET",
    pathSegments: [{ literal: "items" }, { variableRef: "create.handle" }],
  },
} as Step;
const withSteps = (extra: Step[], cleanup?: Json[]): ExecutablePlan => {
  const plan = fixture("backend");
  return {
    ...plan,
    steps: [...plan.steps, ...extra],
    ...(cleanup ? { cleanup } : {}),
  } as ExecutablePlan;
};
const cleanupOf = (resourceRef: string): Json => ({
  resourceRef,
  operation: "request",
  input: { method: "DELETE", pathSegments: [{ literal: "items" }] },
  successPredicate: { predicate: "statusIn", values: [204] },
  deadlineMs: 1000,
  required: true,
});

interface Row {
  name: string;
  defective: ExecutablePlan;
  control: ExecutablePlan;
  reasonCode: string;
  issue: Pick<ValidationIssue, "rule" | "path">;
}
const rows: Row[] = [
  {
    name: "negative_before_render",
    defective: loginPlan([url, gone, heading]),
    control: loginPlan([url, heading, gone]),
    reasonCode: "negative_before_render",
    issue: { rule: "negativeBeforeRender", path: "/steps/3/expectation" },
  },
  {
    name: "cleanup_never_runs",
    defective: withSteps([create()], [cleanupOf("create")]),
    control: withSteps([create({ handle: "/id", ownerProof: "/owner" })], [cleanupOf("create")]),
    reasonCode: "cleanup_never_runs",
    issue: { rule: "cleanupResource", path: "/cleanup/0/resourceRef" },
  },
  {
    name: "handle_not_captured",
    defective: withSteps([create({ handle: "/id" }), read]),
    control: withSteps([create({ handle: "/id", ownerProof: "/owner" }), read]),
    reasonCode: "handle_not_captured",
    issue: { rule: "binding", path: "/steps/4/input/pathSegments/1/variableRef" },
  },
];

const entryPoints: Record<string, (plan: ExecutablePlan) => unknown> = {
  validateDocument: (plan) => validateDocument("ExecutablePlan", plan),
  lintPlan: (plan) => lintPlan(JSON.stringify(plan)),
  validateProposalPlan: (plan) => validateProposalPlan(plan),
};

const refusal = (run: () => unknown): ContractError => {
  try {
    run();
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw error;
  }
  throw new Error("expected the plan to be refused");
};

describe.each(rows)("authoring rule $name", (row) => {
  it("is accepted by the schema and semantic check every stored plan passes", () => {
    expect(() => validate("ExecutablePlan", row.defective)).not.toThrow();
  });
  it.each(Object.keys(entryPoints))("is refused by %s with its own reason and issue", (entry) => {
    const error = refusal(() => entryPoints[entry]?.(row.defective));
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(error.details).toMatchObject({ reasonCode: row.reasonCode });
    expect(error.issues).toEqual([expect.objectContaining(row.issue)]);
  });
  it.each(Object.keys(entryPoints))("passes %s once the defect is removed", (entry) => {
    expect(() => entryPoints[entry]?.(row.control)).not.toThrow();
  });
});
