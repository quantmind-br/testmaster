import { defaults, jsonSchema, schemaCatalog, validate } from "@testmaster/contracts";
import { expect, it } from "vitest";
import { catalogValue } from "./contract-fixtures.js";

it("catalog defaults remain schema-valid and do not silently coerce omitted fields", () => {
  let count = 0;
  for (const name of Object.keys(schemaCatalog)) {
    const root = jsonSchema(name);
    const walk = (schema: Record<string, unknown>, path: string) => {
      if (Object.hasOwn(schema, "default")) {
        expect(catalogValue(schema, root, path)).toEqual(schema.default);
        const alternatives = schema.anyOf as Record<string, unknown>[] | undefined;
        if (!alternatives) {
          if (schema.minimum !== undefined)
            expect(Number(schema.default)).toBeGreaterThanOrEqual(Number(schema.minimum));
          if (schema.maximum !== undefined)
            expect(Number(schema.default)).toBeLessThanOrEqual(Number(schema.maximum));
        }
        count++;
      }
      if (Array.isArray(schema.anyOf)) for (const branch of schema.anyOf) walk(branch, path);
      for (const [field, child] of Object.entries(
        (schema.properties ?? {}) as Record<string, Record<string, unknown>>,
      ))
        walk(child, `${path}/${field}`);
      if (schema.items) walk(schema.items as Record<string, unknown>, `${path}/*`);
    };
    walk(root, "");
  }
  expect(count).toBeGreaterThan(0);
  const pagination = jsonSchema("Pagination").properties as Record<string, Record<string, unknown>>;
  expect(pagination.limit?.default).toBe(defaults.pageSize);
  const omitted = {};
  validate("Pagination", omitted);
  expect(omitted).toEqual({});
});
