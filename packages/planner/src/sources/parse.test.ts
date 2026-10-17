import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { ajv, validateAgainstSchema } from "@testmaster/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSource } from "./parse.js";
import type { SourceFormat } from "./types.js";

const revisionId = "svr_01900000-0000-7000-8000-000000000001";
const fixtureRoot = new URL("../../../../fixtures/", import.meta.url);
async function fixture(path: string, format: SourceFormat) {
  return parseSource({
    revisionId,
    format,
    bytes: await readFile(new URL(path, fixtureRoot)),
    relativePath: path,
  });
}
afterEach(() => vi.restoreAllMocks());
describe("deterministic grounded source parsing", () => {
  it("distinguishes image-only PDF from extractable requirements", async () => {
    const image = await fixture("reference-shop/artifacts/requirements-image-only.pdf", "pdf");
    expect(image.revision.status).toBe("needs_input");
    expect(image.chunks).toEqual([]);
    const text = await fixture("reference-shop/artifacts/requirements-text.pdf", "pdf");
    expect(text.revision.status).toBe("ready");
    expect(text.chunks.some((chunk) => chunk.requirementLike)).toBe(true);
    expect(text.chunks[0]?.evidenceRef.page).toBe(1);
  });
  it("parses OpenAPI and Swagger into grounded operations", async () => {
    for (const path of ["openapi.yaml", "swagger2.yaml"]) {
      const result = await fixture(`reference-shop/artifacts/${path}`, "openapi");
      expect(result.diagnostics, path).toEqual([]);
      expect(result.revision.status).toBe("ready");
      expect(
        result.chunks.some((chunk) => chunk.evidenceRef.jsonPointer === "/paths/~1health/get"),
      ).toBe(true);
    }
  });
  it("refuses external and cyclic references before any network boundary", async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const positive = await globalThis.fetch(`http://127.0.0.1:${address.port}`);
      await positive.text();
      expect(requests).toBe(1);
      fetch.mockClear();
      const externalBytes = (
        await readFile(new URL("adversarial/openapi-external.json", fixtureRoot))
      )
        .toString()
        .replace(
          "http://169.254.169.254/latest/meta-data/credentials",
          `http://127.0.0.1:${address.port}/schema`,
        );
      const external = await parseSource({
        revisionId,
        format: "openapi",
        bytes: Buffer.from(externalBytes),
      });
      const cyclic = await fixture("adversarial/openapi-cyclic.json", "openapi");
      expect(external.revision.status).toBe("invalid");
      expect(cyclic.revision.status).toBe("invalid");
      expect(external.diagnostics[0]?.code).toBe("external_reference");
      expect(cyclic.diagnostics[0]?.code).toBe("cyclic_reference");
      expect(fetch).not.toHaveBeenCalled();
      expect(requests).toBe(1);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
  it("imports recursive OpenAPI schemas as finite self-contained operations", async () => {
    const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
    const bytes = Buffer.from(
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Recursive", version: "1.0.0" },
        paths: {
          "/tree": {
            get: {
              responses: {
                "200": {
                  description: "Tree",
                  content: { "application/json": { schema: ref("Node") } },
                },
              },
            },
          },
          "/parity": {
            get: {
              responses: {
                "200": {
                  description: "Parity",
                  content: { "application/json": { schema: ref("Even") } },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            // `allOf` below is a property name; only the keyword form is instance-neutral.
            Node: {
              type: "object",
              required: ["name"],
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                children: { type: "array", items: ref("Node") },
                allOf: ref("Node"),
                dependentSchemas: ref("Node"),
                $ref: ref("Node"),
              },
            },
            Even: { type: "object", properties: { next: ref("Odd") } },
            Odd: {
              type: "object",
              required: ["next"],
              properties: { next: { oneOf: [{ type: "null" }, ref("Even")] } },
            },
          },
        },
      }),
    );
    const fetch = vi.spyOn(globalThis, "fetch");
    const result = await parseSource({ revisionId, format: "openapi", bytes });
    expect(result.diagnostics).toEqual([]);
    expect(result.revision.status).toBe("ready");
    expect(fetch).not.toHaveBeenCalled();
    const operations = result.inventory.operations as {
      path: string;
      operation: {
        $defs: Record<string, unknown>;
        responses: Record<string, { content: Record<string, { schema: unknown }> }>;
      };
    }[];
    const tree = operations.find((item) => item.path === "/tree")?.operation;
    expect(tree?.responses["200"]?.content["application/json"]?.schema).toEqual({
      $ref: "#/$defs/components~1schemas~1Node",
    });
    expect(Object.keys(tree?.$defs ?? {})).toEqual(["components/schemas/Node"]);
    // The chunk keeps the reference the source wrote, grounded at the operation pointer.
    const chunk = result.chunks.find(
      (item) => item.evidenceRef.jsonPointer === "/paths/~1tree/get",
    );
    expect(chunk?.text).toContain("#/components/schemas/Node");
    // Standalone schema: the operation's `$defs` makes the recursive reference resolvable.
    const schema = {
      ...(tree?.responses["200"]?.content["application/json"]?.schema as object),
      $defs: tree?.$defs,
    } as Record<string, unknown>;
    const nested = { name: "a", children: [{ name: "b", children: [{ name: "c" }] }] };
    expect(validateAgainstSchema(schema, nested)).toBe(nested);
    expect(() =>
      validateAgainstSchema(schema, { name: "a", children: [{ name: "b", children: [{}] }] }),
    ).toThrow("Response does not match source schema");
    expect(() => validateAgainstSchema(schema, { name: "a", allOf: { name: 1 } })).toThrow(
      "Response does not match source schema",
    );
    const parity = operations.find((item) => item.path === "/parity")?.operation;
    expect(Object.keys(parity?.$defs ?? {}).sort()).toEqual([
      "components/schemas/Even",
      "components/schemas/Odd",
    ]);
  });
  it("imports the generated OpenAPI with every response schema usable for assertions", async () => {
    const bytes = await readFile(new URL("../../../contracts/openapi.json", import.meta.url));
    const result = await parseSource({ revisionId, format: "openapi", bytes });
    expect(result.diagnostics).toEqual([]);
    expect(result.revision.status).toBe("ready");
    const operations = result.inventory.operations as {
      operation: {
        $defs?: Record<string, unknown>;
        responses?: Record<string, { content?: Record<string, { schema?: object }> }>;
      };
    }[];
    expect(operations.length).toBeGreaterThan(100);
    let checked = 0;
    for (const { operation } of operations)
      for (const response of Object.values(operation.responses ?? {}))
        for (const body of Object.values(response.content ?? {})) {
          if (!body.schema) continue;
          const schema = (
            operation.$defs ? { ...body.schema, $defs: operation.$defs } : body.schema
          ) as Record<string, unknown>;
          // A reference that does not resolve makes compilation throw.
          expect(() => ajv.compile(schema)).not.toThrow();
          checked += 1;
        }
    expect(checked).toBeGreaterThan(100);
  }, 120_000);
  it("still refuses references that denote no schema, dangle, are malformed or explode", async () => {
    const spec = (schemas: Record<string, unknown>) =>
      Buffer.from(
        JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Invalid", version: "1.0.0" },
          paths: {
            "/tree": {
              get: {
                responses: {
                  "200": {
                    description: "Tree",
                    content: {
                      "application/json": { schema: { $ref: "#/components/schemas/S0" } },
                    },
                  },
                },
              },
            },
          },
          components: { schemas },
        }),
      );
    const fanOut: Record<string, unknown> = { S30: { type: "string" } };
    for (let level = 0; level < 30; level += 1) {
      const next = { $ref: `#/components/schemas/S${level + 1}` };
      fanOut[`S${level}`] = { type: "object", properties: { a: next, b: next } };
    }
    const cases: [string, Record<string, unknown>, string][] = [
      [
        "same-instance cycle",
        { S0: { allOf: [{ $ref: "#/components/schemas/S0" }] } },
        "cyclic_reference",
      ],
      [
        "alias cycle",
        { S0: { $ref: "#/components/schemas/B" }, B: { $ref: "#/components/schemas/S0" } },
        "cyclic_reference",
      ],
      [
        "dependentSchemas cycle",
        {
          S0: {
            type: "object",
            dependentSchemas: { trigger: { $ref: "#/components/schemas/S0" } },
          },
        },
        "cyclic_reference",
      ],
      ["dangling pointer", { S0: { $ref: "#/components/schemas/Nope" } }, "missing_reference"],
      ["malformed pointer", { S0: { $ref: "#/components/schemas/a%20b" } }, "invalid_reference"],
      ["non-string reference", { S0: { $ref: 5 } }, "invalid_reference"],
      ["fan-out expansion", fanOut, "reference_limit"],
    ];
    for (const [name, schemas, code] of cases) {
      const result = await parseSource({ revisionId, format: "openapi", bytes: spec(schemas) });
      expect(result.revision.status, name).toBe("invalid");
      expect(result.diagnostics[0]?.code, name).toBe(code);
      expect(result.chunks, name).toEqual([]);
    }
    const exploded = await parseSource({ revisionId, format: "openapi", bytes: spec(fanOut) });
    expect(exploded.diagnostics[0]?.message).toContain("exceeded at /paths/~1tree/get");
  });
  it("names the operations whose responses declare no status code", async () => {
    const swagger = (paths: Record<string, unknown>) =>
      Buffer.from(JSON.stringify({ swagger: "2.0", info: { title: "A", version: "1" }, paths }));
    const result = await parseSource({
      revisionId,
      format: "openapi",
      bytes: swagger({
        "/a": { get: { responses: {} }, post: { responses: { "x-note": "none" } } },
        "/b": { get: { responses: { "200": { description: "ok" } } } },
      }),
    });
    expect(result.revision.status).toBe("invalid");
    expect(result.diagnostics[0]?.message).toContain(
      "2 operations declare no response, and responses must name at least one status code: GET /a, POST /a",
    );
    expect(result.diagnostics[0]?.message).not.toContain("GET /b");
  });
  it("inventories Postman scripts without evaluating them", async () => {
    const result = await fixture("reference-shop/artifacts/postman.json", "postman");
    expect(result.revision.status).toBe("ready");
    expect(result.inventory.scripts).toMatchObject([{ executed: false, listen: "prerequest" }]);
    expect(result.inventory.requests).toHaveLength(3);
    expect(result.inventory.environmentRefs).toContain("token");
  });
  it("grounds Markdown headings, GFM tables and requirements with stable byte ranges", async () => {
    const bytes = Buffer.from(
      "# Café\n\nThe buyer must log in.\n\n| Name | Required |\n| --- | --- |\n| Password | yes |\n",
    );
    const first = await parseSource({ revisionId, bytes, format: "markdown" });
    const second = await parseSource({ revisionId, bytes, format: "markdown" });
    expect(first.chunks).toEqual(second.chunks);
    expect(first.chunks.some((chunk) => chunk.kind === "table")).toBe(true);
    for (const chunk of first.chunks)
      expect(
        bytes
          .subarray(
            chunk.evidenceRef.offset,
            (chunk.evidenceRef.offset ?? 0) + (chunk.evidenceRef.length ?? 0),
          )
          .toString(),
      ).toBe(chunk.text);
    expect(first.chunks.filter((chunk) => chunk.requirementLike).length).toBeGreaterThan(0);
  });
  it("validates GraphQL and inventories query/mutation separately", async () => {
    const parsed = await parseSource({
      revisionId,
      format: "graphql",
      bytes: Buffer.from(
        "type Query { product(id: ID!): String } type Mutation { create: Boolean }",
      ),
    });
    expect(parsed.revision.status).toBe("ready");
    expect(parsed.inventory.operations).toMatchObject([{ kind: "Query" }, { kind: "Mutation" }]);
    expect(
      (
        await parseSource({
          revisionId,
          format: "graphql",
          bytes: Buffer.from("type Query { broken: Unknown }"),
        })
      ).revision.status,
    ).toBe("invalid");
  });
  it("never reports empty, oversized, malformed or archive bytes as ready", async () => {
    for (const bytes of [Buffer.from(""), Buffer.from([0xff]), Buffer.from("PK archive")])
      expect((await parseSource({ revisionId, bytes, format: "text" })).revision.status).not.toBe(
        "ready",
      );
    expect(
      (await parseSource({ revisionId, format: "text", bytes: Buffer.from("12345"), maxBytes: 4 }))
        .diagnostics[0]?.code,
    ).toBe("size_limit");
  });
  describe("OpenAPI 3.2", () => {
    const parse32 = (document: Record<string, unknown>) =>
      parseSource({
        revisionId,
        format: "openapi",
        bytes: Buffer.from(JSON.stringify({ info: { title: "T", version: "1" }, ...document })),
      });
    const ok = { description: "ok" };
    it("accepts a 3.2 document with QUERY, additionalOperations, itemSchema and 3.2-only fields", async () => {
      const result = await parse32({
        openapi: "3.2.0",
        $self: "https://example.test/api",
        tags: [{ name: "events", summary: "Events", kind: "nav" }],
        servers: [{ url: "https://example.test", name: "prod" }],
        paths: {
          "/events": {
            get: {
              responses: {
                "200": {
                  description: "Stream",
                  summary: "A stream of events",
                  content: {
                    "application/jsonl": { itemSchema: { $ref: "#/components/schemas/Event" } },
                  },
                },
              },
            },
            query: { responses: { "200": ok } },
            additionalOperations: { COPY: { responses: { "200": ok } } },
          },
        },
        components: { schemas: { Event: { type: "object", xml: { nodeType: "element" } } } },
      });
      expect(result.revision.status).toBe("ready");
      const operations = (
        result.inventory.operations as Array<{ method: string; path: string }>
      ).map((item) => `${item.method} ${item.path}`);
      expect(operations).toEqual(["GET /events", "QUERY /events", "COPY /events"]);
    });
    it("keeps unknown 3.2 keywords out of the verdict and reports them as warnings", async () => {
      const result = await parse32({
        openapi: "3.2.1",
        paths: { "/a": { get: { responses: { "200": { ...ok, futureKeyword: true } } } } },
      });
      expect(result.revision.status).toBe("ready");
      expect(result.diagnostics.map((item) => item.message).join()).toContain("futureKeyword");
    });
    it("still rejects a 3.2 document whose QUERY operation is malformed, and 3.3", async () => {
      const bad = await parse32({
        openapi: "3.2.0",
        paths: { "/a": { query: { responses: { "200": {} } } } },
      });
      expect(bad.revision.status).toBe("invalid");
      const future = await parse32({ openapi: "3.3.0", paths: {} });
      expect(future.revision.status).toBe("invalid");
      expect(future.diagnostics[0]?.code).toBe("unsupported_openapi");
    });
  });
});
