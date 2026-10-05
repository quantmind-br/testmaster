import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Artifact,
  type CodeReference,
  ContractError,
  type Project,
  type TestCase,
  type TestRevision,
  validate,
} from "@testmaster/contracts";
import { canonicalJson, semanticHash, sha256 } from "@testmaster/domain";
import { type EntityDocument, IdempotencyRepository } from "@testmaster/persistence";
import {
  type CodeImportFormat,
  type ImportedCodeBundle,
  importCode,
  readConfinedCodeFile,
} from "@testmaster/planner";
import { authoringTransaction } from "../authoring.js";
import type { ResolvedConfig } from "../config.js";
import { entity, requireEntity, type ServiceContext } from "../context.js";

type Stored<T> = T & EntityDocument;
export interface CodeImportRequest {
  projectId: string;
  path: string;
  format: CodeImportFormat;
  name?: string;
}
export interface CodeImportResult {
  test: Stored<TestCase>;
  revision: Stored<TestRevision>;
}
export interface ImportedDependencyLock {
  schemaVersion: "1.0.0";
  runnerCapabilityVersion: "1.0.0";
  image: "testmaster-runner" | "testmaster-runner-python";
  imageId: string;
  buildInputsHash: string;
  runtimeInstalls: false;
}
/** Authored artifacts have a revision but no fabricated Run, Attempt or Snapshot. */
export class CodeImportService {
  constructor(
    readonly ctx: ServiceContext,
    readonly config: Pick<ResolvedConfig, "cwd" | "dataDir">,
  ) {}
  async import(input: CodeImportRequest): Promise<CodeImportResult> {
    this.ctx.authorize("W", input?.projectId);
    if (
      !input ||
      typeof input !== "object" ||
      Object.keys(input).some((key) => !["projectId", "path", "format", "name"].includes(key)) ||
      typeof input.path !== "string" ||
      !input.path ||
      typeof input.projectId !== "string" ||
      !["playwright", "pytest"].includes(input.format)
    )
      throw new ContractError("INVALID_ARGUMENT", "Invalid code import input");
    if (
      input.name !== undefined &&
      (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200)
    )
      throw new ContractError("INVALID_ARGUMENT", "Imported test name must be 1–200 characters");
    const project = requireEntity(this.ctx, "Project", input.projectId) as Stored<Project>;
    if (project.archivedAt)
      throw new ContractError("PRECONDITION_FAILED", "Archived project cannot import tests");
    const bundle = await importCode({
      root: this.config.cwd,
      path: input.path,
      format: input.format,
    });
    const image = input.format === "pytest" ? "testmaster-runner-python" : "testmaster-runner";
    const imageLock = JSON.parse(
      (
        await readConfinedCodeFile(
          await realpath(fileURLToPath(new URL("../../../../", import.meta.url))),
          "containers/images.lock.json",
          64 * 1024,
        )
      ).toString("utf8"),
    ) as Record<string, { imageId: string; buildInputsHash: string }>;
    const pinned = imageLock[image];
    if (
      !pinned ||
      !/^sha256:[a-f0-9]{64}$/u.test(pinned.imageId) ||
      !/^[a-f0-9]{64}$/u.test(pinned.buildInputsHash)
    )
      throw new ContractError("PRECONDITION_FAILED", "Runner image dependency lock is unavailable");
    const lock: ImportedDependencyLock = {
      schemaVersion: "1.0.0",
      runnerCapabilityVersion: "1.0.0",
      image,
      imageId: pinned.imageId,
      buildInputsHash: pinned.buildInputsHash,
      runtimeInstalls: false,
    };
    const test = entity(this.ctx, "tst", {
      projectId: input.projectId,
      name: input.name ?? bundle.tests[0],
      activeRevisionId: null,
      tags: [],
      priority: "normal",
      archivedAt: null,
    }) as Stored<TestCase>;
    const revision = entity(this.ctx, "rev", {}) as Stored<TestRevision>;
    const bundleBytes = Buffer.from(canonicalJson(bundle));
    const lockBytes = Buffer.from(canonicalJson(lock));
    const bundleArtifact = await this.store(revision.id, "code-bundle", bundleBytes);
    let lockArtifact: Stored<Artifact> | undefined;
    try {
      lockArtifact = await this.store(revision.id, "code-dependency-lock", lockBytes);
      const codeRef: CodeReference = {
        artifactId: bundleArtifact.id,
        contentHash: sha256(bundleBytes),
        language: input.format === "pytest" ? "python" : "typescript",
        framework: input.format === "pytest" ? "pytest" : "playwright-test",
        entrypoint: bundle.entrypoint,
        dependencyLockRef: lockArtifact.id,
        runnerCapabilityVersion: "1.0.0",
        trustLevel: "imported",
      };
      Object.assign(revision, {
        testId: test.id,
        ordinal: 1,
        contentHash: codeRef.contentHash,
        plan: null,
        codeArtifactId: bundleArtifact.id,
        codeRef,
        runnerKind: input.format === "pytest" ? "python" : "playwright",
        author: this.ctx.principalId,
        parentId: null,
        origin: "imported",
      });
      test.activeRevisionId = revision.id;
      return authoringTransaction(this.ctx, () => {
        this.ctx.authorize("W", input.projectId);
        if ((requireEntity(this.ctx, "Project", input.projectId) as Stored<Project>).archivedAt)
          throw new ContractError("PRECONDITION_FAILED", "Archived project cannot import tests");
        this.ctx.entities.insert("TestCase", test);
        this.ctx.entities.insert("TestRevision", revision);
        this.ctx.entities.insert("Artifact", bundleArtifact);
        this.ctx.entities.insert("Artifact", lockArtifact as Stored<Artifact>);
        return { test, revision };
      });
    } catch (error) {
      await rm(join(this.config.dataDir, bundleArtifact.storageKey), { force: true });
      if (lockArtifact)
        await rm(join(this.config.dataDir, lockArtifact.storageKey), { force: true });
      throw error;
    }
  }
  async createTestFromReference(input: {
    projectId: string;
    codeRef: CodeReference;
    name?: string;
    idempotencyKey?: string;
  }): Promise<CodeImportResult> {
    this.ctx.authorize("W", input.projectId);
    validate("CodeReference", input.codeRef);
    const body = {
      projectId: input.projectId,
      codeRef: input.codeRef,
      ...(input.name === undefined ? {} : { name: input.name }),
    };
    const request = input.idempotencyKey
      ? { operation: "code.create-test", key: input.idempotencyKey, body }
      : undefined;
    const replay = request ? this.replay<Stored<TestRevision>>(request) : undefined;
    if (replay)
      return {
        revision: replay,
        test: requireEntity(this.ctx, "TestCase", replay.testId) as Stored<TestCase>,
      };
    const project = requireEntity(this.ctx, "Project", input.projectId) as Stored<Project>;
    const artifact = requireEntity(
      this.ctx,
      "Artifact",
      input.codeRef.artifactId,
    ) as Stored<Artifact>;
    const source = requireEntity(
      this.ctx,
      "TestRevision",
      artifact.revisionId,
    ) as Stored<TestRevision>;
    const sourceTest = requireEntity(this.ctx, "TestCase", source.testId) as Stored<TestCase>;
    if (
      project.archivedAt ||
      sourceTest.projectId !== input.projectId ||
      canonicalJson(source.codeRef) !== canonicalJson(input.codeRef) ||
      input.codeRef.trustLevel !== "imported"
    )
      throw new ContractError(
        "FORBIDDEN",
        "CodeReference must identify an owned imported bundle in the same active project",
      );
    if (input.name !== undefined && (!input.name.trim() || input.name.length > 200))
      throw new ContractError("INVALID_ARGUMENT", "Imported test name must be 1–200 characters");
    const stored = await this.readBundle(source.id);
    const bundle = await this.checkStoredCode(stored.bundle);
    const test = entity(this.ctx, "tst", {
      projectId: input.projectId,
      name: input.name ?? bundle.tests[0],
      activeRevisionId: null,
      tags: [],
      priority: "normal",
      archivedAt: null,
    }) as Stored<TestCase>;
    const revision = await this.createFromBundle(
      test,
      bundle,
      stored.dependencyLock,
      "imported",
      undefined,
      true,
      request,
    );
    if (revision.testId !== test.id)
      return {
        revision,
        test: requireEntity(this.ctx, "TestCase", revision.testId) as Stored<TestCase>,
      };
    return { test, revision };
  }
  async createRevision(
    testId: string,
    codeRef: CodeReference,
    parentId?: string,
    idempotencyKey?: string,
  ): Promise<Stored<TestRevision>> {
    this.ctx.authorize("W");
    validate("CodeReference", codeRef);
    const target = requireEntity(this.ctx, "TestCase", testId) as Stored<TestCase>;
    this.ctx.authorize("W", target.projectId);
    const request = idempotencyKey
      ? {
          operation: "code.create-revision",
          key: idempotencyKey,
          body: { testId, codeRef, ...(parentId ? { parentId } : {}) },
        }
      : undefined;
    const replay = request ? this.replay<Stored<TestRevision>>(request) : undefined;
    if (replay) return replay;
    const artifact = requireEntity(this.ctx, "Artifact", codeRef.artifactId) as Stored<Artifact>;
    const source = requireEntity(
      this.ctx,
      "TestRevision",
      artifact.revisionId,
    ) as Stored<TestRevision>;
    const sourceTest = requireEntity(this.ctx, "TestCase", source.testId) as Stored<TestCase>;
    if (
      sourceTest.projectId !== target.projectId ||
      canonicalJson(source.codeRef) !== canonicalJson(codeRef) ||
      codeRef.trustLevel !== "imported"
    )
      throw new ContractError(
        "FORBIDDEN",
        "CodeReference must identify an owned imported bundle in the same project",
      );
    const { bundle, dependencyLock } = await this.readBundle(source.id);
    const checked = await this.checkStoredCode(bundle);
    return this.createFromBundle(
      target,
      checked,
      dependencyLock,
      "imported",
      parentId,
      false,
      request,
    );
  }
  async createGeneratedRevision(
    testId: string,
    input: { code: string; format: CodeImportFormat; parentId?: string },
  ): Promise<Stored<TestRevision>> {
    this.ctx.authorize("W");
    const target = requireEntity(this.ctx, "TestCase", testId) as Stored<TestCase>;
    this.ctx.authorize("W", target.projectId);
    if (
      typeof input.code !== "string" ||
      Buffer.byteLength(input.code) > 1024 * 1024 ||
      !["playwright", "pytest"].includes(input.format)
    )
      throw new ContractError("INVALID_ARGUMENT", "Invalid generated code candidate");
    const entrypoint = input.format === "pytest" ? "test_generated.py" : "generated.spec.ts";
    const bundle = await this.checkStoredCode({
      schemaVersion: "1.0.0",
      validatorVersion: "1.0.0",
      format: input.format,
      entrypoint,
      files: { [entrypoint]: input.code },
      sourceHashes: {},
      tests: [],
      limitations: [],
    });
    const image = input.format === "pytest" ? "testmaster-runner-python" : "testmaster-runner";
    const images = JSON.parse(
      (
        await readConfinedCodeFile(
          await realpath(fileURLToPath(new URL("../../../../", import.meta.url))),
          "containers/images.lock.json",
          64 * 1024,
        )
      ).toString("utf8"),
    ) as Record<string, { imageId: string; buildInputsHash: string }>;
    const pinned = images[image];
    if (
      !pinned ||
      !/^sha256:[a-f0-9]{64}$/u.test(pinned.imageId) ||
      !/^[a-f0-9]{64}$/u.test(pinned.buildInputsHash)
    )
      throw new ContractError("PRECONDITION_FAILED", "Runner image dependency lock is unavailable");
    return this.createFromBundle(
      target,
      bundle,
      {
        schemaVersion: "1.0.0",
        runnerCapabilityVersion: "1.0.0",
        image,
        imageId: pinned.imageId,
        buildInputsHash: pinned.buildInputsHash,
        runtimeInstalls: false,
      },
      "generated",
      input.parentId,
    );
  }
  private async checkStoredCode(bundle: ImportedCodeBundle): Promise<ImportedCodeBundle> {
    const root = await mkdtemp(join(tmpdir(), "testmaster-code-check-"));
    try {
      for (const [path, text] of Object.entries(bundle.files)) {
        if (
          !path ||
          path.startsWith("/") ||
          path.includes("\\") ||
          path.split("/").some((part) => part === ".." || part === "." || !part)
        )
          throw new ContractError("INVALID_ARGUMENT", "Invalid bundled code path");
        await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
        await writeFile(join(root, path), text, { flag: "wx", mode: 0o600 });
      }
      return await importCode({ root, path: bundle.entrypoint, format: bundle.format });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  private async createFromBundle(
    target: Stored<TestCase>,
    bundle: ImportedCodeBundle,
    lock: ImportedDependencyLock,
    origin: "imported" | "generated",
    parentId?: string,
    createTest = false,
    request?: { operation: string; key: string; body: unknown },
  ): Promise<Stored<TestRevision>> {
    const revision = entity(this.ctx, "rev", {}) as Stored<TestRevision>;
    const bytes = Buffer.from(canonicalJson(bundle));
    const artifact = await this.store(revision.id, "code-bundle", bytes);
    let dependency: Stored<Artifact> | undefined;
    try {
      dependency = await this.store(
        revision.id,
        "code-dependency-lock",
        Buffer.from(canonicalJson(lock)),
      );
      const codeRef: CodeReference = {
        artifactId: artifact.id,
        contentHash: sha256(bytes),
        language: bundle.format === "pytest" ? "python" : "typescript",
        framework: bundle.format === "pytest" ? "pytest" : "playwright-test",
        entrypoint: bundle.entrypoint,
        dependencyLockRef: dependency.id,
        runnerCapabilityVersion: "1.0.0",
        trustLevel: origin,
      };
      const action = () =>
        authoringTransaction(this.ctx, () => {
          this.ctx.authorize("W", target.projectId);
          const current = createTest
            ? target
            : (requireEntity(this.ctx, "TestCase", target.id) as Stored<TestCase>);
          const project = requireEntity(this.ctx, "Project", current.projectId) as Stored<Project>;
          if (current.archivedAt || project.archivedAt)
            throw new ContractError(
              "PRECONDITION_FAILED",
              "Archived resource cannot receive code revisions",
            );
          if (
            parentId &&
            (requireEntity(this.ctx, "TestRevision", parentId) as Stored<TestRevision>).testId !==
              target.id
          )
            throw new ContractError("INVALID_ARGUMENT", "Parent revision belongs to another test");
          const ordinal = Number(
            this.ctx.database.get(
              "SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM test_revisions WHERE workspace_id=? AND test_id=?",
              this.ctx.workspaceId,
              target.id,
            )?.ordinal,
          );
          Object.assign(revision, {
            testId: target.id,
            ordinal,
            contentHash: codeRef.contentHash,
            plan: null,
            codeArtifactId: artifact.id,
            codeRef,
            runnerKind: bundle.format === "pytest" ? "python" : "playwright",
            author: this.ctx.principalId,
            parentId: parentId ?? null,
            origin,
          });
          if (origin === "generated")
            revision.extensions = { "testmaster:verificationRequired": true };
          if (createTest) {
            target.activeRevisionId = revision.id;
            this.ctx.entities.insert("TestCase", target);
          }
          this.ctx.entities.insert("TestRevision", revision);
          this.ctx.entities.insert("Artifact", artifact);
          this.ctx.entities.insert("Artifact", dependency as Stored<Artifact>);
          return revision;
        });
      const result = request
        ? new IdempotencyRepository(this.ctx.database).execute(
            { workspaceId: this.ctx.workspaceId, actorScope: this.ctx.principalId, ...request },
            action,
          ).receipt
        : action();
      if (result.id !== revision.id) {
        await rm(join(this.config.dataDir, artifact.storageKey), { force: true });
        await rm(join(this.config.dataDir, dependency.storageKey), { force: true });
      }
      return result;
    } catch (error) {
      await rm(join(this.config.dataDir, artifact.storageKey), { force: true });
      if (dependency) await rm(join(this.config.dataDir, dependency.storageKey), { force: true });
      throw error;
    }
  }
  private replay<T>(request: { operation: string; key: string; body: unknown }): T | undefined {
    if (request.key.length < 16 || request.key.length > 128)
      throw new ContractError("INVALID_ARGUMENT", "Idempotency key must have 16–128 characters");
    const row = this.ctx.database.get(
      "SELECT request_hash,response_json,expires_at FROM idempotency_receipts WHERE workspace_id=? AND actor_scope=? AND operation=? AND key=?",
      this.ctx.workspaceId,
      this.ctx.principalId,
      request.operation,
      request.key,
    );
    if (!row || String(row.expires_at) <= new Date().toISOString()) return undefined;
    if (row.request_hash !== semanticHash(request.body))
      throw new ContractError(
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key has a different request body",
      );
    return JSON.parse(String(row.response_json)) as T;
  }
  private async store(revisionId: string, kind: string, bytes: Buffer): Promise<Stored<Artifact>> {
    const artifact = entity(this.ctx, "art", {
      runId: null,
      attemptId: null,
      revisionId,
      snapshotId: null,
      kind,
      hash: sha256(bytes),
      bytes: bytes.length,
      mime: "application/json",
      state: "available",
      redactionStatus: "not_applicable",
    }) as Stored<Artifact>;
    const root = resolve(this.config.dataDir);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await lstat(root)).isSymbolicLink())
      throw new ContractError("POLICY_DENIED", "Artifact data root cannot be a symlink");
    const directory = join(root, "authored-code");
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink())
      throw new ContractError(
        "POLICY_DENIED",
        "Authored artifact directory must be private and regular",
      );
    artifact.storageKey = `authored-code/${artifact.id}.json`;
    const handle = await open(
      join(root, artifact.storageKey),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      await rm(join(root, artifact.storageKey), { force: true });
      throw error;
    } finally {
      await handle.close();
    }
    return artifact;
  }
  async readBundle(
    revisionId: string,
  ): Promise<{ bundle: ImportedCodeBundle; dependencyLock: ImportedDependencyLock }> {
    this.ctx.authorize("R");
    const revision = requireEntity(this.ctx, "TestRevision", revisionId) as Stored<TestRevision>;
    const test = requireEntity(this.ctx, "TestCase", revision.testId) as Stored<TestCase>;
    this.ctx.authorize("R", test.projectId);
    if (
      revision.plan !== null ||
      !revision.codeRef ||
      revision.codeArtifactId !== revision.codeRef.artifactId
    )
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Revision does not reference an imported code bundle",
      );
    const read = async (id: string, kind: string): Promise<Buffer> => {
      const artifact = requireEntity(this.ctx, "Artifact", id) as Stored<Artifact>;
      if (
        artifact.revisionId !== revision.id ||
        artifact.kind !== kind ||
        artifact.runId !== null ||
        artifact.attemptId !== null ||
        artifact.snapshotId !== null ||
        artifact.state !== "available"
      )
        throw new ContractError("PRECONDITION_FAILED", "Invalid authored artifact provenance");
      const root = await realpath(this.config.dataDir);
      const bytes = await readConfinedCodeFile(root, artifact.storageKey, 8 * 1024 * 1024);
      if (sha256(bytes) !== artifact.hash || bytes.length !== artifact.bytes)
        throw new ContractError("PRECONDITION_FAILED", "Authored code artifact integrity mismatch");
      return bytes;
    };
    const bundleBytes = await read(revision.codeRef.artifactId, "code-bundle");
    if (
      sha256(bundleBytes) !== revision.codeRef.contentHash ||
      revision.contentHash !== revision.codeRef.contentHash
    )
      throw new ContractError("PRECONDITION_FAILED", "CodeReference content hash mismatch");
    const bundle = JSON.parse(bundleBytes.toString("utf8")) as ImportedCodeBundle;
    const dependencyLock = JSON.parse(
      (await read(revision.codeRef.dependencyLockRef, "code-dependency-lock")).toString("utf8"),
    ) as ImportedDependencyLock;
    validate("CodeReference", revision.codeRef);
    if (
      bundle.schemaVersion !== "1.0.0" ||
      bundle.entrypoint !== revision.codeRef.entrypoint ||
      !bundle.files[bundle.entrypoint] ||
      dependencyLock.runnerCapabilityVersion !== revision.codeRef.runnerCapabilityVersion ||
      dependencyLock.runtimeInstalls !== false
    )
      throw new ContractError("PRECONDITION_FAILED", "Invalid code bundle metadata");
    for (const [path, text] of Object.entries(bundle.files)) {
      if (
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").includes("..") ||
        typeof text !== "string" ||
        sha256(Buffer.from(text)) !== bundle.sourceHashes[path]
      )
        throw new ContractError("PRECONDITION_FAILED", "Invalid code bundle file");
    }
    return { bundle, dependencyLock };
  }
}
