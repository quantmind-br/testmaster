import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, openSync } from "node:fs";
import { open } from "node:fs/promises";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import {
  ContractError,
  type Expectation,
  invalidCredentialRefusal,
  JsonSetError,
  type JsonValue,
  type PlanStep,
  parseStrictJson,
  parseXmlPath,
  patternMaxLength,
  SourceSchemaError,
  selectXmlPath,
  setJsonPointer,
  validateAgainstSchema,
  XML_PATH_PREDICATES,
  type XmlSelection,
} from "@testmaster/contracts";
import { type Stopwatch, uuidV7IdGenerator } from "@testmaster/domain";
import { type Dispatcher, ProxyAgent, request } from "undici";
import { matchingCookies, parseStorageCookies, type StoredCookie } from "./profile-session.js";
import {
  type RunnerResult,
  type Runtime,
  RuntimeError,
  stepTimeoutMs,
  storageStateRefusal,
} from "./runtime.js";

/** Shared with the sandbox egress proxy (packages/sandbox/src/egress/proxy.ts). */
const EGRESS_DIAGNOSTICS_HEADER = "x-testmaster-egress-diagnostics";
const UPSTREAM_FAILURE_HEADER = "x-testmaster-upstream-failure";
/** The egress proxy reported that the target connection failed (code is the socket error). */
class UpstreamFailure extends Error {
  constructor(readonly code: string) {
    super("Egress proxy reported an upstream connection failure");
  }
}

type RequestInput = Extract<PlanStep, { operation: "request" }>["input"];
type ResourceState =
  | "planned"
  | "created"
  | "cleanup_pending"
  | "cleaned"
  | "orphaned"
  | "uncertain";
interface OwnedResource {
  stepId: string;
  resourceId: string;
  resourceType: string;
  correlationKey: string;
  state: ResourceState;
  handleRef?: string;
  ownerProof?: unknown;
}
/** Cookies and header credentials of the environment's auth profiles (`auth: "profile"`). */
interface ProfileSession {
  cookies: StoredCookie[];
  headers: Record<string, string>;
}
/** One redirect the engine followed: the request URL, the 3xx status and the raw `Location` value. */
export interface RedirectHop {
  url: string;
  status: number;
  location: string;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  /** Final URL: the request URL, or where the last followed redirect led. */
  url: string;
  /** Redirects followed before this response, in order; empty when none or with `redirect: "manual"`. */
  redirects: RedirectHop[];
  /** Names of the cookies set by any response of the request, redirect hops included. */
  cookieNames: string[];
  authenticated?: boolean;
}
export interface HttpEngineOptions {
  dispatcher?: Dispatcher;
}
const DEFAULT_BODY_BYTES = 10 * 1024 * 1024;
const REDIRECT_STATUS: Record<number, true> = {
  301: true,
  302: true,
  303: true,
  307: true,
  308: true,
};
const FORBIDDEN_HEADER: Record<string, true> = {
  host: true,
  connection: true,
  "content-length": true,
  "transfer-encoding": true,
  forwarded: true,
  via: true,
  upgrade: true,
  te: true,
  trailer: true,
};
const CREDENTIAL_HEADER: Record<string, true> = {
  authorization: true,
  cookie: true,
  cookie2: true,
  "x-api-key": true,
  "api-key": true,
  "set-cookie": true,
};
const EVIDENCE_HEADERS: Record<string, true> = {
  location: true,
  "content-type": true,
  "content-length": true,
  "cache-control": true,
  etag: true,
  "last-modified": true,
  "retry-after": true,
};
function failureExcerpt(runtime: Runtime, response: HttpResponse): string | null {
  if (response.status < 400 || !response.headers["content-type"]?.includes("json")) return null;
  try {
    const value = parseStrictJson(response.body, response.body.byteLength);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const fields = Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, item]) => ["error", "message", "code"].includes(key) && typeof item === "string",
        )
        .map(([key, item]) => [key, runtime.scrub(String(item)).slice(0, 128)]),
    );
    return Object.keys(fields).length ? runtime.scrub(JSON.stringify(fields)).slice(0, 512) : null;
  } catch {
    return null;
  }
}
/** Largest comparison value the runtime retains whole; bigger failures keep a bounded excerpt. */
const COMPARISON_BYTES = 8192;
const EXCERPT_STRING_CHARS = 64;
const EXCERPT_KEYS = 12;
const EXCERPT_ITEMS = 3;
const EXCERPT_DEPTH = 3;
const SCHEMA_VIOLATIONS = 20;
/** Deterministic, size-bounded structural excerpt of a response value for failure diagnosis. */
function valueExcerpt(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string")
    return value.length > EXCERPT_STRING_CHARS
      ? `${value.slice(0, EXCERPT_STRING_CHARS)}...(${value.length} chars)`
      : value;
  if (Array.isArray(value)) {
    if (depth >= EXCERPT_DEPTH) return `[array of ${value.length}]`;
    const items = value.slice(0, EXCERPT_ITEMS).map((item) => valueExcerpt(item, depth + 1));
    return value.length > EXCERPT_ITEMS
      ? [...items, `...(${value.length - EXCERPT_ITEMS} more items)`]
      : items;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (depth >= EXCERPT_DEPTH) return `[object with ${entries.length} keys]`;
    return Object.fromEntries([
      ...entries
        .slice(0, EXCERPT_KEYS)
        .map(([key, item]) => [key.slice(0, EXCERPT_STRING_CHARS), valueExcerpt(item, depth + 1)]),
      ...(entries.length > EXCERPT_KEYS
        ? [["(omitted)", `${entries.length - EXCERPT_KEYS} more keys`]]
        : []),
    ]);
  }
  return "[unavailable]";
}
/**
 * Records the comparison of a failed assertion. A value the runtime would drop for its size is
 * reduced to a bounded excerpt instead, so the failure always carries what was observed.
 */
function recordFailedComparison(runtime: Runtime, observed: unknown, expected: unknown): void {
  const bounded = (value: unknown): unknown => {
    const json = JSON.stringify(value);
    if (json === undefined || Buffer.byteLength(json) <= COMPARISON_BYTES) return value;
    return { truncated: true, sizeBytes: Buffer.byteLength(json), excerpt: valueExcerpt(value) };
  };
  runtime.recordComparison(bounded(observed), bounded(expected));
}
interface SchemaViolation {
  path: string;
  keyword: string;
  message: string;
  property?: string;
}
/** Validator issues as bounded value-free records (paths, keywords and messages only). */
function schemaViolations(error: ContractError): { items: SchemaViolation[]; total: number } {
  const raw: unknown[] = Array.isArray(error.details.issues)
    ? error.details.issues
    : error.issues.map((issue) => ({
        instancePath: issue.path,
        keyword: issue.rule,
        message: issue.message,
      }));
  const items = raw.slice(0, SCHEMA_VIOLATIONS).map((issue): SchemaViolation => {
    const record = (issue && typeof issue === "object" ? issue : {}) as Record<string, unknown>;
    const params = (
      record.params && typeof record.params === "object" ? record.params : {}
    ) as Record<string, unknown>;
    const property =
      typeof params.missingProperty === "string"
        ? params.missingProperty
        : typeof params.additionalProperty === "string"
          ? params.additionalProperty
          : undefined;
    return {
      path: String(record.instancePath ?? "").slice(0, 200),
      keyword: String(record.keyword ?? "").slice(0, 40),
      message: String(record.message ?? "").slice(0, 160),
      ...(property === undefined ? {} : { property: property.slice(0, 64) }),
    };
  });
  return { items, total: raw.length };
}
/**
 * What a schema rejection retained: the violations plus an excerpt of the rejected value, degraded
 * step by step (no excerpt, then counts only) when the full record is too large or carries a
 * secret, so a failure never keeps less than it can safely say.
 */
function schemaObservation(
  runtime: Runtime,
  violations: { items: SchemaViolation[]; total: number },
  value: unknown,
): unknown {
  const base = {
    violations: violations.items,
    omittedViolations: Math.max(0, violations.total - violations.items.length),
  };
  const clean = (candidate: unknown): boolean => {
    const json = JSON.stringify(candidate);
    return Buffer.byteLength(json) <= COMPARISON_BYTES && runtime.scrub(json) === json;
  };
  const withExcerpt = { ...base, excerpt: valueExcerpt(value) };
  if (clean(withExcerpt)) return withExcerpt;
  if (clean(base)) return base;
  return {
    violationCount: violations.total,
    keywords: [...new Set(violations.items.map((item) => item.keyword))].slice(0, 10),
  };
}
/** How a schema check names its schema: the recorded expectation and the failure wording. */
interface SchemaCheck {
  expected: unknown;
  /** Completes "Response does not match ...". */
  mismatch: string;
  /** Starts "... cannot be used for validation". */
  unusable: string;
}
/**
 * The asserted JSON value of the response when it conforms to the schema. A mismatch records the
 * violations and fails the step; a schema the validator cannot use leaves it inconclusive.
 */
function conformingValue(
  runtime: Runtime,
  response: HttpResponse,
  pointer: string | undefined,
  schema: Record<string, unknown>,
  check: SchemaCheck,
): unknown {
  const target = assertedJsonValue(runtime, response, pointer);
  if (!target.present) {
    runtime.recordComparison(null, check.expected);
    throw new RuntimeError(
      "assertion_mismatch",
      `Response does not match ${check.mismatch}${target.diagnostic ? `; missing JSON pointer: ${target.diagnostic}` : ""}`,
      "failed",
    );
  }
  try {
    validateAgainstSchema(schema, target.value);
    return target.value;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    // A schema that cannot be compiled says nothing about the response: the check could not be
    // evaluated, which is not an assertion failure.
    if (error instanceof SourceSchemaError)
      throw new RuntimeError(
        "oracle_uncertain",
        `${check.unusable} cannot be used for validation: ${error.problem}`,
        "inconclusive",
      );
    if (!(error instanceof ContractError))
      throw new RuntimeError(
        "oracle_uncertain",
        `${check.unusable} could not be evaluated: ${error instanceof Error ? error.message.slice(0, 256) : "unknown error"}`,
        "inconclusive",
      );
    const violations = schemaViolations(error);
    runtime.recordComparison(schemaObservation(runtime, violations, target.value), check.expected);
    const first = violations.items[0];
    throw new RuntimeError(
      "assertion_mismatch",
      `Response does not match ${check.mismatch}${
        first
          ? `: ${violations.total} violation${violations.total === 1 ? "" : "s"}; first at ${first.path || "/"}${first.property ? ` (${first.property})` : ""}: ${first.message}`
          : ""
      }`,
      "failed",
    );
  }
}

function deny(message: string): never {
  throw new RuntimeError("security_precondition_failed", message);
}
export function canonicalUrl(input: string, base?: string): URL {
  // Reject ambiguities before WHATWG URL normalization erases them.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: URL policy must reject ASCII controls before URL normalization.
  if (input.length > 8192 || /[\u0000-\u0020\u007f\\]/u.test(input)) deny("Ambiguous URL");
  const authority = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/iu.exec(input)?.[1];
  if (authority && /[%@]/u.test(authority)) deny("Invalid URL authority");
  let url: URL;
  try {
    url = base === undefined ? new URL(input) : new URL(input, base);
  } catch {
    return deny("Invalid URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
    deny("Unsupported URL");
  let host = url.hostname;
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.endsWith(".")) deny("Invalid hostname");
  if (authority && isIP(host) === 4 && authority.split(":")[0]?.replace(/\.$/u, "") !== host)
    deny("Noncanonical IPv4 address");
  url.hostname = host;
  return url;
}
/** Origin checking is local; DNS/address pinning is exclusively enforced by the mandatory gateway. */
export function authorizeUrl(runtime: Runtime, input: string, base?: string): URL {
  const url = canonicalUrl(input, base);
  if (
    !runtime.input.networkPolicy.allowedOrigins.some(
      (origin) => canonicalUrl(origin).origin === url.origin,
    )
  )
    throw new RuntimeError("egress_denied", "Origin is not allowed");
  return url;
}

export function jsonPointerValue(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/") || /~(?![01])/u.test(pointer)) deny("Invalid JSON Pointer");
  let current = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const token = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, token))
      throw new RuntimeError(
        "insufficient_evidence",
        "JSON Pointer target is absent",
        "inconclusive",
      );
    if (Array.isArray(current) && !/^(?:0|[1-9][0-9]*)$/u.test(token))
      deny("Invalid array JSON Pointer");
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}
function responseJson(response: HttpResponse): unknown {
  try {
    return parseStrictJson(response.body, response.body.byteLength);
  } catch {
    const type = response.headers["content-type"];
    throw new RuntimeError(
      "assertion_mismatch",
      `Response is not valid JSON (status ${response.status}, content-type ${type === undefined ? "absent" : JSON.stringify(type.slice(0, 100))})`,
      "failed",
    );
  }
}
/** The whole body as UTF-8 text (a leading BOM dropped); bytes that are not UTF-8 fail the assertion. */
function responseText(response: HttpResponse): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(response.body);
  } catch {
    throw new RuntimeError("assertion_mismatch", "Response body is not UTF-8 text", "failed");
  }
}
/**
 * A complete, valid JSON response that lacks the asserted target contradicts the expectation
 * (e.g. a renamed field or a missing record): it is an observation, not missing evidence.
 * Captures keep treating an absent target as insufficient evidence.
 */
/** Only structure, never response values; the step error transports this bounded diagnostic. */
function missingPointerStructure(runtime: Runtime, json: unknown, pointer: string): string {
  let current = json;
  const resolved: string[] = [];
  for (const encoded of pointer.slice(1).split("/")) {
    const token = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, token)) {
      const type = current === null ? "null" : Array.isArray(current) ? "array" : typeof current;
      const keys = type === "object" ? Object.keys(current as object) : [];
      return JSON.stringify({
        deepestPrefix: runtime.scrub(resolved.length ? `/${resolved.join("/")}` : "").slice(0, 512),
        type,
        ...(type === "object"
          ? {
              keys: keys
                .sort()
                .slice(0, 32)
                .map((key) => runtime.scrub(key).slice(0, 64))
                .sort(),
              unlistedKeyCount: Math.max(0, keys.length - 32),
            }
          : type === "array"
            ? { length: (current as unknown[]).length }
            : {}),
        firstUnresolvedToken: runtime.scrub(token).slice(0, 64),
      });
    }
    resolved.push(encoded);
    current = (current as Record<string, unknown>)[token];
  }
  throw new Error("Missing-pointer diagnostic requires an unresolved target");
}
function assertedJsonValue(
  runtime: Runtime,
  response: HttpResponse,
  pointer: string | undefined,
): { present: boolean; value: unknown; diagnostic?: string } {
  const json = responseJson(response);
  try {
    return { present: true, value: jsonPointerValue(json, pointer ?? "") };
  } catch (error) {
    if (error instanceof RuntimeError && error.reasonCode === "insufficient_evidence")
      return {
        present: false,
        value: null,
        diagnostic: missingPointerStructure(runtime, json, pointer ?? ""),
      };
    throw error;
  }
}
/**
 * What `xmlPath` selects in the XML body: the string value of the first node for the text
 * predicates, the number of nodes for the counts. A body that is not well-formed XML fails.
 */
async function assertXmlResponse(
  runtime: Runtime,
  response: HttpResponse,
  expectation: Expectation,
  xmlPath: string,
): Promise<void> {
  let selection: XmlSelection;
  try {
    parseXmlPath(xmlPath);
  } catch (error) {
    throw new RuntimeError("security_precondition_failed", (error as Error).message);
  }
  try {
    selection = selectXmlPath(responseText(response), xmlPath);
  } catch (error) {
    recordFailedComparison(runtime, { xmlPath, wellFormed: false }, { xmlPath });
    throw new RuntimeError(
      "assertion_mismatch",
      `HTTP ${expectation.predicate} on xmlPath ${xmlPath}: the response body is not XML (${runtime.scrub((error as Error).message).slice(0, 300)})`,
      "failed",
    );
  }
  let matches: boolean;
  let observed: unknown;
  let expected: unknown;
  switch (expectation.predicate) {
    case "textEquals":
    case "textContains": {
      const wanted = await runtime.resolve(expectation.value);
      if (typeof wanted !== "string")
        throw new RuntimeError(
          "security_precondition_failed",
          "Text expectation must resolve to a string",
        );
      observed = selection.text;
      expected = wanted;
      matches =
        selection.text !== null &&
        (expectation.predicate === "textEquals"
          ? selection.text === wanted
          : selection.text.includes(wanted));
      break;
    }
    case "countEquals":
    case "countAtLeast":
    case "countAtMost":
      observed = selection.count;
      expected =
        expectation.predicate === "countEquals"
          ? expectation.value
          : expectation.predicate === "countAtLeast"
            ? { atLeast: expectation.value }
            : { atMost: expectation.value };
      matches =
        expectation.predicate === "countEquals"
          ? selection.count === expectation.value
          : expectation.predicate === "countAtLeast"
            ? selection.count >= expectation.value
            : selection.count <= expectation.value;
      break;
    default:
      throw new RuntimeError(
        "security_precondition_failed",
        `xmlPath is read by ${XML_PATH_PREDICATES.join(", ")} only`,
      );
  }
  if (matches) {
    runtime.recordComparison(observed, expected);
    return;
  }
  recordFailedComparison(runtime, observed, expected);
  throw new RuntimeError(
    "assertion_mismatch",
    `HTTP ${expectation.predicate} expectation was not satisfied at xmlPath ${xmlPath}${selection.count === 0 ? ": the path selects no node" : ""}`,
    "failed",
  );
}
export async function assertResponse(
  runtime: Runtime,
  response: HttpResponse,
  expectation: Expectation,
  pointer?: string,
  xmlPath?: string,
): Promise<void> {
  if (xmlPath !== undefined) {
    if (pointer !== undefined)
      throw new RuntimeError(
        "security_precondition_failed",
        "A response check takes jsonPointer or xmlPath, not both",
      );
    return assertXmlResponse(runtime, response, expectation, xmlPath);
  }
  let matches = false;
  let observed: unknown;
  let expected: unknown;
  let missingDiagnostic: string | undefined;
  switch (expectation.predicate) {
    case "statusIn":
      observed = response.status;
      expected = expectation.values;
      matches = expectation.values.includes(response.status);
      break;
    case "headerEquals": {
      const header = response.headers[expectation.header.toLowerCase()];
      const wanted = await runtime.resolve(expectation.value);
      matches = isDeepStrictEqual(header ?? null, wanted);
      if (CREDENTIAL_HEADER[expectation.header.toLowerCase()]) {
        observed = credentialHeaderObservation(response, expectation.header, header, matches);
        expected = { value: REDACTED_VALUE };
      } else {
        observed = header ?? null;
        expected = wanted;
      }
      break;
    }
    case "headerMatches": {
      let pattern: RegExp;
      try {
        if (expectation.pattern.length > patternMaxLength)
          throw new RangeError("Pattern is too long");
        pattern = new RegExp(expectation.pattern, "u");
      } catch {
        throw new RuntimeError(
          "oracle_uncertain",
          "headerMatches pattern is not a valid bounded ECMAScript regular expression",
          "inconclusive",
        );
      }
      const header = response.headers[expectation.header.toLowerCase()];
      matches = header !== undefined && pattern.test(header);
      observed = CREDENTIAL_HEADER[expectation.header.toLowerCase()]
        ? credentialHeaderObservation(response, expectation.header, header, matches)
        : (header ?? null);
      expected = { matches: expectation.pattern };
      break;
    }
    case "cookieAbsent":
      observed = response.cookieNames;
      expected = { absent: expectation.name };
      matches = !response.cookieNames.includes(expectation.name);
      break;
    case "textEquals":
    case "textContains": {
      if (pointer !== undefined)
        throw new RuntimeError(
          "security_precondition_failed",
          "A text assertion reads the whole response body and takes no jsonPointer",
        );
      const wanted = await runtime.resolve(expectation.value);
      if (typeof wanted !== "string")
        throw new RuntimeError(
          "security_precondition_failed",
          "Text expectation must resolve to a string",
        );
      const text = responseText(response);
      observed = text;
      expected = wanted;
      matches = expectation.predicate === "textEquals" ? text === wanted : text.includes(wanted);
      break;
    }
    case "jsonEquals": {
      const target = assertedJsonValue(runtime, response, pointer);
      missingDiagnostic = target.diagnostic;
      observed = target.value;
      expected = await runtime.resolve(expectation.value);
      matches = target.present && isDeepStrictEqual(observed, expected);
      break;
    }
    case "countEquals":
    case "countAtLeast":
    case "countAtMost": {
      const { value, diagnostic } = assertedJsonValue(runtime, response, pointer);
      missingDiagnostic = diagnostic;
      observed = Array.isArray(value) ? value.length : value;
      expected =
        expectation.predicate === "countEquals"
          ? expectation.value
          : expectation.predicate === "countAtLeast"
            ? { atLeast: expectation.value }
            : { atMost: expectation.value };
      matches =
        Array.isArray(value) &&
        (expectation.predicate === "countEquals"
          ? value.length === expectation.value
          : expectation.predicate === "countAtLeast"
            ? value.length >= expectation.value
            : value.length <= expectation.value);
      break;
    }
    case "jsonSchema": {
      const schemas = runtime.input.schemas ?? {};
      const key = `${expectation.sourceRevisionId}${expectation.pointer}`;
      let schema: unknown;
      if (Object.hasOwn(schemas, key)) schema = schemas[key];
      else if (Object.hasOwn(schemas, expectation.sourceRevisionId))
        schema = jsonPointerValue(schemas[expectation.sourceRevisionId], expectation.pointer);
      else
        throw new RuntimeError(
          "unsupported_capability",
          "Named source schema is absent from snapshot",
        );
      if (!schema || typeof schema !== "object" || Array.isArray(schema))
        deny("Invalid source schema");
      // The schema document can be far larger than a step record; the failure names it instead.
      expected = { sourceRevisionId: expectation.sourceRevisionId, pointer: expectation.pointer };
      observed = conformingValue(runtime, response, pointer, schema as Record<string, unknown>, {
        expected,
        mismatch: "source schema",
        unusable: `Source schema ${key}`,
      });
      matches = true;
      break;
    }
    case "jsonConforms":
      expected = expectation.schema;
      observed = conformingValue(runtime, response, pointer, expectation.schema, {
        expected,
        mismatch: "inline schema",
        unusable: "Inline schema",
      });
      matches = true;
      break;
    default:
      throw new RuntimeError(
        "unsupported_capability",
        `HTTP predicate ${expectation.predicate} is unsupported`,
      );
  }
  if (matches) runtime.recordComparison(observed, expected);
  else recordFailedComparison(runtime, observed, expected);
  if (!matches && response.status === 401 && response.authenticated)
    throw new RuntimeError(
      "manual_auth_required",
      "Static credentials were rejected by the target",
    );
  if (!matches)
    throw new RuntimeError(
      "assertion_mismatch",
      `HTTP ${expectation.predicate} expectation was not satisfied${missingDiagnostic ? `; missing JSON pointer: ${missingDiagnostic}` : ""}`,
      "failed",
    );
}

/** Pins every ancestor descriptor and rejects links, special files and snapshot size changes. */
export async function readAuthorizedArtifact(
  runtime: Runtime,
  artifactRef: string,
  declaredMimeType?: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const artifact = runtime.input.artifacts?.[artifactRef];
  if (!artifact || (declaredMimeType !== undefined && artifact.mimeType !== declaredMimeType))
    deny("Artifact is not authorized with that MIME type");
  const limit = runtime.input.bodyBytes ?? DEFAULT_BODY_BYTES;
  if (
    !Number.isSafeInteger(artifact.sizeBytes) ||
    artifact.sizeBytes < 0 ||
    artifact.sizeBytes > limit
  )
    deny("Artifact size exceeds request limit");
  const containerRoot = "/run/testmaster/input/";
  const relativePath = artifact.path.startsWith(containerRoot)
    ? artifact.path.slice(containerRoot.length)
    : artifact.path;
  const parts = relativePath.split("/");
  if (
    !relativePath ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Artifact paths reject every ASCII control.
    /[\u0000-\u001f\\:]/u.test(artifact.path) ||
    parts.some((part) => !part || part === "." || part === "..")
  )
    deny("Unsafe artifact path");
  const directories: number[] = [];
  try {
    let fd = openSync(
      "/run/testmaster/input",
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    directories.push(fd);
    for (const part of parts.slice(0, -1)) {
      fd = openSync(
        `/proc/self/fd/${fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      directories.push(fd);
    }
    const file = await open(
      `/proc/self/fd/${fd}/${parts[parts.length - 1]}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== artifact.sizeBytes)
        deny("Artifact must be an unchanged regular single-link file");
      const bytes = Buffer.alloc(artifact.sizeBytes);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) deny("Artifact changed while reading");
        offset += bytesRead;
      }
      const extra = Buffer.alloc(1);
      if ((await file.read(extra, 0, 1, offset)).bytesRead) deny("Artifact exceeds snapshot size");
      return { bytes, mimeType: artifact.mimeType };
    } finally {
      await file.close();
    }
  } finally {
    for (let i = directories.length - 1; i >= 0; i--) {
      const directory = directories[i];
      if (directory !== undefined) closeSync(directory);
    }
  }
}
interface InvalidCredentialSpec {
  scheme?: string;
  cookie?: string;
}
function isInvalidCredential(
  value: unknown,
): value is { invalidCredential: InvalidCredentialSpec } {
  return typeof value === "object" && value !== null && "invalidCredential" in value;
}
/** The invalid credentials a request sends, by lower-cased header: what was sent, never its value. */
function invalidCredentialsOf(
  headers: Record<string, unknown> | undefined,
): ({ header: string } & InvalidCredentialSpec)[] {
  return Object.entries(headers ?? {}).flatMap(([name, value]) =>
    isInvalidCredential(value) ? [{ header: name.toLowerCase(), ...value.invalidCredential }] : [],
  );
}
/**
 * A credential the first hop of a request sent, by lower-cased header: where it came from and a
 * non-secret reference to it (a secret id, a variable reference, the names of the profile's
 * cookies). Never the value, never a prefix of it.
 */
type SentCredential = { header: string } & (
  | { source: "secret"; secretRef: string }
  | { source: "variable"; variableRef: string }
  | { source: "authProfile"; cookies?: string[] }
);
/** The credentials the request's own headers carry: a `secretRef` or a sensitive variable. */
function requestCredentialsOf(
  runtime: Runtime,
  headers: Record<string, unknown> | undefined,
): SentCredential[] {
  return Object.entries(headers ?? {}).flatMap(([name, value]): SentCredential[] => {
    if (!value || typeof value !== "object" || isInvalidCredential(value)) return [];
    const header = name.toLowerCase();
    if ("secretRef" in value)
      return [{ header, source: "secret", secretRef: String(value.secretRef) }];
    if ("variableRef" in value && sensitiveInput(runtime, value))
      return [{ header, source: "variable", variableRef: String(value.variableRef) }];
    return [];
  });
}
/** The credentials of the auth profile session a hop sent: its header names and cookie names. */
function profileCredentialsOf(
  session: ProfileSession,
  cookies: readonly StoredCookie[],
): SentCredential[] {
  const credentials = new Map<string, SentCredential>(
    Object.keys(session.headers).map((header) => [header, { header, source: "authProfile" }]),
  );
  if (cookies.length > 0)
    credentials.set("cookie", {
      header: "cookie",
      source: "authProfile",
      cookies: [...new Set(cookies.map(({ name }) => name))],
    });
  return [...credentials.values()];
}
/**
 * Names of the cookies a `Set-Cookie` header sets; a value is never kept. A header that removes
 * its cookie (RFC 6265: `Max-Age` <= 0, or without `Max-Age` an `Expires` in the past) sets
 * nothing, so a response that clears a session cookie still satisfies `cookieAbsent`.
 */
function setCookieNames(header: string | string[] | undefined): string[] {
  const names: string[] = [];
  for (const cookie of header === undefined ? [] : Array.isArray(header) ? header : [header]) {
    const [pair = "", ...attributes] = cookie.split(";");
    const name = pair.includes("=") ? pair.slice(0, pair.indexOf("=")).trim() : "";
    if (name && !removesCookie(attributes)) names.push(name);
  }
  return names;
}
function removesCookie(attributes: readonly string[]): boolean {
  // The last occurrence of an attribute wins (RFC 6265 §5.3).
  const values = new Map<string, string>();
  for (const attribute of attributes) {
    const at = attribute.indexOf("=");
    if (at > 0)
      values.set(attribute.slice(0, at).trim().toLowerCase(), attribute.slice(at + 1).trim());
  }
  const maxAge = values.get("max-age");
  if (maxAge !== undefined && /^-?\d+$/u.test(maxAge)) return Number(maxAge) <= 0;
  const expires = values.get("expires");
  return expires !== undefined && Date.parse(expires) <= Date.now();
}
/**
 * The header credentials of the environment's auth profile: each vault secret as `header`, after
 * its `prefix`. A forbidden or duplicate header name denies the run.
 */
export async function loadProfileHeaders(runtime: Runtime): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const credential of runtime.input.auth?.credentials ?? []) {
    const name = credential.header.toLowerCase();
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name) ||
      FORBIDDEN_HEADER[name] ||
      name.startsWith("proxy-") ||
      name.startsWith("x-forwarded-") ||
      Object.hasOwn(headers, name)
    )
      deny("Forbidden or duplicate auth profile header");
    const secret = scalar(await runtime.resolve({ secretRef: credential.secretRef }));
    const value = `${credential.prefix ?? ""}${secret}`;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Header values reject NUL and line breaks.
    if (/[\r\n\u0000]/u.test(value)) deny("Invalid auth profile header value");
    headers[name] = value;
  }
  return headers;
}
/** The artifacts a request step writes for its response; assertions that read it cite them too. */
const httpEvidencePath = (stepId: string): string => `http/${stepId}.json`;
const httpBodiesPath = (stepId: string): string => `http/${stepId}-bodies.json`;
/** What a credential-header assertion records in place of the header value. */
const REDACTED_VALUE = "[REDACTED]";
/** Shorter issued values are flags and counters, never credentials; scrubbing them would corrupt evidence. */
const MIN_ISSUED_CREDENTIAL_LENGTH = 8;
/**
 * The observation of a credential-header assertion: whether the header was present, the names of
 * the cookies it set with their values redacted, and the verdict. The value is never recorded.
 */
function credentialHeaderObservation(
  response: HttpResponse,
  header: string,
  value: string | undefined,
  matches: boolean,
): unknown {
  const name = header.toLowerCase();
  const present = value !== undefined;
  if (name === "set-cookie")
    return {
      header: name,
      present,
      cookies: response.cookieNames.map((cookie) => ({ name: cookie, value: REDACTED_VALUE })),
      matches,
    };
  return { header: name, present, ...(present ? { value: REDACTED_VALUE } : {}), matches };
}
/**
 * Credential values a response issued (`Set-Cookie` values, a returned `Authorization` or API-key
 * header). The target chose them, so they are unknown until now; they join the attempt's scrub
 * set before any evidence is written.
 */
function issuedCredentials(headers: Record<string, string | string[] | undefined>): string[] {
  const found: string[] = [];
  for (const [header, raw] of Object.entries(headers)) {
    const name = header.toLowerCase();
    if (!CREDENTIAL_HEADER[name] || raw === undefined) continue;
    for (const entry of Array.isArray(raw) ? raw : [raw]) {
      if (name === "set-cookie") {
        const pair = entry.split(";", 1)[0] ?? "";
        const value = pair.slice(pair.indexOf("=") + 1).trim();
        found.push(value, value.replace(/^"(.*)"$/u, "$1"));
      } else {
        const value = entry.trim();
        // `Bearer <token>`: the token alone must be scrubbed as well as the whole header.
        found.push(value, value.replace(/^\S+\s+/u, ""));
      }
    }
  }
  return found.filter((value) => value.length >= MIN_ISSUED_CREDENTIAL_LENGTH);
}
function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
    return String(value);
  return deny("HTTP component must be a scalar");
}
function sensitiveInput(runtime: Runtime, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if ("secretRef" in value) return true;
  if ("variableRef" in value)
    return runtime.variables.get(String(value.variableRef))?.sensitive ?? false;
  return Object.values(value).some((child) => sensitiveInput(runtime, child));
}
function addSensitive(runtime: Runtime, value: unknown): void {
  // Booleans and null are never secrets, and scrubbing them corrupts any evidence that holds
  // `true`, `false` or `null`. A declared-sensitive capture still scrubs its string and number leaves.
  if (typeof value === "string" || typeof value === "number") runtime.secrets.add(String(value));
  else if (value && typeof value === "object") {
    runtime.secrets.add(JSON.stringify(value));
    for (const child of Object.values(value)) addSensitive(runtime, child);
  }
}

export class HttpEngine {
  readonly responses = new Map<string, HttpResponse>();
  private readonly resources: OwnedResource[] = [];
  private profile: Promise<ProfileSession> | undefined;
  private dispatcher: Dispatcher | undefined;
  private readonly ownsDispatcher: boolean;
  private readonly attemptTime: Stopwatch;
  constructor(
    readonly runtime: Runtime,
    options: HttpEngineOptions = {},
  ) {
    this.attemptTime = runtime.clock.stopwatch();
    this.dispatcher = options.dispatcher;
    this.ownsDispatcher = options.dispatcher === undefined;
  }
  private getDispatcher(): Dispatcher {
    if (!this.dispatcher) {
      const proxy = process.env.TESTMASTER_EGRESS_PROXY;
      if (!proxy)
        throw new RuntimeError("security_precondition_failed", "Mandatory egress proxy is missing");
      let proxyUrl: URL;
      try {
        proxyUrl = new URL(proxy);
      } catch {
        throw new RuntimeError("security_precondition_failed", "Mandatory egress proxy is invalid");
      }
      if (
        proxyUrl.protocol !== "http:" ||
        proxyUrl.username ||
        proxyUrl.password ||
        !proxyUrl.hostname ||
        !proxyUrl.port
      )
        throw new RuntimeError("security_precondition_failed", "Mandatory egress proxy is invalid");
      this.dispatcher = new ProxyAgent(proxyUrl.href);
    }
    return this.dispatcher;
  }
  async perform(step: PlanStep): Promise<void> {
    if (step.operation === "request") {
      const response = await this.send(
        step.id,
        step.input,
        stepTimeoutMs(step, this.runtime.input),
        this.runtime.signal,
        true,
      );
      this.responses.set(step.id, response);
      return;
    }
    if (step.kind === "assertion" && "responseStepId" in step.input) {
      const response = this.responses.get(step.input.responseStepId);
      if (!response) throw new RuntimeError("upstream_failed", "Response binding is unavailable");
      // The response is what this step judges: cite its artifacts whether the assertion passes or
      // fails, so the step points at the evidence its request step produced.
      this.runtime.reference([
        httpEvidencePath(step.input.responseStepId),
        ...(this.runtime.input.policy?.httpBodies === true
          ? [httpBodiesPath(step.input.responseStepId)]
          : []),
      ]);
      await assertResponse(
        this.runtime,
        response,
        step.expectation,
        step.input.jsonPointer,
        step.input.xmlPath,
      );
      return;
    }
    throw new RuntimeError(
      "unsupported_capability",
      `HTTP operation ${step.operation} is unsupported`,
    );
  }
  /** The JSON document of a body: `value` resolved, then every `set` entry placed by pointer. */
  private async jsonDocument(
    body: Extract<NonNullable<RequestInput["body"]>, { kind: "json" }>,
  ): Promise<JsonValue> {
    // Resolved values are plan literals, JSON captures or secret strings: JSON by construction.
    let document = (await this.runtime.resolve(body.value)) as JsonValue;
    for (const entry of body.set ?? []) {
      const value = (await this.runtime.resolve(entry.value)) as JsonValue;
      try {
        document = setJsonPointer(document, entry.pointer, value);
      } catch (error) {
        if (error instanceof JsonSetError) deny(`Invalid JSON body set entry: ${error.message}`);
        throw error;
      }
    }
    return document;
  }
  /** The auth profile session the host prepared: stored cookies and header credentials. */
  private profileSession(): Promise<ProfileSession> {
    this.profile ??= this.loadProfileSession();
    return this.profile;
  }
  private async loadProfileSession(): Promise<ProfileSession> {
    const runtime = this.runtime;
    const auth = runtime.input.auth;
    const cookies = auth?.storageState
      ? parseStorageCookies(
          String(await runtime.resolve({ secretRef: auth.storageState.secretRef })),
        )
      : [];
    const headers = await loadProfileHeaders(runtime);
    if (cookies.length === 0 && Object.keys(headers).length === 0)
      throw new RuntimeError(
        "missing_secret",
        "The environment has no usable auth profile session",
        "blocked",
      );
    return { cookies, headers };
  }
  /**
   * Adds the profile session to the headers of one hop of a `auth: "profile"` request, and names
   * the credentials it added. The first hop must target an environment origin and must have a
   * credential to send, otherwise the run is blocked before anything is sent; a redirect hop only
   * receives it on a target origin.
   */
  private async withProfileSession(
    headers: Record<string, string>,
    url: URL,
    first: boolean,
  ): Promise<{ headers: Record<string, string>; credentials: SentCredential[] } | undefined> {
    const runtime = this.runtime;
    const additional = (runtime.input.networkPolicy.additionalOrigins ?? []).map(
      (origin) => canonicalUrl(origin).origin,
    );
    const target = runtime.input.networkPolicy.allowedOrigins
      .map((origin) => canonicalUrl(origin).origin)
      .filter((origin) => !additional.includes(origin));
    if (!target.includes(url.origin)) {
      if (first) deny("The auth profile session can only be sent to the environment's origins");
      return undefined;
    }
    const session = await this.profileSession();
    const applied = { ...session.headers };
    const cookies = matchingCookies(session.cookies, url, Date.now() / 1000);
    for (const cookie of cookies) runtime.secrets.add(cookie.value);
    for (const value of Object.values(session.headers)) runtime.secrets.add(value);
    const cookie = cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
    if (cookie) applied.cookie = applied.cookie ? `${applied.cookie}; ${cookie}` : cookie;
    if (Object.keys(applied).length === 0) {
      if (!first) return undefined;
      throw new RuntimeError(
        "missing_secret",
        "The auth profile session has no credential for this request",
        "blocked",
      );
    }
    if (Object.keys(applied).some((name) => Object.hasOwn(headers, name)))
      deny("A request header conflicts with the auth profile credential");
    return {
      headers: { ...headers, ...applied },
      credentials: profileCredentialsOf(session, cookies),
    };
  }
  private async prepare(
    input: RequestInput,
  ): Promise<{ url: URL; headers: Record<string, string>; body: string | Uint8Array | undefined }> {
    const runtime = this.runtime;
    const base = authorizeUrl(runtime, runtime.input.baseUrl);
    const segments: string[] = [];
    for (const value of input.pathSegments) {
      const segment = scalar(await runtime.resolve(value));
      if (segment === "." || segment === "..") deny("Dot path segments are forbidden");
      segments.push(encodeURIComponent(segment));
    }
    base.pathname = `${base.pathname.replace(/\/$/u, "")}/${segments.join("/")}`;
    base.search = "";
    for (const pair of input.query ?? []) {
      if (sensitiveInput(runtime, pair)) deny("Secrets cannot be transported in query strings");
      base.searchParams.append(
        scalar(await runtime.resolve(pair.name)),
        scalar(await runtime.resolve(pair.value)),
      );
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      const lower = name.toLowerCase();
      if (
        !/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(lower) ||
        Object.hasOwn(headers, lower) ||
        FORBIDDEN_HEADER[lower] ||
        lower.startsWith("proxy-") ||
        lower.startsWith("x-forwarded-")
      )
        deny("Forbidden or duplicate request header");
      let resolved: string;
      if (isInvalidCredential(value)) {
        const spec = value.invalidCredential;
        const refusal = invalidCredentialRefusal(lower, spec);
        if (refusal) deny(refusal);
        if (spec.scheme !== undefined && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/u.test(spec.scheme))
          deny("Invalid credential scheme");
        if (spec.cookie !== undefined && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,200}$/u.test(spec.cookie))
          deny("Invalid credential cookie name");
        // Fresh per request: the target can only reject it, and no run reuses another's value.
        const token = `testmaster-invalid-${randomBytes(16).toString("hex")}`;
        resolved =
          spec.cookie !== undefined
            ? `${spec.cookie}=${token}`
            : spec.scheme === undefined
              ? token
              : `${spec.scheme} ${token}`;
      } else {
        if (CREDENTIAL_HEADER[lower] && !sensitiveInput(runtime, value))
          deny("Credentials require a sensitive reference");
        resolved = scalar(await runtime.resolve(value));
      }
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Header values reject NUL and line breaks.
      if (/[\r\n\u0000]/u.test(resolved)) deny("Invalid request header value");
      headers[lower] = resolved;
    }
    let body: string | Uint8Array | undefined;
    let contentType: string | undefined;
    if (input.body) {
      switch (input.body.kind) {
        case "json":
          body = JSON.stringify(await this.jsonDocument(input.body));
          contentType = "application/json";
          break;
        case "text":
          body = scalar(await runtime.resolve(input.body.value));
          contentType = "text/plain";
          break;
        case "form": {
          const fields = new URLSearchParams();
          for (const field of input.body.fields)
            fields.append(
              scalar(await runtime.resolve(field.name)),
              scalar(await runtime.resolve(field.value)),
            );
          body = fields.toString();
          contentType = "application/x-www-form-urlencoded";
          break;
        }
        case "artifact": {
          const artifact = await readAuthorizedArtifact(
            runtime,
            input.body.artifactRef,
            input.body.mimeType,
          );
          body = artifact.bytes;
          contentType = artifact.mimeType;
          break;
        }
      }
      if (body === undefined) deny("Request body could not be serialized");
      // A text body is sent verbatim under any explicit media type (a malformed JSON payload is
      // text labelled JSON); the other kinds are serialized here, so their type is fixed.
      if (
        input.body.kind !== "text" &&
        headers["content-type"] &&
        headers["content-type"].split(";")[0]?.trim().toLowerCase() !== contentType?.toLowerCase()
      )
        deny("Request Content-Type disagrees with body");
      headers["content-type"] ??= contentType ?? "application/octet-stream";
      const size = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
      if (size > (runtime.input.bodyBytes ?? DEFAULT_BODY_BYTES))
        throw new RuntimeError("artifact_limit_exceeded", "Request body exceeds byte limit");
    }
    return { url: authorizeUrl(runtime, base.href), headers, body };
  }
  private async resourceEvent(type: string, resource: OwnedResource): Promise<void> {
    const { stepId: _stepId, ...payload } = resource;
    await this.runtime.emit(type, payload);
  }
  private async send(
    stepId: string,
    input: RequestInput,
    timeoutMs: number,
    signal: AbortSignal,
    track: boolean,
  ): Promise<HttpResponse> {
    const runtime = this.runtime;
    const remaining = track
      ? (runtime.input.timeoutMs ?? 300000) - this.attemptTime.elapsed()
      : timeoutMs;
    if (remaining <= 0)
      throw new RuntimeError("execution_deadline", "Attempt deadline expired", "inconclusive");
    timeoutMs = Math.max(1, Math.floor(Math.min(timeoutMs, remaining)));
    if (this.runtime.input.policy?.httpBodies && !this.runtime.input.policy.restrictedRaw)
      deny("Full HTTP bodies require restricted raw authorization");
    const started = performance.now();
    const dispatcher = this.getDispatcher();
    const prepared = await this.prepare(input);
    let resource: OwnedResource | undefined;
    if (track && input.resource) {
      if (sensitiveInput(runtime, input.resource.correlationKey))
        deny("Resource correlation keys cannot be sensitive");
      const correlationKey = scalar(await runtime.resolve(input.resource.correlationKey));
      if (
        !correlationKey ||
        correlationKey.length > 200 ||
        runtime.scrubSecrets(correlationKey) !== correlationKey
      )
        deny("Invalid resource correlation key");
      resource = {
        stepId,
        resourceId: uuidV7IdGenerator.next("res"),
        resourceType: input.resource.resourceType,
        correlationKey,
        state: "planned",
      };
      await this.resourceEvent("resource.intent", resource);
      this.resources.push(resource);
    }
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let sent = false;
    try {
      let { url, headers, body } = prepared;
      let method: RequestInput["method"] = input.method;
      const hops: RedirectHop[] = [];
      const cookieNames: string[] = [];
      let profileSent = false;
      const invalidCredentials = invalidCredentialsOf(input.headers);
      const fakeCredentials = new Set(invalidCredentials.map(({ header }) => header));
      // What the first hop sent. A redirect hop may drop or add credentials: `redirects` lists
      // the hops, `credentials` does not follow them.
      const credentials = requestCredentialsOf(runtime, input.headers);
      for (let redirects = 0; ; redirects++) {
        url = authorizeUrl(runtime, url.href);
        deadline.throwIfAborted();
        let outgoing = headers;
        if (input.auth === "profile") {
          const withSession = await this.withProfileSession(headers, url, redirects === 0);
          if (withSession) {
            outgoing = withSession.headers;
            profileSent = true;
            if (redirects === 0) credentials.push(...withSession.credentials);
          }
        }
        sent = true;
        const incoming = await request(url.href, {
          method,
          headers: { ...outgoing, [EGRESS_DIAGNOSTICS_HEADER]: "1" },
          ...(body === undefined ? {} : { body }),
          dispatcher,
          signal: deadline,
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
        });
        const responseHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(incoming.headers))
          if (value !== undefined)
            responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
        for (const name of setCookieNames(incoming.headers["set-cookie"]))
          if (!cookieNames.includes(name)) cookieNames.push(name);
        for (const credential of issuedCredentials(incoming.headers))
          runtime.secrets.add(credential);
        const upstreamFailure = responseHeaders[UPSTREAM_FAILURE_HEADER];
        if (upstreamFailure !== undefined) {
          // Only the egress proxy can emit this marker (it strips it from target responses). The
          // connection failed or was reset, so no response exists; the request may still have
          // reached the target, so the common transport mapping below decides the reason.
          // dump() discards the (empty) proxy body; destroy() would emit an unhandled AbortError.
          await incoming.body.dump().catch(() => undefined);
          throw new UpstreamFailure(upstreamFailure);
        }
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for await (const chunk of incoming.body) {
            const data = chunk as Buffer;
            bytes += data.byteLength;
            if (bytes > (runtime.input.bodyBytes ?? DEFAULT_BODY_BYTES))
              throw new RuntimeError(
                "artifact_limit_exceeded",
                "Response body exceeds byte limit",
                "inconclusive",
              );
            chunks.push(data);
          }
        } catch (error) {
          incoming.body.destroy();
          throw error;
        }
        if (
          input.redirect !== "manual" &&
          REDIRECT_STATUS[incoming.statusCode] &&
          responseHeaders.location
        ) {
          if (redirects >= 10)
            throw new RuntimeError("egress_denied", "HTTP redirect limit exceeded");
          const next = authorizeUrl(runtime, responseHeaders.location, url.href);
          if (next.origin !== url.origin) {
            headers = { ...headers };
            for (const header of Object.keys(CREDENTIAL_HEADER)) delete headers[header];
          }
          if (
            (incoming.statusCode === 303 && method !== "HEAD") ||
            ((incoming.statusCode === 301 || incoming.statusCode === 302) && method === "POST")
          ) {
            method = "GET";
            body = undefined;
            delete headers["content-type"];
          }
          hops.push({
            url: url.href,
            status: incoming.statusCode,
            location: responseHeaders.location,
          });
          url = next;
          continue;
        }
        const response: HttpResponse = {
          status: incoming.statusCode,
          headers: responseHeaders,
          body: Buffer.concat(chunks, bytes),
          url: url.href,
          redirects: hops,
          cookieNames,
          authenticated:
            profileSent ||
            Object.keys(headers).some(
              (name) =>
                (CREDENTIAL_HEADER[name] && !fakeCredentials.has(name)) ||
                sensitiveInput(runtime, input.headers?.[name]),
            ),
        };
        if (resource) {
          if (
            response.status >= 200 &&
            response.status < 300 &&
            input.resource?.handle !== undefined &&
            input.resource.ownerProof !== undefined
          ) {
            const json = responseJson(response);
            const handle = jsonPointerValue(json, input.resource.handle);
            const proof = jsonPointerValue(json, input.resource.ownerProof);
            if (
              handle === null ||
              handle === "" ||
              proof === null ||
              proof === false ||
              proof === ""
            )
              throw new RuntimeError(
                "oracle_uncertain",
                "Creation response lacks ownership evidence",
                "inconclusive",
              );
            if (typeof handle !== "string" && typeof handle !== "number")
              throw new RuntimeError(
                "oracle_uncertain",
                "Resource handle must be scalar",
                "inconclusive",
              );
            resource.handleRef = `${stepId}.handle`;
            runtime.variables.set(resource.handleRef, { value: String(handle), sensitive: true });
            addSensitive(runtime, String(handle));
            await runtime.emit("variable.captured", {
              name: "handle",
              valueType: "string",
              sensitive: true,
              value: { literal: String(handle) },
            });
            resource.ownerProof = {
              sha256: createHash("sha256").update(JSON.stringify(proof)).digest("hex"),
            };
            resource.state = "created";
            await this.resourceEvent("resource.created", resource);
          } else {
            resource.state = "uncertain";
            await this.resourceEvent("resource.uncertain", resource);
          }
        }
        await this.capture(stepId, input, response);
        const bindings: { variableRef: string; sensitive: boolean; resolved: unknown }[] = [];
        const collectBindings = (value: unknown): void => {
          if (!value || typeof value !== "object") return;
          if ("variableRef" in value) {
            const variableRef = String(value.variableRef);
            const variable = runtime.variables.get(variableRef);
            bindings.push({
              variableRef,
              sensitive: variable?.sensitive ?? false,
              resolved: variable?.sensitive ? "[REDACTED]" : variable?.value,
            });
          } else for (const child of Object.values(value)) collectBindings(child);
        };
        collectBindings({
          pathSegments: input.pathSegments,
          query: input.query,
          headers: input.headers,
          set: input.body?.kind === "json" ? input.body.set : undefined,
        });
        const requestBytes =
          typeof prepared.body === "string"
            ? Buffer.from(prepared.body)
            : (prepared.body ?? new Uint8Array());
        const evidence = {
          redirects: hops,
          request: {
            method: input.method,
            url: prepared.url.href,
            headers: Object.fromEntries(
              Object.entries(prepared.headers).filter(([name]) => EVIDENCE_HEADERS[name]),
            ),
            bodyMetadata: {
              sha256: createHash("sha256").update(requestBytes).digest("hex"),
              sizeBytes: requestBytes.byteLength,
              contentType: prepared.headers["content-type"] ?? null,
            },
            bindings,
            ...(invalidCredentials.length ? { invalidCredentials } : {}),
            ...(credentials.length ? { credentials } : {}),
          },
          captures: (input.capture ?? []).map((capture) => {
            const variable = runtime.variables.get(`${stepId}.${capture.name}`);
            return {
              name: capture.name,
              variableRef: `${stepId}.${capture.name}`,
              valueType: capture.valueType,
              sensitive: variable?.sensitive ?? capture.sensitive,
              resolved: variable?.sensitive ? "[REDACTED]" : variable?.value,
            };
          }),
          response: {
            status: response.status,
            url: response.url,
            headers: Object.fromEntries(
              Object.entries(response.headers).filter(([name]) => EVIDENCE_HEADERS[name]),
            ),
            bodyMetadata: {
              sha256: createHash("sha256").update(response.body).digest("hex"),
              sizeBytes: response.body.byteLength,
              contentType: response.headers["content-type"] ?? null,
            },
            failureExcerpt: failureExcerpt(runtime, response),
            durationMs: Math.max(0, performance.now() - started),
          },
        };
        await runtime.artifact(
          httpEvidencePath(stepId),
          "http",
          "application/json",
          Buffer.from(runtime.scrub(JSON.stringify(evidence))),
        );
        if (runtime.input.policy?.httpBodies === true)
          await runtime.artifact(
            httpBodiesPath(stepId),
            "restrictedRaw.http",
            "application/json",
            Buffer.from(
              runtime.scrub(
                JSON.stringify({
                  request: {
                    body: runtime.scrub(new TextDecoder().decode(requestBytes)),
                    encoding: "utf8",
                  },
                  response: {
                    body: runtime.scrub(new TextDecoder().decode(response.body)),
                    encoding: "utf8",
                  },
                }),
              ),
            ),
          );
        return response;
      }
    } catch (error) {
      if (resource && sent && resource.state === "planned") {
        resource.state = "uncertain";
        await this.resourceEvent("resource.uncertain", resource);
      }
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(
        resource && sent ? "retry_unsafe_external_effect" : "insufficient_evidence",
        "HTTP transport did not produce a complete usable response",
        "inconclusive",
        error instanceof UpstreamFailure && /^E[A-Z]+$/.test(error.code) ? error.code : undefined,
      );
    }
  }
  private async capture(
    stepId: string,
    input: RequestInput,
    response: HttpResponse,
  ): Promise<void> {
    const pending: { name: string; value: unknown; valueType: string; sensitive: boolean }[] = [];
    let json: unknown;
    let parsed = false;
    for (const capture of input.capture ?? []) {
      let value: unknown;
      if (capture.from === "jsonPointer") {
        if (!parsed) {
          json = responseJson(response);
          parsed = true;
        }
        value = jsonPointerValue(json, capture.pointer);
      } else {
        value = response.headers[capture.header.toLowerCase()];
        if (typeof value !== "string")
          throw new RuntimeError(
            "insufficient_evidence",
            "Capture header is absent",
            "inconclusive",
          );
        if (capture.valueType === "number") {
          if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(value))
            throw new RuntimeError("assertion_mismatch", "Header capture is not numeric", "failed");
          value = Number(value);
        } else if (capture.valueType === "boolean") {
          if (value !== "true" && value !== "false")
            throw new RuntimeError("assertion_mismatch", "Header capture is not boolean", "failed");
          value = value === "true";
        }
      }
      const actualType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      if (
        actualType !== capture.valueType ||
        (typeof value === "number" && !Number.isFinite(value))
      )
        throw new RuntimeError(
          "assertion_mismatch",
          "Captured value has wrong declared type",
          "failed",
        );
      pending.push({
        name: capture.name,
        value,
        valueType: capture.valueType,
        sensitive: capture.sensitive,
      });
    }
    for (const entry of pending) {
      this.runtime.variables.set(entry.name, { value: entry.value, sensitive: entry.sensitive });
      this.runtime.variables.set(`${stepId}.${entry.name}`, {
        value: entry.value,
        sensitive: entry.sensitive,
      });
      if (entry.sensitive) {
        addSensitive(this.runtime, entry.value);
        // This trusted IPC value is encrypted by the supervisor before durable observations.
        await this.runtime.emit("variable.captured", {
          name: entry.name,
          valueType: entry.valueType,
          sensitive: true,
          value: { literal: entry.value },
        });
      } else {
        await this.runtime.emit("variable.captured", {
          name: entry.name,
          valueType: entry.valueType,
          sensitive: false,
          value: { literal: entry.value },
        });
      }
    }
  }
  async cleanup(result: RunnerResult): Promise<RunnerResult> {
    let outcome: NonNullable<RunnerResult["cleanupOutcome"]> = "not_required";
    const declarations = this.runtime.input.plan?.cleanup ?? [];
    for (const resource of [...this.resources].reverse()) {
      const cleanup = declarations.find((entry) => entry.resourceRef === resource.stepId);
      if (
        resource.state !== "created" ||
        !resource.handleRef ||
        resource.ownerProof === undefined ||
        !cleanup
      ) {
        if (resource.state === "created" || resource.state === "uncertain") {
          resource.state = "orphaned";
          await this.resourceEvent("resource.cleanup", resource);
          if (outcome !== "failed") outcome = "inconclusive";
        }
        continue;
      }
      resource.state = "cleanup_pending";
      await this.resourceEvent("resource.cleanup", resource);
      try {
        if (
          this.runtime.signal.aborted &&
          /credential_revoked|owner_revoked/u.test(String(this.runtime.signal.reason))
        )
          throw new RuntimeError("credential_revoked", "Authorization revoked before cleanup");
        const response = await this.send(
          `cleanup-${resource.stepId}`,
          cleanup.input,
          cleanup.deadlineMs,
          new AbortController().signal,
          false,
        );
        await assertResponse(this.runtime, response, cleanup.successPredicate);
        resource.state = "cleaned";
        if (outcome === "not_required") outcome = "passed";
      } catch (error) {
        resource.state = "orphaned";
        if (error instanceof RuntimeError && error.outcome === "failed") outcome = "failed";
        else if (outcome !== "failed") outcome = "inconclusive";
      }
      await this.resourceEvent("resource.cleanup", resource);
    }
    return { ...result, cleanupOutcome: outcome };
  }
  async close(): Promise<void> {
    if (this.ownsDispatcher) await this.dispatcher?.close();
  }
}

export async function runHttp(runtime: Runtime): Promise<RunnerResult> {
  const unsupported = storageStateRefusal(runtime.input);
  if (unsupported) return unsupported;
  if (!runtime.input.plan)
    throw new RuntimeError("security_precondition_failed", "Executable HTTP plan is missing");
  const engine = new HttpEngine(runtime);
  try {
    const result = await runtime.runSteps(runtime.input.plan.steps, (step) => engine.perform(step));
    return await engine.cleanup(result);
  } finally {
    await engine.close();
  }
}
