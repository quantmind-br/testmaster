import { statfs } from "node:fs/promises";
import { defaults } from "@testmaster/contracts";
import { canonicalJson, semanticHash } from "@testmaster/domain";
import {
  ConfinedRoot,
  collectGarbage,
  type GcCandidate,
  type GcSafety,
  validateRelativePath,
} from "@testmaster/evidence";
import { AuditRepository, OutboxRepository } from "@testmaster/persistence";
import type { ResolvedConfig } from "./config.js";
import type { ServiceContext } from "./context.js";

interface RetentionRecord {
  stage: "marked" | "tombstoned" | "deleted";
  expiredAt: string;
  tombstonedAt?: string;
  deletedAt?: string;
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
    AND r.phase='completed' AND s.id=artifacts.snapshot_id AND s.committed_at<=?
) AND artifacts.created_at<=?
AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.workspace_id=artifacts.workspace_id
  AND a.run_id=artifacts.run_id AND a.phase<>'completed')
AND NOT EXISTS (SELECT 1 FROM job_leases j WHERE j.workspace_id=artifacts.workspace_id
  AND j.resource_id=artifacts.run_id AND j.state='leased' AND j.lease_expires_at>?)
AND NOT EXISTS (SELECT 1 FROM operational_state h WHERE h.value<>'released' AND h.key IN (
  'retention:legal-hold:' || artifacts.workspace_id,
  'retention:legal-hold:' || artifacts.workspace_id || ':' || artifacts.run_id,
  'retention:legal-hold:' || artifacts.workspace_id || ':' || artifacts.id))
AND NOT EXISTS (SELECT 1 FROM artifacts ref WHERE ref.workspace_id=artifacts.workspace_id
  AND ref.storage_key=artifacts.storage_key AND ref.id<>artifacts.id)`;

export class RetentionService {
  constructor(
    readonly ctx: ServiceContext,
    readonly config: ResolvedConfig,
  ) {}

  private key(id: string): string {
    return `retention:artifact:${this.ctx.workspaceId}:${id}`;
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
    database.withTx(() => {
      const pressureKey = "retention:storage-pressure";
      const admission = database.get(
        "SELECT value FROM operational_state WHERE key='admission'",
      )?.value;
      const owned =
        database.get("SELECT value FROM operational_state WHERE key=?", pressureKey)?.value ===
        "suspended";
      if (usedFraction >= 0.9 && admission === "enabled") {
        database.run(
          "UPDATE operational_state SET value='suspended_storage' WHERE key='admission' AND value='enabled'",
        );
        database.run(
          "INSERT INTO operational_state(key,value) VALUES(?,'suspended') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          pressureKey,
        );
      } else if (usedFraction < 0.9 && owned) {
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
    let removed: string[];
    try {
      removed = await collectGarbage(
        this.config.dataDir,
        [...candidates.values()].map((row) => ({
          relativePath: row.storage_key,
          version: Number(row.version),
        })),
        {
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
              if (row.state !== "expired") expiredArtifacts++;
              return { version: candidate.version + 1 };
            }),
          tombstone: async (candidate) =>
            database.withTx(() => {
              const row = current(candidate);
              if (!row || row.state !== "expired") return null;
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
              this.event(original, "artifact.deleted", previous, record);
            }),
        },
      );
    } finally {
      root.close();
    }
    const pressure = await this.storagePressure();
    return {
      expiredArtifacts,
      removed,
      ...pressure,
    };
  }
}
