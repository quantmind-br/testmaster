import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/** Independent HTTP probe: the oracle never imports the application under test. */
export async function rawRequest(
  baseUrl,
  path,
  { method = "GET", token, value, headers = {} } = {},
) {
  const payload = value === undefined ? undefined : JSON.stringify(value);
  const reply = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: payload,
    signal: AbortSignal.timeout(5000),
  });
  const text = await reply.text();
  try {
    return {
      status: reply.status,
      headers: Object.fromEntries(reply.headers),
      body: JSON.parse(text),
    };
  } catch {
    throw new Error(`Expected JSON at ${path}: ${text.slice(0, 100)}`);
  }
}
function select(dbPath, sql, ...parameters) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all(...parameters);
  } finally {
    db.close();
  }
}
const outcome = (check, healthy, observed) => ({ check, healthy, defective: !healthy, observed });
async function openDesk(url) {
  const reply = await rawRequest(url, "/api/session", {
    method: "POST",
    value: { handle: "front@marlow.test", pin: "marlow-pin-77" },
  });
  if (reply.status !== 200 || typeof reply.body.accessToken !== "string")
    throw new Error("Oracle setup sign-in failed");
  return reply.body.accessToken;
}
const reserve = (url, token, value, headers = {}) =>
  rawRequest(url, "/api/stays", { method: "POST", token, headers, value });
async function assigned(url, stayId = "s1") {
  const token = await openDesk(url);
  const reply = await rawRequest(url, `/api/stays/${stayId}/assign`, {
    method: "POST",
    token,
    value: {},
  });
  if (reply.status !== 200) throw new Error("Oracle setup assignment failed");
  return { token, stayId };
}

export const checks = {
  async pinValidation({ url }) {
    const empty = await rawRequest(url, "/api/session", {
      method: "POST",
      value: { handle: "front@marlow.test", pin: "" },
    });
    const wrong = await rawRequest(url, "/api/session", {
      method: "POST",
      value: { handle: "front@marlow.test", pin: "not-the-pin" },
    });
    return outcome("pinValidation", empty.status === 401 && wrong.status === 401, {
      emptyStatus: empty.status,
      wrongStatus: wrong.status,
    });
  },
  async guestValidation({ url, dbPath }) {
    const token = await openDesk(url);
    const before = select(dbPath, "SELECT count(*) AS n FROM stays")[0].n;
    const blank = await reserve(url, token, { guest: "   " });
    const after = select(dbPath, "SELECT count(*) AS n FROM stays")[0].n;
    return outcome("guestValidation", blank.status === 400 && after === before, {
      status: blank.status,
      rowsBefore: before,
      rowsAfter: after,
    });
  },
  async stayPersistence({ url, dbPath }) {
    const token = await openDesk(url);
    const created = await reserve(url, token, { guest: "Oracle persistence" });
    const rows = select(dbPath, "SELECT id FROM stays WHERE guest='Oracle persistence'");
    const listed = await rawRequest(url, "/api/stays?perPage=100", { token });
    return outcome(
      "stayPersistence",
      created.status === 201 && rows.length === 1 && listed.body.total === 6,
      { createdStatus: created.status, persistedRows: rows.length, listedTotal: listed.body.total },
    );
  },
  async keyTagRequired({ url, dbPath }) {
    const { token, stayId } = await assigned(url);
    const blank = await rawRequest(url, `/api/stays/${stayId}/depart`, {
      method: "POST",
      token,
      value: { keyTag: "" },
    });
    const rows = select(dbPath, "SELECT state FROM stays WHERE id=?", stayId);
    return outcome("keyTagRequired", blank.status === 422 && rows[0]?.state === "booked", {
      status: blank.status,
      persistedState: rows[0]?.state,
    });
  },
  async suiteRate({ url, dbPath }) {
    const token = await openDesk(url);
    const created = await reserve(url, token, { guest: "Oracle suite rate", tier: "suite" });
    const rows = select(dbPath, "SELECT nightly_cents FROM stays WHERE id=?", created.body.id);
    return outcome(
      "suiteRate",
      created.body.nightlyCents === 12500 && rows[0]?.nightly_cents === 12500,
      {
        expected: 12500,
        nightlyCents: created.body.nightlyCents,
        persistedCents: rows[0]?.nightly_cents,
      },
    );
  },
  async rosterAuthorization({ url, dbPath }) {
    const rows = select(dbPath, "SELECT id FROM stays ORDER BY seq LIMIT 1");
    if (!rows.length) throw new Error("Oracle setup seeded stay absent");
    const reply = await rawRequest(url, "/api/stays");
    return outcome("rosterAuthorization", reply.status === 401, {
      status: reply.status,
      leakedStay: reply.body.rows?.some((item) => item.id === rows[0].id) ?? false,
    });
  },
  async staySchema({ url, dbPath }) {
    const token = await openDesk(url);
    const reply = await rawRequest(url, "/api/stays?perPage=100", { token });
    const rows = select(dbPath, "SELECT id,tier FROM stays WHERE state<>'departed'");
    return outcome(
      "staySchema",
      reply.status === 200 &&
        rows.length === reply.body.rows.length &&
        rows.every((row) =>
          reply.body.rows.some((item) => item.id === row.id && item.tier === row.tier),
        ),
      reply.body,
    );
  },
  async pageContinuity({ url, dbPath }) {
    const token = await openDesk(url);
    const seen = [];
    for (let pageNo = 1; pageNo <= 3; pageNo += 1) {
      const reply = await rawRequest(url, `/api/stays?perPage=2&pageNo=${pageNo}`, { token });
      if (reply.status !== 200) throw new Error("Oracle paging setup failed");
      seen.push(...reply.body.rows.map((item) => item.id));
    }
    const expected = select(
      dbPath,
      "SELECT id FROM stays WHERE state<>'departed' ORDER BY seq",
    ).map((row) => row.id);
    return outcome("pageContinuity", JSON.stringify(seen) === JSON.stringify(expected), {
      expected,
      observed: seen,
    });
  },
  async requestTokenReplay({ url, dbPath }) {
    const token = await openDesk(url);
    const requestToken = `oracle-${randomUUID()}`;
    const first = await reserve(
      url,
      token,
      { guest: "Oracle once" },
      { "request-token": requestToken },
    );
    const second = await reserve(
      url,
      token,
      { guest: "Oracle once" },
      { "request-token": requestToken },
    );
    const rows = select(dbPath, "SELECT id FROM stays WHERE request_token=?", requestToken);
    return outcome(
      "requestTokenReplay",
      first.status === 201 &&
        second.status === 200 &&
        second.body.id === first.body.id &&
        rows.length === 1,
      { firstId: first.body.id, secondId: second.body.id, persistedRows: rows.length },
    );
  },
  async bumpPersistence({ url, dbPath }) {
    const { token, stayId } = await assigned(url);
    const moved = await rawRequest(url, `/api/stays/${stayId}/bump`, {
      method: "POST",
      token,
      value: {},
    });
    const rows = select(dbPath, "SELECT tier FROM stays WHERE id=?", stayId);
    const listed = await rawRequest(url, "/api/stays?holder=me", { token });
    return outcome(
      "bumpPersistence",
      moved.status === 200 &&
        rows[0]?.tier === "private" &&
        listed.body.rows[0]?.tier === "private",
      { responseTier: moved.body.tier, persistedTier: rows[0]?.tier },
    );
  },
  async departurePersistence({ url, dbPath }) {
    const { token, stayId } = await assigned(url);
    const left = await rawRequest(url, `/api/stays/${stayId}/depart`, {
      method: "POST",
      token,
      value: { keyTag: "KT-ORACLE" },
    });
    const rows = select(dbPath, "SELECT state FROM stays WHERE id=?", stayId);
    const listed = await rawRequest(url, "/api/stays?holder=me", { token });
    return outcome(
      "departurePersistence",
      left.status === 200 &&
        rows[0]?.state === "departed" &&
        listed.body.rows[0]?.state === "departed",
      { responseState: left.body.state, persistedState: rows[0]?.state },
    );
  },
  async serviceHealth({ url }) {
    const reply = await rawRequest(url, "/health");
    return outcome("serviceHealth", reply.status === 200 && reply.body.status === "ok", reply);
  },
};
