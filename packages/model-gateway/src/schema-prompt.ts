import { canonicalJson } from "@testmaster/domain";
/** Share repeated schema nodes without changing the catalog used for validation. */
export function compactPromptSchema(schema: unknown): unknown {
  const counts = new Map<string, number>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const key = canonicalJson(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const child of Object.values(value)) visit(child);
  };
  visit(schema);
  const names = new Map<string, string>();
  const definitions: Record<string, unknown> = {};
  const encode = (value: unknown, root = false): unknown => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => encode(item));
    const key = canonicalJson(value);
    const repeated =
      !root &&
      (counts.get(key) ?? 0) > 1 &&
      key.length > 160 &&
      ("type" in value || "anyOf" in value || "allOf" in value || "oneOf" in value) &&
      !("$id" in value) &&
      !("$ref" in value);
    if (repeated) {
      let name = names.get(key);
      if (!name) {
        name = `shared${names.size}`;
        names.set(key, name);
        definitions[name] = Object.fromEntries(
          Object.entries(value).map(([key, child]) => [key, encode(child)]),
        );
      }
      return { $ref: `#/$defs/${name}` };
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encode(child)]));
  };
  const result = encode(schema, true) as Record<string, unknown>;
  return {
    ...result,
    $defs: { ...(result.$defs as Record<string, unknown> | undefined), ...definitions },
  };
}
