import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Application,
  issueLocalToken,
  revokeLocalToken,
  scaffoldPlan,
} from "@testmaster/application";
import { sha256 } from "@testmaster/domain";
import { afterEach, expect, it } from "vitest";
import { createServer, registerMcpHttp } from "./server.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(options: { cursorTtlMs?: number; now?: () => number } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "tm-server-"));
  const home = join(cwd, "home");
  await mkdir(home);
  await mkdir(join(home, ".config", "testmaster"), { recursive: true });
  await writeFile(
    join(home, ".config", "testmaster", "policy.json"),
    JSON.stringify({ allowUpload: true }),
  );
  const application = await Application.open({ cwd, home, env: {} });
  const init = await application.init();
  const issued = await issueLocalToken(application);
  const app = createServer({
    application,
    mcp: false,
    ...options,
    origins: ["http://127.0.0.1:7331"],
  });
  cleanup.push(async () => {
    await app.close();
    application.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const headers = { authorization: `Bearer ${issued.token}` };
  const mutate = (
    method: "POST" | "PATCH" | "DELETE",
    url: string,
    payload: unknown = {},
    extra: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      headers: { ...headers, "idempotency-key": randomUUID(), ...extra },
      payload,
    });
  return { app, application, init, issued, headers, mutate };
}
it("requires private hashed expiring tokens, scope and exact Origin and honors revocation", async () => {
  const f = await fixture();
  expect((await f.app.inject("/v1/projects")).statusCode).toBe(401);
  expect(
    (await f.app.inject({ url: "/v1/projects", headers: { authorization: "Bearer invalid" } }))
      .statusCode,
  ).toBe(401);
  expect(
    (
      await f.app.inject({
        url: "/v1/projects",
        headers: { ...f.headers, origin: "http://127.0.0.1:7331.evil" },
      })
    ).statusCode,
  ).toBe(403);
  const reader = await issueLocalToken(f.application, {
    scopes: ["R"],
    tokenPath: join(f.application.config.home, "reader.token"),
  });
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { authorization: `Bearer ${reader.token}`, "idempotency-key": randomUUID() },
        payload: { name: "No write" },
      })
    ).statusCode,
  ).toBe(403);
  expect((await stat(f.issued.tokenPath)).mode & 0o777).toBe(0o600);
  expect(
    JSON.stringify(
      f.application.database.all(
        "SELECT value FROM operational_state WHERE key LIKE 'local-token:%'",
      ),
    ),
  ).not.toContain(f.issued.token);
  revokeLocalToken(f.application, f.issued.token);
  expect((await f.app.inject({ url: "/v1/projects", headers: f.headers })).statusCode).toBe(401);
});
it("atomically replays mutations, rejects mismatched bodies and enforces If-Match", async () => {
  const f = await fixture();
  const key = randomUUID();
  const one = await f.mutate(
    "POST",
    "/v1/projects",
    { name: "New project" },
    { "idempotency-key": key },
  );
  expect(one.statusCode).toBe(201);
  const two = await f.mutate(
    "POST",
    "/v1/projects",
    { name: "New project" },
    { "idempotency-key": key },
  );
  expect(two.json().data.id).toBe(one.json().data.id);
  expect(
    (await f.mutate("POST", "/v1/projects", { name: "Other" }, { "idempotency-key": key }))
      .statusCode,
  ).toBe(409);
  const url = `/v1/projects/${one.json().data.id}`;
  expect((await f.mutate("PATCH", url, { name: "Renamed" })).statusCode).toBe(428);
  expect(
    (await f.mutate("PATCH", url, { name: "Renamed" }, { "if-match": '"9"' })).statusCode,
  ).toBe(412);
  expect(
    (await f.mutate("PATCH", url, { name: "Renamed" }, { "if-match": '"1"' })).statusCode,
  ).toBe(200);
  expect(f.application.projects.get(one.json().data.id).name).toBe("Renamed");
  expect(
    (await f.mutate("POST", "/v1/projects", { name: "Unknown", surprise: true })).statusCode,
  ).toBe(400);
});
it("binds signed keyset cursors to collection and filters with expiry and tamper denial", async () => {
  let now = Date.now();
  const f = await fixture({ cursorTtlMs: 10, now: () => now });
  f.application.projects.create({ name: "Second" });
  f.application.projects.create({ name: "Third" });
  const first = await f.app.inject({ url: "/v1/projects?limit=1", headers: f.headers });
  const cursor = first.json().data.nextCursor;
  expect(typeof cursor).toBe("string");
  const next = await f.app.inject({
    url: `/v1/projects?limit=1&cursor=${encodeURIComponent(cursor)}`,
    headers: f.headers,
  });
  expect(next.json().data.items[0].id).not.toBe(first.json().data.items[0].id);
  expect(
    (
      await f.app.inject({
        url: `/v1/projects?cursor=${encodeURIComponent(`${cursor}x`)}`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(400);
  now += 11;
  expect(
    (
      await f.app.inject({
        url: `/v1/projects?cursor=${encodeURIComponent(cursor)}`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(410);
});
it("never marks truncated or hash-mismatched uploads complete or ready", async () => {
  const f = await fixture();
  const bytes = Buffer.from("Some requirement");
  for (const content of [bytes.subarray(0, 4), Buffer.from("X".repeat(bytes.length))]) {
    const create = await f.mutate("POST", "/v1/uploads", {
      mediaType: "text/plain",
      sizeBytes: bytes.length,
      contentHash: sha256(bytes),
    });
    expect(create.statusCode).toBe(201);
    const upload = create.json().data;
    const put = await f.app.inject({
      method: "PUT",
      url: `/v1/uploads/${upload.uploadId}/bytes`,
      headers: {
        ...f.headers,
        "content-type": "application/octet-stream",
        "x-upload-token": upload.token,
      },
      payload: content,
    });
    expect(put.statusCode).toBe(200);
    expect((await f.mutate("POST", `/v1/uploads/${upload.uploadId}/complete`)).statusCode).toBe(
      422,
    );
    const source = await f.mutate("POST", `/v1/projects/${f.init.projectId}/sources`, {
      role: "prd",
      name: "requirement.txt",
      uploadId: upload.uploadId,
    });
    expect(source.statusCode).toBe(422);
    expect(f.application.sources.list(f.init.projectId)).toHaveLength(0);
  }
});
it("guards MCP with the same token and Origin and registers disabled milestones", async () => {
  const f = await fixture();
  registerMcpHttp(f.app, async ({ application, reply }) => {
    application.context.authorize("R");
    reply.send({ ok: true });
  });
  expect((await f.app.inject({ method: "POST", url: "/mcp", payload: {} })).statusCode).toBe(401);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: "/mcp",
        headers: { ...f.headers, origin: "https://evil.test" },
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await f.app.inject({ method: "POST", url: "/mcp", headers: f.headers, payload: {} }))
      .statusCode,
  ).toBe(200);
  const disabled = await f.mutate("POST", "/v1/workspaces", {});
  expect(disabled.statusCode).toBe(422);
  expect(disabled.json().error.details.milestone).toBe("M4");
  expect(() => createServer({ application: f.application, host: "0.0.0.0" })).toThrowError(
    "127.0.0.1",
  );
  expect(() => f.app.listen({ host: "0.0.0.0", port: 0 })).toThrowError("127.0.0.1");
  expect(() => createServer({ application: f.application, mode: "server" })).toThrowError("M4");
});
it("serves a real loopback socket with no unauthenticated data", async () => {
  const f = await fixture();
  const address = await f.app.listen({ port: 0 });
  const response = await fetch(`${address}/v1/projects`);
  expect(response.status).toBe(401);
  const allowed = await fetch(`${address}/v1/projects`, { headers: f.headers });
  expect(allowed.status).toBe(200);
  expect((await allowed.json()).data.items[0].id).toBe(f.init.projectId);
});
it("resumes durable SSE events without gaps or duplicate terminal events", async () => {
  const f = await fixture();
  const test = f.application.tests.create({
    projectId: f.init.projectId,
    plan: scaffoldPlan("backend"),
  });
  f.application.preflight = async () => {};
  const run = f.application.runs.prepare({ testId: test.id, environmentId: f.init.environmentId });
  const receipt = f.application.database.withTx(() => f.application.runs.insert(run, randomUUID()));
  f.application.runs.cancel(receipt.runId);
  const workspace = f.application.context.workspaceId;
  // A terminal resource with a durable outbox allows finite SSE reconnect assertions without a fake runner verdict.
  f.application.database.run(
    "UPDATE runs SET phase='completed',outcome='cancelled',status='cancelled',gate='failed' WHERE workspace_id=? AND id=?",
    workspace,
    receipt.runId,
  );
  const event = f.application.runs.events(receipt.runId)[0];
  expect(event).toBeDefined();
  const address = await f.app.listen({ port: 0 });
  const first = await fetch(`${address}/v1/runs/${receipt.runId}/events`, { headers: f.headers });
  const text = await first.text();
  const cursor = /^id: (.+)$/m.exec(text)?.[1];
  expect(cursor).toBeDefined();
  const reconnect = await fetch(`${address}/v1/runs/${receipt.runId}/events`, {
    headers: { ...f.headers, "last-event-id": cursor as string },
  });
  const resumed = await reconnect.text();
  const originalEvents = [...text.matchAll(/^data: (.+)$/gm)].map((match) =>
    JSON.parse(match[1] as string),
  );
  const resumedEvents = [...resumed.matchAll(/^data: (.+)$/gm)].map((match) =>
    JSON.parse(match[1] as string),
  );
  const durable = f.application.runs.events(receipt.runId);
  expect(originalEvents.map((event) => event.seq)).toEqual(durable.map((event) => event.seq));
  expect(originalEvents.filter((event) => event.type === "run.completed")).toHaveLength(1);
  expect(resumedEvents.map((event) => event.seq)).toEqual(
    durable.slice(1).map((event) => event.seq),
  );
  expect(resumedEvents.map((event) => event.eventId)).toEqual(
    originalEvents.slice(1).map((event) => event.eventId),
  );
  const lastCursor = [...text.matchAll(/^id: (.+)$/gm)].at(-1)?.[1] as string;
  const exhausted = await fetch(`${address}/v1/runs/${receipt.runId}/events`, {
    headers: { ...f.headers, "last-event-id": lastCursor },
  });
  expect(await exhausted.text()).not.toContain("data:");
});

it("validates and returns correlation IDs while readiness follows durable admission state", async () => {
  const f = await fixture();
  const result = await f.app.inject({
    url: "/v1/projects",
    headers: { ...f.headers, "x-correlation-id": "incident-http-123" },
  });
  expect(result.headers["x-correlation-id"]).toBe("incident-http-123");
  expect(result.json().requestId).toBe("incident-http-123");
  const generated = await f.app.inject({ url: "/v1/projects", headers: f.headers });
  expect(generated.headers["x-correlation-id"]).toMatch(/^[a-f0-9-]{36}$/);
  const invalid = await f.app.inject({
    url: "/v1/projects",
    headers: { ...f.headers, "x-correlation-id": "a".repeat(129) },
  });
  expect(invalid.statusCode).toBe(400);
  f.application.database.run(
    "UPDATE operational_state SET value='suspended_manual' WHERE key='admission'",
  );
  const readiness = await f.app.inject({ url: "/v1/health/ready", headers: f.headers });
  expect(readiness.statusCode).toBe(503);
  expect(readiness.json().data.components.admission).toBe("unavailable");
  expect(JSON.stringify(readiness.json())).not.toContain(f.application.config.dataDir);
});

it("admits runs with raw capture when authenticated with authorized local capability token and rejects ungranted tokens", async () => {
  const f = await fixture();
  f.application.context.entities.insert("Worker", {
    id: "wrk_00000000-0000-4000-8000-000000000001",
    workspaceId: f.init.workspaceId,
    createdAt: new Date().toISOString(),
    version: 1,
    identityRef: "local-tabletop",
    capabilities: ["http"],
    imageDigests: [],
    labels: {},
    state: "ready",
    lastHeartbeatAt: new Date().toISOString(),
  });
  f.application.preflight = async () => {};
  const test = f.application.tests.create({
    projectId: f.init.projectId,
    plan: scaffoldPlan("backend"),
  });
  f.application.config.effectiveConfig.config.artifacts = {
    trace: "on",
    video: "off",
    httpBodies: "off",
  };
  const body = {
    testId: test.id,
    environmentId: f.init.environmentId,
    mode: "replay",
    healingPolicy: "off",
    origin: "api",
  };
  const authorized = await f.mutate("POST", "/v1/runs", body);
  expect(authorized.statusCode).toBe(202);
  expect(authorized.json().data.runId).toBeDefined();

  const restricted = await issueLocalToken(f.application, {
    scopes: ["R", "X"],
    tokenPath: join(f.application.config.home, "restricted.token"),
  });
  const denied = await f.app.inject({
    method: "POST",
    url: "/v1/runs",
    headers: {
      authorization: `Bearer ${restricted.token}`,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    payload: body,
  });
  expect(denied.statusCode).toBe(403);
  expect(denied.json().error.code).toBe("FORBIDDEN");
  expect(denied.json().error.message).toContain("artifacts:raw");
});

it("never widens an existing token's raw grant during reuse", async () => {
  const f = await fixture();
  const tokenPath = join(f.application.config.home, "narrow-admin.token");
  const issued = await issueLocalToken(f.application, { tokenPath, grants: [] });
  await expect(issueLocalToken(f.application, { tokenPath })).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
  const reused = await issueLocalToken(f.application, { tokenPath, grants: [] });
  expect(reused.token).toBe(issued.token);
  expect(() =>
    f.application
      .withIdentity(reused.identity)
      .context.authorizeRaw?.(f.init.projectId, f.init.environmentId),
  ).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
});
