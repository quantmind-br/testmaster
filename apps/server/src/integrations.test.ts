import { createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Application,
  type DeliveryOutcome,
  type InboundOutcome,
  type IntegrationProvider,
  integrationProviders,
  issueLocalToken,
  verifyHmacSha256,
} from "@testmaster/application";
import { ContractError, INBOUND_WEBHOOK_MAX_BYTES } from "@testmaster/contracts";
import { afterEach, beforeAll, expect, it } from "vitest";
import { createServer } from "./server.js";

interface Settings {
  installation: string;
}
const secret = "http-test-secret";
const processed: string[] = [];
const tests: { test: boolean; label: string }[] = [];
const provider: IntegrationProvider<Settings> = {
  id: "webhook",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  capabilities: ["notifications", "inbound-events"],
  parseSettings(input) {
    if (typeof input !== "object" || input === null || !("installation" in input))
      throw new ContractError("INVALID_ARGUMENT", "installation is required");
    return { installation: String(input.installation) };
  },
  async sendTest(context): Promise<DeliveryOutcome> {
    tests.push({ test: context.test.test, label: context.test.label });
    return { state: "delivered", detail: "sent" };
  },
  async receive(context, request): Promise<InboundOutcome> {
    if (!verifyHmacSha256(request.headers["x-test-signature"], request.rawBody, [secret]))
      throw new ContractError("UNAUTHENTICATED", "Invalid signature");
    const body = JSON.parse(request.rawBody.toString("utf8")) as { installation: string };
    const deliveryId = request.headers["x-test-delivery"] as string;
    const found = context
      .findIntegrations("webhook")
      .find((item) => (item.settings as Settings).installation === body.installation);
    if (!found)
      return {
        workspaceId: null,
        integrationId: null,
        deliveryId,
        installationKey: body.installation,
        projectId: null,
        eventType: "push",
        action: null,
        disposition: "ignored",
        ignoredReason: "unknown_installation",
      };
    return {
      workspaceId: found.workspaceId,
      integrationId: found.id,
      deliveryId,
      installationKey: body.installation,
      projectId: null,
      eventType: "push",
      action: null,
      disposition: "accepted",
      async process() {
        processed.push(deliveryId);
        return { reference: `ref-${processed.length}` };
      },
    };
  },
};
beforeAll(() => integrationProviders.register(provider as IntegrationProvider));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  processed.length = 0;
  tests.length = 0;
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-integrations-http-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const application = await Application.open({ cwd, home, env: {} });
  const init = await application.init();
  const admin = await issueLocalToken(application);
  const reader = await issueLocalToken(application, {
    scopes: ["R", "W", "X"],
    tokenPath: join(home, "writer.token"),
  });
  const app = createServer({ application, mcp: false, origins: ["http://127.0.0.1:7331"] });
  cleanup.push(async () => {
    await app.close();
    application.close();
    await rm(cwd, { recursive: true, force: true });
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
  const input = (installation = "inst-1") => ({
    provider: "webhook",
    name: `hook-${randomUUID().slice(0, 8)}`,
    projectIds: [init.projectId],
    events: [],
    secretRefs: [],
    settings: { installation },
  });
  const sign = (body: string | Buffer, key = secret) =>
    `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
  const webhook = (
    body: string | Buffer,
    deliveryId: string,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: "POST",
      url: "/v1/integrations/webhook/webhooks",
      headers: {
        "content-type": "application/json",
        "x-test-signature": sign(body),
        "x-test-delivery": deliveryId,
        ...headers,
      },
      payload: body,
    });
  return {
    app,
    application,
    init,
    admin,
    reader,
    authorize,
    send,
    input,
    sign,
    webhook,
  };
}

it("INT-004 integration routes configure, patch, test and list over /v1 with token authentication and administrator scope", async () => {
  const f = await fixture();
  expect((await f.app.inject("/v1/integrations")).statusCode).toBe(401);
  expect(
    (await f.send("POST", "/v1/integrations", f.input(), f.authorize(f.reader.token))).statusCode,
  ).toBe(403);
  expect(
    (await f.app.inject({ url: "/v1/integrations", headers: f.authorize(f.reader.token) }))
      .statusCode,
  ).toBe(403);
  const created = await f.send("POST", "/v1/integrations", f.input());
  expect(created.statusCode).toBe(201);
  const integration = created.json().data;
  expect(integration).toMatchObject({ state: "active", adapterStatus: "compatible" });
  expect(created.headers.etag).toBe('"1"');
  // Attribution is the creating principal; no consent document exists on the integration.
  expect(integration.createdBy).toBe(f.admin.identity.principalId);
  expect(integration).not.toHaveProperty("consent");
  // A consent field is not part of the request schema any more and nothing is stored.
  const legacyConsent = await f.send("POST", "/v1/integrations", {
    ...f.input(),
    consent: { scopes: ["notify:post"] },
  });
  expect(legacyConsent.statusCode).toBe(400);
  // Unknown request fields are refused by the catalog schema before the service runs.
  expect((await f.send("POST", "/v1/integrations", { ...f.input(), extra: 1 })).statusCode).toBe(
    400,
  );
  const listed = await f.app.inject({
    url: "/v1/integrations",
    headers: f.authorize(f.admin.token),
  });
  expect(listed.statusCode).toBe(200);
  expect(listed.json().data.items.map((item: { id: string }) => item.id)).toEqual([integration.id]);
  // PATCH needs If-Match and honours it.
  const noMatch = await f.send("PATCH", `/v1/integrations/${integration.id}`, { name: "renamed" });
  expect(noMatch.statusCode).toBe(428);
  const stale = await f.send(
    "PATCH",
    `/v1/integrations/${integration.id}`,
    { name: "renamed" },
    { ...f.authorize(f.admin.token), "if-match": '"7"' },
  );
  expect(stale.statusCode).toBe(412);
  const patched = await f.send(
    "PATCH",
    `/v1/integrations/${integration.id}`,
    { state: "paused" },
    { ...f.authorize(f.admin.token), "if-match": '"1"' },
  );
  expect(patched.statusCode).toBe(200);
  expect(patched.json().data.state).toBe("paused");
  // A paused integration cannot be tested; once resumed the labelled test receipt is returned.
  expect((await f.send("POST", `/v1/integrations/${integration.id}/test`, {})).statusCode).toBe(
    422,
  );
  await f.send(
    "PATCH",
    `/v1/integrations/${integration.id}`,
    { state: "active" },
    { ...f.authorize(f.admin.token), "if-match": '"2"' },
  );
  const tested = await f.send("POST", `/v1/integrations/${integration.id}/test`, {});
  expect(tested.statusCode).toBe(200);
  expect(tested.json().data).toMatchObject({
    test: true,
    label: "test notification",
    state: "delivered",
  });
  expect(tests).toEqual([{ test: true, label: "test notification" }]);
  expect(
    (
      await f.send(
        "POST",
        `/v1/integrations/${integration.id}/test`,
        {},
        f.authorize(f.reader.token),
      )
    ).statusCode,
  ).toBe(403);
  expect(tests).toHaveLength(1);
});

it("INT-002 the signed webhook route needs neither token, cookie nor Idempotency-Key and dedupes by delivery ID", async () => {
  const f = await fixture();
  const created = (await f.send("POST", "/v1/integrations", f.input())).json().data;
  const body = JSON.stringify({ installation: "inst-1", n: 1 });
  const first = await f.webhook(body, "d-1");
  expect(first.statusCode).toBe(200);
  expect(first.json().data).toMatchObject({
    outcome: "accepted",
    duplicate: false,
    reference: "ref-1",
  });
  // Garbage credentials are not read on a signature route.
  const again = await f.webhook(body, "d-1", {
    authorization: "Bearer not-a-token",
    cookie: "__Host-tm_session=forged",
  });
  expect(again.statusCode).toBe(200);
  expect(again.json().data).toMatchObject({ duplicate: true, reference: "ref-1" });
  expect(processed).toEqual(["d-1"]);
  // Same delivery ID, different bytes: 409 and the original is untouched.
  const tampered = await f.webhook(JSON.stringify({ installation: "inst-1", n: 2 }), "d-1");
  expect(tampered.statusCode).toBe(409);
  expect(tampered.json().error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(processed).toEqual(["d-1"]);
  // The dedupe records stay visible to the owning workspace's administrators.
  expect(
    f.application.integrations
      .inbound({ integrationId: created.id })
      .map((row) => row.outcome)
      .sort(),
  ).toEqual(["accepted", "tampered"]);
  // Control: the same bytes are not accepted on a configuration route without a token.
  expect(
    (await f.app.inject({ method: "POST", url: "/v1/integrations", payload: f.input() }))
      .statusCode,
  ).toBe(401);
});

it("INT-002 the signed webhook route verifies the raw bytes, content type and size before anything is recorded", async () => {
  const f = await fixture();
  await f.send("POST", "/v1/integrations", f.input());
  const count = () =>
    f.application.database.all("SELECT id FROM inbound_webhook_deliveries").length;
  const body = JSON.stringify({ installation: "inst-1" });
  const wrongSignature = await f.webhook(body, "d-1", {
    "x-test-signature": f.sign(body, "wrong"),
  });
  expect(wrongSignature.statusCode).toBe(401);
  // Re-serialised JSON has different bytes and therefore a different valid signature, not the same one.
  const reserialised = JSON.stringify(JSON.parse(body), null, 2);
  expect(
    (await f.webhook(reserialised, "d-1", { "x-test-signature": f.sign(body) })).statusCode,
  ).toBe(401);
  // Invalid JSON with a valid signature is refused by the adapter after the signature, not by the HTTP layer first.
  const notJson = "not json";
  expect(
    (await f.webhook(notJson, "d-2", { "x-test-signature": f.sign(notJson, "wrong") })).statusCode,
  ).toBe(401);
  const wrongType = await f.webhook(body, "d-3", { "content-type": "text/plain" });
  expect(wrongType.statusCode).toBe(400);
  expect(wrongType.json().error.details).toMatchObject({ reason: "unsupported_content_type" });
  const noType = await f.app.inject({
    method: "POST",
    url: "/v1/integrations/webhook/webhooks",
    headers: { "x-test-signature": f.sign(body), "x-test-delivery": "d-4" },
    payload: body,
  });
  expect(noType.statusCode).toBe(400);
  const huge = Buffer.alloc(INBOUND_WEBHOOK_MAX_BYTES + 1, 0x20);
  const tooLarge = await f.webhook(huge, "d-5", { "x-test-signature": f.sign(huge) });
  expect(tooLarge.statusCode).toBe(413);
  expect(tooLarge.json().error.code).toBe("PAYLOAD_TOO_LARGE");
  expect(count()).toBe(0);
  expect(processed).toEqual([]);
  // Control: exactly the limit is accepted by the transport (the adapter then refuses the non-JSON bytes).
  const limit = Buffer.alloc(INBOUND_WEBHOOK_MAX_BYTES, 0x20);
  expect(
    (await f.webhook(limit, "d-6", { "x-test-signature": f.sign(limit) })).statusCode,
  ).not.toBe(413);
  expect((await f.webhook(body, "d-7")).statusCode).toBe(200);
  expect(count()).toBe(1);
  // An unknown provider is a structured 404 and does not run any adapter.
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: "/v1/integrations/nope/webhooks",
        headers: { "content-type": "application/json" },
        payload: body,
      })
    ).statusCode,
  ).toBe(404);
});

it("INT-002 the signed webhook route keeps the caller's rate limit", async () => {
  const f = await fixture();
  const body = JSON.stringify({ installation: "ghost" });
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 40; attempt++)
    statuses.push((await f.webhook(body, `d-${attempt}`)).statusCode);
  expect(statuses[0]).toBe(200);
  expect(statuses).toContain(429);
  const limited = await f.webhook(body, "d-after");
  expect(limited.statusCode).toBe(429);
  expect(limited.headers["retry-after"]).toBe("1");
});

it("OPS-035 INT-004 a caller without administrator scope can neither pause nor revoke an integration over HTTP, and an administrator can do both", async () => {
  const f = await fixture();
  const created = (await f.send("POST", "/v1/integrations", f.input())).json().data;
  const patch = (state: string, token: string, version: number) =>
    f.send(
      "PATCH",
      `/v1/integrations/${created.id}`,
      { state },
      { ...f.authorize(token), "if-match": `"${version}"` },
    );
  const stateOf = async () => {
    const listed = await f.app.inject({
      url: "/v1/integrations",
      headers: f.authorize(f.admin.token),
    });
    return listed.json().data.items.find((item: { id: string }) => item.id === created.id).state;
  };
  for (const state of ["paused", "revoked"]) {
    const refused = await patch(state, f.reader.token, 1);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("FORBIDDEN");
    expect(await stateOf()).toBe("active");
  }
  expect((await patch("paused", f.admin.token, 1)).statusCode).toBe(200);
  expect(await stateOf()).toBe("paused");
  expect((await patch("revoked", f.admin.token, 2)).statusCode).toBe(200);
  expect(await stateOf()).toBe("revoked");
});
