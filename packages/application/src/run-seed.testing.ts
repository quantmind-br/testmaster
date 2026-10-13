import { uuidV7IdGenerator } from "@testmaster/domain";
import { FileEvidenceStore } from "@testmaster/evidence";
import {
  type EntityDocument,
  ExecutionRepository,
  OutboxRepository,
} from "@testmaster/persistence";
import type { Application } from "./application.js";

/**
 * Test-only: drives a real admitted Run through the same persistence repositories the worker
 * uses (lease claim, phase progress, step publication, finalization, outbox events) without
 * starting a sandbox. Nothing here fabricates a verdict the caller did not ask for; the caller
 * states every outcome explicitly.
 */
export type SeedOutcome = "passed" | "failed" | "inconclusive" | "blocked";
export interface SeedArtifact {
  relativePath: string;
  kind: string;
  mimeType: string;
  body: string | Uint8Array;
  restricted?: boolean;
}
export interface SeedStep {
  stepId: string;
  status: SeedOutcome;
  reasonCode?: string;
  durationMs?: number;
  expected?: unknown;
  observed?: unknown;
  /** Relative paths of seeded artifacts this step references. */
  evidence?: readonly string[];
}
export interface SeedAttempt {
  outcome: SeedOutcome;
  steps?: readonly SeedStep[];
  artifacts?: readonly SeedArtifact[];
  /** Ends the Attempt the way a lost worker does: lease expiry, no verdict. */
  leaseExpired?: boolean;
}
export interface SeedRunOptions {
  testId: string;
  environmentId: string;
  attempts: readonly SeedAttempt[];
  /** Leave the Run non-terminal after the last Attempt's steps (live-progress fixtures). */
  complete?: boolean;
  gate?: "passed" | "failed" | "pending";
  cleanupOutcome?: "not_required" | "passed" | "failed" | "inconclusive";
  batchId?: string | null;
  mode?: "replay" | "explore";
  request?: Record<string, unknown>;
}
export interface SeededArtifact {
  id: string;
  attemptId: string;
  relativePath: string;
  kind: string;
  sha256: string;
  sizeBytes: number;
}
export interface SeededRun {
  runId: string;
  attemptIds: string[];
  artifacts: SeededArtifact[];
}

export async function seedRun(app: Application, options: SeedRunOptions): Promise<SeededRun> {
  const workspaceId = app.context.workspaceId;
  const previousPreflight = app.preflight;
  app.preflight = async () => {};
  const receipt = await app.runs
    .admit(
      {
        testId: options.testId,
        environmentId: options.environmentId,
        ...(options.mode ? { mode: options.mode } : {}),
        ...options.request,
      } as Parameters<typeof app.runs.admit>[0],
      { wait: true },
    )
    .finally(() => {
      app.preflight = previousPreflight;
    });
  const runId = receipt.runId;
  const database = app.database;
  const execution = new ExecutionRepository(database);
  const outbox = new OutboxRepository(database);
  const emit = (type: string, payload: Record<string, unknown>) =>
    database.withTx(() => outbox.append(workspaceId, runId, type, payload));
  const evidence = new FileEvidenceStore({ rootDir: app.config.dataDir });
  const seeded: SeededRun = { runId, attemptIds: [], artifacts: [] };
  let run = app.runs.get(runId);
  for (const [index, attempt] of options.attempts.entries()) {
    const last = index === options.attempts.length - 1;
    const fence = execution.leases.claim({
      workspaceId,
      owner: "seed-worker",
      queue: "local",
      leaseMs: 600_000,
      runIds: [runId],
    });
    if (!fence) throw new Error("The admitted Run must be claimable");
    seeded.attemptIds.push(fence.attemptId);
    execution.progress(fence, "preparing");
    const snapshotId = uuidV7IdGenerator.next("snp");
    execution.progress(fence, "running");
    emit("run.snapshot_sealed", { attemptId: fence.attemptId, snapshotId });
    emit("attempt.runner_started", { attemptId: fence.attemptId });
    for (const [stepIndex, step] of (attempt.steps ?? []).entries()) {
      emit("step.started", { attemptId: fence.attemptId, stepId: step.stepId, index: stepIndex });
      execution.publish(fence, "StepResult", {
        id: uuidV7IdGenerator.next("stp"),
        workspaceId,
        createdAt: new Date().toISOString(),
        version: 1,
        attemptId: fence.attemptId,
        planStepId: step.stepId,
        index: stepIndex,
        status: step.status,
        ...(step.reasonCode ? { reasonCode: step.reasonCode } : {}),
        expected: step.expected ?? null,
        observed: step.observed ?? null,
        error: null,
        durationMs: step.durationMs ?? 12,
        evidenceRefs: (step.evidence ?? []).map((relativePath) => ({ relativePath, snapshotId })),
      } as unknown as EntityDocument);
      emit("step.finished", {
        attemptId: fence.attemptId,
        stepId: step.stepId,
        index: stepIndex,
        status: step.status,
        ...(step.reasonCode ? { reasonCode: step.reasonCode } : {}),
        durationMs: step.durationMs ?? 12,
        evidencePaths: step.evidence ?? [],
      });
    }
    if (attempt.artifacts?.length) {
      execution.progress(fence, "collecting");
      const stage = await evidence.openAttempt({
        workspaceId,
        runId,
        attemptId: fence.attemptId,
        revisionId: String(run.revisionId),
        snapshotId,
      });
      const entries = [];
      for (const artifact of attempt.artifacts) {
        const writer = await stage.beginArtifact({
          relativePath: artifact.relativePath,
          kind: artifact.kind,
          mimeType: artifact.mimeType,
          ...(artifact.restricted ? { sensitivity: "restricted" as const } : {}),
        });
        await writer.write(
          typeof artifact.body === "string" ? Buffer.from(artifact.body) : artifact.body,
        );
        entries.push(await writer.end());
      }
      const committed = await stage.commit({ redactionPolicyHash: "0".repeat(64) });
      const now = new Date().toISOString();
      execution.publish(fence, "Snapshot", {
        id: snapshotId,
        workspaceId,
        createdAt: now,
        runId,
        attemptId: fence.attemptId,
        revisionId: String(run.revisionId),
        manifestHash: committed.manifestSha256,
        committedAt: now,
        redactionPolicyHash: "0".repeat(64),
      } as unknown as EntityDocument);
      for (const entry of entries) {
        execution.publish(fence, "Artifact", {
          id: entry.artifactId,
          workspaceId,
          createdAt: now,
          runId,
          attemptId: fence.attemptId,
          revisionId: String(run.revisionId),
          snapshotId,
          kind: entry.kind,
          hash: entry.sha256,
          bytes: entry.sizeBytes,
          mime: entry.mimeType,
          redactionStatus: entry.redactionStatus,
          storageKey: `runs/${workspaceId}/${runId}/${fence.attemptId}/${entry.relativePath}`,
          state: entry.state,
        } as unknown as EntityDocument);
        seeded.artifacts.push({
          id: entry.artifactId,
          attemptId: fence.attemptId,
          relativePath: entry.relativePath,
          kind: entry.kind,
          sha256: String(entry.sha256),
          sizeBytes: entry.sizeBytes,
        });
      }
      emit("cleanup.finished", { attemptId: fence.attemptId });
    }
    if (last && options.complete === false) return seeded;
    if (attempt.leaseExpired) {
      database.run(
        "UPDATE job_leases SET lease_expires_at=? WHERE workspace_id=? AND id=?",
        "2000-01-01T00:00:00.000Z",
        workspaceId,
        fence.jobId,
      );
      execution.leases.expire();
      if (!last)
        database.run(
          "UPDATE job_leases SET state='queued',lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=? AND id=?",
          workspaceId,
          fence.jobId,
        );
      continue;
    }
    if (!last) {
      database.run(
        "UPDATE attempts SET phase='completed',outcome=?,ended_at=? WHERE workspace_id=? AND id=?",
        attempt.outcome,
        new Date().toISOString(),
        workspaceId,
        fence.attemptId,
      );
      database.run(
        "UPDATE job_leases SET state='queued',lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=? AND id=?",
        workspaceId,
        fence.jobId,
      );
      continue;
    }
    run = app.runs.get(runId);
    execution.finalize(fence, {
      ...run,
      phase: "completed",
      status: attempt.outcome,
      outcome: attempt.outcome,
      gate: options.gate ?? (attempt.outcome === "passed" ? "passed" : "failed"),
      cleanupOutcome: options.cleanupOutcome ?? "not_required",
      analysisStatus: "not_requested",
    });
    emit("run.reduced", { outcome: attempt.outcome });
  }
  return seeded;
}
