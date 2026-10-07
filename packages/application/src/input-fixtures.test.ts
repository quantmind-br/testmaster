import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults, type ExecutablePlan, type PlanStep } from "@testmaster/contracts";
import { sha256, uuidV7IdGenerator } from "@testmaster/domain";
import { AttemptExecutor, readImageLock } from "@testmaster/sandbox";
import { afterEach, expect, it, vi } from "vitest";
import { Application } from "./application.js";
import { planRiskActions } from "./approvals.js";
import { scaffoldPlan } from "./authoring.js";
import {
  fixtureInputHashes,
  fixtureRecord,
  fixtureRefIds,
  planRunnerPolicy,
  stageFixtureInputs,
} from "./input-fixtures.js";
import { admissionSnapshot } from "./provenance.js";

const applications: Application[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const app of applications.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tm-fixture-input-"));
  roots.push(root);
  await mkdir(join(root, "home"));
  const app = await Application.open({ cwd: root, home: join(root, "home"), env: {} });
  applications.push(app);
  const init = await app.init();
  const inputDir = join(root, "input");
  await mkdir(inputDir);
  return { app, init, inputDir };
}
function uploadPlan(id: string): ExecutablePlan {
  const plan = scaffoldPlan("frontend");
  plan.steps = [
    {
      id: "upload",
      kind: "action",
      operation: "upload",
      description: "Attach profile file",
      input: { locator: { by: "testId", value: "profile-upload" }, artifactRefs: [id] },
    },
    {
      id: "uploaded",
      kind: "assertion",
      operation: "assert",
      description: "Upload confirmed",
      required: true,
      input: { locator: { by: "testId", value: "profile-status" } },
      expectation: { predicate: "visible" },
    },
  ];
  return plan;
}
it("derives upload permission only from the frozen plan, not existing fixtures", async () => {
  const { app, init } = await fixture();
  await app.artifacts.importFixtureInput({
    projectId: init.projectId,
    name: "profile",
    bytes: Buffer.from("payload"),
    mimeType: "application/octet-stream",
  });
  expect(planRunnerPolicy(scaffoldPlan("frontend"))).toEqual({
    allowUploads: false,
    allowDownloads: false,
    allowFrames: false,
    popupAliases: [],
  });
  expect(planRunnerPolicy(null)).toEqual({
    allowUploads: false,
    allowDownloads: false,
    allowFrames: false,
    popupAliases: [],
  });
});
it("derives nested upload/frame/download and ordered unique page aliases without downgrading risk", () => {
  const plan = uploadPlan(uuidV7IdGenerator.next("art"));
  const upload = plan.steps[0]!;
  plan.steps = [
    {
      id: "frame",
      kind: "action",
      operation: "frame",
      description: "Profile frame",
      input: {
        locator: { by: "testId", value: "profile-frame" },
        childSteps: [
          upload,
          {
            id: "switch",
            kind: "action",
            operation: "switchPage",
            description: "Popup",
            input: { pageAlias: "terms" },
          },
        ],
      },
    },
    {
      id: "download",
      kind: "action",
      operation: "download",
      description: "Download profile",
      input: {
        trigger: {
          operation: "click",
          input: { locator: { by: "testId", value: "download", pageAlias: "help" } },
        },
        outputName: "profile.bin",
      },
    },
    {
      id: "assert-popup",
      kind: "assertion",
      operation: "assert",
      description: "Popup URL",
      input: { pageAlias: "terms" },
      expectation: { predicate: "urlEquals", value: { literal: "http://localhost/terms" } },
    },
  ];
  expect(planRunnerPolicy(plan)).toEqual({
    allowUploads: true,
    allowDownloads: true,
    allowFrames: true,
    popupAliases: ["terms", "help"],
  });
  expect(planRiskActions(plan)).toEqual(
    expect.arrayContaining([
      { stepId: "upload", risk: "write" },
      { stepId: "download", risk: "write" },
    ]),
  );
});
it("permits HTTP artifact bodies including cleanup and traverses typed nested references", () => {
  const plan = scaffoldPlan("backend");
  const id = uuidV7IdGenerator.next("art");
  const request = plan.steps.find(
    (step): step is Extract<PlanStep, { operation: "request" }> => step.operation === "request",
  )!;
  request.input.body = { kind: "artifact", artifactRef: id, mimeType: "application/octet-stream" };
  expect(planRunnerPolicy(plan).allowUploads).toBe(true);
  expect(fixtureRefIds(plan)).toEqual([id]);
  request.input.body = undefined;
  plan.cleanup = [
    {
      resourceRef: "fixture",
      operation: "request",
      input: {
        ...request.input,
        body: { kind: "artifact", artifactRef: id, mimeType: "application/octet-stream" },
      },
      successPredicate: { predicate: "statusIn", values: [200] },
      deadlineMs: 1000,
      required: true,
    },
  ];
  expect(planRunnerPolicy(plan).allowUploads).toBe(true);
  expect(fixtureRefIds(plan)).toEqual([id]);
  const unused = uuidV7IdGenerator.next("art");
  request.input.body = {
    kind: "json",
    value: { literal: { artifactRef: unused, pageAlias: "untrusted-payload" } },
  };
  expect(fixtureRefIds(plan)).toEqual([id]);
  expect(planRunnerPolicy(plan).popupAliases).toEqual([]);
});
it("enforces project writer authorization and size before persisting input", async () => {
  const { app, init } = await fixture();
  const reader = app.withIdentity({ principalId: init.principalId, scopes: ["R"] });
  const input = {
    projectId: init.projectId,
    name: "profile",
    bytes: Buffer.from("payload"),
    mimeType: "application/octet-stream",
  };
  await expect(reader.artifacts.importFixtureInput(input)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(
    app.artifacts.importFixtureInput({ ...input, bytes: new Uint8Array(defaults.bodyBytes + 1) }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(app.database.all("SELECT id FROM fixture_inputs")).toEqual([]);
});
it("persists private immutable inputs, freezes hashes and stages verified container paths", async () => {
  const { app, init, inputDir } = await fixture();
  const bytes = Buffer.from("profile fixture payload");
  const imported = await app.artifacts.importFixtureInput({
    projectId: init.projectId,
    name: "../../not-a-path",
    bytes,
    mimeType: "application/octet-stream",
  });
  expect(imported).toEqual({
    id: expect.stringMatching(/^art_/u),
    contentHash: sha256(bytes),
    sizeBytes: bytes.length,
  });
  const record = fixtureRecord(app.context, imported.id)!;
  expect((await stat(join(app.config.dataDir, record.storage_key))).mode & 0o777).toBe(0o600);
  expect(() =>
    app.database.run("UPDATE fixture_inputs SET name='changed' WHERE id=?", imported.id),
  ).toThrow();
  expect(() => app.database.run("DELETE FROM fixture_inputs WHERE id=?", imported.id)).toThrow();
  expect(app.database.all("SELECT id FROM artifacts")).toEqual([]);
  expect(
    app.database.all("SELECT id FROM audit_events WHERE action='artifact.fixture_imported'"),
  ).toHaveLength(1);
  const plan = uploadPlan(imported.id);
  const test = app.tests.create({ projectId: init.projectId, plan });
  const revision = app.revisions.get(String(test.activeRevisionId));
  const environment = app.environments.get(init.environmentId);
  const envRevision = app.context.entities.get(
    "EnvironmentRevision",
    app.context.workspaceId,
    String(environment.activeRevisionId),
  )!;
  const admission = admissionSnapshot(app.context, revision, envRevision, app.config, null, 0);
  expect(admission.inputFixtureHashes).toEqual({ [imported.id]: imported.contentHash });
  const staged = await stageFixtureInputs(
    app.context,
    app.config,
    init.projectId,
    plan,
    inputDir,
    admission.inputFixtureHashes!,
  );
  expect(staged.inputFixtureHashes).toEqual(admission.inputFixtureHashes);
  expect(staged.artifacts[imported.id]).toEqual({
    path: `/run/testmaster/input/fixture-${imported.id}`,
    mimeType: "application/octet-stream",
    sizeBytes: bytes.length,
  });
  expect(await readFile(join(inputDir, `fixture-${imported.id}`))).toEqual(bytes);
});
it("dispatch input staging refuses missing, foreign, revoked and corrupt fixtures", async () => {
  const { app, init, inputDir } = await fixture();
  const missing = uuidV7IdGenerator.next("art");
  const security = {
    code: "PRECONDITION_FAILED",
    details: { reasonCode: "security_precondition_failed" },
  };
  await expect(
    stageFixtureInputs(app.context, app.config, init.projectId, uploadPlan(missing), inputDir, {}),
  ).rejects.toMatchObject(security);
  const foreign = app.projects.create({ name: "Other project" });
  const other = await app.artifacts.importFixtureInput({
    projectId: foreign.id,
    name: "foreign",
    bytes: Buffer.from("other"),
    mimeType: "text/plain",
  });
  await expect(
    stageFixtureInputs(app.context, app.config, init.projectId, uploadPlan(other.id), inputDir, {
      [other.id]: other.contentHash,
    }),
  ).rejects.toMatchObject(security);
  const imported = await app.artifacts.importFixtureInput({
    projectId: init.projectId,
    name: "profile",
    bytes: Buffer.from("data"),
    mimeType: "text/plain",
  });
  const hashes = fixtureInputHashes(app.context, init.projectId, uploadPlan(imported.id));
  await expect(
    stageFixtureInputs(app.context, app.config, init.projectId, uploadPlan(imported.id), inputDir, {
      [imported.id]: "0".repeat(64),
    }),
  ).rejects.toMatchObject(security);
  const record = fixtureRecord(app.context, imported.id)!;
  await writeFile(join(app.config.dataDir, record.storage_key), "evil");
  await expect(
    stageFixtureInputs(
      app.context,
      app.config,
      init.projectId,
      uploadPlan(imported.id),
      inputDir,
      hashes,
    ),
  ).rejects.toMatchObject(security);
  const operation = app.retention.requestDeletion(imported.id);
  expect(operation.revokedAt).not.toBeNull();
  expect(app.retention.requestDeletion(imported.id).id).toBe(operation.id);
  await expect(
    stageFixtureInputs(
      app.context,
      app.config,
      init.projectId,
      uploadPlan(imported.id),
      inputDir,
      hashes,
    ),
  ).rejects.toMatchObject(security);
});
it("retains physically held fixture blobs while tombstones revoke execution, then resumes collection", async () => {
  const { app, init } = await fixture();
  const imported = await app.artifacts.importFixtureInput({
    projectId: init.projectId,
    name: "profile",
    bytes: Buffer.from("data"),
    mimeType: "text/plain",
  });
  const record = fixtureRecord(app.context, imported.id)!;
  const hold = `retention:legal-hold:${app.context.workspaceId}:${imported.id}`;
  app.database.run("INSERT INTO operational_state(key,value) VALUES(?,'held')", hold);
  const operation = app.retention.requestDeletion(imported.id);
  expect(operation.backupHolds).toContain(hold);
  await app.retention.maintenance();
  expect(app.retention.deletionStatus(operation.id).physicalState).toBe("pending");
  expect(await readFile(join(app.config.dataDir, record.storage_key), "utf8")).toBe("data");
  app.database.run("UPDATE operational_state SET value='released' WHERE key=?", hold);
  await app.retention.maintenance();
  expect(app.retention.deletionStatus(operation.id).physicalState).toBe("completed");
  await expect(readFile(join(app.config.dataDir, record.storage_key))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(() =>
    fixtureInputHashes(app.context, init.projectId, uploadPlan(imported.id)),
  ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
});
it("worker dispatch carries frozen capabilities and fixture hashes into the sealed snapshot", async () => {
  const { app, init } = await fixture();
  const bytes = Buffer.from("dispatch input");
  const imported = await app.artifacts.importFixtureInput({
    projectId: init.projectId,
    name: "profile",
    bytes,
    mimeType: "application/octet-stream",
  });
  const test = app.tests.create({ projectId: init.projectId, plan: uploadPlan(imported.id) });
  const lock = await readImageLock(
    new URL("../../../containers/images.lock.json", import.meta.url).pathname,
  );
  vi.spyOn(app, "preflight").mockResolvedValue();
  vi.spyOn(app, "images").mockResolvedValue(lock);
  vi.spyOn(app.runs.host, "admittedImages").mockReturnValue(lock);
  const execute = vi
    .spyOn(AttemptExecutor.prototype, "execute")
    .mockImplementation(async (input) => {
      expect(input.runnerInput?.policy).toMatchObject({
        allowUploads: true,
        allowDownloads: false,
        allowFrames: false,
        popupAliases: [],
      });
      expect(input.executionSnapshot).toMatchObject({
        inputFixtureHashes: { [imported.id]: imported.contentHash },
      });
      expect(input.runnerInput?.artifacts).toEqual({
        [imported.id]: {
          path: `/run/testmaster/input/fixture-${imported.id}`,
          mimeType: "application/octet-stream",
          sizeBytes: bytes.length,
        },
      });
      expect(await readFile(join(input.inputDir, `fixture-${imported.id}`))).toEqual(bytes);
      return {
        outcome: "blocked",
        reasonCode: "security_precondition_failed",
        logDropped: 0,
        events: [],
      };
    });
  const receipt = await app.runs.admit(
    { testId: test.id, environmentId: init.environmentId, limits: { maxAttempts: 1 } },
    { wait: true },
  );
  await app.worker.run({ ephemeral: true, runIds: [receipt.runId] });
  expect(execute).toHaveBeenCalledOnce();
  const snapshot = app.runs
    .events(receipt.runId)
    .find((event) => event.type === "run.snapshot_sealed")?.payload;
  expect(snapshot).toMatchObject({
    executionSnapshot: { inputFixtureHashes: { [imported.id]: imported.contentHash } },
  });
});
it("worker refuses a fixture revoked after admission before invoking the executor", async () => {
  const { app, init } = await fixture();
  const imported = await app.artifacts.importFixtureInput({
    projectId: init.projectId,
    name: "profile",
    bytes: Buffer.from("dispatch input"),
    mimeType: "text/plain",
  });
  const test = app.tests.create({ projectId: init.projectId, plan: uploadPlan(imported.id) });
  const lock = await readImageLock(
    new URL("../../../containers/images.lock.json", import.meta.url).pathname,
  );
  vi.spyOn(app, "preflight").mockResolvedValue();
  vi.spyOn(app, "images").mockResolvedValue(lock);
  vi.spyOn(app.runs.host, "admittedImages").mockReturnValue(lock);
  const execute = vi.spyOn(AttemptExecutor.prototype, "execute");
  const receipt = await app.runs.admit(
    { testId: test.id, environmentId: init.environmentId, limits: { maxAttempts: 1 } },
    { wait: true },
  );
  app.retention.requestDeletion(imported.id);
  await app.worker.run({ ephemeral: true, runIds: [receipt.runId] });
  expect(execute).not.toHaveBeenCalled();
  expect(app.runs.get(receipt.runId)).toMatchObject({ outcome: "blocked", gate: "failed" });
});
it("backs up fixture bytes and reapplies post-backup deletion tombstones before restored use", async () => {
  const { app, init } = await fixture();
  const bytes = Buffer.from("retained fixture input");
  const imported = await app.artifacts.importFixtureInput({
    projectId: init.projectId,
    name: "profile",
    bytes,
    mimeType: "text/plain",
  });
  const record = fixtureRecord(app.context, imported.id)!;
  const backup = join(app.config.cwd, "backup");
  const manifest = await app.backups.create(backup);
  expect(manifest.files).toContainEqual({
    relativePath: `evidence/${record.storage_key}`,
    sizeBytes: bytes.length,
    sha256: imported.contentHash,
  });
  const operation = app.retention.requestDeletion(imported.id);
  expect(operation.backupHolds.some((hold) => hold.startsWith("backup:"))).toBe(true);
  const restoredDir = join(app.config.cwd, "restored");
  await app.backups.restore(backup, restoredDir);
  expect(await readFile(join(restoredDir, record.storage_key))).toEqual(bytes);
  const restored = await Application.open({
    cwd: app.config.cwd,
    home: app.config.home,
    env: { TESTMASTER_DATA_DIR: restoredDir },
  });
  applications.push(restored);
  expect(() =>
    fixtureInputHashes(restored.context, init.projectId, uploadPlan(imported.id)),
  ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  expect(restored.retention.deletionStatus(operation.id).revokedAt).toBe(operation.revokedAt);
});
