import type { DependencyBinding } from "@testmaster/contracts";
import type { ServiceContext } from "./context.js";

interface CaptureRow {
  secret_id: string;
  test_id: string;
  name: string;
  created_at: string;
}

/**
 * A sensitive capture is released once nothing can read it again:
 * - its producer Run and every member of its batch have completed (the batch's dependents);
 * - its reuse window has passed: an active consumer whose `dependsOn` names the producer test and
 *   output may reuse it explicitly (`test rerun --reuse-from-run`) for that binding's
 *   `maximumAge` after the capture, so the longest such window keeps it alive;
 * - every resource the producer created is `cleaned`. A live fixture may still be reused and its
 *   manual compensation replays the protected `handle` capture; the erasure follows the cleanup.
 * A capture still stored in the host keyring (written before captures moved to the vault) is
 * listed the same way so that its erasure also clears the keyring entry.
 */
export function erasableCaptureSecretIds(ctx: ServiceContext): string[] {
  const rows = ctx.database.all<CaptureRow>(
    `SELECT DISTINCT v.encrypted_value_ref AS secret_id, r.test_id, v.name, v.created_at
     FROM variables v
     JOIN runs r ON r.workspace_id=v.workspace_id AND r.id=v.producer_run_id
     JOIN secret_references s ON s.workspace_id=v.workspace_id AND s.id=v.encrypted_value_ref
     WHERE v.workspace_id=? AND v.taint='sensitive' AND s.revoked_at IS NULL
       AND s.provider IN ('vault','secret-tool') AND s.locator LIKE 'capture-%'
       AND r.phase='completed'
       AND (v.batch_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM runs mr
         WHERE mr.workspace_id=v.workspace_id AND mr.batch_id=v.batch_id
           AND mr.phase<>'completed'))
       AND NOT EXISTS (
         SELECT 1 FROM resources res
         JOIN attempts a ON a.workspace_id=res.workspace_id AND a.id=res.creator_attempt_id
         WHERE res.workspace_id=v.workspace_id AND a.run_id=v.producer_run_id
           AND res.state<>'cleaned')`,
    ctx.workspaceId,
  );
  if (rows.length === 0) return [];
  const windows = reuseWindows(ctx);
  const now = Date.now();
  return rows
    .filter((row) => {
      const created = Date.parse(row.created_at);
      const window = windows.get(outputKey(row.test_id, row.name)) ?? 0;
      // A capture without a valid time can never pass the reuse age check.
      return !Number.isFinite(created) || created + window <= now;
    })
    .map((row) => row.secret_id);
}

function outputKey(producerTestId: string, outputName: string): string {
  return `${producerTestId}\u0000${outputName}`;
}

/** The longest sensitive reuse window of each producer output among active, unarchived tests. */
function reuseWindows(ctx: ServiceContext): Map<string, number> {
  const windows = new Map<string, number>();
  // Only revisions that declare a dependency are parsed.
  const revisions = ctx.database.all<{ data_json: string }>(
    `SELECT r.data_json FROM tests t
     JOIN test_revisions r ON r.workspace_id=t.workspace_id AND r.id=t.active_revision_id
     WHERE t.workspace_id=? AND t.archived_at IS NULL AND r.data_json LIKE '%"producerTestId"%'`,
    ctx.workspaceId,
  );
  for (const revision of revisions) {
    const document = JSON.parse(revision.data_json) as {
      plan?: { dependsOn?: DependencyBinding[] } | null;
    };
    for (const binding of document.plan?.dependsOn ?? []) {
      if (!binding.sensitive) continue;
      const key = outputKey(binding.producerTestId, binding.outputName);
      windows.set(key, Math.max(windows.get(key) ?? 0, binding.maximumAge));
    }
  }
  return windows;
}
