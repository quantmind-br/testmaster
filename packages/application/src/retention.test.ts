import type { StatsFs } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import {
  type AttemptIds,
  ConfinedRoot,
  FileEvidenceStore,
  verifyBundle,
} from "@testmaster/evidence";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";
import type { ServiceContext } from "./context.js";
import { RetentionService } from "./retention.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}));

const applications: Application[] = [];
const roots: string[] = [];
const old = "2020-01-01T00:00:00.000Z";
interface RetentionFixture {
  app: Application;
  ctx: ServiceContext;
  runId: string;
  attemptId: string;
  jobId: string;
  artifactId: string;
  storageKey: string;
  ids: AttemptIds;
  committed: { bundleDir: string; manifestSha256: string };
  service: RetentionService;
  file: string;
  key: string;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of applications.splice(0)) app.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(
  options: { completed?: boolean; retentionDays?: number } = {},
): Promise<RetentionFixture> {
  const root = await fs.mkdtemp(join(tmpdir(), "tm-retention-"));
  roots.push(root);
  const home = join(root, "home");
  await fs.mkdir(home);
  const app = await Application.open({
    cwd: root,
    home,
    ...(options.retentionDays
      ? {
          flags: {
            artifacts: { trace: "off", video: "off", retentionDays: options.retentionDays },
          },
        }
      : {}),
  });
  applications.push(app);
  const init = await app.init();
  const ctx = app.context;
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  const runId = uuidV7IdGenerator.next("run");
  const attemptId = uuidV7IdGenerator.next("att");
  const snapshotId = uuidV7IdGenerator.next("snp");
  const jobId = uuidV7IdGenerator.next("job");
  const revisionId = String(test.activeRevisionId);
  const env = app.environments.get(init.environmentId);
  const completed = options.completed !== false;
  ctx.entities.insert("Run", {
    id: runId,
    workspaceId: ctx.workspaceId,
    createdAt: old,
    testId: test.id,
    revisionId,
    environmentRevisionId: env.activeRevisionId,
    batchId: null,
    matrixCell: { environmentName: "local" },
    mode: "replay",
    phase: completed ? "completed" : "running",
    status: completed ? "passed" : "running",
    outcome: completed ? "passed" : null,
    origin: "retention-test",
    gatePolicy: {},
    gate: completed ? "passed" : "pending",
    cleanupOutcome: "not_required",
    analysisStatus: "not_requested",
  });
  ctx.database.run(
    "INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,state,available_at,fence) VALUES(?,?,?,?,?,?,?,1)",
    ctx.workspaceId,
    jobId,
    old,
    "execution",
    runId,
    "completed",
    old,
  );
  ctx.entities.insert(
    "Attempt",
    {
      id: attemptId,
      workspaceId: ctx.workspaceId,
      createdAt: old,
      runId,
      number: 1,
      workerId: null,
      seed: 0,
      phase: "completed",
      startedAt: old,
      endedAt: old,
      outcome: "passed",
    },
    { jobId, fence: 1, leaseOwner: "retention-test" },
  );
  const ids = { workspaceId: ctx.workspaceId, runId, attemptId, snapshotId, revisionId };
  const staging = await new FileEvidenceStore({ rootDir: app.config.dataDir }).openAttempt(ids);
  const writer = await staging.beginArtifact({
    relativePath: "evidence/result.txt",
    kind: "dom",
    mimeType: "text/plain",
  });
  await writer.write(Buffer.from("retained evidence"));
  const entry = await writer.end();
  const committed = await staging.commit({ redactionPolicyHash: "0".repeat(64) });
  ctx.entities.insert("Snapshot", {
    id: snapshotId,
    workspaceId: ctx.workspaceId,
    createdAt: old,
    runId,
    attemptId,
    revisionId,
    manifestHash: committed.manifestSha256,
    committedAt: old,
    redactionPolicyHash: "0".repeat(64),
  });
  const storageKey = `runs/${ctx.workspaceId}/${runId}/${attemptId}/${entry.relativePath}`;
  ctx.entities.insert("Artifact", {
    id: entry.artifactId,
    workspaceId: ctx.workspaceId,
    createdAt: old,
    runId,
    attemptId,
    revisionId,
    snapshotId,
    kind: entry.kind,
    hash: entry.sha256,
    bytes: entry.sizeBytes,
    mime: entry.mimeType,
    storageKey,
    state: "available",
    redactionStatus: entry.redactionStatus,
  });
  const artifactId = entry.artifactId;
  return {
    app,
    ctx,
    runId,
    attemptId,
    jobId,
    artifactId,
    storageKey,
    ids,
    committed,
    service: new RetentionService(ctx, app.config),
    file: join(app.config.dataDir, storageKey),
    key: `retention:artifact:${ctx.workspaceId}:${artifactId}`,
  };
}
function record(f: RetentionFixture) {
  return JSON.parse(
    String(f.ctx.database.get("SELECT value FROM operational_state WHERE key=?", f.key)?.value),
  );
}
function artifact(f: RetentionFixture) {
  return f.ctx.entities.get("Artifact", f.ctx.workspaceId, f.artifactId);
}

describe("artifact retention maintenance", () => {
  it("tombstones before physical removal, preserves sealed metadata/verdict, and exposes verified expired reports", async () => {
    const f = await fixture();
    const runBefore = f.ctx.database.get("SELECT * FROM runs WHERE id=?", f.runId);
    const manifestBefore = await fs.readFile(join(f.committed.bundleDir, "manifest.json"));
    const metaBefore = await fs.readFile(join(f.committed.bundleDir, "meta.json"));
    const remove = ConfinedRoot.prototype.remove;
    vi.spyOn(ConfinedRoot.prototype, "remove").mockImplementation(async function (
      this: ConfinedRoot,
      path: string,
    ) {
      expect(path).toBe(f.storageKey);
      expect(artifact(f)?.state).toBe("expired");
      expect(record(f).stage).toBe("tombstoned");
      expect(
        f.ctx.database.get(
          "SELECT id FROM audit_events WHERE resource_id=? AND action='artifact.tombstoned'",
          f.artifactId,
        ),
      ).toBeDefined();
      expect(
        f.ctx.database.get(
          "SELECT id FROM outbox WHERE aggregate_id=? AND type='artifact.tombstoned'",
          f.runId,
        ),
      ).toBeDefined();
      await remove.call(this, path);
    });
    expect(await f.service.maintenance()).toMatchObject({
      expiredArtifacts: 1,
      removed: [f.storageKey],
    });
    await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(record(f)).toMatchObject({
      stage: "deleted",
      expiredAt: expect.any(String),
      tombstonedAt: expect.any(String),
      deletedAt: expect.any(String),
    });
    expect(artifact(f)).toMatchObject({
      state: "expired",
      hash: expect.any(String),
      bytes: 17,
      version: 4,
    });
    expect(f.ctx.database.get("SELECT * FROM runs WHERE id=?", f.runId)).toEqual(runBefore);
    expect(await fs.readFile(join(f.committed.bundleDir, "manifest.json"))).toEqual(manifestBefore);
    expect(await fs.readFile(join(f.committed.bundleDir, "meta.json"))).toEqual(metaBefore);
    await expect(
      verifyBundle(f.committed.bundleDir, { ...f.ids, manifestSha256: f.committed.manifestSha256 }),
    ).rejects.toThrow();
    const view = await f.app.artifacts.get(f.runId);
    expect(view.manifest.entries[0]).toMatchObject({
      artifactId: f.artifactId,
      state: "expired",
      omissionReason: "artifact_expired",
    });
    const report = await f.app.reports.snapshot(f.runId);
    expect(report.completeness).toMatchObject({ state: "partial", reasons: ["artifact_expired"] });
    expect(report.runs[0]?.result.outcome).toBe("passed");
    expect(await f.service.maintenance()).toMatchObject({ expiredArtifacts: 0, removed: [] });
    expect(
      f.ctx.database
        .all(
          "SELECT action FROM audit_events WHERE resource_id=? ORDER BY created_at,id",
          f.artifactId,
        )
        .map((row) => row.action),
    ).toEqual(["artifact.expired", "artifact.tombstoned", "artifact.deleted"]);
  });

  it.each([
    "unfinished-run",
    "active-attempt",
    "live-lease",
    "legal-hold",
    "live-reference",
    "new-artifact",
    "new-snapshot",
  ])("does not collect %s evidence", async (reason) => {
    const f = await fixture({ completed: reason !== "unfinished-run" });
    const db = f.ctx.database;
    if (reason === "active-attempt")
      db.run(
        "UPDATE attempts SET phase='running',outcome=NULL,ended_at=NULL WHERE id=?",
        f.attemptId,
      );
    if (reason === "live-lease")
      db.run(
        "UPDATE job_leases SET state='leased',lease_owner='live',lease_expires_at=? WHERE id=?",
        new Date(Date.now() + 60000).toISOString(),
        f.jobId,
      );
    if (reason === "legal-hold")
      db.run(
        "INSERT INTO operational_state(key,value) VALUES(?,'active')",
        `retention:legal-hold:${f.ctx.workspaceId}:${f.runId}`,
      );
    if (reason === "live-reference") {
      const source = artifact(f)!;
      f.ctx.entities.insert("Artifact", { ...source, id: uuidV7IdGenerator.next("art") });
    }
    if (reason === "new-artifact")
      db.run(
        "UPDATE artifacts SET created_at=? WHERE id=?",
        new Date().toISOString(),
        f.artifactId,
      );
    if (reason === "new-snapshot") {
      // Snapshot metadata is immutable: replace only in the test fixture via a fresh committed reference.
      const id = uuidV7IdGenerator.next("snp");
      const original = f.ctx.entities.get("Snapshot", f.ctx.workspaceId, f.ids.snapshotId)!;
      f.ctx.entities.insert("Snapshot", { ...original, id, committedAt: new Date().toISOString() });
      db.run("UPDATE artifacts SET snapshot_id=? WHERE id=?", id, f.artifactId);
    }
    expect(await f.service.maintenance()).toMatchObject({ expiredArtifacts: 0, removed: [] });
    expect(artifact(f)?.state).toBe("available");
    expect(await fs.readFile(f.file, "utf8")).toBe("retained evidence");
    expect(db.get("SELECT value FROM operational_state WHERE key=?", f.key)).toBeUndefined();
  });

  it("honors configured retention without shortening it under storage pressure", async () => {
    const f = await fixture({ retentionDays: 60 });
    f.ctx.database.run(
      "UPDATE artifacts SET created_at=? WHERE id=?",
      new Date(Date.now() - 45 * 86400000).toISOString(),
      f.artifactId,
    );
    vi.spyOn(fs, "statfs").mockResolvedValue({ blocks: 100, bavail: 5 } as StatsFs);
    expect(await f.service.maintenance()).toMatchObject({
      expiredArtifacts: 0,
      removed: [],
      usedFraction: 0.95,
      admissionSuspended: true,
    });
    expect(artifact(f)?.state).toBe("available");
  });

  it("refuses a stale candidate and a newly active attempt at the tombstone CAS", async () => {
    const f = await fixture();
    const openFile = ConfinedRoot.prototype.openFile;
    vi.spyOn(ConfinedRoot.prototype, "openFile").mockImplementation(async function (
      this: ConfinedRoot,
      path: string,
      write?: boolean,
    ) {
      const handle = await openFile.call(this, path, write);
      f.ctx.database.run("UPDATE artifacts SET version=version+1 WHERE id=?", f.artifactId);
      return handle;
    });
    expect(await f.service.maintenance()).toMatchObject({ expiredArtifacts: 0, removed: [] });
    vi.restoreAllMocks();
    const run = f.ctx.database.run.bind(f.ctx.database);
    vi.spyOn(f.ctx.database, "run").mockImplementation((sql, ...args) => {
      const result = run(sql, ...args);
      if (sql.startsWith("UPDATE artifacts SET state='expired'"))
        run(
          "UPDATE attempts SET phase='running',outcome=NULL,ended_at=NULL WHERE id=?",
          f.attemptId,
        );
      return result;
    });
    expect(await f.service.maintenance()).toMatchObject({ expiredArtifacts: 1, removed: [] });
    expect(record(f).stage).toBe("marked");
    expect(await fs.readFile(f.file, "utf8")).toBe("retained evidence");
    expect(
      f.ctx.database.get(
        "SELECT id FROM audit_events WHERE resource_id=? AND action='artifact.tombstoned'",
        f.artifactId,
      ),
    ).toBeUndefined();
  });

  it("rechecks legal holds at tombstone and resumes only after release", async () => {
    const f = await fixture();
    const holdKey = `retention:legal-hold:${f.ctx.workspaceId}:${f.artifactId}`;
    const run = f.ctx.database.run.bind(f.ctx.database);
    const mutation = vi.spyOn(f.ctx.database, "run").mockImplementation((sql, ...args) => {
      const result = run(sql, ...args);
      if (sql.startsWith("UPDATE artifacts SET state='expired'"))
        run("INSERT INTO operational_state(key,value) VALUES(?,'active')", holdKey);
      return result;
    });
    expect(await f.service.maintenance()).toMatchObject({ expiredArtifacts: 1, removed: [] });
    expect(record(f).stage).toBe("marked");
    expect(await fs.readFile(f.file, "utf8")).toBe("retained evidence");
    mutation.mockRestore();
    run("UPDATE operational_state SET value='released' WHERE key=?", holdKey);
    expect(await f.service.maintenance()).toMatchObject({
      expiredArtifacts: 0,
      removed: [f.storageKey],
    });
  });

  it("rolls back the delete permit if tombstone audit cannot commit", async () => {
    const f = await fixture();
    f.ctx.database.run(
      "CREATE TRIGGER reject_retention_audit BEFORE INSERT ON audit_events WHEN NEW.action='artifact.tombstoned' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
    );
    await expect(f.service.maintenance()).rejects.toThrow("audit unavailable");
    expect(record(f).stage).toBe("marked");
    expect(artifact(f)?.version).toBe(2);
    expect(await fs.readFile(f.file, "utf8")).toBe("retained evidence");
    expect(
      f.ctx.database.get(
        "SELECT id FROM outbox WHERE aggregate_id=? AND type='artifact.tombstoned'",
        f.runId,
      ),
    ).toBeUndefined();
    f.ctx.database.run("DROP TRIGGER reject_retention_audit");
    expect(await f.service.maintenance()).toMatchObject({
      expiredArtifacts: 0,
      removed: [f.storageKey],
    });
  });

  it("retries a crashed delete without duplicating expiry/tombstone audit or losing metadata", async () => {
    const f = await fixture();
    const deletion = vi
      .spyOn(ConfinedRoot.prototype, "remove")
      .mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(f.service.maintenance()).rejects.toThrow("storage unavailable");
    expect(record(f).stage).toBe("tombstoned");
    expect(await fs.readFile(f.file, "utf8")).toBe("retained evidence");
    deletion.mockRestore();
    expect(await f.service.maintenance()).toMatchObject({
      expiredArtifacts: 0,
      removed: [f.storageKey],
    });
    expect(record(f).stage).toBe("deleted");
    expect(
      f.ctx.database.all("SELECT action FROM audit_events WHERE resource_id=?", f.artifactId),
    ).toHaveLength(3);
  });

  it("finishes a tombstoned deletion after bytes are already gone", async () => {
    const f = await fixture();
    const remove = ConfinedRoot.prototype.remove;
    const deletion = vi
      .spyOn(ConfinedRoot.prototype, "remove")
      .mockImplementationOnce(async function (this: ConfinedRoot, path: string) {
        await remove.call(this, path);
        throw new Error("crash after unlink");
      });
    await expect(f.service.maintenance()).rejects.toThrow("crash after unlink");
    deletion.mockRestore();
    expect(await f.service.maintenance()).toMatchObject({
      expiredArtifacts: 0,
      removed: [f.storageKey],
    });
    expect(record(f).stage).toBe("deleted");
    expect(await fs.stat(join(f.committed.bundleDir, "manifest.json"))).toBeDefined();
  });

  it("never removes directories, reserved bundle metadata, or foreign storage keys", async () => {
    const f = await fixture();
    await fs.rm(f.file);
    await fs.mkdir(f.file);
    await expect(f.service.maintenance()).rejects.toThrow();
    expect(artifact(f)?.state).toBe("available");
    f.ctx.database.run(
      "UPDATE artifacts SET storage_key=? WHERE id=?",
      `runs/${f.ctx.workspaceId}/${f.runId}/${f.attemptId}/manifest.json`,
      f.artifactId,
    );
    await expect(f.service.maintenance()).rejects.toThrow("metadata");
    f.ctx.database.run("UPDATE artifacts SET storage_key='outside.txt' WHERE id=?", f.artifactId);
    await expect(f.service.maintenance()).rejects.toThrow("outside");
    expect(await fs.stat(join(f.committed.bundleDir, "manifest.json"))).toBeDefined();
  });

  it("suspends at 90%, resumes only its own pressure suspension, and preserves independent maintenance", async () => {
    const f = await fixture({ completed: false });
    const storage = vi.spyOn(fs, "statfs");
    storage.mockResolvedValue({ blocks: 100, bavail: 20 } as StatsFs);
    expect(await f.service.maintenance()).toMatchObject({
      usedFraction: 0.8,
      admissionSuspended: false,
    });
    storage.mockResolvedValue({ blocks: 100, bavail: 10 } as StatsFs);
    expect(await f.service.maintenance()).toMatchObject({
      usedFraction: 0.9,
      admissionSuspended: true,
    });
    storage.mockResolvedValue({ blocks: 100, bavail: 30 } as StatsFs);
    expect(await f.service.maintenance()).toMatchObject({
      usedFraction: 0.7,
      admissionSuspended: false,
    });
    storage.mockResolvedValue({ blocks: 100, bavail: 5 } as StatsFs);
    await f.service.maintenance();
    f.ctx.database.run("UPDATE operational_state SET value='suspended' WHERE key='admission'");
    storage.mockResolvedValue({ blocks: 100, bavail: 30 } as StatsFs);
    expect(await f.service.maintenance()).toMatchObject({ admissionSuspended: true });
    expect(
      f.ctx.database.get("SELECT value FROM operational_state WHERE key='admission'")?.value,
    ).toBe("suspended");
    f.ctx.database.run("UPDATE operational_state SET value='maintenance' WHERE key='admission'");
    expect(await f.service.maintenance()).toMatchObject({ admissionSuspended: true });
    expect(
      f.ctx.database.get("SELECT value FROM operational_state WHERE key='admission'")?.value,
    ).toBe("maintenance");
  });
});
