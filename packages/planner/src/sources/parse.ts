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

export const SOURCE_PARSER_VERSION = "1.0.0";
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
// Follow references and structural edges, with a stack rather than a global seen set:
// repeated acyclic references are valid, cycles and excessive expansion are not.
function checkReferences(root: Record<string, unknown>): void {
  let visits = 0;
  const walk = (node: unknown, stack: Set<object>, depth: number): void => {
    if (depth > 100 || ++visits > 100000)
      throw new Error("reference_limit: Reference depth or expansion limit exceeded");
    if (!node || typeof node !== "object") return;
    if (stack.has(node)) throw new Error("cyclic_reference: Circular reference");
    stack.add(node);
    if (!Array.isArray(node) && "$ref" in node) {
      const ref = (node as Record<string, unknown>).$ref;
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
      walk(target, stack, depth + 1);
    }
    for (const child of Object.values(node)) walk(child, stack, depth + 1);
    stack.delete(node);
  };
  walk(root, new Set(), 0);
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
        const result = await validateApi(api as Parameters<typeof validateApi>[0], {
          resolve: { external: false, file: false },
          dereference: { circular: false },
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
            operations.push({ path, method: method.toUpperCase(), operation });
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
