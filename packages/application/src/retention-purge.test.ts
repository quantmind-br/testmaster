import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuxiliaryLeaseRepository,
  IdempotencyRepository,
  type PersistenceDatabase,
} from "@testmaster/persistence";
import { afterEach, expect, it } from "vitest";
import { Application } from "./application.js";
import { seedRun } from "./ops.testkit.js";

const applications: Application[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const app of applications.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const now = new Date("2026-10-20T12:00:00.000Z");
const old = "2026-06-01T00:00:00.000Z";
const expiredReceipt = "2026-06-01T00:00:00.000Z";
const receiptInsideWindow = "2026-09-01T00:00:00.000Z";
const unexpiredReceipt = "2099-01-01T00:00:00.000Z";

async function openApplication(): Promise<{ app: Application; workspaceId: string }> {
  const root = await mkdtemp(join(tmpdir(), "tm-retention-purge-"));
  roots.push(root);
  const app = await Application.open({ cwd: root, home: join(root, "home") });
  applications.push(app);
  await app.init();
  return { app, workspaceId: String(app.context.workspaceId) };
}

const count = (app: Application, table: string, column: string, id: string): number =>
  Number(
    app.database.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id=? AND ${column}=?`,
      app.context.workspaceId,
      id,
    )?.n,
  );

function setHold(app: Application, key: string): void {
  app.database.run("INSERT INTO operational_state(key,value) VALUES(?,?)", key, "case-17");
}
function releaseHold(app: Application, key: string): void {
  expect(
    app.database.run("UPDATE operational_state SET value='released' WHERE key=?", key).changes,
  ).toBe(1);
}

const receiptRequest = (app: Application, key: string) => ({
  workspaceId: String(app.context.workspaceId),
  actorScope: "usr_seed",
  operation: "seed.operation",
  key,
  body: { key },
});
/** Stores a receipt through the repository, then moves its expiry to `expiresAt`. */
function seedReceipt(app: Application, expiresAt: string): string {
  const key = `receipt-${randomUUID()}`;
  new IdempotencyRepository(app.database).execute(receiptRequest(app, key), () => ({
    stored: key,
  }));
  app.database.run("UPDATE idempotency_receipts SET expires_at=? WHERE key=?", expiresAt, key);
  return key;
}
/** An analysis or healing job of `runId`: claimed, then settled as `state` unless it stays leased. */
function auxiliaryJob(
  database: PersistenceDatabase,
  workspaceId: string,
  queue: "analysis" | "healing",
  runId: string,
  state: "completed" | "cancelled" | "leased",
) {
  const jobs = new AuxiliaryLeaseRepository(database);
  const { job } = jobs.enqueue(workspaceId, queue, {
    operation: queue === "analysis" ? "factual" : "propose",
    targetId: runId,
    actorId: "usr_seed",
    evidenceHash: "a".repeat(64),
    configHash: "b".repeat(64),
    options: {},
  });
  const fence = jobs.claim({ workspaceId, owner: "seed", queue, jobId: job.jobId });
  if (!fence) throw new Error("The seeded job was not claimed");
  if (state !== "leased") jobs.finish(fence, state, {});
  return { jobs, jobId: job.jobId, fence };
}

it("OPS-021 CI-009 a workspace hold released by value no longer protects the workspace", async () => {
  const { app, workspaceId } = await openApplication();
  const expired = seedRun(
    { application: app, workspaceId },
    { createdAt: old, endedAt: old, outcome: "passed" },
  );
  const key = `retention:legal-hold:${workspaceId}`;
  setHold(app, key);
  const held = await app.retentionPurge.run({ now });
  expect(held.legalHold).toBe(true);
  expect(held.runs.purged).toBe(0);
  expect(count(app, "runs", "id", expired.runId)).toBe(1);
  releaseHold(app, key);
  const released = await app.retentionPurge.run({ now });
  expect(released.legalHold).toBe(false);
  expect(released.runs.purged).toBe(1);
  expect(count(app, "runs", "id", expired.runId)).toBe(0);
});

it("OPS-021 CI-009 a Run hold released by value no longer protects that Run", async () => {
  const { app, workspaceId } = await openApplication();
  const expired = seedRun(
    { application: app, workspaceId },
    { createdAt: old, endedAt: old, outcome: "passed" },
  );
  const key = `retention:legal-hold:${workspaceId}:${expired.runId}`;
  setHold(app, key);
  const held = await app.retentionPurge.run({ now });
  expect(held.runs.skipped).toEqual([{ runId: expired.runId, reason: "legal_hold" }]);
  expect(count(app, "runs", "id", expired.runId)).toBe(1);
  releaseHold(app, key);
  const released = await app.retentionPurge.run({ now });
  expect(released.runs).toMatchObject({ purged: 1, skipped: [] });
  expect(count(app, "runs", "id", expired.runId)).toBe(0);
});

it("OPS-021 CI-019 deletes an idempotency receipt expired before the metadata cutoff", async () => {
  const { app } = await openApplication();
  const key = seedReceipt(app, expiredReceipt);
  const report = await app.retentionPurge.run({ now });
  expect(report.idempotencyReceipts).toBe(1);
  expect(count(app, "idempotency_receipts", "key", key)).toBe(0);
});

it("OPS-021 CI-019 keeps an unexpired receipt and replays its stored result", async () => {
  const { app } = await openApplication();
  const key = seedReceipt(app, unexpiredReceipt);
  const report = await app.retentionPurge.run({ now });
  expect(report.idempotencyReceipts).toBe(0);
  expect(count(app, "idempotency_receipts", "key", key)).toBe(1);
  let called = false;
  const replay = new IdempotencyRepository(app.database).execute(receiptRequest(app, key), () => {
    called = true;
    return { stored: "other" };
  });
  expect(replay).toEqual({ replayed: true, receipt: { stored: key } });
  expect(called).toBe(false);
});

it("OPS-021 CI-019 keeps a receipt that expired inside the metadata window", async () => {
  const { app } = await openApplication();
  const key = seedReceipt(app, receiptInsideWindow);
  const report = await app.retentionPurge.run({ now });
  expect(report.idempotencyReceipts).toBe(0);
  expect(count(app, "idempotency_receipts", "key", key)).toBe(1);
});

it("OPS-021 CI-019 a preview deletes no receipt and reports zero", async () => {
  const { app } = await openApplication();
  const key = seedReceipt(app, expiredReceipt);
  const preview = await app.retentionPurge.run({ now, dryRun: true });
  expect(preview.idempotencyReceipts).toBe(0);
  expect(count(app, "idempotency_receipts", "key", key)).toBe(1);
});

it("OPS-021 CI-019 a workspace hold keeps an expired receipt until the hold is released", async () => {
  const { app, workspaceId } = await openApplication();
  const holdKey = `retention:legal-hold:${workspaceId}`;
  const key = seedReceipt(app, expiredReceipt);
  setHold(app, holdKey);
  const held = await app.retentionPurge.run({ now });
  expect(held.idempotencyReceipts).toBe(0);
  expect(count(app, "idempotency_receipts", "key", key)).toBe(1);
  releaseHold(app, holdKey);
  const released = await app.retentionPurge.run({ now });
  expect(released.idempotencyReceipts).toBe(1);
  expect(count(app, "idempotency_receipts", "key", key)).toBe(0);
});

it("OPS-021 a purged Run takes its settled analysis and healing jobs and leaves another Run's job", async () => {
  const { app, workspaceId } = await openApplication();
  const scope = { application: app, workspaceId };
  const expired = seedRun(scope, { createdAt: old, endedAt: old, outcome: "failed" });
  const running = seedRun(scope, { createdAt: old });
  const analysis = auxiliaryJob(app.database, workspaceId, "analysis", expired.runId, "completed");
  const healing = auxiliaryJob(app.database, workspaceId, "healing", expired.runId, "cancelled");
  const other = auxiliaryJob(app.database, workspaceId, "analysis", running.runId, "completed");
  const report = await app.retentionPurge.run({ now });
  expect(report.runs).toMatchObject({ purged: 1, skipped: [] });
  expect(count(app, "runs", "id", expired.runId)).toBe(0);
  expect(analysis.jobs.get(workspaceId, analysis.jobId)).toBeNull();
  expect(analysis.jobs.get(workspaceId, healing.jobId)).toBeNull();
  expect(analysis.jobs.get(workspaceId, other.jobId)?.state).toBe("completed");
});

it("OPS-021 keeps a Run whose analysis job a holder still runs and purges both once the job settles", async () => {
  const { app, workspaceId } = await openApplication();
  const scope = { application: app, workspaceId };
  const expired = seedRun(scope, { createdAt: old, endedAt: old, outcome: "failed" });
  const held = auxiliaryJob(app.database, workspaceId, "analysis", expired.runId, "leased");
  const report = await app.retentionPurge.run({ now });
  expect(report.runs).toMatchObject({
    purged: 0,
    skipped: [{ runId: expired.runId, reason: "auxiliary_job_active" }],
  });
  expect(count(app, "runs", "id", expired.runId)).toBe(1);
  expect(held.jobs.get(workspaceId, held.jobId)?.state).toBe("leased");
  held.jobs.finish(held.fence, "completed", {});
  const later = await app.retentionPurge.run({ now });
  expect(later.runs).toMatchObject({ purged: 1, skipped: [] });
  expect(held.jobs.get(workspaceId, held.jobId)).toBeNull();
});
