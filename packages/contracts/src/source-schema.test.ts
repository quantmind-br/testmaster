import { describe, expect, it } from "vitest";
import { ContractError } from "./registries.js";
import { ajv, SourceSchemaError, validateAgainstSchema } from "./validation.js";

const openApiModels: Record<string, unknown> = {
  type: "object",
  required: ["data"],
  example: { data: [] },
  xml: { name: "models" },
  externalDocs: { url: "https://docs.example.test" },
  discriminator: { propertyName: "kind" },
  "x-internal": true,
  properties: {
    data: {
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", format: "int64", example: "gpt-5" },
          owned_by: { type: ["string", "null"], "x-vendor": { note: 1 } },
          legacy: { type: "string", nullable: true },
        },
      },
    },
  },
};

describe("admitted source schemas", () => {
  it("accept OpenAPI annotation keywords without loosening the strict contract validator", () => {
    const valid = { data: [{ id: "gpt-5", owned_by: null, legacy: null }, { id: "o3" }] };
    expect(validateAgainstSchema(openApiModels, valid)).toBe(valid);
    // The strict instance used for TestMaster's own contracts still rejects the same keywords.
    expect(() => ajv.compile({ type: "object", example: {} })).toThrow(/unknown keyword/u);
    expect(() => ajv.compile({ type: "object", "x-vendor": 1 })).toThrow(/unknown keyword/u);
  });
  it("still validate: annotations are ignored but real keywords reject a bad value", () => {
    let error: unknown;
    try {
      validateAgainstSchema(openApiModels, { data: [{ id: 7 }, {}] });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ContractError);
    expect(error).not.toBeInstanceOf(SourceSchemaError);
    expect((error as ContractError).message).toBe("Response does not match source schema");
    expect(
      ((error as ContractError).details.issues as { instancePath: string; keyword: string }[]).map(
        (issue) => `${issue.instancePath} ${issue.keyword}`,
      ),
    ).toEqual(["/data/0/id type", "/data/1 required"]);
  });
  it("keep a property that is itself named example: only schema keywords are annotations", () => {
    const schema = {
      type: "object",
      required: ["example"],
      properties: { example: { type: "string" }, "x-id": { type: "integer" } },
    };
    expect(validateAgainstSchema(schema, { example: "a", "x-id": 1 })).toEqual({
      example: "a",
      "x-id": 1,
    });
    expect(() => validateAgainstSchema(schema, {})).toThrow(
      "Response does not match source schema",
    );
    expect(() => validateAgainstSchema(schema, { example: "a", "x-id": "1" })).toThrow(
      "Response does not match source schema",
    );
  });
  it("report an unusable schema as a SourceSchemaError, never as a value mismatch", () => {
    const dangling = { type: "object", properties: { a: { $ref: "#/$defs/Missing" } } };
    for (const schema of [dangling, { type: "strange" }, { type: "object", bogusKeyword: 1 }]) {
      let error: unknown;
      try {
        validateAgainstSchema(schema, {});
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(SourceSchemaError);
      expect((error as SourceSchemaError).message).toMatch(/^Source schema cannot be compiled: /u);
      expect((error as SourceSchemaError).problem.length).toBeGreaterThan(0);
    }
    expect(() => validateAgainstSchema(dangling, {})).toThrow(/Missing/u);
  });
  it("reuse a compiled schema and let different content replace a repeated $id", () => {
    const first = { $id: "urn:test:source-schema", type: "string" };
    const second = { $id: "urn:test:source-schema", type: "integer" };
    expect(validateAgainstSchema(first, "a")).toBe("a");
    expect(validateAgainstSchema(first, "b")).toBe("b");
    expect(validateAgainstSchema(second, 3)).toBe(3);
    expect(() => validateAgainstSchema(second, "a")).toThrow(
      "Response does not match source schema",
    );
  });
});
