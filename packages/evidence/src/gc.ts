import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { ConfinedRoot, validateRelativePath } from "./path.js";

export interface GcCandidate {
  relativePath: string;
  version: number;
}
export interface GcSafety {
  activeAttempt: boolean;
  validUploadLease: boolean;
  legalHold: boolean;
  liveReferences: number;
}
export interface GcPort {
  inspect(candidate: GcCandidate): Promise<GcSafety>;
  mark(candidate: GcCandidate): Promise<{ version: number } | null>;
  /** Atomically recheck safety and revoke publication/read authorization before returning a delete permit. */
  tombstone(candidate: GcCandidate): Promise<{ version: number } | null>;
  deleted(candidate: GcCandidate): Promise<void>;
}
export interface StagingOrphan {
  relativePath: string;
  ageMs: number;
  committed: boolean;
}
export async function findOrphanStaging(
  rootDir: string,
  graceMs = 24 * 60 * 60 * 1000,
  now = Date.now(),
): Promise<StagingOrphan[]> {
  const root = new ConfinedRoot(rootDir);
  const result: StagingOrphan[] = [];
  async function walk(path: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (entries.some((entry) => entry.name === ".partial" && entry.isFile())) {
      const details = await lstat(path);
      const ageMs = Math.max(0, now - details.mtimeMs);
      if (ageMs >= graceMs)
        result.push({
          relativePath: relative(rootDir, path),
          ageMs,
          committed: entries.some((entry) => entry.name === "meta.json"),
        });
      return;
    }
    for (const entry of entries)
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(join(path, entry.name));
  }
  try {
    await walk(join(rootDir, "staging"));
    await walk(join(rootDir, "runs"));
    return result;
  } finally {
    root.close();
  }
}
export async function collectGarbage(
  rootDir: string,
  candidates: readonly GcCandidate[],
  port: GcPort,
): Promise<string[]> {
  const root = new ConfinedRoot(rootDir);
  const removed: string[] = [];
  try {
    for (const candidate of candidates) {
      validateRelativePath(candidate.relativePath);
      const safety = await port.inspect(candidate);
      if (
        safety.activeAttempt ||
        safety.validUploadLease ||
        safety.legalHold ||
        safety.liveReferences > 0
      )
        continue;
      const marked = await port.mark(candidate);
      if (!marked) continue;
      const markedCandidate = { ...candidate, version: marked.version };
      const permit = await port.tombstone(markedCandidate);
      if (!permit) continue;
      await root.remove(candidate.relativePath);
      await port.deleted({ ...candidate, version: permit.version });
      removed.push(candidate.relativePath);
    }
    return removed;
  } finally {
    root.close();
  }
}
