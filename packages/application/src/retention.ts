import { readdir, statfs } from "node:fs/promises";
import { ContractError, type DeletionOperation, defaults, validate } from "@testmaster/contracts";
import { canonicalJson, semanticHash } from "@testmaster/domain";
import {
  ConfinedRoot,
  collectGarbage,
  type GcCandidate,
  type GcPort,
  type GcSafety,
  validateRelativePath,
} from "@testmaster/evidence";
import {
  AuditRepository,
  type EntityDocument,
  OutboxRepository,
  type PersistenceDatabase,
  releaseControlPlaneReserve,
} from "@testmaster/persistence";
import { auditSecurity } from "./audit.js";
import type { ResolvedConfig } from "./config.js";
import { allEntities, entity, requireEntity, type ServiceContext } from "./context.js";
import { type FixtureInput, fixtureRecord, fixtureRevoked } from "./input-fixtures.js";
import { storageMetadataReserveBytes } from "./storage-admission.js";

interface RetentionRecord {
  stage: "marked" | "tombstoned" | "deleted";
  expiredAt: string;
  tombstonedAt?: string;
  deletedAt?: string;
  /** Set once a storage outage delayed physical removal, so the alert is emitted once per artifact. */
  gcDelayedAt?: string;
}

/** Fraction of used storage at which one warning event is emitted. */
const storageWarningFraction = 0.8;
/** Errno codes meaning the storage backend, not the artifact, failed to remove an object. */
const storageUnavailableCodes: Record<string, true> = {
  EIO: true,
  EROFS: true,
  ENODEV: true,
  ENXIO: true,
  ESTALE: true,
  ETIMEDOUT: true,
  ENOTCONN: true,
};

function artifactRetentionKey(workspaceId: string, artifactId: string): string {
  return `retention:artifact:${workspaceId}:${artifactId}`;
}

/**
 * Publication of an artifact whose retention record exists (marked, tombstoned or deleted) is
 * revoked: an upload that was in flight when deletion was requested must not republish it.
 */
export function assertArtifactPublishable(
  database: PersistenceDatabase,
  workspaceId: string,
  artifactId: string,
): void {
  if (
    database.get(
      "SELECT 1 FROM operational_state WHERE key=?",
      artifactRetentionKey(workspaceId, artifactId),
    )
  )
    throw new ContractError("PRECONDITION_FAILED", "Artifact publication revoked by tombstone");
}

interface ArtifactRow extends Record<string, unknown> {
  id: string;
  run_id: string;
  attempt_id: string;
  storage_key: string;
  state: string;
  version: number;
}

// Metadata references remain after expiry; only live blob references prevent removal.
const eligible = `EXISTS (
  SELECT 1 FROM runs r JOIN snapshots s ON s.workspace_id=r.workspace_id AND s.run_id=r.id
  WHERE r.workspace_id=artifacts.workspace_id AND r.id=artifacts.run_id
    AND r.phase='completed' AND s.id=artifacts.snapshot_id AND (s.committed_at<=? OR EXISTS (SELECT 1 FROM operational_state d WHERE d.key='retention:deletion:' || artifacts.workspace_id || ':' || artifacts.id))
) AND (artifacts.created_at<=? OR EXISTS (SELECT 1 FROM operational_state d WHERE d.key='retention:deletion:' || artifacts.workspace_id || ':' || artifacts.id))
AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.workspace_id=artifacts.workspace_id
  AND a.run_id=artifacts.run_id AND a.phase<>'completed')
AND NOT EXISTS (SELECT 1 FROM job_leases j WHERE j.workspace_id=artifacts.workspace_id
  AND j.resource_id=artifacts.run_id AND j.state='leased' AND j.lease_expires_at>?)
AND NOT EXISTS (SELECT 1 FROM operational_state h WHERE h.value<>'released' AND h.key IN (
  'retention:legal-hold:' || artifacts.workspace_id,
  'retention:legal-hold:' || artifacts.workspace_id || ':' || artifacts.run_id,
  'retention:legal-hold:' || artifacts.workspace_id || ':' || artifacts.id))
AND NOT EXISTS (SELECT 1 FROM backup_object_holds b WHERE b.workspace_id=artifacts.workspace_id AND b.artifact_id=artifacts.id AND b.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
AND NOT EXISTS (SELECT 1 FROM artifacts ref WHERE ref.workspace_id=artifacts.workspace_id
  AND ref.storage_key=artifacts.storage_key AND ref.id<>artifacts.id)`;

export class RetentionService {
  constructor(
    readonly ctx: ServiceContext,
    readonly config: ResolvedConfig,
  ) {}
  requestDeletion(artifactId: string): DeletionOperation {
    const fixture = fixtureRecord(this.ctx, artifactId);
    if (fixture) {
      this.ctx.authorizeNamed("delete", "Artifact", fixture.project_id);
      return this.transaction(() => {
        const previous = this.deletionPointer(artifactId);
        if (previous) return this.deletionStatus(previous);
        const now = new Date().toISOString();
        const operation = this.createOperation([artifactId], now, "pending");
        this.tombstoneFixture(artifactId, operation.id, now);
        return this.deletionStatus(operation.id);
      });
    }
    const artifact = requireEntity(this.ctx, "Artifact", artifactId);
    const attempt = requireEntity(this.ctx, "Attempt", String(artifact.attemptId));
    const run = requireEntity(this.ctx, "Run", String(attempt.runId));
    const test = requireEntity(this.ctx, "TestCase", String(run.testId));
    const environmentId = this.ctx.database.get(
      "SELECT environment_id FROM environment_revisions WHERE workspace_id=? AND id=?",
      this.ctx.workspaceId,
      run.environmentRevisionId,
    )?.environment_id;
    this.ctx.authorizeNamed("delete", "Artifact", String(test.projectId), String(environmentId));
    return this.transaction(() => {
      const previous = this.deletionPointer(artifactId);
      if (previous) return this.deletionStatus(previous);
      const now = new Date().toISOString();
      const operation = this.createOperation([artifactId], now, "pending");
      this.tombstoneArtifact(artifactId, operation.id, now);
      return this.deletionStatus(operation.id);
    });
  }
  /**
   * Revokes every live artifact and input fixture of an archived project under one umbrella
   * operation. The confirmation token is the typed project slug. Holds are never bypassed: access
   * ends now, physical removal follows the same collection rules as a single artifact.
   */
  purgeProject(projectId: string, confirmationToken: string): DeletionOperation {
    this.ctx.authorize("A", projectId);
    const project = requireEntity(this.ctx, "Project", projectId);
    const refuse = (reason: string, message: string): never => {
      auditSecurity(this.ctx, "project.purge", projectId, "denied");
      throw new ContractError("PRECONDITION_FAILED", message, { reason });
    };
    if (confirmationToken !== String(project.slug))
      refuse("confirmation_mismatch", "Confirmation must be the project slug");
    if (!project.archivedAt)
      refuse("project_not_archived", "Only an archived project can be purged");
    const pointerKey = `retention:project-purge:${this.ctx.workspaceId}:${projectId}`;
    const result = this.transaction((): DeletionOperation | null => {
      const previous = this.ctx.database.get(
        "SELECT value FROM operational_state WHERE key=?",
        pointerKey,
      );
      if (previous) return this.deletionStatus(String(previous.value));
      // An unfinished Run could still publish artifacts after the purge, so none may exist.
      if (
        this.ctx.database.get(
          "SELECT 1 FROM runs r JOIN tests t ON t.workspace_id=r.workspace_id AND t.id=r.test_id WHERE r.workspace_id=? AND t.project_id=? AND r.phase<>'completed' LIMIT 1",
          this.ctx.workspaceId,
          projectId,
        )
      )
        return null;
      const artifactIds = this.ctx.database
        .all<{ id: string }>(
          "SELECT a.id FROM artifacts a JOIN runs r ON r.workspace_id=a.workspace_id AND r.id=a.run_id JOIN tests t ON t.workspace_id=r.workspace_id AND t.id=r.test_id WHERE a.workspace_id=? AND t.project_id=? AND a.state IN ('available','partial') ORDER BY a.created_at,a.id",
          this.ctx.workspaceId,
          projectId,
        )
        .map((row) => row.id)
        .filter((id) => !this.deletionPointer(id));
      const fixtureIds = this.ctx.database
        .all<{ id: string }>(
          "SELECT id FROM fixture_inputs WHERE workspace_id=? AND project_id=? ORDER BY created_at,id",
          this.ctx.workspaceId,
          projectId,
        )
        .map((row) => row.id)
        .filter((id) => !fixtureRevoked(this.ctx, id));
      const refs = [...artifactIds, ...fixtureIds];
      const now = new Date().toISOString();
      const operation = this.createOperation(refs, now, refs.length ? "pending" : "completed");
      for (const id of artifactIds) this.tombstoneArtifact(id, operation.id, now);
      for (const id of fixtureIds) this.tombstoneFixture(id, operation.id, now);
      this.ctx.database.run(
        "INSERT INTO operational_state(key,value) VALUES(?,?)",
        pointerKey,
        operation.id,
      );
      new AuditRepository(this.ctx.database).append({
        workspaceId: this.ctx.workspaceId,
        actor: this.ctx.principalId,
        action: "project.purge",
        resourceId: projectId,
        requestId: pointerKey,
        timestamp: now,
        beforeHash: null,
        afterHash: semanticHash({ operationId: operation.id, count: refs.length }),
      });
      return this.deletionStatus(operation.id);
    });
    return result ?? refuse("active_runs", "The project has Runs that have not completed");
  }
  /** Deletion operations the caller may read, newest first by creation, with live holds. */
  listDeletionOperations(filter: { projectId?: string } = {}): DeletionOperation[] {
    this.ctx.authorize("R", filter.projectId);
    if (filter.projectId) requireEntity(this.ctx, "Project", filter.projectId);
    const operations: DeletionOperation[] = [];
    for (const operation of allEntities(this.ctx, "DeletionOperation")) {
      if (filter.projectId && !this.operationProjects(operation).includes(filter.projectId))
        continue;
      try {
        operations.push(this.deletionStatus(operation.id));
      } catch (error) {
        // Operations over projects the caller cannot read are omitted, never reported.
        if (error instanceof ContractError && error.code === "FORBIDDEN") continue;
        throw error;
      }
    }
    return operations;
  }
  /** Projects an operation concerns: those of its refs plus those it purged. */
  private operationProjects(operation: EntityDocument): string[] {
    const projects = new Set(this.purgedProjectIds(operation.id));
    for (const ref of operation.resourceRefs as string[]) {
      const fixture = fixtureRecord(this.ctx, ref);
      if (fixture) {
        projects.add(fixture.project_id);
        continue;
      }
      const owner = this.ctx.database.get<{ project_id: string }>(
        "SELECT t.project_id FROM artifacts a JOIN runs r ON r.workspace_id=a.workspace_id AND r.id=a.run_id JOIN tests t ON t.workspace_id=r.workspace_id AND t.id=r.test_id WHERE a.workspace_id=? AND a.id=?",
        this.ctx.workspaceId,
        ref,
      );
      if (owner) projects.add(owner.project_id);
    }
    return [...projects];
  }
  private purgedProjectIds(operationId: string): string[] {
    const prefix = `retention:project-purge:${this.ctx.workspaceId}:`;
    return this.ctx.database
      .all<{ key: string }>(
        "SELECT key FROM operational_state WHERE value=? AND key LIKE ?",
        operationId,
        `${prefix}%`,
      )
      .filter((row) => row.key.startsWith(prefix))
      .map((row) => row.key.slice(prefix.length));
  }
  private deletionPointer(id: string): string | null {
    const row = this.ctx.database.get(
      "SELECT value FROM operational_state WHERE key=?",
      `retention:deletion:${this.ctx.workspaceId}:${id}`,
    );
    return row ? String(row.value) : null;
  }
  /** HTTP mutations arrive inside an idempotency receipt transaction, which cannot nest. */
  private transaction<T>(action: () => T): T {
    return this.ctx.database.inTransaction ? action() : this.ctx.database.withTx(action);
  }
  private createOperation(
    refs: string[],
    now: string,
    physicalState: "pending" | "completed",
  ): EntityDocument {
    const operation = entity(this.ctx, "del", {
      resourceRefs: refs,
      requestedBy: this.ctx.principalId,
      revokedAt: now,
      physicalState,
      physicalDeletionDeadlineAt: new Date(Date.parse(now) + 86400000).toISOString(),
      backupExpiryDeadlineAt: null,
      deadlineReason:
        "Active data deletion is due within 24 hours while storage is healthy and no hold blocks collection.",
      backupHolds: [],
      errors: [],
    });
    validate("DeletionOperation", operation);
    this.ctx.entities.insert("DeletionOperation", operation);
    return operation;
  }
  private tombstoneFixture(fixtureId: string, operationId: string, now: string): void {
    const key = `retention:deletion:${this.ctx.workspaceId}:${fixtureId}`;
    this.ctx.database.run("INSERT INTO operational_state(key,value) VALUES(?,?)", key, operationId);
    this.save(fixtureId, { stage: "tombstoned", expiredAt: now, tombstonedAt: now });
    new AuditRepository(this.ctx.database).append({
      workspaceId: this.ctx.workspaceId,
      actor: this.ctx.principalId,
      action: "artifact.deletion_requested",
      resourceId: fixtureId,
      requestId: key,
      timestamp: now,
      beforeHash: null,
      afterHash: semanticHash({ operationId, revokedAt: now }),
    });
  }
  private tombstoneArtifact(artifactId: string, operationId: string, now: string): void {
    this.ctx.database.run(
      "INSERT INTO operational_state(key,value) VALUES(?,?)",
      `retention:deletion:${this.ctx.workspaceId}:${artifactId}`,
      operationId,
    );
    this.save(artifactId, { stage: "tombstoned", expiredAt: now, tombstonedAt: now });
    this.ctx.database.run(
      "UPDATE artifacts SET state='expired',version=version+1 WHERE workspace_id=? AND id=? AND state<>'expired'",
      this.ctx.workspaceId,
      artifactId,
    );
    const row = this.ctx.database.get<ArtifactRow>(
      "SELECT * FROM artifacts WHERE workspace_id=? AND id=?",
      this.ctx.workspaceId,
      artifactId,
    )!;
    this.event(row, "artifact.deletion_requested", null, { operationId, revokedAt: now });
  }
  /** An umbrella operation is physically complete only once every reference is deleted. */
  private completeOperationIfAllDeleted(operationId: string): void {
    const operation = requireEntity(this.ctx, "DeletionOperation", operationId);
    if (operation.physicalState === "completed") return;
    if ((operation.resourceRefs as string[]).some((ref) => this.record(ref)?.stage !== "deleted"))
      return;
    this.ctx.entities.update(
      "DeletionOperation",
      this.ctx.workspaceId,
      operation.id,
      Number(operation.version),
      {
        ...operation,
        version: Number(operation.version) + 1,
        physicalState: "completed",
        backupHolds: [],
        errors: [],
      },
    );
  }
  deletionStatus(id: string): DeletionOperation {
    const operation = requireEntity(this.ctx, "DeletionOperation", id);
    for (const artifactId of operation.resourceRefs as string[]) {
      const fixture = fixtureRecord(this.ctx, artifactId);
      if (fixture) {
        this.ctx.authorize("R", fixture.project_id);
        continue;
      }
      const artifact = requireEntity(this.ctx, "Artifact", artifactId);
      const attempt = requireEntity(this.ctx, "Attempt", String(artifact.attemptId));
      const run = requireEntity(this.ctx, "Run", String(attempt.runId));
      const test = requireEntity(this.ctx, "TestCase", String(run.testId));
      this.ctx.authorize("R", String(test.projectId));
    }
    // An umbrella operation over an empty project has no refs, yet only readers of it may see it.
    for (const projectId of this.purgedProjectIds(operation.id)) this.ctx.authorize("R", projectId);
    const holds: string[] = [];
    if (operation.physicalState !== "completed")
      for (const artifactId of operation.resourceRefs as string[]) {
        const fixture = fixtureRecord(this.ctx, artifactId);
        if (fixture) {
          holds.push(...this.fixtureDeletionHolds(fixture));
          continue;
        }
        const artifact = this.ctx.database.get<ArtifactRow>(
          "SELECT * FROM artifacts WHERE workspace_id=? AND id=?",
          this.ctx.workspaceId,
          artifactId,
        )!;
        for (const row of this.ctx.database.all(
          "SELECT backup_id,expires_at FROM backup_object_holds WHERE workspace_id=? AND artifact_id=? AND expires_at>?",
          this.ctx.workspaceId,
          artifactId,
          new Date().toISOString(),
        ))
          holds.push(`backup:${row.backup_id}:until:${row.expires_at}`);
        for (const row of this.ctx.database.all(
          "SELECT key FROM operational_state WHERE value<>'released' AND key IN (?,?,?)",
          `retention:legal-hold:${this.ctx.workspaceId}`,
          `retention:legal-hold:${this.ctx.workspaceId}:${artifact.run_id}`,
          `retention:legal-hold:${this.ctx.workspaceId}:${artifactId}`,
        ))
          holds.push(String(row.key));
        if (
          this.ctx.database.get(
            "SELECT 1 FROM attempts WHERE workspace_id=? AND run_id=? AND phase<>'completed'",
            this.ctx.workspaceId,
            artifact.run_id,
          )
        )
          holds.push("active_attempt");
        if (
          this.ctx.database.get(
            "SELECT 1 FROM artifacts WHERE workspace_id=? AND storage_key=? AND id<>?",
            this.ctx.workspaceId,
            artifact.storage_key,
            artifactId,
          )
        )
          holds.push("shared_blob_reference");
      }
    const backupExpiries = holds
      .flatMap((hold) => {
        const timestamp = hold.startsWith("backup:") ? hold.split(":until:")[1] : undefined;
        return timestamp && Number.isFinite(Date.parse(timestamp)) ? [timestamp] : [];
      })
      .sort();
    const held = holds.length > 0;
    return {
      ...operation,
      backupHolds: [...new Set(holds)],
      physicalDeletionDeadlineAt: held
        ? null
        : new Date(Date.parse(String(operation.revokedAt)) + 86400000).toISOString(),
      backupExpiryDeadlineAt: backupExpiries.at(-1) ?? null,
      deadlineReason: held
        ? "Physical removal is deferred by the listed holds; backup expiry is separate and restore must reapply tombstones."
        : "Active data deletion is due within 24 hours while storage is healthy; backup copies are not promised immediate erasure.",
    } as unknown as DeletionOperation;
  }
  private fixtureDeletionHolds(fixture: FixtureInput): string[] {
    const holds: string[] = [];
    const references = this.ctx.database.all<FixtureInput>(
      "SELECT * FROM fixture_inputs WHERE workspace_id=? AND storage_key=?",
      this.ctx.workspaceId,
      fixture.storage_key,
    );
    for (const reference of references) {
      for (const row of this.ctx.database.all(
        "SELECT key FROM operational_state WHERE value<>'released' AND key IN (?,?)",
        `retention:legal-hold:${this.ctx.workspaceId}`,
        `retention:legal-hold:${this.ctx.workspaceId}:${reference.id}`,
      ))
        holds.push(String(row.key));
      for (const row of this.ctx.database.all(
        "SELECT key,value FROM operational_state WHERE key LIKE ? AND value>?",
        `retention:fixture-backup:${this.ctx.workspaceId}:${reference.id}:%`,
        new Date().toISOString(),
      ))
        holds.push(`backup:${row.key}:until:${row.value}`);
      if (
        this.ctx.database.get(
          "SELECT 1 FROM runs r JOIN test_revisions v ON v.workspace_id=r.workspace_id AND v.id=r.revision_id WHERE r.workspace_id=? AND r.phase<>'completed' AND instr(v.data_json,?)>0",
          this.ctx.workspaceId,
          reference.id,
        )
      )
        holds.push("active_run");
      if (reference.id !== fixture.id && !fixtureRevoked(this.ctx, reference.id))
        holds.push("shared_blob_reference");
    }
    return holds;
  }
  private async collectDeletedFixtures(): Promise<string[]> {
    const removed: string[] = [];
    const root = new ConfinedRoot(this.config.dataDir);
    try {
      for (const fixture of this.ctx.database.all<FixtureInput>(
        "SELECT f.* FROM fixture_inputs f JOIN operational_state d ON d.key='retention:deletion:' || f.workspace_id || ':' || f.id WHERE f.workspace_id=?",
        this.ctx.workspaceId,
      )) {
        if (
          this.record(fixture.id)?.stage === "deleted" ||
          this.fixtureDeletionHolds(fixture).length
        )
          continue;
        // Metadata is immutable; the tombstone remains authoritative after blob removal.
        if (
          fixture.storage_key !==
          `fixture-inputs/${this.ctx.workspaceId}/${fixture.project_id}/${fixture.content_hash}`
        )
          continue;
        await root.unlink(fixture.storage_key);
        this.ctx.database.withTx(() => {
          const previous = this.record(fixture.id);
          if (!previous || this.fixtureDeletionHolds(fixture).length) return;
          this.save(fixture.id, {
            ...previous,
            stage: "deleted",
            deletedAt: new Date().toISOString(),
          });
          const pointer = this.ctx.database.get(
            "SELECT value FROM operational_state WHERE key=?",
            `retention:deletion:${this.ctx.workspaceId}:${fixture.id}`,
          )!;
          this.completeOperationIfAllDeleted(String(pointer.value));
        });
        removed.push(fixture.storage_key);
      }
    } finally {
      root.close();
    }
    return removed;
  }
  repairReferences(apply = false) {
    this.ctx.authorize("A");
    return this.ctx.database.withTx(() => {
      const actual = this.ctx.database.all<{ storage_key: string; n: number }>(
        "SELECT storage_key,COUNT(*) AS n FROM artifacts WHERE workspace_id=? AND state IN ('available','partial') GROUP BY storage_key",
        this.ctx.workspaceId,
      );
      const keys = new Set(actual.map((row) => row.storage_key));
      for (const row of this.ctx.database.all(
        "SELECT storage_key FROM blob_reference_counts WHERE workspace_id=?",
        this.ctx.workspaceId,
      ))
        keys.add(String(row.storage_key));
      const changes = [...keys].flatMap((storageKey) => {
        const count = actual.find((row) => row.storage_key === storageKey)?.n ?? 0;
        const cached = this.ctx.database.get(
          "SELECT references_count FROM blob_reference_counts WHERE workspace_id=? AND storage_key=?",
          this.ctx.workspaceId,
          storageKey,
        )?.references_count;
        return cached === count
          ? []
          : [{ storageKey, recorded: cached ?? null, recomputed: count }];
      });
      if (apply) {
        for (const change of changes)
          this.ctx.database.run(
            "INSERT INTO blob_reference_counts(workspace_id,storage_key,references_count,checked_at) VALUES(?,?,?,?) ON CONFLICT(workspace_id,storage_key) DO UPDATE SET references_count=excluded.references_count,checked_at=excluded.checked_at",
            this.ctx.workspaceId,
            change.storageKey,
            change.recomputed,
            new Date().toISOString(),
          );
        new AuditRepository(this.ctx.database).append({
          workspaceId: this.ctx.workspaceId,
          actor: this.ctx.principalId,
          action: "storage.references.repaired",
          resourceId: this.ctx.workspaceId,
          requestId: "storage-repair",
          timestamp: new Date().toISOString(),
          beforeHash: semanticHash(changes),
          afterHash: semanticHash(
            changes.map((change) => ({
              storageKey: change.storageKey,
              references: change.recomputed,
            })),
          ),
        });
      }
      return { dryRun: !apply, changes, deletedObjects: 0 };
    });
  }

  private key(id: string): string {
    return artifactRetentionKey(this.ctx.workspaceId, id);
  }
  /** Storage failed while removing a tombstoned object: keep it tombstoned and alert once. */
  private delayDeletion(row: ArtifactRow): void {
    this.ctx.database.withTx(() => {
      const record = this.record(row.id);
      if (!record || record.gcDelayedAt) return;
      this.save(row.id, { ...record, gcDelayedAt: new Date().toISOString() });
      new OutboxRepository(this.ctx.database).append(
        this.ctx.workspaceId,
        this.ctx.workspaceId,
        "storage.gc_delayed",
        {
          artifactId: row.id,
          reasonCode: "storage_unavailable",
          physicalDeletionDeadlineAt: new Date(
            Date.parse(record.expiredAt) + 86400000,
          ).toISOString(),
        },
      );
    });
  }
  private record(id: string): RetentionRecord | null {
    const row = this.ctx.database.get(
      "SELECT value FROM operational_state WHERE key=?",
      this.key(id),
    );
    return row ? (JSON.parse(String(row.value)) as RetentionRecord) : null;
  }
  private save(id: string, record: RetentionRecord): void {
    this.ctx.database.run(
      "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      this.key(id),
      canonicalJson(record),
    );
  }
  private event(row: ArtifactRow, action: string, before: unknown, after: unknown): void {
    new AuditRepository(this.ctx.database).append({
      workspaceId: this.ctx.workspaceId,
      actor: this.ctx.principalId,
      action,
      resourceId: row.id,
      requestId: this.key(row.id),
      timestamp: new Date().toISOString(),
      beforeHash: semanticHash(before),
      afterHash: semanticHash(after),
    });
    new OutboxRepository(this.ctx.database).append(this.ctx.workspaceId, row.run_id, action, {
      artifactId: row.id,
      ...(after as Record<string, unknown>),
    });
  }

  private async storagePressure(): Promise<{ usedFraction: number; admissionSuspended: boolean }> {
    const storage = await statfs(this.config.dataDir);
    const total = Number(storage.blocks);
    const usedFraction =
      total > 0 ? Math.min(1, Math.max(0, 1 - Number(storage.bavail) / total)) : 1;
    const database = this.ctx.database;
    if (Number(storage.bavail) * Number(storage.bsize) < storageMetadataReserveBytes)
      releaseControlPlaneReserve(database.path);
    database.withTx(() => {
      const warningKey = "storage:high-watermark";
      const warned = database.get("SELECT 1 FROM operational_state WHERE key=?", warningKey);
      if (usedFraction >= storageWarningFraction && !warned) {
        const warning = {
          reasonCode: "storage_high_watermark",
          usedFraction,
          thresholdFraction: storageWarningFraction,
        };
        database.run(
          "INSERT INTO operational_state(key,value) VALUES(?,?)",
          warningKey,
          canonicalJson({ ...warning, observedAt: new Date().toISOString() }),
        );
        new OutboxRepository(database).append(
          this.ctx.workspaceId,
          this.ctx.workspaceId,
          "storage.high_watermark",
          warning,
        );
      } else if (usedFraction < storageWarningFraction && warned) {
        database.run("DELETE FROM operational_state WHERE key=?", warningKey);
      }
      // Admission is gated by free bytes at preflight (assertStorageRoom), never suspended by the
      // used share. A suspension recorded by an earlier version's pressure guard is lifted here;
      // restore and operator suspensions are left alone.
      const pressureKey = "retention:storage-pressure";
      const owned =
        database.get("SELECT value FROM operational_state WHERE key=?", pressureKey)?.value ===
        "suspended";
      if (owned) {
        database.run(
          "UPDATE operational_state SET value='enabled' WHERE key='admission' AND value='suspended_storage'",
        );
        database.run("DELETE FROM operational_state WHERE key=?", pressureKey);
      }
    });
    return {
      usedFraction,
      admissionSuspended:
        database.get("SELECT value FROM operational_state WHERE key='admission'")?.value !==
        "enabled",
    };
  }

  /** Internal worker maintenance; callers authorize worker control, not individual GC transitions. */
  async maintenance(): Promise<{
    expiredArtifacts: number;
    removed: string[];
    usedFraction: number;
    admissionSuspended: boolean;
  }> {
    const database = this.ctx.database;
    await this.storagePressure();
    const uploadsRoot = new ConfinedRoot(this.config.dataDir);
    try {
      for (const lease of database.all(
        "SELECT upload_id FROM upload_leases WHERE workspace_id=? AND expires_at<=?",
        this.ctx.workspaceId,
        new Date().toISOString(),
      )) {
        const uploadId = String(lease.upload_id);
        if (!/^[a-f0-9]{48}$/.test(uploadId)) throw new Error("Invalid persisted upload lease");
        const directory = `uploads/${this.ctx.workspaceId}`;
        try {
          const uploads = uploadsRoot.openDirectory(directory);
          try {
            for (const name of await readdir(`/proc/self/fd/${uploads.fd}`))
              if (
                name === `${uploadId}.bin` ||
                (name.startsWith(`${uploadId}.`) && name.endsWith(".pending"))
              )
                await uploads.unlink(name);
          } finally {
            uploads.close();
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        database.withTx(() => {
          database.run(
            "DELETE FROM upload_leases WHERE workspace_id=? AND upload_id=? AND expires_at<=?",
            this.ctx.workspaceId,
            uploadId,
            new Date().toISOString(),
          );
          database.run(
            "DELETE FROM operational_state WHERE key=?",
            `ai:${this.ctx.workspaceId}:upload:${uploadId}`,
          );
        });
      }
    } finally {
      uploadsRoot.close();
    }
    const cutoff = new Date(
      Date.now() -
        (this.config.effectiveConfig.config.artifacts?.retentionDays ??
          defaults.artifactRetentionDays) *
          86400000,
    ).toISOString();
    const rows = database
      .all<ArtifactRow>(
        `SELECT * FROM artifacts WHERE workspace_id=? AND state IN ('available','expired') AND ${eligible} ORDER BY created_at,id`,
        this.ctx.workspaceId,
        cutoff,
        cutoff,
        new Date().toISOString(),
      )
      .filter((row) => this.record(row.id)?.stage !== "deleted");
    const candidates = new Map<string, ArtifactRow>();
    for (const row of rows) {
      validateRelativePath(row.storage_key);
      const prefix = `runs/${this.ctx.workspaceId}/${row.run_id}/${row.attempt_id}/`;
      if (!row.storage_key.startsWith(prefix))
        throw new Error("Artifact storage key is outside its committed bundle");
      const path = row.storage_key.slice(prefix.length);
      if (
        !path ||
        path
          .split("/")
          .some(
            (part) =>
              ["meta.json", "manifest.json", ".partial"].includes(part) || part.startsWith(".tm-"),
          )
      )
        throw new Error("Retention cannot remove bundle metadata");
      candidates.set(row.storage_key, row);
    }
    const current = (candidate: GcCandidate): ArtifactRow | null => {
      const original = candidates.get(candidate.relativePath);
      if (!original) return null;
      return (
        database.get<ArtifactRow>(
          `SELECT * FROM artifacts WHERE workspace_id=? AND id=? AND storage_key=? AND version=? AND state IN ('available','expired') AND ${eligible}`,
          this.ctx.workspaceId,
          original.id,
          candidate.relativePath,
          candidate.version,
          cutoff,
          cutoff,
          new Date().toISOString(),
        ) ?? null
      );
    };
    let expiredArtifacts = 0;
    const root = new ConfinedRoot(this.config.dataDir);
    const removed: string[] = [];
    try {
      const port: GcPort = {
        inspect: async (candidate): Promise<GcSafety> => {
          const safe = Boolean(current(candidate));
          if (safe) {
            try {
              const file = await root.openFile(candidate.relativePath);
              await file.close();
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
          return {
            activeAttempt: !safe,
            validUploadLease: false,
            legalHold: false,
            liveReferences: 0,
          };
        },
        mark: async (candidate) =>
          database.withTx(() => {
            const row = current(candidate);
            if (!row) return null;
            const previous = this.record(row.id);
            if (previous?.stage === "deleted") return null;
            if (row.state === "expired" && previous) return { version: Number(row.version) };
            const record: RetentionRecord = {
              stage: "marked",
              expiredAt: new Date().toISOString(),
            };
            const changed = database.run(
              `UPDATE artifacts SET state='expired',version=version+1 WHERE workspace_id=? AND id=? AND version=? AND state=? AND ${eligible}`,
              this.ctx.workspaceId,
              row.id,
              candidate.version,
              row.state,
              cutoff,
              cutoff,
              new Date().toISOString(),
            );
            if (!changed.changes) return null;
            this.save(row.id, record);
            this.event(
              row,
              "artifact.expired",
              { state: row.state, retention: previous },
              { state: "expired", retention: record },
            );
            database.run(
              "INSERT INTO blob_reference_counts(workspace_id,storage_key,references_count,checked_at) VALUES(?,?,(SELECT COUNT(*) FROM artifacts WHERE workspace_id=? AND storage_key=? AND state IN ('available','partial')),?) ON CONFLICT(workspace_id,storage_key) DO UPDATE SET references_count=excluded.references_count,checked_at=excluded.checked_at",
              this.ctx.workspaceId,
              row.storage_key,
              this.ctx.workspaceId,
              row.storage_key,
              new Date().toISOString(),
            );
            if (row.state !== "expired") expiredArtifacts++;
            return { version: candidate.version + 1 };
          }),
        tombstone: async (candidate) =>
          database.withTx(() => {
            const row = current(candidate);
            if (row?.state !== "expired") return null;
            const previous = this.record(row.id);
            if (!previous || previous.stage === "deleted") return null;
            const changed = database.run(
              `UPDATE artifacts SET version=version+1 WHERE workspace_id=? AND id=? AND version=? AND state='expired' AND ${eligible}`,
              this.ctx.workspaceId,
              row.id,
              candidate.version,
              cutoff,
              cutoff,
              new Date().toISOString(),
            );
            if (!changed.changes) return null;
            if (previous.stage !== "tombstoned") {
              const record: RetentionRecord = {
                ...previous,
                stage: "tombstoned",
                tombstonedAt: new Date().toISOString(),
              };
              this.save(row.id, record);
              this.event(row, "artifact.tombstoned", previous, record);
            }
            return { version: candidate.version + 1 };
          }),
        deleted: async (candidate) =>
          database.withTx(() => {
            const original = candidates.get(candidate.relativePath);
            if (!original) return;
            const previous = this.record(original.id);
            if (previous?.stage !== "tombstoned") return;
            const changed = database.run(
              "UPDATE artifacts SET version=version+1 WHERE workspace_id=? AND id=? AND version=? AND state='expired'",
              this.ctx.workspaceId,
              original.id,
              candidate.version,
            );
            if (!changed.changes) return;
            const record: RetentionRecord = {
              ...previous,
              stage: "deleted",
              deletedAt: new Date().toISOString(),
            };
            this.save(original.id, record);
            const deletion = database.get(
              "SELECT value FROM operational_state WHERE key=?",
              `retention:deletion:${this.ctx.workspaceId}:${original.id}`,
            );
            if (deletion) this.completeOperationIfAllDeleted(String(deletion.value));
            this.event(original, "artifact.deleted", previous, record);
          }),
      };
      for (const row of candidates.values()) {
        const candidate = { relativePath: row.storage_key, version: Number(row.version) };
        try {
          removed.push(...(await collectGarbage(this.config.dataDir, [candidate], port)));
        } catch (error) {
          const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
          if (!code || !Object.hasOwn(storageUnavailableCodes, code)) throw error;
          this.delayDeletion(row);
        }
      }
    } finally {
      root.close();
    }
    removed.push(...(await this.collectDeletedFixtures()));
    const pressure = await this.storagePressure();
    return {
      expiredArtifacts,
      removed,
      ...pressure,
    };
  }
}
