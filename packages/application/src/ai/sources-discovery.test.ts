import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ContractError, type DiscoveryJob, validate } from "@testmaster/contracts";
import { sha256, uuidV7IdGenerator } from "@testmaster/domain";
import { EntityRepository, PersistenceDatabase } from "@testmaster/persistence";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectsService } from "../authoring.js";
import type { ResolvedConfig } from "../config.js";
import { entity, type ServiceContext } from "../context.js";
import { DiscoveryService, DockerPythonSummaryRunner } from "./discovery.js";
import { readAiState, SourcesService, saveAiState, UploadsService } from "./sources.js";

const roots: string[] = [];
const databases: PersistenceDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tm-source-discovery-"));
  roots.push(root);
  const cwd = join(root, "repo");
  const dataDir = join(root, "state");
  await mkdir(cwd);
  await mkdir(dataDir);
  const database = PersistenceDatabase.memory();
  databases.push(database);
  await database.migrate();
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
  const config: ResolvedConfig = {
    cwd,
    dataDir,
    home: root,
    effectiveConfig: {
      config: { schemaVersion: "1.0.0" },
      origins: {},
      policyHash: sha256("policy"),
    },
    profilePolicy: {
      limits: {},
      security: { allowUnsafeProcessExecution: false },
      allowedModelProviders: [],
      allowUpload: true,
      allowCiHealing: false,
      offline: true,
    },
    modelProviders: [],
  };
  const project = new ProjectsService(ctx).create({ name: "Shop" });
  const uploads = new UploadsService(ctx, config);
  const sources = new SourcesService(ctx, config, uploads);
  const discovery = new DiscoveryService(ctx, config, sources, {
    async summarize() {
      return { available: false, reason: "Python image unavailable" };
    },
  });
  return { root, cwd, dataDir, ctx, config, projectId: project.id, uploads, sources, discovery };
}

async function* bytes(...chunks: string[]) {
  for (const chunk of chunks) yield Buffer.from(chunk);
}

describe("source ingestion", () => {
  it("never completes truncated, mismatched, oversized or interrupted streams", async () => {
    const { uploads, sources, projectId } = await fixture();
    const content = Buffer.from("Buyer must retain the cart after reload.");
    const truncated = uploads.create({
      mediaType: "text/plain",
      sizeBytes: content.length,
      contentHash: sha256(content),
    });
    expect((await uploads.write(truncated.uploadId, bytes("Buyer"), truncated.token)).state).toBe(
      "pending",
    );
    await expect(uploads.complete(truncated.uploadId)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(
      sources.add({ projectId, role: "prd", uploadId: truncated.uploadId }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const mismatch = uploads.create({
      mediaType: "text/plain",
      sizeBytes: 3,
      contentHash: sha256("abc"),
    });
    await uploads.write(mismatch.uploadId, bytes("xyz"));
    await expect(uploads.complete(mismatch.uploadId)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(uploads.write(mismatch.uploadId, bytes("abcd"))).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
    await expect(uploads.complete(mismatch.uploadId)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    const interrupted = uploads.create({
      mediaType: "text/plain",
      sizeBytes: 3,
      contentHash: sha256("abc"),
    });
    async function* fail() {
      yield Buffer.from("a");
      throw new Error("Disconnected upload");
    }
    await expect(uploads.write(interrupted.uploadId, fail())).rejects.toThrow(
      "Disconnected upload",
    );
    await expect(uploads.complete(interrupted.uploadId)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(sources.list(projectId)).toEqual([]);
  });
  it("completes streamed bytes and versions identity without replacing same basenames", async () => {
    const { uploads, sources, cwd, projectId, ctx } = await fixture();
    const text = "Buyer must retain the cart after reload.";
    const upload = uploads.create({
      mediaType: "text/plain",
      sizeBytes: Buffer.byteLength(text),
      contentHash: sha256(text),
    });
    await expect(
      uploads.write(
        upload.uploadId,
        bytes("Buyer must ", "retain the cart after reload."),
        "wrong-token",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await uploads.write(
      upload.uploadId,
      bytes("Buyer must ", "retain the cart after reload."),
      upload.token,
    );
    const completionKey = "upload-completion-idempotency";
    const complete = await uploads.complete(upload.uploadId, completionKey);
    expect(complete.state).toBe("complete");
    expect(await uploads.complete(upload.uploadId, completionKey)).toEqual(complete);
    expect(
      ctx.database.get(
        "SELECT COUNT(*) AS n FROM idempotency_receipts WHERE operation=? AND key=?",
        `upload.complete:${upload.uploadId}`,
        completionKey,
      )?.n,
    ).toBe(1);
    const first = await sources.add({
      projectId,
      role: "prd",
      name: "requirements.txt",
      uploadId: upload.uploadId,
    });
    expect(first.revision.status).toBe("ready");
    expect(first.revision.contentHash).toBe(sha256(text));
    expect(first.chunks[0]?.evidenceRef.sourceRevisionId).toBe(first.revision.id);
    await writeFile(join(cwd, "requirements.txt"), "Buyer must reject an empty cart.");
    const second = await sources.add({ projectId, role: "prd", path: "requirements.txt" });
    expect(second.source.id).not.toBe(first.source.id);
    const revised = await sources.add({
      projectId,
      role: "prd",
      path: "requirements.txt",
      sourceId: first.source.id,
      expectedVersion: first.source.version,
    });
    expect(revised.revision.parentId).toBe(first.revision.id);
    expect(sources.revision(first.revision.id).revision.contentHash).toBe(sha256(text));
    expect(() => sources.archive(first.source.id, first.source.version as number)).toThrow(
      ContractError,
    );
    sources.archive(first.source.id, revised.source.version as number);
    expect(sources.get(first.source.id).archivedAt).not.toBeNull();
    expect(sources.list(projectId).map((source) => source.id)).toEqual([second.source.id]);
  });
  it("makes parser failures explicit and rejects path, symlink and hardlink escapes", async () => {
    const { root, cwd, sources, projectId } = await fixture();
    await writeFile(join(cwd, "invalid.json"), "{broken");
    const invalid = await sources.add({ projectId, role: "prd", path: "invalid.json" });
    expect(invalid.revision.status).toBe("invalid");
    expect(invalid.chunks).toEqual([]);
    expect(invalid.diagnostics.length).toBeGreaterThan(0);
    await writeFile(join(cwd, ".env"), "API_KEY=must-never-be-a-source");
    await expect(
      sources.add({ projectId, role: "prd", path: ".env", format: "text" }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await writeFile(join(cwd, "empty.txt"), "");
    expect((await sources.add({ projectId, role: "prd", path: "empty.txt" })).revision.status).toBe(
      "invalid",
    );
    await writeFile(join(root, "outside.txt"), "Must not read outside.");
    await symlink(join(root, "outside.txt"), join(cwd, "escape.txt"));
    await expect(
      sources.add({ projectId, role: "prd", path: "../outside.txt" }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(sources.add({ projectId, role: "prd", path: "escape.txt" })).rejects.toThrow();
    await link(join(root, "outside.txt"), join(cwd, "hardlink.txt"));
    await expect(
      sources.add({ projectId, role: "prd", path: "hardlink.txt" }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });
  it("replays source admission atomically and denies changed bodies", async () => {
    const { cwd, sources, ctx, projectId } = await fixture();
    await writeFile(join(cwd, "prd.md"), "The service must reject anonymous orders.");
    const request = {
      projectId,
      role: "prd",
      path: "prd.md",
      idempotencyKey: "source-idempotency-key",
    };
    const first = await sources.add(request);
    await rm(join(cwd, "prd.md"));
    expect((await sources.add(request)).source.id).toBe(first.source.id);
    await expect(sources.add({ ...request, role: "api-spec" })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(ctx.database.get("SELECT COUNT(*) AS n FROM source_revisions")?.n).toBe(1);
  });
});

describe("durable discovery", () => {
  it("stores partial maps, excluded files and stable fingerprints without live claims", async () => {
    const { cwd, projectId, discovery, ctx, config, sources } = await fixture();
    await writeFile(
      join(cwd, "server.ts"),
      "import express from 'express'; const app = express(); app.get('/health', (req,res) => res.json({ok:true}));",
    );
    await writeFile(join(cwd, ".env"), "PASSWORD=must-not-disclose");
    const first = await discovery.discover({ projectId });
    expect(first.status).toBe("partial");
    expect(first.job.phase).toBe("completed");
    expect(
      first.featureMap.features.some((feature) => feature.endpointRefs.includes("GET /health")),
    ).toBe(true);
    expect(first.codeSnapshot.skippedFiles?.some((file) => file.path === ".env")).toBe(true);
    const resumed = await discovery.discover({ projectId, resume: first.job.id });
    expect(resumed.job.id).toBe(first.job.id);
    const restarted = new DiscoveryService(ctx, config, sources);
    expect(restarted.get(first.job.id).summary.manifestHash).toBe(first.summary.manifestHash);
    const events = restarted.events(first.job.id);
    expect(events.map((event) => event.type)).toEqual(["discovery.accepted", "discovery.updated"]);
    expect(events.map((event) => validate<DiscoveryJob>("DiscoveryJob", event.job).phase)).toEqual([
      "queued",
      "completed",
    ]);
    expect(restarted.events(first.job.id, Number(events[0]?.seq))).toHaveLength(1);
    expect(() => restarted.events(first.job.id, -2)).toThrow(ContractError);
    expect(discovery.events(first.job.id)).toHaveLength(2);
    expect(
      (await discovery.discover({ projectId })).featureMap.features.map((feature) => feature.id),
    ).toEqual(first.featureMap.features.map((feature) => feature.id));
    await writeFile(join(cwd, "server.ts"), "const app = {}; app.post('/checkout', () => {});");
    await expect(discovery.discover({ projectId, resume: first.job.id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect((await discovery.discover({ projectId })).job.inputsFingerprint).not.toBe(
      first.job.inputsFingerprint,
    );
  });
  it("fingerprints source revision, prompt, requested model and policy changes", async () => {
    const { cwd, projectId, discovery, sources, config } = await fixture();
    await writeFile(join(cwd, "prd.md"), "The buyer must reject an empty cart.");
    const firstSource = await sources.add({ projectId, role: "prd", path: "prd.md" });
    const first = await discovery.discover({ projectId });
    const prompt = await discovery.discover({ projectId, promptVersion: "different-prompt" });
    expect(prompt.job.inputsFingerprint).not.toBe(first.job.inputsFingerprint);
    const model = await discovery.discover({ projectId, model: "different-model" });
    expect(model.job.inputsFingerprint).not.toBe(first.job.inputsFingerprint);
    await writeFile(join(cwd, "prd.md"), "The buyer must persist a submitted order.");
    await sources.add({
      projectId,
      role: "prd",
      path: "prd.md",
      sourceId: firstSource.source.id,
      expectedVersion: firstSource.source.version,
    });
    expect((await discovery.discover({ projectId })).job.inputsFingerprint).not.toBe(
      first.job.inputsFingerprint,
    );
    config.profilePolicy.allowUpload = false;
    await expect(discovery.retry(first.job.id)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });
  it("refuses implicit diff and unapproved roots before producing results", async () => {
    const { root, cwd, projectId, discovery, config } = await fixture();
    for (const input of [
      { scope: "diff" as const },
      { scope: "diff" as const, base: "HEAD" },
      { scope: "diff" as const, workingTree: true },
    ]) {
      await expect(discovery.discover({ projectId, ...input })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
    }
    await expect(discovery.discover({ projectId, root: ".." })).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    await symlink(root, join(cwd, "escape"));
    await expect(discovery.discover({ projectId, root: "escape" })).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    await expect(
      new DockerPythonSummaryRunner(config).summarize(cwd, ["../outside.py"]),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });
  it("analyzes the pinned head instead of a later dirty checkout", async () => {
    const { cwd, projectId, discovery, ctx } = await fixture();
    const git = promisify(execFile);
    const run = (args: string[]) =>
      git("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args]);
    await run(["init"]);
    await writeFile(join(cwd, "server.ts"), "const app = {}; app.get('/base', () => {});");
    await run(["add", "server.ts"]);
    await run([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "base",
    ]);
    const base = (await run(["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(cwd, "server.ts"), "const app = {}; app.get('/pinned-head', () => {});");
    await run(["add", "server.ts"]);
    await run([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "head",
    ]);
    const head = (await run(["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(
      join(cwd, "server.ts"),
      "const app = {}; app.get('/dirty-checkout', () => {});",
    );
    const pinned = await discovery.discover({ projectId, scope: "diff", base, head });
    expect(pinned.summary.endpoints.map((value) => value.path)).toEqual(["/pinned-head"]);
    expect(pinned.codeSnapshot.headSha).toBe(head);
    expect(pinned.codeSnapshot.dirtyHash).toBeNull();
    const batch = entity(ctx, "pbt", {
      projectId,
      sourceSnapshotId: pinned.job.inputsFingerprint,
      state: "proposed",
    });
    ctx.entities.insert("ProposalBatch", batch);
    const working = await discovery.discover({ projectId, scope: "diff", base, workingTree: true });
    expect(working.summary.endpoints.map((value) => value.path)).toEqual(["/dirty-checkout"]);
    expect(working.codeSnapshot.dirtyHash).not.toBeNull();
    expect(working.job.inputsFingerprint).not.toBe(pinned.job.inputsFingerprint);
    expect(ctx.entities.get("ProposalBatch", ctx.workspaceId, batch.id)?.state).toBe("stale");
  });
  it("creates no component features and maps route handlers to endpoint features", async () => {
    const { cwd, projectId, discovery } = await fixture();
    await mkdir(join(cwd, "components"));
    await mkdir(join(cwd, "app", "api", "items", "[id]"), { recursive: true });
    await writeFile(
      join(cwd, "components", "Card.tsx"),
      "export function Card() { return <div />; }\n",
    );
    await writeFile(
      join(cwd, "app", "api", "items", "route.ts"),
      "export async function GET() { return Response.json([]); }\nexport const POST = async () => new Response();\n",
    );
    await writeFile(
      join(cwd, "app", "api", "items", "[id]", "route.ts"),
      "export const DELETE = async () => new Response();\n",
    );
    const result = await discovery.discover({ projectId });
    const keys = result.featureMap.features.map((feature) => feature.stableKey).sort();
    expect(keys).toEqual([
      "endpoint:DELETE:/api/items/{id}",
      "endpoint:GET:/api/items",
      "endpoint:POST:/api/items",
    ]);
    expect(keys.some((key) => key.startsWith("component:") || key.includes("UNKNOWN"))).toBe(false);
    expect(
      result.featureMap.features.find((feature) => feature.stableKey === "endpoint:GET:/api/items")
        ?.endpointRefs,
    ).toEqual(["GET /api/items"]);
    // The component is still a summary fact, just not a feature entity.
    expect(result.summary.features.map((feature) => feature.name)).toEqual(["Card"]);
    expect(result.summary.routes).toEqual([]);
  });
  it("bounds stored symbols and declares the truncation instead of failing the job", async () => {
    const { cwd, projectId, discovery } = await fixture();
    await writeFile(
      join(cwd, "many.ts"),
      `${Array.from({ length: 500 }, (_, index) => `export const value${index} = ${index};`).join("\n")}\n`,
    );
    const result = await discovery.discover({ projectId });
    expect(result.summary.symbols).toHaveLength(200);
    expect(result.warnings.some((warning) => warning.includes(": symbols_truncated: "))).toBe(true);
    expect(result.summary.fileRefs.map((ref) => ref.path)).toEqual(["many.ts"]);
  });
  it("stores a snapshot whose skipped file path is longer than 200 characters", async () => {
    const { cwd, projectId, discovery } = await fixture();
    const directory = "d".repeat(120);
    const skipped = `${directory}/${"k".repeat(105)}.pem`;
    expect(skipped).toHaveLength(230);
    await mkdir(join(cwd, directory));
    await writeFile(join(cwd, skipped), "-----BEGIN PRIVATE KEY-----");
    await writeFile(join(cwd, "ok.ts"), "export const ok = 1;\n");
    const result = await discovery.discover({ projectId });
    expect(result.codeSnapshot.skippedFiles?.some((file) => file.path === skipped)).toBe(true);
    expect(result.summary.fileRefs.map((ref) => ref.path)).toEqual(["ok.ts"]);
  });
  it("analyzes only the changed files and their importers in a diff and lists the rest", async () => {
    const { cwd, projectId, discovery } = await fixture();
    const git = promisify(execFile);
    const run = (args: string[]) =>
      git("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args]);
    const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
    await run(["init"]);
    await writeFile(join(cwd, "util.ts"), "export const util = 1;\n");
    await writeFile(
      join(cwd, "page.ts"),
      "import { util } from './util';\nconst app = {}; app.get('/page', () => util);\n",
    );
    await writeFile(join(cwd, "other.ts"), "const app = {}; app.get('/other', () => 1);\n");
    await mkdir(join(cwd, "assets"));
    await writeFile(join(cwd, "assets", "blob.bin"), Buffer.alloc(70 * 1024 * 1024));
    await run(["add", "."]);
    await run([...identity, "commit", "-m", "base"]);
    const base = (await run(["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(cwd, "util.ts"), "export const util = 2;\n");
    await run(["add", "."]);
    await run([...identity, "commit", "-m", "head"]);
    const head = (await run(["rev-parse", "HEAD"])).stdout.trim();
    // A pinned head whose blobs total far above the old 64 MiB budget is analyzed.
    const pinned = await discovery.discover({ projectId, scope: "diff", base, head });
    expect(pinned.summary.scannedFiles).toEqual(["page.ts", "util.ts"]);
    expect(pinned.diff?.impact.selectedFiles).toEqual(["page.ts", "util.ts"]);
    expect(pinned.diff?.impact.excludedFiles.map((file) => file.path)).toEqual(["other.ts"]);
    expect(pinned.summary.endpoints.map((value) => value.path)).toEqual(["/page"]);
    expect(pinned.diff?.impact.gaps.join(" ")).toContain("relative specifiers");
    // The same closure is read from the working tree.
    const working = await discovery.discover({ projectId, scope: "diff", base, workingTree: true });
    expect(working.summary.scannedFiles).toEqual(["page.ts", "util.ts"]);
  });
  it("reports the key, size and limit when AI state exceeds the storage bound", async () => {
    const limit = 32 * 1024 * 1024;
    const { ctx } = await fixture();
    let thrown: unknown;
    try {
      saveAiState(ctx, "oversized-key", "x".repeat(limit));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContractError);
    expect(thrown).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      details: { key: "oversized-key", bytes: limit + 2, limitBytes: limit },
    });
  });
  it("reports unavailable Python honestly and never imports submitted code", async () => {
    const { cwd, projectId, discovery } = await fixture();
    await writeFile(join(cwd, "app.py"), "raise RuntimeError('must never execute')\n");
    const result = await discovery.discover({ projectId });
    expect(result.status).toBe("unreachable");
    expect(result.warnings.some((warning) => warning.includes("python_unavailable"))).toBe(true);
    expect(result.featureMap.status).toBe("needs_input");
  });
  it("supports durable cancellation and fingerprint-checked retry", async () => {
    const { cwd, projectId, discovery, ctx } = await fixture();
    await writeFile(join(cwd, "server.ts"), "const app = {}; app.get('/health', () => {});");
    const first = await discovery.discover({ projectId });
    ctx.entities.update(
      "DiscoveryJob",
      ctx.workspaceId,
      first.job.id,
      first.job.version as number,
      { ...first.job, phase: "queued" },
      { projectId },
    );
    expect(discovery.cancel(first.job.id).phase).toBe("cancelled");
    await expect(discovery.discover({ projectId, resume: first.job.id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(
      (await discovery.retry(first.job.id, { inputsFingerprint: first.job.inputsFingerprint })).job
        .phase,
    ).toBe("completed");
    expect(
      discovery
        .events(first.job.id)
        .map((event) => validate<DiscoveryJob>("DiscoveryJob", event.job).phase),
    ).toEqual(["queued", "completed", "cancelled", "queued", "completed"]);
    discovery.cancel(first.job.id);
    discovery.get(first.job.id);
    expect(discovery.events(first.job.id)).toHaveLength(5);
    await expect(
      discovery.retry(first.job.id, { featureIds: [uuidV7IdGenerator.next("fea")] }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
  it("scopes durable read data and idempotent discovery to the actor and project", async () => {
    const { projectId, discovery, sources, ctx, config } = await fixture();
    const request = { projectId, idempotencyKey: "discovery-idempotency-key" };
    const first = await discovery.discover(request);
    expect((await discovery.discover(request)).job.id).toBe(first.job.id);
    await expect(
      discovery.discover({ ...request, promptVersion: "changed" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const denied = {
      ...ctx,
      authorize() {
        throw new ContractError("FORBIDDEN", "Denied");
      },
    };
    const unauthorized = new DiscoveryService(denied, config, sources);
    expect(() => unauthorized.get(first.job.id)).toThrow(ContractError);
    const state = readAiState(ctx, `discovery:${first.job.id}`);
    expect(state).not.toBeNull();
    expect(() => saveAiState(ctx, "oversized", "x".repeat(32 * 1024 * 1024))).toThrow(
      ContractError,
    );
  });
});
