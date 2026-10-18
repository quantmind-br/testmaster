import { describe, expect, it } from "vitest";
import { ContractError, type ValidationIssue } from "./registries.js";
import { validate, validateDocument } from "./validation.js";

type Json = Record<string, unknown>;
const create = (resource: Json | undefined, extra: Json = {}): Json => ({
  id: "create",
  kind: "action",
  operation: "request",
  description: "Create the item",
  input: {
    method: "POST",
    pathSegments: [{ literal: "items" }],
    ...(resource
      ? { resource: { resourceType: "item", correlationKey: { literal: "k" }, ...resource } }
      : {}),
    ...extra,
  },
});
const read = (): Json => ({
  id: "read",
  kind: "action",
  operation: "request",
  description: "Read the item",
  input: {
    method: "GET",
    pathSegments: [{ literal: "items" }, { variableRef: "create.handle" }],
  },
});
const status: Json = {
  id: "status",
  kind: "assertion",
  operation: "assert",
  description: "Created",
  input: { responseStepId: "create" },
  expectation: { predicate: "statusIn", values: [201] },
};
const cleanup = (resourceRef = "create"): Json => ({
  resourceRef,
  operation: "request",
  input: {
    method: "DELETE",
    pathSegments: [{ literal: "items" }, { variableRef: "create.handle" }],
  },
  successPredicate: { predicate: "statusIn", values: [204] },
  deadlineMs: 1000,
  required: true,
});
const plan = (steps: Json[], extra: Json = {}): Json => ({
  schemaVersion: "1.0.0",
  kind: "executable",
  name: "Item",
  type: "backend",
  runner: "http",
  requirementRefs: [],
  steps,
  ...extra,
});
const refusal = (document: unknown): ContractError | undefined => {
  try {
    validateDocument("ExecutablePlan", document);
    return undefined;
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    return error;
  }
};
const issuesOf = (document: unknown): ValidationIssue[] => refusal(document)?.issues ?? [];

describe("cleanup the runner can never perform", () => {
  it("validateDocument refuses a cleanup whose resource lacks ownerProof", () => {
    const handleOnly = plan([create({ handle: "/id" }), status], { cleanup: [cleanup()] });
    const error = refusal(handleOnly);
    expect(error).toMatchObject({
      code: "INVALID_ARGUMENT",
      details: expect.objectContaining({ reasonCode: "cleanup_never_runs" }),
    });
    expect(error?.issues).toEqual([
      expect.objectContaining({ path: "/steps/0/input/resource", rule: "cleanupResource" }),
    ]);
    expect(error?.message).toContain("input.resource lacks ownerProof");
    // The schema and semantic checks alone accept it: the rule is an authoring check.
    expect(() => validate("ExecutablePlan", handleOnly)).not.toThrow();
  });
  it("names both missing pointers and accepts a resource that declares both", () => {
    const bare = plan([create({}), status], { cleanup: [cleanup()] });
    expect(refusal(bare)?.message).toContain("lacks handle and ownerProof");
    const complete = plan([create({ handle: "/id", ownerProof: "/owner" }), status], {
      cleanup: [cleanup()],
    });
    expect(refusal(complete)).toBeUndefined();
  });
  it("refuses a cleanup naming a step that declares no resource, at the resourceRef", () => {
    // A literal path: a reference to create.handle would already be refused as undeclared.
    const literal = {
      ...cleanup(),
      input: { method: "DELETE", pathSegments: [{ literal: "items" }] },
    };
    const document = plan([create(undefined), status], { cleanup: [literal] });
    expect(refusal(document)?.details).toMatchObject({ reasonCode: "cleanup_never_runs" });
    expect(issuesOf(document)).toEqual([
      expect.objectContaining({ path: "/cleanup/0/resourceRef", rule: "cleanupResource" }),
    ]);
  });
});

describe("a resource handle reference", () => {
  it("is refused when the resource declares a handle without ownerProof", () => {
    const document = plan([create({ handle: "/id" }), read(), status]);
    const error = refusal(document);
    expect(error?.details).toMatchObject({ reasonCode: "handle_not_captured" });
    expect(error?.issues).toEqual([
      expect.objectContaining({
        path: "/steps/1/input/pathSegments/1/variableRef",
        rule: "binding",
      }),
    ]);
    expect(error?.message).toContain(
      "only when its input.resource declares both handle and ownerProof",
    );
    // A stored plan keeps loading: the check every read path runs accepts it.
    expect(() => validate("ExecutablePlan", document)).not.toThrow();
  });
  it("is refused when the resource declares neither pointer", () => {
    expect(issuesOf(plan([create({}), read(), status]))).toEqual([
      expect.objectContaining({ path: "/steps/1/input/pathSegments/1/variableRef" }),
    ]);
  });
  it("is accepted with both pointers, or with a capture named handle on the same step", () => {
    expect(
      refusal(plan([create({ handle: "/id", ownerProof: "/owner" }), read(), status])),
    ).toBeUndefined();
    const captured = create(
      { handle: "/id" },
      {
        capture: [
          {
            name: "handle",
            from: "jsonPointer",
            pointer: "/id",
            valueType: "string",
            sensitive: false,
          },
        ],
      },
    );
    expect(refusal(plan([captured, read(), status]))).toBeUndefined();
  });
});
