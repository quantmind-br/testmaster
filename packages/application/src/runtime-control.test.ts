import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError } from "@testmaster/contracts";
import {
  ExecutionRepository,
  LeaseRepository,
  OutboxRepository,
  StaleFenceError,
} from "@testmaster/persistence";
import { afterEach, expect, it, vi } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";
import { fitsCapacity } from "./worker-capacity.js";

const fixtures: { app: Application; root: string }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { app, root } of fixtures.splice(0)) {
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tm-runtime-control-"));
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home, env: {} });
  fixtures.push({ app, root });
  const init = await app.init();
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  vi.spyOn(app, "preflight").mockResolvedValue();
  return { app, init, test, request: { testId: test.id, environmentId: init.environmentId } };
}
it("reserves headroom and isolated pool slots instead of oversubscribing browser memory", () => {
  const capacity = {
    cpu: 8,
    memoryBytes: 4 * 1024 ** 3,
    pids: 1024,
    diskBytes: 8 * 1024 ** 3,
    pools: { browser: 1, http: 2, python: 1, terminal: 1 },
  };
  expect(fitsCapacity(capacity, [], "browser")).toBe(true);
  expect(fitsCapacity(capacity, ["browser"], "browser")).toBe(false);
  expect(fitsCapacity(capacity, ["http", "http"], "browser")).toBe(true);
  expect(fitsCapacity(capacity, ["http", "http"], "http")).toBe(false);
  expect(fitsCapacity({ ...capacity, cpu: 2 }, [], "browser")).toBe(false);
  // Terminal sessions have a 1 GiB envelope and their own slot pool.
  expect(fitsCapacity(capacity, [], "terminal")).toBe(true);
  expect(fitsCapacity(capacity, ["terminal"], "terminal")).toBe(false);
  expect(
    fitsCapacity({ ...capacity, pools: { ...capacity.pools, terminal: 0 } }, [], "terminal"),
  ).toBe(false);
  expect(fitsCapacity({ ...capacity, memoryBytes: 1024 ** 3 }, [], "terminal")).toBe(false);
});
it("repeated queued cancellation removes the lease atomically and terminal cancellation is a no-op", async () => {
  const { app, request, init } = await fixture();
  const receipt = await app.runs.admit(request, { wait: true });
  expect(app.runs.cancel(receipt.runId).result).toBe("requested");
  const original = app.runs.get(receipt.runId);
  expect(app.runs.cancel(receipt.runId)).toMatchObject({
    result: "already_terminal",
    status: "cancelled",
  });
  expect(app.runs.get(receipt.runId)).toEqual(original);
  expect(
    app.runs.events(receipt.runId).filter((event) => event.type === "run.cancel_requested"),
  ).toHaveLength(1);
  expect(
    app.runs.events(receipt.runId).filter((event) => event.type === "run.completed"),
  ).toHaveLength(1);
  expect(
    new LeaseRepository(app.database).claim({
      workspaceId: init.workspaceId,
      owner: "later",
      queue: "local",
    }),
  ).toBeNull();
  expect(app.database.all("SELECT * FROM attempts")).toHaveLength(0);
});
it("missing enforcement produces a durable typed blocked Run without a job or fallback", async () => {
  const { app, request } = await fixture();
  vi.mocked(app.preflight).mockRejectedValue(
    new ContractError("POLICY_DENIED", "Docker unavailable", {
      reasonCode: "security_precondition_failed",
      control: "docker",
    }),
  );
  const receipt = await app.runs.admit(request, {
    wait: true,
    idempotencyKey: "missing-enforcement-key",
  });
  expect(receipt.status).toBe("blocked");
  expect(app.runs.get(receipt.runId)).toMatchObject({
    phase: "completed",
    outcome: "blocked",
    gate: "failed",
  });
  expect(
    app.runs.events(receipt.runId).find((event) => event.type === "run.completed")?.payload,
  ).toMatchObject({ reasonCode: "security_precondition_failed", control: "docker" });
  expect(app.database.all("SELECT * FROM job_leases")).toHaveLength(0);
  expect(app.database.all("SELECT * FROM attempts")).toHaveLength(0);
});
it("a runner-image refusal records why and the rules analysis points at the image, not the test", async () => {
  const { app, request } = await fixture();
  const imageId = `sha256:${"e".repeat(64)}`;
  vi.mocked(app.preflight).mockRejectedValue(
    new ContractError(
      "POLICY_DENIED",
      `Pinned runner image ${imageId} is not in the local Docker image store`,
      {
        reasonCode: "security_precondition_failed",
        control: "runner_images",
        diagnostic: "image_unavailable",
        imageId,
      },
    ),
  );
  const receipt = await app.runs.admit(request, {
    wait: true,
    idempotencyKey: "image-refusal-key",
  });
  expect(receipt.status).toBe("blocked");
  expect(
    app.runs.events(receipt.runId).find((event) => event.type === "run.completed")?.payload,
  ).toMatchObject({
    reasonCode: "security_precondition_failed",
    control: "runner_images",
    diagnostic: "image_unavailable",
    message: expect.stringContaining(imageId),
  });
  const analysis = await app.analysis.analyze(receipt.runId, { model: false });
  expect(analysis.facts.map((fact) => fact.text)).toContain(
    "Persisted run.completed observation: security_precondition_failed (control runner_images: image_unavailable).",
  );
  const steps = analysis.diagnosis?.nextSteps.map((step) => step.text) ?? [];
  expect(steps.join("\n")).toContain("runner images");
  expect(steps.join("\n")).not.toContain("Review the refused security precondition");
});
it("expired dedup admits a new Run while retaining the historical receipt and Run", async () => {
  const { app, request } = await fixture();
  const key = "expiry-history-receipt-key";
  const first = await app.runs.admit(request, { wait: true, idempotencyKey: key });
  expect(await app.runs.admit(request, { wait: true, idempotencyKey: key })).toEqual(first);
  app.database.run("UPDATE idempotency_receipts SET expires_at='2000-01-01T00:00:00.000Z'");
  const next = await app.runs.admit(request, { wait: true, idempotencyKey: key });
  expect(next.runId).not.toBe(first.runId);
  expect(app.runs.get(first.runId).revisionId).toBe(first.revisionId);
  expect(
    app.runs.events(first.runId).find((event) => event.type === "run.receipt")?.payload,
  ).toMatchObject(first);
});
it("an admitted batch does not observe later tag selection edits", async () => {
  const { app, init, test, request } = await fixture();
  app.tests.update(test.id, { tags: ["selected"] }, test.version!);
  const selection = app.tests
    .list(init.projectId)
    .filter((value) => value.tags.includes("selected"))
    .map((value) => ({ ...request, testId: value.id }));
  const receipt = await app.batches.admit({ selection }, { wait: true });
  const current = app.tests.get(test.id);
  app.tests.update(test.id, { tags: ["excluded"] }, current.version!);
  const added = app.tests.create({
    projectId: init.projectId,
    plan: scaffoldPlan("backend"),
    tags: ["selected"],
  });
  expect(added.id).not.toBe(test.id);
  expect(app.batches.get(receipt.batchId).memberRuns).toEqual(receipt.allMembers);
  expect(app.batches.get(receipt.batchId).requestedCount).toBe(1);
  expect(app.runs.get(receipt.memberRuns[0]!.runId).testId).toBe(test.id);
});
it("restarted old owner cannot publish after a replacement claim even with the same owner name", async () => {
  const { app, request, init } = await fixture();
  const receipt = await app.runs.admit(request, { wait: true });
  const leases = new LeaseRepository(app.database);
  const old = leases.claim({
    workspaceId: init.workspaceId,
    owner: "restarted-pid",
    queue: "local",
  })!;
  app.database.run("UPDATE job_leases SET lease_expires_at='2000-01-01T00:00:00.000Z'");
  leases.expire();
  leases.resume(init.workspaceId, old.jobId, old.fence);
  const replacement = leases.claim({
    workspaceId: init.workspaceId,
    owner: "restarted-pid",
    queue: "local",
  })!;
  expect(replacement.fence).toBeGreaterThan(old.fence);
  expect(() =>
    new ExecutionRepository(app.database).finalize(old, {
      ...app.runs.get(receipt.runId),
      phase: "completed",
      status: "passed",
      outcome: "passed",
      gate: "passed",
    }),
  ).toThrow(StaleFenceError);
  expect(app.runs.get(receipt.runId).outcome).toBeNull();
});
it("dry-run reports pending outbox and missing artifact references without mutating", async () => {
  const { app, init, test } = await fixture();
  const workspaceId = init.workspaceId;
  const insertArtifact = (id: string, storageKey: string) =>
    app.database.run(
      "INSERT INTO artifacts(workspace_id,id,created_at,revision_id,hash,bytes,storage_key,state,redaction_status) VALUES(?,?,?,?,?,?,?,'available','not_applicable')",
      workspaceId,
      id,
      "2026-10-05T00:00:00.000Z",
      String(test.activeRevisionId),
      "hash",
      1,
      storageKey,
    );
  insertArtifact("art-bytes-present", "authored-code/art-bytes-present.json");
  insertArtifact("art-bytes-missing", "authored-code/art-bytes-missing.json");
  await mkdir(join(app.config.dataDir, "authored-code"), { recursive: true });
  await writeFile(join(app.config.dataDir, "authored-code/art-bytes-present.json"), "{}");
  const baseline = new OutboxRepository(app.database).pending(workspaceId).length;
  app.database.withTx(() =>
    new OutboxRepository(app.database).append(workspaceId, workspaceId, "test.pending", {}),
  );
  const before = {
    outbox: app.database.all("SELECT * FROM outbox ORDER BY id"),
    artifacts: app.database.all("SELECT * FROM artifacts ORDER BY id"),
    leases: app.database.all("SELECT * FROM job_leases ORDER BY id"),
  };
  const preview = await app.worker.reconcile({ dryRun: true });
  expect(preview).toMatchObject({
    dryRun: true,
    pendingOutbox: baseline + 1,
    missingArtifactReferences: 1,
  });
  expect({
    outbox: app.database.all("SELECT * FROM outbox ORDER BY id"),
    artifacts: app.database.all("SELECT * FROM artifacts ORDER BY id"),
    leases: app.database.all("SELECT * FROM job_leases ORDER BY id"),
  }).toEqual(before);
});
