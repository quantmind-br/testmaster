import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Application,
  type PermissionGrant,
  type ServerConfig,
  scaffoldPlan,
} from "@testmaster/application";
import { type Role, rbacMatrix, routeCatalog } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "./server.js";

const origin = "https://tm.example";

const canary = "CANARY-team-secret-7f3a91";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-team-http-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const application = await Application.open({ cwd, home, env: {} });
  const init = await application.init();
  vi.spyOn(Application.prototype, "preflight").mockResolvedValue();
  application.context.entities.insert("Worker", {
    id: uuidV7IdGenerator.next("wrk"),
    workspaceId: init.workspaceId,
    identityRef: "team-test",
    capabilities: ["http"],
    imageDigests: [],
    labels: {},
    state: "ready",
    lastHeartbeatAt: new Date().toISOString(),
  });
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
  const member = (role: Role, projectRestrictions: string[] = []) => {
    const login = `${role.replace("_", "-")}-${++counter}`;
    return application.members.add(init.workspaceId, {
      login,
      displayName: login,
      role,
      projectRestrictions,
    }).member;
  };
  const token = (principalId: string, grants?: PermissionGrant[]) =>
    application.tokens.create({
      name: `t-${++counter}`,
      scopes: ["R", "W", "X", "A"],
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      principalId,
      ...(grants ? { grants } : {}),
    }).token;
  const call = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    bearer: string,
    options: { payload?: unknown; headers?: Record<string, string> } = {},
  ) =>
    app.inject({
      method,
      url,
      remoteAddress: "127.0.0.1",
      headers: {
        "x-forwarded-proto": "https",
        authorization: `Bearer ${bearer}`,
        ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }),
        ...options.headers,
      },
      ...(method === "GET" || method === "DELETE" ? {} : { payload: options.payload ?? {} }),
    });
  const owner = application.members.list(init.workspaceId).find((m) => m.role === "org_owner");
  const ownerToken = token(String(owner?.principalId));
  const grant = (action: PermissionGrant["actions"][number]): PermissionGrant => ({
    resourceType: "*",
    actions: [action],
    projectIds: [],
    environmentIds: [],
    expiresAt: null,
    grantedBy: init.principalId,
  });
  return { app, application, init, member, token, call, ownerToken, grant };
}

describe("team permissions over HTTP", () => {
  it("SEC-027 UX-005 each role gets the matrix answer on a read, write, execute, secret and admin route", async () => {
    const f = await fixture();
    const test = f.application.tests.create({
      projectId: f.init.projectId,
      plan: scaffoldPlan("backend"),
    });
    const probes: Record<string, (bearer: string) => Promise<LightMyRequestResponse>> = {
      read: (bearer) => f.call("GET", "/v1/projects", bearer),
      write: (bearer) =>
        f.call("POST", "/v1/projects", bearer, {
          payload: { name: `Probe ${randomUUID().slice(0, 8)}` },
        }),
      execute: (bearer) =>
        f.call("POST", "/v1/batches", bearer, {
          payload: {
            selection: [{ testId: test.id, environmentId: f.init.environmentId }],
          },
        }),
      secret: (bearer) =>
        f.call("POST", "/v1/secrets", bearer, {
          payload: {
            name: `probe-${randomUUID().slice(0, 8)}`,
            value: canary,
            allowedOrigins: ["https://example.com"],
          },
        }),
      admin: (bearer) => f.call("GET", "/v1/audit-events", bearer),
    };
    const outcomes: Record<string, Record<string, number>> = {};
    for (const role of Object.keys(rbacMatrix) as Role[]) {
      const member = f.member(role);
      const bearer = f.token(member.principalId);
      outcomes[role] = {};
      for (const [column, probe] of Object.entries(probes)) {
        const response = await probe(bearer);
        outcomes[role][column] = response.statusCode;
        const value = rbacMatrix[role][column as keyof (typeof rbacMatrix)[Role]];
        if (value === "allow")
          expect(
            [200, 201, 202].includes(response.statusCode),
            `${role}/${column} -> ${response.statusCode} ${response.body}`,
          ).toBe(true);
        else {
          expect(response.statusCode, `${role}/${column}`).toBe(403);
          expect(response.json().error.code).toBe("FORBIDDEN");
        }
      }
    }
    // A grant-only service account is denied everywhere until a matching grant exists.
    const service = f.member("service_account");
    const granted = f.token(service.principalId, [f.grant("read"), f.grant("write")]);
    expect((await probes.read?.(granted))?.statusCode).toBe(200);
    expect((await probes.write?.(granted))?.statusCode).toBe(201);
    expect((await probes.execute?.(granted))?.statusCode).toBe(403);
    expect(outcomes.viewer).toMatchObject({ read: 200, write: 403, execute: 403, admin: 403 });
  });

  it("SEC-027 a request body naming another organization or workspace is refused and creates nothing", async () => {
    const f = await fixture();
    const before = f.application.projects.list().length;
    const expected = {
      workspaceId: { status: 403, code: "FORBIDDEN" },
      organizationId: { status: 400, code: "INVALID_ARGUMENT" },
    };
    for (const [field, answer] of Object.entries(expected)) {
      const refused = await f.call("POST", "/v1/projects", f.ownerToken, {
        payload: { name: "Smuggled", [field]: "ws_01900000-0000-7000-8000-00000000dead" },
      });
      expect(refused.statusCode, field).toBe(answer.status);
      expect(refused.json().error.code, field).toBe(answer.code);
    }
    expect(f.application.projects.list()).toHaveLength(before);
    // The cross-tenant attempt leaves exactly one alertable audit row; the schema rejection leaves none.
    const violations = f.application.audit.list({ operation: "tenant.violation" }).items;
    expect(violations.map((entry) => [entry.operation, entry.outcome])).toEqual([
      ["tenant.violation", "denied"],
    ]);
    // Positive control: the same body without the foreign field creates the project in this workspace.
    const created = await f.call("POST", "/v1/projects", f.ownerToken, {
      payload: { name: "Honest" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.workspaceId).toBe(f.init.workspaceId);
  });

  it("SEC-027 list filters and batch operations stay inside the member's project restrictions", async () => {
    const f = await fixture();
    const other = f.application.projects.create({ name: "Restricted" });
    const environment = f.application.environments.create({
      projectId: other.id,
      name: "staging",
      baseUrl: "https://example.org",
    });
    const hidden = f.application.tests.create({
      projectId: other.id,
      plan: scaffoldPlan("backend"),
    });
    const visible = f.application.tests.create({
      projectId: f.init.projectId,
      plan: scaffoldPlan("backend"),
    });
    const hiddenRun = f.application.runs.prepare({
      testId: hidden.id,
      environmentId: environment.id,
    });
    f.application.database.withTx(() => f.application.runs.insert(hiddenRun, randomUUID()));
    const restricted = f.token(f.member("maintainer", [f.init.projectId]).principalId);
    const names = (await f.call("GET", "/v1/projects", restricted))
      .json()
      .data.items.map((project: { id: string }) => project.id);
    expect(names).toEqual([f.init.projectId]);
    expect((await f.call("GET", `/v1/projects/${other.id}/tests`, restricted)).statusCode).toBe(
      403,
    );
    expect((await f.call("GET", `/v1/tests/${hidden.id}`, restricted)).statusCode).toBe(403);
    const own = await f.call("GET", `/v1/projects/${f.init.projectId}/tests`, restricted);
    expect(own.json().data.items.map((item: { id: string }) => item.id)).toEqual([visible.id]);
    expect((await f.call("GET", "/v1/runs", restricted)).json().data.items).toEqual([]);
    const batches = () =>
      f.application.database.get("SELECT COUNT(*) AS n FROM batches").n as number;
    const before = batches();
    const refused = await f.call("POST", "/v1/batches", restricted, {
      payload: {
        selection: [
          { testId: visible.id, environmentId: f.init.environmentId },
          { testId: hidden.id, environmentId: environment.id },
        ],
      },
    });
    expect(refused.statusCode).toBe(403);
    expect(batches()).toBe(before);
    const accepted = await f.call("POST", "/v1/batches", restricted, {
      payload: { selection: [{ testId: visible.id, environmentId: f.init.environmentId }] },
    });
    expect([200, 201, 202]).toContain(accepted.statusCode);
    expect(batches()).toBe(before + 1);
    // The unrestricted owner sees both projects through the same filters.
    const all = (await f.call("GET", "/v1/projects", f.ownerToken)).json().data.items;
    expect(all).toHaveLength(2);
  });
});

describe("audit trail over HTTP", () => {
  it("UX-050 filters by actor kind, operation, outcome and correlation ID without exposing secret values", async () => {
    const f = await fixture();
    const viewer = f.token(f.member("viewer").principalId);
    const agent = f.token(f.member("service_account").principalId, [
      f.grant("read"),
      f.grant("write"),
    ]);
    const correlation = `corr-${randomUUID()}`;
    const denied = await f.call("POST", "/v1/projects", viewer, {
      payload: { name: "Nope" },
      headers: { "x-correlation-id": correlation },
    });
    expect(denied.statusCode).toBe(403);
    await f.call("POST", "/v1/projects", agent, { payload: { name: "Agent project" } });
    await f.call("POST", "/v1/secrets", f.ownerToken, {
      payload: { name: "shown-never", value: canary, allowedOrigins: ["https://example.com"] },
    });
    const list = async (query: string) => {
      const response = await f.call("GET", `/v1/audit-events?${query}`, f.ownerToken);
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json().data as {
        items: unknown[];
        hasMore: boolean;
        nextCursor: string | null;
      };
      return { data: body.items, page: body } as {
        data: Array<{
          actor: { id: string; kind: string; displayName: string | null };
          operation: string;
          outcome: string;
          correlationId: string;
          scope: { resourceType: string; resourceId: string };
        }>;
        page: { hasMore: boolean; nextCursor: string | null };
      };
    };
    const byCorrelation = await list(`correlationId=${correlation}`);
    expect(byCorrelation.data.length).toBeGreaterThan(0);
    expect(byCorrelation.data.every((entry) => entry.correlationId === correlation)).toBe(true);
    expect(byCorrelation.data.some((entry) => entry.outcome === "denied")).toBe(true);
    const agents = await list("actorKind=agent");
    expect(agents.data.length).toBeGreaterThan(0);
    expect(agents.data.every((entry) => entry.actor.kind === "agent")).toBe(true);
    const humans = await list("actorKind=human");
    expect(humans.data.length).toBeGreaterThan(0);
    expect(humans.data.every((entry) => entry.actor.kind === "human")).toBe(true);
    expect(humans.data.map((entry) => entry.actor.id)).not.toContain(agents.data[0]?.actor.id);
    const denials = await list("outcome=denied");
    expect(denials.data.length).toBeGreaterThan(0);
    expect(denials.data.every((entry) => entry.outcome === "denied")).toBe(true);
    const secrets = await list("operation=secret");
    expect(secrets.data.length).toBeGreaterThan(0);
    expect(secrets.data.every((entry) => entry.operation.startsWith("secret"))).toBe(true);
    const everything = await f.call("GET", "/v1/audit-events?limit=100", f.ownerToken);
    expect(everything.body).not.toContain(canary);
    expect(everything.json().data.items[0].scope.resourceType).toEqual(expect.any(String));
  });

  it("UX-050 pages with a signed cursor bound to the filters and refuses a viewer", async () => {
    const f = await fixture();
    const viewer = f.token(f.member("viewer").principalId);
    for (let index = 0; index < 6; index++)
      await f.call("POST", "/v1/projects", viewer, { payload: { name: `Denied ${index}` } });
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = `outcome=denied&limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await f.call("GET", `/v1/audit-events?${query}`, f.ownerToken);
      expect(response.statusCode, response.body).toBe(200);
      const page = response.json().data;
      expect(page.items.length).toBeLessThanOrEqual(4);
      for (const entry of page.items) {
        expect(seen.has(entry.id)).toBe(false);
        seen.add(entry.id);
      }
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    expect(pages).toBeGreaterThan(1);
    expect(seen.size).toBeGreaterThanOrEqual(6);
    // A cursor minted for one filter cannot be replayed with another, or by another caller.
    const first = (
      await f.call("GET", "/v1/audit-events?outcome=denied&limit=2", f.ownerToken)
    ).json();
    const cursorValue = encodeURIComponent(first.data.nextCursor);
    const replay = await f.call(
      "GET",
      `/v1/audit-events?outcome=allowed&limit=2&cursor=${cursorValue}`,
      f.ownerToken,
    );
    expect(replay.statusCode).toBe(400);
    const admin = f.token(f.member("org_admin").principalId);
    const stolen = await f.call(
      "GET",
      `/v1/audit-events?outcome=denied&limit=2&cursor=${cursorValue}`,
      admin,
    );
    expect(stolen.statusCode).toBe(400);
    // The audit trail needs the admin column, declared by the catalog and enforced by the service.
    expect(
      routeCatalog.find((route) => route.method === "GET" && route.path === "/audit-events")?.scope,
    ).toBe("audit:A");
    const refused = await f.call("GET", "/v1/audit-events", viewer);
    expect(refused.statusCode).toBe(403);
    expect((await f.call("GET", "/v1/audit-events?limit=101", f.ownerToken)).statusCode).toBe(400);
  });
});

describe("approval policy over HTTP", () => {
  it("SEC-039 reads the default policy, changes it with If-Match and refuses non-admins and bad values", async () => {
    const f = await fixture();
    const path = `/v1/projects/${f.init.projectId}/approval-policy`;
    const current = await f.call("GET", path, f.ownerToken);
    expect(current.json().data).toMatchObject({ requiredApprovers: 1, separationOfDuties: false });
    const version = current.json().data.version as number;
    const dual = { requiredApprovers: 2, separationOfDuties: true };
    const maintainer = f.token(f.member("maintainer").principalId);
    const denied = await f.call("PUT", path, maintainer, {
      payload: dual,
      headers: { "if-match": `"${version}"` },
    });
    expect(denied.statusCode).toBe(403);
    expect((await f.call("GET", path, maintainer)).statusCode).toBe(200);
    const invalid = await f.call("PUT", path, f.ownerToken, {
      payload: { requiredApprovers: 2, separationOfDuties: false },
      headers: { "if-match": `"${version}"` },
    });
    expect(invalid.statusCode).toBe(400);
    const stale = await f.call("PUT", path, f.ownerToken, {
      payload: dual,
      headers: { "if-match": `"${version + 5}"` },
    });
    expect(stale.statusCode).toBe(412);
    const updated = await f.call("PUT", path, f.ownerToken, {
      payload: dual,
      headers: { "if-match": `"${version}"` },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().data).toMatchObject(dual);
    expect((await f.call("GET", path, f.ownerToken)).json().data).toMatchObject(dual);
    const audited = await f.call("GET", "/v1/audit-events?operation=approval.policy", f.ownerToken);
    expect(audited.json().data.items).toHaveLength(1);
  });
});
