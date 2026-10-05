import { type Static, type TSchema, Type } from "@sinclair/typebox";
import {
  ContentDigest,
  Description,
  Enum,
  EvidenceRef,
  id,
  Json,
  JsonPointer,
  Name,
  Nonnegative,
  Obj,
  Positive,
  Priority,
  RelativePath,
  Risk,
  Value,
} from "./primitives.js";

export const Locator = Type.Recursive((Self) => {
  const scope = {
    container: Type.Optional(Self),
    frame: Type.Optional(Self),
    pageAlias: Type.Optional(Name),
  };
  return Type.Union([
    Obj({ by: Type.Literal("testId"), value: Name, ...scope }),
    Obj({
      by: Type.Literal("role"),
      role: Name,
      name: Type.Optional(Name),
      exact: Type.Optional(Type.Boolean()),
      ...scope,
    }),
    Obj({
      by: Enum(["label", "text", "placeholder"]),
      value: Name,
      exact: Type.Optional(Type.Boolean()),
      ...scope,
    }),
    Obj({ by: Type.Literal("css"), value: Name, ...scope }),
  ]);
});
const valuePredicate = <P extends string>(predicate: P) =>
  Obj({ predicate: Type.Literal(predicate), value: Value });
export const Expectation = Type.Union([
  ...(["visible", "hidden", "enabled"] as const).map((predicate) =>
    Obj({ predicate: Type.Literal(predicate) }),
  ),
  ...(["textEquals", "textContains", "valueEquals", "urlEquals", "jsonEquals"] as const).map(
    valuePredicate,
  ),
  Obj({ predicate: Type.Literal("countEquals"), value: Nonnegative }),
  Obj({
    predicate: Type.Literal("statusIn"),
    values: Type.Array(Type.Integer({ minimum: 100, maximum: 599 }), {
      minItems: 1,
      uniqueItems: true,
    }),
  }),
  Obj({ predicate: Type.Literal("headerEquals"), header: Name, value: Value }),
  Obj({ predicate: Type.Literal("jsonSchema"), sourceRevisionId: id("svr"), pointer: JsonPointer }),
  Obj({
    predicate: Type.Literal("downloadMatches"),
    outputName: Name,
    sha256: Type.Optional(ContentDigest),
    mimeType: Type.Optional(Name),
    sizeBytes: Type.Optional(Nonnegative),
  }),
  Obj({
    predicate: Type.Literal("visualMatches"),
    baselineId: id("vbl"),
    threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  }),
  Obj({ predicate: Type.Literal("accessibilityViolations"), maximum: Nonnegative }),
]);
export const Capture = Type.Union([
  Obj({
    name: Name,
    from: Type.Literal("jsonPointer"),
    pointer: JsonPointer,
    valueType: Enum(["string", "number", "boolean", "object", "array", "null"]),
    sensitive: Type.Boolean(),
  }),
  Obj({
    name: Name,
    from: Type.Literal("header"),
    header: Name,
    valueType: Enum(["string", "number", "boolean"]),
    sensitive: Type.Boolean(),
  }),
]);
export const RequestInput = Obj({
  method: Enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  pathSegments: Type.Array(Value),
  query: Type.Optional(Type.Array(Obj({ name: Value, value: Value }))),
  headers: Type.Optional(
    Type.Record(Type.String({ pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$" }), Value),
  ),
  body: Type.Optional(
    Type.Union([
      Obj({ kind: Type.Literal("json"), value: Value }),
      Obj({ kind: Type.Literal("text"), value: Value }),
      Obj({ kind: Type.Literal("form"), fields: Type.Array(Obj({ name: Value, value: Value })) }),
      Obj({ kind: Type.Literal("artifact"), artifactRef: id("art"), mimeType: Name }),
    ]),
  ),
  capture: Type.Optional(Type.Array(Capture)),
  resource: Type.Optional(
    Obj({
      resourceType: Name,
      correlationKey: Value,
      handle: Type.Optional(JsonPointer),
      ownerProof: Type.Optional(JsonPointer),
    }),
  ),
});
const common = {
  id: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
  description: Description,
  required: Type.Optional(Type.Boolean({ default: true })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, default: 30000 })),
  risk: Type.Optional(Risk),
};
const action = <O extends string, I extends TSchema>(operation: O, input: I) =>
  Obj({ ...common, kind: Type.Literal("action"), operation: Type.Literal(operation), input });
const locatorInput = Obj({ locator: Locator });
export const Step = Type.Recursive((Self) =>
  Type.Union([
    action(
      "navigate",
      Obj({
        path: Type.String({ minLength: 1 }),
        readiness: Type.Optional(Enum(["load", "domcontentloaded", "networkidle"])),
      }),
    ),
    ...(["click", "hover", "check", "uncheck"] as const).map((op) =>
      action(
        op,
        Obj({
          locator: Locator,
          button: Type.Optional(Enum(["left", "middle", "right"])),
          modifiers: Type.Optional(Type.Array(Enum(["Alt", "Control", "Meta", "Shift"]))),
        }),
      ),
    ),
    action("fill", Obj({ locator: Locator, value: Value })),
    action("press", Obj({ locator: Locator, key: Name })),
    action(
      "select",
      Obj({
        locator: Locator,
        values: Type.Array(
          Type.Union([Obj({ value: Value }), Obj({ label: Value }), Obj({ index: Nonnegative })]),
          { minItems: 1 },
        ),
      }),
    ),
    action("drag", Obj({ source: Locator, destination: Locator })),
    action(
      "upload",
      Obj({ locator: Locator, artifactRefs: Type.Array(id("art"), { minItems: 1 }) }),
    ),
    action(
      "download",
      Obj({
        trigger: Obj({ operation: Type.Literal("click"), input: locatorInput }),
        outputName: Name,
      }),
    ),
    action("switchPage", Obj({ pageAlias: Name })),
    action(
      "frame",
      Obj({ locator: Locator, childSteps: Type.Array(Self, { minItems: 1, maxItems: 200 }) }),
    ),
    action(
      "waitFor",
      Type.Union([
        Obj({
          locator: Locator,
          state: Enum(["attached", "detached", "visible", "hidden"]),
          deadlineMs: Positive,
        }),
        Obj({
          response: Obj({
            url: Name,
            status: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
          }),
          deadlineMs: Positive,
        }),
      ]),
    ),
    action("request", RequestInput),
    Obj({
      ...common,
      kind: Type.Literal("assertion"),
      operation: Type.Literal("assert"),
      input: Type.Union([
        Obj({ locator: Locator }),
        Obj({ pageAlias: Type.Optional(Name), url: Type.Optional(Type.String()) }),
        Obj({ responseStepId: Name, jsonPointer: Type.Optional(JsonPointer) }),
        Obj({ outputName: Name }),
      ]),
      expectation: Expectation,
    }),
  ]),
);
export const DependencyBinding = Obj({
  producerTestId: id("tst"),
  producerRevisionId: Type.Optional(id("rev")),
  producerCell: Type.Optional(Json),
  outputName: Name,
  consumerInput: Name,
  type: Enum(["string", "number", "boolean", "object", "array", "null"]),
  required: Type.Boolean(),
  sensitive: Type.Boolean(),
  maximumAge: Positive,
  permittedEnvironment: id("env"),
});
export const Cleanup = Obj({
  resourceRef: Name,
  operation: Type.Literal("request"),
  input: RequestInput,
  successPredicate: Expectation,
  deadlineMs: Positive,
  required: Type.Boolean(),
});
export const ExecutablePlan = Obj({
  schemaVersion: Type.Literal("1.0.0"),
  kind: Type.Literal("executable"),
  name: Name,
  type: Enum(["frontend", "backend", "integration"]),
  runner: Enum(["playwright", "http"]),
  requirementRefs: Type.Array(id("req")),
  steps: Type.Array(Step, { minItems: 1, maxItems: 200 }),
  dependsOn: Type.Optional(Type.Array(DependencyBinding, { maxItems: 100 })),
  cleanup: Type.Optional(Type.Array(Cleanup)),
  tags: Type.Optional(Type.Array(Name)),
  priority: Type.Optional(Priority),
});
export type ExecutablePlan = Static<typeof ExecutablePlan>;
export type PlanStep = Static<typeof Step>;
export const IntentPlan = Obj({
  schemaVersion: Type.Literal("1.0.0"),
  kind: Type.Literal("intent"),
  name: Name,
  type: Enum(["frontend", "backend", "integration"]),
  requirementRefs: Type.Array(id("req")),
  description: Description,
  acceptanceCriteria: Type.Array(Description, { minItems: 1 }),
  evidenceRefs: Type.Optional(Type.Array(EvidenceRef)),
});
export const CodeReference = Obj({
  artifactId: id("art"),
  contentHash: ContentDigest,
  language: Enum(["typescript", "python"]),
  framework: Enum(["playwright-test", "playwright-sync", "playwright-async", "pytest", "requests"]),
  entrypoint: RelativePath,
  dependencyLockRef: id("art"),
  runnerCapabilityVersion: Name,
  trustLevel: Enum(["imported", "generated", "trusted"]),
});
export const TestRevisionInput = Type.Union([
  Obj({
    plan: ExecutablePlan,
    parentId: Type.Optional(id("rev")),
    origin: Enum(["manual", "generated", "healed", "imported"]),
  }),
  Obj({
    codeRef: CodeReference,
    parentId: Type.Optional(id("rev")),
    origin: Enum(["manual", "generated", "healed", "imported"]),
  }),
]);
export type IntentPlan = Static<typeof IntentPlan>;
export type CodeReference = Static<typeof CodeReference>;
export type TestRevisionInput = Static<typeof TestRevisionInput>;
export type DependencyBinding = Static<typeof DependencyBinding>;
export type Locator = Static<typeof Locator>;
export type Expectation = Static<typeof Expectation>;
