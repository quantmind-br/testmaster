import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { LeaseRepository } from "@testmaster/persistence";
import { afterEach, describe, expect, it } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";
import { fairShareCap } from "./worker-pool.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function open() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-worker-pool-"));
  const app = await Application.open({ cwd, home: cwd });
  cleanups.push(async () => {
    app.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const init = await app.init();
  const environmentRevisionId = app.environments.get(init.environmentId).activeRevisionId;
  return { app, workspaceId: init.workspaceId, projectId: init.projectId, environmentRevisionId };
}
function codeOf(call: () => unknown): string | undefined {
  try {
    call();
    return undefined;
  } catch (error) {
    return error instanceof ContractError ? error.code : "NOT_A_CONTRACT_ERROR";
  }
}
function markReady(app: Application, workerId: string): void {
  app.database.run(
    "UPDATE workers SET state='ready' WHERE workspace_id=? AND id=?",
    app.context.workspaceId,
    workerId,
  );
}
interface Fixture {
  app: Application;
  workspaceId: string;
  projectId: string;
  environmentRevisionId: string;
}
function enqueue(
  { app, workspaceId, projectId, environmentRevisionId }: Fixture,
  count: number,
): void {
  const leases = new LeaseRepository(app.database);
  const test = app.tests.create({ projectId, plan: scaffoldPlan("backend") });
  app.database.withTx(() => {
    for (let index = 0; index < count; index++) {
      const runId = uuidV7IdGenerator.next("run");
      app.context.entities.insert("Run", {
        id: runId,
        workspaceId,
        testId: test.id,
        revisionId: test.activeRevisionId,
        environmentRevisionId: environmentRevisionId,
        batchId: null,
        matrixCell: {},
        mode: "replay",
        phase: "queued",
        status: "queued",
        outcome: null,
        origin: "pool-test",
        gatePolicy: {},
        gate: "pending",
        cleanupOutcome: "not_required",
        analysisStatus: "not_requested",
      });
      leases.enqueue(workspaceId, runId, "local");
    }
  });
}

describe("REQ-038 M4-08 enrollment, drain and revoke of pool workers", () => {
  it("REQ-038 an enrollment token enrolls one worker, resumes it on re-presentation and is refused when wrong or revoked", async () => {
    const { app, workspaceId } = await open();
    const created = app.workerPool.createEnrollment({ name: "w1" });
    expect(created.worker.state).toBe("enrolling");
    expect(created.enrollmentToken).toMatch(/^tm_wrk_/u);

    const controller = app.controllerScope().workerPool;
    const first = controller.enroll(created.enrollmentToken);
    expect(first).toEqual({
      workspaceId,
      workerId: created.worker.id,
      resumed: false,
      shared: false,
    });
    // Presenting the same token again resumes the same identity rather than minting another worker.
    expect(controller.enroll(created.enrollmentToken)).toMatchObject({
      workerId: created.worker.id,
      resumed: true,
    });
    expect(app.workerPool.list()).toHaveLength(1);

    // Negative controls: an unknown token is refused, and revoking blocks resumption.
    expect(codeOf(() => controller.enroll(`tm_wrk_${"A".repeat(43)}`))).toBe("UNAUTHENTICATED");
    // An enrollment token past its expiry is refused although it was never revoked.
    const late = app.workerPool.createEnrollment({ name: "late" });
    app.database.run(
      "UPDATE server_tokens SET expires_at=? WHERE workspace_id=? AND token_hash=?",
      new Date(Date.now() - 1_000).toISOString(),
      workspaceId,
      createHash("sha256").update(late.enrollmentToken).digest("hex"),
    );
    expect(codeOf(() => controller.enroll(late.enrollmentToken))).toBe("UNAUTHENTICATED");
    app.workerPool.revoke(created.worker.id);
    expect(codeOf(() => controller.enroll(created.enrollmentToken))).toBe("UNAUTHENTICATED");
  });

  it("M4-08 a revoked or draining worker receives no claim while a ready worker does, and revoke fences its leased job", async () => {
    const fixture = await open();
    const { app, workspaceId } = fixture;
    const leases = new LeaseRepository(app.database);
    const ready = app.workerPool.createEnrollment({ name: "ready" }).worker;
    const doomed = app.workerPool.createEnrollment({ name: "doomed" }).worker;
    markReady(app, ready.id);
    markReady(app, doomed.id);
    enqueue(fixture, 3);

    const held = leases.claim({
      workspaceId,
      owner: "doomed",
      queue: "local",
      workerId: doomed.id,
    });
    expect(held).not.toBeNull();
    app.workerPool.revoke(doomed.id);
    expect(
      leases.claim({ workspaceId, owner: "doomed", queue: "local", workerId: doomed.id }),
    ).toBeNull();
    const fenced = app.database.get(
      "SELECT state FROM job_leases WHERE workspace_id=? AND resource_id=?",
      workspaceId,
      held?.runId,
    );
    expect(fenced?.state).toBe("reconciliation_required");

    // Draining stops new claims too; the ready worker keeps receiving them.
    app.workerPool.drain(ready.id);
    expect(
      leases.claim({ workspaceId, owner: "ready", queue: "local", workerId: ready.id }),
    ).toBeNull();
    const other = app.workerPool.createEnrollment({ name: "other" }).worker;
    markReady(app, other.id);
    expect(
      leases.claim({ workspaceId, owner: "other", queue: "local", workerId: other.id }),
    ).not.toBeNull();
  });

  it("REQ-038 a ready worker whose heartbeat stopped is marked offline once and announced on the outbox", async () => {
    const { app, workspaceId } = await open();
    const worker = app.workerPool.createEnrollment({ name: "quiet" }).worker;
    app.database.run(
      "UPDATE workers SET state='ready', last_heartbeat_at=? WHERE workspace_id=? AND id=?",
      new Date(Date.now() - 120_000).toISOString(),
      workspaceId,
      worker.id,
    );
    expect(app.workerPool.sweepOffline()).toEqual([worker.id]);
    expect(app.workerPool.sweepOffline()).toEqual([]);
    expect(app.workerPool.get(worker.id).state).toBe("offline");
    expect(
      app.database.all(
        "SELECT id FROM outbox WHERE workspace_id=? AND type='worker.offline'",
        workspaceId,
      ),
    ).toHaveLength(1);
  });
});

describe("REQ-038 an enrolled worker heartbeats its lease with its own credential", () => {
  async function leased() {
    const fixture = await open();
    const { app, workspaceId } = fixture;
    const created = app.workerPool.createEnrollment({ name: "beating" });
    const controller = app.controllerScope().workerPool;
    controller.enroll(created.enrollmentToken);
    markReady(app, created.worker.id);
    enqueue(fixture, 1);
    const claim = new LeaseRepository(app.database).claim({
      workspaceId,
      owner: "beating",
      queue: "local",
      workerId: created.worker.id,
    });
    if (!claim) throw new Error("Expected a claim");
    return { ...fixture, created, controller, claim };
  }

  it("REQ-038 a heartbeat renews the held lease, records liveness and answers the worker document", async () => {
    const { app, workspaceId, created, controller, claim } = await leased();
    const before = app.database.get(
      "SELECT lease_expires_at FROM job_leases WHERE workspace_id=? AND id=?",
      workspaceId,
      claim.jobId,
    );
    const worker = controller.heartbeat(created.enrollmentToken, created.worker.id, {
      leaseId: claim.jobId,
      state: "ready",
      version: app.workerPool.get(created.worker.id).version as number,
    });
    expect(worker).toMatchObject({ id: created.worker.id, state: "ready" });
    const beat = app.database.get(
      "SELECT last_heartbeat_at FROM workers WHERE workspace_id=? AND id=?",
      workspaceId,
      created.worker.id,
    );
    expect(typeof beat?.last_heartbeat_at).toBe("string");
    const after = app.database.get(
      "SELECT lease_expires_at FROM job_leases WHERE workspace_id=? AND id=?",
      workspaceId,
      claim.jobId,
    );
    expect(String(after?.lease_expires_at) >= String(before?.lease_expires_at)).toBe(true);
  });

  it("REQ-038 a heartbeat is refused for a lost lease, a stale version, a draining override and a foreign or revoked credential", async () => {
    const { app, workspaceId, created, controller, claim } = await leased();
    const version = () => app.workerPool.get(created.worker.id).version as number;
    const beat = (state: "ready" | "draining", leaseId = claim.jobId, at = version()) =>
      controller.heartbeat(created.enrollmentToken, created.worker.id, {
        leaseId,
        state,
        version: at,
      });

    // Negative controls first: wrong lease, stale version.
    expect(codeOf(() => beat("ready", `job_${randomUUID()}`))).toBe("PRECONDITION_FAILED");
    expect(codeOf(() => beat("ready", claim.jobId, version() + 5))).toBe("REVISION_CONFLICT");

    // A lease that already expired was reclaimable, so the worker is told to stop rather than renew it.
    app.database.run(
      "UPDATE job_leases SET lease_expires_at=? WHERE workspace_id=? AND id=?",
      new Date(Date.now() - 1_000).toISOString(),
      workspaceId,
      claim.jobId,
    );
    expect(codeOf(() => beat("ready"))).toBe("PRECONDITION_FAILED");
    app.database.run(
      "UPDATE job_leases SET lease_expires_at=? WHERE workspace_id=? AND id=?",
      new Date(Date.now() + 60_000).toISOString(),
      workspaceId,
      claim.jobId,
    );

    // A worker reporting ready never undoes an administrator's drain.
    app.workerPool.drain(created.worker.id);
    expect(beat("ready")).toMatchObject({ state: "draining" });

    // Another worker's credential, an unenrolled token and a revoked worker are all refused.
    const stranger = app.workerPool.createEnrollment({ name: "stranger" });
    expect(
      codeOf(() =>
        controller.heartbeat(stranger.enrollmentToken, created.worker.id, {
          leaseId: claim.jobId,
          state: "ready",
          version: version(),
        }),
      ),
    ).toBe("UNAUTHENTICATED");
    // An enrolled worker still cannot heartbeat on behalf of another worker.
    const enrolledStranger = app.workerPool.createEnrollment({ name: "enrolled-stranger" });
    controller.enroll(enrolledStranger.enrollmentToken);
    expect(
      codeOf(() =>
        controller.heartbeat(enrolledStranger.enrollmentToken, created.worker.id, {
          leaseId: claim.jobId,
          state: "ready",
          version: version(),
        }),
      ),
    ).toBe("UNAUTHENTICATED");
    expect(
      codeOf(() =>
        controller.heartbeat(stranger.enrollmentToken, stranger.worker.id, {
          leaseId: claim.jobId,
          state: "ready",
          version: 1,
        }),
      ),
    ).toBe("UNAUTHENTICATED");
    app.workerPool.revoke(created.worker.id);
    expect(codeOf(() => beat("ready"))).toBe("UNAUTHENTICATED");
  });
});

describe("M4-08 REQ-038 worker administration needs the admin permission", () => {
  it("M4-08 REQ-038 a read-only identity can neither list, enroll, drain nor revoke workers while an administrator can", async () => {
    const { app } = await open();
    const created = app.workerPool.createEnrollment({ name: "admin-made" });
    const reader = app.forIdentity({ principalId: app.context.principalId, scopes: ["R"] });

    expect(app.workerPool.list()).toHaveLength(1);
    expect(app.workerPool.get(created.worker.id).id).toBe(created.worker.id);
    expect(codeOf(() => reader.workerPool.list())).toBe("FORBIDDEN");
    expect(codeOf(() => reader.workerPool.get(created.worker.id))).toBe("FORBIDDEN");
    expect(codeOf(() => reader.workerPool.createEnrollment({ name: "denied" }))).toBe("FORBIDDEN");
    expect(codeOf(() => reader.workerPool.drain(created.worker.id))).toBe("FORBIDDEN");
    expect(codeOf(() => reader.workerPool.revoke(created.worker.id))).toBe("FORBIDDEN");
    // Nothing the reader attempted changed the pool.
    expect(app.workerPool.list()).toHaveLength(1);
    expect(app.workerPool.get(created.worker.id).state).toBe("enrolling");
  });
});

describe("OPS-033 a tenant with thousands of queued jobs cannot starve another tenant", () => {
  it("OPS-033 fair share caps the flooding tenant while another waits and lifts the cap when nobody competes", async () => {
    const fixture = await open();
    const { app, workspaceId } = fixture;
    const worker = app.workerPool.createEnrollment({ name: "slots" }).worker;
    markReady(app, worker.id);
    const otherWorkspace = `ws_${randomUUID()}`;
    app.database.withTx(() => {
      app.context.entities.insert("Workspace", {
        id: otherWorkspace,
        workspaceId: otherWorkspace,
        name: "Other",
        mode: "single-user",
        settingsVersion: 1,
        quotaPolicyId: "local",
      });
    });
    const view = app.database.forWorkspace("*");
    enqueue(fixture, 2500);
    // Taken after the enqueue: on a slower engine inserting 2500 rows may outlast a clock read made before it.
    const now = new Date(Date.now() + 1_000);
    // Nobody competes yet: the busy tenant may use every slot.
    expect(fairShareCap({ database: view, workspaceId, now })).toBeUndefined();

    app.database.withTx(() =>
      new LeaseRepository(app.database).enqueue(otherWorkspace, `run_${randomUUID()}`, "local"),
    );
    const flooder = fairShareCap({ database: view, workspaceId, now });
    const newcomer = fairShareCap({ database: view, workspaceId: otherWorkspace, now });
    expect(flooder).toBe(1);
    expect(newcomer).toBe(1);

    // With the cap applied the flooder holds at most its share.
    const leases = new LeaseRepository(app.database);
    const first = leases.claim({
      workspaceId,
      owner: "a",
      queue: "local",
      workerId: worker.id,
      maxLeased: flooder ?? 1,
    });
    const second = leases.claim({
      workspaceId,
      owner: "a",
      queue: "local",
      workerId: worker.id,
      maxLeased: flooder ?? 1,
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});
