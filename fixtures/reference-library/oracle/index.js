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
async function member(url) {
  const response = await rawRequest(url, "/api/auth/token", {
    method: "POST",
    value: { email: "member@example.test", passcode: "library-passcode" },
  });
  if (response.status !== 200 || typeof response.body.token !== "string")
    throw new Error("Oracle setup login failed");
  return response.body.token;
}
async function borrow(url, bookId, token, headers = {}) {
  return rawRequest(url, "/api/loans", { method: "POST", token, headers, value: { bookId } });
}
async function borrowed(url, bookId = "b1") {
  const token = await member(url);
  const loan = await borrow(url, bookId, token);
  if (loan.status !== 201) throw new Error("Oracle setup borrow failed");
  return { token, loan };
}

export const checks = {
  async passcodeValidation({ url }) {
    const empty = await rawRequest(url, "/api/auth/token", {
      method: "POST",
      value: { email: "member@example.test", passcode: "" },
    });
    const wrong = await rawRequest(url, "/api/auth/token", {
      method: "POST",
      value: { email: "member@example.test", passcode: "wrong" },
    });
    return verdict("passcodeValidation", empty.status === 401 && wrong.status === 401, {
      emptyStatus: empty.status,
      wrongStatus: wrong.status,
    });
  },
  async loanPersistence({ url, dbPath }) {
    const { token, loan } = await borrowed(url);
    const rows = state(dbPath, "SELECT id FROM loans WHERE id=?", loan.body.id);
    const listed = await rawRequest(url, "/api/loans", { token });
    return verdict("loanPersistence", rows.length === 1 && listed.body.total === 1, {
      persistedRows: rows.length,
      listedTotal: listed.body.total,
    });
  },
  async borrowStock({ url, dbPath }) {
    const token = await member(url);
    const first = await borrow(url, "b2", token);
    const second = await borrow(url, "b2", token);
    const copies = state(dbPath, "SELECT copies FROM books WHERE id='b2'")[0]?.copies;
    return verdict("borrowStock", first.status === 201 && second.status === 409 && copies === 0, {
      firstStatus: first.status,
      secondStatus: second.status,
      copies,
    });
  },
  async fineCap({ url, dbPath }) {
    const { token, loan } = await borrowed(url);
    const returned = await rawRequest(url, `/api/loans/${loan.body.id}/return?daysHeld=120`, {
      method: "POST",
      token,
      value: {},
    });
    const rows = state(dbPath, "SELECT fine_cents FROM loans WHERE id=?", loan.body.id);
    return verdict("fineCap", returned.body.fineCents === 1000 && rows[0]?.fine_cents === 1000, {
      expected: 1000,
      responseFine: returned.body.fineCents,
      persistedFine: rows[0]?.fine_cents,
    });
  },
  async loansAuthorization({ url, dbPath }) {
    const { loan } = await borrowed(url);
    if (!state(dbPath, "SELECT id FROM loans WHERE id=?", loan.body.id).length)
      throw new Error("Oracle setup persisted loan absent");
    const response = await rawRequest(url, "/api/loans");
    return verdict("loansAuthorization", response.status === 401, {
      status: response.status,
      leakedLoan: response.body.items?.some((item) => item.id === loan.body.id) ?? false,
    });
  },
  async bookSchema({ url, dbPath }) {
    const response = await rawRequest(url, "/api/books?limit=100");
    const rows = state(dbPath, "SELECT id,copies FROM books ORDER BY id");
    return verdict(
      "bookSchema",
      response.status === 200 &&
        rows.length === response.body.items.length &&
        rows.every((row) =>
          response.body.items.some(
            (item) =>
              item.id === row.id &&
              Number.isInteger(item.copiesAvailable) &&
              item.copiesAvailable === row.copies,
          ),
        ),
      response.body,
    );
  },
  async paginationContinuity({ url, dbPath }) {
    const ids = [];
    for (let offset = 0; offset < 6; offset += 2) {
      const response = await rawRequest(url, `/api/books?limit=2&offset=${offset}`);
      if (response.status !== 200) throw new Error("Oracle pagination setup failed");
      ids.push(...response.body.items.map((item) => item.id));
    }
    const expected = state(dbPath, "SELECT id FROM books ORDER BY id").map((row) => row.id);
    return verdict("paginationContinuity", JSON.stringify(ids) === JSON.stringify(expected), {
      expected,
      observed: ids,
    });
  },
  async borrowIdempotency({ url, dbPath }) {
    const token = await member(url);
    const key = `oracle-${randomUUID()}`;
    const first = await borrow(url, "b1", token, { "idempotency-key": key });
    const second = await borrow(url, "b1", token, { "idempotency-key": key });
    const rows = state(dbPath, "SELECT id FROM loans WHERE idempotency_key=?", key);
    return verdict(
      "borrowIdempotency",
      first.status === 201 &&
        second.status === 200 &&
        second.body.id === first.body.id &&
        rows.length === 1,
      { firstId: first.body.id, secondId: second.body.id, persistedRows: rows.length },
    );
  },
  async renewalPersistence({ url, dbPath }) {
    const { token, loan } = await borrowed(url);
    const renewed = await rawRequest(url, `/api/loans/${loan.body.id}/renew`, {
      method: "POST",
      token,
      value: {},
    });
    const rows = state(dbPath, "SELECT renewals,due_at FROM loans WHERE id=?", loan.body.id);
    const listed = await rawRequest(url, "/api/loans", { token });
    return verdict(
      "renewalPersistence",
      renewed.status === 200 && rows[0]?.renewals === 1 && listed.body.items[0]?.renewals === 1,
      { responseRenewals: renewed.body.renewals, persistedRenewals: rows[0]?.renewals },
    );
  },
  async returnPersistence({ url, dbPath }) {
    const { token, loan } = await borrowed(url);
    const returned = await rawRequest(url, `/api/loans/${loan.body.id}/return`, {
      method: "POST",
      token,
      value: {},
    });
    const rows = state(dbPath, "SELECT status FROM loans WHERE id=?", loan.body.id);
    const listed = await rawRequest(url, "/api/loans", { token });
    return verdict(
      "returnPersistence",
      returned.status === 200 &&
        rows[0]?.status === "returned" &&
        listed.body.items[0]?.status === "returned",
      { responseStatus: returned.body.status, persistedStatus: rows[0]?.status },
    );
  },
  async serviceHealth({ url }) {
    const response = await rawRequest(url, "/health");
    return verdict(
      "serviceHealth",
      response.status === 200 && response.body.status === "ok",
      response,
    );
  },
};
