import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { FileEvidenceStore } from "@testmaster/evidence";
import { afterEach, expect, it } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";

const apps: Application[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const files = [
  ["http/get-health.json", "http", "application/json"],
  ["logs/container.log", "log", "text/plain"],
  ["logs/egress.ndjson", "network", "application/x-ndjson"],
  ["snapshot/runtime.json", "snapshot", "application/json"],
] as const;

/** A committed attempt bundle of the four kinds a terminal HTTP run leaves, with no steps yet. */
async function seedRun(outcome: "passed" | "failed") {
  const root = await mkdtemp(join(tmpdir(), "tm-failed-only-"));
  roots.push(root);
  await mkdir(join(root, "home"));
  const app = await Application.open({ cwd: root, home: join(root, "home"), env: {} });
  apps.push(app);
  const init = await app.init();
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  const ids = {
    workspaceId: init.workspaceId,
    runId: uuidV7IdGenerator.next("run"),
    attemptId: uuidV7IdGenerator.next("att"),
    snapshotId: uuidV7IdGenerator.next("snp"),
    revisionId: String(test.activeRevisionId),
  };
  const now = new Date().toISOString();
  app.context.entities.insert("Run", {
    id: ids.runId,
    workspaceId: ids.workspaceId,
    createdAt: now,
    testId: test.id,
    revisionId: ids.revisionId,
    environmentRevisionId: app.environments.get(init.environmentId).activeRevisionId,
    batchId: null,
    matrixCell: {},
    mode: "replay",
    phase: "completed",
    status: outcome,
    outcome,
    origin: "failed-only-acceptance",
    gatePolicy: {},
    gate: outcome,
    cleanupOutcome: "not_required",
    analysisStatus: "not_requested",
  });
  const jobId = uuidV7IdGenerator.next("job");
  app.database.run(
    "INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,state,available_at,fence) VALUES(?,?,?,?,?,?,?,1)",
    ids.workspaceId,
    jobId,
    now,
    "execution",
    ids.runId,
    "completed",
    now,
  );
  app.context.entities.insert(
    "Attempt",
    {
      id: ids.attemptId,
      workspaceId: ids.workspaceId,
      createdAt: now,
      runId: ids.runId,
      number: 1,
      workerId: null,
      seed: 0,
      phase: "completed",
      startedAt: now,
      endedAt: now,
      outcome,
    },
    { jobId, fence: 1, leaseOwner: "failed-only-acceptance" },
  );
  const stage = await new FileEvidenceStore({ rootDir: app.config.dataDir }).openAttempt(ids);
  const refs: Record<string, { artifactId: string; relativePath: string }> = {};
  for (const [relativePath, kind, mimeType] of files) {
    const writer = await stage.beginArtifact({ relativePath, kind, mimeType });
    await writer.write(Buffer.from("{}"));
    const entry = await writer.end();
    refs[relativePath] = { artifactId: entry.artifactId, relativePath };
  }
  const committed = await stage.commit({ redactionPolicyHash: "0".repeat(64) });
  app.context.entities.insert("Snapshot", {
    id: ids.snapshotId,
    workspaceId: ids.workspaceId,
    createdAt: now,
    runId: ids.runId,
    attemptId: ids.attemptId,
    revisionId: ids.revisionId,
    manifestHash: committed.manifestSha256,
    committedAt: now,
    redactionPolicyHash: "0".repeat(64),
  });
  const addStep = (
    planStepId: string,
    index: number,
    status: "passed" | "failed",
    evidence: readonly string[],
  ) =>
    app.context.entities.insert("StepResult", {
      id: uuidV7IdGenerator.next("stp"),
      workspaceId: ids.workspaceId,
      attemptId: ids.attemptId,
      planStepId,
      index,
      status,
      ...(status === "passed" ? {} : { reasonCode: "assertion_mismatch" }),
      expected: 200,
      observed: status === "passed" ? 200 : 401,
      error: null,
      durationMs: 1,
      evidenceRefs: evidence.map((path) => refs[path]),
    });
  const failedOnly = async () =>
    (await app.artifacts.get(ids.runId, { failedOnly: true })).manifest;
  return { addStep, failedOnly };
}

it("failed-only keeps the evidence of the non-passed step itself", async () => {
  const f = await seedRun("failed");
  f.addStep("get-health", 0, "passed", ["http/get-health.json"]);
  f.addStep("check-status", 1, "failed", ["logs/container.log"]);
  const manifest = await f.failedOnly();
  expect(manifest.subset).toBe(true);
  expect(manifest.entries.map((entry) => entry.relativePath)).toEqual(["logs/container.log"]);
});

it("failed-only falls back to the response an evidence-less assertion read", async () => {
  const f = await seedRun("failed");
  f.addStep("get-health", 0, "passed", ["http/get-health.json"]);
  f.addStep("check-status", 1, "failed", []);
  const manifest = await f.failedOnly();
  expect(manifest.subset).toBe(true);
  expect(manifest.parentSnapshot).toBe(manifest.snapshotId);
  expect(manifest.entries.map((entry) => entry.relativePath)).toEqual(["http/get-health.json"]);
});

it("failed-only falls back to the attempt diagnostics when no step holds evidence and never invents entries", async () => {
  const f = await seedRun("failed");
  f.addStep("get-health", 0, "failed", []);
  const manifest = await f.failedOnly();
  expect(manifest.subset).toBe(true);
  expect(manifest.entries.map((entry) => entry.relativePath).sort()).toEqual([
    "logs/container.log",
    "logs/egress.ndjson",
  ]);
});

it("failed-only on a passed run stays an empty subset", async () => {
  const f = await seedRun("passed");
  f.addStep("get-health", 0, "passed", ["http/get-health.json"]);
  f.addStep("check-status", 1, "passed", []);
  const manifest = await f.failedOnly();
  expect(manifest.subset).toBe(true);
  expect(manifest.entries).toEqual([]);
});
