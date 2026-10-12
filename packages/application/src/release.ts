import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ContractError } from "@testmaster/contracts";
import {
  type DatabaseUpgradePlan,
  type PersistenceDatabase,
  planDatabaseUpgrade,
  RESTORE_GUIDANCE,
  REVOKED_IMAGE_PREFIX,
  type UpgradeOptions,
  type UpgradeReceipt,
  upgradeDatabase,
} from "@testmaster/persistence";

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;
export interface ReleaseAssessment {
  plan: DatabaseUpgradePlan;
  /** Pinned image IDs found in the release's image lock. */
  pinnedImageIds: Record<string, string>;
  /** Reasons this release must not be installed or started against the data directory. */
  blockers: string[];
  warnings: string[];
  allowed: boolean;
}
export interface ReleaseAssessmentOptions {
  dataDir: string;
  /** Migrations shipped by the release under assessment (defaults to the running release). */
  migrationsDir?: string;
  /** `containers/images.lock.json` of the release under assessment (default: the running release). */
  imageLockPath?: string;
}
export const runningImageLockPath = fileURLToPath(
  new URL("../../../containers/images.lock.json", import.meta.url),
);

export function revokedImageIds(database: PersistenceDatabase): Set<string> {
  return new Set(
    database
      .all<{ key: string }>(
        "SELECT key FROM operational_state WHERE key LIKE ?",
        `${REVOKED_IMAGE_PREFIX}%`,
      )
      .map((row) => row.key.slice(REVOKED_IMAGE_PREFIX.length)),
  );
}
export function revokeImage(
  database: PersistenceDatabase,
  imageId: string,
  reason: string,
): { imageId: string; reason: string; revokedAt: string; alreadyRevoked: boolean } {
  if (!IMAGE_ID.test(imageId))
    throw new ContractError("INVALID_ARGUMENT", "Image ID must be sha256:<64 hex>");
  if (!reason.trim())
    throw new ContractError("INVALID_ARGUMENT", "A revocation reason is required");
  return database.withTx(() => {
    const key = `${REVOKED_IMAGE_PREFIX}${imageId}`;
    const existing = database.get("SELECT value FROM operational_state WHERE key=?", key);
    if (existing) return { ...JSON.parse(String(existing.value)), imageId, alreadyRevoked: true };
    const revokedAt = new Date().toISOString();
    database.run(
      "INSERT INTO operational_state(key,value) VALUES(?,?)",
      key,
      JSON.stringify({ reason, revokedAt }),
    );
    return { imageId, reason, revokedAt, alreadyRevoked: false };
  });
}

/**
 * Read-only compatibility check of a release (its migrations and pinned images) against an
 * existing local data directory. Used before installing a candidate or rolling back, so a
 * refusal leaves the installation and the data untouched.
 */
export async function assessRelease(options: ReleaseAssessmentOptions): Promise<ReleaseAssessment> {
  const plan = await planDatabaseUpgrade(
    join(options.dataDir, "testmaster.db"),
    options.migrationsDir,
  );
  const blockers: string[] = [];
  if (plan.refusal) blockers.push(`${plan.refusal} ${RESTORE_GUIDANCE}`);
  const pinnedImageIds: Record<string, string> = {};
  const lock: unknown = JSON.parse(
    await readFile(options.imageLockPath ?? runningImageLockPath, "utf8"),
  );
  for (const [name, entry] of Object.entries((lock ?? {}) as Record<string, unknown>)) {
    const imageId = (entry as { imageId?: unknown } | null)?.imageId;
    if (typeof imageId !== "string" || !IMAGE_ID.test(imageId))
      blockers.push(`Image lock entry ${name} has no valid imageId.`);
    else pinnedImageIds[name] = imageId;
    if (typeof imageId === "string" && plan.revokedImageIds.includes(imageId))
      blockers.push(`Image ${name} (${imageId}) is revoked and is never reinstalled.`);
  }
  return {
    plan,
    pinnedImageIds,
    blockers,
    warnings: plan.refusal ? [] : plan.warnings,
    allowed: blockers.length === 0,
  };
}

/** Ordered offline upgrade of the local database: assess → drain → backup → migrate → readiness. */
export async function upgradeLocalProfile(
  options: ReleaseAssessmentOptions & UpgradeOptions,
): Promise<{ assessment: ReleaseAssessment; receipt: UpgradeReceipt }> {
  const assessment = await assessRelease(options);
  if (!assessment.allowed)
    throw new ContractError("PRECONDITION_FAILED", assessment.blockers.join(" "), {
      blockers: assessment.blockers,
    });
  const receipt = await upgradeDatabase(join(options.dataDir, "testmaster.db"), {
    backupDir: options.backupDir,
    evidenceRoot: options.evidenceRoot ?? options.dataDir,
    ...(options.migrationsDir ? { migrationsDir: options.migrationsDir } : {}),
    ...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
  });
  return { assessment, receipt };
}
