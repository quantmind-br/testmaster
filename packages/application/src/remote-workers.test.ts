import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError, type RemoteClaimInput } from "@testmaster/contracts";
import { LeaseRepository } from "@testmaster/persistence";
import { afterEach, expect, it } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";
import { localHandshake } from "./worker-handshake.js";

const roots: string[] = [];
const apps: Application[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function open() {
  const root = await mkdtemp(join(tmpdir(), "tm-remote-workers-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home, env: {} });
  apps.push(app);
  const init = await app.init();
  app.preflight = async () => {};
  return { app, init };
}

async function admit(app: Application, init: { projectId: string; environmentId: string }) {
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  const receipt = await app.runs.admit(
    {
      testId: test.id,
      environmentId: init.environmentId,
      extensions: { "testmaster:executor": "process" },
    },
    { wait: true },
  );
  return receipt.runId;
}

async function claimInput(app: Application): Promise<RemoteClaimInput> {
  return {
    handshake: localHandshake(await app.lockedImages()),
    capacity: {
      cpu: 4,
      memoryBytes: 8 * 1024 ** 3,
      pids: 1024,
      diskBytes: 100 * 1024 ** 3,
      pools: { browser: 2, http: 2, python: 2, terminal: 2 },
    },
    slots: 2,
    state: "ready",
    architecture: "x64",
    os: "linux",
  };
}

/** Enrolls a private remote worker and answers the caller its credential identifies. */
function enrolled(app: Application, name: string, labels?: Record<string, string>) {
  const { enrollmentToken } = app.workerPool.createEnrollment({
    name,
    ...(labels ? { labels } : {}),
  });
  app.remoteWorkers.enroll(enrollmentToken);
  return app.remoteWorkers.identify(enrollmentToken, null);
}

async function refusal(call: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await call();
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    return { code: error.code, reasonCode: error.details.reasonCode };
  }
  throw new Error("the call was accepted");
}

async function* bytes(text: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(text);
}

it("M5-01 a remote worker whose lease expired publishes nothing: upload, heartbeat and finalize are refused with lease_lost and the Run is reclaimed", async () => {
  const { app, init } = await open();
  const runId = await admit(app, init);
  const stale = enrolled(app, "stale");
  const claim = await app.remoteWorkers.claim(stale, await claimInput(app));
  const attempt = claim.attempt;
  if (!attempt) throw new Error("the admitted Run was not claimed");
  expect(attempt.runId).toBe(runId);

  // Positive control: while the lease is current, the same upload is accepted.
  await expect(
    app.remoteWorkers.uploadBundleFile(stale, attempt.attemptId, "meta.json", bytes("{}")),
  ).resolves.toMatchObject({ path: "meta.json", sizeBytes: 2 });

  // The worker is partitioned: its lease passes and the reconciler requeues the Run.
  new LeaseRepository(app.database).expire(new Date(Date.now() + 60_000).toISOString());
  app.worker.settleLeases();

  const lost = { code: "PRECONDITION_FAILED", reasonCode: "lease_lost" };
  expect(
    await refusal(() =>
      app.remoteWorkers.uploadBundleFile(stale, attempt.attemptId, "manifest.json", bytes("{}")),
    ),
  ).toEqual(lost);
  expect(await refusal(() => app.remoteWorkers.heartbeat(stale, attempt.attemptId))).toEqual(lost);
  expect(
    await refusal(() =>
      app.remoteWorkers.finalize(stale, attempt.attemptId, {
        result: {
          outcome: "passed",
          reasonCode: "assertions_satisfied",
          logDropped: 0,
          events: [],
          bundle: { manifestSha256: "a".repeat(64), files: [] },
        },
      }),
    ),
  ).toEqual(lost);
  // Nothing was published for the stale Attempt, and its staged upload is gone.
  const runDir = join(app.config.dataDir, "runs", init.workspaceId, runId);
  expect(await readdir(runDir).catch(() => [])).not.toContain(attempt.attemptId);
  const staging = join(app.config.dataDir, "staging", init.workspaceId, runId);
  expect(
    (await readdir(staging).catch(() => [] as string[])).filter((name) =>
      name.startsWith(attempt.attemptId),
    ),
  ).toEqual([]);

  // Another worker reclaims the Run under a new fence.
  const healthy = enrolled(app, "healthy");
  const second = await app.remoteWorkers.claim(healthy, await claimInput(app));
  expect(second.attempt?.runId).toBe(runId);
  expect(second.attempt?.attemptId).not.toBe(attempt.attemptId);
});

it("M5-01 an environment's worker selector places its Runs only on workers carrying every selected label", async () => {
  const { app, init } = await open();
  const environment = app.environments.get(init.environmentId);
  app.environments.update(
    environment.id,
    { workerSelector: { pool: "gpu" } },
    Number(environment.version),
  );
  const runId = await admit(app, init);
  const other = enrolled(app, "other", { pool: "cpu" });
  const unlabelled = enrolled(app, "plain");
  const matching = enrolled(app, "match", { pool: "gpu", zone: "eu" });

  expect((await app.remoteWorkers.claim(other, await claimInput(app))).attempt).toBeNull();
  expect((await app.remoteWorkers.claim(unlabelled, await claimInput(app))).attempt).toBeNull();
  expect((await app.remoteWorkers.claim(matching, await claimInput(app))).attempt?.runId).toBe(
    runId,
  );
});
