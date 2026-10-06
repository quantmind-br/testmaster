import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { EntityRepository, PersistenceDatabase } from "@testmaster/persistence";
import { afterEach, expect, it } from "vitest";
import { ProjectsService } from "../authoring.js";
import type { ServiceContext } from "../context.js";
import { CodeImportService } from "./code-import.js";

const cleanups: (() => Promise<unknown> | undefined)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-import-service-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const database = PersistenceDatabase.memory();
  cleanups.push(() => database.close());
  await database.migrate();
  const entities = new EntityRepository(database);
  const workspaceId = uuidV7IdGenerator.next("ws");
  const principalId = uuidV7IdGenerator.next("usr");
  entities.insert("Workspace", {
    id: workspaceId,
    workspaceId,
    name: "Local",
    mode: "single-user",
    settingsVersion: 1,
    quotaPolicyId: "local",
  });
  entities.insert("Principal", {
    id: principalId,
    workspaceId,
    kind: "human",
    displayName: "Owner",
    disabledAt: null,
  });
  const ctx: ServiceContext = {
    database,
    entities,
    workspaceId,
    principalId,
    authorize() {},
    authorizeNamed() {},
  };
  const project = new ProjectsService(ctx).create({ name: "Shop" });
  return {
    cwd,
    ctx,
    project,
    service: new CodeImportService(ctx, { cwd, dataDir: join(cwd, ".testmaster") }),
  };
}
it.each(["playwright", "pytest"] as const)(
  "persists immutable %s code and authored artifacts without fake runs",
  async (format) => {
    const { cwd, ctx, project, service } = await setup();
    const path = format === "pytest" ? "test_health.py" : "health.spec.ts";
    const text =
      format === "pytest"
        ? "def test_health(tm_request):\n    response = tm_request.get('/health', timeout=3)\n    assert response.status_code == 200\n"
        : "import {test,expect} from '@playwright/test'; test('health',async({request})=>{const r=await request.get('/health');expect(r.status()).toBe(200);});\n";
    await writeFile(join(cwd, path), text);
    const result = await service.import({ projectId: project.id, path, format });
    expect(result.test.activeRevisionId).toBe(result.revision.id);
    expect(result.revision).toMatchObject({
      origin: "imported",
      plan: null,
      runnerKind: format === "pytest" ? "python" : "playwright",
      codeRef: { trustLevel: "imported", entrypoint: path },
    });
    expect(ctx.database.get("SELECT COUNT(*) AS count FROM runs")?.count).toBe(0);
    expect(ctx.database.get("SELECT COUNT(*) AS count FROM artifacts")?.count).toBe(2);
    const stored = await service.readBundle(result.revision.id);
    expect(stored.bundle.files[path]).toBe(text);
    expect(stored.dependencyLock.runtimeInstalls).toBe(false);
    expect(() =>
      ctx.entities.update("TestRevision", ctx.workspaceId, result.revision.id, 1, result.revision),
    ).toThrow();
    await writeFile(join(cwd, path), "changed source");
    expect((await service.readBundle(result.revision.id)).bundle.files[path]).toBe(text);
    const artifact = ctx.entities.get(
      "Artifact",
      ctx.workspaceId,
      result.revision.codeArtifactId as string,
    );
    expect(artifact).toMatchObject({
      runId: null,
      attemptId: null,
      snapshotId: null,
      revisionId: result.revision.id,
      state: "available",
    });
    const target = join(service.config.dataDir, String(artifact?.storageKey));
    const bytes = await readFile(target);
    await writeFile(target, Buffer.concat([bytes, Buffer.from(" ")]));
    await expect(service.readBundle(result.revision.id)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  },
);
it("refusal creates no tests, revisions or artifacts", async () => {
  const { cwd, ctx, project, service } = await setup();
  await writeFile(
    join(cwd, "bad.spec.ts"),
    "import {test,expect} from '@playwright/test';test('bad',()=>expect(true).toBe(true));",
  );
  await expect(
    service.import({ projectId: project.id, path: "bad.spec.ts", format: "playwright" }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  for (const table of ["tests", "test_revisions", "artifacts"])
    expect(ctx.database.get(`SELECT COUNT(*) AS count FROM ${table}`)?.count).toBe(0);
});
it("authorizes the actual project before reading imported bytes", async () => {
  const { ctx, project, service } = await setup();
  ctx.authorize = () => {
    throw new Error("forbidden");
  };
  await expect(
    service.import({ projectId: project.id, path: "absent.ts", format: "playwright" }),
  ).rejects.toThrow("forbidden");
});
it("creates generated candidates without promoting and refuses unsafe output", async () => {
  const { cwd, project, service, ctx } = await setup();
  const code =
    "import {test,expect} from '@playwright/test';test('health',async({request})=>{const r=await request.get('/health');expect(r.status()).toBe(200);});";
  await writeFile(join(cwd, "health.spec.ts"), code);
  const initial = await service.import({
    projectId: project.id,
    path: "health.spec.ts",
    format: "playwright",
  });
  const generated = await service.createGeneratedRevision(initial.test.id, {
    code,
    format: "playwright",
    parentId: initial.revision.id,
  });
  expect(generated).toMatchObject({
    plan: null,
    origin: "generated",
    codeRef: { trustLevel: "generated" },
    parentId: initial.revision.id,
    ordinal: 2,
  });
  expect(ctx.entities.get("TestCase", ctx.workspaceId, initial.test.id)?.activeRevisionId).toBe(
    initial.revision.id,
  );
  await expect(
    service.createGeneratedRevision(initial.test.id, {
      code: "eval('unsafe')",
      format: "playwright",
    }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});
it("creates same-project references idempotently and rejects foreign project or changed body", async () => {
  const { cwd, project, service, ctx } = await setup();
  await writeFile(
    join(cwd, "health.spec.ts"),
    "import {test,expect} from '@playwright/test';test('health',async({request})=>{const r=await request.get('/health');expect(r.status()).toBe(200);});",
  );
  const initial = await service.import({
    projectId: project.id,
    path: "health.spec.ts",
    format: "playwright",
  });
  const ref = initial.revision.codeRef;
  if (!ref) throw new Error("missing code reference");
  const input = {
    projectId: project.id,
    codeRef: ref,
    name: "Copied health",
    idempotencyKey: "code-reference-test-key",
  };
  const copied = await service.createTestFromReference(input);
  expect((await service.createTestFromReference(input)).revision.id).toBe(copied.revision.id);
  expect(ctx.database.get("SELECT COUNT(*) AS count FROM tests")?.count).toBe(2);
  await expect(
    service.createTestFromReference({ ...input, name: "Changed" }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  const revision = await service.createRevision(
    copied.test.id,
    ref,
    copied.revision.id,
    "code-reference-revision-key",
  );
  expect(
    (
      await service.createRevision(
        copied.test.id,
        ref,
        copied.revision.id,
        "code-reference-revision-key",
      )
    ).id,
  ).toBe(revision.id);
  const foreign = new ProjectsService(ctx).create({ name: "Other", slug: "other" });
  await expect(
    service.createTestFromReference({ projectId: foreign.id, codeRef: ref }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
