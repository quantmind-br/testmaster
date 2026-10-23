import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { type ObjectStore, temporaryObjectDirectory } from "./object-store.js";
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
}
/** Local scratch of Attempts that never finished publishing, older than `graceMs`. */
export async function findOrphanStaging(
  stagingRoot: string,
  graceMs = 24 * 60 * 60 * 1000,
  now = Date.now(),
): Promise<StagingOrphan[]> {
  const root = new ConfinedRoot(stagingRoot);
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
      if (ageMs >= graceMs) result.push({ relativePath: relative(stagingRoot, path), ageMs });
      return;
    }
    for (const entry of entries)
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(join(path, entry.name));
  }
  try {
    await walk(join(stagingRoot, "staging"));
    return result;
  } finally {
    root.close();
  }
}
/**
 * Removes the scratch files a crashed `put` left under `.tm-put/` once they outlive `graceMs`.
 * Nothing references them, so age alone decides; a live write keeps refreshing its mtime.
 */
export async function sweepTemporaryObjects(
  rootDir: string,
  graceMs = 24 * 60 * 60 * 1000,
  now = Date.now(),
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(rootDir, temporaryObjectDirectory));
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
    throw error;
  }
  const removed: string[] = [];
  const root = new ConfinedRoot(rootDir);
  try {
    for (const name of names.sort()) {
      const path = `${temporaryObjectDirectory}/${name}`;
      const details = await lstat(join(rootDir, path)).catch(() => null);
      if (!details?.isFile() || now - details.mtimeMs < graceMs) continue;
      await root.unlink(path);
      removed.push(path);
    }
  } finally {
    root.close();
  }
  return removed;
}
export interface PublishedOrphan {
  /** `runs/<workspace>/<run>/<attempt>`: the published bundle no database row references yet. */
  bundleKey: string;
  ageMs: number;
}
/**
 * Bundles that were published and whose pending marker (`publishMarkerKey`) is still there after
 * `graceMs`: a crash between publication and the database reference, or a publication that never
 * reached its commit marker `meta.json`. The marker is cleared once the database references the
 * bundle, so a live Attempt's bundle is a candidate too and the collector's safety port decides.
 */
export async function findOrphanPublished(
  store: ObjectStore,
  options: { workspaceId?: string; graceMs?: number; now?: number } = {},
): Promise<PublishedOrphan[]> {
  const graceMs = options.graceMs ?? 24 * 60 * 60 * 1000;
  const now = options.now ?? Date.now();
  const result: PublishedOrphan[] = [];
  for await (const object of store.list(
    options.workspaceId ? `pending/${options.workspaceId}/` : "pending/",
  )) {
    const parts = object.key.split("/");
    const ageMs = Math.max(0, now - object.modifiedAt.getTime());
    if (parts.length === 4 && ageMs >= graceMs)
      result.push({ bundleKey: `runs/${parts.slice(1).join("/")}`, ageMs });
  }
  return result;
}
/**
 * Runs every candidate through the safety port and removes the ones it permits through `remove`.
 * Order is the contract: inspect, mark, tombstone (which rechecks and revokes read authorization),
 * remove, then report deleted.
 */
async function collect(
  candidates: readonly GcCandidate[],
  port: GcPort,
  remove: (relativePath: string) => Promise<void>,
): Promise<string[]> {
  const removed: string[] = [];
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
    await remove(candidate.relativePath);
    await port.deleted({ ...candidate, version: permit.version });
    removed.push(candidate.relativePath);
  }
  return removed;
}
/** Removes permitted local scratch directories (`findOrphanStaging` results). */
export async function collectStagingGarbage(
  stagingRoot: string,
  candidates: readonly GcCandidate[],
  port: GcPort,
): Promise<string[]> {
  const root = new ConfinedRoot(stagingRoot);
  try {
    return await collect(candidates, port, (path) => root.remove(path));
  } finally {
    root.close();
  }
}
/**
 * Removes permitted published objects: a candidate is a key or a key prefix (a bundle), and
 * everything under it goes. A bundle loses its commit marker `meta.json` first and its pending
 * marker last, so an interrupted removal leaves an uncommitted bundle the next sweep still finds.
 */
export async function collectGarbage(
  store: ObjectStore,
  candidates: readonly GcCandidate[],
  port: GcPort,
): Promise<string[]> {
  return collect(candidates, port, async (path) => {
    const parts = path.split("/");
    const bundle = parts[0] === "runs" && parts.length === 4;
    if (bundle) await store.delete(`${path}/meta.json`);
    else await store.delete(path);
    for await (const object of store.list(`${path}/`)) await store.delete(object.key);
    if (bundle) await store.delete(`pending/${parts.slice(1).join("/")}`);
  });
}
