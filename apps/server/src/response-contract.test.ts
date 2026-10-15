import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, issueLocalToken, scaffoldPlan } from "@testmaster/application";
import { routeCatalog } from "@testmaster/contracts";
import { sha256 } from "@testmaster/domain";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, expect, it } from "vitest";
import { seedRun } from "../../../packages/application/src/run-seed.testing.js";
import { responseIssues } from "../../../packages/contracts/src/response-validation.testing.js";
import { createServer } from "./server.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-response-contract-"));
  const home = join(cwd, "home");
  await mkdir(join(home, ".config", "testmaster"), { recursive: true });
  await writeFile(
    join(home, ".config", "testmaster", "policy.json"),
    JSON.stringify({ allowUpload: true }),
  );
  const application = await Application.open({ cwd, home, env: {} });
  const init = await application.init();
  const issued = await issueLocalToken(application);
  const app = createServer({ application, mcp: false, origins: ["http://127.0.0.1:7331"] });
  cleanup.push(async () => {
    await app.close();
    application.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const headers = { authorization: `Bearer ${issued.token}` };
  const send = (
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: object,
    extra: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      headers: { ...headers, "idempotency-key": randomUUID(), ...extra },
      ...(payload ? { payload } : {}),
    });
  /** Reads every `data:` JSON of a finished event stream over a real loopback socket. */
  const events = async (url: string): Promise<unknown[]> => {
    const address = await app.listen({ port: 0 });
    const response = await fetch(`${address}${url}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    return (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as unknown);
  };
  return {
    app,
    application,
    init,
    cwd,
    headers,
    send,
    events,
    get: (url: string) => app.inject({ url, headers }),
    post: (url: string, payload: object) => send("POST", url, payload),
  };
}
interface Envelope {
  data: Record<string, unknown> & { items?: unknown[] };
}
/** Validates the real response of `method path` and returns its parsed envelope. */
function conforms(method: string, path: string, response: LightMyRequestResponse): Envelope {
  const body = response.json();
  expect(response.statusCode, `${method} ${path}: ${response.body}`).toBeLessThan(300);
  expect(responseIssues(method, path, response.statusCode, body), `${method} ${path}`).toEqual([]);
  return body as Envelope;
}
const violations = (method: string, path: string, status: number, body: unknown) =>
  responseIssues(method, path, status, body).length;

it("C4 real list, entity, report and receipt responses match the schemas the generated OpenAPI advertises", async () => {
  const f = await fixture();
  await f.application.secrets.set("contract-secret", "CONTRACT-CANARY-0001", { ephemeral: true });
  const projectId = f.init.projectId;
  const created = await f.post("/v1/projects", { name: "Contract project" });
  expect(created.statusCode).toBe(201);
  conforms("POST", "/projects", created);
  const environment = await f.post(`/v1/projects/${projectId}/environments`, {
    name: "loopback",
    baseUrl: "http://127.0.0.1:3000",
    networkProfile: "local-loopback",
  });
  expect(environment.statusCode).toBe(201);
  conforms("POST", "/projects/{id}/environments", environment);

  const lists: [string, string][] = [
    ["/projects", "/v1/projects"],
    ["/projects/{id}/environments", `/v1/projects/${projectId}/environments`],
    ["/secrets", "/v1/secrets"],
    ["/tokens", "/v1/tokens"],
    ["/runs", "/v1/runs"],
    ["/approvals", "/v1/approvals"],
    ["/suites", "/v1/suites"],
    ["/schedules", "/v1/schedules"],
    ["/resources", "/v1/resources"],
    ["/auth-profiles", "/v1/auth-profiles"],
    ["/audit-events", "/v1/audit-events"],
    ["/deletion-operations", "/v1/deletion-operations"],
  ];
  for (const [path, url] of lists) {
    const body = conforms("GET", path, await f.get(url));
    expect(Array.isArray(body.data.items), `${path} items`).toBe(true);
    expect(body.data, `${path} cursor`).toHaveProperty("hasMore");
  }
  const singles: [string, string][] = [
    ["/health/live", "/v1/health/live"],
    ["/health/ready", "/v1/health/ready"],
    ["/capabilities", "/v1/capabilities"],
    ["/projects/{id}", `/v1/projects/${projectId}`],
    ["/me", "/v1/me"],
    ["/rbac/matrix", "/v1/rbac/matrix"],
    ["/usage", "/v1/usage"],
    ["/operations/status", "/v1/operations/status"],
  ];
  for (const [path, url] of singles) conforms("GET", path, await f.get(url));
  // `/workspaces` is bounded by the service and answers `{items}` without a cursor.
  const workspaces = conforms("GET", "/workspaces", await f.get("/v1/workspaces"));
  expect(workspaces.data).not.toHaveProperty("hasMore");
  expect((await f.get("/v1/secrets")).json().data.items).toHaveLength(1);
});
it("C4 rejects an advertised-shape violation on the same real responses", async () => {
  const f = await fixture();
  await f.application.secrets.set("contract-secret", "CONTRACT-CANARY-0001", { ephemeral: true });
  const projects = (await f.get("/v1/projects")).json();
  const project = (await f.get(`/v1/projects/${f.init.projectId}`)).json();
  const [first] = projects.data.items;
  expect(project.data.id).toBe(first.id);
  // The cited defect: a list answered as one bare entity.
  expect(violations("GET", "/projects", 200, { ...projects, data: first })).toBeGreaterThan(0);
  const { hasMore: _hasMore, ...unpaged } = projects.data;
  expect(violations("GET", "/projects", 200, { ...projects, data: unpaged })).toBeGreaterThan(0);
  expect(
    violations("GET", "/projects", 200, { ...projects, data: { ...projects.data, extra: 1 } }),
  ).toBeGreaterThan(0);
  // The opposite: an entity route answered as a page.
  expect(
    violations("GET", "/projects/{id}", 200, { ...project, data: { ...projects.data } }),
  ).toBeGreaterThan(0);
  // `{items}` routes are strict: a page is not what they send.
  const workspaces = (await f.get("/v1/workspaces")).json();
  expect(
    violations("GET", "/workspaces", 200, {
      ...workspaces,
      data: { ...workspaces.data, hasMore: false, nextCursor: null },
    }),
  ).toBeGreaterThan(0);
  expect(
    violations("GET", "/workspaces", 200, { ...workspaces, data: workspaces.data.items[0] }),
  ).toBeGreaterThan(0);
  // `/capabilities` is the application report, not the MCP CapabilityManifest.
  const capabilities = (await f.get("/v1/capabilities")).json();
  const { features: _features, ...incomplete } = capabilities.data;
  expect(
    violations("GET", "/capabilities", 200, { ...capabilities, data: incomplete }),
  ).toBeGreaterThan(0);
  expect(
    violations("GET", "/capabilities", 200, {
      ...capabilities,
      data: { apiVersion: "v1", capabilities: [] },
    }),
  ).toBeGreaterThan(0);
  // Readiness answers `200` and `503` with one body; no other status is advertised.
  const ready = await f.get("/v1/health/ready");
  expect([200, 503]).toContain(ready.statusCode);
  expect(() => responseIssues("GET", "/health/ready", 500, ready.json())).toThrow(/status 500/);
  expect(
    violations("GET", "/health/ready", ready.statusCode, {
      ...ready.json(),
      data: { status: "ready" },
    }),
  ).toBeGreaterThan(0);
  // A wrapper-less body is not an envelope.
  expect(violations("GET", "/projects", 200, projects.data)).toBeGreaterThan(0);
});
it("C4 advertises the status the server answers and marks the unimplemented routes unavailable", async () => {
  const f = await fixture();
  const created = await f.post("/v1/projects", { name: "Status project" });
  const route = routeCatalog.find((item) => item.method === "POST" && item.path === "/projects");
  expect([route?.response.status, ...(route?.response.alsoStatus ?? [])]).toContain(
    created.statusCode,
  );
  // Reserved routes have no handler: every call is refused, and the catalog says so.
  const reserved = routeCatalog.filter((item) => item.response.kind === "unavailable");
  expect(reserved.map((item) => `${item.method} ${item.path}`).sort()).toEqual(
    [
      "DELETE /memory/{id}",
      "DELETE /tunnels/{id}",
      "GET /projects/{id}/memory",
      "GET /tunnels",
      "GET /visual-baselines",
      "PATCH /memory/{id}",
      "POST /exports",
      "POST /identity/break-glass",
      "POST /imports",
      "POST /projects/{id}/memory",
      "POST /tunnels",
      "POST /visual-baselines",
      "POST /visual-baselines/{id}/approve",
    ].sort(),
  );
  const refused = await f.post("/v1/tunnels", {});
  expect(refused.statusCode).toBe(422);
  expect(refused.json().error.code).toBe("CAPABILITY_UNAVAILABLE");
});
const missingRun = "run_00000000000000000000000000";

it("C4 populated run, step, attempt, bundle, batch and event responses match the advertised schemas", async () => {
  const f = await fixture();
  // A live worker owns the Run, so admission needs no local sandbox (the identity-scoped service
  // the server builds per request does not see an override set on the base application).
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
  const test = f.application.tests.create({
    projectId: f.init.projectId,
    plan: scaffoldPlan("backend"),
  });
  const request = {
    testId: test.id,
    environmentId: f.init.environmentId,
    mode: "replay",
    healingPolicy: "off",
    origin: "api",
  };
  const admitted = await f.send("POST", "/v1/runs", request);
  expect(admitted.statusCode, admitted.body).toBe(202);
  expect(conforms("POST", "/runs", admitted).data).toMatchObject({ ownership: expect.any(String) });
  const batch = await f.send("POST", "/v1/batches", { selection: [request] });
  expect(batch.statusCode, batch.body).toBe(202);
  const batchId = String(conforms("POST", "/batches", batch).data.batchId);
  const view = conforms("GET", "/batches/{id}", await f.get(`/v1/batches/${batchId}`));
  expect(view.data.aggregate).toHaveProperty("allMembers");

  const seeded = await seedRun(f.application, {
    testId: test.id,
    environmentId: f.init.environmentId,
    attempts: [
      {
        outcome: "failed",
        steps: [{ stepId: "s1", status: "failed", reasonCode: "assertion_mismatch" }],
      },
      {
        outcome: "passed",
        steps: [
          { stepId: "s1", status: "passed", evidence: ["dom/page.html"] },
          { stepId: "s2", status: "passed" },
        ],
        artifacts: [
          { relativePath: "dom/page.html", kind: "dom", mimeType: "text/html", body: "<p>x</p>" },
          { relativePath: "out.txt", kind: "console", mimeType: "text/plain", body: "log" },
        ],
      },
    ],
  });
  const runs = conforms("GET", "/runs", await f.get("/v1/runs"));
  expect(runs.data.items?.length).toBeGreaterThanOrEqual(3);
  const run = conforms("GET", "/runs/{id}", await f.get(`/v1/runs/${seeded.runId}`));
  expect(run.data).toMatchObject({ phase: "completed", outcome: "passed" });
  const steps = conforms("GET", "/runs/{id}/steps", await f.get(`/v1/runs/${seeded.runId}/steps`));
  expect(steps.data.items).toHaveLength(3);
  const attempts = conforms(
    "GET",
    "/runs/{id}/attempts",
    await f.get(`/v1/runs/${seeded.runId}/attempts`),
  );
  expect(attempts.data.items).toHaveLength(2);
  const bundle = conforms(
    "GET",
    "/runs/{id}/bundle",
    await f.get(`/v1/runs/${seeded.runId}/bundle`),
  );
  expect(bundle.data).toHaveProperty("manifest");
  conforms(
    "GET",
    "/runs/{id}/healing-proposals",
    await f.get(`/v1/runs/${seeded.runId}/healing-proposals`),
  );
  const link = await f.send("POST", `/v1/artifacts/${seeded.artifacts[0]?.id}/links`, {});
  expect(link.statusCode, link.body).toBe(200);
  conforms("POST", "/artifacts/{id}/links", link);

  const events = await f.events(`/v1/runs/${seeded.runId}/events`);
  expect(events.length).toBeGreaterThan(3);
  for (const event of events)
    expect(responseIssues("GET", "/runs/{id}/events", 200, event), JSON.stringify(event)).toEqual(
      [],
    );
  // Negative controls on the same populated data: a bare Run is not a page, an Attempt row is not a Run.
  expect(violations("GET", "/runs", 200, { ...runs, data: run.data })).toBeGreaterThan(0);
  expect(violations("GET", "/runs/{id}", 200, { ...run, data: runs.data })).toBeGreaterThan(0);
  expect(
    violations("GET", "/runs/{id}/attempts", 200, {
      ...attempts,
      data: { ...attempts.data, items: steps.data.items },
    }),
  ).toBeGreaterThan(0);
  const [event] = events as Record<string, unknown>[];
  expect(
    violations("GET", "/runs/{id}/events", 200, { ...event, unexpected: true }),
  ).toBeGreaterThan(0);
  expect((await f.get(`/v1/runs/${missingRun}/steps`)).statusCode).toBe(404);
}, 90_000);

it("C4 populated source, upload and discovery responses match the advertised schemas", async () => {
  const f = await fixture();
  const projectId = f.init.projectId;
  const ok = { get: { responses: { "200": { description: "ok" } } } };
  await writeFile(
    join(f.cwd, "openapi.json"),
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Shop", version: "1" },
      paths: { "/a": ok },
    }),
  );
  await mkdir(join(f.cwd, "app"));
  await writeFile(
    join(f.cwd, "app", "server.ts"),
    "import express from 'express'; const app = express(); app.get('/health', (req,res) => res.json({ok:true}));",
  );
  const spec = await f.application.sources.add({
    projectId,
    role: "api-spec",
    path: "openapi.json",
  });

  // Upload through the HTTP surface, then register it as a second source.
  const bytes = Buffer.from("# Checkout\n\nThe cart total MUST include tax.\n");
  const upload = await f.send("POST", "/v1/uploads", {
    mediaType: "text/markdown",
    sizeBytes: bytes.length,
    contentHash: sha256(bytes),
  });
  expect(upload.statusCode, upload.body).toBe(201);
  const receipt = conforms("POST", "/uploads", upload).data as { uploadId: string; token: string };
  const put = await f.app.inject({
    method: "PUT",
    url: `/v1/uploads/${receipt.uploadId}/bytes`,
    headers: {
      ...f.headers,
      "content-type": "application/octet-stream",
      "x-upload-token": receipt.token,
    },
    payload: bytes,
  });
  conforms("PUT", "/uploads/{id}/bytes", put);
  conforms(
    "POST",
    "/uploads/{id}/complete",
    await f.send("POST", `/v1/uploads/${receipt.uploadId}/complete`),
  );
  const added = await f.send("POST", `/v1/projects/${projectId}/sources`, {
    role: "prd",
    name: "prd.md",
    uploadId: receipt.uploadId,
    format: "markdown",
  });
  expect(added.statusCode, added.body).toBe(200);
  const prd = conforms("POST", "/projects/{id}/sources", added).data as {
    source: { id: string; version: number };
    chunks: unknown[];
  };
  expect(prd.chunks.length).toBeGreaterThan(0);

  const listed = conforms(
    "GET",
    "/projects/{id}/sources",
    await f.get(`/v1/projects/${projectId}/sources`),
  );
  expect(listed.data.items).toHaveLength(2);
  const detail = conforms("GET", "/sources/{id}", await f.get(`/v1/sources/${spec.source.id}`));
  expect(detail.data.inventory).toHaveProperty("operations");
  const specRevision = (detail.data.revision as { id: string }).id;

  const started = await f.send("POST", `/v1/projects/${projectId}/discovery`, {
    projectId,
    sourceRevisionIds: [specRevision],
    scope: ["codebase"],
    budget: { root: "app" },
  });
  expect(started.statusCode, started.body).toBe(202);
  const job = conforms("POST", "/projects/{id}/discovery", started).data as {
    job: { id: string };
    featureMap: { features: unknown[] };
  };
  expect(job.featureMap.features.length).toBeGreaterThan(0);
  conforms("GET", "/discovery/{id}", await f.get(`/v1/discovery/${job.job.id}`));
  const history = conforms(
    "GET",
    "/projects/{id}/discovery",
    await f.get(`/v1/projects/${projectId}/discovery`),
  );
  expect(history.data.items).toHaveLength(1);
  const events = await f.events(`/v1/discovery/${job.job.id}/events`);
  expect(events.length).toBeGreaterThan(0);
  for (const event of events)
    expect(
      responseIssues("GET", "/discovery/{id}/events", 200, event),
      JSON.stringify(event),
    ).toEqual([]);
  conforms(
    "GET",
    "/projects/{id}/requirements",
    await f.get(`/v1/projects/${projectId}/requirements`),
  );

  // Archiving answers the stored Source, not the SourceDetail the other routes serve.
  const archived = await f.send("DELETE", `/v1/sources/${prd.source.id}`, undefined, {
    "if-match": `"${prd.source.version}"`,
  });
  expect(archived.statusCode, archived.body).toBe(200);
  const archivedBody = conforms("DELETE", "/sources/{id}", archived);
  // Negative controls: the schemas differ, so swapping them must fail.
  expect(
    violations("GET", "/sources/{id}", 200, { ...detail, data: archivedBody.data }),
  ).toBeGreaterThan(0);
  expect(
    violations("DELETE", "/sources/{id}", 200, { ...archivedBody, data: detail.data }),
  ).toBeGreaterThan(0);
  expect(
    violations("GET", "/projects/{id}/sources", 200, { ...listed, data: listed.data.items?.[0] }),
  ).toBeGreaterThan(0);
  expect(
    violations("POST", "/projects/{id}/discovery", 202, { ...detail, data: detail.data }),
  ).toBeGreaterThan(0);
}, 90_000);
