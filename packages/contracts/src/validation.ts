import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { schemaCatalog } from "./catalog.js";
import { JsonSetError, nestedValueReference, setJsonPointer } from "./json-body.js";
import {
  type ExecutablePlan,
  type Expectation,
  invalidCredentialCookieHeader,
  invalidCredentialTokenHeaders,
  type PlanStep,
  terminalPredicateNames,
} from "./plans.js";
import type { JsonValue } from "./primitives.js";
import type { RunnerEvent } from "./protocol.js";
import { ContractError, requireCapability, type ValidationIssue } from "./registries.js";

export const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true });
addFormats.default(ajv);
const compiled = new Map<string, ValidateFunction>();
export function jsonSchema(name: string): Record<string, unknown> {
  const source = schemaCatalog[name];
  if (!source) throw new Error(`Unknown schema ${name}`);
  const document = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
  const definitions: Record<string, unknown> = {};
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) walk(child);
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (typeof object.$id === "string") {
      const identifier = object.$id;
      delete object.$id;
      if (!(identifier in definitions)) definitions[identifier] = structuredClone(object);
    }
    if (typeof object.$ref === "string" && !object.$ref.startsWith("#"))
      object.$ref = `#/$defs/${object.$ref}`;
    for (const child of Object.values(object)) walk(child);
  };
  walk(document);
  for (const definition of Object.values(definitions)) walk(definition);
  document.$defs = definitions;
  document.$id = `urn:testmaster:${name}`;
  document.$schema = "https://json-schema.org/draft/2020-12/schema";
  return document;
}
export function parseStrictJson(bytes: Uint8Array | string, maxBytes = 1048576): unknown {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  if (buffer.byteLength > maxBytes)
    throw new ContractError("PAYLOAD_TOO_LARGE", "JSON exceeds byte limit", {
      limit: maxBytes,
      sizeBytes: buffer.byteLength,
    });
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new ContractError("INVALID_ARGUMENT", "Invalid UTF-8", {}, [
      { path: "", rule: "utf8", message: "Invalid UTF-8" },
    ]);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ContractError("INVALID_ARGUMENT", "Invalid JSON", {}, [
      { path: "", rule: "json", message: "Invalid JSON" },
    ]);
  }
  assertNfc(value);
  return value;
}
function assertNfc(value: unknown, path = ""): void {
  if (
    typeof value === "string" &&
    (value !== value.normalize("NFC") ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))
  )
    throw new ContractError("INVALID_ARGUMENT", "Text must be Unicode NFC", {}, [
      { path, rule: "nfc", message: "Text must be Unicode NFC" },
    ]);
  if (Array.isArray(value))
    value.forEach((child, index) => {
      assertNfc(child, `${path}/${index}`);
    });
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      assertNfc(key, path);
      assertNfc(child, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
    }
}
/**
 * The rules of the source-schema validator. Admitted source schemas come from third-party documents
 * (OpenAPI, JSON Schema). They get their own Ajv instance so TestMaster's strict contract validator
 * (`ajv`) stays untouched: keywords remain strict (an unknown keyword or an ignored `if` is a typo
 * that would silently weaken the oracle), but type-union and tuple conventions of real documents
 * are accepted and the OpenAPI numeric/binary formats are declared. `strictRequired` is off: a
 * `required` entry that this schema object does not declare under `properties` is valid JSON
 * Schema (`not`/`anyOf`/`oneOf` branches that only list `required`, `allOf` parts, `then`), and
 * the keyword still validates. The generated
 * JavaScript validator that code tests run (`@testmaster/domain` `sourceSchemaValidatorSource`) is
 * built from this same table, so a plan step and its generated code judge a body identically.
 */
export const SOURCE_SCHEMA_RULES = {
  ajvOptions: {
    strict: true,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
    allowUnionTypes: true,
    allErrors: true,
    validateFormats: true,
  },
  /** OpenAPI formats with no validation semantics, declared so `strict` mode accepts them. */
  openApiFormats: ["int32", "int64", "float", "double", "byte", "binary", "password"],
  /** OpenAPI annotations with no validation semantics; `x-*` vendor extensions are dropped too. */
  annotations: ["example", "xml", "externalDocs", "discriminator"],
  /** Keywords whose value is a schema or a list of schemas. */
  schemaKeywords: [
    "additionalProperties",
    "items",
    "additionalItems",
    "contains",
    "not",
    "if",
    "then",
    "else",
    "propertyNames",
    "unevaluatedItems",
    "unevaluatedProperties",
    "contentSchema",
    "allOf",
    "anyOf",
    "oneOf",
    "prefixItems",
  ],
  /** Keywords whose value maps names to schemas. */
  schemaMapKeywords: [
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
    "dependencies",
  ],
} as const;
const sourceAjv = new Ajv2020({ ...SOURCE_SCHEMA_RULES.ajvOptions });
addFormats.default(sourceAjv);
for (const format of SOURCE_SCHEMA_RULES.openApiFormats) sourceAjv.addFormat(format, true);
const sourceValidators = new Map<string, ValidateFunction>();
const SOURCE_VALIDATOR_LIMIT = 256;
const tableOf = (names: readonly string[]): Record<string, true> =>
  Object.fromEntries(names.map((name) => [name, true]));
const SOURCE_ANNOTATIONS = tableOf(SOURCE_SCHEMA_RULES.annotations);
const SCHEMA_KEYWORDS = tableOf(SOURCE_SCHEMA_RULES.schemaKeywords);
const SCHEMA_MAP_KEYWORDS = tableOf(SOURCE_SCHEMA_RULES.schemaMapKeywords);
/**
 * Copy of `schema` without annotation keywords, walking only schema positions: a property that is
 * itself named `example` (a key of `properties`) or an `enum`/`const`/`default` value is data and
 * is never touched.
 */
function withoutSourceAnnotations(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutSourceAnnotations);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !Object.hasOwn(SOURCE_ANNOTATIONS, key) && !key.startsWith("x-"))
      .map(([key, value]) => [
        key,
        Object.hasOwn(SCHEMA_KEYWORDS, key)
          ? withoutSourceAnnotations(value)
          : Object.hasOwn(SCHEMA_MAP_KEYWORDS, key) && value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value).map(([name, child]) => [
                  name,
                  withoutSourceAnnotations(child),
                ]),
              )
            : value,
      ]),
  );
}
/** The schema itself is unusable (unknown keyword, dangling reference, invalid keyword value). */
export class SourceSchemaError extends ContractError {
  readonly problem: string;
  constructor(problem: string) {
    super("INVALID_ARGUMENT", `Source schema cannot be compiled: ${problem}`, {
      schemaProblem: problem,
    });
    this.name = "SourceSchemaError";
    this.problem = problem;
  }
}
function compileSourceSchema(schema: Record<string, unknown>): ValidateFunction {
  const sanitized = withoutSourceAnnotations(schema);
  const key = JSON.stringify(sanitized);
  const cached = sourceValidators.get(key);
  if (cached) return cached;
  let validator: ValidateFunction;
  try {
    // Different content under an already registered `$id` replaces it instead of colliding.
    if (typeof schema.$id === "string") sourceAjv.removeSchema(schema.$id);
    validator = sourceAjv.compile(sanitized as Record<string, unknown>);
  } catch (error) {
    throw new SourceSchemaError(
      (error instanceof Error ? error.message : String(error)).slice(0, 512),
    );
  }
  if (sourceValidators.size >= SOURCE_VALIDATOR_LIMIT) {
    sourceValidators.clear();
    sourceAjv.removeSchema();
  }
  sourceValidators.set(key, validator);
  return validator;
}
/** Throws `SourceSchemaError` when the schema cannot be compiled by the source-schema validator. */
export function assertSourceSchemaCompiles(schema: Record<string, unknown>): void {
  compileSourceSchema(schema);
}
/**
 * Validate an admitted source-revision JSON Schema with the shared validator. An unusable schema
 * throws `SourceSchemaError`; a value the schema rejects throws `INVALID_ARGUMENT` carrying the
 * validator issues in `details.issues`.
 */
export function validateAgainstSchema<T = unknown>(
  schema: Record<string, unknown>,
  value: unknown,
): T {
  assertNfc(value);
  const validator = compileSourceSchema(schema);
  if (!validator(value))
    throw new ContractError("INVALID_ARGUMENT", "Response does not match source schema", {
      issues: validator.errors ?? [],
    });
  return value as T;
}
/** Property names that tell the branches of a union apart. */
const UNION_DISCRIMINATORS = ["kind", "operation", "predicate", "runner", "type", "by", "from"];
function within(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}
function valueAt(root: unknown, pointer: string): unknown {
  let current = root;
  if (pointer === "") return current;
  for (const encoded of pointer.slice(1).split("/")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[
      encoded.replaceAll("~1", "/").replaceAll("~0", "~")
    ];
  }
  return current;
}
function allowedValues(error: ErrorObject): unknown[] {
  if (error.keyword === "const") return [error.params.allowedValue];
  if (error.keyword === "enum") return error.params.allowedValues as unknown[];
  return [];
}
function enumerationError(union: ErrorObject, path: string, allowed: unknown[]): ErrorObject {
  const unique = [...new Set(allowed.map(String))];
  return {
    keyword: "enum",
    instancePath: path,
    schemaPath: union.schemaPath,
    params: { allowedValues: unique },
    message: `must be equal to one of the allowed values: ${unique.join(", ")}`,
  };
}
/**
 * Ajv reports every branch of a failed `anyOf`, so one wrong property of a step yields hundreds of
 * issues about the other operations. This keeps the issues of the branch the instance selects
 * through its discriminator properties; when no branch is selected it reports the allowed values
 * of the discriminator once. A union without discriminators keeps its only branch that fails least.
 */
function pruneUnionErrors(errors: readonly ErrorObject[], root: unknown): ErrorObject[] {
  const out: ErrorObject[] = [];
  for (const error of errors) {
    if (error.keyword !== "anyOf") {
      out.push(error);
      continue;
    }
    // The branch errors of a union are emitted just before its own `anyOf` error.
    const parent = error.schemaPath.slice(0, error.schemaPath.lastIndexOf("/") + 1);
    const branchBase = `${error.schemaPath}/`;
    let start = out.length;
    while (start > 0) {
      const previous = out[start - 1] as ErrorObject;
      if (!within(previous.instancePath, error.instancePath)) break;
      if (previous.schemaPath.startsWith(parent) && !previous.schemaPath.startsWith(branchBase))
        break;
      start--;
    }
    const segment = out.splice(start);
    const branches = new Map<number, ErrorObject[]>();
    let current = 0;
    for (const item of segment) {
      if (item.schemaPath.startsWith(branchBase)) {
        const match = /^(\d+)(?:\/|$)/u.exec(item.schemaPath.slice(branchBase.length));
        if (match) current = Number(match[1]);
      }
      const list = branches.get(current);
      if (list) list.push(item);
      else branches.set(current, [item]);
    }
    const lists = [...branches.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
    out.push(...pruneUnion(error, segment, lists, root));
  }
  return out;
}
function pruneUnion(
  union: ErrorObject,
  segment: ErrorObject[],
  lists: ErrorObject[][],
  root: unknown,
): ErrorObject[] {
  // A union of literals reports one failed constant per branch: that is one enumeration.
  if (
    lists.length > 0 &&
    lists.every(
      (list) =>
        list.length === 1 &&
        list[0]?.keyword === "const" &&
        list[0].instancePath === union.instancePath,
    )
  )
    return [
      enumerationError(
        union,
        union.instancePath,
        lists.flatMap((list) => allowedValues(list[0] as ErrorObject)),
      ),
    ];
  let candidates = lists;
  for (const name of UNION_DISCRIMINATORS) {
    const path = `${union.instancePath}/${name}`;
    const mismatch = (error: ErrorObject): boolean =>
      ((error.keyword === "const" || error.keyword === "enum") && error.instancePath === path) ||
      (error.keyword === "required" &&
        error.instancePath === union.instancePath &&
        error.params.missingProperty === name);
    if (!candidates.some((list) => list.some(mismatch))) continue;
    const matching = candidates.filter((list) => !list.some(mismatch));
    if (matching.length === 0) {
      if (valueAt(root, path) === undefined)
        return [
          {
            keyword: "required",
            instancePath: union.instancePath,
            schemaPath: union.schemaPath,
            params: { missingProperty: name },
            message: `must have required property '${name}'`,
          },
        ];
      return [
        enumerationError(
          union,
          path,
          candidates.flatMap((list) =>
            list.flatMap((error) => (error.instancePath === path ? allowedValues(error) : [])),
          ),
        ),
      ];
    }
    candidates = matching;
  }
  if (candidates.length > 1) {
    const fewest = Math.min(...candidates.map((list) => list.length));
    const best = candidates.filter((list) => list.length === fewest);
    if (best.length === 1) return best[0] as ErrorObject[];
  }
  if (candidates.length < lists.length) return candidates.flat();
  return [...segment, union];
}
export function validate<T = unknown>(name: string, value: unknown): T {
  assertNfc(value);
  let validator = compiled.get(name);
  if (!validator) {
    validator = ajv.compile(jsonSchema(name));
    compiled.set(name, validator);
  }
  if (!validator(value)) {
    const seen = new Set<string>();
    const issues: ValidationIssue[] = [];
    for (const error of pruneUnionErrors(validator.errors ?? [], value)) {
      const issue = {
        path:
          error.instancePath +
          (error.keyword === "additionalProperties"
            ? `/${String(error.params.additionalProperty)}`
            : ""),
        rule: error.keyword,
        message: error.message ?? "Invalid value",
      };
      const key = `${issue.path}\u0000${issue.rule}\u0000${issue.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(issue);
    }
    throw new ContractError("INVALID_ARGUMENT", `Invalid ${name}`, { issues }, issues);
  }
  const validateNestedPlans = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const child of candidate) validateNestedPlans(child);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    if ("kind" in candidate && candidate.kind === "executable") {
      const plan = candidate as ExecutablePlan; // The enclosing catalog schema established this plan shape.
      validatePlanSemantics(plan);
      return;
    }
    if ("plan" in candidate) validateNestedPlans(candidate.plan);
    if ("proposals" in candidate) validateNestedPlans(candidate.proposals);
  };
  if (
    [
      "ExecutablePlan",
      "TestRevisionInput",
      "TestRevision",
      "Proposal",
      "ProposalBatch",
      "AIProposalsOutput",
    ].includes(name)
  )
    validateNestedPlans(value);
  if (name === "StepResult") {
    const result = value as { status: string; reasonCode?: string };
    if (!["pending", "running", "passed"].includes(result.status) && !result.reasonCode)
      throw new ContractError("INVALID_ARGUMENT", "Nonpass step requires reasonCode");
  }
  if (name === "RunnerEvent") {
    const event = value as { type: string; payload: Record<string, unknown> };
    if (Buffer.byteLength(JSON.stringify(value)) > 262144)
      throw new ContractError("PAYLOAD_TOO_LARGE", "Protocol line exceeds 256 KiB");
    if (
      event.type === "artifact.chunk" &&
      typeof event.payload.data === "string" &&
      Buffer.from(event.payload.data, "base64").byteLength > 131072
    )
      throw new ContractError("PAYLOAD_TOO_LARGE", "Artifact chunk exceeds 128 KiB");
    if (
      event.type === "variable.captured" &&
      event.payload.sensitive &&
      ("value" in event.payload || !event.payload.encryptedValueRef)
    )
      throw new ContractError("INVALID_ARGUMENT", "Sensitive capture requires encrypted reference");
    if (
      event.type === "step.finished" &&
      !["pending", "running", "passed"].includes(String(event.payload.status)) &&
      !event.payload.reasonCode
    )
      throw new ContractError("INVALID_ARGUMENT", "Nonpass step requires reasonCode");
  }
  return value as T;
}
/** Trusted socket-only DTO; durable/public RunnerEvent validation still rejects plaintext captures. */
export function validateRunnerWireEvent(value: unknown): RunnerEvent {
  assertNfc(value);
  let validator = compiled.get("RunnerEvent");
  if (!validator) {
    validator = ajv.compile(jsonSchema("RunnerEvent"));
    compiled.set("RunnerEvent", validator);
  }
  if (!validator(value))
    throw new ContractError("INVALID_ARGUMENT", "Invalid RunnerEvent", {
      issues: validator.errors ?? [],
    });
  const event = value as RunnerEvent;
  if (
    event.type === "variable.captured" &&
    event.payload.sensitive &&
    event.payload.value &&
    "literal" in event.payload.value
  ) {
    const { value: _value, ...payload } = event.payload;
    validate("RunnerEvent", {
      ...event,
      payload: { ...payload, encryptedValueRef: "supervisor-protection-pending" },
    });
    return event;
  }
  return validate<RunnerEvent>("RunnerEvent", event);
}
export function parseAndValidate<T = unknown>(
  name: string,
  bytes: Uint8Array | string,
  maxBytes = 1048576,
): T {
  return validate<T>(name, parseStrictJson(bytes, maxBytes));
}
/** Offline validation exposed identically by CLI, REST and MCP. */
export function validateDocument(
  schema: string,
  document: unknown,
): { validated: true; schema: string } {
  if (!["ExecutablePlan", "ProjectConfig", "RunRequest"].includes(schema))
    throw new ContractError("INVALID_ARGUMENT", "Unsupported document schema");
  const sizeBytes = Buffer.byteLength(JSON.stringify(document));
  if (sizeBytes > 1048576)
    throw new ContractError("PAYLOAD_TOO_LARGE", "Document exceeds byte limit", {
      limit: 1048576,
      sizeBytes,
    });
  const checked = validate(schema, document);
  if (schema === "ExecutablePlan") assertNoNegativeBeforeRender(checked as ExecutablePlan);
  return { validated: true, schema };
}
/** Canonical JSON (keys sorted recursively) of a locator without its container: the element it selects. */
function locatorSelector(locator: Record<string, unknown>): string {
  const { container: _container, ...selector } = locator;
  return JSON.stringify(selector, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
      : value,
  );
}
/**
 * A named role locator whose container chain holds an identical locator. Only named roles: HTML does
 * not nest headings, buttons or links, while a css selector, an unnamed role or a test id can
 * legitimately repeat in nested structures (submenus, nested lists, nested components).
 */
function selfContainedLocator(value: Record<string, unknown>): boolean {
  if (value.by !== "role" || typeof value.name !== "string") return false;
  const own = locatorSelector(value);
  for (
    let container = value.container;
    container && typeof container === "object";
    container = (container as Record<string, unknown>).container
  )
    if (locatorSelector(container as Record<string, unknown>) === own) return true;
  return false;
}
export function validatePlanSemantics(plan: ExecutablePlan): void {
  const issues: ValidationIssue[] = [];
  const reject = (path: string, rule: string, message: string): void => {
    issues.push({ path, rule, message });
  };
  if (Buffer.byteLength(JSON.stringify(plan)) > 1048576)
    throw new ContractError("PAYLOAD_TOO_LARGE", "Plan exceeds byte limit");
  const ids = new Set<string>();
  const captures = new Set<string>((plan.dependsOn ?? []).map((binding) => binding.consumerInput));
  let count = 0;
  let assertion = false;
  const flat: Array<{ step: PlanStep; path: string }> = [];
  const visit = (steps: readonly PlanStep[], path: string): void => {
    steps.forEach((step, index) => {
      const current = `${path}/${index}`;
      count++;
      if (ids.has(step.id)) reject(`${current}/id`, "unique", "Duplicate step ID");
      ids.add(step.id);
      flat.push({ step, path: current });
      if (step.kind === "assertion" && step.required !== false) assertion = true;
      if (step.operation === "frame") visit(step.input.childSteps, `${current}/input/childSteps`);
      if (step.operation === "request")
        for (const capture of step.input.capture ?? []) {
          if (captures.has(capture.name) || captures.has(`${step.id}.${capture.name}`))
            reject(`${current}/input/capture`, "unique", "Duplicate capture");
          captures.add(capture.name);
          captures.add(`${step.id}.${capture.name}`);
        }
      if (step.operation === "request" && step.input.resource) captures.add(`${step.id}.handle`);
      if (step.operation === "run")
        for (const capture of step.input.capture ?? []) {
          if (captures.has(capture.name) || captures.has(`${step.id}.${capture.name}`))
            reject(`${current}/input/capture`, "unique", "Duplicate capture");
          if (capture.jsonPointer === undefined && capture.valueType !== "string")
            reject(
              `${current}/input/capture`,
              "valueType",
              "A capture without jsonPointer is the whole stream and must be a string",
            );
          captures.add(capture.name);
          captures.add(`${step.id}.${capture.name}`);
        }
    });
  };
  visit(plan.steps, "/steps");
  if (count > 200) reject("/steps", "maxItems", "At most 200 total steps");
  if (!assertion)
    reject("/steps", "requiredAssertion", "At least one required assertion is required");
  const seenResponses = new Set<string>();
  const processes = new Map<string, "run" | "launch">();
  let launched = false;
  if (plan.runner === "terminal" && (plan.cleanup ?? []).length)
    reject("/cleanup", "runner", "Cleanup requests are not available in the terminal runner");
  for (const { step, path } of flat) {
    if (
      plan.runner === "http" &&
      !["request", "assert"].includes(step.operation) &&
      !terminalOnlyOperations.has(step.operation)
    )
      reject(`${path}/operation`, "runner", "Operation requires playwright");
    if (terminalOnlyOperations.has(step.operation) && plan.runner !== "terminal")
      reject(`${path}/operation`, "runner", "Operation requires the terminal runner");
    if (
      plan.runner === "terminal" &&
      step.operation !== "assert" &&
      !terminalOnlyOperations.has(step.operation)
    )
      reject(`${path}/operation`, "runner", "Operation is not available in the terminal runner");
    if (
      (plan.type === "frontend" && plan.runner !== "playwright") ||
      (plan.type === "backend" && plan.runner !== "http") ||
      (plan.type === "cli") !== (plan.runner === "terminal")
    )
      reject("/runner", "runner", "Runner does not match test type");
    if (step.operation === "request") {
      seenResponses.add(step.id);
      validateHeaders(step.input.headers ?? {}, `${path}/input/headers`, reject);
      validateRequestBody(step.input, `${path}/input`, reject);
    }
    if (plan.runner === "terminal") {
      if (sessionOperations.has(step.operation) && !launched)
        reject(`${path}/operation`, "session", "Operation requires a preceding launch");
      validateTerminalStep(step, path, { processes, launched }, reject);
      if (step.operation === "run") processes.set(step.id, "run");
      if (step.operation === "launch") {
        processes.set(step.id, "launch");
        launched = true;
      }
    }
    if (step.kind === "assertion" && plan.runner === "terminal") continue;
    if (step.kind === "assertion") {
      const predicate = step.expectation.predicate;
      if (["visualMatches", "accessibilityViolations"].includes(predicate))
        requireCapability(predicate);
      const input = step.input as Record<string, unknown>;
      if (terminalPredicates.has(predicate))
        reject(`${path}/expectation`, "predicateInput", "Predicate requires the terminal runner");
      if (["processStepId", "screen", "file", "clipboard"].some((key) => key in input))
        reject(`${path}/input`, "predicateInput", "Input requires the terminal runner");
      const locatorPredicates = [
        "visible",
        "hidden",
        "valueEquals",
        "enabled",
        "disabled",
        // The count predicates accept either a browser locator or an HTTP JSON array.
        "visualMatches",
        "accessibilityViolations",
      ];
      const responsePredicates = [
        "jsonEquals",
        "jsonSchema",
        "jsonConforms",
        "statusIn",
        "headerEquals",
        "headerMatches",
        "cookieAbsent",
      ];
      validatePattern(step.expectation, `${path}/expectation`, reject);
      validateInlineSchema(step.expectation, `${path}/expectation`, reject);
      if (
        locatorPredicates.includes(predicate) &&
        (!("locator" in input) || plan.runner !== "playwright")
      )
        reject(`${path}/input`, "predicateInput", "Predicate requires browser locator");
      if (responsePredicates.includes(predicate) && !("responseStepId" in input))
        reject(`${path}/input`, "predicateInput", "Predicate requires responseStepId");
      if (
        ["countEquals", "countAtLeast", "countAtMost"].includes(predicate) &&
        !("responseStepId" in input) &&
        !("locator" in input && plan.runner === "playwright")
      )
        reject(
          `${path}/input`,
          "predicateInput",
          "Count requires browser locator or responseStepId",
        );
      // Text predicates read a browser locator's text, or a whole response body as UTF-8 text.
      if (predicate === "textEquals" || predicate === "textContains") {
        if ("responseStepId" in input) {
          if ("jsonPointer" in input)
            reject(
              `${path}/input/jsonPointer`,
              "predicateInput",
              "A text assertion on a response reads the whole body: drop jsonPointer, or use jsonEquals for a JSON value",
            );
        } else if (!("locator" in input) || plan.runner !== "playwright")
          reject(
            `${path}/input`,
            "predicateInput",
            "Text assertion requires a browser locator or responseStepId",
          );
      }
      if (step.expectation.predicate === "countAtLeast" && step.expectation.value === 0)
        reject(
          `${path}/expectation/value`,
          "vacuousCount",
          "countAtLeast 0 always passes because a count is never negative: use a positive minimum, or countEquals 0 or countAtMost 0 to assert absence",
        );
      if (
        (predicate === "urlEquals" || predicate === "urlMatches") &&
        (plan.runner !== "playwright" || "locator" in input || "responseStepId" in input)
      )
        reject(
          `${path}/input`,
          "predicateInput",
          "URL assertion requires the playwright runner and page input (no locator or responseStepId)",
        );
      if (
        "responseStepId" in input &&
        !seenResponses.has(String(input.responseStepId)) &&
        !captures.has(String(input.responseStepId))
      )
        reject(
          `${path}/input/responseStepId`,
          "responseReference",
          "Response must precede assertion",
        );
      if (predicate === "downloadMatches" && !("outputName" in input))
        reject(`${path}/input`, "predicateInput", "Download assertion requires outputName");
    }
  }
  const stepAt = (path: string): PlanStep | undefined =>
    flat
      .filter((item) => path === item.path || path.startsWith(`${item.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0]?.step;
  const walk = (value: unknown, path: string, inContainer = false): void => {
    if (Array.isArray(value))
      value.forEach((item, index) => {
        walk(item, `${path}/${index}`);
      });
    else if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (typeof object.variableRef === "string" && !captures.has(object.variableRef))
        reject(`${path}/variableRef`, "binding", "Undeclared variable reference");
      // A container chain is checked once, from the locator that starts it.
      if (!inContainer && selfContainedLocator(object)) {
        const owner = stepAt(path);
        reject(
          `${path}/container`,
          "locatorContainer",
          `${owner ? `Step "${owner.id}"` : "A step"} locates a named role element inside a container that is the identical named role element; it matches only an element nested inside an identical one (HTML does not nest headings, buttons or links), which is almost certainly a mistake: drop the container or name a different one (for example the form or dialog)`,
        );
      }
      for (const [key, item] of Object.entries(object))
        walk(item, `${path}/${key}`, key === "container");
    }
  };
  walk(plan, "");
  for (const [index, cleanup] of (plan.cleanup ?? []).entries()) {
    validateHeaders(cleanup.input.headers ?? {}, `/cleanup/${index}/input/headers`, reject);
    validateRequestBody(cleanup.input, `/cleanup/${index}/input`, reject);
    validatePattern(cleanup.successPredicate, `/cleanup/${index}/successPredicate`, reject);
    validateInlineSchema(cleanup.successPredicate, `/cleanup/${index}/successPredicate`, reject);
  }
  if (issues.length)
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Plan semantic validation failed",
      { issues },
      issues,
    );
}
/**
 * Observes content on the page, not its URL, the absence of earlier elements, or a response body
 * (a check through `responseStepId` reads an HTTP response, never the page).
 */
export function observesRenderedContent(step: Extract<PlanStep, { kind: "assertion" }>): boolean {
  if ("responseStepId" in step.input) return false;
  const expectation = step.expectation;
  switch (expectation.predicate) {
    case "visible":
    case "enabled":
    case "disabled":
    case "textEquals":
    case "textContains":
    case "valueEquals":
    case "visualMatches":
    case "downloadMatches":
      return true;
    case "countEquals":
    case "countAtLeast":
      return expectation.value > 0;
    default:
      return false;
  }
}
/** A browser check that an element is absent: it also holds on a page that has not rendered yet. */
function isNegativeBrowserCheck(step: PlanStep): boolean {
  if (step.operation === "waitFor")
    return "locator" in step.input && ["hidden", "detached"].includes(step.input.state);
  if (step.kind !== "assertion" || !("locator" in step.input)) return false;
  const expectation = step.expectation;
  return (
    expectation.predicate === "hidden" ||
    ((expectation.predicate === "countEquals" || expectation.predicate === "countAtMost") &&
      expectation.value === 0)
  );
}
/** Actions that put a value into a form: a later click or key press on the same page submits it. */
const formInputOperations: Record<string, true> = {
  fill: true,
  select: true,
  check: true,
  uncheck: true,
  upload: true,
};
/** Actions that find an element on the page, so the page had rendered when they ran. */
const locatingOperations: Record<string, true> = {
  ...formInputOperations,
  hover: true,
  drag: true,
};
/**
 * A browser check that an element is absent (`hidden`, `countEquals` or `countAtMost` 0, a `waitFor` hidden or
 * detached) passes on a page that has not rendered yet, because the element is not there. When
 * such a check follows a page load without a positive check of the destination in between, it can
 * pass without testing anything. A page load is a `navigate`, or a click or key press that submits
 * a form (it follows a fill) or is followed by a URL assertion (`urlEquals`, `urlMatches`), which
 * declares that the URL changed. A required positive assertion or `waitFor` on rendered content, or
 * an action that must find an element, settles the page. A click that neither follows a fill nor is
 * followed by a URL assertion is not known to navigate and is not treated as a page load.
 */
export function findNegativeBeforeRender(plan: ExecutablePlan): ValidationIssue[] {
  if (plan.runner !== "playwright") return [];
  const issues: ValidationIssue[] = [];
  // The action that loaded a page whose content no step has observed yet.
  let unsettled: string | null = null;
  // The last action that can navigate since the last positive observation.
  let lastNavigating: string | null = null;
  let formFilled = false;
  const visit = (steps: readonly PlanStep[], path: string): void => {
    steps.forEach((step, index) => {
      const here = `${path}/${index}`;
      if (step.operation === "frame") {
        visit(step.input.childSteps, `${here}/input/childSteps`);
        return;
      }
      const required = step.required !== false;
      if (isNegativeBrowserCheck(step)) {
        if (required && unsettled !== null)
          issues.push({
            path: step.kind === "assertion" ? `${here}/expectation` : `${here}/input`,
            rule: "negativeBeforeRender",
            message: `Negative check "${step.id}" follows "${unsettled}" with no positive check of the page in between, so it also passes while that page is still blank. Add a required visible, textContains, textEquals, valueEquals, countEquals or countAtLeast (above 0) assertion on content that exists only after "${unsettled}", before "${step.id}"`,
          });
        return;
      }
      if (step.kind === "assertion") {
        if (required && observesRenderedContent(step)) {
          unsettled = null;
          lastNavigating = null;
          formFilled = false;
        } else if (
          (step.expectation.predicate === "urlEquals" ||
            step.expectation.predicate === "urlMatches") &&
          lastNavigating !== null
        )
          unsettled ??= lastNavigating;
        return;
      }
      if (step.operation === "navigate") {
        unsettled = step.id;
        lastNavigating = step.id;
        formFilled = false;
      } else if (step.operation === "click" || step.operation === "press") {
        unsettled = formFilled ? step.id : null;
        lastNavigating = step.id;
        formFilled = false;
      } else if (step.operation === "waitFor") {
        if (
          required &&
          "locator" in step.input &&
          (step.input.state === "visible" || step.input.state === "attached")
        ) {
          unsettled = null;
          lastNavigating = null;
          formFilled = false;
        }
      } else if (Object.hasOwn(locatingOperations, step.operation)) {
        unsettled = null;
        formFilled = Object.hasOwn(formInputOperations, step.operation);
      }
    });
  };
  visit(plan.steps, "/steps");
  return issues;
}
/**
 * Authoring check, not run when a stored plan executes: a plan saved before the rule existed keeps
 * running; one written, edited or generated now cannot pass on a page that has not rendered.
 */
export function assertNoNegativeBeforeRender(plan: ExecutablePlan): void {
  const issues = findNegativeBeforeRender(plan);
  if (issues.length)
    throw new ContractError(
      "INVALID_ARGUMENT",
      `A negative check runs before the page it checks has rendered: ${issues
        .slice(0, 5)
        .map(({ message }) => message)
        .join("; ")}`,
      { reasonCode: "negative_before_render", issues },
      issues,
    );
}
/**
 * Why `header` cannot carry this invalid credential, or undefined when it can. The cookie form
 * (`<name>=<random>`) fits only `Cookie` and the token form only the token headers, so a value
 * never lands where no server would read it as a credential.
 */
export function invalidCredentialRefusal(
  header: string,
  spec: { scheme?: unknown; cookie?: unknown },
): string | undefined {
  const lower = header.toLowerCase();
  if (spec.scheme !== undefined && spec.cookie !== undefined)
    return "invalidCredential takes scheme or cookie, not both";
  if (spec.cookie !== undefined)
    return lower === invalidCredentialCookieHeader
      ? undefined
      : `invalidCredential.cookie is only valid on the ${invalidCredentialCookieHeader} header`;
  if ((invalidCredentialTokenHeaders as readonly string[]).includes(lower)) return undefined;
  return lower === invalidCredentialCookieHeader
    ? 'A Cookie header needs {"invalidCredential": {"cookie": "<cookie name>"}}: a scheme or a bare token is not a cookie pair'
    : `invalidCredential without cookie is only valid on ${invalidCredentialTokenHeaders.join(", ")}`;
}
function validateHeaders(
  headers: Record<string, unknown>,
  path: string,
  reject: (path: string, rule: string, message: string) => void,
): void {
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (seen.has(lower)) reject(`${path}/${name}`, "header", "Duplicate normalized header");
    seen.add(lower);
    if (
      ["host", "connection", "content-length", "transfer-encoding", "forwarded"].includes(lower) ||
      lower.startsWith("proxy-") ||
      lower.startsWith("x-forwarded-")
    )
      reject(`${path}/${name}`, "header", "Destination or proxy override is forbidden");
    const object = value as {
      literal?: unknown;
      secretRef?: string;
      variableRef?: string;
      invalidCredential?: { scheme?: unknown; cookie?: unknown };
    };
    if ("invalidCredential" in object) {
      const refusal = invalidCredentialRefusal(name, object.invalidCredential ?? {});
      if (refusal) reject(`${path}/${name}`, "header", refusal);
      continue;
    }
    if (
      "literal" in object &&
      (typeof object.literal !== "string" || /[\r\n]/.test(object.literal))
    )
      reject(`${path}/${name}`, "header", "Header literal must be string without CRLF");
    if (
      ["authorization", "cookie", "x-api-key", "api-key", "set-cookie"].includes(lower) &&
      "literal" in object
    )
      reject(`${path}/${name}`, "secretRef", "Authentication headers require a reference");
  }
}
type RequestInputShape = Extract<PlanStep, { operation: "request" }>["input"];
/**
 * A `{secretRef}` or `{variableRef}` object inside a JSON literal is plain data: it would be sent
 * as written, with the secret id as the value. The reference must be placed with `body.set`.
 * When the document is a literal, every `set` pointer is also checked against it.
 */
function validateRequestBody(input: RequestInputShape, path: string, reject: Reject): void {
  const body = input.body;
  if (body?.kind !== "json") return;
  const literals: Array<{ literal: JsonValue; path: string }> = [];
  if ("literal" in body.value)
    literals.push({ literal: body.value.literal, path: `${path}/body/value/literal` });
  for (const [index, entry] of (body.set ?? []).entries())
    if ("literal" in entry.value)
      literals.push({
        literal: entry.value.literal,
        path: `${path}/body/set/${index}/value/literal`,
      });
  for (const { literal, path: where } of literals) {
    const nested = nestedValueReference(literal);
    if (nested === undefined) continue;
    reject(
      `${where}${nested}`,
      "nestedReference",
      `A JSON literal nests a secretRef/variableRef object at pointer "${nested}"; it would be sent as plain data. Keep the document in value and place the reference with body.set: [{ "pointer": "${nested}", "value": { "secretRef": "…" } }]`,
    );
  }
  if (!("literal" in body.value)) return;
  let document = body.value.literal;
  for (const [index, entry] of (body.set ?? []).entries()) {
    try {
      document = setJsonPointer(document, entry.pointer, null);
    } catch (error) {
      if (!(error instanceof JsonSetError)) throw error;
      reject(`${path}/body/set/${index}/pointer`, "jsonPointer", error.message);
    }
  }
}
/** A `headerMatches` or `urlMatches` pattern the runner could not compile is a plan error, never a runtime failure. */
function validatePattern(expectation: Expectation, path: string, reject: Reject): void {
  if (expectation.predicate !== "headerMatches" && expectation.predicate !== "urlMatches") return;
  try {
    new RegExp(expectation.pattern, "u");
  } catch (error) {
    reject(
      `${path}/pattern`,
      "pattern",
      `Pattern is not a valid ECMAScript regular expression with the u flag: ${error instanceof Error ? error.message : "invalid"}`,
    );
  }
}
/** A `jsonConforms` schema the runner could not compile is a plan error, never a runtime failure. */
function validateInlineSchema(expectation: Expectation, path: string, reject: Reject): void {
  if (expectation.predicate !== "jsonConforms") return;
  try {
    assertSourceSchemaCompiles(expectation.schema);
  } catch (error) {
    if (!(error instanceof SourceSchemaError)) throw error;
    reject(`${path}/schema`, "schema", `Inline JSON Schema cannot be compiled: ${error.problem}`);
  }
}
const terminalOnlyOperations: ReadonlySet<string> = new Set([
  "run",
  "launch",
  "sendText",
  "sendKeys",
  "resize",
  "signal",
  "waitForText",
  "waitForExit",
  "writeFile",
]);
const sessionOperations: ReadonlySet<string> = new Set([
  "sendText",
  "sendKeys",
  "resize",
  "signal",
  "waitForText",
  "waitForExit",
]);
const terminalPredicates: ReadonlySet<string> = new Set(terminalPredicateNames);
const reservedEnvironment: ReadonlySet<string> = new Set(["HOME", "TMPDIR", "PWD"]);
const proxyEnvironment: ReadonlySet<string> = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
]);
type Reject = (path: string, rule: string, message: string) => void;
interface TerminalState {
  processes: ReadonlyMap<string, "run" | "launch">;
  launched: boolean;
}
/** Rejects a literal that cannot be rendered as the named scalar type. */
function checkLiteral(
  value: unknown,
  path: string,
  allowed: readonly string[],
  reject: Reject,
): void {
  if (!value || typeof value !== "object" || !("literal" in value)) return;
  const literal = (value as { literal: unknown }).literal;
  if (!allowed.includes(typeof literal))
    reject(`${path}/literal`, "valueType", `Literal must be ${allowed.join(", ")}`);
}
function validateTerminalStep(
  step: PlanStep,
  path: string,
  state: TerminalState,
  reject: Reject,
): void {
  const scalars = ["string", "number", "boolean"];
  if (step.operation === "run" || step.operation === "launch") {
    (step.input.args ?? []).forEach((value, index) => {
      checkLiteral(value, `${path}/input/args/${index}`, scalars, reject);
    });
    for (const [name, value] of Object.entries(step.input.env ?? {})) {
      if (
        reservedEnvironment.has(name) ||
        proxyEnvironment.has(name.toUpperCase()) ||
        name.startsWith("TESTMASTER_")
      )
        reject(`${path}/input/env/${name}`, "environment", "Environment name is reserved");
      checkLiteral(value, `${path}/input/env/${name}`, scalars, reject);
    }
  }
  if (step.operation === "run")
    checkLiteral(step.input.stdin, `${path}/input/stdin`, ["string"], reject);
  if (step.operation === "sendText" || step.operation === "waitForText")
    checkLiteral(step.input.text, `${path}/input/text`, ["string"], reject);
  if (step.operation === "writeFile" && "content" in step.input)
    checkLiteral(step.input.content, `${path}/input/content`, ["string"], reject);
  if (step.kind !== "assertion") return;
  const predicate = step.expectation.predicate;
  const input = step.input as Record<string, unknown>;
  const fail = (message: string): void => reject(`${path}/input`, "predicateInput", message);
  const shape =
    "processStepId" in input
      ? "process"
      : "screen" in input
        ? "screen"
        : "file" in input
          ? "file"
          : "clipboard" in input
            ? "clipboard"
            : "other";
  if (shape === "other") {
    fail("Terminal assertions require processStepId, screen, file or clipboard input");
    return;
  }
  if ((shape === "screen" || shape === "clipboard") && !state.launched)
    reject(`${path}/input`, "session", "Input requires a preceding launch");
  const stream = input.stream;
  if (shape === "process") {
    const kind = state.processes.get(String(input.processStepId));
    if (!kind)
      reject(
        `${path}/input/processStepId`,
        "processReference",
        "Process must be a preceding run or launch",
      );
    if (kind === "run" && stream === "output")
      reject(`${path}/input/stream`, "processReference", "Stream output requires a launch");
    if (kind === "launch" && (stream === "stdout" || stream === "stderr"))
      reject(`${path}/input/stream`, "processReference", "Streams stdout and stderr require a run");
  }
  const jsonPointer = input.jsonPointer !== undefined;
  switch (predicate) {
    case "exitCodeIn":
    case "noLingeringProcesses":
      if (shape !== "process" || stream !== undefined || jsonPointer)
        fail("Predicate requires processStepId without stream or jsonPointer");
      break;
    case "textEquals":
    case "textContains":
    case "textNotContains":
      if (jsonPointer) fail("jsonPointer is only valid with jsonEquals");
      if (shape === "process" && stream === undefined) fail("Text predicate requires a stream");
      break;
    case "jsonEquals":
      if (shape === "screen" || shape === "clipboard")
        fail("jsonEquals requires a process stream or a file");
      if (shape === "process" && stream !== "stdout" && stream !== "stderr")
        fail("jsonEquals requires stream stdout or stderr");
      break;
    case "fileExists":
    case "fileAbsent":
      if (shape !== "file" || jsonPointer)
        fail("Predicate requires a file input without jsonPointer");
      break;
    default:
      fail("Predicate is not available in the terminal runner");
  }
}
