import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ContractError } from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import {
  AuditRepository,
  type BackupManifest,
  EntityRepository,
  OutboxRepository,
  PersistenceDatabase,
} from "@testmaster/persistence";
import type { ResolvedConfig } from "./config.js";
import type { ServiceContext } from "./context.js";
import type { SecretsService } from "./secrets.js";
export class BackupsService {
  constructor(
    readonly ctx: ServiceContext,
    readonly config: ResolvedConfig,
    readonly secrets?: SecretsService,
  ) {}
  private alert(reasonCode: string, details: Record<string, unknown>): void {
    this.ctx.database.withTx(() => {
      this.ctx.database.run(
        "INSERT INTO operational_state(key,value) VALUES('backup:last-warning',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        JSON.stringify({ reasonCode, ...details, observedAt: new Date().toISOString() }),
      );
      new OutboxRepository(this.ctx.database).append(
        this.ctx.workspaceId,
        this.ctx.workspaceId,
        "backup.failed",
        { reasonCode, ...details },
      );
    });
  }
  async create(out: string): Promise<BackupManifest> {
    this.ctx.authorize("A");
    const destination = resolve(this.config.cwd, out);
    const backupId = randomUUID();
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    this.ctx.database.withTx(() => {
      for (const artifact of this.ctx.database.all(
        "SELECT id FROM artifacts WHERE workspace_id=? AND state='available'",
        this.ctx.workspaceId,
      ))
        this.ctx.database.run(
          "INSERT INTO backup_object_holds(workspace_id,artifact_id,backup_id,expires_at) VALUES(?,?,?,?)",
          this.ctx.workspaceId,
          artifact.id,
          backupId,
          expiresAt,
        );
      for (const fixture of this.ctx.database.all(
        "SELECT id FROM fixture_inputs WHERE workspace_id=?",
        this.ctx.workspaceId,
      )) {
        this.ctx.database.run(
          "INSERT INTO operational_state(key,value) VALUES(?,?)",
          `retention:fixture-backup:${this.ctx.workspaceId}:${fixture.id}:${backupId}`,
          expiresAt,
        );
      }
    });
    try {
      const vault = this.ctx.database.get(
        "SELECT 1 FROM secret_references WHERE workspace_id=? AND provider='vault' AND revoked_at IS NULL",
        this.ctx.workspaceId,
      );
      const keyIds = vault && this.secrets ? [(await this.secrets.keyStatus()).activeKeyId] : [];
      const manifest = await this.ctx.database.backup(destination, {
        evidenceRoot: this.config.dataDir,
        configDigests: [semanticHash(this.config.effectiveConfig)],
        keyIds,
      });
      const index = JSON.parse(
        await readFile(join(destination, "evidence-index.json"), "utf8"),
      ) as { complete: boolean; missingObjects: string[] };
      if (!index.complete)
        this.alert("artifact_unavailable", { missingObjects: index.missingObjects, backupId });
      return manifest;
    } catch (error) {
      this.alert("storage_unavailable", { backupId });
      throw error;
    }
  }
  async restore(path: string, out: string) {
    this.ctx.authorize("A");
    const source = resolve(this.config.cwd, path);
    const destination = resolve(this.config.cwd, out);
    const result = await PersistenceDatabase.restore(source, destination, {
      revocations: this.ctx.database.all(
        "SELECT workspace_id,id,secret_version,revoked_at FROM secret_references",
      ),
      tombstones: this.ctx.database.all(
        "SELECT key,value FROM operational_state WHERE key LIKE 'retention:%'",
      ),
    });
    result.database.withTx(() => {
      const restored = new EntityRepository(result.database);
      for (const row of this.ctx.database.all<{ data_json: string }>(
        "SELECT data_json FROM deletion_operations WHERE workspace_id=?",
        this.ctx.workspaceId,
      )) {
        const operation = JSON.parse(row.data_json);
        const previous = restored.get("DeletionOperation", this.ctx.workspaceId, operation.id);
        if (!previous) restored.insert("DeletionOperation", operation);
        else if (Number(previous.version) < Number(operation.version)) {
          restored.update(
            "DeletionOperation",
            this.ctx.workspaceId,
            operation.id,
            Number(previous.version),
            { ...operation, version: Number(previous.version) + 1 },
          );
        }
      }
    });
    try {
      try {
        await rename(join(destination, "evidence", "runs"), join(destination, "runs"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        await rename(
          join(destination, "evidence", "fixture-inputs"),
          join(destination, "fixture-inputs"),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return {
        out: destination,
        manifest: result.manifest,
        evidenceComplete: result.evidenceComplete,
        requiresOperatorReview: true,
      };
    } finally {
      result.database.close();
    }
  }
  review(
    options: {
      apply?: boolean;
      revocationsConfirmed?: boolean;
      incompleteEvidenceAccepted?: boolean;
    } = {},
  ) {
    this.ctx.authorize("A");
    const database = this.ctx.database;
    const admission = database.get(
      "SELECT value FROM operational_state WHERE key='admission'",
    )?.value;
    if (admission !== "suspended_restore")
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Only isolated restored storage can be reviewed",
      );
    const active = database
      .all("SELECT id FROM runs WHERE workspace_id=? AND phase<>'completed'", this.ctx.workspaceId)
      .map((row) => String(row.id));
    const missing = database
      .all(
        "SELECT id FROM artifacts WHERE workspace_id=? AND state IN ('missing','partial')",
        this.ctx.workspaceId,
      )
      .map((row) => String(row.id));
    const complete =
      database.get("SELECT value FROM operational_state WHERE key='restore:evidence-complete'")
        ?.value !== "false";
    if (
      options.apply &&
      (!options.revocationsConfirmed ||
        ((!complete || missing.length > 0) && !options.incompleteEvidenceAccepted))
    )
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Operator must confirm revocation reconciliation and incomplete evidence decision",
      );
    if (options.apply)
      database.withTx(() => {
        new AuditRepository(database).append({
          workspaceId: this.ctx.workspaceId,
          actor: this.ctx.principalId,
          action: "restore.review.approved",
          resourceId: this.ctx.workspaceId,
          requestId: randomUUID(),
          timestamp: new Date().toISOString(),
          beforeHash: semanticHash({ admission, active, missing }),
          afterHash: semanticHash(options),
        });
        database.run(
          "UPDATE operational_state SET value='enabled' WHERE key='admission' AND value='suspended_restore'",
        );
        database.run(
          "UPDATE operational_state SET value='operator_confirmed' WHERE key='restore_review'",
        );
        new OutboxRepository(database).append(
          this.ctx.workspaceId,
          this.ctx.workspaceId,
          "restore.review.approved",
          { actor: this.ctx.principalId, activeRunsRequireDecision: active },
        );
      });
    return {
      dryRun: !options.apply,
      activeRunsRequireDecision: active,
      missingArtifacts: missing,
      admission: options.apply ? "enabled" : admission,
    };
  }
  resumeRun(runId: string, apply = false) {
    this.ctx.authorize("A");
    const database = this.ctx.database;
    const job = database.get(
      "SELECT id,fence FROM job_leases WHERE workspace_id=? AND resource_id=? AND state='reconciliation_required' AND dispatchable=0",
      this.ctx.workspaceId,
      runId,
    );
    const run = database.get(
      "SELECT phase FROM runs WHERE workspace_id=? AND id=?",
      this.ctx.workspaceId,
      runId,
    );
    if (!job || run?.phase === "completed")
      throw new ContractError("PRECONDITION_FAILED", "Restore Run has no resumable in-flight job");
    const risk = database.get(
      "SELECT 1 FROM resources r JOIN attempts a ON a.workspace_id=r.workspace_id AND a.id=r.creator_attempt_id WHERE a.workspace_id=? AND a.run_id=? AND r.state NOT IN ('planned','cleaned')",
      this.ctx.workspaceId,
      runId,
    );
    if (risk)
      throw new ContractError(
        "POLICY_DENIED",
        "Restored Run has uncertain external effects; use a separately reviewed new Run",
      );
    if (apply)
      database.withTx(() => {
        if (
          database.get("SELECT value FROM operational_state WHERE key='restore_review'")?.value !==
          "operator_confirmed"
        )
          throw new ContractError("PRECONDITION_FAILED", "Restore review must be approved first");
        const changed = database.run(
          "UPDATE job_leases SET state='queued',dispatchable=1,available_at=?,fence=fence+1 WHERE workspace_id=? AND id=? AND fence=? AND state='reconciliation_required' AND dispatchable=0",
          new Date().toISOString(),
          this.ctx.workspaceId,
          job.id,
          job.fence,
        );
        if (!changed.changes)
          throw new ContractError("REVISION_CONFLICT", "Restore job decision changed");
        database.run(
          "UPDATE attempts SET phase='completed',outcome='inconclusive',ended_at=? WHERE workspace_id=? AND run_id=? AND phase<>'completed'",
          new Date().toISOString(),
          this.ctx.workspaceId,
          runId,
        );
        new AuditRepository(database).append({
          workspaceId: this.ctx.workspaceId,
          actor: this.ctx.principalId,
          action: "restore.run.resume",
          resourceId: runId,
          requestId: randomUUID(),
          timestamp: new Date().toISOString(),
          beforeHash: semanticHash(job),
          afterHash: semanticHash({ newAttemptRequired: true }),
        });
        new OutboxRepository(database).append(this.ctx.workspaceId, runId, "restore.run.resume", {
          newAttemptRequired: true,
          actor: this.ctx.principalId,
        });
      });
    return { runId, dryRun: !apply, newAttemptRequired: true };
  }
}
