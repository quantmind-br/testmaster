import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const mutants = Object.freeze([
  "no-password-validation",
  "toast-without-persist",
  "health-degraded",
  "price-rounding",
  "orders-auth-bypass",
  "schema-field-renamed",
  "pagination-skip",
  "idempotency-ignored",
  "selector-drift",
  "products-update-ignored",
]);

const json = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
};
async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error("Payload too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * @typedef {object} ShopInstance
 * @property {string} url
 * @property {string} dbPath
 * @property {() => Promise<void>} close
 */
/** @returns {Promise<ShopInstance>} */
export async function startShop({
  port = 0,
  host = "127.0.0.1",
  mutant = process.env.REFERENCE_SHOP_MUTANT ?? "healthy",
  dataDir,
} = {}) {
  if (mutant !== "healthy" && !mutants.includes(mutant))
    throw new Error(`Unknown mutant: ${mutant}`);
  const temporary = dataDir === undefined;
  const directory = dataDir ?? (await mkdtemp(join(tmpdir(), "reference-shop-")));
  await mkdir(directory, { recursive: true });
  const dbPath = join(directory, "shop.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents>=0));
    CREATE TABLE IF NOT EXISTS cart (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE, quantity INTEGER NOT NULL CHECK(quantity>0), PRIMARY KEY(user_id,product_id));
    CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, total_cents INTEGER NOT NULL, items_json TEXT NOT NULL, idempotency_key TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS uploads (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, content BLOB NOT NULL);
  `);
  db.prepare("INSERT OR IGNORE INTO users VALUES (?, ?, ?)").run(
    "buyer",
    "demo@example.test",
    "correct-password",
  );
  const insertProduct = db.prepare("INSERT OR IGNORE INTO products VALUES (?, ?, ?)");
  for (const [id, name, cents] of [
    ["p1", "Precision Widget", 1005],
    ["p2", "Blue Mug", 1299],
    ["p3", "Notebook", 425],
    ["p4", "Pencil", 99],
    ["p5", "Canvas Bag", 1750],
  ])
    insertProduct.run(id, name, cents);
  const html = await readFile(new URL("./shop.html", import.meta.url));
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://shop.invalid");
      const path = url.pathname.replace(/^\/api(?=\/)/, "");
      const method = request.method;
      const parsed = async () => JSON.parse((await body(request)).toString("utf8") || "{}");
      if (path === "/acceptance/body") {
        const incoming = method === "POST" ? await parsed() : null;
        response.writeHead(200, {
          "content-type": "application/json",
          "x-private": "response-header-private-sentinel",
          "set-cookie": "private=header-cookie-sentinel; Path=/",
        });
        return response.end(
          JSON.stringify({
            business: "response-body-private-sentinel",
            requestAccepted: incoming?.private === "request-body-private-sentinel",
          }),
        );
      }
      if (path === "/acceptance/browser-bodies") {
        response.writeHead(200, { "content-type": "text/html" });
        return response.end(
          '<!doctype html><title>Body privacy</title><p data-testid="body-status">pending</p><script>fetch("/acceptance/body",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({private:"request-body-private-sentinel"})}).then(r=>r.json()).then(value=>{document.querySelector("p").textContent=value.requestAccepted?"ready":"failed";document.querySelector("p").dataset.testid="body-ready"})</script>',
        );
      }
      if (path === "/acceptance/browser-session") {
        const known =
          request.headers.cookie?.includes("matrix-session=synthetic-ephemeral-cookie") ?? false;
        response.writeHead(200, {
          "content-type": "text/html",
          "set-cookie":
            "matrix-session=synthetic-ephemeral-cookie; HttpOnly; SameSite=Strict; Path=/",
        });
        return response.end(
          `<!doctype html><title>Ephemeral session</title><p data-testid="session-state">${known ? "reused" : "fresh"}</p>`,
        );
      }
      if (path.startsWith("/adversarial/")) {
        const mode = path.slice("/adversarial/".length);
        const target = url.searchParams.get("target") ?? "http://169.254.169.254/latest/meta-data/";
        const quoted = JSON.stringify(target).replaceAll("<", "\\u003c");
        if (mode === "worker.js") {
          response.writeHead(200, { "content-type": "application/javascript" });
          return response.end(
            `self.addEventListener('install', e => e.waitUntil(fetch(${quoted}, {mode:'no-cors'})));`,
          );
        }
        const scripts = {
          js: `location.href=${quoted}`,
          fetch: `fetch(${quoted}, {mode:'no-cors'}).catch(()=>{})`,
          iframe: `const frame=document.createElement('iframe'); frame.src=${quoted}; document.body.append(frame)`,
          websocket: `new WebSocket(${quoted}.replace(/^http/, 'ws'))`,
          worker: `navigator.serviceWorker.register('/adversarial/worker.js?target='+encodeURIComponent(${quoted})).then(()=>document.body.dataset.worker='registered').catch(()=>document.body.dataset.worker='blocked')`,
        };
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        const meta =
          mode === "meta"
            ? `<meta http-equiv="refresh" content="0;url=${target.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">`
            : "";
        return response.end(
          `<!doctype html><html lang="en"><head>${meta}</head><body><h1 data-testid="fixture">Adversarial fixture</h1><script>${scripts[mode] ?? ""}</script></body></html>`,
        );
      }
      if (path === "/acceptance/server-error")
        return json(response, 500, { error: "deliberate_server_error", retained: "response-body" });
      if (path === "/acceptance/transport") {
        request.socket.destroy();
        return;
      }
      if (path.startsWith("/acceptance/auth/")) {
        const kind = path.split("/").at(-1);
        const expected = {
          basic: ["authorization", `Basic ${Buffer.from("synthetic:password").toString("base64")}`],
          bearer: ["authorization", "Bearer synthetic-bearer"],
          "api-key": ["x-api-key", "synthetic-api-key"],
          header: ["x-shop-auth", "synthetic-header"],
          cookie: ["cookie", "shop-session=synthetic-cookie"],
        }[kind];
        const accepted =
          kind === "none"
            ? !request.headers.authorization && !request.headers.cookie
            : expected && request.headers[expected[0]] === expected[1];
        return json(response, accepted ? 200 : 401, { authenticated: Boolean(accepted), kind });
      }
      if (path === "/health")
        return json(response, 200, { status: mutant === "health-degraded" ? "degraded" : "ok" });
      if (path === "/config")
        return json(response, 200, {
          checkoutHook: mutant === "selector-drift" ? "place-order" : "checkout-button",
        });
      if (["/auth/token", "/auth/refresh"].includes(path) && method === "POST") {
        const input = await parsed();
        const user = db
          .prepare("SELECT * FROM users WHERE email=?")
          .get(input.email ?? "demo@example.test");
        if (
          !user ||
          (user.password !== input.password &&
            !(mutant === "no-password-validation" && !input.password))
        )
          return json(response, 401, { error: "invalid_credentials" });
        const token = randomUUID();
        db.prepare("INSERT INTO sessions VALUES (?,?)").run(token, user.id);
        return json(response, 200, { token, userId: user.id });
      }
      const token = request.headers.authorization?.replace(/^Bearer /, "");
      const session = token
        ? db.prepare("SELECT user_id FROM sessions WHERE token=?").get(token)
        : undefined;
      const userId = session?.user_id;
      if (path === "/products" && method === "GET") {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 2)));
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
        if (!Number.isInteger(limit) || !Number.isInteger(offset))
          return json(response, 400, { error: "invalid_pagination" });
        const effectiveOffset = offset + (mutant === "pagination-skip" && offset > 0 ? 1 : 0);
        const items = db
          .prepare("SELECT id,name,price_cents FROM products ORDER BY id LIMIT ? OFFSET ?")
          .all(limit, effectiveOffset)
          .map((product) =>
            mutant === "schema-field-renamed"
              ? { id: product.id, name: product.name, costCents: product.price_cents }
              : { id: product.id, name: product.name, priceCents: product.price_cents },
          );
        return json(response, 200, {
          items,
          total: db.prepare("SELECT count(*) AS n FROM products").get().n,
          nextOffset: offset + limit,
        });
      }
      if (
        !url.pathname.startsWith("/api/") &&
        ["/login", "/", "/catalog", "/cart", "/orders", "/profile"].includes(path) &&
        method === "GET"
      ) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return response.end(html);
      }
      if (path === "/terms") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return response.end(
          '<!doctype html><html lang="en"><title>Terms</title><h1>Shop terms</h1><p data-testid="terms">Synthetic products only.</p></html>',
        );
      }
      if (path === "/widget") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return response.end(
          '<!doctype html><html lang="en"><title>Delivery widget</title><label>Delivery option<select data-testid="delivery-option"><option>Standard</option><option>Express</option></select></label><button type="button" onclick="document.querySelector(\'output\').textContent=\'Confirmed\'">Confirm delivery</button><output aria-live="polite"></output></html>',
        );
      }
      if (!userId && !(path === "/orders" && method === "GET" && mutant === "orders-auth-bypass"))
        return json(response, 401, { error: "authentication_required" });
      if (path === "/products" && method === "POST") {
        const input = await parsed();
        if (
          typeof input.name !== "string" ||
          !input.name.trim() ||
          !Number.isInteger(input.priceCents) ||
          input.priceCents < 0
        )
          return json(response, 400, { error: "invalid_product" });
        const id = randomUUID();
        db.prepare("INSERT INTO products VALUES (?,?,?)").run(id, input.name, input.priceCents);
        return json(response, 201, { id, ...input });
      }
      if (path.startsWith("/products/")) {
        const id = decodeURIComponent(path.slice(10));
        if (method === "GET") {
          const product = db
            .prepare("SELECT id,name,price_cents AS priceCents FROM products WHERE id=?")
            .get(id);
          return json(response, product ? 200 : 404, product ?? { error: "not_found" });
        }
        if (method === "PUT" || method === "PATCH") {
          const input = await parsed();
          if (
            typeof input.name !== "string" ||
            !input.name.trim() ||
            !Number.isInteger(input.priceCents) ||
            input.priceCents < 0
          )
            return json(response, 400, { error: "invalid_product" });
          if (mutant === "products-update-ignored") {
            const product = db
              .prepare("SELECT id,name,price_cents AS priceCents FROM products WHERE id=?")
              .get(id);
            return json(response, product ? 200 : 404, product ?? { error: "not_found" });
          }
          const result = db
            .prepare("UPDATE products SET name=?,price_cents=? WHERE id=?")
            .run(input.name, input.priceCents, id);
          return json(
            response,
            result.changes ? 200 : 404,
            result.changes ? { id, ...input } : { error: "not_found" },
          );
        }
        if (method === "DELETE") {
          const result = db.prepare("DELETE FROM products WHERE id=?").run(id);
          return json(response, result.changes ? 200 : 404, { deleted: Boolean(result.changes) });
        }
      }
      if (path === "/cart") {
        if (method === "POST") {
          const input = await parsed();
          if (
            !Number.isInteger(input.quantity) ||
            input.quantity < 1 ||
            !db.prepare("SELECT id FROM products WHERE id=?").get(input.productId ?? "")
          )
            return json(response, 400, { error: "invalid_cart_item" });
          db.prepare(
            "INSERT INTO cart VALUES (?,?,?) ON CONFLICT(user_id,product_id) DO UPDATE SET quantity=excluded.quantity",
          ).run(userId, input.productId, input.quantity);
        } else if (method === "DELETE") db.prepare("DELETE FROM cart WHERE user_id=?").run(userId);
        return json(response, 200, {
          items: db
            .prepare(
              "SELECT p.id,p.name,p.price_cents AS priceCents,c.quantity FROM cart c JOIN products p ON p.id=c.product_id WHERE user_id=? ORDER BY p.id",
            )
            .all(userId),
        });
      }
      if (path === "/orders") {
        if (method === "GET")
          return json(response, 200, {
            items: db
              .prepare(
                "SELECT id,total_cents AS totalCents,items_json AS itemsJson,created_at AS createdAt FROM orders WHERE user_id=? ORDER BY created_at,id",
              )
              .all(userId ?? "buyer"),
          });
        if (method === "POST") {
          const key = request.headers["idempotency-key"];
          if (typeof key !== "string" || !key.trim())
            return json(response, 400, { error: "idempotency_key_required" });
          const previous =
            mutant !== "idempotency-ignored" &&
            db
              .prepare(
                "SELECT id,total_cents AS totalCents FROM orders WHERE user_id=? AND idempotency_key=?",
              )
              .get(userId, key);
          if (previous) return json(response, 200, previous);
          const items = db
            .prepare(
              "SELECT product_id,quantity,price_cents FROM cart JOIN products ON products.id=cart.product_id WHERE user_id=?",
            )
            .all(userId);
          if (!items.length) return json(response, 422, { error: "empty_cart" });
          const totalCents = items.reduce(
            (total, item) =>
              total +
              (mutant === "price-rounding"
                ? Math.round(item.price_cents / 100) * 100
                : item.price_cents) *
                item.quantity,
            0,
          );
          const id = randomUUID();
          if (mutant !== "toast-without-persist")
            db.prepare("INSERT INTO orders VALUES (?,?,?,?,?,?)").run(
              id,
              userId,
              totalCents,
              JSON.stringify(items),
              key,
              new Date().toISOString(),
            );
          return json(response, 201, { id, totalCents });
        }
      }
      if (path === "/users" && method === "POST") {
        const input = await parsed();
        if (
          typeof input.email !== "string" ||
          !input.email.includes("@") ||
          typeof input.password !== "string" ||
          !input.password
        )
          return json(response, 400, { error: "invalid_user" });
        const id = randomUUID();
        db.prepare("INSERT INTO users VALUES (?,?,?)").run(id, input.email, input.password);
        return json(response, 201, { id, email: input.email });
      }
      if (path.startsWith("/users/") && method === "DELETE") {
        const result = db
          .prepare("DELETE FROM users WHERE id=? AND id!='buyer'")
          .run(path.slice(7));
        return json(response, result.changes ? 200 : 404, { deleted: Boolean(result.changes) });
      }
      if (path === "/profile/file") {
        if (method === "POST") {
          const content = await body(request);
          db.prepare(
            "INSERT INTO uploads VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET content=excluded.content",
          ).run(userId, content);
          return json(response, 201, { size: content.length });
        }
        const file = db.prepare("SELECT content FROM uploads WHERE user_id=?").get(userId);
        if (!file) return json(response, 404, { error: "not_found" });
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="profile.bin"',
        });
        return response.end(file.content);
      }
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      json(response, error.status ?? (error.code?.startsWith("ERR_SQLITE") ? 409 : 400), {
        error: error.status === 413 ? "payload_too_large" : "invalid_request",
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  let closed = false;
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${server.address().port}`,
    dbPath,
    async close() {
      if (closed) return;
      closed = true;
      server.closeIdleConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      db.close();
      if (temporary) await rm(directory, { recursive: true, force: true });
    },
  };
}
