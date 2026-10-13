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
import { type Role, rbacMatrix } from "@testmaster/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "./server.js";

const origin = "https://tm.example";
const password = "correct horse battery staple";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-identity-http-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const application = await Application.open({ cwd, home, env: {} });
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
  const member = async (role: Role) => {
    const login = `${role.replace("_", "-")}-${++counter}`;
    const added = application.members.add(init.workspaceId, {
      login,
      displayName: login,
      role,
      projectRestrictions: [],
    });
    if (added.recovery)
      await application.identityService.recover({
        principal: login,
        recoveryToken: added.recovery.recoveryToken,
        newPassword: password,
      });
    return { login, view: added.member };
  };
  const call = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    options: {
      headers?: Record<string, string>;
      payload?: unknown;
      https?: boolean;
      remoteAddress?: string;
    } = {},
  ) =>
    app.inject({
      method,
      url,
      remoteAddress: options.remoteAddress ?? "127.0.0.1",
      headers: {
        ...(options.https === false ? {} : { "x-forwarded-proto": "https" }),
        ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }),
        ...options.headers,
      },
      ...(method === "GET" || method === "DELETE" ? {} : { payload: options.payload ?? {} }),
    });
  const login = async (principal: string, secret = password) =>
    call("POST", "/v1/identity/login", {
      payload: { principal, password: secret },
      headers: { origin },
    });
  /** Logs in and returns the cookie header plus the CSRF token of the new session. */
  const browser = async (principal: string) => {
    const response = await login(principal);
    const cookie = String(response.headers["set-cookie"]).split(";")[0] as string;
    return {
      cookie,
      csrf: response.json().data.csrfToken as string,
      response,
    };
  };
  const apiToken = (
    principalId: string,
    scopes: ("R" | "W" | "X" | "A")[],
    grants?: PermissionGrant[],
  ) =>
    application.tokens.create({
      name: `t-${++counter}`,
      scopes,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      principalId,
      ...(grants ? { grants } : {}),
    });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  return { app, application, init, config, member, call, login, browser, apiToken, bearer };
}

it("ADR-017 refuses plaintext requests in server mode except health/live and ignores forwarding headers from untrusted peers", async () => {
  const f = await fixture();
  const plain = await f.call("GET", "/v1/me", { https: false });
  expect(plain.statusCode).toBe(403);
  expect(plain.json().error).toMatchObject({
    code: "FORBIDDEN",
    details: { reason: "tls_required" },
  });
  expect((await f.call("GET", "/v1/health/live", { https: false })).statusCode).toBe(200);
  // An untrusted peer cannot claim https for itself.
  const spoofed = await f.call("GET", "/v1/me", { remoteAddress: "10.9.9.9" });
  expect(spoofed.json().error.details).toMatchObject({ reason: "tls_required" });
  // Positive control: the trusted proxy reaches authentication, which then needs a credential.
  expect((await f.call("GET", "/v1/me")).statusCode).toBe(401);
});

it("ADR-017 logs in with a __Host- session cookie and keeps loopback requests authenticated", async () => {
  const f = await fixture();
  const user = await f.member("maintainer");
  const ok = await f.login(user.login);
  expect(ok.statusCode).toBe(200);
  const cookie = String(ok.headers["set-cookie"]);
  expect(cookie).toMatch(/^__Host-tm_session=[A-Za-z0-9_-]{43};/);
  for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Strict"])
    expect(cookie).toContain(attribute);
  expect(cookie).not.toContain("Domain=");
  expect(ok.json().data).toMatchObject({ state: "authenticated", workspaceId: f.init.workspaceId });
  expect(ok.json().data.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const failed = await f.login(user.login, "wrong wrong wrong");
  expect(failed.statusCode).toBe(401);
  expect(failed.json().error).toMatchObject({
    code: "UNAUTHENTICATED",
    message: "Invalid credentials",
  });
  expect(failed.headers["set-cookie"]).toBeUndefined();
  // Loopback is not a trust boundary: no credential means no data.
  const anonymous = await f.call("GET", "/v1/projects", { remoteAddress: "127.0.0.1" });
  expect(anonymous.statusCode).toBe(401);
  const session = await f.browser(user.login);
  expect(
    (await f.call("GET", "/v1/projects", { headers: { cookie: session.cookie } })).statusCode,
  ).toBe(200);
});

it("ADR-017 locks the credential after ten failed HTTP logins with the same generic answer", async () => {
  const f = await fixture();
  const user = await f.member("maintainer");
  const unknown = await f.login("nobody-here", "wrong wrong wrong");
  for (let index = 0; index < 10; index++) await f.login(user.login, "wrong wrong wrong");
  const locked = await f.login(user.login);
  expect(locked.statusCode).toBe(401);
  expect(locked.json().error).toMatchObject({
    code: "UNAUTHENTICATED",
    message: "Invalid credentials",
  });
  expect(locked.json().error.message).toBe(unknown.json().error.message);
  expect(locked.headers["set-cookie"]).toBeUndefined();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 16 * 60_000);
  expect((await f.login(user.login)).statusCode).toBe(200);
});

it("ADR-017 requires the CSRF token and an allowed Origin for cookie-authenticated writes", async () => {
  const f = await fixture();
  const admin = await f.member("org_admin");
  const session = await f.browser(admin.login);
  const create = (headers: Record<string, string>) =>
    f.call("POST", "/v1/tokens", {
      headers: { cookie: session.cookie, ...headers },
      payload: {
        name: "browser-made",
        scopes: ["R"],
        grants: [],
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    });
  for (const headers of [
    { origin },
    { origin, "x-csrf-token": "x".repeat(43) },
    { "x-csrf-token": session.csrf },
  ]) {
    const refused = await create(headers);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatchObject({ code: "FORBIDDEN", details: { reason: "csrf" } });
  }
  const foreign = await create({ origin: "https://evil.example", "x-csrf-token": session.csrf });
  expect(foreign.statusCode).toBe(403);
  expect(foreign.json().error.message).toBe("Origin is not allowed");
  const accepted = await create({ origin, "x-csrf-token": session.csrf });
  expect(accepted.statusCode).toBe(201);
  expect(accepted.json().data.token).toMatch(/^tm_api_/);
});

it("ADR-017 never reads cookies for bearer requests and needs no CSRF token for bearers", async () => {
  const f = await fixture();
  const user = await f.member("maintainer");
  const session = await f.browser(user.login);
  // A valid cookie cannot rescue an invalid bearer token.
  const mixed = await f.call("GET", "/v1/me", {
    headers: { cookie: session.cookie, authorization: `Bearer tm_api_${"a".repeat(43)}` },
  });
  expect(mixed.statusCode).toBe(401);
  // A valid bearer with a garbage cookie works, as does a bearer write without CSRF or Origin.
  const issued = f.apiToken(user.view.principalId, ["R", "W", "A"]);
  const ok = await f.call("GET", "/v1/me", {
    headers: { ...f.bearer(issued.token), cookie: "__Host-tm_session=garbage" },
  });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().data.csrfToken).toBeNull();
  const write = await f.call("POST", `/v1/projects/${f.init.projectId}/archive`, {
    headers: {
      ...f.bearer(issued.token),
      "if-match": `"${f.application.projects.get(f.init.projectId).version}"`,
    },
  });
  expect(write.statusCode).toBe(200);
});

it("ADR-017 expires an idle browser session over HTTP and logout revokes it", async () => {
  const f = await fixture();
  const user = await f.member("maintainer");
  const session = await f.browser(user.login);
  expect((await f.call("GET", "/v1/me", { headers: { cookie: session.cookie } })).statusCode).toBe(
    200,
  );
  const out = await f.call("POST", "/v1/identity/logout", {
    headers: { cookie: session.cookie, origin, "x-csrf-token": session.csrf },
  });
  expect(out.statusCode).toBe(200);
  expect((await f.call("GET", "/v1/me", { headers: { cookie: session.cookie } })).statusCode).toBe(
    401,
  );
  const idle = await f.browser(user.login);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 31 * 60_000);
  expect((await f.call("GET", "/v1/me", { headers: { cookie: idle.cookie } })).statusCode).toBe(
    401,
  );
});

it("ADR-017 reports the caller through /me and publishes the role matrix", async () => {
  const f = await fixture();
  const viewer = await f.member("viewer");
  const session = await f.browser(viewer.login);
  const me = (await f.call("GET", "/v1/me", { headers: { cookie: session.cookie } })).json().data;
  expect(me.membership.role).toBe("viewer");
  expect(me.permissions).toEqual({
    read: true,
    write: false,
    execute: false,
    secret: false,
    export: false,
    admin: false,
  });
  expect(typeof me.csrfToken).toBe("string");
  const matrix = await f.call("GET", "/v1/rbac/matrix", { headers: { cookie: session.cookie } });
  expect(matrix.json().data.matrix).toEqual(JSON.parse(JSON.stringify(rbacMatrix)));
  // The CSRF token is stable across reads, so concurrent tabs never invalidate each other.
  const again = (await f.call("GET", "/v1/me", { headers: { cookie: session.cookie } })).json()
    .data;
  expect(again.csrfToken).toBe(me.csrfToken);
  expect(me.csrfToken).toBe(session.csrf);
});

it("ADR-017 ends an open SSE stream when its token is revoked and keeps it open until then", async () => {
  const f = await fixture();
  const test = f.application.tests.create({
    projectId: f.init.projectId,
    plan: scaffoldPlan("backend"),
  });
  f.application.preflight = async () => {};
  const run = f.application.runs.prepare({ testId: test.id, environmentId: f.init.environmentId });
  const receipt = f.application.database.withTx(() => f.application.runs.insert(run, randomUUID()));
  const owner = f.application.members.list(f.init.workspaceId).find((m) => m.role === "org_owner");
  const issued = f.apiToken(String(owner?.principalId), ["R"]);
  const address = await f.app.listen({ port: 0, host: "127.0.0.1" });
  const response = await fetch(`${address}/v1/runs/${receipt.runId}/events`, {
    headers: { ...f.bearer(issued.token), "x-forwarded-proto": "https" },
  });
  expect(response.status).toBe(200);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  expect((await reader.read()).done).toBe(false);
  // The stream is polled by a real 100 ms interval on a real socket; fake timers cannot drive it,
  // so this integration test races the platform clock against the stream with generous bounds.
  const still = await Promise.race([
    reader.read().then((chunk) => (chunk.done ? "closed" : "open")),
    new Promise<string>((resolve) => setTimeout(() => resolve("open"), 500)),
  ]);
  expect(still).toBe("open");
  f.application.tokens.revoke(issued.metadata.id);
  const ended = await Promise.race([
    (async () => {
      for (;;) if ((await reader.read()).done) return "closed";
    })(),
    new Promise<string>((resolve) => setTimeout(() => resolve("still open"), 3000)),
  ]);
  expect(ended).toBe("closed");
});

it("ADR-017 allows only operator tokens to create workspaces and reports the engine rule to them", async () => {
  const f = await fixture();
  const owner = f.application.members.list(f.init.workspaceId).find((m) => m.role === "org_owner");
  const admin = f.apiToken(String(owner?.principalId), ["R", "W", "X", "A"]);
  const input = { name: "second", ownerLogin: "second-owner" };
  const denied = await f.call("POST", "/v1/workspaces", {
    headers: f.bearer(admin.token),
    payload: input,
  });
  expect(denied.statusCode).toBe(403);
  expect(denied.json().error).toMatchObject({
    code: "FORBIDDEN",
    details: { reason: "operator_required" },
  });
  const operator = f.application.operator.operatorToken();
  const allowed = await f.call("POST", "/v1/workspaces", {
    headers: f.bearer(operator.token),
    payload: input,
  });
  // SQLite keeps exactly one workspace, so the operator passes the gate and meets the engine rule.
  expect(allowed.json().error.code).toBe("PRECONDITION_FAILED");
  expect(f.application.operator.workspaceIds()).toHaveLength(1);
});

it("ADR-017 refuses self-promotion and demoting the last org_owner over HTTP", async () => {
  const f = await fixture();
  const admin = await f.member("org_admin");
  const token = f.apiToken(admin.view.principalId, ["R", "W", "A"]);
  const patch = (memberId: string, version: number, role: Role) =>
    f.call("PATCH", `/v1/workspaces/${f.init.workspaceId}/members/${memberId}`, {
      headers: { ...f.bearer(token.token), "if-match": `"${version}"` },
      payload: { role },
    });
  const self = await patch(admin.view.id, admin.view.version, "org_owner");
  expect(self.statusCode).toBe(403);
  expect(self.json().error).toMatchObject({
    code: "FORBIDDEN",
    details: { reason: "self_promotion" },
  });
  const owner = f.application.members.list(f.init.workspaceId).find((m) => m.role === "org_owner");
  if (!owner) throw new Error("The workspace owner must exist");
  const last = await patch(owner.id, owner.version, "viewer");
  expect(last.statusCode).toBe(422);
  expect(last.json().error).toMatchObject({
    code: "PRECONDITION_FAILED",
    message: "Workspace needs an org_owner",
  });
  // Positive control: an admin may change another member that is not an owner.
  const viewer = await f.member("viewer");
  const changed = await patch(viewer.view.id, viewer.view.version, "maintainer");
  expect(changed.statusCode).toBe(200);
  expect(changed.json().data.role).toBe("maintainer");
});

it("ADR-017 scopes grants to their resource type over HTTP", async () => {
  const f = await fixture();
  const service = await f.member("service_account");
  const grant = (resourceType: string): PermissionGrant => ({
    resourceType,
    actions: ["write"],
    projectIds: [f.init.projectId],
    environmentIds: [],
    expiresAt: null,
    grantedBy: f.init.principalId,
  });
  const read: PermissionGrant = { ...grant("*"), actions: ["read"] };
  const archive = (grants: PermissionGrant[]) =>
    f.call("POST", `/v1/projects/${f.init.projectId}/archive`, {
      headers: {
        ...f.bearer(f.apiToken(service.view.principalId, ["R", "W"], [read, ...grants]).token),
        "if-match": `"${f.application.projects.get(f.init.projectId).version}"`,
      },
    });
  expect((await archive([])).statusCode).toBe(403);
  expect((await archive([grant("Run")])).statusCode).toBe(403);
  expect((await archive([grant("*")])).statusCode).toBe(200);
});
