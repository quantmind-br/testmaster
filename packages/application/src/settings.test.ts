import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Role, rbacMatrix } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { type AttemptIds, FileEvidenceStore } from "@testmaster/evidence";
import { afterEach, expect, it, vi } from "vitest";
import { testProvider } from "../../model-gateway/src/test-support.js";
import { attemptAdditionalOrigins } from "./authoring.js";
import { entity } from "./context.js";
import {
  Application,
  authenticateSession,
  isDemoWorkspace,
  type ServiceContext,
  scaffoldPlan,
} from "./index.js";

const roots: string[] = [];
const apps: Application[] = [];
const old = "2020-01-01T00:00:00.000Z";
const password = "correct horse battery staple";
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Roles whose RBAC column is `deny`; grant-only service accounts need tokens and are excluded. */
const denied = (column: "secret" | "admin"): Role[] =>
  (Object.keys(rbacMatrix) as Role[]).filter(
    (role) => role !== "service_account" && rbacMatrix[role][column] === "deny",
  );

interface FixtureOptions {
  profile?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  env?: Record<string, string>;
}
async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "tm-settings-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(join(home, ".config/testmaster"), { recursive: true });
  if (options.profile)
    await writeFile(
      join(home, ".config/testmaster/profiles.json"),
      JSON.stringify({ defaultProfile: "test", profiles: { test: options.profile } }),
    );
  if (options.policy)
    await writeFile(join(home, ".config/testmaster/policy.json"), JSON.stringify(options.policy));
  const app = await Application.open({ cwd: root, home, env: { HOME: home, ...options.env } });
  apps.push(app);
  const init = await app.init();
  let counter = 0;
  /** Adds a member, sets their password through the recovery flow and returns their session. */
  const member = async (role: Role, projectRestrictions: string[] = []) => {
    const login = `${role.replace("_", "-")}-${++counter}`;
    const added = app.members.add(init.workspaceId, {
      login,
      displayName: login,
      role,
      projectRestrictions,
    });
    if (added.recovery)
      await app.identityService.recover({
        principal: login,
        recoveryToken: added.recovery.recoveryToken,
        newPassword: password,
      });
    const result = await app.identityService.login({ principal: login, password });
    const identity = authenticateSession(app, result.sessionToken);
    return { login, identity, scoped: app.forIdentity(identity) };
  };
  return { app, init, root, member };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** One completed (or unfinished) Run with a committed attempt bundle and one live artifact. */
async function seedArtifact(
  f: Fixture,
  options: { projectId?: string; completed?: boolean; label?: string } = {},
) {
  const { app } = f;
  const ctx: ServiceContext = app.context;
  const projectId = options.projectId ?? f.init.projectId;
  const test = app.tests.create({ projectId, plan: scaffoldPlan("backend") });
  const runId = uuidV7IdGenerator.next("run");
  const attemptId = uuidV7IdGenerator.next("att");
  const snapshotId = uuidV7IdGenerator.next("snp");
  const jobId = uuidV7IdGenerator.next("job");
  const revisionId = String(test.activeRevisionId);
  const completed = options.completed !== false;
  ctx.entities.insert("Run", {
    id: runId,
    workspaceId: ctx.workspaceId,
    createdAt: old,
    testId: test.id,
    revisionId,
    environmentRevisionId: app.environments.get(f.init.environmentId).activeRevisionId,
    batchId: null,
    matrixCell: { environmentName: "local" },
    mode: "replay",
    phase: completed ? "completed" : "running",
    status: completed ? "passed" : "running",
    outcome: completed ? "passed" : null,
    origin: "settings-test",
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
    { jobId, fence: 1, leaseOwner: "settings-test" },
  );
  const ids: AttemptIds = {
    workspaceId: ctx.workspaceId,
    runId,
    attemptId,
    snapshotId,
    revisionId,
  };
  const staging = await new FileEvidenceStore({ rootDir: app.config.dataDir }).openAttempt(ids);
  const writer = await staging.beginArtifact({
    relativePath: "evidence/result.txt",
    kind: "dom",
    mimeType: "text/plain",
  });
  await writer.write(Buffer.from(`evidence ${options.label ?? runId}`));
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
  return {
    artifactId: entry.artifactId,
    runId,
    file: join(app.config.dataDir, storageKey),
  };
}
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
function archive(app: Application, projectId: string) {
  return app.projects.archive(projectId, Number(app.projects.get(projectId).version));
}
function artifactState(app: Application, artifactId: string) {
  return app.database.get(
    "SELECT state FROM artifacts WHERE workspace_id=? AND id=?",
    app.context.workspaceId,
    artifactId,
  )?.state;
}
const auditActions = (app: Application, action: string) =>
  app.database.all("SELECT * FROM audit_events WHERE action=?", action);

// ---------------------------------------------------------------------------------- UX-046

it("UX-046 rotates a secret, bumps its version and lists created and rotated events newest first without any value", async () => {
  const f = await fixture();
  const canaries = ["CANARY-first-4f1c", "CANARY-second-9a2e", "CANARY-third-77b0"];
  const created = await f.app.secrets.set("portal-token", canaries[0] as string, {
    ephemeral: true,
    allowedOrigins: ["https://shop.example"],
  });
  const second = await f.app.secrets.rotate(created.id, canaries[1] as string);
  const third = await f.app.secrets.rotate(created.id, canaries[2] as string);
  expect([created.secretVersion, second.secretVersion, third.secretVersion]).toEqual([1, 2, 3]);
  const history = f.app.secrets.history(created.id);
  expect(history.map((record) => [record.event, record.version])).toEqual([
    ["rotated", 3],
    ["rotated", 2],
    ["created", 1],
  ]);
  for (const record of history) {
    expect(Object.keys(record).sort()).toEqual(
      ["actor", "createdAt", "event", "id", "requestId", "version"].sort(),
    );
    expect(record.id).toMatch(/^aud_/);
  }
  // Positive control: the canary really is the live value, so the searches below are meaningful.
  expect(await (await f.app.secrets.release(created.id)).resolve()).toBe(canaries[2]);
  const everything = JSON.stringify([
    history,
    f.app.secrets.list(),
    f.app.secrets.get(created.id),
    f.app.database.all("SELECT * FROM audit_events"),
    f.app.database.all("SELECT * FROM secret_references"),
  ]);
  for (const canary of canaries) expect(everything).not.toContain(canary);
  // The history is addressable by the shared locator too.
  expect(f.app.secrets.history("portal-token")).toEqual(history);
});

it("UX-046 refuses rotation to roles without the secret column and lets the roles that hold it rotate", async () => {
  const f = await fixture();
  const secret = await f.app.secrets.set("role-secret", "value-before-rotation", {
    ephemeral: true,
  });
  const roles = denied("secret");
  expect(roles.length).toBeGreaterThan(0);
  for (const role of roles) {
    const user = await f.member(role);
    await expect(
      user.scoped.secrets.rotate(secret.id, "value-after-rotation"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  }
  expect(f.app.secrets.get(secret.id).secretVersion).toBe(1);
  expect(f.app.secrets.history(secret.id).map((record) => record.event)).toEqual(["created"]);
  // Positive control: a role with the column rotates and the history shows it.
  const maintainer = await f.member("maintainer");
  expect(rbacMatrix.maintainer.secret).toBe("allow");
  expect(
    (await maintainer.scoped.secrets.rotate(secret.id, "value-after-rotation")).secretVersion,
  ).toBe(2);
  expect(f.app.secrets.history(secret.id)[0]).toMatchObject({
    event: "rotated",
    version: 2,
    actor: maintainer.identity.principalId,
  });
});

it("UX-046 reads created, rotated, revoked as versions 1, 2, 2 and refuses to rotate a revoked secret", async () => {
  const f = await fixture();
  const secret = await f.app.secrets.set("lifecycle", "value-one-111111", { ephemeral: true });
  await f.app.secrets.rotate(secret.id, "value-two-222222");
  await f.app.secrets.remove(secret.id);
  // Repeating the revoke changes nothing and must not add an event.
  await f.app.secrets.remove(secret.id);
  await expect(f.app.secrets.rotate(secret.id, "value-three-33333")).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
  const chronological = f.app.secrets.history(secret.id).reverse();
  expect(chronological.map((record) => [record.event, record.version])).toEqual([
    ["created", 1],
    ["rotated", 2],
    ["revoked", 2],
  ]);
  // The refused rotation left no allowed event and no version.
  expect(f.app.secrets.get(secret.id)).toMatchObject({ secretVersion: 2 });
  expect(f.app.secrets.history(secret.id)).toHaveLength(3);
  // Positive control: before revocation the same call succeeds.
  const live = await f.app.secrets.set("lifecycle-live", "value-one-111111", { ephemeral: true });
  expect((await f.app.secrets.rotate(live.id, "value-two-222222")).secretVersion).toBe(2);
});

it("UX-046 replays an idempotent rotation without rotating twice and refuses the key for another value", async () => {
  const f = await fixture();
  const secret = await f.app.secrets.set("idempotent", "value-before-key", { ephemeral: true });
  const key = "rotation-key-0000000001";
  const first = await f.app.secrets.rotate(secret.id, "value-after-key", { idempotencyKey: key });
  const replay = await f.app.secrets.rotate(secret.id, "value-after-key", { idempotencyKey: key });
  expect(replay).toEqual(first);
  expect(first.secretVersion).toBe(2);
  expect(f.app.secrets.get(secret.id).secretVersion).toBe(2);
  expect(
    f.app.secrets.history(secret.id).filter((record) => record.event === "rotated"),
  ).toHaveLength(1);
  await expect(
    f.app.secrets.rotate(secret.id, "another-value-here", { idempotencyKey: key }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  // Positive control: a new key is a new rotation.
  const next = await f.app.secrets.rotate(secret.id, "value-after-key", {
    idempotencyKey: "rotation-key-0000000002",
  });
  expect(next.secretVersion).toBe(3);
});

it("UX-046 rotates once when two requests with one idempotency key race", async () => {
  const f = await fixture();
  const secret = await f.app.secrets.set("racing", "value-before-race", { ephemeral: true });
  const key = "rotation-race-0000000001";
  const [one, two] = await Promise.all([
    f.app.secrets.rotate(secret.id, "value-after-race", { idempotencyKey: key }),
    f.app.secrets.rotate(secret.id, "value-after-race", { idempotencyKey: key }),
  ]);
  expect(two).toEqual(one);
  expect(f.app.secrets.get(secret.id).secretVersion).toBe(2);
  expect(
    f.app.secrets.history(secret.id).filter((record) => record.event === "rotated"),
  ).toHaveLength(1);
  // Positive control: two distinct keys are two rotations.
  await Promise.all([
    f.app.secrets.rotate(secret.id, "value-after-race", {
      idempotencyKey: "rotation-race-000000002",
    }),
  ]);
  expect(f.app.secrets.get(secret.id).secretVersion).toBe(3);
});

// ---------------------------------------------------------------------------------- UX-048

it("UX-048 refuses a missing or wrong confirmation token and an unarchived project without changing any state", async () => {
  const f = await fixture();
  const artifact = await seedArtifact(f);
  const project = f.app.projects.get(f.init.projectId);
  const before = f.app.database.all(
    "SELECT key FROM operational_state WHERE key LIKE 'retention:%'",
  );
  for (const token of ["", "not-the-slug", String(project.id)])
    expect(() => f.app.retention.purgeProject(project.id, token)).toThrowError(
      expect.objectContaining({
        code: "PRECONDITION_FAILED",
        details: { reason: "confirmation_mismatch" },
      }),
    );
  // The right token is still refused while the project is live.
  expect(() => f.app.retention.purgeProject(project.id, String(project.slug))).toThrowError(
    expect.objectContaining({
      code: "PRECONDITION_FAILED",
      details: { reason: "project_not_archived" },
    }),
  );
  expect(artifactState(f.app, artifact.artifactId)).toBe("available");
  expect(
    f.app.database.all("SELECT key FROM operational_state WHERE key LIKE 'retention:%'"),
  ).toEqual(before);
  expect(auditActions(f.app, "project.purge")).toHaveLength(0);
  expect(auditActions(f.app, "project.purge.denied").length).toBeGreaterThan(0);
  expect(f.app.retention.listDeletionOperations()).toEqual([]);
  // Positive control: archived project and the slug purge it.
  archive(f.app, project.id);
  const operation = f.app.retention.purgeProject(project.id, String(project.slug));
  expect(operation.resourceRefs).toEqual([artifact.artifactId]);
});

it("UX-048 purges an archived project: tombstones every live artifact and fixture under one operation and replays idempotently", async () => {
  const f = await fixture();
  const other = f.app.projects.create({ name: "Other project" });
  const artifacts = [await seedArtifact(f), await seedArtifact(f), await seedArtifact(f)];
  const untouched = await seedArtifact(f, { projectId: other.id });
  const fixtureId = (
    await f.app.artifacts.importFixtureInput({
      projectId: f.init.projectId,
      name: "data.csv",
      bytes: new TextEncoder().encode("a,b\n1,2\n"),
      mimeType: "text/csv",
    })
  ).id;
  const project = f.app.projects.get(f.init.projectId);
  const stream = await f.app.artifacts.stream(artifacts[0]?.artifactId as string);
  archive(f.app, project.id);
  const operation = f.app.retention.purgeProject(project.id, String(project.slug));
  expect(new Set(operation.resourceRefs)).toEqual(
    new Set([...artifacts.map((entry) => entry.artifactId), fixtureId]),
  );
  expect(operation.physicalState).toBe("pending");
  for (const entry of artifacts) {
    expect(artifactState(f.app, entry.artifactId)).toBe("expired");
    await expect(f.app.artifacts.stream(entry.artifactId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  }
  // An open stream is revoked as for a single deletion.
  await expect(stream.stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(
    f.app.database.get(
      "SELECT value FROM operational_state WHERE key=?",
      `retention:deletion:${f.app.context.workspaceId}:${fixtureId}`,
    )?.value,
  ).toBe(operation.id);
  // Negative control: another project's artifact stays readable and live.
  expect(artifactState(f.app, untouched.artifactId)).toBe("available");
  await expect(f.app.artifacts.stream(untouched.artifactId)).resolves.toBeDefined();
  // One umbrella audit event, and the per-artifact revocation events share its operation.
  expect(auditActions(f.app, "project.purge")).toHaveLength(1);
  expect(auditActions(f.app, "artifact.deletion_requested")).toHaveLength(4);
  // Replay: same operation, no second tombstone, no second event.
  expect(f.app.retention.purgeProject(project.id, String(project.slug)).id).toBe(operation.id);
  expect(auditActions(f.app, "project.purge")).toHaveLength(1);
  expect(f.app.retention.listDeletionOperations()).toHaveLength(1);
});

it("UX-048 refuses purge to roles without the admin column and allows the roles that hold it", async () => {
  const f = await fixture();
  const artifact = await seedArtifact(f);
  const project = f.app.projects.get(f.init.projectId);
  archive(f.app, project.id);
  const roles = denied("admin");
  expect(roles).toEqual(expect.arrayContaining(["maintainer", "runner", "reviewer", "viewer"]));
  for (const role of roles) {
    const user = await f.member(role);
    expect(() => user.scoped.retention.purgeProject(project.id, String(project.slug))).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  }
  expect(artifactState(f.app, artifact.artifactId)).toBe("available");
  expect(
    f.app.database.get(
      "SELECT 1 FROM operational_state WHERE key LIKE 'retention:project-purge:%'",
    ),
  ).toBeUndefined();
  // Positive control: an org admin purges.
  expect(rbacMatrix.org_admin.admin).toBe("allow");
  const admin = await f.member("org_admin");
  expect(
    admin.scoped.retention.purgeProject(project.id, String(project.slug)).resourceRefs,
  ).toEqual([artifact.artifactId]);
});

it("UX-048 keeps a multi-reference operation unfinished until every artifact is physically deleted and never bypasses a hold", async () => {
  const f = await fixture();
  const [a, b, c] = [await seedArtifact(f), await seedArtifact(f), await seedArtifact(f)] as [
    Awaited<ReturnType<typeof seedArtifact>>,
    Awaited<ReturnType<typeof seedArtifact>>,
    Awaited<ReturnType<typeof seedArtifact>>,
  ];
  const project = f.app.projects.get(f.init.projectId);
  const workspaceId = f.app.context.workspaceId;
  const holdKey = (artifactId: string) => `retention:legal-hold:${workspaceId}:${artifactId}`;
  for (const held of [b, c])
    f.app.database.run(
      "INSERT INTO operational_state(key,value) VALUES(?,'active')",
      holdKey(held.artifactId),
    );
  archive(f.app, project.id);
  const operation = f.app.retention.purgeProject(project.id, String(project.slug));
  // Access is revoked at once even for held artifacts, and the operation reports each hold.
  for (const entry of [a, b, c])
    await expect(f.app.artifacts.stream(entry.artifactId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  expect([...operation.backupHolds].sort()).toEqual(
    [holdKey(b.artifactId), holdKey(c.artifactId)].sort(),
  );
  // Only the unheld artifact is collected; one deleted reference must not complete the operation.
  await f.app.retention.maintenance();
  expect(await exists(a.file)).toBe(false);
  expect(await exists(b.file)).toBe(true);
  expect(await exists(c.file)).toBe(true);
  expect(f.app.retention.deletionStatus(operation.id).physicalState).toBe("pending");
  expect(f.app.retention.deletionStatus(operation.id).backupHolds).toHaveLength(2);
  f.app.database.run("DELETE FROM operational_state WHERE key=?", holdKey(b.artifactId));
  await f.app.retention.maintenance();
  expect(await exists(b.file)).toBe(false);
  expect(await exists(c.file)).toBe(true);
  expect(f.app.retention.deletionStatus(operation.id)).toMatchObject({
    physicalState: "pending",
    backupHolds: [holdKey(c.artifactId)],
  });
  f.app.database.run("DELETE FROM operational_state WHERE key=?", holdKey(c.artifactId));
  await f.app.retention.maintenance();
  expect(await exists(c.file)).toBe(false);
  expect(f.app.retention.deletionStatus(operation.id)).toMatchObject({
    physicalState: "completed",
    backupHolds: [],
  });
});

it("UX-048 refuses a purge while a Run is unfinished before tombstoning anything and succeeds once it completes", async () => {
  const f = await fixture();
  const done = await seedArtifact(f);
  const active = await seedArtifact(f, { completed: false });
  const project = f.app.projects.get(f.init.projectId);
  archive(f.app, project.id);
  expect(() => f.app.retention.purgeProject(project.id, String(project.slug))).toThrowError(
    expect.objectContaining({
      code: "PRECONDITION_FAILED",
      details: { reason: "active_runs" },
    }),
  );
  // All or nothing: the finished Run's artifact was not tombstoned either.
  expect(artifactState(f.app, done.artifactId)).toBe("available");
  expect(artifactState(f.app, active.artifactId)).toBe("available");
  expect(
    f.app.database.get("SELECT 1 FROM operational_state WHERE key LIKE 'retention:deletion:%'"),
  ).toBeUndefined();
  expect(auditActions(f.app, "project.purge")).toHaveLength(0);
  // Positive control: the same project purges after the Run finished.
  f.app.database.run(
    "UPDATE runs SET phase='completed',status='passed',outcome='passed',gate='passed' WHERE workspace_id=? AND id=?",
    f.app.context.workspaceId,
    active.runId,
  );
  const operation = f.app.retention.purgeProject(project.id, String(project.slug));
  expect(new Set(operation.resourceRefs)).toEqual(new Set([done.artifactId, active.artifactId]));
});

it("UX-048 completes an empty project purge at once and lists operations by project, omitting unreadable projects", async () => {
  const f = await fixture();
  const empty = f.app.projects.create({ name: "Empty project" });
  const busy = f.app.projects.create({ name: "Busy project" });
  const artifact = await seedArtifact(f, { projectId: busy.id });
  archive(f.app, empty.id);
  archive(f.app, busy.id);
  const emptyOperation = f.app.retention.purgeProject(empty.id, String(empty.slug));
  expect(emptyOperation).toMatchObject({ resourceRefs: [], physicalState: "completed" });
  const busyOperation = f.app.retention.purgeProject(busy.id, String(busy.slug));
  expect(busyOperation.resourceRefs).toEqual([artifact.artifactId]);
  expect(
    f.app.retention
      .listDeletionOperations()
      .map((entry) => entry.id)
      .sort(),
  ).toEqual([emptyOperation.id, busyOperation.id].sort());
  expect(
    f.app.retention.listDeletionOperations({ projectId: empty.id }).map((entry) => entry.id),
  ).toEqual([emptyOperation.id]);
  expect(
    f.app.retention.listDeletionOperations({ projectId: busy.id }).map((entry) => entry.id),
  ).toEqual([busyOperation.id]);
  expect(f.app.retention.listDeletionOperations({ projectId: f.init.projectId })).toEqual([]);
  // A project-restricted member sees only operations of the project they may read.
  const restricted = await f.member("viewer", [busy.id]);
  expect(restricted.scoped.retention.listDeletionOperations().map((entry) => entry.id)).toEqual([
    busyOperation.id,
  ]);
  expect(() =>
    restricted.scoped.retention.listDeletionOperations({ projectId: empty.id }),
  ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  expect(() => restricted.scoped.retention.deletionStatus(emptyOperation.id)).toThrowError(
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
  // Positive control: the unrestricted caller still reads both.
  expect(f.app.retention.deletionStatus(emptyOperation.id).id).toBe(emptyOperation.id);
});

// ---------------------------------------------------------------------------------- UX-047

const providersFixture = (extraEnv: Record<string, string> = {}) =>
  fixture({
    profile: {
      modelProviders: [
        {
          ...testProvider,
          baseUrl: "http://127.0.0.1:4010/v1/private-path?token=QUERY-CANARY",
          apiKeyEnv: "FAKE_KEY",
        },
        {
          ...testProvider,
          id: "remote",
          baseUrl: "https://models.example.com/v1",
          apiKeyEnv: "REMOTE_KEY",
          models: [
            {
              id: "big",
              capabilities: { structuredJson: true, toolCalls: false, maxOutputTokens: 512 },
            },
          ],
        },
      ],
    },
    policy: { allowedModelProviders: ["fake"] },
    env: { FAKE_KEY: "API-KEY-CANARY-fake", REMOTE_KEY: "API-KEY-CANARY-remote", ...extraEnv },
  });

it("UX-047 shows the configured model providers and profile admission, and never exposes endpoint credentials", async () => {
  const f = await providersFixture();
  const settings = f.app.model.settings(f.init.projectId);
  expect(settings).toEqual({
    projectId: f.init.projectId,
    providers: [
      {
        id: "fake",
        baseUrl: "http://127.0.0.1:4010",
        remote: false,
        models: ["model"],
        allowedByProfile: true,
      },
      {
        id: "remote",
        baseUrl: "https://models.example.com",
        remote: true,
        models: ["big"],
        allowedByProfile: false,
      },
    ],
  });
  const serialized = JSON.stringify(settings);
  for (const secret of [
    "QUERY-CANARY",
    "private-path",
    "API-KEY-CANARY-fake",
    "API-KEY-CANARY-remote",
    "apiKey",
    "FAKE_KEY",
  ])
    expect(serialized).not.toContain(secret);
});

it("UX-047 lets every role read the model providers and refuses an unknown project", async () => {
  const f = await providersFixture();
  for (const role of [...denied("admin"), "org_admin" as const]) {
    const user = await f.member(role);
    expect(user.scoped.model.settings(f.init.projectId).providers).toHaveLength(2);
  }
  expect(() => f.app.model.settings(uuidV7IdGenerator.next("prj"))).toThrowError(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
});

// ---------------------------------------------------------------------------------- D5

it("M4-05 lists environment revisions newest first and never returns variables", async () => {
  const f = await fixture();
  const ctx = f.app.context;
  const environment = f.app.environments.get(f.init.environmentId);
  const second = f.app.environments.update(
    environment.id,
    { locale: "pt-BR" },
    Number(environment.version),
  );
  f.app.environments.update(environment.id, { production: true }, Number(second.version));
  const active = f.app.environments.get(environment.id).activeRevisionId;
  const revisions = f.app.environments.revisions(environment.id);
  expect(revisions).toHaveLength(3);
  expect(revisions[0]?.id).toBe(active);
  expect(revisions.map((entry) => [entry.locale, entry.production])).toEqual([
    ["pt-BR", true],
    ["pt-BR", false],
    ["en-US", false],
  ]);
  expect(Object.keys(revisions[0] ?? {}).sort()).toEqual(
    [
      "additionalOrigins",
      "authProfileRefs",
      "createdAt",
      "id",
      "locale",
      "networkProfile",
      "production",
      "serverLog",
      "targetOrigins",
      "timezone",
    ].sort(),
  );
  // Positive control: a stored revision that carries a captured value is listed, minus the value.
  const canary = entity(ctx, "evr", {
    targetOrigins: ["https://shop.example"],
    networkProfile: "public",
    authProfileRefs: [],
    locale: "en-US",
    timezone: "UTC",
    variables: {
      token: {
        name: "token",
        valueType: "string",
        sensitive: true,
        value: { literal: "VARIABLE-CANARY" },
      },
    },
    production: false,
  });
  ctx.entities.insert(
    "EnvironmentRevision",
    { ...canary, createdAt: old },
    { environmentId: environment.id },
  );
  expect(
    JSON.stringify(f.app.database.all("SELECT data_json FROM environment_revisions")),
  ).toContain("VARIABLE-CANARY");
  const listed = f.app.environments.revisions(environment.name);
  expect(listed).toHaveLength(4);
  expect(listed.at(-1)?.id).toBe(canary.id);
  // A revision stored before the field existed reads as an empty list.
  expect(listed.at(-1)?.additionalOrigins).toEqual([]);
  expect(JSON.stringify(listed)).not.toContain("VARIABLE-CANARY");
  expect(JSON.stringify(listed)).not.toContain("variables");
});

// ------------------------------------------------------------------ additional origins

const publicEnvironment = {
  baseUrl: "https://app.example.test",
  networkProfile: "public" as const,
};

it("stores exact additional origins per revision without touching target origins, and update replaces or clears them", async () => {
  const f = await fixture();
  const environments = f.app.environments;
  const extras = ["https://flagcdn.com", "https://cdn.example.test:8443"];
  const created = environments.create({
    projectId: f.init.projectId,
    name: "with-extras",
    ...publicEnvironment,
    additionalOrigins: extras,
  });
  expect(environments.revisions(created.id)[0]).toMatchObject({
    targetOrigins: ["https://app.example.test"],
    additionalOrigins: extras,
  });
  // Control: an environment created without the field has none.
  const plain = environments.create({
    projectId: f.init.projectId,
    name: "plain",
    ...publicEnvironment,
  });
  expect(environments.revisions(plain.id)[0]?.additionalOrigins).toEqual([]);
  // An unrelated update carries the list into the new revision.
  const relocated = environments.update(created.id, { locale: "pt-BR" }, Number(created.version));
  expect(environments.revisions(created.id)[0]?.additionalOrigins).toEqual(extras);
  const replaced = environments.update(
    created.id,
    { additionalOrigins: ["https://fonts.example.test"] },
    Number(relocated.version),
  );
  const cleared = environments.update(
    created.id,
    { additionalOrigins: [] },
    Number(replaced.version),
  );
  expect(environments.revisions(created.id).map((entry) => entry.additionalOrigins)).toEqual([
    [],
    ["https://fonts.example.test"],
    extras,
    extras,
  ]);
  // The additional origins never become target origins on any revision.
  expect(
    environments.revisions(created.id).every((entry) => entry.targetOrigins.length === 1),
  ).toBe(true);
  expect(cleared.activeRevisionId).toBe(environments.revisions(created.id)[0]?.id);
});

it.each([
  ["a path", ["https://cdn.example.test/img"], "INVALID_ARGUMENT"],
  ["a query", ["https://cdn.example.test/?x=1"], "INVALID_ARGUMENT"],
  ["credentials", ["https://user:pass@cdn.example.test"], "INVALID_ARGUMENT"],
  ["a fragment", ["https://cdn.example.test/#x"], "INVALID_ARGUMENT"],
  ["a wildcard", ["https://*.example.test"], "INVALID_ARGUMENT"],
  ["a non-HTTP scheme", ["ftp://cdn.example.test"], "INVALID_ARGUMENT"],
  ["a bare host", ["cdn.example.test"], "INVALID_ARGUMENT"],
  ["the target origin", ["https://app.example.test"], "INVALID_ARGUMENT"],
  ["a duplicate", ["https://cdn.example.test", "https://cdn.example.test:443"], "INVALID_ARGUMENT"],
  [
    "too many origins",
    Array.from({ length: 33 }, (_, i) => `https://c${i}.example.test`),
    "INVALID_ARGUMENT",
  ],
  ["loopback under the public profile", ["http://127.0.0.1:9000"], "POLICY_DENIED"],
  ["localhost under the public profile", ["http://localhost:9000"], "POLICY_DENIED"],
  ["a private address under the public profile", ["http://10.0.0.5"], "POLICY_DENIED"],
  ["the cloud metadata address", ["http://169.254.169.254"], "POLICY_DENIED"],
])("refuses additional origins with %s", async (_label, additionalOrigins, code) => {
  const f = await fixture();
  const before = f.app.database.all("SELECT id FROM environment_revisions").length;
  expect(() =>
    f.app.environments.create({
      projectId: f.init.projectId,
      name: "refused",
      ...publicEnvironment,
      additionalOrigins,
    }),
  ).toThrowError(expect.objectContaining({ code }));
  expect(f.app.database.all("SELECT id FROM environment_revisions")).toHaveLength(before);
});

// ------------------------------------------------------------------ server log

it("stores an opted-in server log source per revision, keeps it across updates and clears it with null", async () => {
  const f = await fixture();
  const environments = f.app.environments;
  const source = { kind: "docker" as const, container: "searxng-tm-app" };
  const created = environments.create({
    projectId: f.init.projectId,
    name: "with-log",
    ...publicEnvironment,
    serverLog: source,
  });
  expect(environments.revisions(created.id)[0]?.serverLog).toEqual(source);
  // Control: nothing is read unless the environment opts in.
  const plain = environments.create({
    projectId: f.init.projectId,
    name: "no-log",
    ...publicEnvironment,
  });
  expect(environments.revisions(plain.id)[0]?.serverLog).toBeNull();
  const relocated = environments.update(created.id, { locale: "pt-BR" }, Number(created.version));
  const cleared = environments.update(created.id, { serverLog: null }, Number(relocated.version));
  expect(environments.revisions(created.id).map((entry) => entry.serverLog)).toEqual([
    null,
    source,
    source,
  ]);
  expect(
    f.app.context.entities.get(
      "EnvironmentRevision",
      f.app.context.workspaceId,
      cleared.activeRevisionId,
    ),
  ).not.toHaveProperty("serverLog");
});

it.each([
  ["an option-like name", { kind: "docker", container: "--since=0" }],
  ["a name with a space", { kind: "docker", container: "app server" }],
  ["a one-character name", { kind: "docker", container: "a" }],
  ["an unknown kind", { kind: "file", container: "app" }],
  ["an unknown field", { kind: "docker", container: "app", path: "/var/log" }],
  ["a bare string", "app"],
])("refuses a server log source with %s", async (_label, serverLog) => {
  const f = await fixture();
  const before = f.app.database.all("SELECT id FROM environment_revisions").length;
  expect(() =>
    f.app.environments.create({
      projectId: f.init.projectId,
      name: "refused",
      ...publicEnvironment,
      serverLog: serverLog as never,
    }),
  ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  expect(f.app.database.all("SELECT id FROM environment_revisions")).toHaveLength(before);
});

it("applies the network profile to literal additional origins like the base URL and rechecks them on update", async () => {
  const f = await fixture();
  const environments = f.app.environments;
  const input = { projectId: f.init.projectId };
  // Positive controls: each profile accepts the literal addresses it permits.
  environments.create({
    ...input,
    name: "public-literal",
    ...publicEnvironment,
    additionalOrigins: ["https://8.8.8.8"],
  });
  environments.create({
    ...input,
    name: "private-literal",
    baseUrl: "http://10.0.0.7:3000",
    networkProfile: "private",
    additionalOrigins: ["http://10.0.0.5:9000"],
  });
  const loopback = environments.create({
    ...input,
    name: "loopback-literal",
    baseUrl: "http://127.0.0.1:3100",
    networkProfile: "local-loopback",
    additionalOrigins: ["http://127.0.0.1:9000", "https://flagcdn.com"],
  });
  const revisions = environments.revisions(loopback.id).length;
  // Switching to a profile that no longer permits a stored origin is refused, and nothing is stored.
  expect(() =>
    environments.update(loopback.id, { networkProfile: "public" }, Number(loopback.version)),
  ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
  // Moving the base URL onto a stored additional origin is refused as a duplicate.
  expect(() =>
    environments.update(
      loopback.id,
      { baseUrl: "http://127.0.0.1:9000" },
      Number(loopback.version),
    ),
  ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  expect(environments.revisions(loopback.id)).toHaveLength(revisions);
  // Clearing together with the profile change is accepted.
  environments.update(
    loopback.id,
    { networkProfile: "public", additionalOrigins: ["https://flagcdn.com"] },
    Number(loopback.version),
  );
  expect(environments.revisions(loopback.id)[0]).toMatchObject({
    networkProfile: "public",
    additionalOrigins: ["https://flagcdn.com"],
  });
});

it("merges additional origins into an attempt policy only outside offline profiles and never duplicates a target", () => {
  const revision = { additionalOrigins: ["https://flagcdn.com", "http://127.0.0.1:3000"] };
  expect(attemptAdditionalOrigins(revision, ["http://127.0.0.1:3000"], false)).toEqual([
    "https://flagcdn.com",
  ]);
  expect(attemptAdditionalOrigins(revision, ["http://127.0.0.1:3000"], true)).toEqual([]);
  expect(attemptAdditionalOrigins({}, ["http://127.0.0.1:3000"], false)).toEqual([]);
});

// ---------------------------------------------------------------------------------- UX-056

it("UX-056 refuses CI gates in a demonstration workspace without writing any gate artifact and resumes after the policy changes", async () => {
  const f = await fixture();
  const ctx = f.app.context;
  const input = { projectId: f.init.projectId, environmentId: f.init.environmentId };
  expect(isDemoWorkspace(ctx)).toBe(false);
  // Positive control: a normal workspace reaches admission and writes its envelope.
  const normal = await f.app.ci.run({ ...input, outputDir: join(f.root, "normal") });
  expect(normal.kind).toBe("admission_rejected");
  expect(await exists(join(f.root, "normal", "report.json"))).toBe(true);
  const workspace = ctx.entities.get("Workspace", ctx.workspaceId, ctx.workspaceId);
  const updated = f.app.workspaces.update(
    ctx.workspaceId,
    { quotaPolicyId: "demo" },
    Number(workspace?.version),
  );
  expect(isDemoWorkspace(ctx)).toBe(true);
  await expect(f.app.ci.run({ ...input, outputDir: join(f.root, "demo") })).rejects.toMatchObject({
    code: "POLICY_DENIED",
    details: { reason: "demo_workspace" },
  });
  expect(await exists(join(f.root, "demo"))).toBe(false);
  expect(
    f.app.database.get("SELECT 1 FROM operational_state WHERE key LIKE 'ci:result:%'"),
  ).toBeUndefined();
  f.app.workspaces.update(ctx.workspaceId, { quotaPolicyId: "default" }, Number(updated.version));
  expect(isDemoWorkspace(ctx)).toBe(false);
  expect((await f.app.ci.run({ ...input, outputDir: join(f.root, "after") })).kind).toBe(
    "admission_rejected",
  );
});
