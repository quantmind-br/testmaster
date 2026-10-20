import { readdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { ContractError } from "@testmaster/contracts";
import { ConfinedRoot } from "@testmaster/evidence";

/**
 * Opens `path` as a pinned directory handle, creating it when it is missing. The path may name a
 * new or an existing empty directory; a directory with entries is refused with `nonEmptyMessage`.
 * No link on the way is followed: the parent is walked by descriptor and the leaf opened with
 * `O_NOFOLLOW`.
 */
export async function openEmptyDirectory(
  path: string,
  nonEmptyMessage: string,
): Promise<ConfinedRoot> {
  const absolute = resolve(path);
  const parent = new ConfinedRoot(dirname(absolute), true);
  try {
    try {
      parent.mkdirExclusive(basename(absolute));
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      if (failure.code !== "EEXIST") throw error;
    }
    const root = parent.openDirectory(basename(absolute));
    try {
      if ((await readdir(`/proc/self/fd/${root.fd}`)).length)
        throw new ContractError("INVALID_ARGUMENT", nonEmptyMessage);
      return root;
    } catch (error) {
      root.close();
      throw error;
    }
  } finally {
    parent.close();
  }
}
