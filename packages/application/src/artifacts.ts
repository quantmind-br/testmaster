import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type ArtifactManifest,
  type Attempt,
  ContractError,
  type RunResult,
  type StepResult,
} from "@testmaster/contracts";
import { deriveFailedOnly, streamBundleArtifact, verifyBundle } from "@testmaster/evidence";
import {
  exportAllure,
  exportHtml,
  exportJson,
  exportJunit,
  exportMarkdown,
  type ReportRun,
  type ReportSnapshot,
} from "@testmaster/reporting";
import type { ResolvedConfig } from "./config.js";
import { requireEntity, type ServiceContext } from "./context.js";
import type { RunsService } from "./runs.js";
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
  async get(
    runId: string,
    options: {
      attemptId?: string;
      out?: string;
      failedOnly?: boolean;
      allowRestrictedRaw?: boolean;
    } = {},
  ) {
    const run = this.runs.get(runId);
    this.ctx.authorize("R", String(requireEntity(this.ctx, "TestCase", run.testId).projectId));
    const row = this.ctx.database.get(
      "SELECT * FROM snapshots WHERE workspace_id=? AND run_id=? AND (? IS NULL OR attempt_id=?) ORDER BY created_at DESC,id DESC LIMIT 1",
      this.ctx.workspaceId,
      runId,
      options.attemptId ?? null,
      options.attemptId ?? null,
    );
    if (!row)
      throw new ContractError("PRECONDITION_FAILED", "Run has no committed evidence", { runId });
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
        !options.allowRestrictedRaw &&
        manifest.entries.some(
          (entry) => entry.state === "available" && entry.redactionStatus === "restrictedRaw",
        )
      )
        throw new ContractError("FORBIDDEN", "Restricted raw evidence requires explicit --raw");
      await mkdir(out, { recursive: true, mode: 0o700 });
      for (const entry of manifest.entries) {
        if (entry.state !== "available") continue;
        const path = join(out, entry.relativePath);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const file = await open(path, "wx", 0o600);
        try {
          for await (const chunk of streamBundleArtifact(bundle, entry.relativePath, {
            allowRestrictedRaw: options.allowRestrictedRaw ?? false,
          }))
            await file.write(chunk);
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
    if (entry.redactionStatus === "restrictedRaw")
      throw new ContractError("FORBIDDEN", "Restricted raw evidence is not exposed to MCP");
    if (offset > entry.sizeBytes)
      throw new ContractError("INVALID_ARGUMENT", "Artifact offset exceeds its size");
    const bytes = Buffer.alloc(Math.min(maxBytes, entry.sizeBytes - offset));
    let position = 0;
    let written = 0;
    for await (const chunk of streamBundleArtifact(
      { rootDir: bundle.bundleDir, manifest: bundle.manifest, meta: bundle.meta },
      relativePath,
    )) {
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
    options: { range?: { start: number; end: number }; allowRestrictedRaw?: boolean } = {},
  ): Promise<ArtifactStream> {
    const artifact = requireEntity(this.ctx, "Artifact", artifactId);
    const attempt = requireEntity(this.ctx, "Attempt", String(artifact.attemptId));
    const bundle = await this.get(String(attempt.runId), { attemptId: attempt.id });
    const entry = bundle.manifest.entries.find((item) => item.artifactId === artifactId);
    if (entry?.state !== "available") throw new ContractError("NOT_FOUND", "Artifact unavailable");
    if (entry.redactionStatus === "restrictedRaw")
      throw new ContractError(
        "FORBIDDEN",
        "Restricted raw evidence requires separate authorization",
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
    async function* chunks() {
      let position = 0;
      for await (const chunk of streamBundleArtifact(
        { rootDir: bundle.bundleDir, manifest: bundle.manifest, meta: bundle.meta },
        relativePath,
      )) {
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
      const evidence = await this.artifacts.get(runId);
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
      entries.push({
        run,
        result,
        title: String(test.name),
        projectId: String(test.projectId),
        environment: String((run.matrixCell as Record<string, unknown>).environmentName),
        snapshot: evidence.meta,
        manifest: evidence.manifest,
        steps: this.runs.steps(runId) as unknown as StepResult[],
        attempts,
        freshness: {
          state: freshnessReasons.length ? "stale" : "current",
          reasons: freshnessReasons,
          currentRevisionId: String(test.activeRevisionId),
          currentEnvironmentRevisionId: String(environment.activeRevisionId),
        },
        durationMs: attempts.reduce(
          (total, attempt) =>
            total +
            (attempt.endedAt && attempt.startedAt
              ? Date.parse(attempt.endedAt) - Date.parse(attempt.startedAt)
              : 0),
          0,
        ),
      });
    }
    const missing = entries.flatMap((entry) =>
      entry.manifest.entries
        .filter((a) => a.state !== "available")
        .map((a) => a.omissionReason ?? a.state),
    );
    const snapshotId = entries[0]?.snapshot.snapshotId ?? id;
    return {
      schemaVersion: "1.0.0",
      committedAt: entries[0]?.snapshot.committedAt ?? new Date().toISOString(),
      snapshotId,
      title: batch ? "Batch report" : (entries[0]?.title ?? "Empty selection"),
      runs: entries,
      selection: {
        requested: batch ? Number(batch.requestedCount) : 1,
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
  }
  async export(
    id: string,
    format: "json" | "markdown" | "html" | "junit" | "allure",
    out?: string,
  ) {
    const snapshot = await this.snapshot(id);
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
      return { runId: id, format, out: path, snapshotId: snapshot.snapshotId };
    }
    return { runId: id, format, content, snapshotId: snapshot.snapshotId };
  }
}
