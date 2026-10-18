import {
  assertSourceSchemaCompiles,
  ContractError,
  type ExecutablePlan,
  SourceSchemaError,
} from "@testmaster/contracts";
import { allEntities, type ServiceContext } from "../context.js";
import { flattenSteps } from "../plan-analysis.js";

type RequestPathSegments = NonNullable<ExecutablePlan["cleanup"]>[number]["input"]["pathSegments"];

/**
 * What an OpenAPI source revision exposes to plans: a document shaped like the original
 * (`/paths/<path>/<method>` with operations) plus the path prefix its first server declares. The
 * parser inlines every `$ref` whose target holds no recursion; each remaining (recursive)
 * reference reads `#/$defs/<pointer>` and its target lives in the operation's own `$defs`.
 *
 * Accepted `jsonSchema` pointers: `/paths/<path>/<method>/...` (inside one operation) and the
 * document-level `/components/...` (OpenAPI 3) or `/definitions/...` (Swagger 2) sections. A
 * document-level schema that still holds recursive `$ref`s comes back with those targets bundled
 * under its own `$defs`, so it validates on its own.
 */
export interface SourceView {
  document: {
    paths: Record<string, Record<string, unknown>>;
    components?: unknown;
    definitions?: unknown;
  };
  /** Path segments of the first declared server URL, e.g. `["v1"]` for `https://host/v1`. */
  basePath: string[];
}

/** Document-level sections a `jsonSchema` pointer may start with, besides `paths`. */
const DOCUMENT_SECTIONS = ["components", "definitions"] as const;

interface StoredRevision {
  result: {
    revision: { status: string };
    chunks?: { kind: string; text: string }[];
    inventory: { operations?: { path?: unknown; method?: unknown; operation?: unknown }[] };
  };
}

/**
 * The path every operation sits under: the first OpenAPI 3 server URL's path, or the Swagger 2
 * `basePath`.
 */
function serverBasePath(chunks: { kind: string; text: string }[] | undefined): string[] {
  const section = (kind: string): unknown => {
    const text = chunks?.find((chunk) => chunk.kind === kind)?.text;
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const servers = section("servers");
  const url = Array.isArray(servers)
    ? (servers[0] as { url?: unknown } | undefined)?.url
    : section("basePath");
  // A templated server URL has no single path to prefix.
  if (typeof url !== "string" || url.includes("{")) return [];
  try {
    return new URL(url, "http://source.invalid").pathname.split("/").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The source view of a stored revision, or null when it is not ready or has no operations. The
 * document-level sections (`components`, `definitions`) are parsed only when `sections` names
 * them, because they can be far larger than the operations.
 */
export function buildSourceView(
  state: StoredRevision,
  sections: readonly string[] = [],
): SourceView | null {
  const operations = state.result.inventory.operations;
  if (state.result.revision.status !== "ready" || !operations) return null;
  const paths: SourceView["document"]["paths"] = {};
  for (const { path, method, operation } of operations) {
    if (typeof path !== "string" || typeof method !== "string") continue;
    const methods = paths[path] ?? {};
    methods[method.toLowerCase()] = operation;
    paths[path] = methods;
  }
  const document: SourceView["document"] = { paths };
  for (const section of DOCUMENT_SECTIONS) {
    if (!sections.includes(section)) continue;
    const text = state.result.chunks?.find((chunk) => chunk.kind === section)?.text;
    if (!text) continue;
    try {
      document[section] = JSON.parse(text);
    } catch {
      // An unreadable section leaves its pointers unresolved.
    }
  }
  return { document, basePath: serverBasePath(state.result.chunks) };
}

export function loadSourceView(
  ctx: ServiceContext,
  revisionId: string,
  sections: readonly string[] = [],
): SourceView | null {
  const row = ctx.database.get(
    "SELECT value FROM operational_state WHERE key=?",
    `ai:${ctx.workspaceId}:revision:${revisionId}`,
  );
  if (!row) return null;
  return buildSourceView(JSON.parse(String(row.value)) as StoredRevision, sections);
}

function refersTo(node: unknown, prefix: string): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((child) => refersTo(child, prefix));
  return Object.entries(node).some(([key, child]) =>
    // Only a string is a reference; an object under `$ref` is a property schema named "$ref".
    key === "$ref" && typeof child === "string"
      ? child.startsWith(prefix)
      : refersTo(child, prefix),
  );
}

function valueAt(root: unknown, pointer: string): unknown {
  let value = root;
  for (const token of pointer.split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * Self-contained copy of a document-level schema: every `#/<pointer>` reference the parser left
 * in place (a recursive target) reads `#/$defs/<pointer>` and its target, rewritten the same way
 * and transitively, lives under the returned `$defs`. A reference that does not reach the
 * document makes the schema unresolvable.
 */
function bundleDocumentSchema(
  document: unknown,
  schema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const definitions: Record<string, unknown> = {};
  const pending: string[] = [];
  let broken = false;
  const rewrite = (node: unknown): unknown => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(rewrite);
    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => {
        if (key === "$ref" && typeof child === "string" && child.startsWith("#/")) {
          const target = child.slice(2);
          if (!Object.hasOwn(definitions, target) && !pending.includes(target))
            pending.push(target);
          return [key, `#/$defs/${target.replaceAll("~", "~0").replaceAll("/", "~1")}`];
        }
        return [key, rewrite(child)];
      }),
    );
  };
  const bundled = rewrite(schema) as Record<string, unknown>;
  for (let target = pending.shift(); target !== undefined; target = pending.shift()) {
    const found = valueAt(document, target);
    if (found === undefined) {
      broken = true;
      break;
    }
    definitions[target] = rewrite(found);
  }
  if (broken) return undefined;
  if (!Object.keys(definitions).length) return schema;
  const own = bundled.$defs && typeof bundled.$defs === "object" ? bundled.$defs : {};
  return { ...bundled, $defs: { ...own, ...definitions } };
}

/**
 * The object at a JSON pointer, or undefined when the pointer does not reach one. A schema inside
 * an operation that reaches recursive definitions comes back with its operation's `$defs`
 * attached; a document-level schema (`/components/...`, `/definitions/...`) comes back with its
 * recursive targets bundled under `$defs`. Either way it validates on its own.
 */
export function resolveSourceSchema(
  view: SourceView,
  pointer: string,
): Record<string, unknown> | undefined {
  if (pointer !== "" && !pointer.startsWith("/")) return undefined;
  let value: unknown = view.document;
  let definitions: unknown;
  const tokens = pointer === "" ? [] : pointer.slice(1).split("/");
  for (const [index, token] of tokens.entries()) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
    if (index === 2 && tokens[0] === "paths" && value && typeof value === "object")
      definitions = (value as Record<string, unknown>).$defs;
  }
  // The whole document is not a schema for a response body.
  if (pointer === "" || !value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const schema = value as Record<string, unknown>;
  if ((DOCUMENT_SECTIONS as readonly string[]).includes(tokens[0] ?? ""))
    return refersTo(schema, "#/") ? bundleDocumentSchema(view.document, schema) : schema;
  if (!definitions || typeof definitions !== "object" || !refersTo(schema, "#/$defs/"))
    return schema;
  const own = schema.$defs && typeof schema.$defs === "object" ? schema.$defs : {};
  return { ...schema, $defs: { ...own, ...definitions } };
}

/** One `jsonSchema` assertion of a plan and the source schema it cites. */
export interface SchemaCitation {
  stepId: string;
  sourceRevisionId: string;
  pointer: string;
}
export function schemaCitations(plan: ExecutablePlan): SchemaCitation[] {
  const found: SchemaCitation[] = [];
  for (const step of flattenSteps(plan.steps))
    if (step.operation === "assert" && step.expectation.predicate === "jsonSchema")
      found.push({
        stepId: step.id,
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
  const expectations = schemaCitations(plan);
  const views = new Map<string, SourceView | null>();
  for (const { sourceRevisionId } of expectations) {
    if (views.has(sourceRevisionId)) continue;
    const sections = expectations
      .filter((item) => item.sourceRevisionId === sourceRevisionId)
      .map(({ pointer }) => pointer.split("/")[1] ?? "");
    views.set(sourceRevisionId, loadSourceView(ctx, sourceRevisionId, sections));
  }
  for (const { sourceRevisionId, pointer } of expectations) {
    const view = views.get(sourceRevisionId);
    const schema = view ? resolveSourceSchema(view, pointer) : undefined;
    if (schema) schemas[`${sourceRevisionId}${pointer}`] = schema;
  }
  return schemas;
}

/** Pointers a `jsonSchema` assertion cites that do not reach a schema in the cited revision. */
export function unresolvedSchemaPointers(ctx: ServiceContext, plan: ExecutablePlan): string[] {
  const schemas = sourceSchemasFor(ctx, plan);
  return schemaCitations(plan)
    .filter(({ sourceRevisionId, pointer }) => !(`${sourceRevisionId}${pointer}` in schemas))
    .map(({ sourceRevisionId, pointer }) => `${sourceRevisionId}#${pointer}`);
}

/** A `jsonSchema` assertion whose cited schema resolves but the source-schema validator cannot compile. */
export interface UnusableSchema extends SchemaCitation {
  problem: string;
}
/** Cited schemas (as `sourceSchemasFor` resolved them) that cannot be compiled, one per citing step. */
export function unusableSchemas(
  citations: readonly SchemaCitation[],
  schemas: Record<string, unknown>,
): UnusableSchema[] {
  return citations.flatMap((citation) => {
    const schema = schemas[`${citation.sourceRevisionId}${citation.pointer}`];
    if (schema === undefined) return [];
    try {
      assertSourceSchemaCompiles(schema as Record<string, unknown>);
      return [];
    } catch (error) {
      if (!(error instanceof SourceSchemaError)) throw error;
      return [{ ...citation, problem: error.problem }];
    }
  });
}
/** What a refusal says about an uncompilable cited schema: the step, the pointer and the compile error. */
export function unusableSchemaText(item: UnusableSchema): string {
  return `Step ${JSON.stringify(item.stepId)} cites source schema ${item.sourceRevisionId}#${item.pointer}, which cannot be compiled: ${item.problem}`;
}
/**
 * Refuses a plan that cites a schema it cannot use: a pointer that reaches no schema in the cited
 * source revision (or a revision that does not exist) would block its `jsonSchema` step at run time,
 * and a schema the source-schema validator cannot compile would end it inconclusive, so both are
 * reported where the plan is saved.
 */
export function assertCitedSchemasUsable(ctx: ServiceContext, plan: ExecutablePlan): void {
  const citations = schemaCitations(plan);
  if (!citations.length) return;
  const schemas = sourceSchemasFor(ctx, plan);
  const unresolved = citations.filter(
    ({ sourceRevisionId, pointer }) => !(`${sourceRevisionId}${pointer}` in schemas),
  );
  if (unresolved.length)
    throw new ContractError(
      "INVALID_ARGUMENT",
      `${unresolved
        .map(
          ({ stepId, sourceRevisionId, pointer }) =>
            `Step ${JSON.stringify(stepId)} cites source schema ${sourceRevisionId}#${pointer}, which reaches no schema (the revision does not exist in this workspace or the pointer leads nowhere)`,
        )
        .join(
          "; ",
        )}; cite an existing source revision and a pointer to a schema in it, such as /paths/~1items/get/responses/200/content/application~1json/schema or /components/schemas/Item`,
      {
        reasonCode: "schema_pointer_unresolved",
        schemas: unresolved.map(({ stepId, sourceRevisionId, pointer }) => ({
          stepId,
          sourceRevisionId,
          pointer,
        })),
      },
    );
  const unusable = unusableSchemas(citations, schemas);
  if (unusable.length)
    throw new ContractError(
      "INVALID_ARGUMENT",
      `${unusable.map(unusableSchemaText).join("; ")}; fix the schema in a new source revision or cite another pointer`,
      {
        reasonCode: "source_schema_uncompilable",
        schemas: unusable.map(({ stepId, sourceRevisionId, pointer, problem }) => ({
          stepId,
          sourceRevisionId,
          pointer,
          problem,
        })),
      },
    );
}

/** One operation of an offered API specification and where its JSON response schemas live. */
export interface OfferedOperation {
  method: string;
  path: string;
  operationId?: string;
  /** The operation declares `security: []`, so it needs no credential. */
  public?: true;
  /** HTTP status to the `jsonSchema` pointer of that response's JSON schema. */
  responseSchemas: Record<string, string>;
}

/** An API specification of the project the planner may cite in a `jsonSchema` assertion. */
export interface OfferedApiSpec {
  sourceRevisionId: string;
  sourceName: string;
  operations: OfferedOperation[];
}

const escapePointerToken = (token: string): string =>
  token.replaceAll("~", "~0").replaceAll("/", "~1");

/** The parts of a parsed OpenAPI operation the catalog reads; the source parser validated the document. */
interface ParsedOperation {
  operationId?: unknown;
  security?: unknown;
  responses?: Record<string, { content?: Record<string, unknown>; schema?: unknown } | undefined>;
}

/**
 * The pointers of one operation's JSON response schemas. OpenAPI 3 keeps a schema under
 * `content/<media type>/schema`, Swagger 2 directly under the response; only pointers that
 * resolve exactly as a `jsonSchema` assertion's runner input does are offered.
 */
function responseSchemaPointers(
  view: SourceView,
  base: string,
  operation: ParsedOperation,
): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    const at = `${base}/responses/${escapePointerToken(status)}`;
    const candidates = response?.content
      ? Object.keys(response.content)
          .filter((mediaType) => /json/iu.test(mediaType))
          .map((mediaType) => `${at}/content/${escapePointerToken(mediaType)}/schema`)
      : [`${at}/schema`];
    const pointer = candidates.find((candidate) => resolveSourceSchema(view, candidate));
    if (pointer) found[status] = pointer;
  }
  return found;
}

/**
 * The operations of every API specification the project currently has (the active revision of
 * each source that parsed as one), so a plan can check a response against its schema although no
 * requirement cites that document. Archived sources and unreadable revisions offer nothing.
 */
export function offeredApiSpecs(ctx: ServiceContext, projectId: string): OfferedApiSpec[] {
  const specs: OfferedApiSpec[] = [];
  for (const source of allEntities(ctx, "Source")) {
    if (source.projectId !== projectId || !source.activeRevisionId) continue;
    const sourceRevisionId = String(source.activeRevisionId);
    const view = loadSourceView(ctx, sourceRevisionId);
    if (!view) continue;
    const operations: OfferedOperation[] = [];
    for (const [path, methods] of Object.entries(view.document.paths))
      for (const [method, operation] of Object.entries(methods)) {
        const parsed = operation as ParsedOperation;
        const base = `/paths/${escapePointerToken(path)}/${method}`;
        operations.push({
          method: method.toUpperCase(),
          path,
          ...(typeof parsed.operationId === "string" ? { operationId: parsed.operationId } : {}),
          ...(Array.isArray(parsed.security) && parsed.security.length === 0
            ? { public: true as const }
            : {}),
          responseSchemas: responseSchemaPointers(view, base, parsed),
        });
      }
    if (operations.length)
      specs.push({ sourceRevisionId, sourceName: String(source.displayName), operations });
  }
  return specs;
}

/** The request's path segments, starting with the server path prefix. */
function prefixedSegments(
  basePath: readonly string[],
  segments: RequestPathSegments,
): RequestPathSegments {
  const present = basePath.every((part, index) => {
    const segment = segments[index];
    return segment !== undefined && "literal" in segment && segment.literal === part;
  });
  return present ? segments : [...basePath.map((literal) => ({ literal })), ...segments];
}
/**
 * Request paths are relative to the OpenAPI server URL but the environment base URL is an
 * origin, so every request, cleanup requests included, must carry the server path prefix
 * itself. Prefixes the literal segments when the cited sources agree on one prefix and the
 * request does not already start with it.
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
  for (const step of flattenSteps(clone.steps))
    if (step.operation === "request")
      step.input.pathSegments = prefixedSegments(basePath, step.input.pathSegments);
  for (const cleanup of clone.cleanup ?? []) {
    cleanup.input.pathSegments = prefixedSegments(basePath, cleanup.input.pathSegments);
    if (cleanup.find)
      cleanup.find.lookup.pathSegments = prefixedSegments(
        basePath,
        cleanup.find.lookup.pathSegments,
      );
  }
  return clone;
}
