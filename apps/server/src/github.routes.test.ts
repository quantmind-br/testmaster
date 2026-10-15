import { randomUUID } from "node:crypto";
import { issueLocalToken } from "@testmaster/application";
import { type GithubWorld, startGithubWorld } from "@testmaster/application/testing";
import { INBOUND_WEBHOOK_MAX_BYTES } from "@testmaster/contracts";
import { afterEach, expect, it } from "vitest";
import { createServer } from "./server.js";

const SHA_A = "a".repeat(40);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(options?: Parameters<typeof startGithubWorld>[0]) {
  const world: GithubWorld = await startGithubWorld(options);
  const admin = await issueLocalToken(world.app);
  const reader = await issueLocalToken(world.app, {
    scopes: ["R", "W", "X"],
    tokenPath: `${world.app.config.home}/writer.token`,
  });
  const viewer = await issueLocalToken(world.app, {
    scopes: ["R"],
    tokenPath: `${world.app.config.home}/viewer.token`,
  });
  const app = createServer({
    application: world.app,
    mcp: false,
    origins: ["http://127.0.0.1:7331"],
  });
  cleanup.push(async () => {
    await app.close();
    await world.stop();
  });
  const authorize = (token: string) => ({ authorization: `Bearer ${token}` });
  const send = (
    method: "POST" | "PATCH",
    url: string,
    payload: unknown,
    headers: Record<string, string> = authorize(admin.token),
  ) =>
    app.inject({
      method,
      url,
      headers: { "idempotency-key": randomUUID(), ...headers },
      payload: payload as object,
    });
  const get = (url: string, token = admin.token) =>
    app.inject({ method: "GET", url, headers: authorize(token) });
  const webhook = (
    event: string,
    payload: unknown,
    options: Parameters<GithubWorld["fake"]["signedRequest"]>[2] = {},
    extra: Record<string, string> = {},
  ) => {
    const request = world.fake.signedRequest(event, payload, options);
    return app.inject({
      method: "POST",
      url: "/v1/integrations/github/webhooks",
      headers: { ...request.headers, ...extra },
      payload: request.rawBody,
    });
  };
  const pr = (number: number, sha: string, action = "opened") =>
    world.fake.pullRequestPayload({
      installationId: world.installationId,
      repository: world.repository,
      number,
      headSha: sha,
      action,
    });
  return { world, app, admin, reader, viewer, authorize, send, get, webhook, pr };
}

it("INT-014 INT-002 the GitHub webhook route authenticates by signature only and answers each failure with its own status", async () => {
  const f = await fixture();
  await f.world.install();
  const payload = f.pr(7, SHA_A);
  const ok = await f.webhook("pull_request", payload, { deliveryId: "d-1" });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().data).toMatchObject({
    event: { eventId: "d-1", provider: "github" },
    outcome: "accepted",
    duplicate: false,
  });
  // Garbage bearer and cookie credentials are never read on a signature route; the same delivery dedupes.
  const again = await f.webhook(
    "pull_request",
    payload,
    { deliveryId: "d-1" },
    { authorization: "Bearer nope", cookie: "__Host-tm_session=forged" },
  );
  expect(again.statusCode).toBe(200);
  expect(again.json().data.duplicate).toBe(true);
  // Negative controls: wrong secret, altered body and missing signature never create work.
  expect((await f.webhook("pull_request", f.pr(8, SHA_A), { secret: "wrong" })).statusCode).toBe(
    401,
  );
  expect(
    (
      await f.webhook("pull_request", f.pr(9, SHA_A), {
        alteredBody: JSON.stringify(f.pr(9, "b".repeat(40))),
      })
    ).statusCode,
  ).toBe(401);
  expect((await f.webhook("pull_request", f.pr(10, SHA_A), { signature: "" })).statusCode).toBe(
    401,
  );
  expect(
    f.world.app.database.all("SELECT pr_number FROM github_pulls").map((row) => row.pr_number),
  ).toEqual([7]);
  // A replay of the same delivery ID with different bytes is a tamper: 409, never processed.
  const tampered = await f.webhook("pull_request", f.pr(7, "c".repeat(40), "synchronize"), {
    deliveryId: "d-1",
  });
  expect(tampered.statusCode).toBe(409);
  expect(tampered.json().error).toMatchObject({
    code: "IDEMPOTENCY_CONFLICT",
    details: { reason: "tampered" },
  });
  expect(f.world.app.database.get("SELECT COUNT(*) AS n FROM github_pulls")?.n).toBe(1);
});

it("INT-014 the GitHub webhook route rejects other content types and oversize bodies before any signature work", async () => {
  const f = await fixture();
  await f.world.install();
  const form = await f.webhook("pull_request", f.pr(7, SHA_A), {
    contentType: "application/x-www-form-urlencoded",
  });
  expect(form.statusCode).toBe(400);
  expect(form.json().error).toMatchObject({
    code: "INVALID_ARGUMENT",
    details: { reason: "unsupported_content_type" },
  });
  const big = await f.app.inject({
    method: "POST",
    url: "/v1/integrations/github/webhooks",
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-github-delivery": "big",
      "x-hub-signature-256": "sha256=00",
    },
    payload: Buffer.alloc(INBOUND_WEBHOOK_MAX_BYTES + 1, 0x20),
  });
  expect(big.statusCode).toBe(413);
  expect(f.world.app.database.get("SELECT COUNT(*) AS n FROM github_pulls")?.n).toBe(0);
});

it("INT-014 INT-023 the GitHub webhook route answers 503 retryable for an unreadable secret and records no authentication failure, unlike a wrong secret", async () => {
  const f = await fixture();
  await f.world.install();
  const denials = Number(
    f.world.app.database.get("SELECT COUNT(*) AS n FROM audit_events WHERE action='auth.denied'")
      ?.n,
  );
  // Control: a wrong secret is a 401 and is counted as an authentication failure.
  expect((await f.webhook("pull_request", f.pr(8, SHA_A), { secret: "wrong" })).statusCode).toBe(
    401,
  );
  const counted = () =>
    Number(
      f.world.app.database.get("SELECT COUNT(*) AS n FROM audit_events WHERE action='auth.denied'")
        ?.n,
    );
  expect(counted()).toBe(denials + 1);
  await f.world.app.secrets.remove(f.world.secrets.webhookSecretRef);
  const unavailable = await f.webhook("pull_request", f.pr(7, SHA_A));
  expect(unavailable.statusCode).toBe(503);
  expect(unavailable.json().error).toMatchObject({
    code: "UNAVAILABLE",
    retryable: true,
    details: { reasonCode: "webhook_secret_unavailable" },
  });
  expect(counted()).toBe(denials + 1);
  expect(f.world.app.database.get("SELECT COUNT(*) AS n FROM github_pulls")?.n).toBe(0);
});

it("INT-018 INT-014 an installation event over HTTP does not reach other tenants' routes and an unknown installation creates no Run", async () => {
  const f = await fixture();
  await f.world.install();
  const unknown = f.world.fake.pullRequestPayload({
    installationId: 999,
    repository: f.world.repository,
    number: 7,
    headSha: SHA_A,
    action: "opened",
  });
  const response = await f.webhook("pull_request", unknown);
  expect(response.statusCode).toBe(200);
  expect(response.json().data).toMatchObject({
    outcome: "ignored",
    ignoredReason: "unknown_installation",
  });
  expect(f.world.app.runs.list()).toEqual([]);
});

it("INT-023 INT-020 the management routes need administrator scope and list pulls, checks and installations with cursor pages", async () => {
  const f = await fixture();
  await f.world.install();
  const id = f.world.integration.id;
  for (const url of [
    `/v1/integrations/${id}/github/installations`,
    `/v1/integrations/${id}/github/pulls`,
    `/v1/integrations/${id}/github/checks`,
  ])
    expect((await f.app.inject(url)).statusCode).toBe(401);
  // Reading status needs only read scope; changing anything needs more.
  expect((await f.get(`/v1/integrations/${id}/github/pulls`, f.viewer.token)).statusCode).toBe(200);
  const installations = await f.get(`/v1/integrations/${id}/github/installations`);
  expect(installations.statusCode).toBe(200);
  expect(installations.json().data.items[0]).toMatchObject({
    installationId: "777",
    state: "active",
  });
  await f.webhook("pull_request", f.pr(7, SHA_A));
  await f.webhook("pull_request", f.pr(8, "b".repeat(40)));
  const first = await f.get(`/v1/integrations/${id}/github/pulls?limit=1`);
  expect(first.json().data.items).toHaveLength(1);
  expect(first.json().data.hasMore ?? first.json().meta?.hasMore).toBeTruthy();
  const cursor = first.json().data.nextCursor ?? first.json().meta?.nextCursor;
  const second = await f.get(
    `/v1/integrations/${id}/github/pulls?limit=1&cursor=${encodeURIComponent(cursor)}`,
  );
  expect(second.json().data.items[0].id).not.toBe(first.json().data.items[0].id);
  await f.world.app.github.reconcile();
  const checks = await f.get(`/v1/integrations/${id}/github/checks`);
  expect(checks.json().data.items.length).toBeGreaterThanOrEqual(4);
  expect(checks.json().data.items[0]).toMatchObject({
    state: expect.any(String),
    name: expect.stringContaining("TestMaster /"),
  });
  // Retrying a healthy check is a conflict, not a republish.
  const retry = await f.send(
    "POST",
    `/v1/integrations/${id}/github/checks/${checks.json().data.items[0].id}/retry`,
    {},
  );
  expect(retry.statusCode).toBe(422);
  expect(retry.json().error.details).toMatchObject({ reasonCode: "not_dead_lettered" });
});

it("INT-018 INT-017 repository settings and manual previews are administrator-only, validated and idempotent", async () => {
  const f = await fixture();
  await f.world.install();
  const id = f.world.integration.id;
  const url = `/v1/integrations/${id}/github/repositories/501`;
  expect(
    (await f.send("PATCH", url, { forkPolicy: "deny" }, f.authorize(f.reader.token))).statusCode,
  ).toBe(403);
  const patched = await f.send("PATCH", url, {
    includeDrafts: true,
    preview: { provider: "manual" },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().data.settings).toMatchObject({
    includeDrafts: true,
    preview: { provider: "manual" },
  });
  const invalid = await f.send("PATCH", url, { forkPolicy: "allow-everything" });
  expect(invalid.statusCode).toBe(400);
  await f.webhook("pull_request", f.pr(7, SHA_A));
  const body = {
    integrationId: id,
    repositoryId: "501",
    prNumber: 7,
    headSha: SHA_A,
    url: f.world.target.origin,
  };
  const denied = await f.send("POST", "/v1/preview-deployments", {
    ...body,
    url: "http://169.254.169.254",
  });
  expect(denied.statusCode).toBe(200);
  expect(denied.json().data).toMatchObject({ state: "denied", reasonCode: "preview_url_denied" });
  const wrongSha = await f.send("POST", "/v1/preview-deployments", {
    ...body,
    headSha: "f".repeat(40),
  });
  expect(wrongSha.statusCode).toBe(422);
  expect(
    (await f.send("POST", "/v1/preview-deployments", body, f.authorize(f.viewer.token))).statusCode,
  ).toBe(403);
});

it("INT-014 the manifest routes return the one-time state, never the credentials, and convert the code once", async () => {
  const f = await fixture();
  const manifest = await f.send("POST", "/v1/integrations/github/manifests", {
    name: "TestMaster HTTP",
    publicOrigin: "https://testmaster.example.test",
    redirectUrl: "http://127.0.0.1:41999/callback",
  });
  expect(manifest.statusCode).toBe(201);
  const { state, createUrl } = manifest.json().data;
  expect(createUrl).toContain(state);
  expect(
    (await f.send("POST", "/v1/integrations/github/manifests", { name: "x" })).statusCode,
  ).toBe(400);
  expect(
    (
      await f.send(
        "POST",
        `/v1/integrations/github/manifests/${state}/conversion`,
        { code: "code-1", projectIds: [f.world.projectId] },
        f.authorize(f.reader.token),
      )
    ).statusCode,
  ).toBe(403);
  f.world.fake.registerManifestCode("code-1");
  const converted = await f.send("POST", `/v1/integrations/github/manifests/${state}/conversion`, {
    code: "code-1",
    projectIds: [f.world.projectId],
  });
  expect(converted.statusCode).toBe(200);
  expect(JSON.stringify(converted.json())).not.toContain("BEGIN");
  expect(JSON.stringify(converted.json())).not.toContain(f.world.fake.webhookSecret);
  f.world.fake.registerManifestCode("code-2");
  const replay = await f.send("POST", `/v1/integrations/github/manifests/${state}/conversion`, {
    code: "code-2",
    projectIds: [f.world.projectId],
  });
  expect(replay.statusCode).toBe(404);
});

it("INT-014 rotating the webhook secret over HTTP keeps the previous secret valid for the overlap window only", async () => {
  const f = await fixture();
  await f.world.install();
  const id = f.world.integration.id;
  const next = await f.world.app.secrets.set("github-webhook-secret-2", "second-secret", {
    allowedOrigins: [new URL(f.world.fake.url).origin],
  });
  const rotated = await f.send("POST", `/v1/integrations/${id}/github/rotate-webhook-secret`, {
    secretRef: next.id,
  });
  expect(rotated.statusCode).toBe(200);
  // Both the new and the previous secret verify; an unrelated one still fails.
  expect(
    (await f.webhook("pull_request", f.pr(7, SHA_A), { secret: "second-secret" })).statusCode,
  ).toBe(200);
  expect((await f.webhook("pull_request", f.pr(8, SHA_A))).statusCode).toBe(200);
  expect((await f.webhook("pull_request", f.pr(9, SHA_A), { secret: "third" })).statusCode).toBe(
    401,
  );
  f.world.clock.t += 25 * 3600_000;
  expect((await f.webhook("pull_request", f.pr(10, SHA_A))).statusCode).toBe(401);
  expect(
    (await f.webhook("pull_request", f.pr(11, SHA_A), { secret: "second-secret" })).statusCode,
  ).toBe(200);
});
