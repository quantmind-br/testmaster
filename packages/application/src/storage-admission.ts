import { statfs } from "node:fs/promises";
import { ContractError, defaults } from "@testmaster/contracts";
import type { PersistenceDatabase } from "@testmaster/persistence";

/**
 * Space kept free besides evidence: SQLite pages and WAL, audit and outbox rows, and the daily
 * component logs that runs write. It keeps the control plane writable when every run in progress
 * fills its evidence quota.
 */
export const storageMetadataReserveBytes = 256 * 1024 * 1024;

export interface EvidenceLimits {
  attemptArtifactBytes?: number;
  maxAttempts?: number;
}

/** The most evidence bytes one run can write in the data directory: every attempt at its cap. */
export function runEvidenceBytes(limits: EvidenceLimits = {}): number {
  return (
    (limits.attemptArtifactBytes ?? defaults.attemptArtifactBytes) *
    (limits.maxAttempts ?? defaults.maxAttempts)
  );
}

/** Free bytes an unprivileged writer can use on the data-directory volume. */
export async function freeDataBytes(dataDir: string): Promise<number> {
  const storage = await statfs(dataDir);
  return Number(storage.bavail) * Number(storage.bsize);
}

/**
 * Worst-case evidence of the runs writing now, in every workspace: started and not completed, or
 * claimed by a worker. Queued runs write nothing until a worker starts them, and the worker checks
 * the room again before it does (`hasStorageRoom`), so they do not count.
 */
export function inFlightEvidenceBytes(database: PersistenceDatabase): number {
  let total = 0;
  for (const row of database
    .forWorkspace("*")
    .all(
      "SELECT r.data_json FROM runs r WHERE r.phase NOT IN ('queued','completed') OR (r.phase='queued' AND EXISTS (SELECT 1 FROM job_leases j WHERE j.workspace_id=r.workspace_id AND j.resource_id=r.id AND j.state='leased'))",
    )) {
    const run = JSON.parse(String(row.data_json)) as { matrixCell?: { limits?: EvidenceLimits } };
    total += runEvidenceBytes(run.matrixCell?.limits);
  }
  return total;
}

export interface StorageRoom {
  freeBytes: number;
  inFlightBytes: number;
  incomingBytes: number;
}

function requiredBytes(room: StorageRoom): number {
  return room.inFlightBytes + room.incomingBytes + storageMetadataReserveBytes;
}

/** Whether a run of `incomingBytes` worst-case evidence can start next to the runs in progress. */
export function hasStorageRoom(room: StorageRoom): boolean {
  return room.freeBytes >= requiredBytes(room);
}

/**
 * Refuses admission only when the free space cannot hold the worst-case evidence of the runs in
 * progress plus the incoming run and the metadata reserve. The share of the volume in use plays no
 * part: other data on the volume is not TestMaster's to move.
 */
export function assertStorageRoom(room: StorageRoom): void {
  if (hasStorageRoom(room)) return;
  throw new ContractError(
    "QUOTA_EXCEEDED",
    "Free space cannot hold the evidence of the runs in progress and this one",
    {
      reasonCode: "storage_reserve_insufficient",
      freeBytes: room.freeBytes,
      requiredBytes: requiredBytes(room),
      inFlightRunBytes: room.inFlightBytes,
      incomingRunBytes: room.incomingBytes,
      reserveBytes: storageMetadataReserveBytes,
      path: "<data-dir>",
      options: [
        "wait for the runs in progress to complete; their reserved bytes are released then",
        "testmaster worker reconcile runs eligible retention GC",
        "lower execution.attemptArtifactBytes or execution.maxAttempts for this run",
        "report the refusal to the operator; never delete or move files outside TestMaster",
      ],
    },
  );
}

/** Where the evidence of this process lives, for the numbers the admission and retention read. */
export interface EvidenceVolume {
  /** Share of the evidence capacity in use, 0 to 1. */
  usedFraction: number;
  /** Bytes new evidence can still take. */
  freeBytes: number;
}

/**
 * Bytes of evidence the object store holds: artifacts that share a blob count once. The sum covers
 * every workspace, like the capacity it is compared with.
 */
export function storedEvidenceBytes(database: PersistenceDatabase): number {
  return Number(
    database
      .forWorkspace("*")
      .get(
        "SELECT COALESCE(SUM(bytes),0) AS n FROM (SELECT DISTINCT workspace_id, storage_key, bytes FROM artifacts WHERE state IN ('available','partial')) blobs",
      )?.n ?? 0,
  );
}

/**
 * The evidence volume. On a filesystem profile it is the data directory's volume. On the S3 profile
 * it is the operator's `capacityBytes` less the stored evidence (an object store reports no free
 * space), and never more than the local staging volume: evidence is staged there before it is
 * published.
 */
export async function evidenceVolume(
  config: { dataDir: string; evidenceCapacityBytes?: number },
  database: PersistenceDatabase,
): Promise<EvidenceVolume> {
  const local = await statfs(config.dataDir);
  const localFree = Number(local.bavail) * Number(local.bsize);
  if (config.evidenceCapacityBytes === undefined) {
    const total = Number(local.blocks);
    return {
      usedFraction: total > 0 ? Math.min(1, Math.max(0, 1 - Number(local.bavail) / total)) : 1,
      freeBytes: localFree,
    };
  }
  const used = storedEvidenceBytes(database);
  return {
    usedFraction: Math.min(1, used / config.evidenceCapacityBytes),
    freeBytes: Math.min(localFree, Math.max(0, config.evidenceCapacityBytes - used)),
  };
}
