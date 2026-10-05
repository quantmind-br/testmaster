import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
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
});
