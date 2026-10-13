import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "@testmaster/application";
import { type GithubWorld, startGithubWorld } from "@testmaster/application/testing";
import { createTestDatabase, type TestDatabase } from "@testmaster/persistence/testing";
import { createServer } from "@testmaster/server";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createTestCa,
  HttpsClient,
  startTlsProxy,
  type TestCa,
  type TlsProxy,
} from "./tls-proxy.js";

/**
 * SEC-013 on the server profile: PostgreSQL, the real HTTP server and a TLS-terminating proxy
 * standing in for Caddy. Real TLS handshakes, real `Set-Cookie` headers and a fake GitHub that signs
 * webhooks exactly as GitHub does.
 */
const SHA_A = "a".repeat(40);
const SHA_B = "b1".repeat(20);

let directory = "";
let database: TestDatabase;
let ca: TestCa;
let strangerCa: TestCa;
let proxy: TlsProxy;
let world: GithubWorld;
let http: ReturnType<typeof createServer>;
let directPort = 0;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "tm-sec013-"));
  await writeFile(join(directory, "master.key"), randomBytes(32), { mode: 0o600 });
  await mkdir(join(directory, "evidence"), { recursive: true });
  database = await createTestDatabase();
  ca = await createTestCa(join(directory, "ca"));
  strangerCa = await createTestCa(join(directory, "stranger-ca"));
  proxy = await startTlsProxy({ ca, upstreamPort: () => directPort });
  const server: ServerConfig = {
    mode: "server",
    database: { engine: "postgres", ...database.config },
    storage: { kind: "filesystem", root: join(directory, "evidence") },
    server: {
      listen: { host: "127.0.0.1", port: 0 },
      publicOrigin: proxy.origin,
      trustedProxies: ["127.0.0.1"],
      origins: [proxy.origin],
    },
    security: {
      masterKeyFile: join(directory, "master.key"),
      backupKeyFile: join(directory, "backup.key"),
      atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
    },
  };
  world = await startGithubWorld({ server, publicOrigin: proxy.origin });
  http = createServer({ application: world.runtime, mode: "server", server, mcp: false });
  await http.listen({ host: "127.0.0.1", port: 0 });
  const address = http.server.address();
  directPort = typeof address === "object" && address ? address.port : 0;
  await world.install();
}, 300_000);

afterAll(async () => {
  await http?.close();
  await proxy?.close();
  await world?.stop();
  await database?.drop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

const hookUrl = "/v1/integrations/github/webhooks";
const pullCount = (): number =>
  Number(world.app.database.get("SELECT COUNT(*) AS n FROM github_pulls")?.n);
const deliveryCount = (): number =>
  Number(world.app.database.get("SELECT COUNT(*) AS n FROM inbound_webhook_deliveries")?.n);
const pullPayload = (number: number, sha: string) =>
  world.fake.pullRequestPayload({
    installationId: world.installationId,
    repository: world.repository,
    number,
    headSha: sha,
  });

interface PlainResponse {
  status: number;
  json: { error?: { code: string; details?: { reason?: string } } };
}

/** Plain HTTP straight to the application, with whatever headers the caller picks. */
function plainRequest(
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer | null = null,
): Promise<PlainResponse> {
  const { promise, resolve, reject } = Promise.withResolvers<PlainResponse>();
  const call = httpRequest(
    { host: "127.0.0.1", port: directPort, path, method, headers },
    (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
        }),
      );
    },
  );
  call.on("error", reject);
  if (body) call.write(body);
  call.end();
  return promise;
}

function signedHook(client: HttpsClient, payload: unknown, deliveryId: string) {
  const signed = world.fake.signedRequest("pull_request", payload, { deliveryId });
  return client.request("POST", hookUrl, { body: payload, headers: signed.headers });
}

it("SEC-013 a client that does not trust the server certificate fails the handshake before any request reaches the server, and the trusted CA gets through", async () => {
  const seen = proxy.requests.length;
  const stranger = new HttpsClient(proxy.origin, strangerCa.caPem);
  await expect(stranger.request("GET", "/v1/health/live")).rejects.toMatchObject({
    code: expect.stringMatching(/SIGNATURE|SELF_SIGNED|CERT/u),
  });
  // Not even the health probe reached the server: the handshake failed first.
  expect(proxy.requests).toHaveLength(seen);
  const trusted = new HttpsClient(proxy.origin, ca.caPem);
  const live = await trusted.request("GET", "/v1/health/live");
  expect(live.status).toBe(200);
  expect(proxy.requests).toHaveLength(seen + 1);
});

it("SEC-013 plaintext reaches nothing but the liveness probe, and a spoofed forwarding header from outside the trusted proxy changes nothing", async () => {
  const me = await plainRequest("GET", "/v1/me", {});
  expect(me.status).toBe(403);
  expect(me.json.error).toMatchObject({ code: "FORBIDDEN", details: { reason: "tls_required" } });
  expect((await plainRequest("GET", "/v1/health/live", {})).status).toBe(200);
  // Through the trusted proxy the same route reaches authentication, which then wants a credential.
  const viaProxy = await new HttpsClient(proxy.origin, ca.caPem).request("GET", "/v1/me");
  expect(viaProxy.status).toBe(401);
  // Every identity route is refused in plaintext too: a password never travels over http.
  const login = await plainRequest(
    "POST",
    "/v1/identity/login",
    { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    Buffer.from(JSON.stringify({ principal: world.owner?.login, password: world.owner?.password })),
  );
  expect(login.status).toBe(403);
  expect(login.json.error?.details?.reason).toBe("tls_required");
});

it("SEC-013 the session cookie is Secure, HttpOnly, SameSite=Strict and host-bound, and a cross-site write with that cookie is refused", async () => {
  const owner = world.owner;
  if (!owner) throw new Error("server-profile world has an owner");
  const client = new HttpsClient(proxy.origin, ca.caPem);
  const login = await client.request("POST", "/v1/identity/login", {
    body: { principal: owner.login, password: owner.password },
    headers: { origin: proxy.origin, "idempotency-key": crypto.randomUUID() },
  });
  expect(login.status).toBe(200);
  const setCookie = String([login.headers["set-cookie"]].flat()[0]);
  expect(setCookie).toMatch(/^__Host-tm_session=[A-Za-z0-9_-]{43};/u);
  for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Strict"])
    expect(setCookie).toContain(attribute);
  expect(setCookie).not.toContain("Domain=");
  const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  client.csrfToken = csrf;
  const write = (headers: Record<string, string>) =>
    client.request("POST", "/v1/tokens", {
      body: {
        name: "cross-site",
        scopes: ["R"],
        grants: [],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      headers: { "idempotency-key": crypto.randomUUID(), ...headers },
    });
  // Cross-site: the browser would attach the cookie, but the Origin is not ours and the CSRF token is unknown.
  const foreign = await write({ origin: "https://evil.example", "x-csrf-token": csrf });
  expect(foreign.status).toBe(403);
  const noToken = await write({ origin: proxy.origin });
  expect(noToken.status).toBe(403);
  expect(noToken.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
    "csrf",
  );
  const wrongToken = await write({ origin: proxy.origin, "x-csrf-token": "x".repeat(43) });
  expect(wrongToken.status).toBe(403);
  // Positive control: same session, our Origin and the CSRF token it was issued.
  const accepted = await write({ origin: proxy.origin, "x-csrf-token": csrf });
  expect(accepted.status).toBe(201);
});

it("SEC-013 a signed webhook over plaintext is refused before its signature is read, and over TLS it is accepted once and replayed without effect", async () => {
  const payload = pullPayload(7, SHA_A);
  const signed = world.fake.signedRequest("pull_request", payload, { deliveryId: "sec013-1" });
  const before = { pulls: pullCount(), deliveries: deliveryCount() };
  const plain = await plainRequest("POST", hookUrl, signed.headers, signed.rawBody);
  expect(plain.status).toBe(403);
  expect(plain.json.error?.details?.reason).toBe("tls_required");
  expect({ pulls: pullCount(), deliveries: deliveryCount() }).toEqual(before);

  const client = new HttpsClient(proxy.origin, ca.caPem);
  const first = await signedHook(client, payload, "sec013-1");
  expect(first.status).toBe(200);
  expect(first.json<{ data: unknown }>().data).toMatchObject({
    outcome: "accepted",
    duplicate: false,
  });
  expect(pullCount()).toBe(before.pulls + 1);
  const replay = await signedHook(client, payload, "sec013-1");
  expect(replay.status).toBe(200);
  expect(replay.json<{ data: unknown }>().data).toMatchObject({ duplicate: true });
  expect({ pulls: pullCount(), deliveries: deliveryCount() }).toEqual({
    pulls: before.pulls + 1,
    deliveries: before.deliveries + 1,
  });
});

it("SEC-013 a webhook with a wrong, altered or missing signature has no effect, and a browser session cookie never authorizes one", async () => {
  const owner = world.owner;
  if (!owner) throw new Error("server-profile world has an owner");
  const client = new HttpsClient(proxy.origin, ca.caPem);
  const login = await client.request("POST", "/v1/identity/login", {
    body: { principal: owner.login, password: owner.password },
    headers: { origin: proxy.origin, "idempotency-key": crypto.randomUUID() },
  });
  expect(login.status).toBe(200);
  const before = { pulls: pullCount(), deliveries: deliveryCount() };
  const payload = pullPayload(8, SHA_B);
  const wrongSecret = world.fake.signedRequest("pull_request", payload, {
    deliveryId: "sec013-bad-1",
    secret: "attacker-secret",
  });
  const altered = world.fake.signedRequest("pull_request", payload, {
    deliveryId: "sec013-bad-2",
    alteredBody: JSON.stringify(pullPayload(8, "c".repeat(40))),
  });
  for (const request of [wrongSecret, altered]) {
    const refused = await client.request("POST", hookUrl, {
      body: JSON.parse(request.rawBody.toString("utf8")),
      headers: request.headers,
    });
    expect(refused.status).toBe(401);
  }
  // Valid session cookie, no signature: the cookie is not a credential for a signature route.
  const unsigned = await client.request("POST", hookUrl, {
    body: payload,
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": "sec013-bad-3",
    },
  });
  expect(unsigned.status).toBe(401);
  expect({ pulls: pullCount(), deliveries: deliveryCount() }).toEqual(before);
  // Positive control: the same bytes, correctly signed, are processed even though the cookie carries no CSRF token.
  const good = await signedHook(client, payload, "sec013-good-1");
  expect(good.status).toBe(200);
  expect(pullCount()).toBe(before.pulls + 1);
});

it("SEC-013 replay protection is durable: a captured delivery replayed after the metadata and audit windows is still answered from its record", async () => {
  const payload = pullPayload(9, "d1".repeat(20));
  const client = new HttpsClient(proxy.origin, ca.caPem);
  const first = await signedHook(client, payload, "sec013-durable");
  expect(first.status).toBe(200);
  const pulls = pullCount();
  const system = world.runtime.forWorkspaceSystem(String(world.app.context.workspaceId));
  const later = new Date(Date.now() + 800 * 86_400_000);
  await system.retentionPurge.run({ now: later });
  const replay = await signedHook(client, payload, "sec013-durable");
  expect(replay.json<{ data: unknown }>().data).toMatchObject({ duplicate: true });
  expect(pullCount()).toBe(pulls);
  // A replay whose bytes changed is a tamper, however old the original is.
  const tampered = await signedHook(client, pullPayload(9, "e1".repeat(20)), "sec013-durable");
  expect(tampered.status).toBe(409);
  expect(pullCount()).toBe(pulls);
});
