import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type CodeSnapshot,
  ContractError,
  type DiscoveryJob,
  type Feature,
  parseStrictJson,
  validateAgainstSchema,
} from "@testmaster/contracts";
import { canonicalJson, sha256, uuidV7IdGenerator } from "@testmaster/domain";
import {
  type EntityDocument,
  IdempotencyRepository,
  OutboxRepository,
} from "@testmaster/persistence";
import {
  analyzeDiff,
  buildStaticFeatureMap,
  CODE_DETECTOR_VERSION,
  type CodeDiff,
  type CodeSummary,
  type PythonCodeSummary,
  type PythonSummaryRunner,
  SOURCE_PARSER_VERSION,
  summarizeCode,
} from "@testmaster/planner";
import { DockerExecutor, dockerCommand, verifyImageLock } from "@testmaster/sandbox";
import type { ResolvedConfig } from "../config.js";
import { allEntities, entity, requireEntity, type ServiceContext } from "../context.js";
import { promptVersions } from "./model.js";
import { readAiState, replayAiReceipt, type SourcesService, saveAiState } from "./sources.js";

type StoredJob = DiscoveryJob & EntityDocument;
const execFileAsync = promisify(execFile);
export interface DiscoverInput {
  projectId: string;
  root?: string;
  sourceRevisionIds?: string[];
  scope?: "codebase" | "diff";
  base?: string;
  head?: string;
  workingTree?: boolean;
  resume?: string;
  environmentRevisionId?: string;
  provider?: string;
  model?: string;
  promptVersion?: string;
  excludes?: string[];
  inputsFingerprint?: string;
  retryFeatures?: string[];
  idempotencyKey?: string;
}
export interface DiscoveryFeatureMap {
  projectId: string;
  version: number;
  features: Feature[];
  sourceRevisionIds: string[];
  status: "ready" | "partial" | "needs_input";
}
export interface DiscoveryDetail {
  job: StoredJob;
  codeSnapshot: CodeSnapshot & EntityDocument;
  summary: CodeSummary;
  diff: CodeDiff | null;
  featureMap: DiscoveryFeatureMap;
  status: "partial" | "needs_input" | "unreachable";
  warnings: string[];
}
interface DiscoveryState {
  projectId: string;
  request: DiscoverInput;
  detail: Omit<DiscoveryDetail, "job">;
  featureEvidence: Record<string, unknown[]>;
}

/** AST-only analysis: no user module is imported; the repository mount is read-only. */
export class DockerPythonSummaryRunner implements PythonSummaryRunner {
  constructor(
    readonly config: ResolvedConfig,
    readonly executor = new DockerExecutor(),
  ) {}
  async summarize(
    repoRoot: string,
    files: string[],
  ): Promise<
    { available: true; summary: PythonCodeSummary } | { available: false; reason: string }
  > {
    let temporary: string | undefined;
    try {
      const root = await realpath(repoRoot);
      const approved = await realpath(this.config.cwd);
      const snapshots = resolve(this.config.dataDir, "discovery-snapshots");
      if (
        root !== approved &&
        !root.startsWith(`${approved}${sep}`) &&
        !root.startsWith(`${snapshots}${sep}`)
      )
        throw new ContractError("POLICY_DENIED", "Python root escapes project");
      if (
        !files.length ||
        files.length > 20000 ||
        files.some(
          (path) =>
            path.startsWith("/") ||
            path.includes("\\") ||
            path.split("/").includes("..") ||
            !path.endsWith(".py"),
        )
      )
        throw new ContractError("POLICY_DENIED", "Python file list is not confined");
      const lockPath = fileURLToPath(
        new URL("../../../../containers/images.lock.json", import.meta.url),
      );
      const lock = await verifyImageLock(lockPath, async (imageId) => {
        const result = await dockerCommand(
          ["image", "inspect", imageId, "--format", "{{.Id}}"],
          10000,
        );
        if (result.code !== 0) throw new Error("Pinned Python image is unavailable");
        return result.stdout.toString().trim();
      });
      const runtime = join(this.config.dataDir, "python-summary");
      await mkdir(runtime, { recursive: true, mode: 0o700 });
      temporary = await mkdtemp(join(runtime, "summary-"));
      const sockets = join(temporary, "sockets");
      await mkdir(sockets, { mode: 0o755 });
      const result = await this.executor.execute({
        attemptId: uuidV7IdGenerator.next("att"),
        runId: uuidV7IdGenerator.next("run"),
        kind: "python",
        imageId: lock["testmaster-runner-python"].imageId,
        inputDir: root,
        socketsDir: sockets,
        seccompPath: join(lockPath, "..", "seccomp_profile.json"),
        entrypoint: ["python"],
        command: ["-m", "testmaster_runner.code_summary", "/run/testmaster/input", ...files],
        attemptTimeoutMs: 120000,
        cancellationGraceMs: 0,
      });
      if (result.code !== 0 || result.cancelled || result.facts.oomKilled)
        return {
          available: false,
          reason: "Hardened Python analysis failed or exceeded its limit",
        };
      const summary = parseStrictJson(result.stdout, 8 * 1024 * 1024);
      validateAgainstSchema(
        {
          type: "object",
          additionalProperties: false,
          required: ["version", "files", "diagnostics"],
          properties: {
            version: { const: "1.0.0" },
            files: {
              type: "array",
              maxItems: 20000,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["path", "routes", "tests", "symbols"],
                properties: {
                  path: { type: "string", maxLength: 4096 },
                  routes: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["framework", "method", "path", "handler", "line"],
                      properties: {
                        framework: { enum: ["fastapi", "flask"] },
                        method: { type: "string" },
                        path: { type: "string" },
                        handler: { type: "string" },
                        line: { type: "integer", minimum: 1 },
                      },
                    },
                  },
                  tests: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["name", "line", "async"],
                      properties: {
                        name: { type: "string" },
                        line: { type: "integer", minimum: 1 },
                        async: { type: "boolean" },
                      },
                    },
                  },
                  symbols: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["name", "kind", "line"],
                      properties: {
                        name: { type: "string" },
                        kind: { enum: ["function", "class"] },
                        line: { type: "integer", minimum: 1 },
                      },
                    },
                  },
                },
              },
            },
            diagnostics: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["path", "code", "message"],
                properties: {
                  path: { type: "string" },
                  code: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        summary,
      );
      return { available: true, summary: summary as PythonCodeSummary };
    } catch (error) {
      if (error instanceof ContractError && error.code === "POLICY_DENIED") throw error;
      return {
        available: false,
        reason: error instanceof Error ? error.message : "Hardened Python analysis is unavailable",
      };
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }
}

export class DiscoveryService {
  readonly pythonRunner: PythonSummaryRunner;
  constructor(
    readonly ctx: ServiceContext,
    readonly config: ResolvedConfig,
    readonly sources: SourcesService,
    pythonRunner?: PythonSummaryRunner,
  ) {
    this.pythonRunner = pythonRunner ?? new DockerPythonSummaryRunner(config);
  }
  private state(id: string): DiscoveryState {
    const state = readAiState<DiscoveryState>(this.ctx, `discovery:${id}`);
    if (!state) throw new ContractError("NOT_FOUND", "Discovery does not exist");
    this.ctx.authorize("R", state.projectId);
    return state;
  }
  get(id: string): DiscoveryDetail {
    const state = this.state(id);
    return { job: requireEntity(this.ctx, "DiscoveryJob", id) as StoredJob, ...state.detail };
  }
  events(id: string, afterSeq = -1): Record<string, unknown>[] {
    this.get(id);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < -1)
      throw new ContractError("INVALID_ARGUMENT", "Event sequence must be an integer at least -1");
    return this.ctx.database
      .all(
        "SELECT * FROM outbox WHERE workspace_id=? AND aggregate_id=? AND seq>? ORDER BY seq LIMIT 100",
        this.ctx.workspaceId,
        id,
        afterSeq,
      )
      .map((row) => ({ ...row, ...JSON.parse(String(row.data_json)) }));
  }
  async discover(input: DiscoverInput): Promise<DiscoveryDetail> {
    return this.execute(input, false);
  }
  private async execute(input: DiscoverInput, retry: boolean): Promise<DiscoveryDetail> {
    this.ctx.authorize("X", input.projectId);
    const project = requireEntity(this.ctx, "Project", input.projectId);
    const replay =
      !retry && !input.resume
        ? replayAiReceipt<{ jobId: string }>(
            this.ctx,
            "discovery.discover",
            input.idempotencyKey,
            input,
          )
        : null;
    if (replay) return this.get(replay.jobId);
    if (project.archivedAt) throw new ContractError("PRECONDITION_FAILED", "Project is archived");
    const scope = input.scope ?? "codebase";
    if (!["codebase", "diff"].includes(scope))
      throw new ContractError("INVALID_ARGUMENT", "Unknown discovery scope");
    if (scope === "diff" && (!input.base || (!input.head && !input.workingTree)))
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Diff requires explicit base and head, or base and working-tree",
      );
    const approved = await realpath(this.config.cwd);
    const root = await realpath(resolve(approved, input.root ?? "."));
    if (root !== approved && !root.startsWith(`${approved}${sep}`))
      throw new ContractError("POLICY_DENIED", "Discovery root escapes approved project");
    const sourceRevisionIds = [
      ...new Set(
        input.sourceRevisionIds ??
          this.sources
            .list(input.projectId)
            .flatMap((source) => (source.activeRevisionId ? [source.activeRevisionId] : [])),
      ),
    ].sort();
    const revisions = sourceRevisionIds.map((id) => {
      if (this.sources.revisionProject(id) !== input.projectId)
        throw new ContractError("FORBIDDEN", "Source revision belongs to another project");
      return this.sources.revision(id);
    });
    let environment: unknown = null;
    const defaultEnvironment = project.defaultEnvironmentId
      ? requireEntity(this.ctx, "Environment", String(project.defaultEnvironmentId))
      : null;
    const environmentRevisionId =
      input.environmentRevisionId ?? defaultEnvironment?.activeRevisionId;
    if (environmentRevisionId) {
      const revision = requireEntity(
        this.ctx,
        "EnvironmentRevision",
        String(environmentRevisionId),
      );
      if (
        !allEntities(this.ctx, "Environment").some(
          (value) =>
            value.projectId === input.projectId &&
            (value.activeRevisionId === revision.id ||
              this.ctx.database.get(
                "SELECT id FROM environment_revisions WHERE workspace_id=? AND id=? AND environment_id=?",
                this.ctx.workspaceId,
                revision.id,
                value.id,
              )),
        )
      )
        throw new ContractError("FORBIDDEN", "Environment revision belongs to another project");
      environment = revision;
    }
    let summary: CodeSummary;
    let diff: CodeDiff | null = null;
    const options = {
      excludes: input.excludes ?? [],
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 64 * 1024 * 1024,
      maxFiles: 20000,
      pythonRunner: this.pythonRunner,
    };
    if (scope === "diff" && !input.workingTree) {
      const pinned = await analyzeDiff({
        repoRoot: root,
        base: input.base as string,
        head: input.head as string,
      });
      summary = await this.summarizePinned(root, pinned.headSha, options);
      diff = await analyzeDiff({
        repoRoot: root,
        base: pinned.baseSha,
        head: pinned.headSha,
        summary,
      });
    } else {
      summary = await summarizeCode(root, options);
      if (scope === "diff")
        diff = await analyzeDiff({
          repoRoot: root,
          base: input.base as string,
          ...(input.head ? { head: input.head } : {}),
          workingTree: true,
          summary,
        });
    }
    const provider = this.config.modelProviders.find((value) =>
      input.provider
        ? value.id === input.provider
        : this.config.profilePolicy.allowedModelProviders.includes(value.id),
    );
    const model = provider?.models.find((value) =>
      input.model ? value.id === input.model : value.capabilities.structuredJson,
    );
    const fingerprint = sha256(
      canonicalJson({
        workspaceId: this.ctx.workspaceId,
        projectId: input.projectId,
        sourceRevisions: revisions.map((value) => ({
          id: value.revision.id,
          hash: value.revision.contentHash,
          status: value.revision.status,
          parserVersion: value.revision.parserVersion,
        })),
        codeSnapshot: { repoRef: root, manifestHash: summary.manifestHash, diff },
        parserVersion: SOURCE_PARSER_VERSION,
        detectorVersion: CODE_DETECTOR_VERSION,
        runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
        promptVersion: input.promptVersion ?? promptVersions.summarize,
        model: {
          requestedProvider: input.provider ?? null,
          requestedModel: input.model ?? null,
          provider: provider?.id ?? null,
          endpoint: provider?.baseUrl ?? null,
          resolvedModel: model ?? null,
        },
        environment,
        effectiveEnvironment: this.config.effectiveConfig.config.environment ?? null,
        scope,
        policyHash: this.config.effectiveConfig.policyHash,
        policy: this.config.profilePolicy,
        excludes: input.excludes ?? [],
      }),
    );
    if (input.inputsFingerprint && input.inputsFingerprint !== fingerprint)
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Discovery fingerprint no longer matches inputs",
      );
    if (input.resume) {
      const existing = this.get(input.resume);
      const state = this.state(input.resume);
      if (state.projectId !== input.projectId || existing.job.inputsFingerprint !== fingerprint)
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Resume fingerprint does not match current inputs",
        );
      if (!retry && existing.job.phase === "completed") return existing;
      if (!retry && existing.job.phase === "cancelled")
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Cancelled discovery requires explicit retry",
        );
      if (retry) {
        const selectedFeatures = input.retryFeatures?.length ? new Set(input.retryFeatures) : null;
        new IdempotencyRepository(this.ctx.database).execute(
          {
            workspaceId: this.ctx.workspaceId,
            actorScope: this.ctx.principalId,
            operation: "discovery.retry",
            key: input.idempotencyKey ?? uuidV7IdGenerator.next("dsc"),
            body: input,
          },
          () => {
            state.detail.summary = summary;
            state.detail.diff = diff;
            const unavailable = summary.warnings.some(
              (value) => value.code === "python_unavailable",
            );
            state.detail.status = unavailable
              ? "unreachable"
              : state.detail.featureMap.status === "needs_input"
                ? "needs_input"
                : "partial";
            state.detail.warnings = [
              ...summary.warnings.map((value) => `${value.path}: ${value.code}: ${value.message}`),
              ...state.detail.warnings.filter((value) => !value.includes("python_unavailable")),
            ];
            saveAiState(this.ctx, `discovery:${input.resume}`, state);
            this.ctx.entities.update(
              "DiscoveryJob",
              this.ctx.workspaceId,
              input.resume as string,
              existing.job.version as number,
              {
                ...existing.job,
                phase: "queued",
                usage: { modelCalls: 0, status: state.detail.status },
                perFeatureResults: existing.job.perFeatureResults.map((value) =>
                  !selectedFeatures || selectedFeatures.has(value.featureId)
                    ? {
                        ...value,
                        status:
                          state.detail.featureMap.status === "needs_input"
                            ? "needs_input"
                            : "partial",
                        errors: [],
                      }
                    : value,
                ),
              },
              { projectId: input.projectId },
            );
            new OutboxRepository(this.ctx.database).append(
              this.ctx.workspaceId,
              input.resume as string,
              "discovery.updated",
              this.get(input.resume as string),
            );
            return { jobId: input.resume as string };
          },
        );
        await Promise.resolve();
      }
      return this.finish(input.resume);
    }
    const codeSnapshot = entity(this.ctx, "csp", {
      repoRef: root,
      baseSha: diff?.baseSha ?? null,
      headSha: diff?.headSha ?? null,
      dirtyHash: diff?.dirtyHash ?? null,
      manifestHash: summary.manifestHash,
      excludes: input.excludes ?? [],
      skippedFiles: [...summary.skippedFiles, ...(diff?.impact.excludedFiles ?? [])],
    }) as CodeSnapshot & EntityDocument;
    const features: Feature[] = [];
    const featureEvidence: Record<string, unknown[]> = {};
    const existingFeatures = allEntities(this.ctx, "Feature").filter(
      (value) => value.projectId === input.projectId,
    ) as (Feature & EntityDocument)[];
    const add = (stableKey: string, routes: string[], endpoints: string[], evidence: unknown[]) => {
      const duplicate = features.find((value) => value.stableKey === stableKey);
      if (duplicate) {
        featureEvidence[duplicate.id]?.push(...evidence);
        return;
      }
      const feature =
        existingFeatures.find((value) => value.stableKey === stableKey) ??
        (entity(this.ctx, "fea", {
          projectId: input.projectId,
          stableKey,
          requirementRefs: [],
          routeRefs: routes,
          endpointRefs: endpoints,
        }) as Feature & EntityDocument);
      features.push(feature);
      featureEvidence[feature.id] = evidence;
    };
    const selected = diff ? new Set(diff.impact.selectedFiles) : null;
    for (const route of summary.routes.filter((value) => !selected || selected.has(value.ref.path)))
      add(
        `route:${route.method}:${route.path}`,
        [route.path],
        [],
        [{ relativePath: route.ref.path, contentHash: route.ref.contentHash }],
      );
    for (const endpoint of summary.endpoints.filter(
      (value) => !selected || selected.has(value.ref.path),
    ))
      add(
        `endpoint:${endpoint.method}:${endpoint.path}`,
        [],
        [`${endpoint.method} ${endpoint.path}`],
        [{ relativePath: endpoint.ref.path, contentHash: endpoint.ref.contentHash }],
      );
    for (const component of summary.features.filter(
      (value) => !selected || selected.has(value.ref.path),
    ))
      add(
        `component:${component.ref.path}:${component.name}`,
        [],
        [],
        [{ relativePath: component.ref.path, contentHash: component.ref.contentHash }],
      );
    for (const result of revisions)
      for (const chunk of result.chunks.filter(
        (value) => value.requirementLike || value.kind === "requirement",
      ))
        add(`desired:${chunk.contentHash}`, [], [], [chunk.evidenceRef]);
    const warnings = [
      ...summary.warnings.map((value) => `${value.path}: ${value.code}: ${value.message}`),
      ...revisions.flatMap((value) =>
        value.diagnostics.map(
          (diagnostic) => `${value.revision.id}: ${diagnostic.code}: ${diagnostic.message}`,
        ),
      ),
      ...(diff?.impact.gaps ?? []),
      "Static analysis is partial; no live target observations or complete code coverage are claimed.",
    ];
    const unreachable = summary.warnings.some((value) => value.code === "python_unavailable");
    const needsInput =
      !features.length ||
      revisions.some(
        (value) => value.revision.status === "invalid" || value.revision.status === "needs_input",
      );
    const status = unreachable ? "unreachable" : needsInput ? "needs_input" : "partial";
    const featureMap = buildStaticFeatureMap(
      input.projectId,
      sourceRevisionIds,
      features,
      needsInput,
    );
    const job = entity(this.ctx, "dsc", {
      inputsFingerprint: fingerprint,
      phase: "queued",
      perFeatureResults: features.map((feature) => ({
        featureId: feature.id,
        status: needsInput ? "needs_input" : "partial",
        evidenceRefs: featureEvidence[feature.id] ?? [],
        errors: [],
      })),
      limits: this.config.profilePolicy.limits,
      usage: { modelCalls: 0, status },
    }) as StoredJob;
    const state: DiscoveryState = {
      projectId: input.projectId,
      request: { ...input, root, sourceRevisionIds },
      detail: { codeSnapshot, summary, diff, featureMap, status, warnings },
      featureEvidence,
    };
    const admission = new IdempotencyRepository(this.ctx.database).execute(
      {
        workspaceId: this.ctx.workspaceId,
        actorScope: this.ctx.principalId,
        operation: "discovery.discover",
        key: input.idempotencyKey ?? uuidV7IdGenerator.next("dsc"),
        body: input,
      },
      () => {
        this.ctx.entities.insert("CodeSnapshot", codeSnapshot, { projectId: input.projectId });
        for (const feature of features)
          if (!this.ctx.entities.get("Feature", this.ctx.workspaceId, feature.id))
            this.ctx.entities.insert("Feature", feature as Feature & EntityDocument);
        this.ctx.entities.insert("DiscoveryJob", job, { projectId: input.projectId });
        saveAiState(this.ctx, `discovery:${job.id}`, state);
        new OutboxRepository(this.ctx.database).append(
          this.ctx.workspaceId,
          job.id,
          "discovery.accepted",
          this.get(job.id),
        );
        return { jobId: job.id };
      },
    );
    await Promise.resolve();
    return this.finish(admission.receipt.jobId);
  }
  private async summarizePinned(
    root: string,
    sha: string,
    options: Parameters<typeof summarizeCode>[1],
  ): Promise<CodeSummary> {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    const git = async (args: string[], maxBuffer: number) =>
      execFileAsync(
        "git",
        ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
        { env, encoding: "buffer", maxBuffer, timeout: 30000 },
      );
    const tree = await git(["ls-tree", "-r", "-z", "-l", sha, "--"], 8 * 1024 * 1024);
    const storage = join(this.config.dataDir, "discovery-snapshots");
    await mkdir(storage, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(storage, "head-"));
    await chmod(temporary, 0o755);
    const skipped: { path: string; reason: string }[] = [];
    let count = 0;
    let total = 0;
    try {
      for (const entry of tree.stdout.toString("utf8").split("\0").filter(Boolean)) {
        const tab = entry.indexOf("\t");
        const path = entry.slice(tab + 1);
        const metadata = entry.slice(0, tab).trim().split(/\s+/u);
        if (
          tab < 0 ||
          path.startsWith("/") ||
          path.includes("\\") ||
          path.split("/").includes("..")
        )
          throw new ContractError("POLICY_DENIED", "Git tree contains an unconfined path");
        if (!metadata[0]?.startsWith("100") || metadata[1] !== "blob") {
          skipped.push({ path, reason: "git_link_or_nonregular" });
          continue;
        }
        const size = Number(metadata[3]);
        if (!Number.isSafeInteger(size) || size < 0)
          throw new ContractError("PRECONDITION_FAILED", "Git tree has an invalid blob size");
        if (++count > 20000 || total + size > 64 * 1024 * 1024)
          throw new ContractError("PAYLOAD_TOO_LARGE", "Pinned Git tree exceeds analysis limits");
        total += size;
        if (size > 1024 * 1024) {
          skipped.push({ path, reason: "file_size_limit" });
          continue;
        }
        const blob = await git(["cat-file", "blob", metadata[2] as string], 1024 * 1024 + 1);
        if (blob.stdout.byteLength !== size)
          throw new ContractError("PRECONDITION_FAILED", "Git blob size changed");
        await mkdir(dirname(join(temporary, path)), { recursive: true, mode: 0o755 });
        await writeFile(join(temporary, path), blob.stdout, { mode: 0o644, flag: "wx" });
      }
      const summary = await summarizeCode(temporary, options);
      summary.skippedFiles.push(...skipped);
      summary.manifestHash = sha256(
        canonicalJson({ manifestHash: summary.manifestHash, pinnedHead: sha, skipped }),
      );
      return summary;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  private finish(id: string): DiscoveryDetail {
    this.ctx.database.withTx(() => {
      const detail = this.get(id);
      if (detail.job.phase === "cancelled" || detail.job.phase === "completed") return;
      this.ctx.entities.update(
        "DiscoveryJob",
        this.ctx.workspaceId,
        id,
        detail.job.version as number,
        { ...detail.job, phase: "completed" },
        { projectId: this.state(id).projectId },
      );
      new OutboxRepository(this.ctx.database).append(
        this.ctx.workspaceId,
        id,
        "discovery.updated",
        this.get(id),
      );
    });
    return this.get(id);
  }
  async retry(
    id: string,
    input: { featureIds?: string[]; inputsFingerprint?: string; idempotencyKey?: string } = {},
  ): Promise<DiscoveryDetail> {
    const state = this.state(id);
    const current = this.get(id);
    this.ctx.authorize("X", state.projectId);
    if (
      input.featureIds?.some(
        (featureId) =>
          !state.detail.featureMap.features.some((feature) => feature.id === featureId),
      )
    )
      throw new ContractError("INVALID_ARGUMENT", "Retry contains an unknown feature");
    if (input.inputsFingerprint && input.inputsFingerprint !== current.job.inputsFingerprint)
      throw new ContractError("PRECONDITION_FAILED", "Retry fingerprint does not match job");
    const request = { ...state.request, inputsFingerprint: current.job.inputsFingerprint };
    delete request.idempotencyKey;
    delete request.resume;
    // Re-read sources/code and reject drift before changing the durable job.
    const retryRequest: DiscoverInput = {
      ...request,
      resume: id,
      ...(input.featureIds ? { retryFeatures: input.featureIds } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    };
    const replay = replayAiReceipt<{ jobId: string }>(
      this.ctx,
      "discovery.retry",
      input.idempotencyKey,
      retryRequest,
    );
    if (replay) return this.get(replay.jobId);
    return this.execute(retryRequest, true);
  }
  cancel(id: string): StoredJob {
    const detail = this.get(id);
    this.ctx.authorize("X", this.state(id).projectId);
    if (["completed", "failed", "cancelled"].includes(detail.job.phase)) return detail.job;
    this.ctx.database.withTx(() => {
      const current = this.get(id);
      if (["completed", "failed", "cancelled"].includes(current.job.phase)) return;
      this.ctx.entities.update(
        "DiscoveryJob",
        this.ctx.workspaceId,
        id,
        current.job.version as number,
        { ...current.job, phase: "cancelled" },
        { projectId: this.state(id).projectId },
      );
      new OutboxRepository(this.ctx.database).append(
        this.ctx.workspaceId,
        id,
        "discovery.updated",
        this.get(id),
      );
    });
    return this.get(id).job;
  }
}
