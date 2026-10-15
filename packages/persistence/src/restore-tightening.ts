import type { PersistenceDatabase, SqlRow } from "./database.js";

/**
 * Post-backup facts a restore replays so it can only tighten access: revocations, approval
 * withdrawals, retention tombstones and deletion decisions made after the snapshot.
 */
export interface RestoreTighteningOptions {
  revocations?: SqlRow[];
  tombstones?: SqlRow[];
  /** Approval rows revoked in the live ledger after the backup was taken. */
  approvalRevocations?: SqlRow[];
  /** False when the caller could not read the post-backup ledger; the restore stays suspended and says so. */
  ledgerAvailable?: boolean;
  /** Whether every evidence object the backup indexed was captured. */
  evidenceComplete: boolean;
}

const upsertState =
  "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value";

/**
 * Applies the restore invariants to a freshly restored database, on either engine. Runs inside the
 * caller's transaction so a server restore can finalize (drop its pending marker) atomically with it.
 *
 * Restored state starts isolated: admission suspended, workers offline, leases and outbox
 * undispatchable, bearer tokens and sessions dropped, signing keys revoked, integrations paused and
 * `restore:isolated` set. A revoked integration stays revoked.
 */
export function applyRestoreTightening(
  restored: PersistenceDatabase,
  options: RestoreTighteningOptions,
): void {
  const ledgerAvailable = options.ledgerAvailable !== false;
  for (const current of options.revocations ?? []) {
    const row = restored.get(
      "SELECT data_json FROM secret_references WHERE workspace_id=? AND id=?",
      current.workspace_id,
      current.id,
    );
    if (!row) continue;
    const reference = JSON.parse(String(row.data_json)) as Record<string, unknown>;
    if (!current.revoked_at && Number(current.secret_version) <= Number(reference.secretVersion))
      continue;
    const revokedAt = current.revoked_at ?? new Date().toISOString();
    reference.revokedAt = revokedAt;
    reference.version = Number(reference.version ?? 1) + 1;
    restored.run(
      "UPDATE secret_references SET revoked_at=?,data_json=?,version=version+1 WHERE workspace_id=? AND id=?",
      revokedAt,
      JSON.stringify(reference),
      current.workspace_id,
      current.id,
    );
  }
  const revokedNow = new Date().toISOString();
  for (const current of options.approvalRevocations ?? []) {
    const row = restored.get(
      "SELECT data_json FROM approvals WHERE workspace_id=? AND id=? AND revoked_at IS NULL",
      current.workspace_id,
      current.id,
    );
    if (!row) continue;
    const approval = JSON.parse(String(row.data_json)) as Record<string, unknown>;
    const revokedAt = current.revoked_at ?? revokedNow;
    approval.revokedAt = revokedAt;
    approval.version = Number(approval.version ?? 1) + 1;
    restored.run(
      "UPDATE approvals SET revoked_at=?,data_json=?,version=version+1 WHERE workspace_id=? AND id=? AND revoked_at IS NULL",
      revokedAt,
      JSON.stringify(approval),
      current.workspace_id,
      current.id,
    );
  }
  for (const tombstone of options.tombstones ?? []) {
    restored.run(upsertState, tombstone.key, tombstone.value);
    const match = /^retention:artifact:(ws_[0-9a-f-]+):(art_[0-9a-f-]+)$/.exec(
      String(tombstone.key),
    );
    if (match) {
      const retention = JSON.parse(String(tombstone.value)) as { stage?: string };
      if (["marked", "tombstoned", "deleted"].includes(retention.stage ?? ""))
        restored.run(
          "UPDATE artifacts SET state='expired',version=version+1 WHERE workspace_id=? AND id=? AND state<>'expired'",
          match[1],
          match[2],
        );
    }
  }
  restored.run("UPDATE workers SET state='offline',last_heartbeat_at=?", new Date(0).toISOString());
  restored.run("UPDATE operational_state SET value='suspended_restore' WHERE key='admission'");
  restored.run(
    upsertState,
    "restore_review",
    ledgerAvailable
      ? "post_backup_revocations_and_tombstones_unverified"
      : "post_backup_ledger_unavailable",
  );
  restored.run(upsertState, "restore:evidence-complete", String(options.evidenceComplete));
  // Schedules, integrations and every notification channel start inactive until an admin re-enables them.
  restored.run(upsertState, "restore:isolated", "true");
  if (restored.tableExists("integrations"))
    restored.run("UPDATE integrations SET state='paused',version=version+1 WHERE state='active'");
  restored.run(
    "UPDATE job_leases SET dispatchable=0,state=CASE WHEN state IN ('leased','queued') THEN 'reconciliation_required' ELSE state END,lease_owner=NULL,lease_expires_at=NULL,fence=fence+1",
  );
  restored.run("UPDATE outbox SET dispatchable=0");
  restored.run("DELETE FROM server_tokens");
  // Backups taken before migration 10 have no session table.
  if (restored.tableExists("sessions")) restored.run("DELETE FROM sessions");
  restored.run("UPDATE cursor_signing_keys SET revoked_at=?", new Date().toISOString());
}
