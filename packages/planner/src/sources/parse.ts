import { validate as validateApi } from "@readme/openapi-parser";
import { parseStrictJson, validate } from "@testmaster/contracts";
import { canonicalJson, sha256 } from "@testmaster/domain";
import { buildASTSchema, parse as parseGraphql } from "graphql";
import type { RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { extractText, getDocumentProxy } from "unpdf";
import { parseDocument } from "yaml";
import type {
  SourceChunk,
  SourceDiagnostic,
  SourceParseInput,
  SourceParseResult,
} from "./types.js";

export const SOURCE_PARSER_VERSION = "1.1.0";
const requirement =
  /\b(must|shall|should|required|requirement|acceptance|deve|precisa|obrigat[oó]rio|crit[eé]rio)\b/iu;
const pointerKey = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function structured(text: string): Record<string, unknown> {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors.map((e) => e.message).join("; "));
  return object(doc.toJS({ maxAliasCount: 100 }));
}
// Keys whose value maps arbitrary names to schemas or objects: a child called `$ref` or `allOf`
// there is a name, not a keyword.
const NAME_MAPS: Record<string, true> = {
  properties: true,
  patternProperties: true,
  dependentSchemas: true,
  dependencies: true,
  $defs: true,
  definitions: true,
  schemas: true,
  responses: true,
  parameters: true,
  requestBodies: true,
  headers: true,
  examples: true,
  links: true,
  callbacks: true,
  securitySchemes: true,
  securityDefinitions: true,
  pathItems: true,
  paths: true,
  webhooks: true,
  content: true,
  encoding: true,
  mapping: true,
  variables: true,
};
// Schema keywords that apply to the same instance location as the schema that holds them. The
// dependent maps name properties, but each mapped schema still applies to that same instance.
const SAME_INSTANCE: Record<string, true> = {
  dependentSchemas: true,
  dependencies: true,
  allOf: true,
  anyOf: true,
  oneOf: true,
  not: true,
  if: true,
  // biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema keyword; this is a static string-keyed registry, never a thenable.
  then: true,
  else: true,
};
// A bundled operation carries the definitions its remaining `$ref`s need under this key.
const DEFINITIONS_KEY = "$defs";
const REFERENCE_DEPTH_LIMIT = 100;
const EXPANSION_LIMIT_NODES = 2_000_000;
function resolvePointer(root: Record<string, unknown>, ref: string): unknown {
  if (typeof ref !== "string") throw new Error("invalid_reference: $ref must be a string");
  if (!ref.startsWith("#/"))
    throw new Error("external_reference: External references are disabled");
  let target: unknown = root;
  for (const key of ref.slice(2).split("/")) {
    if (/%/.test(key) || /~(?![01])/u.test(key))
      throw new Error("invalid_reference: Invalid JSON pointer");
    const decoded = key.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!target || typeof target !== "object" || !Object.hasOwn(target, decoded))
      throw new Error("missing_reference: Unresolved JSON pointer");
    target = (target as Record<string, unknown>)[decoded];
  }
  return target;
}
// Every `$ref` must be local and resolvable. Recursion through properties, items or other
// instance-descending keywords is legitimate (a tree schema); a reference cycle that never
// descends into the instance (`A: {$ref: B}, B: {$ref: A}`, `allOf: [{$ref: self}]`) denotes no
// schema at all and is refused. Dereferencing shares one object per target, so memory stays
// linear while the tree a validator walks can grow exponentially with fan-out references; the
// expanded size is estimated here, before any dereferencing, and bounded. Work is linear in the
// document. A reference into a recursive target is not expanded, which is how the parser
// dereferences it.
function checkReferences(root: Record<string, unknown>): void {
  const contained = new Map<object, object[]>();
  const refTo = new Map<object, object>();
  const sameInstance = new Map<object, object[]>();
  const push = (map: Map<object, object[]>, from: object, to: object) => {
    const edges = map.get(from);
    if (edges) edges.push(to);
    else map.set(from, [to]);
  };
  const trail: string[] = [];
  const walk = (node: unknown, names: boolean, parent: object | null, neutral: boolean): void => {
    if (trail.length > REFERENCE_DEPTH_LIMIT)
      throw new Error(
        `reference_limit: Reference depth limit ${REFERENCE_DEPTH_LIMIT} exceeded at /${trail.map(pointerKey).join("/")}`,
      );
    if (!node || typeof node !== "object") return;
    if (parent) {
      push(contained, parent, node);
      if (neutral) push(sameInstance, parent, node);
    }
    if (contained.has(node) || refTo.has(node)) return;
    contained.set(node, []);
    if (Array.isArray(node)) {
      node.forEach((child, index) => {
        trail.push(String(index));
        walk(child, false, node, neutral);
        trail.pop();
      });
      return;
    }
    if (!names && "$ref" in node) {
      const target = resolvePointer(root, (node as Record<string, unknown>).$ref as string);
      if (target && typeof target === "object") {
        refTo.set(node, target);
        push(sameInstance, node, target);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      trail.push(key);
      walk(
        child,
        !names && Object.hasOwn(NAME_MAPS, key),
        node,
        // A name map's entries inherit how the map itself was reached: those of
        // `dependentSchemas` stay on the instance, those of `properties` descend.
        names ? neutral : Object.hasOwn(SAME_INSTANCE, key),
      );
      trail.pop();
    }
  };
  walk(root, false, null, false);
  // 1. A cycle made only of same-instance edges never reaches the instance: refuse it.
  const state = new Map<object, "open" | "done">();
  for (const start of sameInstance.keys()) {
    if (state.has(start)) continue;
    state.set(start, "open");
    const stack: { node: object; next: number }[] = [{ node: start, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1] as { node: object; next: number };
      const edges = sameInstance.get(frame.node);
      if (!edges || frame.next >= edges.length) {
        state.set(frame.node, "done");
        stack.pop();
        continue;
      }
      const next = edges[frame.next++] as object;
      const status = state.get(next);
      if (status === "open") throw new Error("cyclic_reference: Circular reference");
      if (status === undefined) {
        state.set(next, "open");
        stack.push({ node: next, next: 0 });
      }
    }
  }
  // 2. Members of any cycle (strongly connected components of containment plus reference edges).
  const neighbours = (node: object): object[] => {
    const target = refTo.get(node);
    const children = contained.get(node) ?? [];
    return target ? [...children, target] : children;
  };
  const index = new Map<object, number>();
  const low = new Map<object, number>();
  const open = new Set<object>();
  const pending: object[] = [];
  const recursive = new Set<object>();
  for (const start of contained.keys()) {
    if (index.has(start)) continue;
    index.set(start, index.size);
    low.set(start, index.get(start) as number);
    pending.push(start);
    open.add(start);
    const frames: { node: object; edges: object[]; next: number }[] = [
      { node: start, edges: neighbours(start), next: 0 },
    ];
    while (frames.length) {
      const frame = frames[frames.length - 1] as (typeof frames)[number];
      if (frame.next < frame.edges.length) {
        const next = frame.edges[frame.next++] as object;
        if (!index.has(next)) {
          index.set(next, index.size);
          low.set(next, index.get(next) as number);
          pending.push(next);
          open.add(next);
          frames.push({ node: next, edges: neighbours(next), next: 0 });
        } else if (open.has(next))
          low.set(frame.node, Math.min(low.get(frame.node) as number, index.get(next) as number));
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent)
        low.set(
          parent.node,
          Math.min(low.get(parent.node) as number, low.get(frame.node) as number),
        );
      if (low.get(frame.node) !== index.get(frame.node)) continue;
      const component: object[] = [];
      let member: object | undefined;
      do {
        member = pending.pop() as object;
        open.delete(member);
        component.push(member);
      } while (member !== frame.node);
      if (component.length > 1 || frame.edges.includes(frame.node))
        for (const value of component) recursive.add(value);
    }
  }
  // 3. Bound the expanded size of each top-level entry (operation, component group, ...).
  const sizes = new Map<object, number>();
  const size = (node: object, active: Set<object>): number => {
    const known = sizes.get(node);
    if (known !== undefined) return known;
    if (active.has(node)) throw new Error("cyclic_reference: Circular reference");
    active.add(node);
    let total = 1;
    for (const child of contained.get(node) ?? []) total += size(child, active);
    const target = refTo.get(node);
    if (target && !recursive.has(target)) total += size(target, active);
    active.delete(node);
    sizes.set(node, total);
    return total;
  };
  const entries: [string, unknown][] = [];
  const isObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  for (const [key, value] of Object.entries(root)) {
    if (key !== "paths" || !isObject(value)) {
      entries.push([`/${pointerKey(key)}`, value]);
      continue;
    }
    for (const [path, item] of Object.entries(value)) {
      if (!isObject(item)) entries.push([`/paths/${pointerKey(path)}`, item]);
      else
        for (const [method, operation] of Object.entries(item))
          entries.push([`/paths/${pointerKey(path)}/${pointerKey(method)}`, operation]);
    }
  }
  let total = 0;
  for (const [pointer, value] of entries) {
    if (!value || typeof value !== "object") continue;
    const expanded = size(value, new Set());
    total += expanded;
    if (expanded > EXPANSION_LIMIT_NODES || total > EXPANSION_LIMIT_NODES)
      throw new Error(
        `reference_limit: Reference expansion limit ${EXPANSION_LIMIT_NODES} nodes exceeded at ${pointer}`,
      );
  }
}
// The parser dereferences every `$ref` whose target holds no recursion and leaves the rest as
// references, so the document stays finite. Those remaining references point into the
// document; a consumer that sees one operation alone cannot follow them. Rewrite them to
// `#/$defs/<pointer>` and carry the (also rewritten) targets, transitively, in the operation's
// own `$defs`, which makes each operation, and any schema inside it once `$defs` is attached
// at its root, a self-contained JSON Schema.
function bundleOperation(api: Record<string, unknown>, operation: unknown): unknown {
  const used = new Set<string>();
  const memo = new Map<object, unknown>();
  const rewrite = (node: unknown): unknown => {
    if (!node || typeof node !== "object") return node;
    const known = memo.get(node);
    if (known !== undefined) return known;
    const out = Array.isArray(node)
      ? node.map(rewrite)
      : Object.fromEntries(
          Object.entries(node).map(([key, child]) => {
            if (key === "$ref" && typeof child === "string" && child.startsWith("#/")) {
              used.add(child);
              return [key, `#/${DEFINITIONS_KEY}/${pointerKey(child.slice(2))}`];
            }
            return [key, rewrite(child)];
          }),
        );
    memo.set(node, out);
    return out;
  };
  const bundled = rewrite(operation);
  if (!used.size) return operation;
  const definitions: Record<string, unknown> = {};
  for (const ref of used)
    Object.defineProperty(definitions, ref.slice(2), {
      value: rewrite(resolvePointer(api, ref)),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return { ...(bundled as Record<string, unknown>), [DEFINITIONS_KEY]: definitions };
}
export async function parseSource(input: SourceParseInput): Promise<SourceParseResult> {
  const chunks: SourceChunk[] = [];
  const diagnostics: SourceDiagnostic[] = [];
  const inventory: Record<string, unknown> = {};
  const mediaTypes = {
    markdown: "text/markdown",
    text: "text/plain",
    "prd-json": "application/json",
    pdf: "application/pdf",
    openapi: "application/vnd.oai.openapi",
    graphql: "application/graphql",
    postman: "application/json",
  };
  const revision = {
    id: input.revisionId,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    contentHash: sha256(input.bytes),
    mediaType: mediaTypes[input.format],
    sizeBytes: input.bytes.byteLength,
    parserVersion: SOURCE_PARSER_VERSION,
    status: "ready" as SourceParseResult["revision"]["status"],
    parentId: input.parentId ?? null,
    chunks: [] as SourceParseResult["revision"]["chunks"],
  };
  const add = (
    kind: string,
    text: string,
    location: {
      offset?: number;
      length?: number;
      page?: number;
      jsonPointer?: string;
      lineStart?: number;
      lineEnd?: number;
    } = {},
  ) => {
    if (!text.trim()) return;
    const { lineStart, lineEnd, ...wireLocation } = location;
    const contentHash = sha256(text);
    const evidenceRef = validate<SourceChunk["evidenceRef"]>("EvidenceRef", {
      sourceRevisionId: input.revisionId,
      ...(input.relativePath ? { relativePath: input.relativePath } : {}),
      contentHash,
      ...wireLocation,
    });
    chunks.push({
      id: `chunk_${sha256(canonicalJson({ sourceHash: revision.contentHash, kind, location, contentHash }))}`,
      kind,
      text,
      contentHash,
      evidenceRef,
      ...(lineStart === undefined ? {} : { lineStart }),
      ...(lineEnd === undefined ? {} : { lineEnd }),
      requirementLike: requirement.test(text),
    });
  };
  try {
    if (input.bytes.byteLength > (input.maxBytes ?? 25 * 1024 * 1024))
      throw new Error("size_limit: Source exceeds byte limit");
    const signature = Buffer.from(input.bytes.subarray(0, 512));
    if (
      signature.subarray(0, 2).equals(Buffer.from("PK")) ||
      (signature[0] === 0x1f && signature[1] === 0x8b) ||
      signature.subarray(257, 262).toString() === "ustar"
    )
      throw new Error("archive_refused: Archives require the confined archive guard");
    if (input.format === "pdf") {
      const pdf = await getDocumentProxy(new Uint8Array(input.bytes));
      try {
        if (pdf.numPages > (input.maxPages ?? 500))
          throw new Error("page_limit: PDF exceeds page limit");
        const { text } = await extractText(pdf, { mergePages: false });
        text.forEach((page, index) => {
          add("page", page.normalize("NFC"), { page: index + 1 });
        });
      } finally {
        await pdf.loadingTask.destroy();
      }
    } else {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
      if (text !== text.normalize("NFC"))
        throw new Error("invalid_charset: Text must be Unicode NFC");
      if (!text.trim()) throw new Error("empty_source: Source has no text");
      const ranged = (
        kind: string,
        start: number,
        end: number,
        startLine: number,
        endLine: number,
      ) =>
        add(kind, text.slice(start, end), {
          offset: Buffer.byteLength(text.slice(0, start)),
          length: Buffer.byteLength(text.slice(start, end)),
          lineStart: startLine,
          lineEnd: endLine,
        });
      if (input.format === "markdown") {
        const root = fromMarkdown(text, {
          extensions: [gfm()],
          mdastExtensions: [gfmFromMarkdown()],
        });
        const visit = (node: RootContent): void => {
          if (
            ["heading", "paragraph", "listItem", "table", "code"].includes(node.type) &&
            node.position
          )
            ranged(
              node.type,
              node.position.start.offset ?? 0,
              node.position.end.offset ?? text.length,
              node.position.start.line,
              node.position.end.line,
            );
          if ("children" in node && node.type !== "table" && node.type !== "listItem")
            for (const child of node.children) visit(child as RootContent);
        };
        root.children.forEach(visit);
      } else if (input.format === "text") {
        let offset = 0;
        text.split(/(?<=\n)/u).forEach((line, index) => {
          ranged("text", offset, offset + line.length, index + 1, index + 1);
          offset += line.length;
        });
      } else if (input.format === "openapi") {
        const api = structured(text);
        checkReferences(api);
        if (
          api.swagger !== "2.0" &&
          !(typeof api.openapi === "string" && /^3\.[01]\./u.test(api.openapi))
        )
          throw new Error("unsupported_openapi: Expected OpenAPI 3.0/3.1 or Swagger 2.0");
        // Targets that hold recursion stay references so the dereferenced document is finite.
        const result = await validateApi(api as Parameters<typeof validateApi>[0], {
          resolve: { external: false, file: false },
          dereference: { circular: "ignore" },
        });
        if (!result.valid)
          throw new Error(`invalid_openapi: ${result.errors.map((e) => e.message).join("; ")}`);
        diagnostics.push(
          ...result.warnings.map((w) => ({ code: "openapi_warning", message: w.message })),
        );
        const operations: unknown[] = [];
        for (const [path, item] of Object.entries(object(api.paths)))
          for (const [method, operation] of Object.entries(object(item))) {
            if (
              !["get", "post", "put", "patch", "delete", "options", "head", "trace"].includes(
                method,
              )
            )
              continue;
            const jsonPointer = `/paths/${pointerKey(path)}/${method}`;
            operations.push({
              path,
              method: method.toUpperCase(),
              operation: bundleOperation(api, operation),
            });
            add("operation", canonicalJson(operation), { jsonPointer });
          }
        for (const key of [
          "components",
          "definitions",
          "securityDefinitions",
          "security",
          "servers",
          "tags",
        ])
          if (api[key] !== undefined) add(key, canonicalJson(api[key]), { jsonPointer: `/${key}` });
        inventory.operations = operations;
        inventory.specification = result.specification;
      } else if (input.format === "graphql") {
        const ast = parseGraphql(text);
        buildASTSchema(ast);
        const operations: unknown[] = [];
        for (const definition of ast.definitions) {
          if (definition.loc)
            ranged(
              definition.kind,
              definition.loc.start,
              definition.loc.end,
              text.slice(0, definition.loc.start).split("\n").length,
              text.slice(0, definition.loc.end).split("\n").length,
            );
          if (
            definition.kind === "ObjectTypeDefinition" &&
            ["Query", "Mutation", "Subscription"].includes(definition.name.value)
          )
            operations.push({
              kind: definition.name.value,
              fields: definition.fields?.map((f) => f.name.value),
              supported: definition.name.value !== "Subscription",
            });
        }
        inventory.operations = operations;
      } else if (input.format === "postman") {
        const collection = object(parseStrictJson(input.bytes, input.maxBytes ?? 25 * 1024 * 1024));
        if (
          !Array.isArray(collection.item) ||
          !object(collection.info).schema?.toString().includes("collection/v2.")
        )
          throw new Error("invalid_postman: Expected Postman v2 collection");
        const scripts: unknown[] = [];
        const requests: unknown[] = [];
        const refs = new Set<string>();
        const walk = (node: Record<string, unknown>, pointer: string, depth: number): void => {
          if (depth > 100) throw new Error("depth_limit: Postman nesting exceeds limit");
          if (Array.isArray(node.event))
            node.event.forEach((event, index) => {
              const e = object(event);
              scripts.push({
                listen: e.listen,
                script: e.script,
                jsonPointer: `${pointer}/event/${index}`,
                executed: false,
              });
              add("script_inventory", canonicalJson(e), {
                jsonPointer: `${pointer}/event/${index}`,
              });
            });
          if (node.request) {
            requests.push({
              name: node.name,
              request: node.request,
              jsonPointer: `${pointer}/request`,
            });
            add("request", canonicalJson(node.request), { jsonPointer: `${pointer}/request` });
          }
          if (Array.isArray(node.item))
            node.item.forEach((item, index) => {
              walk(object(item), `${pointer}/item/${index}`, depth + 1);
            });
        };
        walk(collection, "", 0);
        for (const match of text.matchAll(/\{\{([^{}]+)\}\}/gu)) refs.add(match[1] ?? "");
        inventory.requests = requests;
        inventory.scripts = scripts;
        inventory.environmentRefs = [...refs].sort();
        inventory.unsupported = scripts.length ? ["arbitrary_scripts"] : [];
      } else {
        const prd = object(parseStrictJson(input.bytes, input.maxBytes ?? 25 * 1024 * 1024));
        if (!Array.isArray(prd.requirements) || !prd.requirements.length)
          throw new Error("invalid_prd: Nonempty requirements array required");
        prd.requirements.forEach((raw, index) => {
          const r = object(raw);
          if (typeof r.text !== "string" || !r.text.trim())
            throw new Error("invalid_prd: Requirement text required");
          if (
            r.originKind !== undefined &&
            !["explicit", "user_spec", "inferred", "observed"].includes(String(r.originKind))
          )
            throw new Error("invalid_prd: Unknown originKind");
          add("requirement", canonicalJson(r), { jsonPointer: `/requirements/${index}` });
        });
        inventory.product = prd.product ?? null;
      }
    }
    if (!chunks.length) {
      revision.status = "needs_input";
      diagnostics.push({
        code: "no_extractable_text",
        message: "No extractable content; supply a textual source (OCR is not enabled)",
      });
    }
  } catch (error) {
    revision.status = "invalid";
    chunks.length = 0;
    const message = error instanceof Error ? error.message : "Source parsing failed";
    diagnostics.push({ code: /^([a-z_]+):/u.exec(message)?.[1] ?? "parse_failed", message });
  }
  revision.chunks = chunks.map((chunk) => chunk.evidenceRef);
  validate("SourceRevision", revision);
  return { revision, chunks, diagnostics, inventory };
}
