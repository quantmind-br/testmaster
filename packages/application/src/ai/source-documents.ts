import type { ExecutablePlan } from "@testmaster/contracts";
import type { ServiceContext } from "../context.js";
import { flattenSteps } from "../plan-analysis.js";

/**
 * What an OpenAPI source revision exposes to plans: a document shaped like the original
 * (`/paths/<path>/<method>` with operations) plus the path prefix its first server declares. The
 * parser inlines every `$ref` whose target holds no recursion; each remaining (recursive)
 * reference reads `#/$defs/<pointer>` and its target lives in the operation's own `$defs`.
 */
export interface SourceView {
  document: { paths: Record<string, Record<string, unknown>> };
  /** Path segments of the first declared server URL, e.g. `["v1"]` for `https://host/v1`. */
  basePath: string[];
}

interface StoredRevision {
  result: {
    revision: { status: string };
    chunks?: { kind: string; text: string }[];
    inventory: { operations?: { path?: unknown; method?: unknown; operation?: unknown }[] };
  };
}

function serverBasePath(chunks: { kind: string; text: string }[] | undefined): string[] {
  const text = chunks?.find((chunk) => chunk.kind === "servers")?.text;
  if (!text) return [];
  let servers: unknown;
  try {
    servers = JSON.parse(text);
  } catch {
    return [];
  }
  const url = Array.isArray(servers) ? (servers[0] as { url?: unknown } | undefined)?.url : null;
  // A templated server URL has no single path to prefix.
  if (typeof url !== "string" || url.includes("{")) return [];
  try {
    return new URL(url, "http://source.invalid").pathname.split("/").filter(Boolean);
  } catch {
    return [];
  }
}

export function loadSourceView(ctx: ServiceContext, revisionId: string): SourceView | null {
  const row = ctx.database.get(
    "SELECT value FROM operational_state WHERE key=?",
    `ai:${ctx.workspaceId}:revision:${revisionId}`,
  );
  if (!row) return null;
  const state = JSON.parse(String(row.value)) as StoredRevision;
  const operations = state.result.inventory.operations;
  if (state.result.revision.status !== "ready" || !operations) return null;
  const paths: SourceView["document"]["paths"] = {};
  for (const { path, method, operation } of operations) {
    if (typeof path !== "string" || typeof method !== "string") continue;
    const methods = paths[path] ?? {};
    methods[method.toLowerCase()] = operation;
    paths[path] = methods;
  }
  return { document: { paths }, basePath: serverBasePath(state.result.chunks) };
}

function refersToDefinitions(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(refersToDefinitions);
  return Object.entries(node).some(([key, child]) =>
    // Only a string is a reference; an object under `$ref` is a property schema named "$ref".
    key === "$ref" && typeof child === "string"
      ? child.startsWith("#/$defs/")
      : refersToDefinitions(child),
  );
}

/**
 * The object at a JSON pointer, or undefined when the pointer does not reach one. A schema that
 * reaches recursive definitions comes back with its operation's `$defs` attached, so it validates
 * on its own wherever the pointer cuts into the operation.
 */
export function resolveSourceSchema(
  view: SourceView,
  pointer: string,
): Record<string, unknown> | undefined {
  if (pointer !== "" && !pointer.startsWith("/")) return undefined;
  let value: unknown = view.document;
  let definitions: unknown;
  for (const [index, token] of (pointer === "" ? [] : pointer.slice(1).split("/")).entries()) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
    if (index === 2 && value && typeof value === "object")
      definitions = (value as Record<string, unknown>).$defs;
  }
  // The whole document is not a schema for a response body.
  if (pointer === "" || !value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const schema = value as Record<string, unknown>;
  if (!definitions || typeof definitions !== "object" || !refersToDefinitions(schema))
    return schema;
  const own = schema.$defs && typeof schema.$defs === "object" ? schema.$defs : {};
  return { ...schema, $defs: { ...own, ...definitions } };
}

function schemaExpectations(plan: ExecutablePlan): { sourceRevisionId: string; pointer: string }[] {
  const found: { sourceRevisionId: string; pointer: string }[] = [];
  for (const step of flattenSteps(plan.steps))
    if (step.operation === "assert" && step.expectation.predicate === "jsonSchema")
      found.push({
        sourceRevisionId: step.expectation.sourceRevisionId,
        pointer: step.expectation.pointer,
      });
  return found;
}

/**
 * Runner input `schemas`: one entry per `jsonSchema` assertion, keyed by revision id + pointer.
 * Unresolvable references are left out so the runner blocks the step instead of validating
 * against the wrong document.
 */
export function sourceSchemasFor(
  ctx: ServiceContext,
  plan: ExecutablePlan | null,
): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  if (!plan) return schemas;
  const views = new Map<string, SourceView | null>();
  for (const { sourceRevisionId, pointer } of schemaExpectations(plan)) {
    if (!views.has(sourceRevisionId))
      views.set(sourceRevisionId, loadSourceView(ctx, sourceRevisionId));
    const view = views.get(sourceRevisionId);
    const schema = view ? resolveSourceSchema(view, pointer) : undefined;
    if (schema) schemas[`${sourceRevisionId}${pointer}`] = schema;
  }
  return schemas;
}

/** Pointers a `jsonSchema` assertion cites that do not reach a schema in the cited revision. */
export function unresolvedSchemaPointers(ctx: ServiceContext, plan: ExecutablePlan): string[] {
  const schemas = sourceSchemasFor(ctx, plan);
  return schemaExpectations(plan)
    .filter(({ sourceRevisionId, pointer }) => !(`${sourceRevisionId}${pointer}` in schemas))
    .map(({ sourceRevisionId, pointer }) => `${sourceRevisionId}#${pointer}`);
}

/**
 * Request paths are relative to the OpenAPI server URL but the environment base URL is an
 * origin, so every request must carry the server path prefix itself. Prefixes the literal
 * segments when the cited sources agree on one prefix and the request does not already start
 * with it.
 */
export function applyServerBasePath(
  ctx: ServiceContext,
  plan: ExecutablePlan,
  sourceRevisionIds: readonly string[],
): ExecutablePlan {
  const prefixes = new Set<string>();
  for (const id of new Set(sourceRevisionIds)) {
    const view = loadSourceView(ctx, id);
    if (view?.basePath.length) prefixes.add(JSON.stringify(view.basePath));
  }
  if (prefixes.size !== 1) return plan;
  const basePath = JSON.parse([...prefixes][0] as string) as string[];
  const clone = structuredClone(plan);
  for (const step of flattenSteps(clone.steps)) {
    if (step.operation !== "request") continue;
    const segments = step.input.pathSegments;
    const present = basePath.every((part, index) => {
      const segment = segments[index];
      return segment !== undefined && "literal" in segment && segment.literal === part;
    });
    if (!present)
      step.input.pathSegments = [...basePath.map((literal) => ({ literal })), ...segments];
  }
  return clone;
}
