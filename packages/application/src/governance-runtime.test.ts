import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sandbox from "@testmaster/sandbox";
import { afterEach, expect, it, vi } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";
import { OperationalLogger } from "./observability.js";
import { localHandshake, supportsQueuedRun } from "./worker-handshake.js";

// Polling is not under test; dispatch observes its durable queue before the abort signal.
vi.mock("node:timers/promises", () => ({ setTimeout: async () => {} }));

const roots: string[] = [];
const applications: Application[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const app of applications.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tm-governance-"));
  roots.push(root);
  await mkdir(join(root, "home"));
  const app = await Application.open({
    cwd: root,
    home: join(root, "home"),
    env: {},
    correlationId: "ops-runtime-acceptance",
  });
  applications.push(app);
  const init = await app.init();
  return { app, init };
}
async function imageLock() {
  return sandbox.readImageLock(
    new URL("../../../containers/images.lock.json", import.meta.url).pathname,
  );
}
it("opens only migrated storage and degrades browser readiness without declaring HTTP unavailable", async () => {
  const { app } = await fixture();
  vi.spyOn(sandbox, "verifyImageLock").mockResolvedValue(await imageLock());
  vi.spyOn(sandbox.DockerExecutor.prototype, "doctor").mockImplementation(async (options) => ({
    available: !options,
    mode: "rootful",
    seccomp: true,
    cgroupVersion: "2",
    diagnostics: options ? ["browser_sandbox_unavailable"] : [],
  }));
  const readiness = await app.readiness();
  expect(readiness).toMatchObject({
    status: "ready",
    components: { persistence: "ready", admission: "ready" },
    worker: {
      status: "degraded",
      runners: {
        http: { status: "ready" },
        playwright: { status: "unavailable" },
        python: { status: "ready" },
      },
    },
  });
  expect(app.database.status().pending).toEqual([]);
  expect(
    app.database.get("SELECT value FROM operational_state WHERE key='readiness:probe'"),
  ).toBeDefined();
  expect(JSON.stringify(readiness)).not.toContain(app.config.dataDir);
  app.database.run("UPDATE operational_state SET value='suspended_manual' WHERE key='admission'");
  expect((await app.readiness()).status).toBe("unavailable");
});
it("an old local worker advertises real digests but never claims a queued action it does not understand", async () => {
  const { app, init } = await fixture();
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  vi.spyOn(app, "preflight").mockResolvedValue();
  const lock = await imageLock();
  vi.spyOn(app, "images").mockResolvedValue(lock);
  vi.spyOn(sandbox.DockerExecutor.prototype, "listOrphans").mockResolvedValue([]);
  const receipt = await app.runs.admit(
    { testId: test.id, environmentId: init.environmentId },
    { wait: true },
  );
  const handshake = localHandshake(lock);
  handshake.runnerVersion = "0.0.1";
  handshake.actions = handshake.actions.filter((action) => action !== "request");
  const controller = new AbortController();
  const finished = Promise.withResolvers<void>();
  const originalAll = app.database.all.bind(app.database);
  vi.spyOn(app.database, "all").mockImplementation((sql, ...params) => {
    const rows = originalAll(sql, ...params);
    if (sql.includes("SELECT r.id FROM runs") && sql.includes("j.state='queued'")) {
      controller.abort();
      finished.resolve();
    }
    return rows;
  });
  const running = app.worker.run({
    signal: controller.signal,
    handshake,
    capacity: {
      cpu: 16,
      memoryBytes: 17179869184,
      pids: 1024,
      diskBytes: 10737418240,
      pools: { browser: 2, http: 4, python: 1 },
    },
  });
  await finished.promise;
  await running;
  vi.useRealTimers();
  expect(app.runs.get(receipt.runId).phase).toBe("queued");
  expect(app.database.all("SELECT id FROM attempts WHERE run_id=?", receipt.runId)).toEqual([]);
  expect(
    app.database.get("SELECT state FROM job_leases WHERE resource_id=?", receipt.runId)?.state,
  ).toBe("queued");
  const worker = app.worker.status().at(-1);
  if (!worker) throw new Error("Missing worker acceptance record");
  expect(worker.imageDigests).toEqual(Object.values(lock).map((image) => image.imageId));
  expect(worker.labels).toMatchObject({ runnerVersion: "0.0.1", schemaVersions: '["1.0.0"]' });
  const accepted = app.runs.events(receipt.runId).find((event) => event.type === "run.accepted");
  if (!accepted) throw new Error("Missing admitted event acceptance record");
  expect(accepted.payload).toHaveProperty("correlationId", "ops-runtime-acceptance");
});
it("propagates one correlation through durable admission and attempt logs without serializing secret fields", async () => {
  const { app, init } = await fixture();
  vi.spyOn(app, "preflight").mockResolvedValue();
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  const identity = {
    principalId: init.principalId,
    scopes: ["R", "W", "X", "A"] as ("R" | "W" | "X" | "A")[],
  };
  const scoped = app.withIdentity(identity, "incident-test-123");
  vi.spyOn(scoped, "preflight").mockResolvedValue();
  const receipt = await scoped.runs.admit(
    { testId: test.id, environmentId: init.environmentId },
    { wait: true },
  );
  const run = scoped.runs.get(receipt.runId);
  expect(run.matrixCell).toHaveProperty("correlationId", "incident-test-123");
  expect(
    scoped.runs.events(receipt.runId).filter((event) => event.type === "run.accepted")[0]?.payload,
  ).toHaveProperty("correlationId", "incident-test-123");
  const logger = new OperationalLogger(join(app.config.dataDir, "correlation-logs"), 14, () =>
    Date.parse("2026-10-05T12:00:00Z"),
  );
  logger.record({
    component: "worker",
    event: "attempt.started",
    correlationId: "incident-test-123",
    runId: receipt.runId,
    ...{ secret: "do-not-log-canary" },
  });
  await logger.flush();
  const log = await readFile(join(logger.root, "2026-10-05.0.jsonl"), "utf8");
  expect(log).toContain("incident-test-123");
  expect(log).toContain(receipt.runId);
  expect(log).not.toContain("do-not-log-canary");
});

it("allows the local admin to drain and stop while refusing a viewer without changing worker state", async () => {
  const { app, init } = await fixture();
  const worker = {
    id: "wrk_00000000-0000-4000-8000-000000000001",
    workspaceId: app.context.workspaceId,
    createdAt: new Date().toISOString(),
    version: 1,
    identityRef: "local-tabletop",
    capabilities: ["http"],
    imageDigests: [],
    labels: {},
    state: "ready",
    lastHeartbeatAt: new Date().toISOString(),
  };
  app.context.entities.insert("Worker", worker);
  const viewer = app.withIdentity({ principalId: init.principalId, scopes: ["R"] });
  expect(() => viewer.worker.drain()).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  expect(() => viewer.worker.stop()).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  expect(app.database.get("SELECT state FROM workers WHERE id=?", worker.id)?.state).toBe("ready");
  expect(app.worker.drain()).toEqual({ requested: true });
  expect(app.database.get("SELECT state FROM workers WHERE id=?", worker.id)?.state).toBe(
    "draining",
  );
  expect(app.worker.stop()).toEqual({ requested: true });
  expect(app.database.all("SELECT id FROM outbox WHERE type='worker.stop_requested'")).toHaveLength(
    1,
  );
});

it("refuses future executable schemas and an absent image before claim", async () => {
  const { app, init } = await fixture();
  const plan = scaffoldPlan("backend");
  const test = app.tests.create({ projectId: init.projectId, plan });
  vi.spyOn(app, "preflight").mockResolvedValue();
  const receipt = await app.runs.admit(
    { testId: test.id, environmentId: init.environmentId },
    { wait: true },
  );
  const run = app.runs.get(receipt.runId);
  const revision = app.revisions.get(String(test.activeRevisionId));
  const lock = await imageLock();
  const handshake = localHandshake(lock);
  expect(supportsQueuedRun(handshake, run, revision, lock)).toBe(true);
  expect(
    supportsQueuedRun(
      handshake,
      run,
      { ...revision, plan: { ...plan, schemaVersion: "2.0.0" } },
      lock,
    ),
  ).toBe(false);
  expect(supportsQueuedRun({ ...handshake, imageDigests: [] }, run, revision, lock)).toBe(false);
  expect(app.database.all("SELECT id FROM attempts WHERE run_id=?", run.id)).toEqual([]);
});
