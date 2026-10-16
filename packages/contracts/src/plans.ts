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
/** Longest `headerMatches` or `urlMatches` pattern: it bounds the plan text the runner compiles. */
export const patternMaxLength = 512;
/** RFC 6265 cookie-name token. */
const CookieName = Type.String({ pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$", maxLength: 200 });
/** Request headers that take the token form of an invalid credential (`scheme` optional). */
export const invalidCredentialTokenHeaders = ["authorization", "x-api-key", "api-key"] as const;
/** The one request header that takes the cookie form of an invalid credential. */
export const invalidCredentialCookieHeader = "cookie";
/**
 * A credential the target must reject, for negative authentication tests: the runner sends a
 * fresh random value, so no real secret is needed. Only request header values accept it, in one
 * form: `scheme` (token form, `<scheme> <random>` or the bare random token when empty;
 * `Authorization`, `X-Api-Key`, `Api-Key`) or `cookie` (`<name>=<random>`; `Cookie` only).
 */
export const InvalidCredential = Obj({
  invalidCredential: Obj({
    scheme: Type.Optional(Type.String({ pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$", maxLength: 64 })),
    cookie: Type.Optional(CookieName),
  }),
});
const HeaderValue = Type.Union([Value, InvalidCredential]);
const valuePredicate = <P extends string>(predicate: P) =>
  Obj({ predicate: Type.Literal(predicate), value: Value });
/**
 * Predicates only the terminal runner executes. The plan validator refuses them in HTTP and
 * browser plans, so `ModelExpectation` leaves them out and a model is never offered one.
 */
export const terminalPredicateNames = [
  "textNotContains",
  "exitCodeIn",
  "noLingeringProcesses",
  "fileExists",
  "fileAbsent",
] as const;
const terminalExpectations = [
  ...(["noLingeringProcesses", "fileExists", "fileAbsent"] as const).map((predicate) =>
    Obj({ predicate: Type.Literal(predicate) }),
  ),
  Obj({
    predicate: Type.Literal("exitCodeIn"),
    values: Type.Array(Type.Integer({ minimum: 0, maximum: 255 }), {
      minItems: 1,
      uniqueItems: true,
    }),
  }),
  valuePredicate("textNotContains"),
];
const httpAndBrowserExpectations = [
  ...(["visible", "hidden", "enabled", "disabled"] as const).map((predicate) =>
    Obj({ predicate: Type.Literal(predicate) }),
  ),
  ...(["textEquals", "textContains", "valueEquals", "urlEquals", "jsonEquals"] as const).map(
    valuePredicate,
  ),
  /**
   * ECMAScript pattern (`u` flag, unanchored) tested against the page's full URL; the plan validator
   * compiles it. A negative lookahead states where the page must not be (`^(?!.*\/login)`).
   */
  Obj({
    predicate: Type.Literal("urlMatches"),
    pattern: Type.String({ minLength: 1, maxLength: patternMaxLength }),
  }),
  Obj({ predicate: Type.Literal("countEquals"), value: Nonnegative }),
  /** The observed count is at least `value`; `0` always passes, so the plan validator refuses it. */
  Obj({ predicate: Type.Literal("countAtLeast"), value: Nonnegative }),
  /** The observed count is at most `value`; `0` is an absence check, like `countEquals` 0. */
  Obj({ predicate: Type.Literal("countAtMost"), value: Nonnegative }),
  Obj({
    predicate: Type.Literal("statusIn"),
    values: Type.Array(Type.Integer({ minimum: 100, maximum: 599 }), {
      minItems: 1,
      uniqueItems: true,
    }),
  }),
  Obj({ predicate: Type.Literal("headerEquals"), header: Name, value: Value }),
  /** ECMAScript pattern (`u` flag, unanchored) tested against the response header; the plan validator compiles it. */
  Obj({
    predicate: Type.Literal("headerMatches"),
    header: Name,
    pattern: Type.String({ minLength: 1, maxLength: patternMaxLength }),
  }),
  /** No response of the request step (redirect hops included) sets a cookie with this name. */
  Obj({ predicate: Type.Literal("cookieAbsent"), name: CookieName }),
  Obj({ predicate: Type.Literal("jsonSchema"), sourceRevisionId: id("svr"), pointer: JsonPointer }),
  /**
   * The JSON value conforms to an inline JSON Schema (draft 2020-12) written from the approved
   * criteria: field types, value ranges, required fields, list item shape. The plan validator
   * compiles it with the source-schema validator and refuses a schema that states no keyword.
   */
  Obj({
    predicate: Type.Literal("jsonConforms"),
    schema: Type.Record(Type.String(), Json, { minProperties: 1 }),
  }),
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
];
export const Expectation = Type.Union([...httpAndBrowserExpectations, ...terminalExpectations]);
/** The expectations a model may propose: those an HTTP or browser plan can execute. */
export const ModelExpectation = Type.Union(httpAndBrowserExpectations);
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
    Type.Record(Type.String({ pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$" }), HeaderValue),
  ),
  /** `follow` (default) follows up to 10 redirects and reports the last response; `manual` reports the 3xx response itself. */
  redirect: Type.Optional(Enum(["follow", "manual"])),
  /**
   * `profile` sends the session of the environment's bound auth profile (cookies of its storage
   * state that match the request URL, or its header credential) with this request only. Absent
   * means no profile session.
   */
  auth: Type.Optional(Type.Literal("profile")),
  body: Type.Optional(
    Type.Union([
      Obj({
        kind: Type.Literal("json"),
        value: Value,
        /**
         * Values placed into the JSON document by RFC 6901 pointer after `value` is resolved:
         * the only way to put a `secretRef` or `variableRef` inside a JSON body, because a
         * `Value` nested in a literal is plain data.
         */
        set: Type.Optional(
          Type.Array(Obj({ pointer: JsonPointer, value: Value }), { maxItems: 100 }),
        ),
      }),
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
/** Named keys of the terminal runner; `Ctrl+<A-Z>` and `Alt+<A-Za-z0-9>` are matched by pattern. */
export const terminalNamedKeys = [
  "Enter",
  "Tab",
  "Shift+Tab",
  "Backspace",
  "Delete",
  "Escape",
  "Space",
  "Up",
  "Down",
  "Left",
  "Right",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Insert",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
] as const;
export const terminalSignals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGKILL"] as const;
/** Program run without an implicit shell: an imported fixture or an absolute path in the image. */
export const TerminalProgram = Type.Union([
  Obj({ artifactRef: id("art") }),
  Obj({ path: Type.String({ pattern: "^(?!.*(?:^|/)\\.\\.(?:/|$))/[^\\\\]+$", maxLength: 1024 }) }),
]);
export const TerminalEnvName = Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,127}$" });
export const TerminalEnv = Type.Record(TerminalEnvName, Value, { maxProperties: 64 });
export const TerminalKey = Type.String({
  pattern: `^(?:${terminalNamedKeys.map((key) => key.replace("+", "\\+")).join("|")}|Ctrl\\+[A-Z]|Alt\\+[A-Za-z0-9])$`,
});
export const TerminalColumns = Type.Integer({ minimum: 20, maximum: 500 });
export const TerminalRows = Type.Integer({ minimum: 5, maximum: 200 });
export const TerminalRoot = Enum(["workdir", "home"]);
export const ProcessCapture = Obj({
  name: Name,
  from: Enum(["stdout", "stderr"]),
  jsonPointer: Type.Optional(JsonPointer),
  valueType: Enum(["string", "number", "boolean", "object", "array", "null"]),
  sensitive: Type.Boolean(),
});
const terminalProcess = {
  program: TerminalProgram,
  args: Type.Optional(Type.Array(Value, { maxItems: 256 })),
  env: Type.Optional(TerminalEnv),
  cwd: Type.Optional(RelativePath),
};
const terminalFilePath = Obj({ root: TerminalRoot, path: RelativePath });
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
const buildStep = (withTerminal: boolean) =>
  Type.Recursive((Self) =>
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
      ...(withTerminal
        ? [
            action(
              "run",
              Obj({
                ...terminalProcess,
                stdin: Type.Optional(Value),
                capture: Type.Optional(Type.Array(ProcessCapture, { maxItems: 32 })),
              }),
            ),
            action(
              "launch",
              Obj({ ...terminalProcess, cols: TerminalColumns, rows: TerminalRows }),
            ),
            action("sendText", Obj({ text: Value })),
            action(
              "sendKeys",
              Obj({ keys: Type.Array(TerminalKey, { minItems: 1, maxItems: 100 }) }),
            ),
            action("resize", Obj({ cols: TerminalColumns, rows: TerminalRows })),
            action("signal", Obj({ signal: Enum(terminalSignals) })),
            action(
              "waitForText",
              Obj({
                text: Value,
                state: Type.Optional(Enum(["present", "absent"])),
                row: Type.Optional(Type.Integer({ minimum: 0, maximum: 199 })),
                deadlineMs: Positive,
              }),
            ),
            action("waitForExit", Obj({ deadlineMs: Positive })),
            action(
              "writeFile",
              Type.Union([
                Obj({ root: TerminalRoot, path: RelativePath, content: Value }),
                Obj({ root: TerminalRoot, path: RelativePath, artifactRef: id("art") }),
              ]),
            ),
          ]
        : []),
      Obj({
        ...common,
        kind: Type.Literal("assertion"),
        operation: Type.Literal("assert"),
        input: Type.Union([
          Obj({ locator: Locator }),
          Obj({ pageAlias: Type.Optional(Name), url: Type.Optional(Type.String()) }),
          Obj({ responseStepId: Name, jsonPointer: Type.Optional(JsonPointer) }),
          Obj({ outputName: Name }),
          ...(withTerminal
            ? [
                Obj({
                  processStepId: Name,
                  stream: Type.Optional(Enum(["stdout", "stderr", "output"])),
                  jsonPointer: Type.Optional(JsonPointer),
                }),
                Obj({
                  screen: Obj({ row: Type.Optional(Type.Integer({ minimum: 0, maximum: 199 })) }),
                }),
                Obj({ file: terminalFilePath, jsonPointer: Type.Optional(JsonPointer) }),
                Obj({ clipboard: Type.Literal("osc52") }),
              ]
            : []),
        ]),
        expectation: withTerminal ? Expectation : ModelExpectation,
      }),
    ]),
  );
/** Every step the runners execute. */
export const Step = buildStep(true);
/** The steps a model may propose: terminal tests are authored by people, so neither their operations, inputs nor predicates are in prompts. */
export const ModelStep = buildStep(false);
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
const buildCleanup = <E extends TSchema>(expectation: E) =>
  Obj({
    resourceRef: Name,
    operation: Type.Literal("request"),
    input: RequestInput,
    successPredicate: expectation,
    deadlineMs: Positive,
    required: Type.Boolean(),
  });
export const Cleanup = buildCleanup(Expectation);
/** The cleanup requests a model may propose: their success predicate is an HTTP/browser one. */
const ModelCleanup = buildCleanup(ModelExpectation);
export const ExecutablePlan = Obj({
  schemaVersion: Type.Literal("1.0.0"),
  kind: Type.Literal("executable"),
  name: Name,
  type: Enum(["frontend", "backend", "integration", "cli"]),
  runner: Enum(["playwright", "http", "terminal"]),
  requirementRefs: Type.Array(id("req")),
  steps: Type.Array(Step, { minItems: 1, maxItems: 200 }),
  dependsOn: Type.Optional(Type.Array(DependencyBinding, { maxItems: 100 })),
  cleanup: Type.Optional(Type.Array(Cleanup)),
  tags: Type.Optional(Type.Array(Name)),
  priority: Type.Optional(Priority),
});
/** An ExecutablePlan as a model may propose it: no terminal tests, so their operations and predicates are not in prompts. */
export const ModelExecutablePlan = Obj({
  schemaVersion: Type.Literal("1.0.0"),
  kind: Type.Literal("executable"),
  name: Name,
  type: Enum(["frontend", "backend", "integration"]),
  runner: Enum(["playwright", "http"]),
  requirementRefs: Type.Array(id("req")),
  steps: Type.Array(ModelStep, { minItems: 1, maxItems: 200 }),
  dependsOn: Type.Optional(Type.Array(DependencyBinding, { maxItems: 100 })),
  cleanup: Type.Optional(Type.Array(ModelCleanup)),
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
  /**
   * Secrets the code reads through the harness `secrets` fixture (`secrets.get("NAME")`); the
   * importer refuses any name not declared here and the worker releases exactly these.
   */
  secretRefs: Type.Optional(
    Type.Array(Obj({ name: Name, secretRef: id("sec") }), { maxItems: 64 }),
  ),
});
export const TestRevisionInput = Type.Union([
  Obj({
    plan: ExecutablePlan,
    parentId: Type.Optional(id("rev")),
    /** Why the revision exists; kept on the revision and shown in its history (UX-024). */
    justification: Type.Optional(Description),
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
