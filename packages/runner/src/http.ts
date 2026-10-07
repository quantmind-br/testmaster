import { createHash } from "node:crypto";
import { closeSync, constants, openSync } from "node:fs";
import { open } from "node:fs/promises";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import {
  type Expectation,
  type PlanStep,
  parseStrictJson,
  validateAgainstSchema,
} from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { type Dispatcher, ProxyAgent, request } from "undici";
import { type RunnerResult, type Runtime, RuntimeError } from "./runtime.js";

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
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  url: string;
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

function deny(message: string): never {
  throw new RuntimeError("security_precondition_failed", message);
}
function canonicalUrl(input: string, base?: string): URL {
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
    throw new RuntimeError("assertion_mismatch", "Response is not valid JSON", "failed");
  }
}
export async function assertResponse(
  runtime: Runtime,
  response: HttpResponse,
  expectation: Expectation,
  pointer?: string,
): Promise<void> {
  let matches = false;
  switch (expectation.predicate) {
    case "statusIn":
      matches = expectation.values.includes(response.status);
      break;
    case "headerEquals":
      matches = isDeepStrictEqual(
        response.headers[expectation.header.toLowerCase()],
        await runtime.resolve(expectation.value),
      );
      break;
    case "jsonEquals":
      matches = isDeepStrictEqual(
        jsonPointerValue(responseJson(response), pointer ?? ""),
        await runtime.resolve(expectation.value),
      );
      break;
    case "countEquals": {
      const value = jsonPointerValue(responseJson(response), pointer ?? "");
      matches = Array.isArray(value) && value.length === expectation.value;
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
      try {
        validateAgainstSchema(
          schema as Record<string, unknown>,
          jsonPointerValue(responseJson(response), pointer ?? ""),
        );
        matches = true;
      } catch (error) {
        if (error instanceof RuntimeError) throw error;
        throw new RuntimeError(
          "assertion_mismatch",
          "Response does not match source schema",
          "failed",
        );
      }
      break;
    }
    default:
      throw new RuntimeError(
        "unsupported_capability",
        `HTTP predicate ${expectation.predicate} is unsupported`,
      );
  }
  if (!matches && response.status === 401 && response.authenticated)
    throw new RuntimeError(
      "manual_auth_required",
      "Static credentials were rejected by the target",
    );
  if (!matches)
    throw new RuntimeError(
      "assertion_mismatch",
      `HTTP ${expectation.predicate} expectation was not satisfied`,
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
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    runtime.secrets.add(String(value));
  else if (value && typeof value === "object") {
    runtime.secrets.add(JSON.stringify(value));
    for (const child of Object.values(value)) addSensitive(runtime, child);
  }
}

export class HttpEngine {
  readonly responses = new Map<string, HttpResponse>();
  private readonly resources: OwnedResource[] = [];
  private dispatcher: Dispatcher | undefined;
  private readonly ownsDispatcher: boolean;
  private readonly startedAt = performance.now();
  constructor(
    readonly runtime: Runtime,
    options: HttpEngineOptions = {},
  ) {
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
        step.timeoutMs ?? this.runtime.input.stepTimeoutMs ?? 30000,
        this.runtime.signal,
        true,
      );
      this.responses.set(step.id, response);
      return;
    }
    if (step.kind === "assertion" && "responseStepId" in step.input) {
      const response = this.responses.get(step.input.responseStepId);
      if (!response) throw new RuntimeError("upstream_failed", "Response binding is unavailable");
      await assertResponse(this.runtime, response, step.expectation, step.input.jsonPointer);
      return;
    }
    throw new RuntimeError(
      "unsupported_capability",
      `HTTP operation ${step.operation} is unsupported`,
    );
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
      if (CREDENTIAL_HEADER[lower] && !sensitiveInput(runtime, value))
        deny("Credentials require a sensitive reference");
      const resolved = scalar(await runtime.resolve(value));
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Header values reject NUL and line breaks.
      if (/[\r\n\u0000]/u.test(resolved)) deny("Invalid request header value");
      headers[lower] = resolved;
    }
    let body: string | Uint8Array | undefined;
    let contentType: string | undefined;
    if (input.body) {
      switch (input.body.kind) {
        case "json":
          body = JSON.stringify(await runtime.resolve(input.body.value));
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
      if (
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
      ? (runtime.input.timeoutMs ?? 300000) - (performance.now() - this.startedAt)
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
      for (let redirects = 0; ; redirects++) {
        url = authorizeUrl(runtime, url.href);
        deadline.throwIfAborted();
        sent = true;
        const incoming = await request(url.href, {
          method,
          headers,
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
        if (REDIRECT_STATUS[incoming.statusCode] && responseHeaders.location) {
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
          url = next;
          continue;
        }
        const response: HttpResponse = {
          status: incoming.statusCode,
          headers: responseHeaders,
          body: Buffer.concat(chunks, bytes),
          url: url.href,
          authenticated: Object.keys(headers).some(
            (name) => CREDENTIAL_HEADER[name] || sensitiveInput(runtime, input.headers?.[name]),
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
        });
        const requestBytes =
          typeof prepared.body === "string"
            ? Buffer.from(prepared.body)
            : (prepared.body ?? new Uint8Array());
        const evidence = {
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
          `http/${stepId}.json`,
          "http",
          "application/json",
          Buffer.from(runtime.scrub(JSON.stringify(evidence))),
        );
        if (runtime.input.policy?.httpBodies === true)
          await runtime.artifact(
            `http/${stepId}-bodies.json`,
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
        sensitive: capture.sensitive || sensitiveInput(this.runtime, input),
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
