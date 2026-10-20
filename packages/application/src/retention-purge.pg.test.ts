import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AuxiliaryLeaseRepository,
  IdempotencyRepository,
  type PersistenceDatabase,
} from "@testmaster/persistence";
import { afterEach, expect, it, vi } from "vitest";
import { addWorkspace, type OpsStack, opsStack, type SeededRun, seedRun } from "./ops.testkit.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const now = new Date("2026-10-20T12:00:00.000Z");
const old = "2026-06-01T00:00:00.000Z";
const recent = "2026-10-10T00:00:00.000Z";
const older = "2026-05-01T00:00:00.000Z";

async function stackWithClock(): Promise<OpsStack> {
  const stack = await opsStack();
  cleanups.push(() => stack.cleanup());
  return stack;
}
const db = (stack: OpsStack) => stack.application.controllerScope().database;
const count = (stack: OpsStack, table: string, column: string, id: string, ws?: string): number =>
  Number(
    db(stack).get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id=? AND ${column}=?`,
      ws ?? stack.workspaceId,
      id,
    )?.n,
  );
function insertAudit(stack: OpsStack, timestamp: string, ws = stack.workspaceId): string {
  const id = `aud_seed_${randomUUID()}`;
  db(stack).run(
    "INSERT INTO audit_events(workspace_id,id,created_at,actor,action,resource_id,request_id,timestamp) VALUES(?,?,?,?,?,?,?,?)",
    ws,
    id,
    timestamp,
    "usr_seed",
    "seed.event",
    "res_seed",
    "req_seed",
    timestamp,
  );
  return id;
}
const permits = (stack: OpsStack): number =>
  Number(
    db(stack).get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM operational_state WHERE key LIKE 'retention:purge-permit:%'",
    )?.n,
  );
const expiredReceipt = "2026-06-01T00:00:00.000Z";
const receiptInsideWindow = "2026-09-01T00:00:00.000Z";
const unexpiredReceipt = "2099-01-01T00:00:00.000Z";
const placeHold = (stack: OpsStack, key: string): void => {
  db(stack).run("INSERT INTO operational_state(key,value) VALUES(?,?)", key, "case-17");
};
const releaseHold = (stack: OpsStack, key: string): void => {
  expect(
    db(stack).run("UPDATE operational_state SET value='released' WHERE key=?", key).changes,
  ).toBe(1);
};
/** Stores a receipt through the repository, then moves its expiry to `expiresAt`. */
function seedReceipt(stack: OpsStack, expiresAt: string, ws = stack.workspaceId): string {
  const key = `receipt-${randomUUID()}`;
  new IdempotencyRepository(db(stack)).execute(
    { workspaceId: ws, actorScope: "usr_seed", operation: "seed.operation", key, body: { key } },
    () => ({ stored: key }),
  );
  db(stack).run("UPDATE idempotency_receipts SET expires_at=? WHERE key=?", expiresAt, key);
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
/** A delivered outbox event of `aggregateId` with the delivered check run that refers to it. */
function deliveredEvent(database: PersistenceDatabase, workspaceId: string, aggregateId: string) {
  const eventId = `evt_${randomUUID()}`;
  database.run(
    "INSERT INTO outbox(workspace_id,id,created_at,aggregate_id,seq,type,payload_ref,data_json,delivery_state) VALUES(?,?,?,?,?,?,?,?,?)",
    workspaceId,
    eventId,
    old,
    aggregateId,
    0,
    "job.settled",
    eventId,
    "{}",
    "delivered",
  );
  const deliveryId = `dlv_${randomUUID()}`;
  database.run(
    "INSERT INTO deliveries(workspace_id,id,created_at,event_id,destination_ref,check_name,subject_sha,report_hash,payload_hash,state,check_status) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    workspaceId,
    deliveryId,
    old,
    eventId,
    "github:repo",
    "TestMaster / result",
    "a".repeat(40),
    randomUUID().replaceAll("-", "").repeat(2),
    "c".repeat(64),
    "delivered",
    "completed",
  );
  return { eventId, deliveryId };
}

it("OPS-021 purges terminal Runs past the metadata window with their whole subtree and keeps newer and running Runs", async () => {
  const stack = await stackWithClock();
  const expired = seedRun(stack, {
    createdAt: old,
    endedAt: old,
    outcome: "passed",
    artifact: "expired",
  });
  const fresh = seedRun(stack, { createdAt: recent, endedAt: recent, outcome: "passed" });
  const running = seedRun(stack, { createdAt: old });
  const preview = await stack.workspace.retentionPurge.run({ now, dryRun: true });
  expect(preview).toMatchObject({ dryRun: true, runs: { eligible: 1, purged: 0 } });
  expect(count(stack, "runs", "id", expired.runId)).toBe(1);

  const report = await stack.workspace.retentionPurge.run({ now });
  expect(report.runs).toMatchObject({ eligible: 1, purged: 1, skipped: [] });
  for (const [table, column] of [
    ["runs", "id"],
    ["attempts", "run_id"],
    ["job_leases", "resource_id"],
    ["outbox", "aggregate_id"],
    ["artifacts", "run_id"],
    ["snapshots", "run_id"],
  ] as const)
    expect(count(stack, table, column, expired.runId), `${table} of the expired Run`).toBe(0);
  expect(count(stack, "runs", "id", fresh.runId)).toBe(1);
  expect(count(stack, "runs", "id", running.runId)).toBe(1);
  expect(count(stack, "attempts", "run_id", fresh.runId)).toBe(1);
  expect(permits(stack)).toBe(0);
});

it("OPS-021 honours legal holds on the workspace, a Run and an artifact, and purges once the hold is lifted", async () => {
  const stack = await stackWithClock();
  const ws = stack.workspaceId;
  const held = seedRun(stack, {
    createdAt: old,
    endedAt: old,
    outcome: "passed",
    artifact: "expired",
  });
  const holdKeys = [
    `retention:legal-hold:${ws}`,
    `retention:legal-hold:${ws}:${held.runId}`,
    `retention:legal-hold:${ws}:${held.artifactId}`,
  ];
  for (const key of holdKeys) {
    db(stack).run("INSERT INTO operational_state(key,value) VALUES(?,?)", key, "case-17");
    const report = await stack.workspace.retentionPurge.run({ now });
    expect(report.runs.purged, key).toBe(0);
    expect(report.runs.skipped[0]?.reason, key).toBe("legal_hold");
    expect(count(stack, "runs", "id", held.runId), key).toBe(1);
    db(stack).run("DELETE FROM operational_state WHERE key=?", key);
  }
  const workspaceHold = db(stack).run(
    "INSERT INTO operational_state(key,value) VALUES(?,?)",
    holdKeys[0],
    "case-17",
  );
  expect(workspaceHold.changes).toBe(1);
  insertAudit(stack, "2025-01-01T00:00:00.000Z");
  const blocked = await stack.workspace.retentionPurge.run({ now });
  expect(blocked.legalHold).toBe(true);
  expect(blocked.audit).toMatchObject({ purged: 0, skipped: "legal_hold" });
  db(stack).run("DELETE FROM operational_state WHERE key=?", holdKeys[0]);
  const released = await stack.workspace.retentionPurge.run({ now });
  expect(released.runs.purged).toBe(1);
  expect(count(stack, "runs", "id", held.runId)).toBe(0);
});

it("OPS-021 CI-009 a workspace hold released by value no longer protects the workspace", async () => {
  const stack = await stackWithClock();
  const key = `retention:legal-hold:${stack.workspaceId}`;
  const expired = seedRun(stack, { createdAt: old, endedAt: old, outcome: "passed" });
  db(stack).run("INSERT INTO operational_state(key,value) VALUES(?,?)", key, "case-17");
  const held = await stack.workspace.retentionPurge.run({ now });
  expect(held.legalHold).toBe(true);
  expect(held.audit.skipped).toBe("legal_hold");
  expect(count(stack, "runs", "id", expired.runId)).toBe(1);
  releaseHold(stack, key);
  const released = await stack.workspace.retentionPurge.run({ now });
  expect(released.legalHold).toBe(false);
  expect(released.runs.purged).toBe(1);
  expect(count(stack, "runs", "id", expired.runId)).toBe(0);
});

it("OPS-021 CI-009 a Run hold released by value no longer protects that Run", async () => {
  const stack = await stackWithClock();
  const expired = seedRun(stack, { createdAt: old, endedAt: old, outcome: "passed" });
  const key = `retention:legal-hold:${stack.workspaceId}:${expired.runId}`;
  db(stack).run("INSERT INTO operational_state(key,value) VALUES(?,?)", key, "case-17");
  const held = await stack.workspace.retentionPurge.run({ now });
  expect(held.runs.purged).toBe(0);
  expect(held.runs.skipped).toEqual([{ runId: expired.runId, reason: "legal_hold" }]);
  expect(count(stack, "runs", "id", expired.runId)).toBe(1);
  releaseHold(stack, key);
  const released = await stack.workspace.retentionPurge.run({ now });
  expect(released.runs).toMatchObject({ purged: 1, skipped: [] });
  expect(count(stack, "runs", "id", expired.runId)).toBe(0);
});

it("OPS-021 CI-009 an artifact hold released by value no longer blocks the Run that owns the artifact", async () => {
  const stack = await stackWithClock();
  const expired = seedRun(stack, {
    createdAt: old,
    endedAt: old,
    outcome: "passed",
    artifact: "expired",
  });
  const key = `retention:legal-hold:${stack.workspaceId}:${expired.artifactId}`;
  db(stack).run("INSERT INTO operational_state(key,value) VALUES(?,?)", key, "case-17");
  const held = await stack.workspace.retentionPurge.run({ now });
  expect(held.runs.skipped).toEqual([{ runId: expired.runId, reason: "legal_hold" }]);
  releaseHold(stack, key);
  const released = await stack.workspace.retentionPurge.run({ now });
  expect(released.runs).toMatchObject({ purged: 1, skipped: [] });
  expect(count(stack, "runs", "id", expired.runId)).toBe(0);
});

it("OPS-021 CI-019 deletes an idempotency receipt expired before the metadata cutoff even when no Run is purgeable", async () => {
  const stack = await stackWithClock();
  const key = seedReceipt(stack, expiredReceipt);
  const report = await stack.workspace.retentionPurge.run({ now });
  expect(report.runs.eligible).toBe(0);
  expect(report.idempotencyReceipts).toBe(1);
  expect(count(stack, "idempotency_receipts", "key", key)).toBe(0);
});

it("OPS-021 CI-019 keeps an unexpired receipt and replays its stored result", async () => {
  const stack = await stackWithClock();
  const key = seedReceipt(stack, unexpiredReceipt);
  const report = await stack.workspace.retentionPurge.run({ now });
  expect(report.idempotencyReceipts).toBe(0);
  expect(count(stack, "idempotency_receipts", "key", key)).toBe(1);
  let called = false;
  const replay = new IdempotencyRepository(db(stack)).execute(
    {
      workspaceId: stack.workspaceId,
      actorScope: "usr_seed",
      operation: "seed.operation",
      key,
      body: { key },
    },
    () => {
      called = true;
      return { stored: "other" };
    },
  );
  expect(replay).toEqual({ replayed: true, receipt: { stored: key } });
  expect(called).toBe(false);
});

it("OPS-021 CI-019 keeps a receipt that expired inside the metadata window", async () => {
  const stack = await stackWithClock();
  const key = seedReceipt(stack, receiptInsideWindow);
  const report = await stack.workspace.retentionPurge.run({ now });
  expect(report.idempotencyReceipts).toBe(0);
  expect(count(stack, "idempotency_receipts", "key", key)).toBe(1);
});

it("OPS-021 CI-019 a preview deletes no receipt and reports zero", async () => {
  const stack = await stackWithClock();
  const key = seedReceipt(stack, expiredReceipt);
  const preview = await stack.workspace.retentionPurge.run({ now, dryRun: true });
  expect(preview.idempotencyReceipts).toBe(0);
  expect(count(stack, "idempotency_receipts", "key", key)).toBe(1);
});

it("OPS-021 CI-019 a workspace hold keeps an expired receipt until the hold is released", async () => {
  const stack = await stackWithClock();
  const holdKey = `retention:legal-hold:${stack.workspaceId}`;
  const key = seedReceipt(stack, expiredReceipt);
  db(stack).run("INSERT INTO operational_state(key,value) VALUES(?,?)", holdKey, "case-17");
  const held = await stack.workspace.retentionPurge.run({ now });
  expect(held.idempotencyReceipts).toBe(0);
  expect(count(stack, "idempotency_receipts", "key", key)).toBe(1);
  releaseHold(stack, holdKey);
  const released = await stack.workspace.retentionPurge.run({ now });
  expect(released.idempotencyReceipts).toBe(1);
  expect(count(stack, "idempotency_receipts", "key", key)).toBe(0);
});

it("OPS-021 keeps Runs whose evidence, backup hold, events, delivery or healing review are still needed", async () => {
  const stack = await stackWithClock();
  const base = { createdAt: old, endedAt: old, outcome: "passed" } as const;
  const cases: [string, SeededRun][] = [
    ["artifacts_not_collected", seedRun(stack, { ...base, artifact: "available" })],
    ["backup_hold", seedRun(stack, { ...base, artifact: "expired" })],
    ["pending_outbox", seedRun(stack, { ...base, pendingOutbox: true })],
    ["pending_delivery", seedRun(stack, { ...base, pendingDelivery: true })],
    ["healing_review_open", seedRun(stack, { ...base, healing: "proposed" })],
  ];
  const backupHeld = cases[1]?.[1];
  db(stack).run(
    "INSERT INTO backup_object_holds(workspace_id,artifact_id,backup_id,expires_at) VALUES(?,?,?,?)",
    stack.workspaceId,
    backupHeld?.artifactId,
    "bkp_seed",
    "2026-10-21T00:00:00.000Z",
  );
  const rejected = seedRun(stack, { ...base, healing: "rejected" });
  const report = await stack.workspace.retentionPurge.run({ now });
  const reasons = Object.fromEntries(report.runs.skipped.map((item) => [item.runId, item.reason]));
  for (const [reason, run] of cases) {
    expect(reasons[run.runId], reason).toBe(reason);
    expect(count(stack, "runs", "id", run.runId), reason).toBe(1);
  }
  expect(report.runs.purged).toBe(1);
  expect(count(stack, "runs", "id", rejected.runId)).toBe(0);
  const later = await stack.workspace.retentionPurge.run({
    now: new Date("2026-10-22T00:00:00.000Z"),
  });
  expect(later.runs.skipped.some((item) => item.reason === "backup_hold")).toBe(false);
  expect(count(stack, "runs", "id", backupHeld?.runId ?? ""), "hold expired").toBe(0);
});

it("OPS-021 purges audit events past 365 days behind a signed chained summary and keeps newer events", async () => {
  const stack = await stackWithClock();
  const first = [
    insertAudit(stack, "2025-01-01T00:00:00.000Z"),
    insertAudit(stack, "2025-01-02T00:00:00.000Z"),
  ];
  const kept = insertAudit(stack, "2026-09-01T00:00:00.000Z");
  const report = await stack.workspace.retentionPurge.run({ now });
  expect(report.audit).toMatchObject({ eligible: 2, purged: 2, skipped: null });
  for (const id of first) expect(count(stack, "audit_events", "id", id)).toBe(0);
  expect(count(stack, "audit_events", "id", kept)).toBe(1);
  const summary = db(stack).get<{
    event_count: number;
    digest: string;
    previous_digest: string | null;
    signature: string;
  }>(
    "SELECT event_count,digest,previous_digest,signature FROM audit_purge_summaries WHERE workspace_id=? AND id=?",
    stack.workspaceId,
    report.audit.summaryId,
  );
  expect(summary).toMatchObject({ event_count: 2, previous_digest: null });
  expect(summary?.signature).toMatch(/^[0-9a-f]{64}$/);

  insertAudit(stack, "2025-02-01T00:00:00.000Z");
  const second = await stack.workspace.retentionPurge.run({
    now: new Date(now.getTime() + 60_000),
  });
  const chained = db(stack).get<{ previous_digest: string | null }>(
    "SELECT previous_digest FROM audit_purge_summaries WHERE workspace_id=? AND id=?",
    stack.workspaceId,
    second.audit.summaryId,
  );
  expect(chained?.previous_digest).toBe(summary?.digest);
  expect(await stack.workspace.retentionPurge.verifySummaries()).toEqual({
    valid: true,
    summaries: 2,
    problems: [],
  });
  expect(() =>
    db(stack).run("DELETE FROM audit_events WHERE workspace_id=?", stack.workspaceId),
  ).toThrow();
  expect(() =>
    db(stack).run(
      "UPDATE audit_purge_summaries SET event_count=9 WHERE workspace_id=?",
      stack.workspaceId,
    ),
  ).toThrow();
  expect(permits(stack)).toBe(0);
});

it("OPS-021 a different signing key makes the summary chain fail verification", async () => {
  const stack = await stackWithClock();
  insertAudit(stack, "2025-01-01T00:00:00.000Z");
  await stack.workspace.retentionPurge.run({ now });
  expect((await stack.workspace.retentionPurge.verifySummaries()).valid).toBe(true);
  const original = await readFile(stack.server.security.masterKeyFile);
  await writeFile(stack.server.security.masterKeyFile, Buffer.alloc(32, 7), { mode: 0o600 });
  const verdict = await stack.workspace.retentionPurge.verifySummaries();
  expect(verdict.valid).toBe(false);
  expect(verdict.problems.join(" ")).toMatch(/signature mismatch/);
  await writeFile(stack.server.security.masterKeyFile, original, { mode: 0o600 });
  expect((await stack.workspace.retentionPurge.verifySummaries()).valid).toBe(true);
});

it("OPS-021 detects an altered or removed audit purge summary even when the owner disables the immutability trigger", async () => {
  const stack = await stackWithClock();
  insertAudit(stack, "2025-01-01T00:00:00.000Z");
  await stack.workspace.retentionPurge.run({ now });
  insertAudit(stack, "2025-02-01T00:00:00.000Z");
  await stack.workspace.retentionPurge.run({ now: new Date(now.getTime() + 60_000) });
  const verify = () => stack.workspace.retentionPurge.verifySummaries();
  expect(await verify()).toMatchObject({ valid: true, summaries: 2, problems: [] });
  // The summary rows are immutable for the application: an update is refused.
  expect(() => db(stack).run("UPDATE audit_purge_summaries SET event_count=99")).toThrow();

  const summaries = db(stack).all<{ id: string; event_count: number }>(
    "SELECT id,event_count FROM audit_purge_summaries WHERE workspace_id=? ORDER BY created_at,id",
    stack.workspaceId,
  );
  const first = String(summaries[0]?.id);
  const second = String(summaries[1]?.id);
  const originalCount = Number(summaries[0]?.event_count);
  db(stack).run(
    "ALTER TABLE audit_purge_summaries DISABLE TRIGGER audit_purge_summaries_immutable",
  );
  try {
    // An altered event count breaks the signature of that summary only.
    db(stack).run("UPDATE audit_purge_summaries SET event_count=99 WHERE id=?", first);
    expect((await verify()).problems).toEqual([`${first}: signature mismatch`]);
    db(stack).run(
      "UPDATE audit_purge_summaries SET event_count=? WHERE id=?",
      originalCount,
      first,
    );
    expect((await verify()).valid).toBe(true);

    // Removing the first summary leaves the second one pointing at a missing predecessor.
    db(stack).run("DELETE FROM audit_purge_summaries WHERE id=?", first);
    const broken = await verify();
    expect(broken.valid).toBe(false);
    expect(broken.problems).toEqual([`${second}: chain broken`]);
  } finally {
    db(stack).run(
      "ALTER TABLE audit_purge_summaries ENABLE TRIGGER audit_purge_summaries_immutable",
    );
  }
});

it("OPS-021 refuses to delete audit events while the signing key is unavailable", async () => {
  const stack = await stackWithClock();
  const id = insertAudit(stack, "2025-01-01T00:00:00.000Z");
  const original = await readFile(stack.server.security.masterKeyFile);
  await rm(stack.server.security.masterKeyFile);
  const report = await stack.workspace.retentionPurge.run({ now });
  expect(report.audit).toMatchObject({ purged: 0, skipped: "signing_key_unavailable" });
  expect(count(stack, "audit_events", "id", id)).toBe(1);
  await writeFile(join(stack.root, "master.key"), original, { mode: 0o600 });
  const retried = await stack.workspace.retentionPurge.run({ now });
  expect(retried.audit.purged).toBe(1);
  expect(count(stack, "audit_events", "id", id)).toBe(0);
});

it("OPS-021 SEC-037 a purge of one workspace never reads or deletes another workspace's rows", async () => {
  const stack = await stackWithClock();
  const otherId = addWorkspace(stack, "Other", "other-owner");
  const mine = seedRun(stack, { createdAt: old, endedAt: old, outcome: "passed" });
  const theirs = seedRun(stack, {
    createdAt: old,
    endedAt: old,
    outcome: "passed",
    workspaceId: otherId,
  });
  const theirAudit = insertAudit(stack, "2025-01-01T00:00:00.000Z", otherId);
  const myReceipt = seedReceipt(stack, expiredReceipt);
  const theirReceipt = seedReceipt(stack, expiredReceipt, otherId);
  const report = await stack.workspace.retentionPurge.run({ now });
  expect(report.runs.purged).toBe(1);
  expect(report.idempotencyReceipts).toBe(1);
  expect(count(stack, "idempotency_receipts", "key", myReceipt)).toBe(0);
  expect(count(stack, "idempotency_receipts", "key", theirReceipt, otherId)).toBe(1);
  expect(count(stack, "runs", "id", mine.runId)).toBe(0);
  expect(count(stack, "runs", "id", theirs.runId, otherId)).toBe(1);
  expect(count(stack, "audit_events", "id", theirAudit, otherId)).toBe(1);
  const otherReport = await stack.application
    .forWorkspaceSystem(otherId)
    .retentionPurge.run({ now });
  expect(otherReport.runs.purged).toBe(1);
  expect(otherReport.idempotencyReceipts).toBe(1);
  expect(count(stack, "idempotency_receipts", "key", theirReceipt, otherId)).toBe(0);
  expect(count(stack, "audit_events", "id", theirAudit, otherId)).toBe(0);
});

it("OPS-021 a purged Run takes its settled analysis and healing jobs with their events and leaves another Run's job", async () => {
  const stack = await stackWithClock();
  const ws = stack.workspaceId;
  const expired = seedRun(stack, { createdAt: old, endedAt: old, outcome: "failed" });
  const running = seedRun(stack, { createdAt: old });
  const analysis = auxiliaryJob(db(stack), ws, "analysis", expired.runId, "completed");
  const healing = auxiliaryJob(db(stack), ws, "healing", expired.runId, "cancelled");
  const other = auxiliaryJob(db(stack), ws, "analysis", running.runId, "completed");
  const purgedEvent = deliveredEvent(db(stack), ws, analysis.jobId);
  const keptEvent = deliveredEvent(db(stack), ws, other.jobId);
  const report = await stack.workspace.retentionPurge.run({ now });
  expect(report.runs).toMatchObject({ purged: 1, skipped: [] });
  expect(count(stack, "runs", "id", expired.runId)).toBe(0);
  expect(analysis.jobs.get(ws, analysis.jobId)).toBeNull();
  expect(analysis.jobs.get(ws, healing.jobId)).toBeNull();
  expect(count(stack, "outbox", "id", purgedEvent.eventId)).toBe(0);
  expect(count(stack, "deliveries", "id", purgedEvent.deliveryId)).toBe(0);
  expect(analysis.jobs.get(ws, other.jobId)?.state).toBe("completed");
  expect(count(stack, "outbox", "id", keptEvent.eventId)).toBe(1);
  expect(count(stack, "deliveries", "id", keptEvent.deliveryId)).toBe(1);
});

it("OPS-021 keeps a Run whose analysis job a holder claims while the purge pass runs", async () => {
  const stack = await stackWithClock();
  const ws = stack.workspaceId;
  const expired = seedRun(stack, { createdAt: old, endedAt: old, outcome: "failed" });
  // Another caller enqueues and claims the Run's analysis job after the pass selected the Run,
  // just before the transaction that deletes it.
  const database = stack.workspace.database;
  const withTx = database.withTx.bind(database);
  let started: ReturnType<typeof auxiliaryJob> | undefined;
  const spy = vi
    .spyOn(database, "withTx")
    .mockImplementationOnce(<T>(fn: (tx: PersistenceDatabase) => T): T => {
      started = auxiliaryJob(db(stack), ws, "analysis", expired.runId, "leased");
      return withTx(fn);
    });
  try {
    const report = await stack.workspace.retentionPurge.run({ now });
    expect(report.runs).toMatchObject({
      eligible: 0,
      purged: 0,
      skipped: [{ runId: expired.runId, reason: "auxiliary_job_active" }],
    });
  } finally {
    spy.mockRestore();
  }
  expect(count(stack, "runs", "id", expired.runId)).toBe(1);
  expect(started?.jobs.get(ws, started.jobId)?.state).toBe("leased");
});

it("OPS-021 keeps a Run when a legal hold on it is placed while the purge pass runs", async () => {
  const stack = await stackWithClock();
  const ws = stack.workspaceId;
  const expired = seedRun(stack, { createdAt: old, endedAt: old, outcome: "failed" });
  // The hold lands after the pass read the holds, just before the transaction that deletes the Run.
  const database = stack.workspace.database;
  const withTx = database.withTx.bind(database);
  const spy = vi
    .spyOn(database, "withTx")
    .mockImplementationOnce(<T>(fn: (tx: PersistenceDatabase) => T): T => {
      placeHold(stack, `retention:legal-hold:${ws}:${expired.runId}`);
      return withTx(fn);
    });
  try {
    const report = await stack.workspace.retentionPurge.run({ now });
    expect(report.runs).toMatchObject({
      eligible: 0,
      purged: 0,
      skipped: [{ runId: expired.runId, reason: "legal_hold" }],
    });
  } finally {
    spy.mockRestore();
  }
  expect(count(stack, "runs", "id", expired.runId)).toBe(1);
});

it("OPS-021 a workspace legal hold placed while the purge pass runs keeps everything the pass has not deleted yet", async () => {
  const stack = await stackWithClock();
  const ws = stack.workspaceId;
  const first = seedRun(stack, { createdAt: older, endedAt: older, outcome: "failed" });
  const second = seedRun(stack, { createdAt: old, endedAt: old, outcome: "failed" });
  const receipt = seedReceipt(stack, expiredReceipt);
  const audit = insertAudit(stack, "2025-01-01T00:00:00.000Z");
  // The hold lands right after the transaction that deletes the first Run.
  const database = stack.workspace.database;
  const withTx = database.withTx.bind(database);
  const spy = vi
    .spyOn(database, "withTx")
    .mockImplementationOnce(<T>(fn: (tx: PersistenceDatabase) => T): T => {
      const result = withTx(fn);
      placeHold(stack, `retention:legal-hold:${ws}`);
      return result;
    });
  try {
    const report = await stack.workspace.retentionPurge.run({ now });
    expect(report).toMatchObject({
      legalHold: true,
      runs: { eligible: 1, purged: 1, skipped: [{ runId: second.runId, reason: "legal_hold" }] },
      idempotencyReceipts: 0,
      audit: { purged: 0, summaryId: null, skipped: "legal_hold" },
    });
  } finally {
    spy.mockRestore();
  }
  expect(count(stack, "runs", "id", first.runId)).toBe(0);
  expect(count(stack, "runs", "id", second.runId)).toBe(1);
  expect(count(stack, "idempotency_receipts", "key", receipt)).toBe(1);
  expect(count(stack, "audit_events", "id", audit)).toBe(1);
});

it("OPS-021 keeps a Run whose analysis job a holder still runs and purges both once the job settles", async () => {
  const stack = await stackWithClock();
  const ws = stack.workspaceId;
  const expired = seedRun(stack, { createdAt: old, endedAt: old, outcome: "failed" });
  const held = auxiliaryJob(db(stack), ws, "analysis", expired.runId, "leased");
  const report = await stack.workspace.retentionPurge.run({ now });
  expect(report.runs).toMatchObject({
    purged: 0,
    skipped: [{ runId: expired.runId, reason: "auxiliary_job_active" }],
  });
  expect(count(stack, "runs", "id", expired.runId)).toBe(1);
  expect(held.jobs.get(ws, held.jobId)?.state).toBe("leased");
  held.jobs.finish(held.fence, "completed", {});
  const later = await stack.workspace.retentionPurge.run({ now });
  expect(later.runs).toMatchObject({ purged: 1, skipped: [] });
  expect(held.jobs.get(ws, held.jobId)).toBeNull();
});
