import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { semanticHash } from "@testmaster/domain";
import { IdempotencyRepository, LeaseRepository } from "@testmaster/persistence";
import { afterEach, expect, it } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";
import { entity } from "./context.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-cleanup-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const app = await Application.open({ cwd, home, env: {} });
  const init = await app.init();
  cleanups.push(async () => {
    app.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const plan = scaffoldPlan("backend");
  const test = app.tests.create({ projectId: init.projectId, plan });
  const run = app.runs.prepare({ testId: test.id, environmentId: init.environmentId });
  const receipt = app.database.withTx(() => app.runs.insert(run, randomUUID()));
  const lease = new LeaseRepository(app.database).claim({
    workspaceId: app.context.workspaceId,
    owner: "cleanup-test",
    queue: "local",
    leaseMs: 30000,
  });
  if (!lease) throw new Error("No lease");
  const resource = entity(app.context, "res", {
    creatorAttemptId: lease.attemptId,
    resourceType: "user",
    handleRef: "create.handle",
    cleanupPlan: { stepId: "create", declaration: null },
    state: "orphaned",
    ownerProof: { contentHash: semanticHash("proof") },
  });
  app.context.entities.insert("ResourceRecord", resource);
  return { app, resource, runId: receipt.runId };
}
it("denies missing approval and mismatched ownership before any compensation", async () => {
  const { app, resource } = await fixture();
  await expect(
    app.resources.cleanup(resource.id, { expectedVersion: 1, idempotencyKey: randomUUID() }),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await expect(
    app.resources.cleanup(resource.id, {
      approvalId: "apr_01900000-0000-7000-8000-000000000001",
      expectedVersion: 1,
      ownerProof: { contentHash: semanticHash("foreign") },
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  const reader = app.withIdentity({ principalId: app.context.principalId, scopes: ["R"] });
  await expect(
    reader.resources.cleanup(resource.id, { expectedVersion: 1, idempotencyKey: randomUUID() }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(app.resources.get(resource.id).state).toBe("orphaned");
});
it("replays durable cleanup receipts but conflicts on another owner or version", async () => {
  const { app, resource } = await fixture();
  const key = randomUUID();
  const approvalId = "apr_01900000-0000-7000-8000-000000000001";
  const request = { expectedVersion: 1, idempotencyKey: key, approvalId };
  const receipt = {
    resourceId: resource.id,
    operationId: randomUUID(),
    state: "cleaned",
    attemptId: null,
  };
  new IdempotencyRepository(app.database).execute(
    {
      workspaceId: app.context.workspaceId,
      actorScope: app.context.principalId,
      operation: `resource.cleanup:${resource.id}`,
      key,
      body: { resourceId: resource.id, approvalId, expectedVersion: 1, ownerProof: null },
    },
    () => receipt,
  );
  expect(await app.resources.cleanup(resource.id, request)).toEqual(receipt);
  await expect(
    app.resources.cleanup(resource.id, { ...request, expectedVersion: 2 }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});
