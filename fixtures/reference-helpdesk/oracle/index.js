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
async function agent(url) {
  const response = await rawRequest(url, "/api/session", {
    method: "POST",
    value: { email: "agent@helpdesk.test", secret: "desk-secret" },
  });
  if (response.status !== 200 || typeof response.body.sessionToken !== "string")
    throw new Error("Oracle setup sign-in failed");
  return response.body.sessionToken;
}
async function createTicket(url, token, value, headers = {}) {
  return rawRequest(url, "/api/tickets", { method: "POST", token, headers, value });
}
async function claimed(url, ticketId = "t1") {
  const token = await agent(url);
  const claim = await rawRequest(url, `/api/tickets/${ticketId}/claim`, {
    method: "POST",
    token,
    value: {},
  });
  if (claim.status !== 200) throw new Error("Oracle setup claim failed");
  return { token, ticketId };
}

export const checks = {
  async secretValidation({ url }) {
    const empty = await rawRequest(url, "/api/session", {
      method: "POST",
      value: { email: "agent@helpdesk.test", secret: "" },
    });
    const wrong = await rawRequest(url, "/api/session", {
      method: "POST",
      value: { email: "agent@helpdesk.test", secret: "wrong" },
    });
    return verdict("secretValidation", empty.status === 401 && wrong.status === 401, {
      emptyStatus: empty.status,
      wrongStatus: wrong.status,
    });
  },
  async subjectValidation({ url, dbPath }) {
    const token = await agent(url);
    const before = state(dbPath, "SELECT count(*) AS n FROM tickets")[0].n;
    const blank = await createTicket(url, token, { subject: "   " });
    const after = state(dbPath, "SELECT count(*) AS n FROM tickets")[0].n;
    return verdict("subjectValidation", blank.status === 400 && after === before, {
      status: blank.status,
      rowsBefore: before,
      rowsAfter: after,
    });
  },
  async ticketPersistence({ url, dbPath }) {
    const token = await agent(url);
    const created = await createTicket(url, token, { subject: "Oracle persistence" });
    const rows = state(dbPath, "SELECT id FROM tickets WHERE subject='Oracle persistence'");
    const listed = await rawRequest(url, "/api/tickets?pageSize=100", { token });
    return verdict(
      "ticketPersistence",
      created.status === 201 && rows.length === 1 && listed.body.total === 6,
      { createdStatus: created.status, persistedRows: rows.length, listedTotal: listed.body.total },
    );
  },
  async closeResolution({ url, dbPath }) {
    const { token, ticketId } = await claimed(url);
    const blank = await rawRequest(url, `/api/tickets/${ticketId}/close`, {
      method: "POST",
      token,
      value: { resolution: "" },
    });
    const rows = state(dbPath, "SELECT status FROM tickets WHERE id=?", ticketId);
    return verdict("closeResolution", blank.status === 422 && rows[0]?.status === "open", {
      status: blank.status,
      persistedStatus: rows[0]?.status,
    });
  },
  async slaUrgent({ url, dbPath }) {
    const token = await agent(url);
    const created = await createTicket(url, token, { subject: "Oracle SLA", priority: "urgent" });
    const rows = state(dbPath, "SELECT sla_hours FROM tickets WHERE id=?", created.body.id);
    return verdict("slaUrgent", created.body.slaHours === 2 && rows[0]?.sla_hours === 2, {
      expected: 2,
      responseSla: created.body.slaHours,
      persistedSla: rows[0]?.sla_hours,
    });
  },
  async ticketsAuthorization({ url, dbPath }) {
    const rows = state(dbPath, "SELECT id FROM tickets ORDER BY seq LIMIT 1");
    if (!rows.length) throw new Error("Oracle setup seeded ticket absent");
    const response = await rawRequest(url, "/api/tickets");
    return verdict("ticketsAuthorization", response.status === 401, {
      status: response.status,
      leakedTicket: response.body.items?.some((item) => item.id === rows[0].id) ?? false,
    });
  },
  async ticketSchema({ url, dbPath }) {
    const token = await agent(url);
    const response = await rawRequest(url, "/api/tickets?pageSize=100", { token });
    const rows = state(dbPath, "SELECT id,priority FROM tickets WHERE status<>'closed'");
    return verdict(
      "ticketSchema",
      response.status === 200 &&
        rows.length === response.body.items.length &&
        rows.every((row) =>
          response.body.items.some((item) => item.id === row.id && item.priority === row.priority),
        ),
      response.body,
    );
  },
  async paginationContinuity({ url, dbPath }) {
    const token = await agent(url);
    const ids = [];
    for (let page = 1; page <= 3; page += 1) {
      const response = await rawRequest(url, `/api/tickets?pageSize=2&page=${page}`, { token });
      if (response.status !== 200) throw new Error("Oracle pagination setup failed");
      ids.push(...response.body.items.map((item) => item.id));
    }
    const expected = state(
      dbPath,
      "SELECT id FROM tickets WHERE status<>'closed' ORDER BY seq",
    ).map((row) => row.id);
    return verdict("paginationContinuity", JSON.stringify(ids) === JSON.stringify(expected), {
      expected,
      observed: ids,
    });
  },
  async createIdempotency({ url, dbPath }) {
    const token = await agent(url);
    const key = `oracle-${randomUUID()}`;
    const first = await createTicket(
      url,
      token,
      { subject: "Oracle once" },
      { "x-request-id": key },
    );
    const second = await createTicket(
      url,
      token,
      { subject: "Oracle once" },
      { "x-request-id": key },
    );
    const rows = state(dbPath, "SELECT id FROM tickets WHERE request_id=?", key);
    return verdict(
      "createIdempotency",
      first.status === 201 &&
        second.status === 200 &&
        second.body.id === first.body.id &&
        rows.length === 1,
      { firstId: first.body.id, secondId: second.body.id, persistedRows: rows.length },
    );
  },
  async escalationPersistence({ url, dbPath }) {
    const { token, ticketId } = await claimed(url);
    const escalated = await rawRequest(url, `/api/tickets/${ticketId}/escalate`, {
      method: "POST",
      token,
      value: {},
    });
    const rows = state(dbPath, "SELECT priority FROM tickets WHERE id=?", ticketId);
    const listed = await rawRequest(url, "/api/tickets?assignee=me", { token });
    return verdict(
      "escalationPersistence",
      escalated.status === 200 &&
        rows[0]?.priority === "high" &&
        listed.body.items[0]?.priority === "high",
      { responsePriority: escalated.body.priority, persistedPriority: rows[0]?.priority },
    );
  },
  async closePersistence({ url, dbPath }) {
    const { token, ticketId } = await claimed(url);
    const closed = await rawRequest(url, `/api/tickets/${ticketId}/close`, {
      method: "POST",
      token,
      value: { resolution: "Resolved by oracle" },
    });
    const rows = state(dbPath, "SELECT status FROM tickets WHERE id=?", ticketId);
    const listed = await rawRequest(url, "/api/tickets?assignee=me", { token });
    return verdict(
      "closePersistence",
      closed.status === 200 &&
        rows[0]?.status === "closed" &&
        listed.body.items[0]?.status === "closed",
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
