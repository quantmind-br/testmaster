import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type ArtifactManifest,
  type Attempt,
  type BundleMeta,
  ContractError,
  type RunResult,
  type RuntimeTiming,
  type StepResult,
  validate,
} from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import {
  BundleIntegrityError,
  ConfinedRoot,
  deriveFailedOnly,
  streamBundleArtifact,
  UnsafePathError,
  verifyBundle,
} from "@testmaster/evidence";
import {
  executionMetrics,
  exportAllure,
  exportHtml,
  exportJson,
  exportJunit,
  exportMarkdown,
  type ReportRun,
  type ReportSnapshot,
} from "@testmaster/reporting";
import type { AnalysisService } from "./ai/analysis.js";
import { auditedOperation, auditSecurity } from "./audit.js";
import type { ResolvedConfig } from "./config.js";
import { requireEntity, type ServiceContext } from "./context.js";
import { reportCoverage } from "./coverage.js";
import {
  type FixtureImportInput,
  type FixtureImportReceipt,
  importFixtureInput,
} from "./input-fixtures.js";
import type { RunsService } from "./runs.js";
import { sumTimings } from "./timing.js";
export class EvidenceUnavailableError extends ContractError {
  constructor(
    readonly reason: "missing" | "expired",
    runId: string,
  ) {
    super("PRECONDITION_FAILED", `Run evidence is ${reason}`, { runId, reason });
  }
}
export function isEvidenceUnavailable(
  error: unknown,
): error is EvidenceUnavailableError | BundleIntegrityError {
  return error instanceof EvidenceUnavailableError || error instanceof BundleIntegrityError;
}
export interface EvidenceBundle {
  bundleDir: string;
  sourceBundleDir?: string;
  manifest: ArtifactManifest;
  meta: BundleMeta;
}
export interface SanitizedExport {
  manifestPath: string;
  omitted: { relativePath: string; reason: string }[];
  sourceSnapshotId: string;
  sourceManifestHash: string;
}
export interface ArtifactStream {
  entry: ArtifactManifest["entries"][number];
  stream: AsyncIterable<Uint8Array>;
}
export class ArtifactsService {
  constructor(
    readonly ctx: ServiceContext,
    readonly config: ResolvedConfig,
    readonly runs: RunsService,
  ) {}
  importFixtureInput(input: FixtureImportInput): Promise<FixtureImportReceipt> {
    return importFixtureInput(this.ctx, this.config, input);
  }
  private assertReadable(artifactId: string): void {
    const artifact = requireEntity(this.ctx, "Artifact", artifactId);
    const run = this.runs.get(String(artifact.runId));
    this.ctx.authorize("R", String(requireEntity(this.ctx, "TestCase", run.testId).projectId));
    if (
      artifact.state === "expired" ||
      this.ctx.database.get(
        "SELECT 1 FROM operational_state WHERE key=?",
        `retention:artifact:${this.ctx.workspaceId}:${artifactId}`,
      )
    )
      throw new ContractError("NOT_FOUND", "Artifact access revoked");
  }
  private authorizeRaw(runId: string, explicit: boolean, approvalId?: string): void {
    try {
      if (!explicit)
        throw new ContractError("FORBIDDEN", "Restricted raw evidence requires explicit --raw");
      const run = this.runs.get(runId);
      const test = requireEntity(this.ctx, "TestCase", run.testId);
      const environment = requireEntity(this.ctx, "EnvironmentRevision", run.environmentRevisionId);
      const row = this.ctx.database.get(
        "SELECT environment_id FROM environment_revisions WHERE workspace_id=? AND id=?",
        this.ctx.workspaceId,
        environment.id,
      );
      if (!row || !this.ctx.authorizeRaw)
        throw new ContractError("FORBIDDEN", "Raw authorization is unavailable");
      this.ctx.authorizeRaw(String(test.projectId), String(row.environment_id));
      if (environment.production) {
        const approval = approvalId ? requireEntity(this.ctx, "Approval", approvalId) : undefined;
        const revision = requireEntity(this.ctx, "TestRevision", run.revisionId);
        if (
          !approval ||
          approval.actorId !== this.ctx.principalId ||
          approval.revokedAt ||
          Date.parse(String(approval.expiresAt)) <= Date.now() ||
          approval.environmentRevisionId !== environment.id ||
          !(approval.actionSet as string[]).includes("artifacts:raw") ||
          approval.revisionHash !== revision.contentHash ||
          approval.policyHash !== this.config.effectiveConfig.policyHash ||
          semanticHash(approval.originSet) !== semanticHash(environment.targetOrigins)
        )
          throw new ContractError(
            "POLICY_DENIED",
            "Production raw evidence requires a matching current approval",
          );
      }
      auditSecurity(this.ctx, "artifact.raw", runId, "allowed");
    } catch (error) {
      auditSecurity(this.ctx, "artifact.raw", runId, "denied");
      throw error;
    }
  }
  async get(
    runId: string,
    options: {
      attemptId?: string;
      out?: string;
      failedOnly?: boolean;
      allowRestrictedRaw?: boolean;
      approvalId?: string;
    } = {},
  ): Promise<EvidenceBundle> {
    if (options.out)
      return auditedOperation(this.ctx, "artifact.export", runId, () =>
        this.getBundle(runId, options),
      );
    return this.getBundle(runId, options);
  }
  private async getBundle(
    runId: string,
    options: {
      attemptId?: string;
      out?: string;
      failedOnly?: boolean;
      allowRestrictedRaw?: boolean;
      approvalId?: string;
    } = {},
  ): Promise<EvidenceBundle> {
    const run = this.runs.get(runId);
    this.ctx.authorize("R", String(requireEntity(this.ctx, "TestCase", run.testId).projectId));
    const row = this.ctx.database.get(
      "SELECT * FROM snapshots WHERE workspace_id=? AND run_id=? AND (? IS NULL OR attempt_id=?) ORDER BY created_at DESC,id DESC LIMIT 1",
      this.ctx.workspaceId,
      runId,
      options.attemptId ?? null,
      options.attemptId ?? null,
    );
    if (!row) throw new EvidenceUnavailableError("missing", runId);
    const attemptId = String(row.attempt_id);
    const bundleDir = join(this.config.dataDir, "runs", this.ctx.workspaceId, runId, attemptId);
    const bundle = await verifyBundle(bundleDir, {
      workspaceId: this.ctx.workspaceId,
      runId,
      attemptId,
      revisionId: run.revisionId,
      snapshotId: String(row.id),
      manifestSha256: String(row.manifest_hash),
      expiredArtifactIds: this.ctx.database
        .all(
          "SELECT id FROM artifacts WHERE workspace_id=? AND snapshot_id=? AND state='expired'",
          this.ctx.workspaceId,
          row.id,
        )
        .map((artifact) => String(artifact.id)),
    }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
        throw new EvidenceUnavailableError("missing", runId);
      if (
        error instanceof UnsafePathError ||
        ["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "")
      )
        throw new BundleIntegrityError("Evidence path confinement failed");
      throw error;
    });
    let manifest = bundle.manifest;
    if (options.failedOnly) {
      const failed = this.runs.steps(runId, attemptId).filter((s) => s.status !== "passed");
      const paths = failed.flatMap((s) =>
        (s.evidenceRefs as { relativePath?: string }[])
          .map((ref) => ref.relativePath)
          .filter((path): path is string => Boolean(path)),
      );
      manifest = deriveFailedOnly(manifest, paths);
    }
    if (options.out) {
      const out = resolve(this.config.cwd, options.out);
      if (out === bundleDir || out.startsWith(`${bundleDir}/`))
        throw new ContractError("INVALID_ARGUMENT", "Output must not overwrite committed evidence");
      if (
        manifest.entries.some(
          (entry) => entry.state === "available" && entry.redactionStatus === "restrictedRaw",
        )
      )
        this.authorizeRaw(runId, options.allowRestrictedRaw === true, options.approvalId);
      await mkdir(out, { recursive: true, mode: 0o700 });
      for (const entry of manifest.entries) {
        if (entry.state !== "available") continue;
        this.assertReadable(entry.artifactId);
        const path = join(out, entry.relativePath);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const file = await open(path, "wx", 0o600);
        try {
          for await (const chunk of streamBundleArtifact(bundle, entry.relativePath, {
            allowRestrictedRaw: options.allowRestrictedRaw ?? false,
          })) {
            this.assertReadable(entry.artifactId);
            await file.write(chunk);
          }
        } finally {
          await file.close();
        }
      }
      await writeFile(join(out, "manifest.json"), JSON.stringify(manifest), {
        mode: 0o600,
        flag: "wx",
      });
      await writeFile(join(out, "meta.json"), JSON.stringify(bundle.meta), {
        mode: 0o600,
        flag: "wx",
      });
      return { bundleDir: out, sourceBundleDir: bundleDir, manifest, meta: bundle.meta };
    }
    return { bundleDir, manifest, meta: bundle.meta };
  }
  async exportSanitized(runId: string, outDir: string): Promise<SanitizedExport> {
    const bundle = await this.get(runId);
    const unavailable = bundle.manifest.entries.filter((entry) => entry.state !== "available");
    if (unavailable.length)
      throw new BundleIntegrityError(
        `Required evidence unavailable: ${unavailable.map((entry) => entry.relativePath).join(", ")}`,
      );
    const out = resolve(this.config.cwd, outDir);
    if (out === bundle.bundleDir || out.startsWith(`${bundle.bundleDir}/`))
      throw new ContractError("INVALID_ARGUMENT", "Export cannot overwrite committed evidence");
    await mkdir(dirname(out), { recursive: true, mode: 0o700 });
    const parent = new ConfinedRoot(dirname(out));
    const name = out.slice(dirname(out).length + 1);
    let root: ConfinedRoot | undefined;
    try {
      parent.mkdirExclusive(name);
      root = parent.openDirectory(name);
      const omitted = bundle.manifest.entries
        .filter((entry) => entry.redactionStatus === "restrictedRaw")
        .map((entry) => ({
          relativePath: entry.relativePath,
          reason: "restricted_raw_export_policy",
        }));
      const manifest = {
        ...bundle.manifest,
        exportPolicy: "sanitized",
        sourceSnapshotId: bundle.meta.snapshotId,
        sourceManifestHash: bundle.meta.manifestHash,
        entries: bundle.manifest.entries.map((entry) =>
          entry.redactionStatus === "restrictedRaw"
            ? { ...entry, state: "omitted", omissionReason: "restricted_raw_export_policy" }
            : entry,
        ),
      };
      for (const entry of bundle.manifest.entries) {
        if (entry.redactionStatus === "restrictedRaw") continue;
        this.assertReadable(entry.artifactId);
        const file = await root.openFile(entry.relativePath, true);
        try {
          for await (const chunk of streamBundleArtifact(
            { rootDir: bundle.bundleDir, manifest: bundle.manifest, meta: bundle.meta },
            entry.relativePath,
          )) {
            this.assertReadable(entry.artifactId);
            await file.write(chunk);
          }
        } finally {
          await file.close();
        }
      }
      const file = await root.openFile("manifest.json", true);
      try {
        await file.writeFile(JSON.stringify(manifest, null, 2));
        await file.sync();
      } finally {
        await file.close();
      }
      await root.sync();
      return {
        manifestPath: join(out, "manifest.json"),
        omitted,
        sourceSnapshotId: bundle.meta.snapshotId,
        sourceManifestHash: bundle.meta.manifestHash,
      };
    } finally {
      root?.close();
      parent.close();
    }
  }
  async read(
    runId: string,
    relativePath: string,
    options: { attemptId?: string; offset?: number; maxBytes?: number } = {},
  ) {
    const offset = options.offset ?? 0;
    const maxBytes = options.maxBytes ?? 65536;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 262144
    )
      throw new ContractError("INVALID_ARGUMENT", "Invalid artifact page bounds");
    const bundle = await this.get(runId, options.attemptId ? { attemptId: options.attemptId } : {});
    const entry = bundle.manifest.entries.find((item) => item.relativePath === relativePath);
    if (entry?.state !== "available")
      throw new ContractError("NOT_FOUND", "Artifact is unavailable");
    if (entry.redactionStatus === "restrictedRaw") {
      auditSecurity(this.ctx, "artifact.raw", "run-evidence", "denied");
      throw new ContractError("FORBIDDEN", "Restricted raw evidence is not exposed to MCP");
    }
    if (offset > entry.sizeBytes)
      throw new ContractError("INVALID_ARGUMENT", "Artifact offset exceeds its size");
    this.assertReadable(entry.artifactId);
    const bytes = Buffer.alloc(Math.min(maxBytes, entry.sizeBytes - offset));
    let position = 0;
    let written = 0;
    for await (const chunk of streamBundleArtifact(
      { rootDir: bundle.bundleDir, manifest: bundle.manifest, meta: bundle.meta },
      relativePath,
    )) {
      this.assertReadable(entry.artifactId);
      const start = Math.max(0, offset - position);
      const count = Math.min(chunk.length - start, bytes.length - written);
      if (count > 0) {
        bytes.set(chunk.subarray(start, start + count), written);
        written += count;
      }
      position += chunk.length;
      if (written === bytes.length) break;
    }
    return {
      bytes,
      entry,
      nextOffset: offset + written < entry.sizeBytes ? offset + written : null,
    };
  }
  async stream(
    artifactId: string,
    options: {
      range?: { start: number; end: number };
      allowRestrictedRaw?: boolean;
      approvalId?: string;
    } = {},
  ): Promise<ArtifactStream> {
    const artifact = requireEntity(this.ctx, "Artifact", artifactId);
    const attempt = requireEntity(this.ctx, "Attempt", String(artifact.attemptId));
    const bundle = await this.get(String(attempt.runId), { attemptId: attempt.id });
    const entry = bundle.manifest.entries.find((item) => item.artifactId === artifactId);
    if (entry?.state !== "available") throw new ContractError("NOT_FOUND", "Artifact unavailable");
    if (entry.redactionStatus === "restrictedRaw")
      this.authorizeRaw(
        String(attempt.runId),
        options.allowRestrictedRaw === true,
        options.approvalId,
      );
    const start = options.range?.start ?? 0;
    const end = options.range?.end ?? entry.sizeBytes - 1;
    if (
      options.range &&
      (!Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end >= entry.sizeBytes)
    )
      throw new ContractError("INVALID_ARGUMENT", "Invalid artifact range");
    const relativePath = entry.relativePath;
    const ctx = this.ctx;
    const runs = this.runs;
    async function* chunks() {
      const current = requireEntity(ctx, "Artifact", artifactId);
      runs.get(String(attempt.runId));
      ctx.authorize(
        "R",
        String(requireEntity(ctx, "TestCase", runs.get(String(attempt.runId)).testId).projectId),
      );
      if (
        current.state === "expired" ||
        ctx.database.get(
          "SELECT 1 FROM operational_state WHERE key=?",
          `retention:artifact:${ctx.workspaceId}:${artifactId}`,
        )
      )
        throw new ContractError("NOT_FOUND", "Artifact access revoked");
      let position = 0;
      for await (const chunk of streamBundleArtifact(
        { rootDir: bundle.bundleDir, manifest: bundle.manifest, meta: bundle.meta },
        relativePath,
        { allowRestrictedRaw: options.allowRestrictedRaw === true },
      )) {
        if (
          requireEntity(ctx, "Artifact", artifactId).state === "expired" ||
          ctx.database.get(
            "SELECT 1 FROM operational_state WHERE key=?",
            `retention:artifact:${ctx.workspaceId}:${artifactId}`,
          )
        )
          throw new ContractError("NOT_FOUND", "Artifact access revoked");
        const from = Math.max(0, start - position);
        const to = Math.min(chunk.length, end + 1 - position);
        if (to > from) yield chunk.subarray(from, to);
        position += chunk.length;
        if (position > end) break;
      }
    }
    return { entry, stream: chunks() };
  }
}
export class ReportsService {
  constructor(
    readonly ctx: ServiceContext,
    readonly config: ResolvedConfig,
    readonly runs: RunsService,
    readonly artifacts: ArtifactsService,
    readonly analysis?: Pick<AnalysisService, "get">,
  ) {}
  async snapshot(id: string): Promise<ReportSnapshot> {
    this.ctx.authorize("R");
    const batch = id.startsWith("bat_") ? requireEntity(this.ctx, "BatchRun", id) : null;
    const runIds = batch ? (batch.memberRuns as string[]) : [id];
    const entries: ReportRun[] = [];
    for (const runId of runIds) {
      const run = this.runs.get(runId);
      const test = requireEntity(this.ctx, "TestCase", run.testId);
      const environmentRow = this.ctx.database.get(
        "SELECT environment_id FROM environment_revisions WHERE workspace_id=? AND id=?",
        this.ctx.workspaceId,
        run.environmentRevisionId,
      );
      const environment = requireEntity(
        this.ctx,
        "Environment",
        String(environmentRow?.environment_id),
      );
      const freshnessReasons: ("test_revision_changed" | "environment_revision_changed")[] = [];
      if (test.activeRevisionId !== run.revisionId) freshnessReasons.push("test_revision_changed");
      if (environment.activeRevisionId !== run.environmentRevisionId)
        freshnessReasons.push("environment_revision_changed");
      this.ctx.authorize("R", String(test.projectId));
      let evidence: EvidenceBundle | null = null;
      const evidenceErrors: string[] = [];
      try {
        evidence = await this.artifacts.get(runId);
      } catch (error) {
        if (!isEvidenceUnavailable(error)) throw error;
        evidenceErrors.push(`${error.code}: ${error.message}`);
      }
      const attempts = this.ctx.database
        .all(
          "SELECT id FROM attempts WHERE workspace_id=? AND run_id=? ORDER BY number",
          this.ctx.workspaceId,
          runId,
        )
        .map((row) => requireEntity(this.ctx, "Attempt", String(row.id)) as unknown as Attempt);
      const reduced = this.runs.events(runId).findLast((e) => e.type === "run.reduced")?.payload as
        | Record<string, unknown>
        | undefined;
      const result: RunResult = {
        runId,
        phase: run.phase,
        outcome: run.outcome,
        status: run.status,
        gate: run.gate,
        cleanupOutcome: run.cleanupOutcome,
        analysisStatus: run.analysisStatus,
        passedOnRetry: Boolean(reduced?.passedOnRetry),
        firstAttemptOutcome: (reduced?.firstAttemptOutcome ??
          attempts[0]?.outcome ??
          null) as RunResult["firstAttemptOutcome"],
        ...(reduced?.reasonCode ? { reasonCode: String(reduced.reasonCode) } : {}),
      };
      const recordedTimings = this.runs
        .events(runId)
        .filter((event) => event.type === "attempt.timing")
        .map((event) => {
          const payload = event.payload as { timing: unknown };
          return validate<RuntimeTiming>("RuntimeTiming", payload.timing);
        });
      const timings = sumTimings(recordedTimings);
      const analysis = this.analysis?.get(runId);
      entries.push({
        run,
        result,
        title: String(test.name),
        projectId: String(test.projectId),
        environment: String((run.matrixCell as Record<string, unknown>).environmentName),
        ...(evidence
          ? {
              evidenceState: "committed" as const,
              snapshot: evidence.meta,
              manifest: evidence.manifest,
            }
          : {
              evidenceState: "unavailable" as const,
              snapshot: null,
              manifest: null,
              evidenceErrors,
            }),
        ...(analysis ? { analysis } : {}),
        ...(evidence?.manifest.reproduction
          ? {
              reproduction: {
                degree: "evidence-replay" as const,
                executionDegree:
                  evidence.manifest.reproduction.degree === "fresh-llm-regeneration"
                    ? ("fresh-llm-regeneration" as const)
                    : ("strict-execution-replay" as const),
                limitations: evidence.manifest.reproduction.limitations,
              },
            }
          : {}),
        steps: this.runs.steps(runId) as unknown as StepResult[],
        attempts,
        freshness: {
          state: freshnessReasons.length ? "stale" : "current",
          reasons: freshnessReasons,
          currentRevisionId: String(test.activeRevisionId),
          currentEnvironmentRevisionId: String(environment.activeRevisionId),
        },
        timings,
        durationMs: recordedTimings.length === attempts.length ? timings.executionDuration : null,
      });
    }
    const missing = entries.flatMap((entry) =>
      entry.evidenceState === "unavailable"
        ? [...entry.evidenceErrors]
        : entry.manifest.entries
            .filter((a) => a.state !== "available")
            .map((a) => a.omissionReason ?? a.state),
    );
    const snapshotId =
      entries[0]?.snapshot?.snapshotId ??
      `report:${semanticHash(entries.map((entry) => ({ runId: entry.run.id, result: entry.result, errors: entry.evidenceErrors })))}`;
    const selection = batch?.selectionSnapshot as Record<string, unknown> | undefined;
    const snapshot: ReportSnapshot = {
      schemaVersion: "1.0.0",
      committedAt: entries[0]?.snapshot?.committedAt ?? new Date().toISOString(),
      snapshotId,
      title: batch ? "Batch report" : (entries[0]?.title ?? "Empty selection"),
      runs: entries,
      selection: {
        requested: batch ? Number(batch.requestedCount) : 1,
        requestedRunIds: (selection?.requestedRunIds as string[] | undefined) ?? runIds,
        duplicates: Number(selection?.duplicates ?? 0),
        notDispatched: batch
          ? (batch.rejectedMembers as { memberKey: string; reasonCode: string }[])
          : [],
        excluded: [],
        allowEmpty: batch
          ? Boolean((batch.selectionSnapshot as Record<string, unknown>).allowEmpty)
          : false,
        ...(!entries.length ? { emptyReason: "Explicitly empty selection" } : {}),
      },
      completeness: { state: missing.length ? "partial" : "complete", reasons: missing },
    };
    snapshot.executionMetrics = executionMetrics(snapshot);
    snapshot.coverage = reportCoverage(this.ctx, snapshot);
    snapshot.executionMetrics.rates.requirementMappingCoverage = snapshot.coverage.requirement;
    snapshot.executionMetrics.rates.endpointContractCoverage = snapshot.coverage.operation;
    snapshot.executionMetrics.rates.verifiedRequirementCoverage = {
      ...snapshot.coverage.requirement,
      numerator: 0,
      value: snapshot.coverage.requirement.denominator ? 0 : null,
      definition:
        "N_inScopeRequirementsWithIndependentOracleAndFreshPassingEvidence / N_inScopeRequirements; no independent-oracle attestations recorded by current authoring surfaces",
    };
    return snapshot;
  }
  async export(
    id: string,
    format: "json" | "markdown" | "html" | "junit" | "allure",
    out?: string,
  ) {
    return auditedOperation(this.ctx, "report.export", id, async () => {
      const snapshot = await this.snapshot(id);
      return this.exportCaptured(snapshot, format, out);
    });
  }
  async exportCaptured(
    snapshot: ReportSnapshot,
    format: "json" | "markdown" | "html" | "junit" | "allure",
    out?: string,
  ) {
    this.ctx.authorize("R");
    for (const entry of snapshot.runs) {
      const run = this.runs.get(entry.run.id);
      this.ctx.authorize("R", String(requireEntity(this.ctx, "TestCase", run.testId).projectId));
    }
    let content: string | Record<string, string>;
    switch (format) {
      case "json":
        content = exportJson(snapshot);
        break;
      case "markdown":
        content = exportMarkdown(snapshot);
        break;
      case "html":
        content = exportHtml(snapshot);
        break;
      case "junit":
        content = exportJunit(snapshot);
        break;
      case "allure":
        content = exportAllure(snapshot);
        break;
      default:
        throw new ContractError("INVALID_ARGUMENT", "Unknown report format");
    }
    if (out) {
      const path = resolve(this.config.cwd, out);
      if (typeof content === "string") {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, content, { mode: 0o600 });
      } else {
        await mkdir(path, { recursive: true, mode: 0o700 });
        for (const [name, value] of Object.entries(content))
          await writeFile(join(path, name), value, { mode: 0o600 });
      }
      return {
        runId: snapshot.batch?.id ?? snapshot.runs[0]?.run.id ?? null,
        format,
        out: path,
        snapshotId: snapshot.snapshotId,
      };
    }
    return {
      runId: snapshot.batch?.id ?? snapshot.runs[0]?.run.id ?? null,
      format,
      content,
      snapshotId: snapshot.snapshotId,
    };
  }
}
