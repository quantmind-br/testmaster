import type { BatchReceipt } from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import { type ReportSnapshot, reportGate } from "@testmaster/reporting";
import type { Application } from "../../application.js";
import type { CiResult } from "../../ci.js";
import type { SelectionPreview } from "../../selection.js";
import type { StoredResult } from "./render.js";

interface FrozenAdmission {
  repository?: {
    binding?: string;
    bindingSource?: string;
    dirtyHash?: string | null;
    commitSha?: string | null;
    checkoutSha?: string | null;
    deploymentId?: string | null;
  };
}
/**
 * `github-deployment` binds the verdict to a commit only when every Run was admitted against the very
 * deployment the webhook named for that SHA, and ran against the origin of that deployment (INV-014).
 */
export function deploymentProvenance(
  snapshot: ReportSnapshot,
  previewOrigin: string | null,
): CiResult["provenance"] {
  const admissions = snapshot.runs.map((entry) => {
    const cell = entry.run.matrixCell as Record<string, unknown>;
    return {
      repository: (cell.admissionSnapshot as FrozenAdmission | undefined)?.repository,
      sameTarget: previewOrigin !== null && cell.baseUrl === previewOrigin,
    };
  });
  const first = admissions[0]?.repository;
  const verified = Boolean(
    first?.commitSha &&
      first.checkoutSha &&
      first.deploymentId &&
      admissions.every(
        (item) =>
          item.sameTarget &&
          item.repository?.binding === "verified" &&
          item.repository.bindingSource === "github-deployment" &&
          item.repository.dirtyHash === null &&
          item.repository.deploymentId === first.deploymentId &&
          item.repository.commitSha === first.commitSha &&
          item.repository.checkoutSha === first.checkoutSha,
      ),
  );
  return {
    assessedSha: first?.commitSha ?? null,
    checkoutSha: first?.checkoutSha ?? null,
    binding: verified ? "verified" : "unbound",
    targetBinding: verified ? "github-deployment" : "unbound",
  };
}

/**
 * The frozen verdict of one finished batch, in the same envelope the CLI publishes. There is no output
 * directory: a hosted verdict carries no local file paths.
 */
export async function storedResultForBatch(
  acting: Application,
  input: { batchId: string; previewUrl: string | null; environmentName: string; selection: string },
): Promise<StoredResult> {
  const snapshot = await acting.reports.snapshot(input.batchId);
  const batch = acting.batches.get(input.batchId);
  const selective = (batch.selectionSnapshot as { selective?: { preview?: SelectionPreview } })
    .selective?.preview;
  const aggregate = batch.aggregate as { counts: BatchReceipt["counts"] };
  const previewOrigin = input.previewUrl ? new URL(input.previewUrl).origin : null;
  if (snapshot.runs.length) snapshot.provenance = deploymentProvenance(snapshot, previewOrigin);
  const gate = reportGate(snapshot);
  const ci: CiResult = {
    schemaVersion: "1.0.0",
    kind: snapshot.runs.length ? "batch" : "empty",
    batchId: input.batchId,
    gate,
    exitCode: gate === "passed" || gate === "not_applicable" ? 0 : 1,
    counts: aggregate.counts,
    provenance: snapshot.provenance ?? {
      assessedSha: null,
      checkoutSha: null,
      binding: "unbound",
      targetBinding: "unbound",
    },
    selection: {
      requested: selective?.requested.length ?? snapshot.selection.requested,
      excluded: (selective?.excluded ?? []).map(({ testId, reason, owner, expiresAt }) => ({
        testId,
        reason,
        owner,
        expiresAt,
      })),
      emptyReason: null,
      quarantinePolicy: "exclude",
    },
    outputs: { report: null, junit: null, summary: null, bundleIndex: null },
    bundles: [],
    reportHash: semanticHash(snapshot),
    error: null,
  };
  return {
    ci,
    runs: snapshot.runs.map((entry) => ({
      id: entry.run.id,
      outcome: entry.result.outcome ?? null,
      gate: entry.result.gate,
    })),
    environmentName: input.environmentName,
    selection: input.selection,
    completedAt: new Date().toISOString(),
  };
}
