/**
 * OpenAPI 3.2 is the 3.1 model plus a closed set of additions. The validator in use knows only
 * the 3.0, 3.1 and 2.0 schemas, so a 3.2 document is checked as the 3.1 document that remains
 * after the additions are lifted out:
 *
 * - `query` and `additionalOperations` operations are validated as `get` operations of a
 *   synthetic path, so their responses and parameters are still checked;
 * - `$self`, `itemSchema`, `itemEncoding`, `prefixEncoding`, `summary`, `kind`, `parent`, ... are
 *   removed because the 3.1 schema rejects them as unevaluated properties.
 *
 * The caller keeps the original document for everything it stores; only the validation copy is
 * downgraded.
 */
type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function eachObject(value: unknown, visit: (item: Json) => void): void {
  if (Array.isArray(value)) for (const item of value) eachObject(item, visit);
  else if (isObject(value)) visit(value);
}
function eachValue(map: unknown, visit: (item: Json) => void): void {
  if (isObject(map)) for (const value of Object.values(map)) eachObject(value, visit);
}
function remove(item: Json, keys: readonly string[]): void {
  for (const key of keys) delete item[key];
}

const SCHEMA_CHILD = [
  "items",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentSchema",
] as const;
const SCHEMA_LIST = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const SCHEMA_MAP = [
  "properties",
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
] as const;

function schema(node: Json, seen: Set<Json>): void {
  if (seen.has(node)) return;
  seen.add(node);
  if (isObject(node.xml)) remove(node.xml, ["nodeType"]);
  if (isObject(node.discriminator)) remove(node.discriminator, ["defaultMapping"]);
  for (const key of SCHEMA_CHILD) eachObject(node[key], (child) => schema(child, seen));
  for (const key of SCHEMA_LIST) eachObject(node[key], (child) => schema(child, seen));
  for (const key of SCHEMA_MAP) eachValue(node[key], (child) => schema(child, seen));
}

function example(node: Json): void {
  if (node.dataValue !== undefined || node.serializedValue !== undefined)
    remove(node, ["dataValue", "serializedValue"]);
}
function encoding(node: Json, seen: Set<Json>): void {
  remove(node, ["encoding", "itemEncoding", "prefixEncoding"]);
  eachValue(node.headers, (header) => parameter(header, seen));
}
function mediaType(node: Json, seen: Set<Json>): void {
  remove(node, ["itemSchema", "itemEncoding", "prefixEncoding"]);
  eachObject(node.schema, (item) => schema(item, seen));
  eachValue(node.examples, example);
  eachValue(node.encoding, (item) => encoding(item, seen));
}
function content(map: unknown, seen: Set<Json>): void {
  eachValue(map, (item) => mediaType(item, seen));
}
function parameter(node: Json, seen: Set<Json>): void {
  // `in: querystring` carries a whole query string as `content`; 3.1 has no such location.
  if (node.in === "querystring") node.in = "query";
  eachObject(node.schema, (item) => schema(item, seen));
  eachValue(node.examples, example);
  content(node.content, seen);
}
function response(node: Json, seen: Set<Json>): void {
  remove(node, ["summary"]);
  content(node.content, seen);
  eachValue(node.headers, (item) => parameter(item, seen));
}
function operation(node: Json, seen: Set<Json>): void {
  eachObject(node.parameters, (item) => parameter(item, seen));
  if (isObject(node.requestBody)) content(node.requestBody.content, seen);
  eachValue(node.responses, (item) => response(item, seen));
  eachValue(node.callbacks, (callback) => eachValue(callback, (item) => pathItem(item, seen)));
}
const FIXED_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
function pathItem(node: Json, seen: Set<Json>): void {
  eachObject(node.parameters, (item) => parameter(item, seen));
  for (const method of FIXED_METHODS) eachObject(node[method], (item) => operation(item, seen));
  if (isObject(node.query)) operation(node.query, seen);
  if (isObject(node.additionalOperations))
    for (const value of Object.values(node.additionalOperations))
      eachObject(value, (item) => operation(item, seen));
}
function securityScheme(node: Json): void {
  remove(node, ["oauth2MetadataUrl", "deprecated"]);
  if (isObject(node.flows)) remove(node.flows, ["deviceAuthorization"]);
}

/** The operations that 3.2 declares outside the eight fixed methods, keyed by method name. */
export function additionalOperations(item: Json): Array<[string, Json]> {
  const out: Array<[string, Json]> = [];
  if (isObject(item.query)) out.push(["QUERY", item.query]);
  if (isObject(item.additionalOperations))
    for (const [method, value] of Object.entries(item.additionalOperations))
      if (isObject(value)) out.push([method, value]);
  return out;
}

/**
 * A 3.1 document that validates the 3.2 document `api`. Works on a deep copy; `api` is not
 * modified.
 */
export function downgradeOpenApi32(api: Json): Json {
  const copy = structuredClone(api);
  const seen = new Set<Json>();
  copy.openapi = "3.1.0";
  remove(copy, ["$self"]);
  eachObject(copy.tags, (tag) => remove(tag, ["summary", "parent", "kind"]));
  eachObject(copy.servers, (server) => remove(server, ["name"]));
  const components = isObject(copy.components) ? copy.components : undefined;
  if (components) {
    delete components.mediaTypes;
    eachValue(components.schemas, (item) => schema(item, seen));
    eachValue(components.responses, (item) => response(item, seen));
    eachValue(components.parameters, (item) => parameter(item, seen));
    eachValue(components.headers, (item) => parameter(item, seen));
    eachValue(components.examples, example);
    eachValue(components.securitySchemes, securityScheme);
    eachValue(components.requestBodies, (item) => content(item.content, seen));
    eachValue(components.pathItems, (item) => pathItem(item, seen));
  }
  eachValue(copy.webhooks, (item) => pathItem(item, seen));
  if (isObject(copy.paths)) {
    const lifted: Record<string, Json> = {};
    for (const [path, item] of Object.entries(copy.paths)) {
      if (!isObject(item)) continue;
      pathItem(item, seen);
      for (const [method, op] of additionalOperations(item))
        lifted[`${path}#${method}`] = {
          ...(item.parameters !== undefined ? { parameters: item.parameters } : {}),
          get: op,
        };
      delete item.query;
      delete item.additionalOperations;
    }
    Object.assign(copy.paths, lifted);
  }
  return copy;
}
