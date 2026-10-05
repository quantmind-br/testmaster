import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { DatabaseSync } from "node:sqlite";

export function rawRequest(baseUrl, path, { method = "GET", token, value, headers = {} } = {}) {
  const payload = value === undefined ? undefined : JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(path, baseUrl),
      {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: JSON.parse(text),
            });
          } catch {
            reject(new Error(`Expected JSON at ${path}: ${text.slice(0, 100)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("Oracle request timed out")));
    req.end(payload);
  });
}
function state(dbPath, sql, ...parameters) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all(...parameters);
  } finally {
    db.close();
  }
}
function verdict(check, healthy, observed) {
  return { check, healthy, defective: !healthy, observed };
}
async function buyer(url) {
  const response = await rawRequest(url, "/api/auth/token", {
    method: "POST",
    value: { email: "demo@example.test", password: "correct-password" },
  });
  if (response.status !== 200 || typeof response.body.token !== "string")
    throw new Error("Oracle setup login failed");
  return response.body.token;
}
async function checkout(url) {
  const token = await buyer(url);
  const cart = await rawRequest(url, "/api/cart", {
    method: "POST",
    token,
    value: { productId: "p1", quantity: 3 },
  });
  if (cart.status !== 200) throw new Error("Oracle setup cart failed");
  const key = `oracle-${randomUUID()}`;
  const order = await rawRequest(url, "/api/orders", {
    method: "POST",
    token,
    headers: { "idempotency-key": key },
    value: {},
  });
  if (order.status !== 201) throw new Error("Oracle setup checkout failed");
  return { token, key, order };
}
export const checks = {
  async passwordValidation({ url, dbPath }) {
    const before = state(dbPath, "SELECT token FROM sessions").length;
    const response = await rawRequest(url, "/api/auth/token", {
      method: "POST",
      value: { email: "demo@example.test", password: "" },
    });
    const after = state(dbPath, "SELECT token FROM sessions").length;
    return verdict("passwordValidation", response.status === 401 && before === after, {
      status: response.status,
      sessionsCreated: after - before,
    });
  },
  async orderPersistence({ url, dbPath }) {
    const { order } = await checkout(url);
    const rows = state(dbPath, "SELECT id,total_cents FROM orders WHERE id=?", order.body.id);
    return verdict("orderPersistence", rows.length === 1 && rows[0].total_cents === 3015, {
      orderId: order.body.id,
      persistedRows: rows.length,
    });
  },
  async serviceHealth({ url }) {
    const response = await rawRequest(url, "/health");
    return verdict(
      "serviceHealth",
      response.status === 200 && response.body.status === "ok",
      response,
    );
  },
  async exactPrice({ url, dbPath }) {
    const { order } = await checkout(url);
    const rows = state(dbPath, "SELECT total_cents FROM orders WHERE id=?", order.body.id);
    return verdict("exactPrice", order.body.totalCents === 3015 && rows[0]?.total_cents === 3015, {
      expected: 3015,
      responseTotal: order.body.totalCents,
      persistedTotal: rows[0]?.total_cents,
    });
  },
  async ordersAuthorization({ url, dbPath }) {
    const { order } = await checkout(url);
    if (!state(dbPath, "SELECT id FROM orders WHERE id=?", order.body.id).length)
      throw new Error("Oracle setup persisted order absent");
    const response = await rawRequest(url, "/api/orders");
    return verdict("ordersAuthorization", response.status === 401, {
      status: response.status,
      leakedOrder: response.body.items?.some((item) => item.id === order.body.id) ?? false,
    });
  },
  async productSchema({ url, dbPath }) {
    const response = await rawRequest(url, "/api/products?limit=100");
    const rows = state(dbPath, "SELECT id,price_cents FROM products ORDER BY id");
    return verdict(
      "productSchema",
      response.status === 200 &&
        rows.length === response.body.items.length &&
        rows.every((row) =>
          response.body.items.some(
            (item) =>
              item.id === row.id &&
              Number.isInteger(item.priceCents) &&
              item.priceCents === row.price_cents,
          ),
        ),
      response.body,
    );
  },
  async paginationContinuity({ url, dbPath }) {
    const ids = [];
    for (let offset = 0; offset < 6; offset += 2) {
      const response = await rawRequest(url, `/api/products?limit=2&offset=${offset}`);
      if (response.status !== 200) throw new Error("Oracle pagination setup failed");
      ids.push(...response.body.items.map((item) => item.id));
    }
    const expected = state(dbPath, "SELECT id FROM products ORDER BY id").map((row) => row.id);
    return verdict("paginationContinuity", JSON.stringify(ids) === JSON.stringify(expected), {
      expected,
      observed: ids,
    });
  },
  async orderIdempotency({ url, dbPath }) {
    const { token, key, order } = await checkout(url);
    const second = await rawRequest(url, "/api/orders", {
      method: "POST",
      token,
      headers: { "idempotency-key": key },
      value: {},
    });
    const rows = state(dbPath, "SELECT id FROM orders WHERE idempotency_key=?", key);
    return verdict(
      "orderIdempotency",
      second.status === 200 && second.body.id === order.body.id && rows.length === 1,
      { firstId: order.body.id, secondId: second.body.id, persistedRows: rows.length },
    );
  },
};
export const mutantChecks = Object.freeze({
  "no-password-validation": "passwordValidation",
  "toast-without-persist": "orderPersistence",
  "health-degraded": "serviceHealth",
  "price-rounding": "exactPrice",
  "orders-auth-bypass": "ordersAuthorization",
  "schema-field-renamed": "productSchema",
  "pagination-skip": "paginationContinuity",
  "idempotency-ignored": "orderIdempotency",
});

export async function allChecks(instance) {
  const results = [];
  for (const check of Object.values(checks)) results.push(await check(instance));
  return results;
}

export async function checkoutSelector(page) {
  const button = page.getByRole("button", { name: "Checkout", exact: true });
  await button.waitFor();
  const hook = await button.getAttribute("data-testid");
  return verdict("checkoutSelector", hook === "checkout-button", { hook });
}

export async function browserChecks({ browser, url, dbPath }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const results = [];
  try {
    await page.goto(`${url}/login`);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="password-error"]')?.textContent ||
        location.pathname === "/catalog",
    );
    results.push(
      verdict(
        "browserPasswordValidation",
        (await page.locator('[data-testid="password-error"]').allTextContents()).includes(
          "Password is required",
        ),
        { path: new URL(page.url()).pathname },
      ),
    );
    await page.goto(`${url}/login`);
    await page.getByLabel("Password", { exact: true }).fill("correct-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByTestId("catalog-ready").waitFor();
    await page.getByTestId("add-p1").click();
    await page.getByTestId("toast").filter({ hasText: "Added to cart" }).waitFor();
    await page.getByRole("link", { name: "Cart", exact: true }).click();
    const checkoutButton = page.getByRole("button", { name: "Checkout", exact: true });
    await checkoutButton.waitFor();
    results.push(await checkoutSelector(page));
    const before = state(dbPath, "SELECT id FROM orders").length;
    await checkoutButton.click();
    await page.getByTestId("toast").filter({ hasText: "Order created:" }).waitFor();
    await page.getByRole("link", { name: "Orders", exact: true }).click();
    await page.getByTestId("order-count").waitFor();
    await page.reload();
    await page.getByTestId("order-count").waitFor();
    const after = state(dbPath, "SELECT id FROM orders").length;
    const displayed = Number(await page.getByTestId("order-count").textContent());
    results.push(
      verdict("browserOrderPersistence", after === before + 1 && displayed === after, {
        before,
        after,
        displayed,
      }),
    );
    return results;
  } finally {
    await context.close();
  }
}
