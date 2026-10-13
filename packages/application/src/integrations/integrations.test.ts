import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContractError,
  INBOUND_WEBHOOK_MAX_BYTES,
  type IntegrationInput,
  type IntegrationMetadata,
  routeCatalog,
  validate,
} from "@testmaster/contracts";
import { sha256 } from "@testmaster/domain";
import { afterEach, describe, expect, it } from "vitest";
import { Application } from "../application.js";
import type { ServiceContext } from "../context.js";
import {
  type DeliveryOutcome,
  type InboundOutcome,
  type InboundRequest,
  type IntegrationContext,
  type IntegrationProvider,
  IntegrationProviderRegistry,
  IntegrationsService,
  type TestDeliveryContext,
  verifyHmacSha256,
} from "./index.js";

interface Settings {
  installation: string;
  admin?: boolean;
}
interface Probe {
  parsed: number;
  tests: { context: TestDeliveryContext; integrationId: string }[];
  received: number;
  processed: string[];
  failNext: boolean;
  testOutcome: () => Promise<DeliveryOutcome> | DeliveryOutcome;
}
const secrets = ["current-secret", "previous-secret"];
const base = {
  id: "webhook",
  version: "1.4.2",
  schemaVersion: "1.0.0",
  capabilities: ["notifications", "inbound-events"],
  supportedEvents: ["run.completed", "push"],
} as const;

function sign(body: string, secret = secrets[0] as string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
/** Adapter defined by this file; the core ships none. Signature, schema and classification live here, as they do in a real adapter. */
function testProvider(
  probe: Probe,
  overrides: Partial<IntegrationProvider<Settings>> = {},
): IntegrationProvider<Settings> {
  return {
    ...base,
    parseSettings(input) {
      probe.parsed++;
      if (
        typeof input !== "object" ||
        input === null ||
        typeof (input as Settings).installation !== "string"
      )
        throw new ContractError("INVALID_ARGUMENT", "installation is required");
      const { installation, admin } = input as Settings;
      return { installation, ...(admin ? { admin } : {}) };
    },
    requiredScopes: (settings) => ["notify:post", ...(settings.admin ? ["notify:admin"] : [])],
    async sendTest(context, integration) {
      probe.tests.push({ context, integrationId: integration.id });
      return probe.testOutcome();
    },
    async receive(context: IntegrationContext, request: InboundRequest): Promise<InboundOutcome> {
      probe.received++;
      if (!verifyHmacSha256(request.headers["x-test-signature"], request.rawBody, secrets))
        throw new ContractError("UNAUTHENTICATED", "Invalid signature");
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(request.rawBody.toString("utf8"));
      } catch {
        throw new ContractError("INVALID_ARGUMENT", "Body is not JSON");
      }
      if (typeof body.installation !== "string" || typeof body.event !== "string")
        throw new ContractError("INVALID_ARGUMENT", "installation and event are required");
      const deliveryId = request.headers["x-test-delivery"] as string;
      const integration = context
        .findIntegrations("webhook")
        .find((item) => (item.settings as Settings).installation === body.installation);
      const action = typeof body.action === "string" ? body.action : null;
      const projectId = typeof body.project === "string" ? body.project : null;
      if (!integration)
        return {
          workspaceId: null,
          integrationId: null,
          deliveryId,
          installationKey: body.installation,
          projectId,
          eventType: body.event,
          action,
          disposition: "ignored",
          ignoredReason: "unknown_installation",
        };
      // Deliberately reports `accepted` whatever the stored state is: the core must decide, not the adapter.
      return {
        workspaceId: integration.workspaceId,
        integrationId: integration.id,
        deliveryId,
        installationKey: body.installation,
        projectId,
        eventType: body.event,
        action,
        disposition: "accepted",
        async process() {
          if (probe.failNext) {
            probe.failNext = false;
            throw new ContractError("UNAVAILABLE", "Downstream unavailable");
          }
          probe.processed.push(deliveryId);
          return { reference: `run-ref-${probe.processed.length}` };
        },
      };
    },
    ...overrides,
  };
}
function newProbe(): Probe {
  return {
    parsed: 0,
    tests: [],
    received: 0,
    processed: [],
    failNext: false,
    testOutcome: () => ({ state: "delivered", detail: "sent" }),
  };
}
function payload(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    installation: "inst-1",
    event: "run.completed",
    action: "done",
    ...fields,
  });
}
function delivery(
  body: string,
  deliveryId: string,
  headers: Record<string, string> = {},
): { headers: Record<string, string>; rawBody: Buffer } {
  return {
    headers: {
      "content-type": "application/json",
      "x-test-signature": sign(body),
      "x-test-delivery": deliveryId,
      ...headers,
    },
    rawBody: Buffer.from(body),
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Fixture {
  app: Application;
  service: IntegrationsService;
  registry: IntegrationProviderRegistry;
  probe: Probe;
  workspaceId: string;
  projectId: string;
  secretId: string;
  clock: { now: Date };
  input(overrides?: Partial<IntegrationInput>): IntegrationInput;
  rows(sql: string, ...params: unknown[]): Record<string, unknown>[];
  second(): {
    ctx: ServiceContext;
    service: IntegrationsService;
    secretId: string;
    projectId: string;
  };
}
async function fixture(
  options: { provider?: (probe: Probe) => IntegrationProvider<Settings> } = {},
): Promise<Fixture> {
  const cwd = await mkdtemp(join(tmpdir(), "tm-integrations-"));
  const app = await Application.open({ cwd, home: cwd });
  cleanups.push(async () => {
    app.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const init = await app.init();
  const secretId = `sec_${randomUUID()}`;
  app.context.entities.insert("SecretReference", {
    id: secretId,
    workspaceId: init.workspaceId,
    provider: "env",
    locator: "SLACK_TOKEN",
    secretVersion: 1,
    allowedOrigins: [],
    revokedAt: null,
  });
  const probe = newProbe();
  const registry = new IntegrationProviderRegistry();
  registry.register((options.provider ?? testProvider)(probe) as IntegrationProvider);
  const clock = { now: new Date("2026-10-13T10:00:00.000Z") };
  const service = new IntegrationsService(app.context, {
    providers: registry,
    now: () => clock.now,
  });
  return {
    app,
    service,
    registry,
    probe,
    workspaceId: init.workspaceId,
    projectId: init.projectId,
    secretId,
    clock,
    input: (overrides = {}) => ({
      provider: "webhook",
      name: `hook-${randomUUID().slice(0, 8)}`,
      projectIds: [init.projectId],
      events: ["run.completed"],
      consent: { scopes: ["notify:post"] },
      secretRefs: [secretId],
      settings: { installation: "inst-1" },
      ...overrides,
    }),
    rows: (sql, ...params) => app.database.all(sql, ...params),
    second() {
      const workspaceId = `ws_${randomUUID()}`;
      const principalId = `usr_${randomUUID()}`;
      const projectId = `prj_${randomUUID()}`;
      const otherSecret = `sec_${randomUUID()}`;
      app.database.withTx(() => {
        app.context.entities.insert("Workspace", {
          id: workspaceId,
          workspaceId,
          name: "Other workspace",
          mode: "single-user",
          settingsVersion: 1,
          quotaPolicyId: "local",
        });
        app.context.entities.insert("Principal", {
          id: principalId,
          workspaceId,
          kind: "human",
          displayName: "Other owner",
          disabledAt: null,
        });
        app.context.entities.insert("Project", {
          id: projectId,
          workspaceId,
          name: "Other project",
          slug: "other",
          defaultEnvironmentId: null,
          archivedAt: null,
        });
        app.context.entities.insert("SecretReference", {
          id: otherSecret,
          workspaceId,
          provider: "env",
          locator: "OTHER_TOKEN",
          secretVersion: 1,
          allowedOrigins: [],
          revokedAt: null,
        });
      });
      // Authorization is the owner's concern in these cases; the service's own tenant filter is under test.
      const ctx: ServiceContext = {
        ...app.context,
        workspaceId,
        principalId,
        authorize: () => undefined,
      };
      return {
        ctx,
        service: new IntegrationsService(ctx, { providers: registry, now: () => clock.now }),
        secretId: otherSecret,
        projectId,
      };
    },
  };
}
function codeOf(call: () => unknown): Promise<string | undefined> {
  return Promise.resolve()
    .then(call)
    .then(
      () => undefined,
      (error: unknown) => (error instanceof ContractError ? error.code : "NOT_A_CONTRACT_ERROR"),
    );
}

describe("INT-001 adapters are versioned, declare capabilities and speak the /v1 contract", () => {
  it("INT-001 an integration exposes its adapter version, schemaVersion and capabilities and validates against the /v1 contract", async () => {
    const f = await fixture();
    const created = f.service.create(f.input());
    expect(created.adapter).toEqual({
      id: "webhook",
      version: "1.4.2",
      schemaVersion: "1.0.0",
      capabilities: ["notifications", "inbound-events"],
    });
    expect(created.adapterStatus).toBe("compatible");
    validate("IntegrationMetadata", created);
    expect(f.service.get(created.id)).toEqual(created);
    expect(f.service.list().map((item) => item.id)).toEqual([created.id]);
  });

  it("INT-001 an integration whose adapter is not registered is described as unregistered and cannot run", async () => {
    const f = await fixture();
    const created = f.service.create(f.input());
    const bare = new IntegrationsService(f.app.context, {
      providers: new IntegrationProviderRegistry(),
    });
    const described = bare.get(created.id);
    expect(described.adapter).toBeNull();
    expect(described.adapterStatus).toBe("unregistered");
    expect(await codeOf(() => bare.test(created.id))).toBe("NOT_FOUND");
    expect(await codeOf(() => bare.create(f.input({ name: "other" })))).toBe("NOT_FOUND");
    expect(f.probe.tests).toHaveLength(0);
  });

  it("INT-001 an adapter built for another schemaVersion is refused with an update action before any adapter code runs", async () => {
    const stale = ["2.0.0", "0.9.0", "1.1.0"];
    for (const schemaVersion of stale) {
      const f = await fixture({
        provider: (probe) => testProvider(probe, { schemaVersion }),
      });
      const error = await Promise.resolve()
        .then(() => f.service.create(f.input()))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ContractError);
      expect((error as ContractError).code).toBe("PRECONDITION_FAILED");
      expect((error as ContractError).details).toMatchObject({
        provider: "webhook",
        adapterSchemaVersion: schemaVersion,
        coreSchemaVersion: "1.0.0",
        nextActions: ["update-adapter"],
      });
      const webhook = await codeOf(() =>
        f.service.receiveWebhook("webhook", delivery(payload(), "d-1")),
      );
      expect(webhook).toBe("PRECONDITION_FAILED");
      expect(f.probe.parsed).toBe(0);
      expect(f.probe.received).toBe(0);
      expect(f.rows("SELECT id FROM integrations")).toHaveLength(0);
    }
    const compatible = await fixture();
    expect(compatible.service.create(compatible.input()).adapterStatus).toBe("compatible");
  });

  it("INT-001 malformed adapter declarations are rejected at registration", async () => {
    const probe = newProbe();
    const registry = new IntegrationProviderRegistry();
    expect(() => registry.register(testProvider(probe, { capabilities: [] }) as never)).toThrow(
      "capability",
    );
    expect(() =>
      registry.register(testProvider(probe, { capabilities: ["Chat", "chat"] }) as never),
    ).toThrow("capability");
    expect(() => registry.register(testProvider(probe, { version: "latest" }) as never)).toThrow(
      "semver",
    );
    expect(registry.list()).toHaveLength(0);
    registry.register(testProvider(probe) as never);
    expect(() => registry.register(testProvider(probe) as never)).toThrow("already registered");
    expect(registry.list()).toHaveLength(1);
  });

  it("INT-001 adapter faults surface as structured errors and never leak adapter messages", async () => {
    const leak = "xoxb-super-secret-token";
    const f = await fixture({
      provider: (probe) =>
        testProvider(probe, {
          async receive() {
            throw new Error(`boom ${leak}`);
          },
        }),
    });
    const error = await f.service
      .receiveWebhook("webhook", delivery(payload(), "d-fault"))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).code).toBe("INTERNAL");
    expect((error as ContractError).details).toMatchObject({ reasonCode: "adapter_error" });
    expect(JSON.stringify(error) + String(error)).not.toContain(leak);
    const created = f.service.create(f.input());
    f.probe.testOutcome = () => {
      throw new Error(`boom ${leak}`);
    };
    const receipt = await f.service.test(created.id);
    expect(receipt.state).toBe("failed");
    expect(JSON.stringify(receipt)).not.toContain(leak);
    expect(await codeOf(() => f.service.create({ ...f.input(), settings: { nope: true } }))).toBe(
      "INVALID_ARGUMENT",
    );
    expect(await codeOf(() => f.service.create({ ...f.input(), bogus: 1 } as never))).toBe(
      "INVALID_ARGUMENT",
    );
  });

  it("INT-001 an outcome or disposition outside the contract is never read as delivered or accepted", async () => {
    const f = await fixture();
    const created = f.service.create(f.input());
    for (const state of ["passed", "success", "ok", undefined, 1]) {
      f.probe.testOutcome = () => ({ state }) as never;
      const receipt = await f.service.test(created.id);
      expect(receipt.state).toBe("failed");
      expect(receipt.detail).toBe("Adapter reported an unrecognized outcome");
    }
    const odd = await fixture({
      provider: (probe) =>
        testProvider(probe, {
          async receive(_context, request) {
            return {
              workspaceId: null,
              integrationId: null,
              deliveryId: request.headers["x-test-delivery"] as string,
              installationKey: null,
              projectId: null,
              eventType: "push",
              action: null,
              disposition: "passed",
            } as never;
          },
        }),
    });
    const error = await odd.service
      .receiveWebhook("webhook", delivery(payload(), "d-odd"))
      .catch((caught: unknown) => caught);
    expect((error as ContractError).code).toBe("INTERNAL");
    expect((error as ContractError).details).toMatchObject({
      reasonCode: "adapter_contract_violation",
      field: "disposition",
    });
    expect(odd.rows("SELECT id FROM inbound_webhook_deliveries")).toHaveLength(0);
  });
});

describe("INT-002 inbound idempotency is scoped, hashed and durable", () => {
  async function withIntegration(options: Parameters<typeof fixture>[0] = {}) {
    const f = await fixture(options);
    const created = f.service.create(f.input());
    return { f, created };
  }

  it("INT-002 a repeated delivery returns the original receipt reference and the handler runs once", async () => {
    const { f, created } = await withIntegration();
    const body = payload();
    const first = await f.service.receiveWebhook("webhook", delivery(body, "d-1"));
    expect(first).toMatchObject({
      outcome: "accepted",
      duplicate: false,
      reference: "run-ref-1",
      event: { eventId: "d-1", provider: "webhook", payloadHash: sha256(Buffer.from(body)) },
    });
    f.clock.now = new Date("2026-10-13T10:05:00.000Z");
    const second = await f.service.receiveWebhook("webhook", delivery(body, "d-1"));
    expect(second.duplicate).toBe(true);
    expect(second.reference).toBe("run-ref-1");
    expect(second.event).toEqual(first.event);
    expect(f.probe.processed).toEqual(["d-1"]);
    const records = f.rows("SELECT * FROM inbound_webhook_deliveries");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      workspace_id: f.workspaceId,
      integration_id: created.id,
      provider: "webhook",
      installation_key: "inst-1",
      event_type: "run.completed",
      action: "done",
      payload_sha256: sha256(Buffer.from(body)),
      outcome: "accepted",
    });
    validate("InboundWebhookReceipt", second);
    expect(f.service.inbound({ integrationId: created.id })).toHaveLength(1);
    expect(await codeOf(() => f.service.inbound({ limit: 101 }))).toBe("INVALID_ARGUMENT");
    // A different delivery of the same event type is a different event and is processed.
    await f.service.receiveWebhook("webhook", delivery(payload({ action: "again" }), "d-2"));
    expect(f.probe.processed).toEqual(["d-1", "d-2"]);
  });

  it("INT-002 the same delivery ID with a different payload is a tamper conflict recorded durably and never replaces the original", async () => {
    const { f } = await withIntegration();
    const original = await f.service.receiveWebhook("webhook", delivery(payload(), "d-1"));
    const tampered = payload({ note: "rewritten" });
    const error = await f.service
      .receiveWebhook("webhook", delivery(tampered, "d-1"))
      .catch((caught: unknown) => caught);
    expect((error as ContractError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((error as ContractError).details).toMatchObject({
      provider: "webhook",
      deliveryId: "d-1",
      reason: "tampered",
      originalReceipt: original.event.receiptRef,
    });
    expect(f.probe.processed).toEqual(["d-1"]);
    const outcomes = f
      .rows(
        "SELECT outcome,original_id,payload_sha256 FROM inbound_webhook_deliveries ORDER BY outcome",
      )
      .map((row) => `${String(row.outcome)}:${row.original_id === null ? "-" : "linked"}`);
    expect(outcomes).toEqual(["accepted:-", "tampered:linked"]);
    // The original is still replayable and a second tamper attempt is a second record, not a replacement.
    expect((await f.service.receiveWebhook("webhook", delivery(payload(), "d-1"))).duplicate).toBe(
      true,
    );
    await f.service.receiveWebhook("webhook", delivery(tampered, "d-1")).catch(() => undefined);
    expect(
      f.rows("SELECT id FROM inbound_webhook_deliveries WHERE outcome='tampered'"),
    ).toHaveLength(2);
    const audit = f.rows(
      "SELECT action FROM audit_events WHERE action LIKE 'integrations.webhook.%' ORDER BY created_at,id",
    );
    expect(audit.map((row) => row.action)).toContain("integrations.webhook.tampered");
    // Records are append-only evidence: the database refuses to rewrite the hash (even of a non-terminal
    // delivery) or to touch a tamper record.
    f.probe.failNext = true;
    await f.service
      .receiveWebhook("webhook", delivery(payload({ action: "other" }), "d-failed"))
      .catch(() => undefined);
    expect(() =>
      f.app.database.run(
        "UPDATE inbound_webhook_deliveries SET payload_sha256=? WHERE delivery_id='d-failed'",
        "0".repeat(64),
      ),
    ).toThrow("inbound_delivery_frozen");
    expect(() =>
      f.app.database.run(
        "UPDATE inbound_webhook_deliveries SET outcome='accepted' WHERE outcome='tampered'",
      ),
    ).toThrow();
  });

  it("INT-002 the same delivery ID with a different installation, project, event or action is a conflict even when the body is identical", async () => {
    const { f } = await withIntegration();
    const body = payload({ project: "p1" });
    await f.service.receiveWebhook("webhook", delivery(body, "d-1"));
    // Same bytes, but the adapter classifies them under another scope.
    const scopes: Partial<InboundOutcome>[] = [
      { installationKey: "inst-other" },
      { projectId: "p2" },
      { eventType: "push" },
      { action: "other" },
    ];
    for (const change of scopes) {
      const g = await fixture({
        provider: (probe) => {
          const real = testProvider(probe);
          return {
            ...real,
            async receive(context, request) {
              const outcome = await (real.receive as NonNullable<typeof real.receive>)(
                context,
                request,
              );
              return request.headers["x-test-variant"] ? { ...outcome, ...change } : outcome;
            },
          };
        },
      });
      g.service.create(g.input());
      await g.service.receiveWebhook("webhook", delivery(body, "d-1"));
      const code = await codeOf(() =>
        g.service.receiveWebhook("webhook", delivery(body, "d-1", { "x-test-variant": "1" })),
      );
      expect(code).toBe("IDEMPOTENCY_CONFLICT");
      // Control: the identical classification is a plain duplicate.
      expect((await g.service.receiveWebhook("webhook", delivery(body, "d-1"))).duplicate).toBe(
        true,
      );
    }
  });

  it("INT-002 dedupe is scoped per workspace: another workspace's identical delivery ID is independent and invisible", async () => {
    const { f, created } = await withIntegration();
    const other = f.second();
    const otherIntegration = other.service.create({
      ...f.input({ name: "other-hook" }),
      projectIds: [other.projectId],
      secretRefs: [other.secretId],
      settings: { installation: "inst-2" },
    });
    const a = await f.service.receiveWebhook("webhook", delivery(payload(), "shared-id"));
    const b = await f.service.receiveWebhook(
      "webhook",
      delivery(payload({ installation: "inst-2" }), "shared-id"),
    );
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(false);
    expect(a.event.receiptRef).not.toBe(b.event.receiptRef);
    expect(f.probe.processed).toEqual(["shared-id", "shared-id"]);
    expect(f.service.inbound().map((row) => row.integrationId)).toEqual([created.id]);
    expect(other.service.inbound().map((row) => row.integrationId)).toEqual([otherIntegration.id]);
    expect(await codeOf(() => f.service.get(otherIntegration.id))).toBe("NOT_FOUND");
    expect(other.service.list().map((item) => item.id)).toEqual([otherIntegration.id]);
  });

  it("INT-002 a failed handler can be redelivered, an in-flight delivery cannot, and an abandoned one is reclaimed", async () => {
    const { f, created } = await withIntegration();
    const body = payload();
    f.probe.failNext = true;
    expect(await codeOf(() => f.service.receiveWebhook("webhook", delivery(body, "d-1")))).toBe(
      "UNAVAILABLE",
    );
    expect(f.rows("SELECT outcome,error_code,attempts FROM inbound_webhook_deliveries")).toEqual([
      { outcome: "failed", error_code: "UNAVAILABLE", attempts: 1 },
    ]);
    const retried = await f.service.receiveWebhook("webhook", delivery(body, "d-1"));
    expect(retried).toMatchObject({ outcome: "accepted", duplicate: false });
    expect(f.rows("SELECT attempts FROM inbound_webhook_deliveries")).toEqual([{ attempts: 2 }]);
    expect(f.probe.processed).toEqual(["d-1"]);
    // Simulate a crash after first sight: only a `received` row exists for the delivery.
    const stamp = "2026-10-13T10:00:30.000Z";
    f.app.database.run("DELETE FROM inbound_webhook_deliveries");
    f.app.database.run(
      "INSERT INTO inbound_webhook_deliveries(id,workspace_id,created_at,version,provider,delivery_id,integration_id,installation_key,project_id,event_type,action,payload_sha256,outcome,received_at,updated_at) VALUES(?,?,?,1,'webhook','d-1',?,'inst-1','','run.completed','done',?,'received',?,?)",
      `iwd_${randomUUID()}`,
      f.workspaceId,
      stamp,
      created.id,
      sha256(Buffer.from(body)),
      stamp,
      stamp,
    );
    f.clock.now = new Date("2026-10-13T10:01:00.000Z");
    const inflight = await f.service.receiveWebhook("webhook", delivery(body, "d-1"));
    expect(inflight).toMatchObject({ outcome: "received", duplicate: true });
    expect(f.probe.processed).toEqual(["d-1"]);
    f.app.database.run(
      "UPDATE inbound_webhook_deliveries SET updated_at='2026-10-13T09:00:00.000Z'",
    );
    const reclaimed = await f.service.receiveWebhook("webhook", delivery(body, "d-1"));
    expect(reclaimed).toMatchObject({ outcome: "accepted", duplicate: false });
    expect(f.probe.processed).toEqual(["d-1", "d-1"]);
  });

  it("INT-002 content type, size, signature and schema are all checked before any dedupe record exists", async () => {
    const { f } = await withIntegration();
    const count = () => f.rows("SELECT id FROM inbound_webhook_deliveries").length;
    const body = payload();
    const good = delivery(body, "d-1");
    expect(
      await codeOf(() =>
        f.service.receiveWebhook("webhook", {
          ...good,
          headers: { ...good.headers, "content-type": "text/plain" },
        }),
      ),
    ).toBe("INVALID_ARGUMENT");
    expect(
      await codeOf(() =>
        f.service.receiveWebhook("webhook", {
          ...good,
          headers: { ...good.headers, "Content-Type": "application/x-www-form-urlencoded" },
        }),
      ),
    ).toBe("INVALID_ARGUMENT");
    expect(f.probe.received).toBe(0);
    expect(
      await codeOf(() =>
        f.service.receiveWebhook("webhook", {
          headers: good.headers,
          rawBody: Buffer.alloc(INBOUND_WEBHOOK_MAX_BYTES + 1, 0x20),
        }),
      ),
    ).toBe("PAYLOAD_TOO_LARGE");
    expect(f.probe.received).toBe(0);
    expect(
      await codeOf(() =>
        f.service.receiveWebhook(
          "webhook",
          delivery(body, "d-1", { "x-test-signature": sign(body, "wrong") }),
        ),
      ),
    ).toBe("UNAUTHENTICATED");
    const unsignedSchema = "{}";
    expect(
      await codeOf(() => f.service.receiveWebhook("webhook", delivery(unsignedSchema, "d-1"))),
    ).toBe("INVALID_ARGUMENT");
    expect(f.probe.received).toBe(2);
    expect(count()).toBe(0);
    expect(f.probe.processed).toEqual([]);
    // Control: the same request with a charset parameter, a mixed-case header name and a valid signature is admitted.
    const ok = await f.service.receiveWebhook("webhook", {
      rawBody: good.rawBody,
      headers: {
        ...good.headers,
        "Content-Type": "Application/JSON; charset=utf-8",
        "content-type": "text/plain",
      },
    });
    expect(ok.outcome).toBe("accepted");
    expect(count()).toBe(1);
    // Provider-less and unknown providers are structured refusals.
    expect(await codeOf(() => f.service.receiveWebhook("github", good))).toBe("NOT_FOUND");
    expect(f.probe.processed).toEqual(["d-1"]);
  });

  it("INT-002 a paused or revoked integration never processes a delivery even when the adapter accepts it", async () => {
    const { f, created } = await withIntegration();
    const paused = f.service.pause(created.id, created.version);
    const receipt = await f.service.receiveWebhook("webhook", delivery(payload(), "d-1"));
    expect(receipt).toMatchObject({ outcome: "ignored", ignoredReason: "paused_integration" });
    const resumed = f.service.update(created.id, { state: "active" }, paused.version);
    f.service.revoke(created.id, resumed.version);
    const revoked = await f.service.receiveWebhook(
      "webhook",
      delivery(payload({ action: "x" }), "d-2"),
    );
    expect(revoked).toMatchObject({ outcome: "ignored", ignoredReason: "revoked_integration" });
    expect(f.probe.processed).toEqual([]);
    // Control: an active integration processes.
    const active = await fixture();
    active.service.create(active.input());
    expect(
      (await active.service.receiveWebhook("webhook", delivery(payload(), "d-3"))).outcome,
    ).toBe("accepted");
  });

  it("INT-002 an unknown installation is recorded unattributed, deduplicated, invisible to tenants and creates no work", async () => {
    const { f } = await withIntegration();
    const body = payload({ installation: "ghost" });
    const first = await f.service.receiveWebhook("webhook", delivery(body, "d-1"));
    expect(first).toMatchObject({ outcome: "ignored", ignoredReason: "unknown_installation" });
    expect((await f.service.receiveWebhook("webhook", delivery(body, "d-1"))).duplicate).toBe(true);
    expect(
      await codeOf(() =>
        f.service.receiveWebhook(
          "webhook",
          delivery(payload({ installation: "ghost", action: "z" }), "d-1"),
        ),
      ),
    ).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      f.rows(
        "SELECT workspace_id,outcome FROM inbound_webhook_deliveries WHERE outcome<>'tampered'",
      ),
    ).toEqual([{ workspace_id: null, outcome: "ignored" }]);
    expect(f.service.inbound()).toEqual([]);
    expect(f.probe.processed).toEqual([]);
    expect(f.rows("SELECT id FROM runs")).toHaveLength(0);
  });

  it("INT-002 an adapter cannot accept a delivery for an integration the workspace does not own", async () => {
    const { f } = await withIntegration();
    const g = await fixture({
      provider: (probe) => {
        const real = testProvider(probe);
        return {
          ...real,
          async receive(context, request) {
            const outcome = await (real.receive as NonNullable<typeof real.receive>)(
              context,
              request,
            );
            return { ...outcome, integrationId: `int_${randomUUID()}` };
          },
        };
      },
    });
    g.service.create(g.input());
    expect(
      await codeOf(() => g.service.receiveWebhook("webhook", delivery(payload(), "d-1"))),
    ).toBe("INTERNAL");
    expect(g.rows("SELECT id FROM inbound_webhook_deliveries")).toHaveLength(0);
    expect(f.probe.processed).toEqual([]);
  });

  it("INT-002 signatures verify against either secret during rotation and reject tampered or malformed values", () => {
    const body = Buffer.from('{"a":1}');
    expect(verifyHmacSha256(sign(body.toString(), "current-secret"), body, secrets)).toBe(true);
    expect(verifyHmacSha256(sign(body.toString(), "previous-secret"), body, secrets)).toBe(true);
    expect(verifyHmacSha256(sign(body.toString(), "retired-secret"), body, secrets)).toBe(false);
    expect(
      verifyHmacSha256(sign(body.toString(), "current-secret"), Buffer.from('{"a":2}'), secrets),
    ).toBe(false);
    expect(verifyHmacSha256(undefined, body, secrets)).toBe(false);
    expect(verifyHmacSha256("sha256=zz", body, secrets)).toBe(false);
    expect(verifyHmacSha256(sign(body.toString()).replace("sha256=", "sha1="), body, secrets)).toBe(
      false,
    );
    expect(verifyHmacSha256(sign(body.toString()), body, [])).toBe(false);
  });
});

describe("INT-004 integrations need scope consent and test deliveries are labelled", () => {
  it("INT-004 creating an integration without consent for every required scope is refused and stores nothing", async () => {
    const f = await fixture();
    const missing = await Promise.resolve()
      .then(() => f.service.create(f.input({ settings: { installation: "inst-1", admin: true } })))
      .catch((caught: unknown) => caught);
    expect((missing as ContractError).code).toBe("PRECONDITION_FAILED");
    expect((missing as ContractError).details).toMatchObject({
      missingScopes: ["notify:admin"],
      nextActions: ["grant-consent"],
    });
    expect(await codeOf(() => f.service.create(f.input({ consent: { scopes: [] } })))).toBe(
      "PRECONDITION_FAILED",
    );
    expect(f.rows("SELECT id FROM integrations")).toHaveLength(0);
    const granted = f.service.create(
      f.input({
        settings: { installation: "inst-1", admin: true },
        consent: { scopes: ["notify:post", "notify:admin", "extra"] },
      }),
    );
    expect(granted.consent).toMatchObject({
      scopes: ["notify:post", "notify:admin", "extra"],
      grantedBy: f.app.context.principalId,
      grantedAt: "2026-10-13T10:00:00.000Z",
    });
    expect(granted.state).toBe("active");
  });

  it("INT-004 widening settings or resuming re-checks consent against what the adapter now requires", async () => {
    const f = await fixture();
    const created = f.service.create(f.input());
    expect(
      await codeOf(() =>
        f.service.update(
          created.id,
          { settings: { installation: "inst-1", admin: true } },
          created.version,
        ),
      ),
    ).toBe("PRECONDITION_FAILED");
    expect(f.service.get(created.id).version).toBe(created.version);
    const widened = f.service.update(
      created.id,
      {
        settings: { installation: "inst-1", admin: true },
        consent: { scopes: ["notify:post", "notify:admin"] },
      },
      created.version,
    );
    expect(widened.version).toBe(created.version + 1);
    expect((widened.settings as Settings).admin).toBe(true);
    expect(widened.consent.grantedAt).toBe("2026-10-13T10:00:00.000Z");
    // Consent that no longer covers the settings cannot be kept by narrowing it silently.
    expect(
      await codeOf(() =>
        f.service.update(created.id, { consent: { scopes: ["notify:post"] } }, widened.version),
      ),
    ).toBe("PRECONDITION_FAILED");
  });

  it("INT-004 revoking ends access with no fallback: no consent, no secrets, no test, no update, no reactivation", async () => {
    const f = await fixture();
    const created = f.service.create(f.input());
    const revoked = f.service.revoke(created.id, created.version);
    expect(revoked).toMatchObject({ state: "revoked", secretRefs: [] });
    expect(revoked.consent.scopes).toEqual([]);
    expect(await codeOf(() => f.service.test(created.id))).toBe("PRECONDITION_FAILED");
    expect(f.probe.tests).toHaveLength(0);
    expect(
      await codeOf(() => f.service.update(created.id, { name: "renamed" }, revoked.version)),
    ).toBe("PRECONDITION_FAILED");
    expect(
      await codeOf(() => f.service.update(created.id, { state: "active" }, revoked.version)),
    ).toBe("PRECONDITION_FAILED");
    expect(() =>
      f.app.database.run("UPDATE integrations SET state='active' WHERE id=?", created.id),
    ).toThrow();
    expect(f.service.get(created.id).state).toBe("revoked");
    const paused = await fixture();
    const other = paused.service.create(paused.input());
    paused.service.pause(other.id, other.version);
    expect(await codeOf(() => paused.service.test(other.id))).toBe("PRECONDITION_FAILED");
  });

  it("INT-004 a test delivery is labelled, carries the test marker and never becomes a delivery, Run or event of record", async () => {
    const f = await fixture();
    const created = f.service.create(f.input());
    const before = ["deliveries", "runs", "outbox", "inbound_webhook_deliveries"].map(
      (table) => f.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n,
    );
    const receipt = await f.service.test(created.id);
    expect(receipt).toMatchObject({
      integrationId: created.id,
      test: true,
      label: "test notification",
      state: "delivered",
      detail: "sent",
    });
    validate("IntegrationTestReceipt", receipt);
    expect(f.probe.tests).toHaveLength(1);
    expect(f.probe.tests[0]?.context.test).toEqual({
      test: true,
      deliveryId: receipt.deliveryId,
      label: "test notification",
    });
    expect(f.probe.tests[0]?.context.workspaceId).toBe(f.workspaceId);
    const after = ["deliveries", "runs", "outbox", "inbound_webhook_deliveries"].map(
      (table) => f.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n,
    );
    expect(after).toEqual(before);
    const stored = f.service.get(created.id);
    expect(stored.lastTest).toMatchObject({ deliveryId: receipt.deliveryId, state: "delivered" });
    expect(stored.version).toBe(created.version + 1);
    expect(
      f.rows("SELECT action FROM audit_events WHERE action='integrations.test.allowed'"),
    ).toHaveLength(1);
    // A failing test is reported as failed and stays labelled; it does not change the integration state.
    f.probe.testOutcome = () => ({ state: "rejected", detail: "x".repeat(900) });
    const failed = await f.service.test(created.id);
    expect(failed).toMatchObject({ test: true, label: "test notification", state: "rejected" });
    expect(failed.detail).toHaveLength(500);
    expect(f.service.get(created.id).state).toBe("active");
  });

  it("INT-004 only an administrator of the workspace may configure, list or test an integration", async () => {
    const f = await fixture();
    const created = f.service.create(f.input());
    for (const scopes of [["R"], ["R", "W", "X"]] as const) {
      const limited = f.app.withIdentity({
        principalId: f.app.context.principalId,
        scopes: [...scopes],
      });
      const service = new IntegrationsService(limited.context, { providers: f.registry });
      expect(await codeOf(() => service.create(f.input({ name: "denied" })))).toBe("FORBIDDEN");
      expect(await codeOf(() => service.list())).toBe("FORBIDDEN");
      expect(await codeOf(() => service.get(created.id))).toBe("FORBIDDEN");
      expect(await codeOf(() => service.update(created.id, { name: "x" }, created.version))).toBe(
        "FORBIDDEN",
      );
      expect(await codeOf(() => service.test(created.id))).toBe("FORBIDDEN");
    }
    expect(f.probe.tests).toHaveLength(0);
    expect(f.service.list()).toHaveLength(1);
    const admin = f.app.withIdentity({
      principalId: f.app.context.principalId,
      scopes: ["R", "A"],
    });
    expect(new IntegrationsService(admin.context, { providers: f.registry }).list()).toHaveLength(
      1,
    );
  });

  it("INT-004 projects and secrets of another workspace, archived projects and revoked secrets cannot be bound", async () => {
    const f = await fixture();
    const other = f.second();
    expect(await codeOf(() => f.service.create(f.input({ projectIds: [other.projectId] })))).toBe(
      "NOT_FOUND",
    );
    expect(await codeOf(() => f.service.create(f.input({ secretRefs: [other.secretId] })))).toBe(
      "NOT_FOUND",
    );
    f.app.database.run(
      "UPDATE secret_references SET revoked_at=? WHERE id=?",
      "2026-10-13T09:00:00.000Z",
      f.secretId,
    );
    expect(await codeOf(() => f.service.create(f.input()))).toBe("NOT_FOUND");
    expect(f.rows("SELECT id FROM integrations")).toHaveLength(0);
    f.app.database.run("UPDATE secret_references SET revoked_at=NULL WHERE id=?", f.secretId);
    expect(f.service.create(f.input()).secretRefs).toEqual([f.secretId]);
  });

  it("INT-004 optimistic versions and unique names guard configuration changes", async () => {
    const f = await fixture();
    const created = f.service.create(f.input({ name: "primary" }));
    expect(
      await codeOf(() => f.service.update(created.id, { name: "x" }, created.version + 1)),
    ).toBe("REVISION_CONFLICT");
    expect(
      await codeOf(() => f.service.update(created.id, { name: "x" }, undefined as never)),
    ).toBe("PRECONDITION_REQUIRED");
    expect(await codeOf(() => f.service.create(f.input({ name: "primary" })))).toBe(
      "INVALID_ARGUMENT",
    );
    const second = f.service.create(f.input({ name: "secondary" }));
    expect(
      await codeOf(() => f.service.update(second.id, { name: "primary" }, second.version)),
    ).toBe("INVALID_ARGUMENT");
    expect(
      await codeOf(() =>
        f.service.update(second.id, { events: ["unknown.event"] }, second.version),
      ),
    ).toBe("INVALID_ARGUMENT");
    expect(await codeOf(() => f.service.update(`int_${randomUUID()}`, { name: "z" }, 1))).toBe(
      "NOT_FOUND",
    );
    const renamed = f.service.update(second.id, { name: "renamed" }, second.version);
    expect(renamed).toMatchObject({ name: "renamed", version: second.version + 1 });
    // Control: the provider and workspace are immutable at the database.
    expect(() =>
      f.app.database.run("UPDATE integrations SET provider='slack' WHERE id=?", second.id),
    ).toThrow();
    const typed: IntegrationMetadata = renamed;
    expect(typed.provider).toBe("webhook");
  });
});

describe("INT-001 surface catalog", () => {
  it("INT-001 integration routes are declared under /v1 with distinct request and response contracts", () => {
    const rows = routeCatalog.filter((route) => route.path.startsWith("/integrations"));
    expect(rows.map((route) => `${route.method} ${route.path} ${route.scope}`).sort()).toEqual([
      "GET /integrations integrations:A",
      "PATCH /integrations/{id} integrations:A",
      "POST /integrations integrations:A",
      "POST /integrations/{id}/test integrations:A",
      "POST /integrations/{provider}/webhooks signature",
    ]);
    const patch = rows.find((route) => route.method === "PATCH");
    expect(patch).toMatchObject({
      requestSchema: "IntegrationPatchInput",
      responseSchema: "IntegrationMetadata",
    });
    expect(rows.find((route) => route.path.endsWith("/webhooks"))).toMatchObject({
      requestSchema: "InboundWebhookBody",
      responseSchema: "InboundWebhookReceipt",
    });
  });
});
