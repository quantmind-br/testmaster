import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { UnsafePathError, validateRelativePath } from "@testmaster/evidence";
import { agentSkillHash } from "./managed.js";

/** The skill directory holds this record of what was installed; it is never part of the shipped tree. */
export const SKILL_MANIFEST_NAME = ".testmaster-manifest.json";
/** The entry point of every skill tree; it additionally carries the ownership marker. */
export const SKILL_ENTRY_NAME = "SKILL.md";

export interface SkillTreeFile {
  /** Path relative to the skill directory, `/`-separated. */
  path: string;
  bytes: Buffer;
}
export interface SkillManifestEntry {
  path: string;
  sha256: string;
  size: number;
}

/** Reads every regular file under a skill content directory, sorted by path; other entry types are not content. */
export async function readSkillTree(directory: string): Promise<SkillTreeFile[]> {
  const files: SkillTreeFile[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        if (path === SKILL_MANIFEST_NAME)
          throw new UnsafePathError("Skill content uses a reserved name");
        files.push({
          path: validateRelativePath(path),
          bytes: await readFile(join(directory, path)),
        });
      }
    }
  };
  await walk("");
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function manifestEntry(path: string, bytes: Buffer): SkillManifestEntry {
  return { path, sha256: agentSkillHash(bytes), size: bytes.length };
}

/** Canonical manifest bytes: entries sorted by path, two-space indentation, trailing newline. */
export function renderManifest(version: string, entries: readonly SkillManifestEntry[]): Buffer {
  const files = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return Buffer.from(`${JSON.stringify({ schema: 1, version, files }, null, 2)}\n`);
}

/** Null when the bytes are not a well-formed manifest; paths are validated so they cannot leave the skill directory. */
export function parseManifest(bytes: Buffer): SkillManifestEntry[] | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as {
      schema?: unknown;
      version?: unknown;
      files?: unknown;
    } | null;
    if (
      typeof value !== "object" ||
      value === null ||
      value.schema !== 1 ||
      typeof value.version !== "string" ||
      !Array.isArray(value.files)
    )
      return null;
    const seen = new Set<string>();
    const entries: SkillManifestEntry[] = [];
    for (const item of value.files as Record<string, unknown>[]) {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof item.path !== "string" ||
        typeof item.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.sha256) ||
        typeof item.size !== "number" ||
        !Number.isSafeInteger(item.size) ||
        item.size < 0 ||
        item.path === SKILL_MANIFEST_NAME ||
        seen.has(item.path)
      )
        return null;
      validateRelativePath(item.path);
      seen.add(item.path);
      entries.push({ path: item.path, sha256: item.sha256, size: item.size });
    }
    return entries;
  } catch {
    return null;
  }
}
