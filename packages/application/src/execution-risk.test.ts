import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecutionLimits, type RunnerEvent, validate } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import {
  ExecutionRepository,
  type Fence,
  LeaseRepository,
  StaleFenceError,
} from "@testmaster/persistence";
import { DockerExecutor } from "@testmaster/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Application, type PermissionGrant } from "./application.js";
import { scaffoldPlan } from "./authoring.js";

const roots: string[] = [];
const applications: Application[] = [];

beforeEach(() => {
  // Reconciliation is real; only unrelated host-container enumeration is isolated.
  vi.spyOn(DockerExecutor.prototype, "listOrphans").mockResolvedValue([]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of applications.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(limits?: ExecutionLimits) {
  const root = await mkdtemp(join(tmpdir(), "tm-execution-risk-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  if (limits) {
    const policyDirectory = join(home, ".config", "testmaster");
    await mkdir(policyDirectory, { recursive: true });
    await writeFile(join(policyDirectory, "policy.json"), JSON.stringify({ limits }), {
      mode: 0o600,
    });
  }
  const app = await Application.open({ cwd: root, home, env: {} });
  applications.push(app);
  const init = await app.init();
  const plan = scaffoldPlan("backend");
  const test = app.tests.create({ projectId: init.projectId, plan });
  // Admission unit boundary: this never executes a runner or fabricates a successful result.
  app.preflight = vi.fn(async () => {});
  const request = { testId: test.id, environmentId: init.environmentId };
  return { app, init, plan, test, request };
}

async function claimed() {
  const value = await fixture();
  const receipt = await value.app.runs.admit(value.request, { wait: true });
  const leases = new LeaseRepository(value.app.database);
  const fence = leases.claim({
    workspaceId: value.init.workspaceId,
    owner: "risk-test-worker",
    queue: "local",
    leaseMs: 60000,
    runIds: [receipt.runId],
  });
  if (!fence) throw new Error("The admitted run must be claimable");
  const execution = new ExecutionRepository(value.app.database);
  execution.progress(fence, "running");
  let seq = 0;
  const observe = (event: Pick<RunnerEvent, "type" | "payload">, malformed = false) => {
    const payload = {
      protocolVersion: "1.0.0",
      seq: seq++,
      attemptId: fence.attemptId,
      occurredAt: new Date().toISOString(),
      ...event,
    };
    if (!malformed) validate("RunnerEvent", payload);
    const accepted = execution.observe(fence, {
      id: uuidV7IdGenerator.next("evt"),
      seq: payload.seq,
      payload,
    });
    expect(accepted).toBe(true);
  };
  return { ...value, receipt, leases, fence, execution, observe };
}

function expire(app: Application, fence: Fence) {
  // Move only this persisted deadline; no sleeps, global fake clock, or private worker access.
  const changed = app.database.run(
    "UPDATE job_leases SET lease_expires_at=? WHERE workspace_id=? AND id=? AND fence=? AND state='leased'",
    "2000-01-01T00:00:00.000Z",
    fence.workspaceId,
    fence.jobId,
    fence.fence,
  );
  expect(changed.changes).toBe(1);
}

function stepFinished(
  stepId: string,
  index: number,
  status: "passed" | "failed" | "inconclusive" | "blocked",
): RunnerEvent["payload"] {
  return {
    stepId,
    index,
    status,
    durationMs: 1,
    evidencePaths: [],
    ...(status !== "passed"
      ? {
          reasonCode:
            status === "failed"
              ? ("assertion_mismatch" as const)
              : ("insufficient_evidence" as const),
        }
      : {}),
  };
}

function expectNoAdmission(app: Application) {
  expect(app.database.all("SELECT * FROM runs")).toEqual([]);
  expect(app.database.all("SELECT * FROM job_leases")).toEqual([]);
  expect(app.database.all("SELECT * FROM outbox")).toEqual([]);
  expect(app.database.all("SELECT * FROM idempotency_receipts")).toEqual([]);
}

function expectTerminal(app: Application, runId: string, outcome: "failed" | "inconclusive") {
  expect(app.runs.get(runId)).toMatchObject({
    phase: "completed",
    status: outcome,
    outcome,
    gate: "failed",
    cleanupOutcome: "inconclusive",
  });
  expect(
    app.database.get("SELECT state,attempts FROM job_leases WHERE resource_id=?", runId),
  ).toMatchObject({
    state: "completed",
    attempts: 1,
  });
  expect(app.runs.events(runId).filter((event) => event.type === "run.completed")).toHaveLength(1);
  expect(
    new LeaseRepository(app.database).claim({
      workspaceId: app.context.workspaceId,
      owner: "another-worker",
      queue: "local",
      runIds: [runId],
    }),
  ).toBeNull();
}

describe("persisted worker-loss reconciliation", () => {
  it.each(["resource.intent", "resource.created", "resource.uncertain"] as const)(
    "does not retry after accepted %s, even without a finished assertion",
    async (type) => {
      const { app, receipt, fence, execution, observe } = await claimed();
      observe({ type: "step.started", payload: { stepId: "get-health", index: 0 } });
      observe({
        type,
        payload: {
          resourceId: uuidV7IdGenerator.next("res"),
          resourceType: "http-mutation",
          correlationKey: "effect-risk",
          state:
            type === "resource.intent"
              ? "planned"
              : type === "resource.created"
                ? "created"
                : "uncertain",
        },
      });
      expire(app, fence);
      const result = await app.worker.reconcile();
      expect(result.expired).toEqual([fence.jobId]);
      expectTerminal(app, receipt.runId, "inconclusive");
      expect(app.runs.events(receipt.runId)).toContainEqual(
        expect.objectContaining({
          type: "run.completed",
          payload: expect.objectContaining({ reasonCode: "retry_unsafe_external_effect" }),
        }),
      );
      expect(() =>
        execution.observe(fence, { id: uuidV7IdGenerator.next("evt"), seq: 99, payload: {} }),
      ).toThrow(StaleFenceError);
      await app.worker.reconcile();
      expectTerminal(app, receipt.runId, "inconclusive");
    },
  );

  it.each(["passed", "failed", "inconclusive"] as const)(
    "does not retry after an accepted %s assertion, and preserves reliable failure",
    async (status) => {
      const { app, receipt, fence, observe } = await claimed();
      observe({ type: "step.started", payload: { stepId: "check-status", index: 1 } });
      observe({ type: "step.finished", payload: stepFinished("check-status", 1, status) });
      expire(app, fence);
      await app.worker.reconcile();
      expectTerminal(app, receipt.runId, status === "failed" ? "failed" : "inconclusive");
      expect(
        app.database.all("SELECT * FROM observations WHERE attempt_id=?", fence.attemptId),
      ).toHaveLength(2);
    },
  );

  it("cannot turn complete passed observations into a green run after losing its claim", async () => {
    const { app, plan, receipt, fence, observe } = await claimed();
    observe({ type: "step.started", payload: { stepId: "get-health", index: 0 } });
    plan.steps.forEach((step, index) => {
      observe({ type: "step.finished", payload: stepFinished(step.id, index, "passed") });
    });
    observe({
      type: "runner.finished",
      payload: { outcome: "passed", reasonCode: "assertions_satisfied" },
    });
    expire(app, fence);
    await app.worker.reconcile();
    expectTerminal(app, receipt.runId, "inconclusive");
  });

  it.each([false, true])(
    "resumes safe pre-effect loss (started=%s) on the same run with a new fenced attempt",
    async (started) => {
      const { app, request, receipt, fence, leases, execution, observe } = await claimed();
      if (started) {
        observe({ type: "step.started", payload: { stepId: "get-health", index: 0 } });
        observe({ type: "step.finished", payload: stepFinished("get-health", 0, "blocked") });
      }
      const pinned = app.runs.get(receipt.runId);
      expire(app, fence);
      await app.worker.reconcile();
      expect(app.runs.get(receipt.runId)).toMatchObject({
        phase: "running",
        outcome: null,
        gate: "pending",
      });
      expect(app.database.get("SELECT state FROM job_leases WHERE id=?", fence.jobId)?.state).toBe(
        "queued",
      );
      const next = leases.claim({
        workspaceId: app.context.workspaceId,
        owner: "replacement-worker",
        queue: "local",
        runIds: [receipt.runId],
      });
      expect(next).toMatchObject({
        jobId: fence.jobId,
        runId: receipt.runId,
        number: 2,
        fence: fence.fence + 1,
      });
      expect(next?.attemptId).not.toBe(fence.attemptId);
      expect(
        app.database.all(
          "SELECT id,number,outcome FROM attempts WHERE run_id=? ORDER BY number",
          receipt.runId,
        ),
      ).toEqual([
        { id: fence.attemptId, number: 1, outcome: "inconclusive" },
        { id: next?.attemptId, number: 2, outcome: null },
      ]);
      expect(app.runs.get(receipt.runId)).toMatchObject({
        revisionId: pinned.revisionId,
        environmentRevisionId: pinned.environmentRevisionId,
        matrixCell: pinned.matrixCell,
      });
      expect(app.runs.list()).toHaveLength(1);
      expect(app.runs.get(receipt.runId).testId).toBe(request.testId);
      expect(() => execution.progress(fence, "collecting")).toThrow(StaleFenceError);
      expect(
        app.runs.events(receipt.runId).filter((event) => event.type === "run.accepted"),
      ).toHaveLength(1);
      expect(
        app.runs.events(receipt.runId).filter((event) => event.type === "run.completed"),
      ).toEqual([]);
    },
  );

  it.each(["none", "passed", "failed"] as const)(
    "terminalizes a malformed runner-terminal outcome without losing preceding %s assertion evidence",
    async (preceding) => {
      const { app, plan, receipt, fence, observe } = await claimed();
      if (preceding !== "none") {
        observe({ type: "step.started", payload: { stepId: "get-health", index: 0 } });
        plan.steps.forEach((step, index) => {
          observe({
            type: "step.finished",
            payload: stepFinished(
              step.id,
              index,
              preceding === "failed" && step.id === "check-status" ? "failed" : "passed",
            ),
          });
        });
      }
      // Persistence accepts opaque observations; reconciliation must distrust their wire claims.
      observe(
        {
          type: "runner.finished",
          payload: { outcome: "green", reasonCode: "assertions_satisfied" },
        } as unknown as Pick<RunnerEvent, "type" | "payload">,
        true,
      );
      expire(app, fence);
      await app.worker.reconcile();
      expectTerminal(app, receipt.runId, preceding === "failed" ? "failed" : "inconclusive");
      expect(
        app.database.all("SELECT * FROM observations WHERE attempt_id=?", fence.attemptId),
      ).toHaveLength(preceding === "none" ? 1 : plan.steps.length + 2);
      await app.worker.reconcile();
      expectTerminal(app, receipt.runId, preceding === "failed" ? "failed" : "inconclusive");
    },
  );
});

describe("admission risk boundaries", () => {
  it("cannot broaden operator limit ceilings but retains a narrower caller limit", async () => {
    const ceilings = {
      maxAttempts: 1,
      executionTimeoutMs: 120000,
      attemptTimeoutMs: 60000,
      bodyBytes: 1024,
      artifactBytes: 2048,
    };
    const { app, request } = await fixture(ceilings);
    const receipt = await app.runs.admit(
      {
        ...request,
        limits: {
          maxAttempts: 2,
          executionTimeoutMs: 7200000,
          attemptTimeoutMs: 900000,
          bodyBytes: 4096,
          artifactBytes: 8192,
          stepTimeoutMs: 500,
        },
      },
      { wait: true },
    );
    expect(app.runs.get(receipt.runId).matrixCell).toMatchObject({
      limits: { ...ceilings, stepTimeoutMs: 500 },
    });
    expect(app.config.profilePolicy.limits).toMatchObject(ceilings);
  });

  it("pins the admitted environment snapshot across mutable updates and idempotent replay", async () => {
    const { app, init, request } = await fixture();
    const key = "environment-pin-risk-key";
    const receipt = await app.runs.admit(request, { wait: true, idempotencyKey: key });
    const pinned = app.runs.get(receipt.runId);
    const snapshot = app.context.entities.get(
      "EnvironmentRevision",
      init.workspaceId,
      receipt.environmentRevisionId,
    );
    const environment = app.environments.get(init.environmentId);
    const next = app.environments.update(
      environment.id,
      {
        baseUrl: "http://127.0.0.1:4100",
        locale: "pt-BR",
        timezone: "America/Sao_Paulo",
        name: "changed-after-admission",
      },
      environment.version ?? 1,
    );
    expect(next.activeRevisionId).not.toBe(receipt.environmentRevisionId);
    expect(
      app.context.entities.get(
        "EnvironmentRevision",
        init.workspaceId,
        receipt.environmentRevisionId,
      ),
    ).toEqual(snapshot);
    expect(app.runs.get(receipt.runId)).toEqual(pinned);
    expect(await app.runs.admit(request, { wait: true, idempotencyKey: key })).toEqual(receipt);
    const fresh = await app.runs.admit(request, {
      wait: true,
      idempotencyKey: "fresh-environment-risk-key",
    });
    expect(fresh.environmentRevisionId).toBe(next.activeRevisionId);
    expect(app.runs.get(fresh.runId).matrixCell).toMatchObject({
      baseUrl: "http://127.0.0.1:4100",
    });
  });

  it("admits a single durable unit under overlapping idempotent requests and rolls back conflicting reuse", async () => {
    const { app, request } = await fixture();
    const options = { wait: true, idempotencyKey: "overlapping-admission-risk-key" };
    const receipts = await Promise.all(
      Array.from({ length: 4 }, () => app.runs.admit(request, options)),
    );
    expect(receipts).toEqual(Array.from({ length: 4 }, () => receipts[0]));
    await expect(app.runs.admit({ ...request, seed: 7 }, options)).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(app.runs.list()).toHaveLength(1);
    expect(app.database.all("SELECT * FROM job_leases")).toHaveLength(1);
    expect(app.database.all("SELECT * FROM idempotency_receipts")).toHaveLength(1);
    expect(
      app.runs.events(receipts[0]!.runId).filter((event) => event.type === "run.accepted"),
    ).toHaveLength(1);
  });

  it("rejects another secret destination even when the environment has no auth profile", async () => {
    const { app, init, plan } = await fixture();
    const secret = await app.secrets.set("admission-token", "not-a-runner-result", {
      ephemeral: true,
      allowedOrigins: ["http://127.0.0.1:3000"],
    });
    const requestStep = plan.steps[0];
    if (!requestStep || requestStep.operation !== "request")
      throw new Error("Expected the HTTP scaffold request");
    requestStep.input.headers = { Authorization: { secretRef: secret.id } };
    const test = app.tests.create({ projectId: init.projectId, plan });
    const request = { testId: test.id, environmentId: init.environmentId };
    const environment = app.environments.get(init.environmentId);
    expect(
      app.context.entities.get(
        "EnvironmentRevision",
        init.workspaceId,
        environment.activeRevisionId,
      )?.authProfileRefs,
    ).toEqual([]);
    await expect(
      app.runs.admit(
        { ...request, extensions: { "testmaster:targetUrl": "https://unapproved.example/health" } },
        { wait: true },
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expectNoAdmission(app);
    const receipt = await app.runs.admit(
      { ...request, extensions: { "testmaster:targetUrl": "http://127.0.0.1:3000/health" } },
      { wait: true },
    );
    expect(app.runs.get(receipt.runId).matrixCell).toMatchObject({
      baseUrl: "http://127.0.0.1:3000",
    });
    expect(app.secrets.get(secret.id).allowedOrigins).toEqual(["http://127.0.0.1:3000"]);
  });

  it.each([false, true])(
    "a matching denied execute grant wins over owner role and an explicit allow (denyFirst=%s)",
    async (denyFirst) => {
      const { app, init, request } = await fixture();
      const allow: PermissionGrant = {
        resourceType: "Run",
        actions: ["execute"],
        projectIds: [init.projectId],
        environmentIds: [],
        expiresAt: null,
        grantedBy: init.principalId,
      };
      const denied = { ...allow, deny: true };
      const restricted = await Application.open({
        cwd: app.config.cwd,
        home: app.config.home,
        env: {},
        identity: {
          principalId: init.principalId,
          scopes: ["R", "W", "X", "A"],
          grants: denyFirst ? [denied, allow] : [allow, denied],
        },
      });
      applications.push(restricted);
      restricted.preflight = vi.fn(async () => {});
      expect(restricted.projects.get(init.projectId).id).toBe(init.projectId);
      await expect(restricted.runs.admit(request, { wait: true })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(restricted.preflight).not.toHaveBeenCalled();
      expectNoAdmission(restricted);
    },
  );
});
