import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, issueLocalToken, scaffoldPlan } from "@testmaster/application";
import { uuidV7IdGenerator } from "@testmaster/domain";
import type { FastifyInstance } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "./server.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function fixture(configure?: (server: FastifyInstance) => void) {
  const cwd = await mkdtemp(join(tmpdir(), "tm-http-runtime-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const application = await Application.open({ cwd, home, env: {} });
  const init = await application.init();
  const token = await issueLocalToken(application);
  const server = createServer({ application, mcp: false });
  configure?.(server);
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  cleanup.push(async () => {
    await server.close();
    application.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const headers = { authorization: `Bearer ${token.token}`, "content-type": "application/json" };
  const test = application.tests.create({
    projectId: init.projectId,
    plan: scaffoldPlan("backend"),
  });
  vi.spyOn(Application.prototype, "preflight").mockResolvedValue();
  application.context.entities.insert("Worker", {
    id: uuidV7IdGenerator.next("wrk"),
    workspaceId: init.workspaceId,
    identityRef: "http-test",
    capabilities: ["http"],
    imageDigests: [],
    labels: {},
    state: "ready",
    lastHeartbeatAt: new Date().toISOString(),
  });
  return { application, server, init, test, headers, url: `http://127.0.0.1:${address.port}` };
}
it("OPS-013 authenticated API repeated cancellation has one event and terminal no-op retains outcome", async () => {
  const f = await fixture();
  const receipt = await f.application.runs.admit({
    testId: f.test.id,
    environmentId: f.init.environmentId,
  });
  const cancel = () =>
    fetch(`${f.url}/v1/runs/${receipt.runId}/cancel`, {
      method: "POST",
      headers: { ...f.headers, "idempotency-key": randomUUID() },
      body: "{}",
    });
  const first = await cancel();
  expect(first.status).toBe(200);
  const before = f.application.runs.get(receipt.runId);
  const repeated = await cancel();
  expect(repeated.status).toBe(200);
  expect((await repeated.json()).data).toMatchObject({
    result: "already_terminal",
    status: "cancelled",
  });
  expect(f.application.runs.get(receipt.runId)).toEqual(before);
  expect(
    f.application.runs
      .events(receipt.runId)
      .filter((event) => event.type === "run.cancel_requested"),
  ).toHaveLength(1);
  expect(
    f.application.runs.events(receipt.runId).filter((event) => event.type === "run.completed"),
  ).toHaveLength(1);
  expect(f.application.database.all("SELECT * FROM attempts")).toHaveLength(0);
});
it("OPS-010 client timeout after durable commit before receipt retries to one Run and historical receipt survives dedup expiry", async () => {
  const committed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let intercepted = false;
  const f = await fixture((server) =>
    server.addHook("onSend", async (request, _reply, payload) => {
      if (request.url === "/v1/runs" && !intercepted) {
        intercepted = true;
        committed.resolve();
        await release.promise;
      }
      return payload;
    }),
  );
  cleanup.push(async () => release.resolve());
  const key = randomUUID();
  const body = JSON.stringify({ testId: f.test.id, environmentId: f.init.environmentId });
  const controller = new AbortController();
  const lost = fetch(`${f.url}/v1/runs`, {
    method: "POST",
    headers: { ...f.headers, "idempotency-key": key },
    body,
    signal: controller.signal,
  });
  await committed.promise;
  expect(f.application.runs.list()).toHaveLength(1);
  controller.abort(new Error("client_receipt_timeout"));
  await expect(lost).rejects.toThrow("client_receipt_timeout");
  release.resolve();
  const response = await fetch(`${f.url}/v1/runs`, {
    method: "POST",
    headers: { ...f.headers, "idempotency-key": key },
    body,
  });
  expect(response.status).toBe(202);
  const receipt = (await response.json()).data;
  expect(f.application.runs.list()).toHaveLength(1);
  expect(receipt.runId).toBe(f.application.runs.list()[0]?.id);
  f.application.database.run(
    "UPDATE idempotency_receipts SET expires_at='2000-01-01T00:00:00.000Z'",
  );
  const next = await fetch(`${f.url}/v1/runs`, {
    method: "POST",
    headers: { ...f.headers, "idempotency-key": key },
    body,
  });
  expect((await next.json()).data.runId).not.toBe(receipt.runId);
  expect(
    f.application.runs.events(receipt.runId).find((event) => event.type === "run.receipt")?.payload,
  ).toMatchObject({ runId: receipt.runId, idempotencyKey: key });
});
