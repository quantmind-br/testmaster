import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, type ServerConfig } from "@testmaster/application";
import type { Role } from "@testmaster/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer } from "./server.js";

const origin = "https://tm.example";
const password = "correct horse battery staple";
const targetPassword = "target-password-canary-7788";
const cleanup: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  vi.stubEnv("CI", "true");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A minimal target app: JSON login that sets a `session` cookie. */
async function targetSite(): Promise<{ url: string; logins: () => number }> {
  let logins = 0;
  const server: Server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        username?: string;
        password?: string;
      };
      if (request.url === "/api/login" && body.password === targetPassword) {
        logins += 1;
        response.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "session=server-issued-session-value; Path=/",
        });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "bad" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, logins: () => logins };
}

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-auth-http-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const application = await Application.open({ cwd, home, env: {} });
  const init = await application.init();
  application.preflight = async () => {};
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
  const site = await targetSite();
  let counter = 0;
  const tokenFor = async (role: Role | "owner") => {
    if (role === "owner")
      return application.tokens.create({
        name: "owner",
        scopes: ["R", "W", "X", "A"],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }).token;
    const login = `${role.replace("_", "-")}-${++counter}`;
    const added = application.members.add(init.workspaceId, {
      login,
      displayName: login,
      role,
      projectRestrictions: [],
    });
    return application.tokens.create({
      name: `t-${counter}`,
      scopes: ["R", "W", "X"],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      principalId: String(added.member.principalId),
    }).token;
  };
  const call = (
    method: "GET" | "POST" | "PATCH",
    url: string,
    token: string | null,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      remoteAddress: "127.0.0.1",
      headers: {
        "x-forwarded-proto": "https",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }),
        ...headers,
      },
      ...(method === "GET" ? {} : { payload: payload ?? {} }),
    });
  const username = await application.secrets.set("site-user", "alice", {
    allowedOrigins: [site.url],
  });
  const secret = await application.secrets.set("site-pass", targetPassword, {
    allowedOrigins: [site.url],
  });
  const profileBody = {
    projectId: init.projectId,
    name: "site-login",
    kind: "form",
    originBindings: [site.url],
    secrets: { username: username.id, password: secret.id },
    config: {
      http: {
        loginUrl: `${site.url}/api/login`,
        contentType: "json",
        fields: { username: "username", password: "password" },
        success: { statusIn: [200], cookieNames: ["session"] },
      },
    },
  };
  const environment = application.environments.create({
    projectId: init.projectId,
    name: "route-env",
    baseUrl: site.url,
    networkProfile: "local-loopback",
  });
  return { application, init, site, call, tokenFor, profileBody, environment, username, secret };
}

it("REQ-018 SEC-023 M4-03 auth profile routes require authentication and the right role", async () => {
  const f = await fixture();
  const anonymous = await f.call("GET", "/v1/auth-profiles", null);
  expect(anonymous.statusCode).toBe(401);
  const viewer = await f.tokenFor("viewer");
  const runner = await f.tokenFor("runner");
  const owner = await f.tokenFor("owner");
  // A viewer reads but cannot author; a runner cannot author either.
  expect((await f.call("GET", "/v1/auth-profiles", viewer)).statusCode).toBe(200);
  for (const denied of [viewer, runner]) {
    const refused = await f.call("POST", "/v1/auth-profiles", denied, f.profileBody);
    expect(refused.statusCode).toBe(403);
  }
  const created = await f.call("POST", "/v1/auth-profiles", owner, f.profileBody);
  expect(created.statusCode).toBe(201);
  const profile = created.json().data;
  expect(profile).toMatchObject({ name: "site-login", kind: "form" });
  // The viewer cannot run a login test either; the runner can.
  const testBody = { environmentId: f.environment.id };
  expect(
    (await f.call("POST", `/v1/auth-profiles/${profile.id}/test-login`, viewer, testBody))
      .statusCode,
  ).toBe(403);
  expect(f.site.logins()).toBe(0);
  const environmentWithAuth = f.application.environments.create({
    projectId: f.init.projectId,
    name: "with-auth",
    baseUrl: f.site.url,
    networkProfile: "local-loopback",
    authRefs: [profile.id],
  });
  const tested = await f.call("POST", `/v1/auth-profiles/${profile.id}/test-login`, runner, {
    environmentId: environmentWithAuth.id,
  });
  expect(tested.statusCode).toBe(200);
  expect(tested.json().data).toMatchObject({ outcome: "authenticated", draftsChanged: false });
  expect(f.site.logins()).toBe(1);
});

it("SEC-023 SEC-022 no route response contains a credential value", async () => {
  const f = await fixture();
  const owner = await f.tokenFor("owner");
  const created = await f.call("POST", "/v1/auth-profiles", owner, f.profileBody);
  const profile = created.json().data;
  const environment = f.application.environments.create({
    projectId: f.init.projectId,
    name: "leak-env",
    baseUrl: f.site.url,
    networkProfile: "local-loopback",
    authRefs: [profile.id],
  });
  const responses = [
    created,
    await f.call("POST", `/v1/auth-profiles/${profile.id}/test-login`, owner, {
      environmentId: environment.id,
    }),
    await f.call("GET", `/v1/auth-profiles/${profile.id}`, owner),
    await f.call("GET", "/v1/auth-profiles", owner),
    await f.call("POST", `/v1/auth-profiles/${profile.id}/revoke-session`, owner),
    await f.call("GET", "/v1/auth-checkpoints", owner),
  ];
  for (const response of responses) {
    expect(response.statusCode).toBeLessThan(300);
    expect(response.body).not.toContain(targetPassword);
    expect(response.body).not.toContain("server-issued-session-value");
    expect(response.body).not.toContain("alice");
  }
  // The revoked session now refuses use.
  const view = (await f.call("GET", `/v1/auth-profiles/${profile.id}`, owner)).json().data;
  expect(view.session.state).toBe("revoked");
});

it("SEC-023 profile updates need the current ETag and refuse a stale one", async () => {
  const f = await fixture();
  const owner = await f.tokenFor("owner");
  const created = (await f.call("POST", "/v1/auth-profiles", owner, f.profileBody)).json().data;
  const missing = await f.call("PATCH", `/v1/auth-profiles/${created.id}`, owner, {
    name: "renamed",
  });
  expect(missing.statusCode).toBe(428);
  const stale = await f.call(
    "PATCH",
    `/v1/auth-profiles/${created.id}`,
    owner,
    { name: "renamed" },
    { "if-match": '"99"' },
  );
  expect(stale.statusCode).toBe(412);
  const current = await f.call(
    "PATCH",
    `/v1/auth-profiles/${created.id}`,
    owner,
    { name: "renamed" },
    { "if-match": `"${created.version}"` },
  );
  expect(current.statusCode).toBe(200);
  expect(current.json().data.name).toBe("renamed");
});

it("SEC-022 exporting a storage state over HTTP needs the caller's password and an explicit grant", async () => {
  const f = await fixture();
  const owner = await f.tokenFor("owner");
  const created = await f.call("POST", "/v1/auth-profiles", owner, {
    ...f.profileBody,
    name: "manual-site",
    kind: "manual",
    secrets: {},
    config: { challenge: { kind: "captcha", resolution: "storage-state" } },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().data.id as string;
  const hostname = new URL(f.site.url).hostname;
  const input = await f.application.secrets.set(
    "imported-state",
    JSON.stringify({
      cookies: [{ name: "session", value: "http-export-cookie", domain: hostname, path: "/" }],
      origins: [],
    }),
    { allowedOrigins: [f.site.url] },
  );
  const imported = await f.call("POST", `/v1/auth-profiles/${id}/import-state`, owner, {
    inputRef: input.id,
  });
  expect(imported.statusCode).toBe(200);
  expect(imported.body).not.toContain("http-export-cookie");
  // A bearer token has no implicit export right even with admin scope.
  const refused = await f.call("POST", `/v1/auth-profiles/${id}/export-state`, owner, {
    password,
  });
  expect(refused.statusCode).toBe(403);
  const unauthenticated = await f.call("POST", `/v1/auth-profiles/${id}/export-state`, null, {
    password,
  });
  expect(unauthenticated.statusCode).toBe(401);
});

it("SEC-024 an unknown checkpoint is not found and cannot be continued", async () => {
  const f = await fixture();
  const owner = await f.tokenFor("owner");
  const viewer = await f.tokenFor("viewer");
  const missing = "chk_00000000-0000-4000-8000-000000000000";
  expect((await f.call("GET", `/v1/auth-checkpoints/${missing}`, owner)).statusCode).toBe(404);
  expect(
    (await f.call("POST", `/v1/auth-checkpoints/${missing}/continue`, owner, {})).statusCode,
  ).toBe(404);
  expect(
    (await f.call("POST", `/v1/auth-checkpoints/${missing}/cancel`, viewer, {})).statusCode,
  ).toBeGreaterThanOrEqual(403);
  expect((await f.call("GET", "/v1/auth-checkpoints", owner)).json().data.items).toEqual([]);
});

it("OPS-035 SEC-023 a viewer and a runner cannot revoke an authenticated session, and an owner can", async () => {
  const f = await fixture();
  const owner = await f.tokenFor("owner");
  const viewer = await f.tokenFor("viewer");
  const runner = await f.tokenFor("runner");
  const created = await f.call("POST", "/v1/auth-profiles", owner, f.profileBody);
  const profile = created.json().data;
  const environment = f.application.environments.create({
    projectId: f.init.projectId,
    name: "revoke-env",
    baseUrl: f.site.url,
    networkProfile: "local-loopback",
    authRefs: [profile.id],
  });
  const signedIn = await f.call("POST", `/v1/auth-profiles/${profile.id}/test-login`, owner, {
    environmentId: environment.id,
  });
  expect(signedIn.statusCode).toBe(200);
  const sessionState = async () =>
    (await f.call("GET", `/v1/auth-profiles/${profile.id}`, owner)).json().data.session.state;
  const before = await sessionState();
  expect(before).not.toBe("revoked");
  for (const denied of [viewer, runner]) {
    const refused = await f.call("POST", `/v1/auth-profiles/${profile.id}/revoke-session`, denied);
    expect(refused.statusCode).toBe(403);
    expect(await sessionState()).toBe(before);
  }
  const revoked = await f.call("POST", `/v1/auth-profiles/${profile.id}/revoke-session`, owner);
  expect(revoked.statusCode).toBe(200);
  expect(await sessionState()).toBe("revoked");
});
