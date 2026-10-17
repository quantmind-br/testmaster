import { validateAgainstSchema } from "@testmaster/contracts";
import { parseSource } from "@testmaster/planner";
import { describe, expect, it } from "vitest";
import { buildSourceView, resolveSourceSchema, type SourceView } from "./source-documents.js";

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

const revisionId = "svr_01900000-0000-7000-8000-000000000001";
async function parsedView(document: object, sections: readonly string[]) {
  const result = await parseSource({
    revisionId,
    format: "openapi",
    bytes: Buffer.from(JSON.stringify(document)),
  });
  const view = buildSourceView({ result } as Parameters<typeof buildSourceView>[0], sections);
  if (!view) throw new Error("Source revision is not ready");
  return view;
}
const itemOperation = {
  get: {
    responses: {
      "200": {
        description: "ok",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Plain" } } },
      },
    },
  },
};
const openapi = {
  openapi: "3.0.3",
  info: { title: "Nodes", version: "1" },
  paths: { "/items": itemOperation },
  components: {
    schemas: {
      Plain: { type: "string", minLength: 2 },
      Node: {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: { name: { type: "string" }, next: { $ref: "#/components/schemas/Node" } },
      },
      Wrapper: {
        type: "object",
        required: ["node"],
        properties: { node: { $ref: "#/components/schemas/Node" } },
      },
    },
  },
};

describe("document-level jsonSchema pointers", () => {
  it("resolves /components/schemas entries and bundles their recursive targets", async () => {
    const view = await parsedView(openapi, ["components"]);
    const plain = resolveSourceSchema(view, "/components/schemas/Plain");
    expect(plain).toEqual({ type: "string", minLength: 2 });
    expect(validateAgainstSchema(plain as Record<string, unknown>, "ab")).toBe("ab");
    expect(() => validateAgainstSchema(plain as Record<string, unknown>, "a")).toThrow(mismatch);
    const node = resolveSourceSchema(view, "/components/schemas/Node") as Record<string, unknown>;
    const valid = { name: "a", next: { name: "b", next: { name: "c" } } };
    expect(validateAgainstSchema(node, valid)).toBe(valid);
    expect(() =>
      validateAgainstSchema(node, { name: "a", next: { name: "b", next: { name: 3 } } }),
    ).toThrow(mismatch);
    // A component that only reaches the recursion through another component is bundled too.
    const wrapper = resolveSourceSchema(view, "/components/schemas/Wrapper") as Record<
      string,
      unknown
    >;
    expect(validateAgainstSchema(wrapper, { node: valid })).toEqual({ node: valid });
    expect(() =>
      validateAgainstSchema(wrapper, { node: { name: "a", next: { name: 1 } } }),
    ).toThrow(mismatch);
  });
  it("keeps in-operation pointers working beside the document-level ones", async () => {
    const view = await parsedView(openapi, ["paths", "components"]);
    expect(
      resolveSourceSchema(
        view,
        "/paths/~1items/get/responses/200/content/application~1json/schema",
      ),
    ).toEqual({ type: "string", minLength: 2 });
  });
  it("leaves undeclared components and sections that were not requested unresolved", async () => {
    const view = await parsedView(openapi, ["components"]);
    expect(resolveSourceSchema(view, "/components/schemas/Nope")).toBeUndefined();
    expect(resolveSourceSchema(view, "/components/schemas/Plain/enum")).toBeUndefined();
    // The section is parsed only when a pointer asks for it.
    const lazy = await parsedView(openapi, ["paths"]);
    expect(resolveSourceSchema(lazy, "/components/schemas/Plain")).toBeUndefined();
  });
  it("resolves Swagger 2 /definitions entries", async () => {
    const view = await parsedView(
      {
        swagger: "2.0",
        info: { title: "Pets", version: "1" },
        paths: {
          "/pets": {
            get: {
              responses: { "200": { description: "ok", schema: { $ref: "#/definitions/Pet" } } },
            },
          },
        },
        definitions: {
          Pet: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        },
      },
      ["definitions"],
    );
    const pet = resolveSourceSchema(view, "/definitions/Pet") as Record<string, unknown>;
    expect(validateAgainstSchema(pet, { name: "rex" })).toEqual({ name: "rex" });
    expect(() => validateAgainstSchema(pet, {})).toThrow(mismatch);
  });
});
describe("operation path prefix", () => {
  const swagger = (extra: object) => ({
    swagger: "2.0",
    info: { title: "Auth", version: "1" },
    paths: { "/auth/login": { post: { responses: { "200": { description: "ok" } } } } },
    ...extra,
  });
  it("takes the Swagger 2 basePath as the prefix requests must carry", async () => {
    expect((await parsedView(swagger({ basePath: "/api/v1" }), [])).basePath).toEqual([
      "api",
      "v1",
    ]);
    // Control: without a basePath the operations sit at the origin.
    expect((await parsedView(swagger({}), [])).basePath).toEqual([]);
  });
  it("takes the first OpenAPI 3 server URL's path", async () => {
    const view = await parsedView({ ...openapi, servers: [{ url: "https://host.test/v2" }] }, []);
    expect(view.basePath).toEqual(["v2"]);
  });
});
