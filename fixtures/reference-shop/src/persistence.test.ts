import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checks, rawRequest } from "../oracle/index.js";
import { startShop } from "./index.js";

it("retains business state across instance restart without sharing unrelated instances", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "shop-persist-"));
  let shop = await startShop({ dataDir });
  try {
    expect((await checks.orderPersistence(shop)).healthy).toBe(true);
    const login = await rawRequest(shop.url, "/api/auth/token", {
      method: "POST",
      value: { password: "correct-password" },
    });
    const token = login.body.token;
    await shop.close();
    shop = await startShop({ dataDir });
    expect((await rawRequest(shop.url, "/api/orders", { token })).body.items).toHaveLength(1);
    expect((await rawRequest(shop.url, "/api/cart", { token })).body.items).toHaveLength(1);
    const isolated = await startShop();
    try {
      const other = await rawRequest(isolated.url, "/api/auth/token", {
        method: "POST",
        value: { password: "correct-password" },
      });
      expect(
        (await rawRequest(isolated.url, "/api/orders", { token: other.body.token })).body.items,
      ).toHaveLength(0);
      expect((await rawRequest(isolated.url, "/api/orders", { token })).status).toBe(401);
    } finally {
      await isolated.close();
    }
  } finally {
    await shop.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
