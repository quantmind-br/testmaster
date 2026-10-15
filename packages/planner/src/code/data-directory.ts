import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Resolves symlinks in the deepest existing ancestor of `path`; missing tails stay lexical. */
function realpathLoose(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    const parent = dirname(path);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path) throw error;
    return join(realpathLoose(parent), basename(path));
  }
}

/**
 * Repository-relative POSIX prefixes under which the project data directory lives (the directory
 * itself, and the symlink that points at it when it is one). The process that scans the repository
 * also holds the SQLite connection in that directory; opening and closing any of its files here
 * would drop the process's POSIX locks on them (fcntl locks are released on any close), so these
 * paths are never read. Empty when the directory is outside the repository or is the repository.
 */
export function dataDirectoryPrefixes(repoRoot: string, dataDir: string | undefined): string[] {
  if (!dataDir) return [];
  const root = realpathLoose(repoRoot);
  const lexical = resolve(dataDir);
  const candidates = new Set([
    realpathLoose(lexical),
    join(realpathLoose(dirname(lexical)), basename(lexical)),
  ]);
  const prefixes: string[] = [];
  for (const candidate of candidates) {
    const path = relative(root, candidate);
    if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) continue;
    prefixes.push(path.split(sep).join("/"));
  }
  return prefixes;
}

/** True when a repository-relative path (or a `dir/` entry) is one of, or inside, the prefixes. */
export function insideDataDirectory(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
