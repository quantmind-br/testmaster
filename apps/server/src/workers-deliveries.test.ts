import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { issueLocalToken, scaffoldPlan } from "@testmaster/application";
import {
  createNotificationHarness,
  type NotificationHarness,
} from "@testmaster/application/testing/notification-harness";
import { afterEach, expect, it } from "vitest";
import { createServer, type RateBudget } from "./server.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function fixture(rateLimits?: { actor?: RateBudget; tenant?: RateBudget }) {
  const h: NotificationHarness = await createNotificationHarness();
  const admin = await issueLocalToken(h.app);
  const reader = await issueLocalToken(h.app, {
    scopes: ["R"],
    tokenPath: join(h.app.config.home, "reader.token"),
  });
  const app = createServer({
    application: h.app,
    mcp: false,
    origins: ["http://127.0.0.1:7331"],
    ...(rateLimits ? { rateLimits } : {}),
  });
  cleanup.push(async () => {
    await app.close();
    await h.close();
  });
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const call = (
    method: "GET" | "POST",
    url: string,
    options: { token?: string; payload?: object; headers?: Record<string, string> } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...as(options.token ?? admin.token),
        ...(method === "POST" ? { "idempotency-key": randomUUID() } : {}),
        ...options.headers,
      },
      ...(options.payload ? { payload: options.payload } : {}),
    });
  return { h, app, admin, reader, as, call };
}

it("REQ-038 M4-08 the workers routes enroll with a one-time token, list without it, drain and revoke for administrators only", async () => {
  const f = await fixture();
  expect((await f.app.inject("/v1/workers")).statusCode).toBe(401);
  // Negative control: a read-only token sees nothing and creates nothing.
  expect((await f.call("GET", "/v1/workers", { token: f.reader.token })).statusCode).toBe(403);
  expect(
    (await f.call("POST", "/v1/workers", { token: f.reader.token, payload: { name: "no" } }))
      .statusCode,
  ).toBe(403);

  const created = await f.call("POST", "/v1/workers", { payload: { name: "pool-1" } });
  expect(created.statusCode).toBe(201);
  const { worker, enrollmentToken } = created.json().data;
  expect(enrollmentToken).toMatch(/^tm_wrk_/u);
  expect(worker.state).toBe("enrolling");

  // The token is shown once: neither the list nor the detail carries it.
  const listed = await f.call("GET", "/v1/workers");
  expect(listed.statusCode).toBe(200);
  expect(listed.body).not.toContain(enrollmentToken);
  const detail = await f.call("GET", `/v1/workers/${worker.id}`);
  expect(detail.body).not.toContain(enrollmentToken);

  // A worker credential is not a user token.
  expect((await f.call("GET", "/v1/workers", { token: enrollmentToken })).statusCode).toBe(401);

  const drained = await f.call("POST", `/v1/workers/${worker.id}/drain`);
  expect(drained.json().data.state).toBe("draining");
  const revoked = await f.call("POST", `/v1/workers/${worker.id}/revoke`);
  expect(revoked.json().data.state).toBe("revoked");
  // A revoked worker cannot be drained back into service.
  expect((await f.call("POST", `/v1/workers/${worker.id}/drain`)).statusCode).toBe(422);
  expect((await f.call("GET", `/v1/workers/wrk_${randomUUID()}`)).statusCode).toBe(404);
});

it("REQ-038 the heartbeat route renews a lease with the worker credential and refuses every other caller", async () => {
  const f = await fixture();
  f.h.queueRuns(1);
  const created = (await f.call("POST", "/v1/workers", { payload: { name: "beater" } })).json()
    .data;
  f.h.app.controllerScope().workerPool.enroll(created.enrollmentToken);
  f.h.app.database.run(
    "UPDATE workers SET state='ready' WHERE workspace_id=? AND id=?",
    f.h.workspaceId,
    created.worker.id,
  );
  const claim = f.h.claimAs(created.worker.id, "beater");
  if (!claim) throw new Error("Expected a claim");

  const url = `/v1/workers/${created.worker.id}/heartbeat`;
  const beat = (token: string, payload: object) =>
    f.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });
  const body = { leaseId: claim.jobId, state: "ready", version: created.worker.version };
  const worker = f.h.app.workerPool.get(created.worker.id);
  const accepted = await beat(created.enrollmentToken, { ...body, version: worker.version });
  expect(accepted.statusCode).toBe(200);
  expect(accepted.json().data).toMatchObject({ id: created.worker.id, state: "ready" });

  // Negative controls: no credential, a user token, a malformed body, a lost lease, a stale version.
  expect(
    (
      await f.app.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify(body),
      })
    ).statusCode,
  ).toBe(401);
  expect((await beat(f.admin.token, { ...body, version: worker.version })).statusCode).toBe(401);
  expect((await beat(created.enrollmentToken, { state: "ready" })).statusCode).toBe(400);
  const lost = await beat(created.enrollmentToken, {
    ...body,
    leaseId: `job_${randomUUID()}`,
    version: worker.version,
  });
  expect(lost.statusCode).toBe(422);
  expect(lost.json().error.details.reasonCode).toBe("lease_lost");
  const stale = await beat(created.enrollmentToken, { ...body, version: 99 });
  expect(stale.statusCode).toBe(412);
  expect(stale.json().error.code).toBe("REVISION_CONFLICT");
});

it("OPS-033 the HTTP admission receipt explains the wait and a full tenant queue answers 429 with Retry-After", async () => {
  const f = await fixture();
  f.h.app.preflight = async () => {};
  const test = f.h.app.tests.create({
    projectId: f.h.projectId,
    plan: scaffoldPlan("backend"),
  });
  const request = {
    testId: test.id,
    environmentId: f.h.environmentId,
    mode: "replay",
    healingPolicy: "off",
    origin: "api",
  };
  // Admission needs a live worker; this one only keeps the pool "ready" without claiming anything.
  const live = (await f.call("POST", "/v1/workers", { payload: { name: "live" } })).json().data;
  f.h.app.database.run(
    "UPDATE workers SET state='ready', last_heartbeat_at=? WHERE workspace_id=? AND id=?",
    new Date().toISOString(),
    f.h.workspaceId,
    live.worker.id,
  );
  const first = await f.call("POST", "/v1/runs", { payload: request });
  expect(first.statusCode).toBe(202);
  expect(first.json().data.queue).toMatchObject({ position: 1, queued: 1, limit: 1000 });

  // Fill the remaining capacity directly: 1000 queued jobs is the documented per-tenant limit.
  f.h.queueRuns(999);
  const full = await f.call("POST", "/v1/runs", { payload: request });
  expect(full.statusCode).toBe(429);
  expect(full.headers["retry-after"]).toBe("30");
  expect(full.json().error).toMatchObject({
    code: "RATE_LIMITED",
    details: { reason: "queue_overflow", limit: 1000, queued: 1000 },
  });
});

it("OPS-033 the per-actor and the per-tenant budgets refuse mutations with Retry-After while reads stay free", async () => {
  const actorLimited = await fixture({
    actor: { burst: 2, perSecond: 0.001 },
    tenant: { burst: 1000, perSecond: 1000 },
  });
  const statuses: number[] = [];
  for (let index = 0; index < 4; index++)
    statuses.push(
      (await actorLimited.call("POST", "/v1/workers", { payload: { name: `w${index}` } }))
        .statusCode,
    );
  expect(statuses).toEqual([201, 201, 429, 429]);
  const refused = await actorLimited.call("POST", "/v1/workers", { payload: { name: "late" } });
  expect(refused.json().error.details).toMatchObject({ scope: "actor" });
  expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  // Control: reads are not charged.
  expect((await actorLimited.call("GET", "/v1/workers")).statusCode).toBe(200);

  const tenantLimited = await fixture({
    actor: { burst: 1000, perSecond: 1000 },
    tenant: { burst: 1, perSecond: 0.001 },
  });
  expect(
    (await tenantLimited.call("POST", "/v1/workers", { payload: { name: "a" } })).statusCode,
  ).toBe(201);
  const tenantRefused = await tenantLimited.call("POST", "/v1/workers", { payload: { name: "b" } });
  expect(tenantRefused.statusCode).toBe(429);
  expect(tenantRefused.json().error.details).toMatchObject({ scope: "tenant" });
});

it("INT-026 OPS-011 the deliveries routes list check and notification deliveries together, filter them and requeue a dead letter", async () => {
  const f = await fixture();
  const receiver = await f.h.receiver();
  let failing = true;
  receiver.behave(() => ({ status: failing ? 503 : 200 }));
  const integration = await f.h.webhook(receiver);
  f.h.completedRun({ outcome: "failed" });
  await f.h.settle(60);

  const listed = await f.call("GET", "/v1/deliveries?state=dead_letter");
  expect(listed.statusCode).toBe(200);
  const [delivery] = listed.json().data.items;
  expect(delivery).toMatchObject({
    state: "dead_letter",
    attempts: 10,
    integrationId: integration.id,
  });
  expect(delivery.id).toMatch(/^ntd_/u);
  expect(
    (await f.call("GET", `/v1/deliveries?type=run.failed&integrationId=${integration.id}`)).json()
      .data.items,
  ).toHaveLength(1);
  // Negative controls: a type that never occurred and an unknown state.
  expect((await f.call("GET", "/v1/deliveries?type=batch.completed")).json().data.items).toEqual(
    [],
  );
  expect((await f.call("GET", "/v1/deliveries?state=bogus")).statusCode).toBe(400);

  const detail = await f.call("GET", `/v1/deliveries/${delivery.id}`);
  expect(detail.json().data.attemptLog).toHaveLength(10);
  expect(detail.json().data.attemptLog.at(-1)).toMatchObject({ outcome: "failed" });

  // Requeue needs administrator scope; the destination recovers and the same delivery id lands once.
  expect(
    (await f.call("POST", `/v1/deliveries/${delivery.id}/retry`, { token: f.reader.token }))
      .statusCode,
  ).toBe(403);
  failing = false;
  const retried = await f.call("POST", `/v1/deliveries/${delivery.id}/retry`);
  expect(retried.statusCode).toBe(200);
  expect(retried.json().data.state).toBe("pending");
  await f.h.settle(5);
  const after = await f.call("GET", `/v1/deliveries/${delivery.id}`);
  expect(after.json().data.state).toBe("delivered");
  expect(receiver.requests.at(-1)?.headers["testmaster-delivery-id"]).toBe(delivery.id);
});
