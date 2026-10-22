import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Application,
  type PermissionGrant,
  type ServerConfig,
  scaffoldPlan,
} from "@testmaster/application";
import { type Role, routeCatalog } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { afterEach, expect, it } from "vitest";
import { testProvider } from "../../../packages/model-gateway/src/test-support.js";
import { buildRouteTable } from "./routes/index.js";
import { createServer } from "./server.js";

const origin = "https://tm.example";
const password = "correct horse battery staple";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function fixture(options: { providers?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "tm-settings-http-"));
  const home = join(cwd, "home");
  await mkdir(join(home, ".config/testmaster"), { recursive: true });
  if (options.providers) {
    await writeFile(
      join(home, ".config/testmaster/profiles.json"),
      JSON.stringify({
        defaultProfile: "test",
        profiles: {
          test: {
            modelProviders: [
              {
                ...testProvider,
                baseUrl: "http://127.0.0.1:4010/v1/private-path",
                apiKeyEnv: "SETTINGS_FAKE_KEY",
              },
              {
                ...testProvider,
                id: "remote",
                baseUrl: "https://models.example.com/v1",
                apiKeyEnv: "SETTINGS_REMOTE_KEY",
              },
            ],
          },
        },
      }),
    );
    await writeFile(
      join(home, ".config/testmaster/policy.json"),
      JSON.stringify({ allowedModelProviders: ["fake"] }),
    );
  }
  const application = await Application.open({
    cwd,
    home,
    env: {
      HOME: home,
      SETTINGS_FAKE_KEY: "HTTP-API-KEY-CANARY-fake",
      SETTINGS_REMOTE_KEY: "HTTP-API-KEY-CANARY-remote",
    },
  });
  const init = await application.init();
  const config: ServerConfig = {
    mode: "server",
    database: { engine: "postgres", url: "postgres://testmaster@127.0.0.1:5432/testmaster" },
    storage: { kind: "filesystem", root: join(cwd, "evidence") },
    server: {
      listen: { host: "127.0.0.1", port: 0 },
      publicOrigin: origin,
      trustedProxies: ["127.0.0.1"],
      origins: [origin],
    },
    security: {
      masterKeyFile: join(cwd, "master.key"),
      backupKeyFile: join(cwd, "backup.key"),
      atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
    },
  };
  const app = createServer({ application, mode: "server", server: config, mcp: false });
  cleanup.push(async () => {
    await app.close();
    application.close();
    await rm(cwd, { recursive: true, force: true });
  });
  let counter = 0;
  /** A member of the role plus a bearer token carrying the given scopes. */
  const actor = async (
    role: Role,
    scopes: ("R" | "W" | "X" | "A")[],
    restrictions: string[] = [],
    grants: PermissionGrant[] = [],
  ) => {
    const login = `${role.replace("_", "-")}-${++counter}`;
    const added = application.members.add(init.workspaceId, {
      login,
      displayName: login,
      role,
      projectRestrictions: restrictions,
    });
    if (added.recovery)
      await application.identityService.recover({
        principal: login,
        recoveryToken: added.recovery.recoveryToken,
        newPassword: password,
      });
    const issued = application.tokens.create({
      name: `t-${++counter}`,
      scopes,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      principalId: added.member.principalId,
      ...(grants.length ? { grants } : {}),
    });
    return { token: issued.token, principalId: added.member.principalId };
  };
  const call = (
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    url: string,
    token: string,
    options: { payload?: unknown; key?: string; ifMatch?: number } = {},
  ) =>
    app.inject({
      method,
      url: `/v1${url}`,
      remoteAddress: "127.0.0.1",
      headers: {
        authorization: `Bearer ${token}`,
        "x-forwarded-proto": "https",
        ...(method === "GET" ? {} : { "idempotency-key": options.key ?? randomUUID() }),
        ...(options.ifMatch ? { "if-match": `"${options.ifMatch}"` } : {}),
      },
      ...(method === "GET" || method === "DELETE" ? {} : { payload: options.payload ?? {} }),
    });
  return { app, application, init, actor, call };
}

it("UX-046 rotates a secret over HTTP, replays an idempotent request once, lists its history and never returns a value", async () => {
  const f = await fixture();
  const created = await f.application.secrets.set("http-secret", "HTTP-CANARY-one-0001", {
    ephemeral: true,
  });
  const maintainer = await f.actor("maintainer", ["R", "W"]);
  const key = randomUUID();
  const first = await f.call("POST", `/secrets/${created.id}/rotate`, maintainer.token, {
    payload: { value: "HTTP-CANARY-two-0002" },
    key,
  });
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json().data).toMatchObject({ id: created.id, secretVersion: 2 });
  const replay = await f.call("POST", `/secrets/${created.id}/rotate`, maintainer.token, {
    payload: { value: "HTTP-CANARY-two-0002" },
    key,
  });
  expect(replay.statusCode).toBe(200);
  expect(replay.json().data).toEqual(first.json().data);
  // The replay did not rotate: still version 2, one rotated event.
  const history = await f.call("GET", `/secrets/${created.id}/history`, maintainer.token);
  expect(history.statusCode, history.body).toBe(200);
  expect(
    history
      .json()
      .data.items.map((item: { event: string; version: number }) => [item.event, item.version]),
  ).toEqual([
    ["rotated", 2],
    ["created", 1],
  ]);
  expect(history.json().data.items[0]).toMatchObject({ actor: maintainer.principalId });
  // The same key for another value is a conflict, never a second rotation.
  const conflict = await f.call("POST", `/secrets/${created.id}/rotate`, maintainer.token, {
    payload: { value: "HTTP-CANARY-three-0003" },
    key,
  });
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
  // Positive control: a fresh key rotates again.
  const next = await f.call("POST", `/secrets/${created.id}/rotate`, maintainer.token, {
    payload: { value: "HTTP-CANARY-three-0003" },
  });
  expect(next.json().data.secretVersion).toBe(3);
  const list = await f.call("GET", "/secrets", maintainer.token);
  const everything = JSON.stringify([
    first.body,
    replay.body,
    history.body,
    conflict.body,
    next.body,
    list.body,
    f.application.database.all("SELECT * FROM audit_events"),
  ]);
  for (const canary of ["HTTP-CANARY-one", "HTTP-CANARY-two", "HTTP-CANARY-three"])
    expect(everything).not.toContain(canary);
  // Wrong shapes never reach the service.
  const missing = await f.call("POST", `/secrets/${created.id}/rotate`, maintainer.token, {
    payload: { name: "x" },
  });
  expect(missing.statusCode).toBe(400);
});

it("UX-046 refuses HTTP rotation to viewers and runners even with a write scope and answers other ids with not found", async () => {
  const f = await fixture();
  const created = await f.application.secrets.set("guarded", "HTTP-CANARY-guard-01", {
    ephemeral: true,
  });
  for (const role of ["viewer", "runner"] as const) {
    const user = await f.actor(role, ["R", "W", "X"]);
    const denied = await f.call("POST", `/secrets/${created.id}/rotate`, user.token, {
      payload: { value: "HTTP-CANARY-guard-02" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("FORBIDDEN");
    // Reading the history needs only the read column.
    expect((await f.call("GET", `/secrets/${created.id}/history`, user.token)).statusCode).toBe(
      200,
    );
  }
  expect(f.application.secrets.get(created.id).secretVersion).toBe(1);
  const maintainer = await f.actor("maintainer", ["R", "W"]);
  const unknown = `sec_${randomUUID()}`;
  const missing = await f.call("GET", `/secrets/${unknown}/history`, maintainer.token);
  expect(missing.statusCode).toBe(404);
  expect(missing.json().error.code).toBe("NOT_FOUND");
});

it("UX-048 purges an archived project over HTTP with the slug, replays it and lists the operation by project", async () => {
  const f = await fixture();
  const project = f.application.projects.get(f.init.projectId);
  await f.application.artifacts.importFixtureInput({
    projectId: project.id,
    name: "fixture.csv",
    bytes: new TextEncoder().encode("a,b\n"),
    mimeType: "text/csv",
  });
  const owner = await f.actor("org_owner", ["R", "W", "A"]);
  const purge = (token: string, confirmationToken: string, key?: string) =>
    f.call("POST", `/projects/${project.id}/purge`, token, {
      payload: { confirmationToken },
      ...(key ? { key } : {}),
    });
  // Wrong token and live project are precondition failures with a reason.
  const wrong = await purge(owner.token, "wrong-slug");
  expect(wrong.statusCode).toBe(422);
  expect(wrong.json().error).toMatchObject({
    code: "PRECONDITION_FAILED",
    details: { reason: "confirmation_mismatch" },
  });
  const live = await purge(owner.token, String(project.slug));
  expect(live.json().error.details).toEqual({ reason: "project_not_archived" });
  const archived = await f.call("POST", `/projects/${project.id}/archive`, owner.token, {
    ifMatch: Number(project.version),
  });
  expect(archived.statusCode, archived.body).toBe(200);
  // Roles without the admin column are refused even with an admin scope.
  for (const role of ["viewer", "runner", "reviewer", "maintainer"] as const) {
    const user = await f.actor(role, ["R", "W", "X", "A"]);
    expect((await purge(user.token, String(project.slug))).statusCode).toBe(403);
  }
  expect(f.application.retention.listDeletionOperations()).toEqual([]);
  const key = randomUUID();
  const done = await purge(owner.token, String(project.slug), key);
  expect(done.statusCode, done.body).toBe(200);
  const operation = done.json().data;
  expect(operation).toMatchObject({ requestedBy: owner.principalId, physicalState: "pending" });
  expect(operation.resourceRefs).toHaveLength(1);
  // A replay with the same key and a repeat with a new key both name the same operation.
  expect((await purge(owner.token, String(project.slug), key)).json().data.id).toBe(operation.id);
  expect((await purge(owner.token, String(project.slug))).json().data.id).toBe(operation.id);
  const viewer = await f.actor("viewer", ["R"]);
  const listed = await f.call("GET", "/deletion-operations", viewer.token);
  expect(listed.statusCode).toBe(200);
  expect(listed.json().data.items.map((item: { id: string }) => item.id)).toEqual([operation.id]);
  const filtered = await f.call(
    "GET",
    `/deletion-operations?projectId=${project.id}`,
    viewer.token,
  );
  expect(filtered.json().data.items).toHaveLength(1);
  const other = f.application.projects.create({ name: "Another" });
  const none = await f.call("GET", `/deletion-operations?projectId=${other.id}`, viewer.token);
  expect(none.json().data.items).toEqual([]);
  const single = await f.call("GET", `/deletion-operations/${operation.id}`, viewer.token);
  expect(single.json().data.id).toBe(operation.id);
});

it("UX-047 lists the model providers over HTTP without exposing credentials or any consent state", async () => {
  const f = await fixture({ providers: true });
  const projectId = f.init.projectId;
  const viewer = await f.actor("viewer", ["R"]);
  const read = await f.call("GET", `/projects/${projectId}/model-providers`, viewer.token);
  expect(read.statusCode, read.body).toBe(200);
  expect(read.json().data).toEqual({
    projectId,
    providers: [
      {
        id: "fake",
        baseUrl: "http://127.0.0.1:4010",
        remote: false,
        models: ["model"],
        allowedByProfile: true,
      },
      {
        id: "remote",
        baseUrl: "https://models.example.com",
        remote: true,
        models: ["model"],
        allowedByProfile: false,
      },
    ],
  });
  for (const secret of ["HTTP-API-KEY-CANARY", "SETTINGS_FAKE_KEY", "apiKey", "private-path"])
    expect(read.body).not.toContain(secret);
  // The removed consent routes no longer exist, whatever the caller's role.
  const owner = await f.actor("org_owner", ["R", "W", "A"]);
  for (const method of ["GET", "PUT", "DELETE"]) {
    const gone = await f.call(method, `/projects/${projectId}/model-consents/fake`, owner.token, {
      payload: { dataClasses: ["documents"] },
    });
    expect(gone.statusCode, `${method} ${gone.body}`).toBe(404);
    expect(gone.json().error.code).toBe("NOT_FOUND");
  }
  // A project the workspace does not own is not found.
  const unknown = await f.call("GET", `/projects/prj_${randomUUID()}/model-providers`, owner.token);
  expect(unknown.statusCode).toBe(404);
});

it("UX-047 exposes measured usage and storage bytes and has no budget route", async () => {
  const f = await fixture();
  const projectId = f.init.projectId;
  const owner = await f.actor("org_owner", ["R", "W", "A"]);
  const viewer = await f.actor("viewer", ["R", "A"]);
  const usage = await f.call("GET", `/usage?projectId=${projectId}`, viewer.token);
  expect(usage.statusCode, usage.body).toBe(200);
  expect(usage.json().data).toMatchObject({
    storageBytes: expect.any(Number),
    reservations: { reserved: 0, settled: 0, released: 0 },
  });
  expect(usage.json().data).not.toHaveProperty("lifetimeBudget");
  const gone = await f.call("POST", `/projects/${projectId}/budget`, owner.token, {
    payload: { tokens: 777 },
  });
  expect(gone.statusCode).toBe(404);
});

it("M4-05 lists environment revisions over HTTP newest first and answers every portal settings route", async () => {
  const f = await fixture();
  const owner = await f.actor("org_owner", ["R", "W"]);
  const environment = f.application.environments.get(f.init.environmentId);
  const patch = (version: number, payload: unknown) =>
    f.call("PATCH", `/environments/${environment.id}`, owner.token, { payload, ifMatch: version });
  const one = await patch(Number(environment.version), { baseUrl: "https://staging.example.com" });
  expect(one.statusCode, one.body).toBe(200);
  const two = await patch(Number(one.json().data.version), { production: true });
  expect(two.statusCode, two.body).toBe(200);
  const listed = await f.call("GET", `/environments/${environment.id}/revisions`, owner.token);
  expect(listed.statusCode, listed.body).toBe(200);
  const items = listed.json().data.items as {
    id: string;
    targetOrigins: string[];
    production: boolean;
  }[];
  expect(items).toHaveLength(3);
  expect(items[0]?.id).toBe(two.json().data.activeRevisionId);
  expect(items.map((item) => [item.targetOrigins[0], item.production])).toEqual([
    ["https://staging.example.com", true],
    ["https://staging.example.com", false],
    [expect.any(String), false],
  ]);
  expect(listed.body).not.toContain("variables");
  const first = await f.call(
    "GET",
    `/environments/${environment.id}/revisions?limit=1`,
    owner.token,
  );
  expect(first.json().data).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });
  const missing = await f.call("GET", `/environments/env_${randomUUID()}/revisions`, owner.token);
  expect(missing.statusCode).toBe(404);
  const table = buildRouteTable();
  const keys = [
    "POST /secrets/{id}/rotate",
    "GET /secrets/{id}/history",
    "POST /projects/{id}/purge",
    "GET /deletion-operations",
    "GET /projects/{id}/model-providers",
    "GET /environments/{id}/revisions",
  ];
  const catalog = new Set(routeCatalog.map((route) => `${route.method} ${route.path}`));
  for (const key of keys) {
    expect(catalog.has(key)).toBe(true);
    expect(table.has(key)).toBe(true);
  }
  // The removed model-consent surface is neither catalogued nor implemented.
  for (const key of [
    "GET /projects/{id}/model-consents",
    "PUT /projects/{id}/model-consents/{provider}",
    "DELETE /projects/{id}/model-consents/{provider}",
  ]) {
    expect(catalog.has(key)).toBe(false);
    expect(table.has(key)).toBe(false);
  }
  // Negative control: a catalog row no module implements still answers CAPABILITY_UNAVAILABLE.
  expect(table.has("GET /projects/{id}/memory")).toBe(false);
  const memory = await f.call("GET", `/projects/${f.init.projectId}/memory`, owner.token);
  expect(memory.json().error.code).toBe("CAPABILITY_UNAVAILABLE");
});

/** One completed Run of a fresh Test with a live artifact row and file, written without a worker. */
async function seedArtifact(f: Awaited<ReturnType<typeof fixture>>) {
  const { application } = f;
  const ctx = application.context;
  const at = "2020-01-01T00:00:00.000Z";
  const test = application.tests.create({
    projectId: f.init.projectId,
    plan: scaffoldPlan("backend"),
  });
  const revisionId = String(test.activeRevisionId);
  const runId = uuidV7IdGenerator.next("run");
  const attemptId = uuidV7IdGenerator.next("att");
  const snapshotId = uuidV7IdGenerator.next("snp");
  const jobId = uuidV7IdGenerator.next("job");
  const artifactId = uuidV7IdGenerator.next("art");
  ctx.entities.insert("Run", {
    id: runId,
    workspaceId: ctx.workspaceId,
    createdAt: at,
    testId: test.id,
    revisionId,
    environmentRevisionId: application.environments.get(f.init.environmentId).activeRevisionId,
    batchId: null,
    matrixCell: { environmentName: "local" },
    mode: "replay",
    phase: "completed",
    status: "passed",
    outcome: "passed",
    origin: "settings-http-test",
    gatePolicy: {},
    gate: "passed",
    cleanupOutcome: "not_required",
    analysisStatus: "not_requested",
  });
  ctx.database.run(
    "INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,state,available_at,fence) VALUES(?,?,?,?,?,?,?,1)",
    ctx.workspaceId,
    jobId,
    at,
    "execution",
    runId,
    "completed",
    at,
  );
  ctx.entities.insert(
    "Attempt",
    {
      id: attemptId,
      workspaceId: ctx.workspaceId,
      createdAt: at,
      runId,
      number: 1,
      workerId: null,
      seed: 0,
      phase: "completed",
      startedAt: at,
      endedAt: at,
      outcome: "passed",
    },
    { jobId, fence: 1, leaseOwner: "settings-http-test" },
  );
  ctx.entities.insert("Snapshot", {
    id: snapshotId,
    workspaceId: ctx.workspaceId,
    createdAt: at,
    runId,
    attemptId,
    revisionId,
    manifestHash: "0".repeat(64),
    committedAt: at,
    redactionPolicyHash: "0".repeat(64),
  });
  const storageKey = `runs/${ctx.workspaceId}/${runId}/${attemptId}/evidence/result.txt`;
  const file = join(application.config.dataDir, storageKey);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, "evidence");
  ctx.entities.insert("Artifact", {
    id: artifactId,
    workspaceId: ctx.workspaceId,
    createdAt: at,
    runId,
    attemptId,
    revisionId,
    snapshotId,
    kind: "dom",
    hash: "1".repeat(64),
    bytes: 8,
    mime: "text/plain",
    storageKey,
    state: "available",
    redactionStatus: "not_applicable",
  });
  return artifactId;
}

it("UX-048 revokes an artifact over HTTP through the idempotency wrapper and replays the same operation", async () => {
  const f = await fixture();
  const artifactId = await seedArtifact(f);
  const deleteGrant: PermissionGrant = {
    resourceType: "Artifact",
    actions: ["delete"],
    projectIds: [f.init.projectId],
    environmentIds: [],
    expiresAt: null,
    grantedBy: f.init.principalId,
  };
  const owner = await f.actor("org_owner", ["R", "W", "A"], [], [deleteGrant]);
  const viewer = await f.actor("viewer", ["R", "W", "A"], [], [deleteGrant]);
  // Negative control: a role without the delete authority is refused and nothing is tombstoned.
  const refused = await f.call("DELETE", `/artifacts/${artifactId}`, viewer.token);
  expect(refused.statusCode).toBe(403);
  expect(f.application.retention.listDeletionOperations()).toEqual([]);
  const key = randomUUID();
  const first = await f.call("DELETE", `/artifacts/${artifactId}`, owner.token, { key });
  expect(first.statusCode, first.body).toBe(200);
  const operation = first.json().data;
  expect(operation).toMatchObject({ resourceRefs: [artifactId], requestedBy: owner.principalId });
  const replay = await f.call("DELETE", `/artifacts/${artifactId}`, owner.token, { key });
  expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.json().data.id).toBe(operation.id);
  const repeat = await f.call("DELETE", `/artifacts/${artifactId}`, owner.token);
  expect(repeat.json().data.id).toBe(operation.id);
  expect(f.application.retention.listDeletionOperations()).toHaveLength(1);
  expect(
    f.application.database.get("SELECT state FROM artifacts WHERE id=?", artifactId)?.state,
  ).toBe("expired");
});
