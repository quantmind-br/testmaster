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
function stored(dbPath, sql, ...parameters) {
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
async function signIn(url) {
  const response = await rawRequest(url, "/api/session", {
    method: "POST",
    value: { email: "desk@larkspur.test", passcode: "lark-passcode" },
  });
  if (response.status !== 200 || typeof response.body.accessToken !== "string")
    throw new Error("Oracle setup login failed");
  return response.body.accessToken;
}
async function register(url, token, value, headers = {}) {
  return rawRequest(url, "/api/bookings", { method: "POST", token, headers, value });
}
async function confirmed(url, bookingId = "b1") {
  const token = await signIn(url);
  const confirm = await rawRequest(url, `/api/bookings/${bookingId}/confirm`, {
    method: "POST",
    token,
    value: {},
  });
  if (confirm.status !== 200) throw new Error("Oracle setup confirmation failed");
  return { token, bookingId };
}

export const checks = {
  async passcodeValidation({ url }) {
    const empty = await rawRequest(url, "/api/session", {
      method: "POST",
      value: { email: "desk@larkspur.test", passcode: "" },
    });
    const wrong = await rawRequest(url, "/api/session", {
      method: "POST",
      value: { email: "desk@larkspur.test", passcode: "wrong" },
    });
    return verdict("passcodeValidation", empty.status === 401 && wrong.status === 401, {
      emptyStatus: empty.status,
      wrongStatus: wrong.status,
    });
  },
  async labelValidation({ url, dbPath }) {
    const token = await signIn(url);
    const before = stored(dbPath, "SELECT count(*) AS n FROM bookings")[0].n;
    const blank = await register(url, token, { label: "   " });
    const after = stored(dbPath, "SELECT count(*) AS n FROM bookings")[0].n;
    return verdict("labelValidation", blank.status === 400 && after === before, {
      status: blank.status,
      rowsBefore: before,
      rowsAfter: after,
    });
  },
  async bookingPersistence({ url, dbPath }) {
    const token = await signIn(url);
    const created = await register(url, token, { label: "Oracle persistence" });
    const rows = stored(dbPath, "SELECT id FROM bookings WHERE label='Oracle persistence'");
    const listed = await rawRequest(url, "/api/bookings?size=100", { token });
    return verdict(
      "bookingPersistence",
      created.status === 201 && rows.length === 1 && listed.body.count === 6,
      { createdStatus: created.status, persistedRows: rows.length, listedCount: listed.body.count },
    );
  },
  async closeNote({ url, dbPath }) {
    const { token, bookingId } = await confirmed(url);
    const blank = await rawRequest(url, `/api/bookings/${bookingId}/close`, {
      method: "POST",
      token,
      value: { note: "" },
    });
    const rows = stored(dbPath, "SELECT status FROM bookings WHERE id=?", bookingId);
    return verdict("closeNote", blank.status === 422 && rows[0]?.status === "open", {
      status: blank.status,
      persistedStatus: rows[0]?.status,
    });
  },
  async emergencyMinutes({ url, dbPath }) {
    const token = await signIn(url);
    const created = await register(url, token, {
      label: "Oracle response window",
      slot: "emergency",
    });
    const rows = stored(
      dbPath,
      "SELECT response_minutes FROM bookings WHERE id=?",
      created.body.id,
    );
    return verdict(
      "emergencyMinutes",
      created.body.responseMinutes === 15 && rows[0]?.response_minutes === 15,
      {
        expected: 15,
        responseMinutes: created.body.responseMinutes,
        persistedMinutes: rows[0]?.response_minutes,
      },
    );
  },
  async bookingsAuthorization({ url, dbPath }) {
    const rows = stored(dbPath, "SELECT id FROM bookings ORDER BY seq LIMIT 1");
    if (!rows.length) throw new Error("Oracle setup seeded booking absent");
    const response = await rawRequest(url, "/api/bookings");
    return verdict("bookingsAuthorization", response.status === 401, {
      status: response.status,
      leakedBooking: response.body.results?.some((item) => item.id === rows[0].id) ?? false,
    });
  },
  async bookingSchema({ url, dbPath }) {
    const token = await signIn(url);
    const response = await rawRequest(url, "/api/bookings?size=100", { token });
    const rows = stored(dbPath, "SELECT id,slot FROM bookings WHERE status<>'closed'");
    return verdict(
      "bookingSchema",
      response.status === 200 &&
        rows.length === response.body.results.length &&
        rows.every((row) =>
          response.body.results.some((item) => item.id === row.id && item.slot === row.slot),
        ),
      response.body,
    );
  },
  async paginationContinuity({ url, dbPath }) {
    const token = await signIn(url);
    const ids = [];
    for (let page = 1; page <= 3; page += 1) {
      const response = await rawRequest(url, `/api/bookings?size=2&page=${page}`, { token });
      if (response.status !== 200) throw new Error("Oracle pagination setup failed");
      ids.push(...response.body.results.map((item) => item.id));
    }
    const expected = stored(
      dbPath,
      "SELECT id FROM bookings WHERE status<>'closed' ORDER BY seq",
    ).map((row) => row.id);
    return verdict("paginationContinuity", JSON.stringify(ids) === JSON.stringify(expected), {
      expected,
      observed: ids,
    });
  },
  async registrationIdempotency({ url, dbPath }) {
    const token = await signIn(url);
    const key = `oracle-${randomUUID()}`;
    const first = await register(url, token, { label: "Oracle once" }, { "idempotency-key": key });
    const second = await register(url, token, { label: "Oracle once" }, { "idempotency-key": key });
    const rows = stored(dbPath, "SELECT id FROM bookings WHERE idempotency_key=?", key);
    return verdict(
      "registrationIdempotency",
      first.status === 201 &&
        second.status === 200 &&
        second.body.id === first.body.id &&
        rows.length === 1,
      { firstId: first.body.id, secondId: second.body.id, persistedRows: rows.length },
    );
  },
  async upgradePersistence({ url, dbPath }) {
    const { token, bookingId } = await confirmed(url);
    const upgraded = await rawRequest(url, `/api/bookings/${bookingId}/upgrade`, {
      method: "POST",
      token,
      value: {},
    });
    const rows = stored(dbPath, "SELECT slot FROM bookings WHERE id=?", bookingId);
    const listed = await rawRequest(url, "/api/bookings?owner=me", { token });
    return verdict(
      "upgradePersistence",
      upgraded.status === 200 &&
        rows[0]?.slot === "urgent" &&
        listed.body.results[0]?.slot === "urgent",
      { responseSlot: upgraded.body.slot, persistedSlot: rows[0]?.slot },
    );
  },
  async closePersistence({ url, dbPath }) {
    const { token, bookingId } = await confirmed(url);
    const closed = await rawRequest(url, `/api/bookings/${bookingId}/close`, {
      method: "POST",
      token,
      value: { note: "Closed by oracle" },
    });
    const rows = stored(dbPath, "SELECT status FROM bookings WHERE id=?", bookingId);
    const listed = await rawRequest(url, "/api/bookings?owner=me", { token });
    return verdict(
      "closePersistence",
      closed.status === 200 &&
        rows[0]?.status === "closed" &&
        listed.body.results[0]?.status === "closed",
      { responseStatus: closed.body.status, persistedStatus: rows[0]?.status },
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
