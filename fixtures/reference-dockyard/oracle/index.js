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
async function clerk(url) {
  const response = await rawRequest(url, "/api/session", {
    method: "POST",
    value: { email: "clerk@dockyard.test", secret: "dock-secret" },
  });
  if (response.status !== 200 || typeof response.body.sessionToken !== "string")
    throw new Error("Oracle setup sign-in failed");
  return response.body.sessionToken;
}
async function logShipment(url, token, value, headers = {}) {
  return rawRequest(url, "/api/shipments", { method: "POST", token, headers, value });
}
async function accepted(url, shipmentId = "s1") {
  const token = await clerk(url);
  const accept = await rawRequest(url, `/api/shipments/${shipmentId}/accept`, {
    method: "POST",
    token,
    value: {},
  });
  if (accept.status !== 200) throw new Error("Oracle setup accept failed");
  return { token, shipmentId };
}

export const checks = {
  async passphraseValidation({ url }) {
    const empty = await rawRequest(url, "/api/session", {
      method: "POST",
      value: { email: "clerk@dockyard.test", secret: "" },
    });
    const wrong = await rawRequest(url, "/api/session", {
      method: "POST",
      value: { email: "clerk@dockyard.test", secret: "wrong" },
    });
    return verdict("passphraseValidation", empty.status === 401 && wrong.status === 401, {
      emptyStatus: empty.status,
      wrongStatus: wrong.status,
    });
  },
  async referenceValidation({ url, dbPath }) {
    const token = await clerk(url);
    const before = state(dbPath, "SELECT count(*) AS n FROM shipments")[0].n;
    const blank = await logShipment(url, token, { reference: "   " });
    const after = state(dbPath, "SELECT count(*) AS n FROM shipments")[0].n;
    return verdict("referenceValidation", blank.status === 400 && after === before, {
      status: blank.status,
      rowsBefore: before,
      rowsAfter: after,
    });
  },
  async shipmentPersistence({ url, dbPath }) {
    const token = await clerk(url);
    const created = await logShipment(url, token, { reference: "Oracle persistence" });
    const rows = state(dbPath, "SELECT id FROM shipments WHERE reference='Oracle persistence'");
    const listed = await rawRequest(url, "/api/shipments?pageSize=100", { token });
    return verdict(
      "shipmentPersistence",
      created.status === 201 && rows.length === 1 && listed.body.total === 6,
      { createdStatus: created.status, persistedRows: rows.length, listedTotal: listed.body.total },
    );
  },
  async sealNote({ url, dbPath }) {
    const { token, shipmentId } = await accepted(url);
    const blank = await rawRequest(url, `/api/shipments/${shipmentId}/seal`, {
      method: "POST",
      token,
      value: { note: "" },
    });
    const rows = state(dbPath, "SELECT status FROM shipments WHERE id=?", shipmentId);
    return verdict("sealNote", blank.status === 422 && rows[0]?.status === "open", {
      status: blank.status,
      persistedStatus: rows[0]?.status,
    });
  },
  async handlingExpress({ url, dbPath }) {
    const token = await clerk(url);
    const created = await logShipment(url, token, {
      reference: "Oracle handling",
      tier: "express",
    });
    const rows = state(dbPath, "SELECT handling_hours FROM shipments WHERE id=?", created.body.id);
    return verdict(
      "handlingExpress",
      created.body.handlingHours === 4 && rows[0]?.handling_hours === 4,
      {
        expected: 4,
        responseHours: created.body.handlingHours,
        persistedHours: rows[0]?.handling_hours,
      },
    );
  },
  async shipmentsAuthorization({ url, dbPath }) {
    const rows = state(dbPath, "SELECT id FROM shipments ORDER BY seq LIMIT 1");
    if (!rows.length) throw new Error("Oracle setup seeded shipment absent");
    const response = await rawRequest(url, "/api/shipments");
    return verdict("shipmentsAuthorization", response.status === 401, {
      status: response.status,
      leakedShipment: response.body.items?.some((item) => item.id === rows[0].id) ?? false,
    });
  },
  async shipmentSchema({ url, dbPath }) {
    const token = await clerk(url);
    const response = await rawRequest(url, "/api/shipments?pageSize=100", { token });
    const rows = state(dbPath, "SELECT id,tier FROM shipments WHERE status<>'sealed'");
    return verdict(
      "shipmentSchema",
      response.status === 200 &&
        rows.length === response.body.items.length &&
        rows.every((row) =>
          response.body.items.some((item) => item.id === row.id && item.tier === row.tier),
        ),
      response.body,
    );
  },
  async paginationContinuity({ url, dbPath }) {
    const token = await clerk(url);
    const ids = [];
    for (let page = 1; page <= 3; page += 1) {
      const response = await rawRequest(url, `/api/shipments?pageSize=2&page=${page}`, { token });
      if (response.status !== 200) throw new Error("Oracle pagination setup failed");
      ids.push(...response.body.items.map((item) => item.id));
    }
    const expected = state(
      dbPath,
      "SELECT id FROM shipments WHERE status<>'sealed' ORDER BY seq",
    ).map((row) => row.id);
    return verdict("paginationContinuity", JSON.stringify(ids) === JSON.stringify(expected), {
      expected,
      observed: ids,
    });
  },
  async logIdempotency({ url, dbPath }) {
    const token = await clerk(url);
    const key = `oracle-${randomUUID()}`;
    const first = await logShipment(
      url,
      token,
      { reference: "Oracle once" },
      { "x-request-id": key },
    );
    const second = await logShipment(
      url,
      token,
      { reference: "Oracle once" },
      { "x-request-id": key },
    );
    const rows = state(dbPath, "SELECT id FROM shipments WHERE request_id=?", key);
    return verdict(
      "logIdempotency",
      first.status === 201 &&
        second.status === 200 &&
        second.body.id === first.body.id &&
        rows.length === 1,
      { firstId: first.body.id, secondId: second.body.id, persistedRows: rows.length },
    );
  },
  async expeditePersistence({ url, dbPath }) {
    const { token, shipmentId } = await accepted(url);
    const expedited = await rawRequest(url, `/api/shipments/${shipmentId}/expedite`, {
      method: "POST",
      token,
      value: {},
    });
    const rows = state(dbPath, "SELECT tier FROM shipments WHERE id=?", shipmentId);
    const listed = await rawRequest(url, "/api/shipments?assignee=me", { token });
    return verdict(
      "expeditePersistence",
      expedited.status === 200 &&
        rows[0]?.tier === "priority" &&
        listed.body.items[0]?.tier === "priority",
      { responseTier: expedited.body.tier, persistedTier: rows[0]?.tier },
    );
  },
  async sealPersistence({ url, dbPath }) {
    const { token, shipmentId } = await accepted(url);
    const sealed = await rawRequest(url, `/api/shipments/${shipmentId}/seal`, {
      method: "POST",
      token,
      value: { note: "Sealed by oracle" },
    });
    const rows = state(dbPath, "SELECT status FROM shipments WHERE id=?", shipmentId);
    const listed = await rawRequest(url, "/api/shipments?assignee=me", { token });
    return verdict(
      "sealPersistence",
      sealed.status === 200 &&
        rows[0]?.status === "sealed" &&
        listed.body.items[0]?.status === "sealed",
      { responseStatus: sealed.body.status, persistedStatus: rows[0]?.status },
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
