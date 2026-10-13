import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import type { Application } from "./application.js";
import { isolationKey } from "./operations.js";
import {
  addWorkspace,
  memberSession,
  type OpsStack,
  opsStack,
  ownerSession,
  seedRun,
} from "./ops.testkit.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function ready(options: Parameters<typeof opsStack>[0] = {}): Promise<{
  stack: OpsStack;
  owner: Application;
  viewer: Application;
}> {
  const stack = await opsStack(options);
  cleanups.push(() => stack.cleanup());
  const owner = await ownerSession(stack);
  const viewer = await memberSession(stack, owner, "viewer-one", "viewer");
  return { stack, owner, viewer };
}
const db = (stack: OpsStack) => stack.application.controllerScope().database;
const total = (stack: OpsStack, sql: string, ...values: unknown[]): number =>
  Number(db(stack).get<{ n: number }>(sql, ...values)?.n);
async function failure(
  promise: Promise<unknown>,
): Promise<{ code?: string; details?: Record<string, unknown> }> {
  return promise.then(
    () => ({}),
    (error: { code?: string; details?: Record<string, unknown> }) => error,
  );
}

it("M4-02 pauses, drains and resumes Run admission for one workspace and leaves running work and other workspaces alone", async () => {
  const { stack, owner, viewer } = await ready();
  const otherId = addWorkspace(stack, "Other", "other-owner");
  const running = seedRun(stack, { createdAt: "2026-10-01T00:00:00.000Z" });

  owner.operations.admission({ action: "pause", reason: "maintenance window" });
  expect((await failure(owner.preflight())).details?.reasonCode).toBe("admission_paused");
  expect(owner.operations.status().admission).toMatchObject({
    state: "paused",
    reason: "maintenance window",
  });
  expect(
    (await failure(stack.application.forWorkspaceSystem(otherId).preflight())).details?.reasonCode,
  ).not.toBe("admission_paused");

  owner.operations.admission({ action: "drain", reason: "upgrade" });
  expect((await failure(owner.preflight())).details?.reasonCode).toBe("admission_draining");
  const drained = owner.operations.status();
  expect(drained.admission.state).toBe("draining");
  expect(drained.work).toMatchObject({ activeRuns: 1, drained: false });
  expect(
    total(
      stack,
      "SELECT COUNT(*) AS n FROM runs WHERE workspace_id=? AND id=? AND phase='running'",
      stack.workspaceId,
      running.runId,
    ),
  ).toBe(1);

  owner.operations.admission({ action: "resume", reason: "done" });
  expect((await failure(owner.preflight())).details?.reasonCode ?? "").not.toMatch(/^admission_/);
  expect(owner.operations.status().admission.state).toBe("enabled");
  expect(
    total(
      stack,
      "SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id=? AND action IN ('ops.admission.pause.allowed','ops.admission.drain.allowed','ops.admission.resume.allowed')",
      stack.workspaceId,
    ),
  ).toBe(3);
  expect(
    total(
      stack,
      "SELECT COUNT(*) AS n FROM outbox WHERE workspace_id=? AND type='ops.admission.changed'",
      stack.workspaceId,
    ),
  ).toBe(3);

  expect(() => viewer.operations.admission({ action: "pause", reason: "nope" })).toThrowError(
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
  expect(owner.operations.status().admission.state).toBe("enabled");
});

it("M4-02 previews reconciliation without changing state and records the applied pass", async () => {
  const { stack, owner, viewer } = await ready();
  const running = seedRun(stack, { createdAt: "2026-10-01T00:00:00.000Z" });
  const leaseBefore = db(stack).get(
    "SELECT state,lease_owner,lease_expires_at FROM job_leases WHERE workspace_id=? AND resource_id=?",
    stack.workspaceId,
    running.runId,
  );
  const preview = await owner.operations.reconcile({ mode: "preview" });
  expect(preview).toMatchObject({ kind: "reconcile", state: "completed" });
  expect(
    db(stack).get(
      "SELECT state,lease_owner,lease_expires_at FROM job_leases WHERE workspace_id=? AND resource_id=?",
      stack.workspaceId,
      running.runId,
    ),
  ).toEqual(leaseBefore);
  const applied = await owner.operations.reconcile({ mode: "apply", approval: "ops-ticket-1" });
  expect(applied.params).toMatchObject({ mode: "apply", approval: "ops-ticket-1" });
  expect(owner.operations.list().map((operation) => operation.id)).toEqual(
    expect.arrayContaining([preview.id, applied.id]),
  );
  expect(
    total(
      stack,
      "SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id=? AND action IN ('ops.reconcile.preview.allowed','ops.reconcile.apply.allowed')",
      stack.workspaceId,
    ),
  ).toBe(2);
  await expect(viewer.operations.reconcile({ mode: "apply" })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});

it("M4-02 queues one backup request at a time for org owners only and refuses an unconfigured deployment", async () => {
  const { stack, owner } = await ready();
  const admin = await memberSession(stack, owner, "admin-one", "org_admin");
  const first = owner.operations.requestBackup("nightly check");
  const second = owner.operations.requestBackup("again");
  expect(first).toMatchObject({ kind: "backup", state: "requested" });
  expect(second.id).toBe(first.id);
  expect(
    total(
      stack,
      "SELECT COUNT(*) AS n FROM admin_operations WHERE workspace_id=? AND kind='backup'",
      stack.workspaceId,
    ),
  ).toBe(1);
  expect(() => admin.operations.requestBackup("not an owner")).toThrowError(
    expect.objectContaining({ code: "FORBIDDEN", details: { reason: "owner_required" } }),
  );
  expect(() =>
    admin.operations.requestRestoreVerification({ backupId: "bkp_x", reason: "r" }),
  ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  const verify = owner.operations.requestRestoreVerification({
    backupId: "bkp_x",
    reason: "drill",
  });
  expect(verify).toMatchObject({
    kind: "restore_verify",
    state: "requested",
    params: { backupId: "bkp_x" },
  });

  const bare = await ready({ backup: false });
  expect(() => bare.owner.operations.requestBackup("no destination")).toThrowError(
    expect.objectContaining({
      code: "PRECONDITION_FAILED",
      details: expect.objectContaining({ reasonCode: "backup_not_configured" }),
    }),
  );
});

it("OPS-025 M4-02 restore isolation stays until the review is confirmed and the owner releases it", async () => {
  const { stack, owner, viewer } = await ready();
  expect(owner.operations.isolated()).toBe(false);
  expect(() => owner.operations.releaseIsolation("nothing to release")).toThrowError(
    expect.objectContaining({ details: { reasonCode: "not_isolated" } }),
  );
  db(stack).run("INSERT INTO operational_state(key,value) VALUES(?,?)", isolationKey, "true");
  db(stack).run("INSERT INTO operational_state(key,value) VALUES('restore_review','pending')");
  expect(owner.operations.isolated()).toBe(true);
  expect(owner.operations.status().isolation).toEqual({ isolated: true, review: "pending" });
  expect(() => owner.operations.releaseIsolation("too early")).toThrowError(
    expect.objectContaining({ details: { reasonCode: "restore_review_pending" } }),
  );
  db(stack).run(
    "UPDATE operational_state SET value='operator_confirmed' WHERE key='restore_review'",
  );
  expect(() => viewer.operations.releaseIsolation("viewer")).toThrowError(
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
  expect(owner.operations.isolated()).toBe(true);
  expect(owner.operations.releaseIsolation("reviewed restore")).toMatchObject({
    kind: "isolation_release",
    result: { integrationsStayPaused: true },
  });
  expect(owner.operations.isolated()).toBe(false);
});

function emptyResult() {
  const sha = "a".repeat(40);
  return {
    schemaVersion: "1.0.0" as const,
    kind: "empty" as const,
    batchId: null,
    gate: "not_applicable" as const,
    exitCode: 0,
    counts: { passed: 0, failed: 0, blocked: 0, cancelled: 0, inconclusive: 0, inFlight: 0 },
    provenance: {
      assessedSha: sha,
      checkoutSha: sha,
      binding: "verified" as const,
      targetBinding: "local-checkout" as const,
    },
    selection: {
      requested: 0,
      excluded: [],
      emptyReason: "No applicable tests",
      quarantinePolicy: "exclude" as const,
    },
    outputs: { report: null, junit: null, summary: null, bundleIndex: null },
    bundles: [],
    reportHash: "b".repeat(64),
    error: null,
  };
}

it("M4-02 lists dead-lettered deliveries and auxiliary jobs and requeues one without rerunning anything", async () => {
  const { stack, owner, viewer } = await ready();
  const rejecting = createServer((_request, response) => {
    response.statusCode = 401;
    response.end("{}");
  });
  rejecting.listen(0, "127.0.0.1");
  await once(rejecting, "listening");
  cleanups.push(async () => {
    rejecting.close();
    await once(rejecting, "close");
  });
  const address = rejecting.address();
  if (!address || typeof address === "string") throw new Error("HTTP listener missing");
  await stack.workspace.delivery.publish(emptyResult(), "owner/repo", "a".repeat(40), "test", {
    apiUrl: `http://127.0.0.1:${address.port}`,
  });
  db(stack).run(
    "INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,state,available_at,fence,attempts,data_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
    stack.workspaceId,
    "job_aux_dead",
    "2026-10-01T00:00:00.000Z",
    "analysis",
    "res_aux",
    "completed",
    "2026-10-01T00:00:00.000Z",
    1,
    3,
    JSON.stringify({
      payload: {},
      progress: {},
      result: { state: "dead_letter", reason: "attempts_exhausted" },
    }),
  );
  // Not an auxiliary queue: it cannot be requeued this way, so it must not be offered.
  db(stack).run(
    "INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,state,available_at,fence,attempts,data_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
    stack.workspaceId,
    "job_other_dead",
    "2026-10-01T00:00:00.000Z",
    "cleanup",
    "res_other",
    "completed",
    "2026-10-01T00:00:00.000Z",
    1,
    1,
    JSON.stringify({ payload: {}, progress: {}, result: { state: "dead_letter" } }),
  );
  const entries = owner.operations.dlq();
  expect(entries.filter((entry) => entry.source === "delivery")).toHaveLength(2);
  expect(entries.filter((entry) => entry.source === "auxiliary")).toHaveLength(1);
  expect(entries.find((entry) => entry.source === "auxiliary")).toMatchObject({
    id: "job_aux_dead",
    attempts: 3,
    subject: "analysis",
  });
  const runsBefore = total(
    stack,
    "SELECT COUNT(*) AS n FROM runs WHERE workspace_id=?",
    stack.workspaceId,
  );

  const target = entries.find((entry) => entry.source === "delivery");
  expect(owner.operations.requeue({ source: "delivery", id: String(target?.id) })).toMatchObject({
    state: "requeued",
  });
  expect(owner.operations.dlq().filter((entry) => entry.source === "delivery")).toHaveLength(1);
  owner.operations.requeue({ source: "auxiliary", id: "job_aux_dead" });
  expect(
    db(stack).get(
      "SELECT state FROM job_leases WHERE workspace_id=? AND id='job_aux_dead'",
      stack.workspaceId,
    )?.state,
  ).toBe("queued");
  expect(
    total(stack, "SELECT COUNT(*) AS n FROM runs WHERE workspace_id=?", stack.workspaceId),
  ).toBe(runsBefore);

  expect(() => owner.operations.requeue({ source: "delivery", id: "dlv_missing" })).toThrowError(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  expect(() => owner.operations.requeue({ source: "nowhere", id: "x" })).toThrowError(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  expect(() =>
    viewer.operations.requeue({ source: "delivery", id: String(target?.id) }),
  ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  const otherId = addWorkspace(stack, "Other", "other-owner");
  expect(stack.application.forWorkspaceSystem(otherId).operations.dlq()).toEqual([]);
});
