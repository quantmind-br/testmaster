import { schemaCatalog } from "./catalog.js";
import { type RouteDefinition, routeCatalog } from "./surfaces.js";
import { jsonSchema } from "./validation.js";

type JsonObject = Record<string, unknown>;

/** Standalone JSON Schema of every catalog schema, keyed by name. */
export function contractSchemas(): Record<string, JsonObject> {
  return Object.fromEntries(
    Object.keys(schemaCatalog)
      .sort()
      .map((name) => [name, jsonSchema(name)]),
  );
}
const ref = (name: string): JsonObject => ({ $ref: `#/components/schemas/${name}` });
const envelope = (data: JsonObject): JsonObject => ({
  type: "object",
  required: ["schemaVersion", "requestId", "data", "warnings"],
  properties: {
    schemaVersion: { const: "1.0.0" },
    requestId: { type: "string" },
    data,
    warnings: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
});
const nextCursor = { type: ["string", "null"] };
const statusDescriptions: Record<number, string> = {
  200: "Successful operation",
  201: "Created",
  202: "Accepted",
  206: "Partial content",
  503: "Service not ready",
};
/** `data` of the success envelope for `item`, `page`, `items` and `empty` routes. */
function dataSchema(route: RouteDefinition): JsonObject {
  const { kind, schema } = route.response;
  switch (kind) {
    case "item":
      return ref(schema);
    case "empty":
      return ref("Empty");
    case "items":
      return {
        type: "object",
        required: ["items"],
        properties: { items: { type: "array", items: ref(schema) } },
        additionalProperties: false,
      };
    case "page":
      return {
        type: "object",
        required: ["items", "hasMore", "nextCursor"],
        properties: {
          items: { type: "array", items: ref(schema) },
          hasMore: { type: "boolean" },
          nextCursor,
        },
        additionalProperties: false,
      };
    default:
      throw new Error(`${route.method} ${route.path}: ${kind} has no envelope`);
  }
}
/** Media types of a success status. Only JSON kinds are wrapped in the success envelope. */
function successContent(route: RouteDefinition): JsonObject {
  switch (route.response.kind) {
    case "stream":
      return {
        "text/event-stream": {
          schema: { type: "string" },
          "x-event-schema": ref(route.response.schema),
        },
      };
    case "binary":
      return { "*/*": { schema: { type: "string", format: "binary" } } };
    case "text":
      return { "text/plain": { schema: { type: "string" } } };
    default:
      return { "application/json": { schema: envelope(dataSchema(route)) } };
  }
}
function responses(route: RouteDefinition): JsonObject {
  const errorBody = { "application/json": { schema: ref("ErrorEnvelope") } };
  const result: JsonObject = {};
  if (route.response.kind === "unavailable")
    result["422"] = {
      description: `Capability unavailable: ${route.milestone} has no handler for this route`,
      content: errorBody,
    };
  else
    for (const status of [route.response.status, ...route.response.alsoStatus])
      result[String(status)] = {
        description: statusDescriptions[status] ?? "Successful operation",
        content: successContent(route),
      };
  result.default = { description: "Canonical error", content: errorBody };
  return result;
}
/** The generated OpenAPI 3.1 document, built from the route catalog and the schema catalog. */
export function openApiDocument(): JsonObject {
  const components = structuredClone(contractSchemas());
  const rewrite = (value: unknown, name: string): void => {
    if (Array.isArray(value)) {
      for (const child of value) rewrite(child, name);
    } else if (value && typeof value === "object") {
      const object = value as JsonObject;
      if (typeof object.$ref === "string" && object.$ref.startsWith("#/$defs/"))
        object.$ref = `#/components/schemas/${name}${object.$ref.slice(1)}`;
      delete object.$id;
      delete object.$schema;
      for (const child of Object.values(object)) rewrite(child, name);
    }
  };
  for (const [name, schema] of Object.entries(components)) rewrite(schema, name);
  const paths: Record<string, JsonObject> = {};
  for (const route of routeCatalog) {
    const operationId = `${route.method.toLowerCase()}_${route.path.replace(/[^a-zA-Z0-9]+/g, "_")}`;
    const parameters = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    const operation: JsonObject = {
      operationId,
      tags: [route.milestone],
      parameters,
      "x-scope": route.scope,
      "x-milestone": route.milestone,
      responses: responses(route),
    };
    if (route.response.kind === "unavailable") operation["x-unavailable"] = true;
    if (route.requestSchema !== "Empty")
      operation.requestBody = {
        required: route.method !== "DELETE",
        content: { "application/json": { schema: ref(route.requestSchema) } },
      };
    const pathItem = paths[route.path] ?? {};
    paths[route.path] = pathItem;
    pathItem[route.method.toLowerCase()] = operation;
  }
  return {
    openapi: "3.1.0",
    info: { title: "TestMaster API", version: "1.0.0" },
    servers: [{ url: "/v1" }],
    paths,
    components: { schemas: components },
  };
}
