import { existsSync, type StatsFs } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import {
  type AttemptIds,
  bundleKeyFor,
  ConfinedRoot,
  FileEvidenceStore,
  FileObjectStore,
  verifyBundle,
} from "@testmaster/evidence";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadsService } from "./ai/sources.js";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";
import type { ServiceContext } from "./context.js";
import { assertArtifactPublishable, RetentionService } from "./retention.js";

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
  options: { completed?: boolean; retentionDays?: number; restricted?: boolean } = {},
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
    ...(options.restricted ? { sensitivity: "restricted" as const } : {}),
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
    service: new RetentionService(ctx, app.config, app.objectStore),
    file: join(app.config.dataDir, storageKey),
    key: `retention:artifact:${ctx.workspaceId}:${artifactId}`,
  };
}

it("reports absent committed bytes as partial without changing the persisted outcome and propagates unknown errors", async () => {
  const f = await fixture();
  await fs.rm(join(f.committed.bundleDir, "meta.json"));
  const snapshot = await f.app.reports.snapshot(f.runId);
  expect(snapshot.completeness.state).toBe("partial");
  expect(snapshot.runs[0]).toMatchObject({
    evidenceState: "unavailable",
    snapshot: null,
    manifest: null,
    result: { outcome: "passed", gate: "passed" },
  });
  expect(snapshot.runs[0]?.evidenceErrors).toEqual([expect.stringContaining("missing")]);
  vi.spyOn(f.app.artifacts, "get").mockRejectedValue(new Error("programming failure"));
  await expect(f.app.reports.snapshot(f.runId)).rejects.toThrow("programming failure");
});
it("sanitized export omits restricted raw bytes and retains source seal provenance", async () => {
  const f = await fixture({ restricted: true });
  const before = await fs.readFile(join(f.committed.bundleDir, "manifest.json"));
  const out = join(roots[roots.length - 1]!, "sanitized");
  const result = await f.app.artifacts.exportSanitized(f.runId, out);
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  expect(manifest).toMatchObject({
    exportPolicy: "sanitized",
    sourceSnapshotId: f.ids.snapshotId,
    sourceManifestHash: f.committed.manifestSha256,
  });
  expect(manifest.entries[0]).toMatchObject({
    state: "omitted",
    redactionStatus: "restrictedRaw",
    omissionReason: "restricted_raw_export_policy",
  });
  expect(result.omitted).toEqual([
    { relativePath: "evidence/result.txt", reason: "restricted_raw_export_policy" },
  ]);
  await expect(fs.access(join(out, "evidence/result.txt"))).rejects.toBeDefined();
  expect(await fs.readFile(join(f.committed.bundleDir, "manifest.json"))).toEqual(before);
});
it("deletion is idempotent, revokes existing streams immediately, and remains pending under a legal hold", async () => {
  const f = await fixture();
  const stream = await f.app.artifacts.stream(f.artifactId);
  const key = `retention:legal-hold:${f.ctx.workspaceId}:${f.artifactId}`;
  f.ctx.database.run("INSERT INTO operational_state(key,value) VALUES(?,'active')", key);
  const operation = f.service.requestDeletion(f.artifactId);
  expect(f.service.requestDeletion(f.artifactId).id).toBe(operation.id);
  expect(operation).toMatchObject({ physicalState: "pending", backupHolds: [key] });
  await expect(stream.stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(f.app.artifacts.stream(f.artifactId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await f.service.maintenance()).toMatchObject({ removed: [] });
  expect(f.service.deletionStatus(operation.id).physicalState).toBe("pending");
  f.ctx.database.run("DELETE FROM operational_state WHERE key=?", key);
  await f.service.maintenance();
  expect(f.service.deletionStatus(operation.id).physicalState).toBe("completed");
  await expect(fs.access(f.file)).rejects.toBeDefined();
});
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
    const remove = FileObjectStore.prototype.delete;
    vi.spyOn(FileObjectStore.prototype, "delete").mockImplementation(async function (
      this: FileObjectStore,
      key: string,
    ) {
      expect(key).toBe(f.storageKey);
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
      await remove.call(this, key);
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
      verifyBundle(f.app.objectStore, bundleKeyFor(f.ids), {
        ...f.ids,
        manifestSha256: f.committed.manifestSha256,
      }),
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
    vi.spyOn(fs, "statfs").mockResolvedValue({ blocks: 100, bavail: 5, bsize: 4096 } as StatsFs);
    expect(await f.service.maintenance()).toMatchObject({
      expiredArtifacts: 0,
      removed: [],
      usedFraction: 0.95,
      admissionSuspended: false,
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
      .spyOn(FileObjectStore.prototype, "delete")
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
    const remove = FileObjectStore.prototype.delete;
    const deletion = vi
      .spyOn(FileObjectStore.prototype, "delete")
      .mockImplementationOnce(async function (this: FileObjectStore, key: string) {
        await remove.call(this, key);
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

  it("storage pressure never suspends admission, lifts a pressure suspension and keeps the reserve while bytes remain", async () => {
    const f = await fixture({ completed: false });
    const storage = vi.spyOn(fs, "statfs");
    const reserve = join(dirname(f.ctx.database.path), ".control-plane.reserve");
    const admission = () =>
      f.ctx.database.get("SELECT value FROM operational_state WHERE key='admission'")?.value;
    expect(existsSync(reserve)).toBe(true);
    // 90 % used of a large volume still leaves gigabytes: admission stays open, the reserve stays.
    storage.mockResolvedValue({ blocks: 100, bavail: 10, bsize: 1024 ** 3 } as StatsFs);
    expect(await f.service.maintenance()).toMatchObject({
      usedFraction: 0.9,
      admissionSuspended: false,
    });
    expect(existsSync(reserve)).toBe(true);
    // A suspension the share-based guard recorded is lifted on the next pass.
    f.ctx.database.run(
      "UPDATE operational_state SET value='suspended_storage' WHERE key='admission'",
    );
    f.ctx.database.run(
      "INSERT INTO operational_state(key,value) VALUES('retention:storage-pressure','suspended')",
    );
    expect(await f.service.maintenance()).toMatchObject({ admissionSuspended: false });
    expect(admission()).toBe("enabled");
    // Restore and operator suspensions are not the pressure guard's to lift.
    for (const value of ["suspended", "maintenance"]) {
      f.ctx.database.run("UPDATE operational_state SET value=? WHERE key='admission'", value);
      expect(await f.service.maintenance()).toMatchObject({ admissionSuspended: true });
      expect(admission()).toBe(value);
    }
    // Free bytes below the metadata reserve release the preallocated control-plane blocks.
    storage.mockResolvedValue({ blocks: 100, bavail: 10, bsize: 4096 } as StatsFs);
    await f.service.maintenance();
    expect(existsSync(reserve)).toBe(false);
  });

  it("warns once at 80 percent and clears the warning below 80 percent", async () => {
    const f = await fixture({ completed: false });
    const storage = vi.spyOn(fs, "statfs");
    const warnings = () =>
      f.ctx.database.all("SELECT data_json FROM outbox WHERE type='storage.high_watermark'");
    const state = () =>
      f.ctx.database.get("SELECT value FROM operational_state WHERE key='storage:high-watermark'");
    storage.mockResolvedValue({ blocks: 100, bavail: 21 } as StatsFs);
    await f.service.maintenance();
    expect(warnings()).toHaveLength(0);
    storage.mockResolvedValue({ blocks: 100, bavail: 20 } as StatsFs);
    await f.service.maintenance();
    await f.service.maintenance();
    expect(warnings()).toHaveLength(1);
    expect(JSON.parse(String(warnings()[0]?.data_json))).toMatchObject({
      reasonCode: "storage_high_watermark",
      thresholdFraction: 0.8,
    });
    storage.mockResolvedValue({ blocks: 100, bavail: 30 } as StatsFs);
    await f.service.maintenance();
    expect(state()).toBeUndefined();
    storage.mockResolvedValue({ blocks: 100, bavail: 10 } as StatsFs);
    await f.service.maintenance();
    expect(warnings()).toHaveLength(2);
  });

  it("artifact expiry leaves audit events and run metadata untouched", async () => {
    const f = await fixture();
    f.service.requestDeletion(f.artifactId);
    const auditBefore = f.ctx.database.all("SELECT id FROM audit_events ORDER BY id");
    const runBefore = f.ctx.database.get("SELECT * FROM runs WHERE id=?", f.runId);
    expect(await f.service.maintenance()).toMatchObject({ removed: [f.storageKey] });
    expect(f.ctx.database.all("SELECT id FROM audit_events ORDER BY id")).toEqual(
      expect.arrayContaining(auditBefore),
    );
    expect(f.ctx.database.get("SELECT * FROM runs WHERE id=?", f.runId)).toEqual(runBefore);
  });

  it("keeps audit rows and revoked secret tombstones when artifact bytes are collected", async () => {
    const f = await fixture();
    const secret = await f.app.secrets.set("canary", "CANARY-retention", { ephemeral: true });
    await f.app.secrets.remove(secret.id);
    const auditBefore = f.ctx.database.all("SELECT id FROM audit_events ORDER BY id");
    expect(auditBefore.length).toBeGreaterThan(0);
    expect(await f.service.maintenance()).toMatchObject({ removed: [f.storageKey] });
    expect(f.ctx.database.all("SELECT id FROM audit_events ORDER BY id")).toEqual(
      expect.arrayContaining(auditBefore),
    );
    expect(
      f.ctx.database.get("SELECT revoked_at FROM secret_references WHERE id=?", secret.id)
        ?.revoked_at,
    ).not.toBeNull();
    expect(
      f.ctx.database.get("SELECT 1 AS n FROM audit_events WHERE action='secret.revoke.allowed'"),
    ).toBeDefined();
  });

  it("does not retain bytes merely because another artifact records the same hash", async () => {
    const f = await fixture();
    const source = artifact(f)!;
    const otherKey = `runs/${f.ctx.workspaceId}/${f.runId}/${f.attemptId}/same-hash-other-bytes.txt`;
    await fs.writeFile(join(f.app.config.dataDir, otherKey), "retained evidence");
    f.ctx.entities.insert("Artifact", {
      ...source,
      id: uuidV7IdGenerator.next("art"),
      storageKey: otherKey,
      createdAt: new Date().toISOString(),
    });
    expect(await f.service.maintenance()).toMatchObject({ removed: [f.storageKey] });
    await expect(fs.access(f.file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(join(f.app.config.dataDir, otherKey), "utf8")).toBe(
      "retained evidence",
    );
  });

  it("dedup protects a shared blob only among artifacts of the same workspace", async () => {
    const f = await fixture();
    expect(f.storageKey.startsWith(`runs/${f.ctx.workspaceId}/`)).toBe(true);
    const siblingId = uuidV7IdGenerator.next("art");
    f.ctx.entities.insert("Artifact", { ...artifact(f)!, id: siblingId });
    expect(await f.service.maintenance()).toMatchObject({ expiredArtifacts: 0, removed: [] });
    expect(await fs.readFile(f.file, "utf8")).toBe("retained evidence");
    f.ctx.database.run("DELETE FROM artifacts WHERE id=?", siblingId);
    f.ctx.database.exec("PRAGMA foreign_keys=OFF");
    try {
      f.ctx.database.run(
        "INSERT INTO artifacts(workspace_id,id,created_at,revision_id,hash,bytes,storage_key,state,redaction_status) VALUES('ws-foreign','art-foreign',?,'rev-foreign','hash',1,?,'available','not_applicable')",
        old,
        f.storageKey,
      );
    } finally {
      f.ctx.database.exec("PRAGMA foreign_keys=ON");
    }
    expect(
      f.ctx.database.get("SELECT COUNT(*) AS n FROM artifacts WHERE storage_key=?", f.storageKey)
        ?.n,
    ).toBe(2);
    expect(await f.service.maintenance()).toMatchObject({ removed: [f.storageKey] });
    await expect(fs.access(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a valid-lease upload staged file survives maintenance until its lease expires", async () => {
    const f = await fixture({ completed: false });
    const uploads = new UploadsService(
      f.ctx,
      {
        ...f.app.config,
        profilePolicy: { ...f.app.config.profilePolicy, allowUpload: true },
      },
      f.app.objectStore,
    );
    const receipt = uploads.create({
      mediaType: "application/json",
      sizeBytes: 10,
      contentHash: "0".repeat(64),
    });
    const directory = join(f.app.config.dataDir, "uploads", f.ctx.workspaceId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const staged = join(directory, `${receipt.uploadId}.0123456789abcdef.pending`);
    await fs.writeFile(staged, "staged bytes");
    await f.service.maintenance();
    expect(await fs.readFile(staged, "utf8")).toBe("staged bytes");
    f.ctx.database.run("UPDATE upload_leases SET expires_at=?", new Date(0).toISOString());
    await f.service.maintenance();
    await expect(fs.access(staged)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("unavailable storage during GC emits a delayed-deletion event with its deadline", async () => {
    const f = await fixture();
    const remove = vi
      .spyOn(FileObjectStore.prototype, "delete")
      .mockRejectedValue(Object.assign(new Error("EIO"), { code: "EIO" }));
    expect(await f.service.maintenance()).toMatchObject({ removed: [] });
    expect(await f.service.maintenance()).toMatchObject({ removed: [] });
    const events = f.ctx.database.all(
      "SELECT data_json FROM outbox WHERE type='storage.gc_delayed'",
    );
    expect(events).toHaveLength(1);
    expect(JSON.parse(String(events[0]?.data_json))).toEqual({
      artifactId: f.artifactId,
      reasonCode: "storage_unavailable",
      physicalDeletionDeadlineAt: new Date(
        Date.parse(record(f).expiredAt) + 86400000,
      ).toISOString(),
    });
    expect(record(f).stage).toBe("tombstoned");
    expect(await fs.readFile(f.file, "utf8")).toBe("retained evidence");
    remove.mockRestore();
    expect(await f.service.maintenance()).toMatchObject({ removed: [f.storageKey] });
    expect(record(f).stage).toBe("deleted");
  });

  it("tombstone metadata in the outbox never carries storage keys or bytes", async () => {
    const f = await fixture();
    f.service.requestDeletion(f.artifactId);
    await f.service.maintenance();
    const rows = f.ctx.database.all<{ data_json: string }>(
      "SELECT data_json FROM outbox WHERE type LIKE 'artifact.%'",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => !row.data_json.includes(f.storageKey))).toBe(true);
    expect(rows.every((row) => !row.data_json.includes("retained evidence"))).toBe(true);
  });

  it("refuses publication of an artifact tombstoned during its upload", async () => {
    const f = await fixture();
    f.service.requestDeletion(f.artifactId);
    expect(() =>
      assertArtifactPublishable(f.ctx.database, f.ctx.workspaceId, f.artifactId),
    ).toThrow("Artifact publication revoked by tombstone");
    expect(() =>
      assertArtifactPublishable(
        f.ctx.database,
        f.ctx.workspaceId,
        "art_00000000-0000-7000-8000-000000000000",
      ),
    ).not.toThrow();
  });
});
