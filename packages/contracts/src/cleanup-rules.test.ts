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

const titleCapture = {
  capture: [
    {
      name: "title",
      from: "jsonPointer",
      pointer: "/title",
      valueType: "string",
      sensitive: false,
    },
  ],
};
const secretCapture = {
  capture: [
    {
      name: "secret",
      from: "jsonPointer",
      pointer: "/secret",
      valueType: "string",
      sensitive: true,
    },
  ],
};
const lookup = (extra: Json = {}): Json => ({
  method: "GET",
  pathSegments: [{ literal: "items" }],
  ...extra,
});
const findEntry = (find: Json = {}, resourceRef = "create"): Json => ({
  ...cleanup(resourceRef),
  find: {
    resourceType: "item",
    lookup: lookup(),
    itemsPointer: "/items",
    keyPointer: "/name",
    equals: { variableRef: "create.title" },
    handlePointer: "/id",
    ownerProofPointer: "/owner",
    ...find,
  },
});
const findPlan = (entry: Json, createStep: Json = create(undefined, titleCapture)): Json =>
  plan([createStep, status], { cleanup: [entry] });

describe("cleanup by lookup", () => {
  it("accepts a lookup entry for a step that declares no resource, with a literal or captured key", () => {
    expect(refusal(findPlan(findEntry()))).toBeUndefined();
    expect(refusal(findPlan(findEntry({ equals: { literal: "Run 42" } })))).toBeUndefined();
    expect(() => validate("ExecutablePlan", findPlan(findEntry()))).not.toThrow();
  });
  it("refuses a resourceRef that is no step, or a request that already declares its own resource", () => {
    const unknown = findPlan({
      ...findEntry({}, "missing"),
      input: {
        method: "DELETE",
        pathSegments: [{ literal: "items" }, { variableRef: "missing.handle" }],
      },
    });
    expect(refusal(unknown)?.details).toMatchObject({ reasonCode: "cleanup_never_runs" });
    expect(issuesOf(unknown)).toContainEqual(
      expect.objectContaining({ path: "/cleanup/0/resourceRef", rule: "cleanupResource" }),
    );
    const declared = findPlan(
      findEntry(),
      create({ handle: "/id", ownerProof: "/owner" }, titleCapture),
    );
    expect(refusal(declared)?.details).toMatchObject({ reasonCode: "cleanup_never_runs" });
    expect(issuesOf(declared)).toContainEqual(
      expect.objectContaining({ path: "/cleanup/0/resourceRef", rule: "cleanupResource" }),
    );
  });
  it("refuses two entries for the same step", () => {
    const document = plan([create(undefined, titleCapture), status], {
      cleanup: [findEntry(), findEntry()],
    });
    expect(refusal(document)?.details).toMatchObject({ reasonCode: "cleanup_never_runs" });
  });
  it("refuses a lookup that is not a GET, or that carries a body, capture or resource", () => {
    for (const [field, extra] of [
      ["method", { method: "POST" }],
      ["method", { method: "DELETE" }],
      ["body", { body: { kind: "text", value: { literal: "x" } } }],
      ["capture", titleCapture],
      ["resource", { resource: { resourceType: "item", correlationKey: { literal: "k" } } }],
    ] as const) {
      const document = findPlan(findEntry({ lookup: lookup(extra) }));
      expect(() => validate("ExecutablePlan", document), field).toThrow();
      expect(issuesOf(document), field).toContainEqual(
        expect.objectContaining({
          path: `/cleanup/0/find/lookup/${field}`,
          rule: "cleanupFind",
        }),
      );
    }
  });
  it("refuses a variableRef no step captured, and one that is the id the lookup finds", () => {
    const uncaptured = findPlan(findEntry({ equals: { variableRef: "nobody.title" } }));
    expect(issuesOf(uncaptured)).toContainEqual(
      expect.objectContaining({ path: "/cleanup/0/find/equals/variableRef", rule: "binding" }),
    );
    const inLookup = findPlan(
      findEntry({
        lookup: lookup({ query: [{ name: { literal: "q" }, value: { variableRef: "ghost" } }] }),
      }),
    );
    expect(issuesOf(inLookup)).toContainEqual(
      expect.objectContaining({
        path: "/cleanup/0/find/lookup/query/0/value/variableRef",
        rule: "binding",
      }),
    );
    const ownHandle = findPlan(findEntry({ equals: { variableRef: "create.handle" } }));
    expect(() => validate("ExecutablePlan", ownHandle)).toThrow();
    expect(issuesOf(ownHandle)).toContainEqual(
      expect.objectContaining({ path: "/cleanup/0/find/equals/variableRef", rule: "binding" }),
    );
  });
  it("refuses a sensitive key value", () => {
    const document = findPlan(
      findEntry({ equals: { variableRef: "create.secret" } }),
      create(undefined, secretCapture),
    );
    expect(() => validate("ExecutablePlan", document)).toThrow();
    expect(issuesOf(document)).toContainEqual(
      expect.objectContaining({
        path: "/cleanup/0/find/equals/variableRef",
        rule: "cleanupFind",
      }),
    );
  });
  it("refuses a pointer that is not an RFC 6901 pointer, and one that names the item itself", () => {
    for (const bad of [
      { itemsPointer: "items" },
      { keyPointer: "name" },
      { handlePointer: "id" },
      { ownerProofPointer: "owner" },
      { totalPointer: "total" },
    ])
      expect(
        () => validate("ExecutablePlan", findPlan(findEntry(bad))),
        JSON.stringify(bad),
      ).toThrow();
    const whole = findPlan(findEntry({ handlePointer: "" }));
    expect(issuesOf(whole)).toContainEqual(
      expect.objectContaining({ path: "/cleanup/0/find/handlePointer", rule: "cleanupFind" }),
    );
  });
});
