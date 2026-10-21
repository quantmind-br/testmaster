import { randomUUID } from "node:crypto";
import { ContractError } from "@testmaster/contracts";
import type { Application } from "./application.js";
import { readKeyFile } from "./backup-crypto.js";
import { type Controller, ControllerRegistry } from "./controllers.js";
import { stateJson } from "./operations.js";
import {
  applyServerBackupRetention,
  backupSettings,
  createServerBackup,
  listServerBackups,
  verifyServerBackup,
} from "./server-backup.js";
import type { ServerConfig } from "./server-config.js";

/** Controllers that run inside the server process; none of them can read the backup key. */
const staleRunningMs = 2 * 3_600_000;
const scheduleIntervalMs = 24 * 3_600_000;
const scheduleRetryMs = 3_600_000;

function workspaceIds(scope: Application): string[] {
  return scope.database
    .all<{ id: string }>("SELECT id FROM workspaces ORDER BY created_at")
    .map((row) => row.id);
}

export const alertsController: Controller = {
  name: "alerts",
  intervalMs: 60_000,
  async run(scope) {
    for (const id of workspaceIds(scope)) {
      const workspace = scope.forWorkspaceSystem(id);
      if (workspace.operations.isolated()) continue;
      await workspace.alerts.evaluate();
    }
  },
};

export const retentionController: Controller = {
  name: "retention-purge",
  intervalMs: 3_600_000,
  async run(scope) {
    for (const id of workspaceIds(scope)) {
      const workspace = scope.forWorkspaceSystem(id);
      if (workspace.operations.isolated()) continue;
      await workspace.retentionPurge.run();
    }
  },
};

/**
 * Expires the leases of lost workers and settles their Runs. A remote worker has no database to
 * do this itself, so the server process runs it for every pool (ADR-030).
 */
export const leaseReconcilerController: Controller = {
  name: "lease-reconciler",
  intervalMs: 5_000,
  async run(scope) {
    for (const id of workspaceIds(scope)) {
      const workspace = scope.systemScope(id);
      if (workspace.operations.isolated()) continue;
      workspace.worker.settleLeases();
    }
    await scope.remoteWorkers.sweep();
  },
};

/** Registers the loops the server process runs (alerts, retention and lease reconciliation). */
export function registerOperationsControllers(registry: ControllerRegistry): void {
  registry.register(alertsController);
  registry.register(retentionController);
  registry.register(leaseReconcilerController);
}

interface PendingOperation {
  id: string;
  kind: "backup" | "restore_verify";
  data_json: string;
}

/**
 * Claims and fulfils queued backup requests. Only the backup agent calls this: it needs the backup
 * key and the backup destination, which the server process must not be able to read or write.
 */
export async function fulfilBackupRequests(
  scope: Application,
  server: ServerConfig,
  options: { now?: () => Date } = {},
): Promise<{ completed: string[]; failed: string[] }> {
  const database = scope.database;
  const now = options.now ?? (() => new Date());
  const outcome = { completed: [] as string[], failed: [] as string[] };
  for (const stale of database.all<{ id: string }>(
    "SELECT id FROM admin_operations WHERE kind IN ('backup','restore_verify') AND state='running' AND started_at<?",
    new Date(now().getTime() - staleRunningMs).toISOString(),
  ))
    finish(scope, stale.id, "failed", {
      error: { code: "UNAVAILABLE", message: "Backup agent stopped before finishing" },
    });
  for (;;) {
    const next = database.get<PendingOperation>(
      "SELECT id,kind,data_json FROM admin_operations WHERE kind IN ('backup','restore_verify') AND state='requested' ORDER BY created_at,id LIMIT 1",
    );
    if (!next) return outcome;
    const claimed = database.run(
      "UPDATE admin_operations SET state='running',started_at=?,version=version+1 WHERE id=? AND state='requested'",
      now().toISOString(),
      next.id,
    ).changes;
    if (!claimed) continue;
    try {
      const params = JSON.parse(next.data_json).params ?? {};
      if (next.kind === "backup") {
        const result = await createServerBackup({ database, server, now });
        finish(scope, next.id, "completed", {
          result: {
            backupId: result.backupId,
            evidenceComplete: result.evidenceComplete,
            missingObjects: result.missingObjects.length,
          },
        });
      } else {
        const key = await readKeyFile(server.security.backupKeyFile, "security.backupKeyFile");
        const listing = (await listServerBackups(backupSettings(server).destination, key)).find(
          (candidate) => candidate.backupId === params.backupId,
        );
        if (!listing)
          throw new ContractError("NOT_FOUND", "Backup does not exist", {
            backupId: params.backupId,
          });
        const report = await verifyServerBackup(listing.directory, server);
        finish(scope, next.id, "completed", { result: JSON.parse(JSON.stringify(report)) });
      }
      outcome.completed.push(next.id);
    } catch (error) {
      finish(scope, next.id, "failed", {
        error: {
          code: error instanceof ContractError ? error.code : "INTERNAL",
          message: error instanceof Error ? error.message.slice(0, 500) : "Backup failed",
        },
      });
      outcome.failed.push(next.id);
    }
  }
}

function finish(
  scope: Application,
  id: string,
  state: "completed" | "failed",
  update: { result?: unknown; error?: { code: string; message: string } },
): void {
  const database = scope.database;
  database.withTx(() => {
    const row = database.get("SELECT data_json FROM admin_operations WHERE id=?", id);
    if (!row) return;
    const data = JSON.parse(String(row.data_json));
    database.run(
      "UPDATE admin_operations SET state=?,finished_at=?,version=version+1,data_json=? WHERE id=?",
      state,
      new Date().toISOString(),
      JSON.stringify({ ...data, result: update.result ?? {}, error: update.error ?? null }),
      id,
    );
  });
}

/** Queues one scheduled backup when the newest success is older than a day and none is pending. */
export function scheduleBackup(
  scope: Application,
  server: ServerConfig,
  now: Date = new Date(),
): string | null {
  const settings = backupSettings(server);
  if (settings.schedule === "disabled") return null;
  const database = scope.database;
  const last = stateJson<{ at?: string }>(database, "backup:last-success")?.at;
  if (last && now.getTime() - Date.parse(last) < scheduleIntervalMs) return null;
  const recent = database.get(
    "SELECT 1 FROM admin_operations WHERE kind='backup' AND (state IN ('requested','running') OR created_at>?)",
    new Date(now.getTime() - scheduleRetryMs).toISOString(),
  );
  if (recent) return null;
  const id = `opr_${randomUUID()}`;
  database.run(
    "INSERT INTO admin_operations(id,workspace_id,created_at,data_json,kind,state,requested_by) VALUES(?,NULL,?,?,'backup','requested','system:backup-schedule')",
    id,
    now.toISOString(),
    JSON.stringify({ reason: "scheduled daily backup", params: {}, result: {}, error: null }),
  );
  return id;
}

/** The loops of `testmaster backup agent`: fulfil requests, schedule dailies, apply backup retention. */
export function backupAgentRegistry(server: ServerConfig): ControllerRegistry {
  const registry = new ControllerRegistry();
  registry.register({
    name: "backup-fulfil",
    intervalMs: 5_000,
    async run(scope) {
      await fulfilBackupRequests(scope, server);
    },
  });
  registry.register({
    name: "backup-schedule",
    intervalMs: 300_000,
    run(scope) {
      scheduleBackup(scope, server);
    },
  });
  registry.register({
    name: "backup-retention",
    intervalMs: 3_600_000,
    async run() {
      await applyServerBackupRetention(server);
    },
  });
  return registry;
}
