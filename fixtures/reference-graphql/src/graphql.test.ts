import { afterEach, describe, expect, it } from "vitest";
import { type GraphqlInstance, startGraphql } from "./index.js";

const instances: GraphqlInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.close()));
});
async function instance(mutant = "healthy") {
  const started = await startGraphql({ port: 0, mutant });
  instances.push(started);
  return started;
}
async function query(url: string, source: string, variables?: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: source, variables }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("reference GraphQL fixture", () => {
  it("serves the products and a single product", async () => {
    const { url } = await instance();
    const list = await query(url, "{ products(limit: 2) { id name priceCents } }");
    expect(list.status).toBe(200);
    expect(list.body).toEqual({
      data: {
        products: [
          { id: "p-1", name: "Notebook", priceCents: 1250 },
          { id: "p-2", name: "Pencil", priceCents: 150 },
        ],
      },
    });
    const single = await query(url, "query($id: ID!) { product(id: $id) { name } }", { id: "p-3" });
    expect(single.body).toEqual({ data: { product: { name: "Backpack" } } });
    const missing = await query(url, '{ product(id: "nope") { name } }');
    expect(missing.body).toEqual({ data: { product: null } });
  });

  it("answers validation errors with HTTP 200 and an errors array", async () => {
    const { url } = await instance();
    const result = await query(url, "{ products { unknownField } }");
    expect(result.status).toBe(200);
    expect(result.body.errors).toHaveLength(1);
  });

  it("returns an empty list for a negative limit on the healthy build", async () => {
    const { url } = await instance();
    const literal = await query(url, "{ products(limit: -1) { id } }");
    expect(literal).toEqual({ status: 200, body: { data: { products: [] } } });
    const variable = await query(url, "query($n: Int) { products(limit: $n) { id } }", { n: -7 });
    expect(variable).toEqual({ status: 200, body: { data: { products: [] } } });
  });

  it("answers HTTP 500 for a negative limit on the server-error-on-negative-limit mutant", async () => {
    const { url } = await instance("server-error-on-negative-limit");
    const literal = await query(url, "{ products(limit: -1) { id } }");
    expect(literal.status).toBe(500);
    const variable = await query(url, "query($n: Int) { products(limit: $n) { id } }", { n: -7 });
    expect(variable.status).toBe(500);
    const nonNegative = await query(url, "{ products(limit: 0) { id } }");
    expect(nonNegative).toEqual({ status: 200, body: { data: { products: [] } } });
  });

  it("rejects an unknown mutant", async () => {
    await expect(startGraphql({ port: 0, mutant: "no-such-mutant" })).rejects.toThrow();
  });
});
