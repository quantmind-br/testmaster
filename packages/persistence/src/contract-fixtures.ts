import { entities, jsonSchema, validate } from "@testmaster/contracts";
import { contractProjections } from "./contract-projections.js";

export const unavailableEntityCapabilities: Record<string, string> = {
  Schedule: "schedules",
  ScheduledFire: "schedules",
  VisualBaseline: "visual-baselines",
};
export function catalogValue(
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
  path = "",
  depth = 0,
): unknown {
  if (depth > 20) throw new Error(`Recursive required catalog value: ${path}`);
  if (schema.$ref) {
    const target = String(schema.$ref).split("/").at(-1);
    const definition = (root.$defs as Record<string, Record<string, unknown>>)[String(target)];
    if (!definition) throw new Error(`Missing catalog definition ${String(target)}`);
    return catalogValue(definition, root, path, depth + 1);
  }
  if (Object.hasOwn(schema, "default")) return schema.default;
  if (Object.hasOwn(schema, "const")) return schema.const;
  if (Array.isArray(schema.anyOf)) {
    const nullable = schema.anyOf.find((branch) => branch.type === "null");
    const intent = schema.anyOf.find((branch) => branch.properties?.kind?.const === "intent");
    if (intent) return catalogValue(intent, root, path, depth + 1);
    return nullable ? null : catalogValue(schema.anyOf[0], root, path, depth + 1);
  }
  if (schema.type === "null") return null;
  if (schema.type === "boolean") return false;
  if (schema.type === "number" || schema.type === "integer") return schema.minimum ?? 0;
  if (schema.type === "array")
    return Array.from({ length: Number(schema.minItems ?? 0) }, (_, index) =>
      catalogValue(schema.items as Record<string, unknown>, root, `${path}/${index}`, depth + 1),
    );
  if (schema.type === "object") {
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const result: Record<string, unknown> = {};
    const fields = (schema.required ?? []) as string[];
    for (const field of fields) {
      const child = properties[field];
      if (!child) throw new Error(`Missing required schema ${path}/${field}`);
      result[field] = catalogValue(child, root, `${path}/${field}`, depth + 1);
    }
    if (schema.minProperties && !Object.keys(result).length) {
      const field = Object.keys(properties)[0];
      if (field && properties[field])
        result[field] = catalogValue(properties[field], root, `${path}/${field}`, depth + 1);
    }
    return result;
  }
  if (schema.format === "date-time") return "2026-10-05T00:00:00.000Z";
  if (schema.format === "uri") return "http://127.0.0.1:7339";
  const pattern = String(schema.pattern ?? "");
  const prefix = /^\^([a-z]+)_/.exec(pattern)?.[1];
  if (prefix) return `${prefix}_00000000-0000-4000-8000-000000000001`;
  if (pattern.includes("{64}")) return "a".repeat(64);
  if (pattern.includes("{40}")) return "a".repeat(40);
  if (pattern.includes("Z$")) return "2026-10-05T00:00:00.000Z";
  if (pattern.includes("^/")) return "/value";
  if (pattern.includes("[0-9]")) return "0";
  return "x".repeat(Math.max(Number(schema.minLength ?? 1), 1));
}
export function entityFixtures(): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const kind of Object.keys(entities)) {
    const schema = jsonSchema(kind);
    const value = catalogValue(schema, schema) as Record<string, unknown>;
    try {
      validate(kind, value);
    } catch (error) {
      throw new Error(`Generated ${kind}: ${String(error)} ${JSON.stringify(value)}`);
    }
    result[kind] = value;
  }
  return result;
}
export const persistedEntityKinds = Object.keys(entities).filter(
  (kind) => kind in contractProjections,
);
