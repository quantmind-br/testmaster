import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuxiliaryLeaseRepository } from "@testmaster/persistence";
import * as sandbox from "@testmaster/sandbox";
import { afterEach, expect, it, vi } from "vitest";
import { Application } from "./index.js";

const directories: string[] = [];
const applications: Application[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const application of applications.splice(0)) application.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function open() {
  const directory = await mkdtemp(join(tmpdir(), "tm-worker-aux-"));
  directories.push(directory);
  const application = await Application.open({ cwd: directory, home: directory, env: {} });
  applications.push(application);
  const init = await application.init();
  return { application, init };
}
/** A diagnosis job in the shared job table, as a CLI process leaves it while a model call runs. */
function analysisJob(application: Application, workspaceId: string) {
  return new AuxiliaryLeaseRepository(application.database).enqueue(workspaceId, "analysis", {
    operation: "diagnose",
    targetId: "run_not_a_job_resource",
    actorId: "principal",
    evidenceHash: "a".repeat(64),
    configHash: "b".repeat(64),
    options: {},
  }).job;
}

it("a leased diagnosis job held by another process does not make the worker treat it as a Run", async () => {
  const { application, init } = await open();
  const lock = await sandbox.readImageLock(
    new URL("../../../containers/images.lock.json", import.meta.url).pathname,
  );
  vi.spyOn(application, "images").mockResolvedValue(lock);
  vi.spyOn(sandbox.DockerExecutor.prototype, "listOrphans").mockResolvedValue([]);
  const job = analysisJob(application, init.workspaceId);
  const claimed = new AuxiliaryLeaseRepository(application.database).claim({
    workspaceId: init.workspaceId,
    owner: "another-process",
    queue: "analysis",
    jobId: job.jobId,
  });
  expect(claimed?.job.state).toBe("leased");
  const controller = new AbortController();
  const running = application.worker.run({ signal: controller.signal });
  // The registered worker heartbeats once per scheduling pass: several distinct heartbeats prove
  // it scheduled repeatedly while the lease was held. A worker that stops on its own rejects here.
  const heartbeats = new Set<unknown>();
  const ticked = vi.waitFor(
    () => {
      heartbeats.add(application.worker.status().at(-1)?.lastHeartbeatAt);
      heartbeats.delete(undefined);
      expect(heartbeats.size).toBeGreaterThanOrEqual(4);
    },
    { timeout: 10_000, interval: 25 },
  );
  await Promise.race([
    ticked,
    running.then(() => {
      throw new Error("The worker stopped while only an auxiliary lease was held");
    }),
  ]);
  expect(application.worker.status().at(-1)).toMatchObject({ state: "ready" });
  controller.abort();
  await expect(running).resolves.toMatchObject({ drained: true });
  expect(application.worker.status().at(-1)).toMatchObject({ state: "offline" });
  expect(
    application.database.get(
      "SELECT state,fence,lease_owner FROM job_leases WHERE id=?",
      job.jobId,
    ),
  ).toMatchObject({ state: "leased", fence: claimed?.fence, lease_owner: "another-process" });
});

it("worker maintenance leaves an auxiliary job needing settlement to its owning service", async () => {
  const { application, init } = await open();
  const job = analysisJob(application, init.workspaceId);
  application.database.run(
    "UPDATE job_leases SET state='reconciliation_required' WHERE workspace_id=? AND id=?",
    init.workspaceId,
    job.jobId,
  );
  const dry = (await application.worker.reconcile({ dryRun: true })) as {
    actions: unknown[];
  };
  expect(dry.actions).toEqual([]);
  await expect(application.worker.reconcile()).resolves.toMatchObject({
    expired: [],
    orphanStaging: 0,
  });
  expect(
    application.database.get("SELECT state,fence FROM job_leases WHERE id=?", job.jobId),
  ).toMatchObject({ state: "reconciliation_required", fence: job.fence });
});

it("a Run job whose Run is missing remains an explicit NOT_FOUND failure", async () => {
  const { application, init } = await open();
  application.database.run(
    "INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,state,available_at,fence) VALUES(?,?,?,?,?,?,?,1)",
    init.workspaceId,
    "job_orphaned_run",
    new Date().toISOString(),
    "local",
    "run_does_not_exist",
    "reconciliation_required",
    new Date().toISOString(),
  );
  await expect(application.worker.reconcile()).rejects.toMatchObject({ code: "NOT_FOUND" });
});
