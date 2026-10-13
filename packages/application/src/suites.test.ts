import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BatchReceipt, Role, SuiteSelection } from "@testmaster/contracts";
import { afterEach, expect, it } from "vitest";
import { Application, scaffoldPlan } from "./index.js";

const roots: string[] = [];
const apps: Application[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Two projects with a `staging` environment each, different origins, secrets and two tests per project. */
async function world() {
  const root = await mkdtemp(join(tmpdir(), "tm-suites-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home, env: {} });
  apps.push(app);
  app.preflight = async () => {};
  const init = await app.init();
  const projectB = app.projects.create({ name: "Project B" });
  const origins = { a: "http://127.0.0.1:4101", b: "http://127.0.0.1:4102" };
  const stagingA = app.environments.create({
    projectId: init.projectId,
    name: "staging",
    baseUrl: origins.a,
  });
  const stagingB = app.environments.create({
    projectId: projectB.id,
    name: "staging",
    baseUrl: origins.b,
  });
  const secretA = await app.secrets.set("token-a", "secret-a-value", {
    ephemeral: true,
    allowedOrigins: [origins.a],
  });
  const secretB = await app.secrets.set("token-b", "secret-b-value", {
    ephemeral: true,
    allowedOrigins: [origins.b],
  });
  const make = (projectId: string, name: string, secretId: string | null, tags: string[] = []) => {
    const plan = scaffoldPlan("backend");
    const step = plan.steps[0];
    if (secretId && step?.operation === "request")
      step.input.headers = { Authorization: { secretRef: secretId } };
    return app.tests.create({ projectId, plan, name, tags });
  };
  const a1 = make(init.projectId, "a-checkout", secretA.id, ["smoke"]);
  const a2 = make(init.projectId, "a-profile", null);
  const b1 = make(projectB.id, "b-checkout", secretB.id, ["smoke"]);
  const b2 = make(projectB.id, "b-profile", null);
  const dynamic = (): SuiteSelection => ({
    kind: "dynamic",
    projects: [
      { projectId: init.projectId, environmentId: stagingA.id },
      { projectId: projectB.id, environmentId: stagingB.id },
    ],
  });
  let counter = 0;
  /** An identity with the given role confined to `restrictions`; stubs avoid a real executor. */
  const member = (role: Role, restrictions: string[]): Application => {
    const login = `${role.replace("_", "-")}-${++counter}`;
    const added = app.members.add(init.workspaceId, {
      login,
      displayName: login,
      role,
      projectRestrictions: restrictions,
    });
    const scoped = app.forIdentity({
      principalId: added.member.principalId,
      scopes: ["R", "W", "X"],
      grants: [],
      workspaceId: init.workspaceId,
      credential: { kind: "api", id: `tok_${login}` },
    });
    scoped.preflight = async () => {};
    return scoped;
  };
  return {
    app,
    init,
    projectB,
    stagingA,
    stagingB,
    origins,
    secretA,
    secretB,
    tests: { a1, a2, b1, b2 },
    dynamic,
    member,
  };
}
interface FrozenSuite {
  hash: unknown;
  mapping: unknown[];
}
/** The suite provenance frozen on a BatchRun's selection snapshot. */
const frozenSuite = (batch: { selectionSnapshot?: unknown } | null | undefined): FrozenSuite => {
  const snapshot = batch?.selectionSnapshot as { suite: FrozenSuite } | undefined;
  if (!snapshot) throw new Error("BatchRun has no frozen suite");
  return snapshot.suite;
};
const batchRows = (app: Application) =>
  app.database.all("SELECT id,version FROM batches ORDER BY id");

it("REQ-034 UX-041 a dynamic list expands across projects with one pinned environment and one mapping row per project", async () => {
  const { app, init, projectB, stagingA, stagingB, origins, secretA, secretB, dynamic } =
    await world();
  const suite = app.suites.create({ name: "cross-project", selection: dynamic() });
  const expansion = app.suites.expansion(suite.id);
  expect(expansion.kind).toBe("dynamic");
  expect(expansion.exclusions).toEqual([]);
  expect(expansion.requiresConfirmation).toEqual([]);
  expect(expansion.members.map((member) => member.testName)).toEqual([
    "a-checkout",
    "a-profile",
    "b-checkout",
    "b-profile",
  ]);
  expect(expansion.mapping).toHaveLength(2);
  const [mapA, mapB] = expansion.mapping;
  expect(mapA).toMatchObject({
    projectId: init.projectId,
    environmentId: stagingA.id,
    targetOrigins: [origins.a],
    secretRefs: [secretA.id],
    memberCount: 2,
  });
  expect(mapB).toMatchObject({
    projectId: projectB.id,
    environmentId: stagingB.id,
    targetOrigins: [origins.b],
    secretRefs: [secretB.id],
    memberCount: 2,
  });
  // Negative control: the two mappings share no destination and no credential.
  expect(mapA?.targetOrigins).not.toEqual(mapB?.targetOrigins);
  expect(mapA?.secretRefs).not.toContain(secretB.id);
  expect(JSON.stringify(expansion)).not.toContain("secret-a-value");
});

it("UX-041 a dynamic list filters by tag per project and a fixed list pins revisions", async () => {
  const { app, init, projectB, stagingA, stagingB, tests } = await world();
  const filtered = app.suites.preview({
    name: "smoke-only",
    selection: {
      kind: "dynamic",
      projects: [
        { projectId: init.projectId, environmentId: stagingA.id, filter: { tags: ["smoke"] } },
        { projectId: projectB.id, environmentId: stagingB.id },
      ],
    },
  });
  expect(filtered.members.map((member) => member.testName)).toEqual([
    "a-checkout",
    "b-checkout",
    "b-profile",
  ]);
  const pinned = String(tests.a1.activeRevisionId);
  const fixed = app.suites.create({
    name: "pinned",
    selection: {
      kind: "fixed",
      members: [{ testId: tests.a1.id, revisionId: pinned, environmentId: stagingA.id }],
    },
  });
  // A new revision of the test does not change what the fixed list runs.
  const plan = scaffoldPlan("backend");
  const revised = app.revisions.create(tests.a1.id, plan, pinned);
  app.revisions.promote(revised.id, Number(app.tests.get(tests.a1.id).version));
  const expansion = app.suites.expansion(fixed.id);
  expect(expansion.members).toHaveLength(1);
  expect(expansion.members[0]?.revisionId).toBe(pinned);
  // Negative control: a dynamic list follows the active revision.
  const dynamicNow = app.suites.preview({
    name: "follows-active",
    selection: {
      kind: "dynamic",
      projects: [{ projectId: init.projectId, environmentId: stagingA.id }],
    },
  });
  const active = app.tests.get(tests.a1.id).activeRevisionId;
  expect(active).not.toBe(pinned);
  expect(dynamicNow.members.find((member) => member.testId === tests.a1.id)?.revisionId).toBe(
    active,
  );
});

it("REQ-034 UX-041 running a list freezes expansion, revisions and mapping on the BatchRun and later edits never alter it", async () => {
  const { app, init, stagingA, stagingB, projectB, dynamic, tests } = await world();
  const suite = app.suites.create({ name: "frozen", selection: dynamic() });
  const receipt = await app.suites.run(suite.id, {}, { wait: true });
  expect(receipt.requested).toBe(4);
  expect(receipt.accepted).toBe(4);
  expect(receipt.notDispatched).toEqual([]);
  const batch = app.context.entities.get("BatchRun", init.workspaceId, receipt.batchId);
  expect(batch?.suiteId).toBe(suite.id);
  const snapshot = frozenSuite(batch);
  const frozenHash = snapshot.hash;
  expect((snapshot.mapping as unknown[]).length).toBe(2);
  const runRevisions = receipt.memberRuns.map(
    (run) => app.runs.get(run.runId).revisionId as string,
  );

  // Edit the list, add a test, change a revision, archive a project environment's test.
  app.suites.update(
    suite.id,
    { selection: { kind: "dynamic", projects: [dynamic().projects?.[0] as never] } as never },
    Number(suite.version),
  );
  app.tests.create({ projectId: projectB.id, plan: scaffoldPlan("backend"), name: "b-late" });
  app.revisions.create(tests.a1.id, scaffoldPlan("backend"), String(tests.a1.activeRevisionId));

  const after = app.context.entities.get("BatchRun", init.workspaceId, receipt.batchId);
  expect(frozenSuite(after).hash).toBe(frozenHash);
  expect(after?.memberRuns).toEqual(batch?.memberRuns);
  expect(receipt.memberRuns.map((run) => app.runs.get(run.runId).revisionId)).toEqual(runRevisions);
  // Negative control: the edited list now resolves to something else.
  expect(app.suites.expansion(suite.id).hash).not.toBe(frozenHash);
  expect(stagingA.id).not.toBe(stagingB.id);
});

it("REQ-034 UX-042 a viewer with access to one project cannot run the other and the list never silently shrinks", async () => {
  const { app, init, projectB, dynamic, member } = await world();
  const suite = app.suites.create({ name: "partial", selection: dynamic() });
  const restricted = member("maintainer", [init.projectId]);
  const before = batchRows(app);
  const expansion = restricted.suites.expansion(suite.id);
  expect(expansion.exclusions).toHaveLength(1);
  expect(expansion.exclusions[0]).toMatchObject({
    key: `project:${projectB.id}`,
    kind: "access_denied",
    reasonCode: "actor_revoked",
  });
  expect(expansion.members.every((item) => item.projectId === init.projectId)).toBe(true);
  expect(expansion.requiresConfirmation).toEqual([`project:${projectB.id}`]);
  // Without confirmation nothing is admitted at all.
  await expect(restricted.suites.run(suite.id, {}, { wait: true })).rejects.toMatchObject({
    code: "FORBIDDEN",
    details: { exclusions: [expect.objectContaining({ key: `project:${projectB.id}` })] },
  });
  expect(batchRows(app)).toEqual(before);
  // Negative control: the unrestricted owner runs the whole list without a confirmation.
  const full = await app.suites.run(suite.id, {}, { wait: true });
  expect(full.requested).toBe(4);
  expect(full.notDispatched).toEqual([]);
});

it("REQ-034 UX-042 a confirmed subset dispatches the allowed part and the BatchRun declares what was left out with a failed gate", async () => {
  const { app, init, projectB, dynamic, member } = await world();
  const suite = app.suites.create({ name: "subset", selection: dynamic() });
  const restricted = member("maintainer", [init.projectId]);
  const receipt = await restricted.suites.run(
    suite.id,
    { confirmedExclusions: [`project:${projectB.id}`] },
    { wait: true },
  );
  expect(receipt.accepted).toBe(2);
  expect(receipt.notDispatched).toEqual([
    { memberKey: `project:${projectB.id}`, reasonCode: "actor_revoked" },
  ]);
  expect(receipt.gate).not.toBe("passed");
  const batch = app.context.entities.get("BatchRun", init.workspaceId, receipt.batchId);
  expect(batch?.rejectedMembers).toEqual(receipt.notDispatched);
  const fetched = app.batches.get(receipt.batchId);
  expect(fetched.rejectedMembers).toEqual(receipt.notDispatched);
  expect(fetched.aggregate.gate).not.toBe("passed");
  // Negative control: only members of the permitted project were admitted.
  const projects = receipt.memberRuns.map((run) => {
    const test = app.tests.get(String(app.runs.get(run.runId).testId));
    return test.projectId;
  });
  expect(new Set(projects)).toEqual(new Set([init.projectId]));
});

it("REQ-034 UX-042 confirming an exclusion that does not apply or a stale expansion hash is refused", async () => {
  const { app, init, projectB, dynamic, member } = await world();
  const suite = app.suites.create({ name: "confirm", selection: dynamic() });
  const restricted = member("maintainer", [init.projectId]);
  await expect(
    restricted.suites.run(
      suite.id,
      { confirmedExclusions: ["project:prj_unknown"] },
      { wait: true },
    ),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(
    app.suites.run(suite.id, { confirmedExclusions: [`project:${projectB.id}`] }, { wait: true }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  const hash = app.suites.expansion(suite.id).hash;
  app.tests.create({ projectId: projectB.id, plan: scaffoldPlan("backend"), name: "b-new" });
  await expect(
    app.suites.run(suite.id, { expectedExpansionHash: hash }, { wait: true }),
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  // Negative control: the fresh hash is accepted.
  const fresh = app.suites.expansion(suite.id).hash;
  const receipt = await app.suites.run(suite.id, { expectedExpansionHash: fresh }, { wait: true });
  expect(receipt.requested).toBe(5);
});

it("REQ-034 a grant on one project does not authorize another project in a list", async () => {
  const { app, init, projectB, stagingB, tests, member } = await world();
  const restricted = member("maintainer", [init.projectId]);
  // The restricted member cannot even save a list that names the other project.
  expect(() =>
    restricted.suites.create({
      name: "sneaky",
      selection: {
        kind: "fixed",
        members: [
          {
            testId: tests.b1.id,
            revisionId: String(tests.b1.activeRevisionId),
            environmentId: stagingB.id,
          },
        ],
      },
    }),
  ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  expect(() =>
    restricted.suites.preview({
      name: "sneaky-dynamic",
      selection: {
        kind: "dynamic",
        projects: [{ projectId: projectB.id, environmentId: stagingB.id }],
      },
    }),
  ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  expect(app.suites.list()).toEqual([]);
  // Negative control: the same member can save a list inside its own project.
  const own = restricted.suites.create({
    name: "own",
    selection: {
      kind: "dynamic",
      projects: [
        {
          projectId: init.projectId,
          environmentId: String(app.environments.list(init.projectId)[0]?.id),
        },
      ],
    },
  });
  expect(own.id).toMatch(/^sui_/);
});

it("UX-041 retrying with the same idempotency key returns the original batch even after the list was edited", async () => {
  const { app, dynamic, projectB } = await world();
  const suite = app.suites.create({ name: "idempotent", selection: dynamic() });
  const key = "suite-run-0123456789abcdef";
  const first = await app.suites.run(suite.id, {}, { wait: true, idempotencyKey: key });
  const edited = app.suites.update(
    suite.id,
    { selection: { kind: "dynamic", projects: [dynamic().projects?.[1] as never] } as never },
    Number(suite.version),
  );
  expect(edited.version).toBe(Number(suite.version) + 1);
  const retry = await app.suites.run(suite.id, {}, { wait: true, idempotencyKey: key });
  expect(retry.batchId).toBe(first.batchId);
  expect(batchRows(app)).toHaveLength(1);
  // Negative control: a different key admits a new batch from the edited list.
  const second = await app.suites.run(
    suite.id,
    {},
    { wait: true, idempotencyKey: "suite-run-fedcba9876543210" },
  );
  expect(second.batchId).not.toBe(first.batchId);
  expect(second.requested).toBe(2);
  expect(projectB.id).toMatch(/^prj_/);
});

it("REQ-034 an archived environment excludes its project and an archived list cannot run", async () => {
  const { app, projectB, stagingB, dynamic } = await world();
  const suite = app.suites.create({ name: "unavailable", selection: dynamic() });
  app.environments.archive(stagingB.id, Number(stagingB.version));
  const expansion = app.suites.expansion(suite.id);
  expect(expansion.exclusions).toMatchObject([
    { key: `project:${projectB.id}`, kind: "environment_unavailable" },
  ]);
  await expect(app.suites.run(suite.id, {}, { wait: true })).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
  const current = app.suites.get(suite.id);
  const archived = app.suites.archive(suite.id, Number(current.version));
  await expect(app.suites.run(archived.id, {}, { wait: true })).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
  expect(app.suites.list().map((item) => item.id)).not.toContain(suite.id);
});

it("UX-041 previewing a list leaves execution rows unchanged", async () => {
  const { app, dynamic } = await world();
  const rows = () =>
    ["runs", "attempts", "batches", "outbox", "job_leases", "suites"].map((table) =>
      app.database.all(`SELECT * FROM ${table}`),
    );
  const before = rows();
  const preview = app.suites.preview({ name: "preview", selection: dynamic() });
  expect(preview.suiteId).toBeNull();
  expect(preview.members).toHaveLength(4);
  expect(rows()).toEqual(before);
  // Negative control: saving the list does write a row.
  app.suites.create({ name: "preview", selection: dynamic() });
  expect(rows()).not.toEqual(before);
});

it("REQ-034 an empty dynamic list is not dispatchable and admits nothing", async () => {
  const { app, init, stagingA, tests } = await world();
  const suite = app.suites.create({
    name: "nothing-matches",
    selection: {
      kind: "dynamic",
      projects: [
        {
          projectId: init.projectId,
          environmentId: stagingA.id,
          filter: { tags: ["does-not-exist"] },
        },
      ],
    },
  });
  expect(app.suites.expansion(suite.id).dispatchable).toBe(false);
  const before = batchRows(app);
  await expect(app.suites.run(suite.id, {}, { wait: true })).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
  expect(batchRows(app)).toEqual(before);
  expect(tests.a1.id).toMatch(/^tst_/);
});

it("REQ-034 a suite run reports the BatchReceipt of the batch gate and never passes on dropped members", async () => {
  const { app, projectB, dynamic, member, init } = await world();
  const suite = app.suites.create({ name: "gate", selection: dynamic() });
  const restricted = member("runner", [init.projectId]);
  const receipt: BatchReceipt = await restricted.suites.run(
    suite.id,
    { confirmedExclusions: [`project:${projectB.id}`] },
    { wait: true },
  );
  expect(receipt.requested).toBe(receipt.accepted + receipt.notDispatched.length);
  expect(["failed", "blocked", "inconclusive", "pending"]).toContain(receipt.gate);
});
