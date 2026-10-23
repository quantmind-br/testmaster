import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { issueLocalToken } from "@testmaster/application";
import { createNotificationHarness } from "@testmaster/application/testing/notification-harness";
import { afterEach, expect, it } from "vitest";
import { createServer } from "./server.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function fixture() {
  const h = await createNotificationHarness();
  const admin = await issueLocalToken(h.app);
  const reader = await issueLocalToken(h.app, {
    scopes: ["R"],
    tokenPath: join(h.app.config.home, "reader.token"),
  });
  const app = createServer({ application: h.app, mcp: false, origins: ["http://127.0.0.1:7331"] });
  cleanup.push(async () => {
    await app.close();
    await h.close();
  });
  const call = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    options: { token?: string; payload?: object } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${options.token ?? admin.token}`,
        ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }),
      },
      ...(options.payload ? { payload: options.payload } : {}),
    });
  return { h, reader, call, runId: h.completedRun().runId };
}

it("REQ-044 the memory routes create, review, edit and forget an entry, and refuse a reader and a mixed patch", async () => {
  const f = await fixture();
  const collection = `/v1/projects/${f.h.projectId}/memory`;
  const created = await f.call("POST", collection, {
    payload: { text: "Totals include VAT", sourceRefs: [{ runId: f.runId }] },
  });
  expect(created.statusCode).toBe(201);
  const entry = created.json().data;
  expect(entry).toMatchObject({ state: "pending", approval: null, version: 1 });

  // Negative controls: a reader reads but writes nothing, and a ref outside the project resolves to nothing.
  expect((await f.call("GET", collection, { token: f.reader.token })).statusCode).toBe(200);
  expect(
    (
      await f.call("POST", collection, {
        token: f.reader.token,
        payload: { text: "Nope", sourceRefs: [{ runId: f.runId }] },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await f.call("POST", collection, {
        payload: { text: "Nope", sourceRefs: [{ runId: `run_${randomUUID()}` }] },
      })
    ).statusCode,
  ).toBe(400);

  const item = `/v1/memory/${entry.id}`;
  // An approval stands alone: it takes no edit, and a reason belongs to an approval.
  expect(
    (await f.call("PATCH", item, { payload: { expectedVersion: 1, approve: true, text: "Other" } }))
      .statusCode,
  ).toBe(400);
  expect(
    (
      await f.call("PATCH", item, {
        payload: { expectedVersion: 1, text: "Edited", reason: "no approval" },
      })
    ).statusCode,
  ).toBe(400);
  const approved = await f.call("PATCH", item, {
    payload: { expectedVersion: 1, approve: true, reason: "Confirmed" },
  });
  expect(approved.statusCode).toBe(200);
  expect(approved.json().data).toMatchObject({ state: "active", version: 2 });

  const edited = await f.call("PATCH", item, {
    payload: { expectedVersion: 2, text: "Totals include VAT at 21%" },
  });
  expect(edited.json().data).toMatchObject({ state: "pending", approval: null, version: 3 });
  const stale = await f.call("PATCH", item, { payload: { expectedVersion: 2, approve: true } });
  expect(stale.statusCode).toBe(412);

  const forgotten = await f.call("DELETE", item);
  expect(forgotten.statusCode).toBe(200);
  expect(forgotten.json().data).toMatchObject({ state: "forgotten", text: "", sourceRefs: [] });
  const listed = (await f.call("GET", collection)).json().data.items;
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ id: entry.id, state: "forgotten" });
});
