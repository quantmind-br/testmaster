import type { ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { schemaCatalog } from "./catalog.js";
import type { ExecutablePlan, PlanStep } from "./plans.js";
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
/** Validate an admitted source-revision JSON Schema with the shared validator. */
export function validateAgainstSchema<T = unknown>(
  schema: Record<string, unknown>,
  value: unknown,
): T {
  assertNfc(value);
  const validator = ajv.compile(schema);
  if (!validator(value))
    throw new ContractError("INVALID_ARGUMENT", "Response does not match source schema", {
      issues: validator.errors ?? [],
    });
  return value as T;
}
export function validate<T = unknown>(name: string, value: unknown): T {
  assertNfc(value);
  let validator = compiled.get(name);
  if (!validator) {
    validator = ajv.compile(jsonSchema(name));
    compiled.set(name, validator);
  }
  if (!validator(value)) {
    const issues = (validator.errors ?? []).map((error) => ({
      path:
        error.instancePath +
        (error.keyword === "additionalProperties"
          ? `/${String(error.params.additionalProperty)}`
          : ""),
      rule: error.keyword,
      message: error.message ?? "Invalid value",
    }));
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
  validate(schema, document);
  return { validated: true, schema };
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
        "textEquals",
        "textContains",
        "valueEquals",
        "enabled",
        // countEquals accepts either a browser locator or an HTTP JSON array.
        "visualMatches",
        "accessibilityViolations",
      ];
      const responsePredicates = ["jsonEquals", "jsonSchema", "statusIn", "headerEquals"];
      if (
        locatorPredicates.includes(predicate) &&
        (!("locator" in input) || plan.runner !== "playwright")
      )
        reject(`${path}/input`, "predicateInput", "Predicate requires browser locator");
      if (responsePredicates.includes(predicate) && !("responseStepId" in input))
        reject(`${path}/input`, "predicateInput", "Predicate requires responseStepId");
      if (
        predicate === "countEquals" &&
        !("responseStepId" in input) &&
        !("locator" in input && plan.runner === "playwright")
      )
        reject(
          `${path}/input`,
          "predicateInput",
          "Count requires browser locator or responseStepId",
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
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value))
      value.forEach((item, index) => {
        walk(item, `${path}/${index}`);
      });
    else if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (typeof object.variableRef === "string" && !captures.has(object.variableRef))
        reject(`${path}/variableRef`, "binding", "Undeclared variable reference");
      for (const [key, item] of Object.entries(object)) walk(item, `${path}/${key}`);
    }
  };
  walk(plan, "");
  for (const [index, cleanup] of (plan.cleanup ?? []).entries())
    validateHeaders(cleanup.input.headers ?? {}, `/cleanup/${index}/input/headers`, reject);
  if (issues.length)
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Plan semantic validation failed",
      { issues },
      issues,
    );
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
    const object = value as { literal?: unknown; secretRef?: string; variableRef?: string };
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
const terminalPredicates: ReadonlySet<string> = new Set([
  "textNotContains",
  "exitCodeIn",
  "noLingeringProcesses",
  "fileExists",
  "fileAbsent",
]);
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
