import { afterEach, describe, expect, it } from "vitest";
import { checks, mutantChecks, rawRequest } from "../oracle/index.js";
import { type ShopInstance, startShop } from "./index.js";

const instances: ShopInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((shop) => shop.close()));
});
async function instance(mutant = "healthy") {
  const shop = await startShop({ port: 0, mutant });
  instances.push(shop);
  return shop;
}

describe("Independent corpus ground truth", () => {
  for (const [mutant, check] of Object.entries(mutantChecks)) {
    it(`${check} accepts baseline and detects ${mutant}`, async () => {
      const baseline = await instance();
      const defective = await instance(mutant);
      expect(await checks[check](baseline)).toMatchObject({ healthy: true, defective: false });
      expect(await checks[check](defective)).toMatchObject({ healthy: false, defective: true });
    });
  }
  it("persists CRUD, cart and cleanup through raw HTTP", async () => {
    const shop = await instance();
    const login = await rawRequest(shop.url, "/api/auth/token", {
      method: "POST",
      value: { email: "demo@example.test", password: "correct-password" },
    });
    const token = login.body.token;
    const created = await rawRequest(shop.url, "/api/products", {
      method: "POST",
      token,
      value: { name: "Owned product", priceCents: 123 },
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(
      (
        await rawRequest(shop.url, `/api/products/${id}`, {
          method: "PUT",
          token,
          value: { name: "Updated product", priceCents: 456 },
        })
      ).status,
    ).toBe(200);
    expect((await rawRequest(shop.url, `/api/products/${id}`, { token })).body).toMatchObject({
      name: "Updated product",
      priceCents: 456,
    });
    expect(
      (
        await rawRequest(shop.url, "/api/cart", {
          method: "POST",
          token,
          value: { productId: id, quantity: 2 },
        })
      ).body.items,
    ).toContainEqual({ id, name: "Updated product", priceCents: 456, quantity: 2 });
    expect((await rawRequest(shop.url, "/api/cart", { token })).body.items).toHaveLength(1);
    expect(
      (await rawRequest(shop.url, "/api/cart", { method: "DELETE", token })).body.items,
    ).toHaveLength(0);
    expect(
      (
        await rawRequest(shop.url, "/api/orders", {
          method: "POST",
          token,
          value: {},
          headers: { "idempotency-key": "empty-cart" },
        })
      ).status,
    ).toBe(422);
    expect(
      (await rawRequest(shop.url, `/api/products/${id}`, { method: "DELETE", token })).body.deleted,
    ).toBe(true);
    expect((await rawRequest(shop.url, `/api/products/${id}`, { token })).status).toBe(404);
    const user = await rawRequest(shop.url, "/api/users", {
      method: "POST",
      token,
      value: { email: "cleanup@example.test", password: "owned-password" },
    });
    expect(user.status).toBe(201);
    expect(
      (await rawRequest(shop.url, `/api/users/${user.body.id}`, { method: "DELETE", token })).body
        .deleted,
    ).toBe(true);
    expect(
      (
        await rawRequest(shop.url, "/api/auth/token", {
          method: "POST",
          value: { email: "cleanup@example.test", password: "owned-password" },
        })
      ).status,
    ).toBe(401);
  });
  it("roundtrips uploaded profile bytes and refuses oversized requests", async () => {
    const shop = await instance();
    const login = await rawRequest(shop.url, "/api/auth/token", {
      method: "POST",
      value: { password: "correct-password" },
    });
    const headers = { authorization: `Bearer ${login.body.token}` };
    const bytes = new Uint8Array([0, 255, 1, 128, 10]);
    expect(
      (await fetch(`${shop.url}/api/profile/file`, { method: "POST", headers, body: bytes }))
        .status,
    ).toBe(201);
    const download = await fetch(`${shop.url}/api/profile/file`, { headers });
    expect(download.headers.get("content-disposition")).toContain("profile.bin");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
    expect(
      (
        await fetch(`${shop.url}/api/profile/file`, {
          method: "POST",
          headers,
          body: new Uint8Array(1024 * 1024 + 1),
        })
      ).status,
    ).toBe(413);
  });
});
