import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { EntityRepository, PersistenceDatabase } from "@testmaster/persistence";
import { afterEach, expect, it } from "vitest";
import { ProjectsService, RevisionsService, scaffoldPlan, TestsService } from "../authoring.js";
import type { ServiceContext } from "../context.js";
import { CodeExportService } from "./code-export.js";
import { CodeImportService } from "./code-import.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-code-export-"));
  const database = PersistenceDatabase.memory();
  await database.migrate();
  cleanups.push(async () => {
    database.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const workspaceId = uuidV7IdGenerator.next("ws");
  const principalId = uuidV7IdGenerator.next("usr");
  const entities = new EntityRepository(database);
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
  new ProjectsService(ctx).create({ name: "Shop" });
  const tests = new TestsService(ctx);
  const test = tests.create({ plan: scaffoldPlan("backend") });
  const service = new CodeExportService(ctx, { cwd, dataDir: join(cwd, ".testmaster") });
  return { cwd, ctx, test, tests, service };
}
it("exports selected immutable revisions and confines exclusive writes", async () => {
  const { cwd, ctx, test, service } = await setup();
  const plan = scaffoldPlan("backend");
  plan.name = "Candidate health oracle";
  const candidate = new RevisionsService(ctx).create(test.id, plan);
  const result = await service.export(test.id, {
    format: "playwright",
    revisionId: candidate.id,
    out: "exports/health",
  });
  expect(result.revisionId).toBe(candidate.id);
  expect(result.files["tests/plan.spec.ts"]).toContain("Candidate health oracle");
  expect(await readFile(join(cwd, "exports/health/package-lock.json"), "utf8")).toBe(
    result.files["package-lock.json"],
  );
  expect(new TestsService(ctx).get(test.id).activeRevisionId).toBe(test.activeRevisionId);
  await expect(
    service.export(test.id, { format: "pytest", out: "exports/health" }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(await readFile(join(cwd, "exports/health/package-lock.json"), "utf8")).toBe(
    result.files["package-lock.json"],
  );
});
it("rejects traversals, application data and symlink ancestors", async () => {
  const { cwd, test, service } = await setup();
  const outside = await mkdtemp(join(tmpdir(), "tm-export-outside-"));
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(cwd, "linked"));
  for (const out of ["../outside", outside, ".testmaster/code", "linked/export"]) {
    await expect(service.export(test.id, { format: "pytest", out })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
});
it("requires read access and write scope for output, never releases secrets", async () => {
  const { ctx, test, service } = await setup();
  const result = await service.export(test.id, { format: "pytest" });
  expect(result.revisionId).toBe(test.activeRevisionId);
  ctx.authorize = (scope) => {
    if (scope === "W") throw new ContractError("FORBIDDEN", "Read-only principal");
  };
  await expect(service.export(test.id, { format: "pytest" })).resolves.toMatchObject({
    testId: test.id,
  });
  await expect(
    service.export(test.id, { format: "pytest", out: "exports/denied" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  ctx.authorize = () => {
    throw new ContractError("FORBIDDEN", "No read access");
  };
  await expect(service.export(test.id, { format: "pytest" })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});
it("rejects revision ownership mismatches", async () => {
  const { test, tests, service } = await setup();
  const other = tests.create({ plan: scaffoldPlan("backend") });
  await expect(
    service.export(test.id, { format: "pytest", revisionId: other.activeRevisionId as string }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});
it("exports code-backed revisions without changing source or admitted image pins", async () => {
  const { cwd, ctx, test, service } = await setup();
  const source =
    "import {test,expect} from '@playwright/test';test('health',async({request})=>{const r=await request.get('/health');expect(r.status()).toBe(200);});\n";
  await writeFile(join(cwd, "health.spec.ts"), source);
  const imported = await new CodeImportService(ctx, service.config).import({
    projectId: test.projectId,
    path: "health.spec.ts",
    format: "playwright",
  });
  const result = await service.export(imported.test.id, { format: "playwright" });
  expect(result.files["health.spec.ts"]).toBe(source);
  expect(JSON.parse(result.files["runtime-lock.json"] ?? "")).toMatchObject({
    runtimeInstalls: false,
    image: "testmaster-runner",
  });
  await expect(service.export(imported.test.id, { format: "pytest" })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});
