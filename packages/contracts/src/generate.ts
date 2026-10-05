import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schemaCatalog } from "./catalog.js";
import { routeCatalog } from "./surfaces.js";
import { jsonSchema } from "./validation.js";
export function generatedArtifacts(): Record<string, string> {
  const schemas = Object.fromEntries(
    Object.keys(schemaCatalog)
      .sort()
      .map((name) => [name, jsonSchema(name)]),
  );
  const artifacts: Record<string, string> = {};
  for (const [name, schema] of Object.entries(schemas))
    artifacts[`schemas/${name}.json`] = `${JSON.stringify(schema, null, 2)}\n`;
  const components = structuredClone(schemas);
  const rewrite = (value: unknown, name: string): void => {
    if (Array.isArray(value)) {
      for (const child of value) rewrite(child, name);
    } else if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (typeof object.$ref === "string" && object.$ref.startsWith("#/$defs/"))
        object.$ref = `#/components/schemas/${name}${object.$ref.slice(1)}`;
      delete object.$id;
      delete object.$schema;
      for (const child of Object.values(object)) rewrite(child, name);
    }
  };
  for (const [name, schema] of Object.entries(components)) rewrite(schema, name);
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routeCatalog) {
    const operationId = `${route.method.toLowerCase()}_${route.path.replace(/[^a-zA-Z0-9]+/g, "_")}`;
    const parameters = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    const operation: Record<string, unknown> = {
      operationId,
      tags: [route.milestone],
      parameters,
      "x-scope": route.scope,
      "x-milestone": route.milestone,
      responses: {
        "200": {
          description: "Successful operation",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["schemaVersion", "requestId", "data", "warnings"],
                properties: {
                  schemaVersion: { const: "1.0.0" },
                  requestId: { type: "string" },
                  data: { $ref: `#/components/schemas/${route.responseSchema}` },
                  warnings: { type: "array", items: { type: "string" } },
                },
                additionalProperties: false,
              },
            },
          },
        },
        default: {
          description: "Canonical error",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } },
          },
        },
      },
    };
    if (route.requestSchema !== "Empty")
      operation.requestBody = {
        required: true,
        content: {
          "application/json": { schema: { $ref: `#/components/schemas/${route.requestSchema}` } },
        },
      };
    const pathItem = paths[route.path] ?? {};
    paths[route.path] = pathItem;
    pathItem[route.method.toLowerCase()] = operation;
  }
  artifacts["openapi.json"] =
    `${JSON.stringify({ openapi: "3.1.0", info: { title: "TestMaster API", version: "1.0.0" }, servers: [{ url: "/v1" }], paths, components: { schemas: components } }, null, 2)}\n`;
  return artifacts;
}
export async function generateContracts(
  root = fileURLToPath(new URL("../", import.meta.url)),
): Promise<void> {
  await mkdir(resolve(root, "schemas"), { recursive: true });
  for (const [path, bytes] of Object.entries(generatedArtifacts()))
    await writeFile(resolve(root, path), bytes, "utf8");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await generateContracts();
