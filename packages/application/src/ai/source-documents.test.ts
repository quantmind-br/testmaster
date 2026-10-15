import { validateAgainstSchema } from "@testmaster/contracts";
import { describe, expect, it } from "vitest";
import { resolveSourceSchema, type SourceView } from "./source-documents.js";

const nodeRef = { $ref: "#/$defs/components~1schemas~1Node" };
// What the parser bundles for a recursive component: the target lives in the operation's `$defs`.
const definitions = {
  "components/schemas/Node": {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: { name: { type: "string" }, next: nodeRef },
  },
};
const pointer = "/paths/~1x/get/responses/200/content/application~1json/schema";
function extract(schema: unknown): Record<string, unknown> {
  const view: SourceView = {
    document: {
      paths: {
        "/x": {
          get: {
            $defs: definitions,
            responses: { "200": { content: { "application/json": { schema } } } },
          },
        },
      },
    },
    basePath: [],
  };
  const resolved = resolveSourceSchema(view, pointer);
  if (!resolved) throw new Error("Schema was not extracted");
  return resolved;
}
const mismatch = "Response does not match source schema";

describe("extracted source schemas validate recursive responses on their own", () => {
  it("accepts a nested recursive value and rejects an invalid nested field", () => {
    const schema = extract(nodeRef);
    const valid = { name: "a", next: { name: "b", next: { name: "c" } } };
    expect(validateAgainstSchema(schema, valid)).toBe(valid);
    expect(() =>
      validateAgainstSchema(schema, { name: "a", next: { name: "b", next: { name: 3 } } }),
    ).toThrow(mismatch);
  });
  it("resolves a recursive reference held by a property named $ref", () => {
    const schema = extract({
      type: "object",
      additionalProperties: false,
      properties: { $ref: nodeRef },
    });
    const valid = { $ref: { name: "a", next: { name: "b" } } };
    expect(validateAgainstSchema(schema, valid)).toBe(valid);
    expect(() => validateAgainstSchema(schema, { $ref: { name: "a", next: { name: 2 } } })).toThrow(
      mismatch,
    );
  });
  it("enforces both the schema's own definitions and the recursive ones", () => {
    const schema = extract({
      type: "object",
      $defs: { Tag: { type: "string", minLength: 2 } },
      properties: { tag: { $ref: "#/$defs/Tag" }, node: nodeRef },
    });
    const valid = { tag: "ab", node: { name: "a", next: { name: "b" } } };
    expect(validateAgainstSchema(schema, valid)).toBe(valid);
    expect(() => validateAgainstSchema(schema, { ...valid, tag: "a" })).toThrow(mismatch);
    expect(() =>
      validateAgainstSchema(schema, { ...valid, node: { name: "a", next: { name: 1 } } }),
    ).toThrow(mismatch);
  });
});
