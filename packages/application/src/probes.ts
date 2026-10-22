import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ContractError,
  DEFAULT_PROPERTY_EXAMPLES,
  type ExecutablePlan,
  type ProbeSpec,
  type ReproductionInput,
  resolvePropertyChecks,
  validate,
} from "@testmaster/contracts";
import { sha256 } from "@testmaster/domain";
import { streamBundleArtifact } from "@testmaster/evidence";
import { loadSourceView } from "./ai/source-documents.js";
import { readAiState } from "./ai/sources.js";
import type { ArtifactsService } from "./artifacts.js";
import type { TestsService } from "./authoring.js";
import type { ResolvedConfig } from "./config.js";
import { requireEntity, type ServiceContext } from "./context.js";
import type { OwnedReceipt, RunsService } from "./runs.js";

/** The source media type each probe API reads (`parseSource` stores it on the revision). */
const API_MEDIA_TYPES = {
  openapi: "application/vnd.oai.openapi",
  graphql: "application/graphql",
} as const;
/** A replay plan is a small JSON document; anything larger is not one the runner wrote. */
const MAX_REPLAY_PLAN_BYTES = 1024 * 1024;

/** A probe with its defaults filled in, so equal probes hash, run and compare alike (ADR-033). */
export function normalizeProbe(spec: ProbeSpec): ProbeSpec {
  return {
    ...spec,
    maxExamples: spec.maxExamples ?? DEFAULT_PROPERTY_EXAMPLES,
    checks: resolvePropertyChecks(spec),
  };
}

/**
 * Refuses a probe its project cannot run: a source of another project or of another API kind, an
 * OpenAPI operation the description does not declare, GraphQL options only OpenAPI has, or a
 * credential that does not exist.
 */
export function assertProbeUsable(ctx: ServiceContext, projectId: string, spec: ProbeSpec): void {
  const source = requireEntity(ctx, "SourceRevision", spec.sourceRevisionId);
  const state = readAiState<{ projectId?: string }>(ctx, `revision:${spec.sourceRevisionId}`);
  if (state?.projectId !== projectId)
    throw new ContractError("INVALID_ARGUMENT", "The source revision belongs to another project", {
      sourceRevisionId: spec.sourceRevisionId,
    });
  if (source.mediaType !== API_MEDIA_TYPES[spec.api as keyof typeof API_MEDIA_TYPES])
    throw new ContractError("INVALID_ARGUMENT", `The source revision is not a ${spec.api} source`, {
      sourceRevisionId: spec.sourceRevisionId,
      mediaType: source.mediaType,
    });
  if (spec.api === "graphql") {
    if (spec.stateful)
      throw new ContractError("INVALID_ARGUMENT", "Stateful property runs need OpenAPI links");
    if (spec.checks?.some((check) => check !== "not_a_server_error"))
      throw new ContractError(
        "INVALID_ARGUMENT",
        "A GraphQL property probe checks only not_a_server_error",
      );
  }
  if (spec.api === "openapi" && spec.operations) {
    const view = loadSourceView(ctx, spec.sourceRevisionId);
    // The view lists the parsed inventory's operations only, keyed by lower-case method.
    const declared = new Set(
      Object.entries(view?.document.paths ?? {}).flatMap(([path, methods]) =>
        Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
      ),
    );
    const unknown = spec.operations.find((operation) => !declared.has(operation));
    if (unknown)
      throw new ContractError("INVALID_ARGUMENT", "The API description has no such operation", {
        operation: unknown,
      });
  }
  for (const credential of spec.credentials ?? [])
    requireEntity(ctx, "SecretReference", credential.secretRef);
}

/**
 * The bytes the source was imported from, checked against the revision's content hash, and the
 * file name the Python runner reads them under. Changed bytes refuse the Attempt: the probe would
 * otherwise test a description other than the one admission bound.
 */
export async function probeSchemaFile(
  ctx: ServiceContext,
  config: ResolvedConfig,
  spec: ProbeSpec,
): Promise<{ fileName: string; bytes: Buffer }> {
  const source = requireEntity(ctx, "SourceRevision", spec.sourceRevisionId);
  const bytes = await readFile(
    join(config.dataDir, "sources", ctx.workspaceId, `${spec.sourceRevisionId}.bin`),
  ).catch(() => {
    throw new ContractError("PRECONDITION_FAILED", "The probe's source bytes are unavailable", {
      sourceRevisionId: spec.sourceRevisionId,
    });
  });
  if (sha256(bytes) !== String(source.contentHash).replace(/^sha256:/u, ""))
    throw new ContractError("PRECONDITION_FAILED", "The probe's source bytes changed", {
      sourceRevisionId: spec.sourceRevisionId,
    });
  const fileName =
    spec.api === "graphql"
      ? "schema.graphql"
      : bytes.toString("utf8").trimStart().startsWith("{")
        ? "schema.json"
        : "schema.yaml";
  return { fileName, bytes };
}

/** Turns a failed property example into a deterministic HTTP test and admits it (ADR-033). */
export class ReproductionsService {
  constructor(
    readonly ctx: ServiceContext,
    private readonly artifacts: ArtifactsService,
    private readonly runs: RunsService,
    private readonly tests: TestsService,
  ) {}

  async reproduce(
    runId: string,
    input: ReproductionInput,
    options: { origin: "cli" | "api" | "mcp"; idempotencyKey?: string; wait?: boolean },
  ): Promise<OwnedReceipt & { testId: string }> {
    const request = validate<ReproductionInput>("ReproductionInput", input);
    const run = this.runs.get(runId);
    const source = requireEntity(this.ctx, "TestCase", run.testId);
    const projectId = String(source.projectId);
    this.ctx.authorize("W", projectId);
    this.ctx.authorize("X", projectId);
    if (!requireEntity(this.ctx, "TestRevision", run.revisionId).probe)
      throw new ContractError("INVALID_ARGUMENT", "The Run is not a probe Run", { runId });
    if (run.phase !== "completed")
      throw new ContractError("PRECONDITION_FAILED", "Run has not completed", {
        runId,
        phase: run.phase,
      });
    const plan = validate<ExecutablePlan>(
      "ExecutablePlan",
      JSON.parse((await this.replayPlan(runId, request.artifact)).toString("utf8")),
    );
    // One test per stored reproduction, so a retried request admits the same test again instead
    // of leaving an orphan behind.
    const key = `reproduction:${this.ctx.workspaceId}:${runId}:${request.artifact}`;
    const ordinal = /^property\/(\d+)-/u.exec(request.artifact)?.[1] ?? "1";
    const suffix = ` reproduction ${ordinal}`;
    const testId = this.ctx.database.withTx(() => {
      const known = this.ctx.database.get("SELECT value FROM operational_state WHERE key=?", key);
      if (known) return String(known.value);
      const created = this.tests.create({
        projectId,
        plan,
        name: `${String(source.name).slice(0, 200 - suffix.length)}${suffix}`,
      });
      this.ctx.database.run(
        "INSERT INTO operational_state(key,value) VALUES(?,?)",
        key,
        created.id,
      );
      return created.id;
    });
    const cell = run.matrixCell as Record<string, unknown>;
    const receipt = await this.runs.admit(
      {
        testId,
        environmentId: String(cell.environmentId),
        mode: "replay",
        seed: Number(cell.seed ?? 0),
        origin: options.origin,
      },
      {
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        ...(options.wait ? { wait: true } : {}),
      },
    );
    return { testId, ...receipt };
  }

  /** The stored replay plan's bytes; restricted raw evidence never leaves the bundle this way. */
  private async replayPlan(runId: string, relativePath: string): Promise<Buffer> {
    const bundle = await this.artifacts.get(runId);
    const entry = bundle.manifest.entries.find((item) => item.relativePath === relativePath);
    if (entry?.state !== "available")
      throw new ContractError("NOT_FOUND", "The Run stored no such replay plan", {
        runId,
        artifact: relativePath,
      });
    if (entry.redactionStatus === "restrictedRaw" || entry.sizeBytes > MAX_REPLAY_PLAN_BYTES)
      throw new ContractError("INVALID_ARGUMENT", "The artifact is not a replay plan", {
        artifact: relativePath,
      });
    const chunks: Buffer[] = [];
    for await (const chunk of streamBundleArtifact(
      { rootDir: bundle.bundleDir, manifest: bundle.manifest, meta: bundle.meta },
      entry.relativePath,
    ))
      chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
}
