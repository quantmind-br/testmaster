import { renameSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { FileEvidenceStore } from "@testmaster/evidence";
import { afterEach, expect, it, vi } from "vitest";
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
  const entries = [];
  for (const [relativePath, kind, mimeType] of files) {
    const writer = await stage.beginArtifact({ relativePath, kind, mimeType });
    await writer.write(Buffer.from("{}"));
    const entry = await writer.end();
    entries.push(entry);
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
  for (const entry of entries)
    app.context.entities.insert("Artifact", {
      id: entry.artifactId,
      workspaceId: ids.workspaceId,
      createdAt: now,
      runId: ids.runId,
      attemptId: ids.attemptId,
      revisionId: ids.revisionId,
      snapshotId: ids.snapshotId,
      kind: entry.kind,
      hash: entry.sha256,
      bytes: entry.sizeBytes,
      mime: entry.mimeType,
      redactionStatus: entry.redactionStatus,
      storageKey: `runs/${ids.workspaceId}/${ids.runId}/${ids.attemptId}/${entry.relativePath}`,
      state: entry.state,
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
  return { addStep, failedOnly, app, ids };
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

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[relative(dir, path)] = (await readFile(path)).toString("base64");
  }
  return out;
}

it("exports a raw bundle to a missing directory with the committed bytes and a compact manifest", async () => {
  const f = await seedRun("passed");
  const committed = await f.app.artifacts.get(f.ids.runId);
  const out = join(roots[0] as string, "export");
  const exported = await f.app.artifacts.get(f.ids.runId, { out });
  expect(exported.bundleDir).toBe(out);
  const written = await tree(out);
  expect(Object.keys(written).sort()).toEqual(
    [...files.map(([path]) => path), "manifest.json", "meta.json"].sort(),
  );
  for (const [path] of files)
    expect(written[path]).toBe(
      (await readFile(join(committed.bundleDir, path))).toString("base64"),
    );
  const manifestText = await readFile(join(out, "manifest.json"), "utf8");
  expect(JSON.parse(manifestText)).toEqual(JSON.parse(JSON.stringify(exported.manifest)));
  expect(manifestText).not.toContain("\n");
  expect(JSON.parse(await readFile(join(out, "meta.json"), "utf8"))).toEqual(
    JSON.parse(JSON.stringify(exported.meta)),
  );
});

it("exports into an existing empty directory", async () => {
  const f = await seedRun("passed");
  const out = join(roots[0] as string, "empty");
  await mkdir(out);
  await f.app.artifacts.get(f.ids.runId, { out });
  expect(Object.keys(await tree(out)).sort()).toEqual(
    [...files.map(([path]) => path), "manifest.json", "meta.json"].sort(),
  );
});

it("refuses a non-empty output directory and leaves its files alone", async () => {
  const f = await seedRun("passed");
  const out = join(roots[0] as string, "export");
  await f.app.artifacts.get(f.ids.runId, { out });
  const first = await tree(out);
  await expect(f.app.artifacts.get(f.ids.runId, { out })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(await tree(out)).toEqual(first);

  const other = join(roots[0] as string, "other");
  await mkdir(other);
  await writeFile(join(other, "unrelated.txt"), "keep");
  await expect(f.app.artifacts.get(f.ids.runId, { out: other })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(await readdir(other)).toEqual(["unrelated.txt"]);
  expect(await readFile(join(other, "unrelated.txt"), "utf8")).toBe("keep");
});

it("refuses an output that is or goes through a symbolic link and creates nothing at its target", async () => {
  const f = await seedRun("passed");
  const root = roots[0] as string;
  const target = join(root, "target");
  await mkdir(target);
  await symlink(target, join(root, "link"));
  await symlink(join(root, "planted"), join(root, "dangling"));
  for (const out of [join(root, "link", "export"), join(root, "link"), join(root, "dangling")]) {
    await expect(f.app.artifacts.get(f.ids.runId, { out })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  }
  expect(await readdir(target)).toEqual([]);
  await expect(stat(join(root, "planted"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses an output path that is an existing regular file and leaves the file alone", async () => {
  const f = await seedRun("passed");
  const out = join(roots[0] as string, "report.txt");
  await writeFile(out, "keep");
  await expect(f.app.artifacts.get(f.ids.runId, { out })).rejects.toMatchObject({
    code: "FORBIDDEN",
    details: { path: out },
  });
  expect(await readFile(out, "utf8")).toBe("keep");
});

it("a source artifact swapped for a symbolic link during an export keeps its own error, not an output refusal", async () => {
  const f = await seedRun("passed");
  const committed = await f.app.artifacts.get(f.ids.runId);
  const elsewhere = join(roots[0] as string, "elsewhere");
  await mkdir(elsewhere);
  // The bundle was verified; its files are then replaced by links before they are streamed.
  let swapped = false;
  vi.spyOn(
    f.app.artifacts as unknown as { assertReadable(artifactId: string): void },
    "assertReadable",
  ).mockImplementation(() => {
    if (swapped) return;
    swapped = true;
    for (const [path] of files) {
      const moved = join(elsewhere, basename(path));
      renameSync(join(committed.bundleDir, path), moved);
      symlinkSync(moved, join(committed.bundleDir, path));
    }
  });
  const out = join(roots[0] as string, "export");
  await expect(f.app.artifacts.get(f.ids.runId, { out })).rejects.toMatchObject({ code: "ELOOP" });
});

it("exports nested entries with private directories and files", async () => {
  const f = await seedRun("passed");
  const out = join(roots[0] as string, "export");
  await f.app.artifacts.get(f.ids.runId, { out });
  for (const dir of ["http", "logs", "snapshot"])
    expect((await stat(join(out, dir))).mode & 0o777).toBe(0o700);
  for (const [path] of files) expect((await stat(join(out, path))).mode & 0o777).toBe(0o600);
  expect((await stat(join(out, "manifest.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(join(out, "meta.json"))).mode & 0o777).toBe(0o600);
});
