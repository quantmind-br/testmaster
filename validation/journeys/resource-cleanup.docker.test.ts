import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { type ExecutablePlan, validate } from "@testmaster/contracts";
import { expect, it } from "vitest";
import { controlledShop, items, Journey, object, text } from "./harness.js";

it("manually compensates an orphan through the sandbox and preserves the owning run verdict", async () => {
  const session = await Journey.create("W4-A-resource-cleanup");
  const shop = await controlledShop();
  let interruptDelete = true;
  let deletedRequests = 0;
  const proxy = createServer((incoming, outgoing) => {
    if (incoming.method === "DELETE" && interruptDelete) {
      deletedRequests++;
      return;
    }
    const upstream = request(
      new URL(incoming.url ?? "/", shop.url),
      { method: incoming.method, headers: incoming.headers },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let error: unknown;
  try {
    await session.init(baseUrl);
    const login = await fetch(`${shop.shop.url}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "demo@example.test", password: "correct-password" }),
    });
    const bearer = text(object(await login.json()).token);
    const secret = await session.command(
      ["secret", "set", "cleanup-auth", "--from-env", "CLEANUP_AUTH", "--allowed-origin", baseUrl],
      0,
      { CLEANUP_AUTH: `Bearer ${bearer}` },
    );
    const email = `cleanup-${randomUUID()}@example.test`;
    const plan = validate<ExecutablePlan>("ExecutablePlan", {
      schemaVersion: "1.0.0",
      kind: "executable",
      name: "Create an owned cleanup fixture",
      type: "backend",
      runner: "http",
      requirementRefs: [],
      steps: [
        {
          id: "create",
          kind: "action",
          operation: "request",
          description: "Create owned test user",
          required: true,
          input: {
            method: "POST",
            pathSegments: [{ literal: "api" }, { literal: "users" }],
            headers: { Authorization: { secretRef: text(secret.id) } },
            body: { kind: "json", value: { literal: { email, password: "temporary-password" } } },
            resource: {
              resourceType: "user",
              correlationKey: { literal: email },
              handle: "/id",
              ownerProof: "/email",
            },
          },
        },
        {
          id: "created",
          kind: "assertion",
          operation: "assert",
          description: "Verify creation",
          required: true,
          input: { responseStepId: "create" },
          expectation: { predicate: "statusIn", values: [201] },
        },
      ],
      cleanup: [
        {
          resourceRef: "create",
          operation: "request",
          input: {
            method: "DELETE",
            headers: { Authorization: { secretRef: text(secret.id) } },
            pathSegments: [
              { literal: "api" },
              { literal: "users" },
              { variableRef: "create.handle" },
            ],
          },
          successPredicate: { predicate: "statusIn", values: [200] },
          deadlineMs: 500,
          required: true,
        },
      ],
    });
    const test = await session.createTest(plan);
    const failed = await session.command(["test", "run", text(test.id), "--wait"], 1);
    const execution = object(failed.data);
    const runId = text(object(execution.receipt).runId);
    session.recordIds(runId);
    expect(deletedRequests).toBeGreaterThan(0);
    const oracle = new DatabaseSync(shop.shop.dbPath, { readOnly: true });
    const before = oracle.prepare("SELECT id FROM users WHERE email=?").get(email);
    expect(before).toBeDefined();
    const inventory = await session.command(["resource", "list", "--run", runId]);
    const resource = items(inventory.items)[0];
    if (!resource) throw new Error("Missing orphan resource");
    expect(resource.state).toBe("orphaned");
    const approvalSpec = object(resource.cleanupApproval);
    const approval = await session.command([
      "approval",
      "create",
      "--action",
      text((approvalSpec.actionSet as string[])[0]),
      "--revision-hash",
      text(approvalSpec.revisionHash),
      "--environment-revision",
      text(approvalSpec.environmentRevisionId),
      "--origin",
      baseUrl,
      "--policy-hash",
      text(approvalSpec.policyHash),
    ]);
    interruptDelete = false;
    proxy.closeAllConnections();
    const key = randomUUID();
    const cleanup = await session.command([
      "resource",
      "cleanup",
      text(resource.id),
      "--approval",
      text(approval.id),
      "--expected-version",
      String(resource.version),
      "--idempotency-key",
      key,
    ]);
    expect(cleanup.state).toBe("cleaned");
    expect(oracle.prepare("SELECT id FROM users WHERE email=?").get(email)).toBeUndefined();
    oracle.close();
    const replay = await session.command([
      "resource",
      "cleanup",
      text(resource.id),
      "--approval",
      text(approval.id),
      "--expected-version",
      String(resource.version),
      "--idempotency-key",
      key,
    ]);
    expect(replay.operationId).toBe(cleanup.operationId);
    const current = await session.command(["run", "get", runId]);
    expect(current.gate).toBe("failed");
    session.oracles.push({
      resourceId: resource.id,
      operationId: cleanup.operationId,
      userPresentBefore: true,
      userPresentAfter: false,
      originalGate: current.gate,
    });
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await shop.close();
    await session.close(error);
  }
}, 120000);
