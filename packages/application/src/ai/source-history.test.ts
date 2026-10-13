import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutablePlan } from "@testmaster/contracts";
import { afterEach, expect, it } from "vitest";
import { Application } from "../application.js";
import { scaffoldPlan } from "../authoring.js";
import { entity } from "../context.js";

const apps: Application[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const ok = { responses: { "200": { description: "ok" } } };
const byId = {
  get: {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    responses: { "200": { description: "ok" } },
  },
};
const api = (paths: Record<string, unknown>) =>
  JSON.stringify({ openapi: "3.0.3", info: { title: "Shop", version: "1" }, paths });
const V1 = api({
  "/orders": { get: ok },
  "/orders/{id}": byId,
  "/legacy": { get: ok },
});
const V2 = api({
  "/orders": {
    get: { responses: { "200": { description: "list" }, "404": { description: "none" } } },
  },
  "/orders/{id}": byId,
  "/refunds": { post: ok },
});

function requestPlan(name: string, path: string, requirementRefs: string[] = []): ExecutablePlan {
  const plan = scaffoldPlan("backend");
  plan.name = name;
  plan.requirementRefs = requirementRefs;
  plan.steps = [
    {
      id: "call",
      kind: "action",
      operation: "request",
      description: "Call the endpoint",
      input: {
        method: "GET",
        pathSegments: path
          .split("/")
          .filter(Boolean)
          .map((literal) => ({ literal })),
      },
    },
    {
      id: "status",
      kind: "assertion",
      operation: "assert",
      description: "Status is 200",
      input: { responseStepId: "call" },
      expectation: { predicate: "statusIn", values: [200] },
    },
  ];
  return plan;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tm-source-history-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home, env: { HOME: home } });
  apps.push(app);
  const init = await app.init();
  await writeFile(join(root, "openapi.json"), V1);
  const first = await app.sources.add({
    projectId: init.projectId,
    role: "api-spec",
    path: "openapi.json",
  });
  await writeFile(join(root, "openapi.json"), V2);
  const second = await app.sources.add({
    projectId: init.projectId,
    role: "api-spec",
    path: "openapi.json",
    sourceId: first.source.id,
    expectedVersion: Number(first.source.version),
  });
  return { app, root, projectId: init.projectId, first, second, sourceId: first.source.id };
}

it("UX-044 keeps every revision with its hash and importer and diffs each against its parent", async () => {
  const { app, first, second, sourceId } = await fixture();
  const history = await app.sources.history(sourceId);
  expect(history.revisions.map((item) => item.ordinal)).toEqual([2, 1]);
  const [latest, previous] = history.revisions;
  expect(latest).toMatchObject({
    active: true,
    parentId: first.revision.id,
    contentHash: second.revision.contentHash,
    importedBy: app.context.principalId,
  });
  expect(previous).toMatchObject({
    active: false,
    contentHash: first.revision.contentHash,
    changes: null,
  });
  expect(latest?.contentHash).not.toBe(previous?.contentHash);
  expect(latest?.changes?.operations).toEqual({
    added: ["POST /refunds"],
    removed: ["GET /legacy"],
    changed: ["GET /orders"],
  });
  // The previous revision is retained and still readable, never replaced by the update.
  expect(app.sources.revision(first.revision.id).revision.contentHash).toBe(
    first.revision.contentHash,
  );
  expect(previous?.chunkCount).toBeGreaterThan(0);
  // Negative control: an operation that did not change is not reported as changed.
  const reported = Object.values(latest?.changes?.operations ?? {}).flat();
  expect(reported).not.toContain("GET /orders/{id}");
});

it("UX-011 reports owner, origin update state and counts, and notices a changed or missing origin", async () => {
  const { app, root, projectId, second } = await fixture();
  const read = async () => (await app.sources.listWithOverview(projectId))[0]?.overview;
  expect(await read()).toMatchObject({
    ownerId: app.context.principalId,
    revisionCount: 2,
    active: { id: second.revision.id, ordinal: 2, importedBy: app.context.principalId },
    origin: { kind: "local-file", path: "openapi.json", state: "unchanged" },
    diagnostics: 0,
  });
  await writeFile(join(root, "openapi.json"), V1);
  expect((await read())?.origin.state).toBe("changed");
  await unlink(join(root, "openapi.json"));
  expect((await read())?.origin.state).toBe("missing");
});

it("UX-044 lists only tests that rest on a changed, removed or superseded declaration", async () => {
  const { app, projectId, first, sourceId } = await fixture();
  const create = (plan: ExecutablePlan) => app.tests.create({ projectId, plan });
  const changed = create(requestPlan("Orders list", "/orders"));
  const removed = create(requestPlan("Legacy ping", "/legacy"));
  const untouched = create(requestPlan("Order detail", "/orders/7"));
  const pinned = requestPlan("Orders schema", "/orders/7");
  pinned.steps.push({
    id: "schema",
    kind: "assertion",
    operation: "assert",
    description: "Body matches the v1 schema",
    input: { responseStepId: "call" },
    expectation: {
      predicate: "jsonSchema",
      sourceRevisionId: first.revision.id,
      pointer: "/paths/~1orders/get",
    },
  });
  const superseded = create(pinned);
  const history = await app.sources.history(sourceId);
  const byTest = Object.fromEntries(history.staleTests.map((item) => [item.testId, item.reasons]));
  expect(byTest[changed.id]).toEqual(["endpoint_changed: GET /orders"]);
  expect(byTest[removed.id]).toEqual(["endpoint_removed: GET /legacy"]);
  expect(byTest[superseded.id]).toEqual(["assertion_cites_superseded_revision"]);
  // Negative control: a test on an unchanged operation is not flagged.
  expect(byTest[untouched.id]).toBeUndefined();
  expect(history.staleTests).toHaveLength(3);
  expect((await app.sources.listWithOverview(projectId))[0]?.overview.dependents.staleTests).toBe(
    3,
  );
});

it("UX-044 flags tests through the requirements whose evidence cites a superseded revision", async () => {
  const { app, projectId, first, second, sourceId } = await fixture();
  const requirement = (revisionId: string, key: string) => {
    const value = entity(app.context, "req", {
      text: `Requirement ${key}`,
      acceptanceCriteria: ["It works"],
      sourceRefs: [{ sourceRevisionId: revisionId, contentHash: first.revision.contentHash }],
      originKind: "explicit",
      confidence: null,
      approval: null,
      extensions: { "testmaster:projectId": projectId, "testmaster:key": key },
    });
    app.context.entities.insert("Requirement", value, { projectId });
    return value;
  };
  const stale = requirement(first.revision.id, "old");
  const fresh = requirement(second.revision.id, "new");
  const onStale = app.tests.create({
    projectId,
    plan: requestPlan("Uses old basis", "/orders/7", [stale.id]),
  });
  const onFresh = app.tests.create({
    projectId,
    plan: requestPlan("Uses new basis", "/orders/8", [fresh.id]),
  });
  const history = await app.sources.history(sourceId);
  const flagged = history.staleTests.map((item) => item.testId);
  expect(flagged).toContain(onStale.id);
  expect(history.staleTests.find((item) => item.testId === onStale.id)?.reasons).toContain(
    "requirement_cites_superseded_revision",
  );
  expect(flagged).not.toContain(onFresh.id);
});

it("UX-044 states the fixed exclusion policy and still refuses excluded files", async () => {
  const { app, root, projectId, sourceId } = await fixture();
  const history = await app.sources.history(sourceId, ["dist/**", "coverage/**"]);
  expect(history.exclusions.policy).toEqual(
    expect.arrayContaining([".env, .env.*", ".git/", "*.pem"]),
  );
  expect(history.exclusions.discovery).toEqual(["dist/**", "coverage/**"]);
  await writeFile(join(root, ".env"), "TOKEN=abc");
  await expect(app.sources.add({ projectId, role: "prd", path: ".env" })).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
});

it("UX-011 refuses an upload named like a credential and accepts the same bytes under a plain name", async () => {
  const { app, projectId } = await fixture();
  app.config.profilePolicy.allowUpload = true;
  const content = Buffer.from("API_TOKEN=do-not-upload-0123456789\n");
  const completed = async () => {
    const receipt = app.uploads.create({
      mediaType: "text/plain",
      sizeBytes: content.length,
      contentHash: createHash("sha256").update(content).digest("hex"),
    });
    await app.uploads.write(receipt.uploadId, [content], receipt.token);
    await app.uploads.complete(receipt.uploadId);
    return receipt.uploadId;
  };
  const before = (await app.sources.listWithOverview(projectId)).length;
  for (const name of [".env", "config/.env.production", "deploy\\server.pem", "id_rsa"])
    await expect(
      app.sources.add({ projectId, role: "doc", name, uploadId: await completed() }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  expect(await app.sources.listWithOverview(projectId)).toHaveLength(before);
  // Negative control: the same bytes under an ordinary name become a source.
  const added = await app.sources.add({
    projectId,
    role: "doc",
    name: "notes.txt",
    uploadId: await completed(),
  });
  expect(added.source.displayName).toContain("notes.txt");
});
