import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError, type IntegrationInput } from "@testmaster/contracts";
import { createTestDatabase, type TestDatabase } from "@testmaster/persistence/testing";
import { afterEach, beforeAll, expect, it } from "vitest";
import {
  Application,
  authenticateBearer,
  authenticateSession,
  type ServerConfig,
} from "../index.js";
import {
  type InboundOutcome,
  type IntegrationProvider,
  integrationProviders,
  verifyHmacSha256,
} from "./index.js";

const secret = "pg-test-secret";
const password = "correct horse battery staple";
const processed: string[] = [];
const visibleToTest: number[] = [];
const provider: IntegrationProvider<{ installation: string }> = {
  id: "webhook",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  capabilities: ["inbound-events"],
  parseSettings(input) {
    if (typeof input !== "object" || input === null || !("installation" in input))
      throw new ContractError("INVALID_ARGUMENT", "installation is required");
    return { installation: String(input.installation) };
  },
  requiredScopes: () => [],
  async sendTest(context) {
    visibleToTest.push(context.findIntegrations("webhook").length);
    return { state: "delivered" };
  },
  async receive(context, request): Promise<InboundOutcome> {
    if (!verifyHmacSha256(request.headers["x-test-signature"], request.rawBody, [secret]))
      throw new ContractError("UNAUTHENTICATED", "Invalid signature");
    const body = JSON.parse(request.rawBody.toString("utf8")) as { installation: string };
    const deliveryId = request.headers["x-test-delivery"] as string;
    const found = context
      .findIntegrations("webhook")
      .find((item) => item.settings.installation === body.installation);
    const common = {
      deliveryId,
      installationKey: body.installation,
      projectId: null,
      eventType: "push",
      action: null,
    };
    if (!found)
      return {
        ...common,
        workspaceId: null,
        integrationId: null,
        disposition: "ignored",
        ignoredReason: "unknown_installation",
      };
    return {
      ...common,
      workspaceId: found.workspaceId,
      integrationId: found.id,
      disposition: "accepted",
      async process() {
        processed.push(`${found.workspaceId}:${deliveryId}`);
        return { reference: `ref-${processed.length}` };
      },
    };
  },
};
beforeAll(() => integrationProviders.register(provider as IntegrationProvider));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  processed.length = 0;
  visibleToTest.length = 0;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const sign = (body: string | Buffer, key = secret) =>
  `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
const request = (body: string, deliveryId: string) => ({
  headers: {
    "content-type": "application/json",
    "x-test-signature": sign(body),
    "x-test-delivery": deliveryId,
  },
  rawBody: Buffer.from(body),
});

/** Two tenants in one PostgreSQL database, each with an owner session and one integration. */
async function twoTenants() {
  const database: TestDatabase = await createTestDatabase();
  cleanups.push(() => database.drop());
  const root = await mkdtemp(join(tmpdir(), "tm-integrations-pg-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(home);
  const server: ServerConfig = {
    mode: "server",
    database: { engine: "postgres", ...database.config },
    storage: { kind: "filesystem", root: join(root, "evidence") },
    server: {
      listen: { host: "127.0.0.1", port: 0 },
      publicOrigin: "https://tm.example",
      trustedProxies: [],
      origins: ["https://tm.example"],
    },
    security: {
      masterKeyFile: join(root, "master.key"),
      backupKeyFile: join(root, "backup.key"),
      atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
    },
  };
  const application = await Application.open({ cwd: root, home, env: {}, server });
  cleanups.push(() => application.close());
  const first = application.operator.bootstrap({ workspaceName: "Acme", ownerLogin: "acme-owner" });
  const operator = application.forIdentity(
    authenticateBearer(application, application.operator.operatorToken().token),
  );
  const second = operator.workspaces.create({ name: "Globex", ownerLogin: "globex-owner" });
  const tenant = async (
    login: string,
    recoveryToken: string,
    workspaceId: string,
    installation: string,
  ) => {
    await application.identityService.recover({
      principal: login,
      recoveryToken,
      newPassword: password,
    });
    const session = authenticateSession(
      application,
      (await application.identityService.login({ principal: login, password })).sessionToken,
    );
    const scoped = application.forIdentity(session);
    const project = scoped.projects.create({ name: `${login}-project` });
    const input: IntegrationInput = {
      provider: "webhook",
      name: `${login}-hook`,
      projectIds: [project.id],
      events: [],
      consent: { scopes: [] },
      secretRefs: [],
      settings: { installation },
    };
    return { workspaceId, scoped, integration: scoped.integrations.create(input) };
  };
  const a = await tenant(
    "acme-owner",
    first.ownerRecovery.recoveryToken,
    String(first.workspace.id),
    "inst-a",
  );
  const b = await tenant(
    "globex-owner",
    second.ownerRecovery.recoveryToken,
    String(second.workspace.id),
    "inst-b",
  );
  return { application, a, b };
}

it("INT-001 INT-002 PostgreSQL intake resolves the installation across tenants, dedupes per workspace and records tampering", async () => {
  const { application, a, b } = await twoTenants();
  const intake = application.controllerScope().integrations;
  const bodyA = JSON.stringify({ installation: "inst-a" });
  const first = await intake.receiveWebhook("webhook", request(bodyA, "d-1"));
  expect(first).toMatchObject({ outcome: "accepted", duplicate: false });
  expect(processed).toEqual([`${a.workspaceId}:d-1`]);
  // The same delivery ID in another tenant is its own delivery, not a duplicate of A's.
  const bodyB = JSON.stringify({ installation: "inst-b" });
  expect(await intake.receiveWebhook("webhook", request(bodyB, "d-1"))).toMatchObject({
    outcome: "accepted",
    duplicate: false,
  });
  expect(processed).toEqual([`${a.workspaceId}:d-1`, `${b.workspaceId}:d-1`]);
  // A replay of A's bytes is answered from the record and does not process again.
  expect(await intake.receiveWebhook("webhook", request(bodyA, "d-1"))).toMatchObject({
    duplicate: true,
    reference: first.reference,
  });
  expect(processed).toHaveLength(2);
  // Different bytes under A's delivery ID are tampering and process nothing.
  await expect(
    intake.receiveWebhook(
      "webhook",
      request(JSON.stringify({ installation: "inst-a", x: 1 }), "d-1"),
    ),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(processed).toHaveLength(2);
  // Concurrent first-sight deliveries of one ID process exactly once.
  const racing = request(bodyA, "d-race");
  const results = await Promise.all([
    intake.receiveWebhook("webhook", racing),
    intake.receiveWebhook("webhook", racing),
    intake.receiveWebhook("webhook", racing),
  ]);
  expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
  expect(processed.filter((entry) => entry.endsWith("d-race"))).toHaveLength(1);
  // An unknown installation is recorded without a workspace and creates nothing.
  expect(
    await intake.receiveWebhook(
      "webhook",
      request(JSON.stringify({ installation: "ghost" }), "d-ghost"),
    ),
  ).toMatchObject({ outcome: "ignored" });
  expect(processed.filter((entry) => entry.endsWith("d-ghost"))).toEqual([]);
  // A bad signature is refused and records nothing.
  const before = application.database.all("SELECT id FROM inbound_webhook_deliveries").length;
  await expect(
    intake.receiveWebhook("webhook", {
      ...request(bodyA, "d-bad"),
      headers: { ...request(bodyA, "d-bad").headers, "x-test-signature": sign(bodyA, "wrong") },
    }),
  ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  expect(application.database.all("SELECT id FROM inbound_webhook_deliveries").length).toBe(before);
});

it("INT-001 INT-002 PostgreSQL row-level security hides one tenant's integrations and deliveries from another", async () => {
  const { application, a, b } = await twoTenants();
  const intake = application.controllerScope().integrations;
  await intake.receiveWebhook(
    "webhook",
    request(JSON.stringify({ installation: "inst-a" }), "d-a"),
  );
  await intake.receiveWebhook(
    "webhook",
    request(JSON.stringify({ installation: "inst-b" }), "d-b"),
  );
  await intake.receiveWebhook(
    "webhook",
    request(JSON.stringify({ installation: "ghost" }), "d-ghost"),
  );
  // Raw SQL through a workspace-scoped connection sees only that workspace's rows.
  for (const [own, other] of [
    [a, b],
    [b, a],
  ] as const) {
    const scoped = application.database.forWorkspace(own.workspaceId);
    expect(scoped.all("SELECT id FROM integrations").map((row) => row.id)).toEqual([
      own.integration.id,
    ]);
    expect(scoped.all("SELECT id FROM integrations WHERE id=?", other.integration.id)).toEqual([]);
    const deliveries = scoped.all("SELECT workspace_id FROM inbound_webhook_deliveries");
    expect(deliveries).toEqual([{ workspace_id: own.workspaceId }]);
  }
  // The controller scope (and only it) sees both tenants and the unattributed record.
  expect(application.database.all("SELECT id FROM integrations")).toHaveLength(2);
  expect(application.database.all("SELECT id FROM inbound_webhook_deliveries")).toHaveLength(3);
  // Services bound to a tenant cannot read, change or test the other tenant's integration.
  expect(a.scoped.integrations.list().map((item) => item.id)).toEqual([a.integration.id]);
  expect(a.scoped.integrations.inbound().map((row) => row.deliveryId)).toEqual(["d-a"]);
  expect(() => a.scoped.integrations.get(b.integration.id)).toThrowError(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  expect(() =>
    a.scoped.integrations.update(b.integration.id, { name: "taken" }, b.integration.version),
  ).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  await expect(a.scoped.integrations.test(b.integration.id)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(visibleToTest).toEqual([]);
  // The row-level policy hides the other tenant's row from writes, so the update matches nothing.
  const attacker = application.database.forWorkspace(a.workspaceId);
  expect(
    attacker.run("UPDATE integrations SET name='hijacked' WHERE id=?", b.integration.id).changes,
  ).toBe(0);
  expect(b.scoped.integrations.get(b.integration.id).name).toBe("globex-owner-hook");
  // A test delivery only ever resolves its own workspace's integrations.
  await a.scoped.integrations.test(a.integration.id);
  expect(visibleToTest).toEqual([1]);
});
