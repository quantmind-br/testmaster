import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CodeSnapshot,
  ContractError,
  type DiscoveryJob,
  type DiscoverySummary,
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
  buildStaticFeatureMap,
  CODE_DETECTOR_VERSION,
  type CodeDiff,
  type CodeSummary,
  type PythonCodeSummary,
  type PythonSummaryRunner,
  retainRelativeImports,
  SOURCE_PARSER_VERSION,
  summarizeCode,
  summarizeDiffScope,
} from "@testmaster/planner";
import { DockerExecutor, dockerCommand, verifyImageLock } from "@testmaster/sandbox";
import type { ResolvedConfig } from "../config.js";
import { allEntities, entity, requireEntity, type ServiceContext } from "../context.js";
import { type RepositoryProvenance, resolveRepositoryProvenance } from "../provenance.js";
import { revokedImageIds } from "../release.js";
import { invalidateAiDescendants } from "./invalidation.js";
import { promptVersions } from "./model.js";
import { readAiState, replayAiReceipt, type SourcesService, saveAiState } from "./sources.js";

type StoredJob = DiscoveryJob & EntityDocument;
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
  repository?: RepositoryProvenance;
}
/**
 * Why a feature found by static analysis is not `ready`. A feature that is `partial` or
 * `needs_input` with no reason reads as an unexplained success.
 */
function staticFeatureReasons(needsInput: boolean, pythonUnavailable: boolean): string[] {
  if (needsInput) return ["source_revision_not_ready"];
  return pythonUnavailable
    ? ["static_analysis_only", "python_unavailable"]
    : ["static_analysis_only"];
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
    private readonly revokedImages: () => ReadonlySet<string> = () => new Set(),
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
      const lock = await verifyImageLock(
        lockPath,
        async (imageId) => {
          const result = await dockerCommand(
            ["image", "inspect", imageId, "--format", "{{.Id}}"],
            10000,
          );
          if (result.code !== 0) throw new Error("Pinned Python image is unavailable");
          return result.stdout.toString().trim();
        },
        undefined,
        this.revokedImages(),
      );
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
            version: { const: "1.1.0" },
            files: {
              type: "array",
              maxItems: 20000,
              items: {
                type: "object",
                additionalProperties: false,
                required: [
                  "path",
                  "routes",
                  "routers",
                  "includes",
                  "calls",
                  "functions",
                  "imports",
                  "tests",
                  "symbols",
                ],
                properties: {
                  path: { type: "string", maxLength: 4096 },
                  routes: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["framework", "method", "path", "handler", "line", "router"],
                      properties: {
                        framework: { enum: ["fastapi", "flask"] },
                        method: { type: "string" },
                        path: { type: "string" },
                        handler: { type: "string" },
                        line: { type: "integer", minimum: 1 },
                        router: { type: ["integer", "null"], minimum: 0 },
                      },
                    },
                  },
                  routers: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["id", "kind", "name", "line", "prefix", "module"],
                      properties: {
                        id: { type: "integer", minimum: 0 },
                        kind: { enum: ["app", "router", "parameter"] },
                        name: { type: "string" },
                        line: { type: "integer", minimum: 1 },
                        prefix: { type: ["string", "null"] },
                        module: { type: "boolean" },
                      },
                    },
                  },
                  includes: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["parent", "child", "prefix", "line"],
                      properties: {
                        parent: { type: "integer", minimum: 0 },
                        child: {
                          anyOf: [
                            {
                              type: "object",
                              additionalProperties: false,
                              required: ["router"],
                              properties: { router: { type: "integer", minimum: 0 } },
                            },
                            {
                              type: "object",
                              additionalProperties: false,
                              required: ["name", "call"],
                              properties: { name: { type: "string" }, call: { type: "boolean" } },
                            },
                          ],
                        },
                        prefix: { type: ["string", "null"] },
                        line: { type: "integer", minimum: 1 },
                      },
                    },
                  },
                  calls: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["callee", "arguments", "line"],
                      properties: {
                        callee: { type: "string" },
                        arguments: {
                          type: "array",
                          items: {
                            type: "object",
                            additionalProperties: false,
                            required: ["router", "index", "keyword"],
                            properties: {
                              router: { type: "integer", minimum: 0 },
                              index: { type: ["integer", "null"], minimum: 0 },
                              keyword: { type: ["string", "null"] },
                            },
                          },
                        },
                        line: { type: "integer", minimum: 1 },
                      },
                    },
                  },
                  functions: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["name", "parameters", "routerParameters", "returns"],
                      properties: {
                        name: { type: "string" },
                        parameters: { type: "array", items: { type: "string" } },
                        routerParameters: {
                          type: "object",
                          additionalProperties: { type: "integer", minimum: 0 },
                        },
                        returns: { type: "array", items: { type: "integer", minimum: 0 } },
                      },
                    },
                  },
                  imports: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["local", "module", "name", "level"],
                      properties: {
                        local: { type: "string" },
                        module: { type: "string" },
                        name: { type: ["string", "null"] },
                        level: { type: "integer", minimum: 0 },
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
    this.pythonRunner =
      pythonRunner ??
      new DockerPythonSummaryRunner(config, new DockerExecutor(), () =>
        revokedImageIds(ctx.database),
      );
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
  /** Discovery runs of a project, newest first, without their bulky per-file detail. */
  list(projectId: string): DiscoverySummary[] {
    this.ctx.authorize("R", projectId);
    requireEntity(this.ctx, "Project", projectId);
    return allEntities(this.ctx, "DiscoveryJob")
      .flatMap((job): DiscoverySummary[] => {
        const state = readAiState<DiscoveryState>(this.ctx, `discovery:${job.id}`);
        if (!state || state.projectId !== projectId) return [];
        const { summary, diff, codeSnapshot, featureMap, status, warnings } = state.detail;
        return [
          {
            id: job.id,
            createdAt: job.createdAt as string,
            projectId,
            phase: job.phase as DiscoverySummary["phase"],
            scope: state.request.scope ?? "codebase",
            baseSha: diff?.baseSha ?? codeSnapshot.baseSha,
            headSha: diff?.headSha ?? codeSnapshot.headSha,
            includesWorkingTree: diff?.includeWorkingTree ?? false,
            status,
            counts: {
              scannedFiles: summary.scannedFiles.length,
              skippedFiles: summary.skippedFiles.length,
              endpoints: summary.endpoints.length,
              routes: summary.routes.length,
              features: featureMap.features.length,
              warnings: warnings.length,
            },
            sourceRevisionIds: featureMap.sourceRevisionIds,
          },
        ];
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
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
      maxSymbolsPerFile: 200,
      maxSymbols: 20000,
      pythonRunner: this.pythonRunner,
    };
    if (scope === "diff") {
      // Only the changed files, their importers and critical tests are read; the rest is listed
      // as excluded. A pinned head is staged from git objects, never from the working tree.
      const scoped = await summarizeDiffScope({
        repoRoot: root,
        base: input.base as string,
        ...(input.head ? { head: input.head } : {}),
        ...(input.workingTree ? { workingTree: true, dataDir: this.config.dataDir } : {}),
        summary: options,
        stagingDir: join(this.config.dataDir, "discovery-snapshots"),
      });
      summary = scoped.summary;
      diff = scoped.diff;
    } else summary = await summarizeCode(root, options);
    // The import graph is complete up to here; only relative specifiers are stored, bounded.
    retainRelativeImports(summary);
    const repository = resolveRepositoryProvenance(root, undefined, {
      dataDir: this.config.dataDir,
      persistCache: this.ctx.database.engine === "sqlite",
    });
    if (diff && !input.workingTree) {
      repository.commitSha = diff.headSha;
      repository.checkoutSha = diff.headSha;
      repository.dirtyHash = null;
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
        repository,
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
                perFeatureResults: existing.job.perFeatureResults.map((value) => {
                  if (selectedFeatures && !selectedFeatures.has(value.featureId)) return value;
                  const needsInput = state.detail.featureMap.status === "needs_input";
                  return {
                    ...value,
                    status: needsInput ? "needs_input" : "partial",
                    errors: staticFeatureReasons(needsInput, unavailable),
                  };
                }),
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
      dirtyHash: repository.dirtyHash,
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
    // Components are not features: they have no route or endpoint and cannot be explored.
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
        errors: staticFeatureReasons(needsInput, unreachable),
      })),
      limits: this.config.profilePolicy.limits,
      usage: { modelCalls: 0, status },
    }) as StoredJob;
    const state: DiscoveryState = {
      projectId: input.projectId,
      request: { ...input, root, sourceRevisionIds },
      detail: { codeSnapshot, summary, diff, featureMap, status, warnings, repository },
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
        const cacheKey = `discovery-inputs:${input.projectId}:${root}:${scope}`;
        const currentFingerprint = readAiState<string>(this.ctx, cacheKey);
        if (currentFingerprint && currentFingerprint !== fingerprint)
          invalidateAiDescendants(this.ctx, input.projectId, `code:${codeSnapshot.id}`);
        saveAiState(this.ctx, cacheKey, fingerprint);
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
