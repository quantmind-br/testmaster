import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { ConfinedRoot, UnsafePathError } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";

/**
 * Every file the CLI reads or writes on behalf of a user-supplied path goes through here. The
 * parent directory is opened component by component without following symbolic links and the file
 * itself is opened with `O_NOFOLLOW` against that pinned directory, so a `..` or a link anywhere in
 * the path cannot redirect the access to another location after the path was resolved. This guards
 * against path mistakes; it does not make a path a security boundary against a user who already
 * has a shell.
 */
function refusal(path: string, error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // O_NOFOLLOW on a symbolic link fails with ELOOP, and together with O_DIRECTORY with ENOTDIR.
  if (error instanceof UnsafePathError || code === "ELOOP" || code === "ENOTDIR")
    return new ContractError(
      "FORBIDDEN",
      "Path goes through a symbolic link, a parent that is not a directory, or a file that is not a regular single-link file",
      { path },
    );
  return error;
}

function openParent(absolute: string, create: boolean): ConfinedRoot {
  try {
    return new ConfinedRoot(dirname(absolute), create);
  } catch (error) {
    throw refusal(absolute, error);
  }
}

/** The bytes of one regular file; a link anywhere on the path is refused. */
export async function readConfinedFile(absolute: string): Promise<Buffer> {
  const parent = openParent(absolute, false);
  try {
    const file = await parent.openFile(basename(absolute));
    try {
      return await file.readFile();
    } finally {
      await file.close();
    }
  } catch (error) {
    throw refusal(absolute, error);
  } finally {
    parent.close();
  }
}

export interface WriteConfinedOptions {
  /** Permission bits of the new file before the umask; owner-only unless the output is public. */
  mode?: number;
  /** Creates missing parent directories (owner-only), like `mkdir -p`. */
  createParents?: boolean;
  /**
   * Replaces an existing file atomically (a sibling temporary file renamed over it) instead of
   * refusing it. A link at the destination is replaced, never followed.
   */
  replace?: boolean;
}

/**
 * Creates one regular file with the bytes. Unless `replace` is set it never replaces an existing
 * file: `EEXIST` propagates so each command can say what it refuses.
 */
export async function writeConfinedFile(
  absolute: string,
  data: string | Uint8Array,
  options: WriteConfinedOptions = {},
): Promise<void> {
  const parent = openParent(absolute, options.createParents === true);
  const name = basename(absolute);
  const target = options.replace === true ? `.${name}.${randomUUID()}.tmp` : name;
  try {
    const file = await parent.openFile(target, true, options.mode ?? 0o600);
    try {
      await file.writeFile(data);
      await file.close();
      if (target !== name) await parent.rename(target, name);
    } catch (error) {
      await file.close().catch(() => {});
      if (target !== name) await parent.unlink(target);
      throw error;
    }
  } catch (error) {
    throw refusal(absolute, error);
  } finally {
    parent.close();
  }
}

/**
 * Validates a path that an application service reads or writes by itself: no link on the way to
 * it and none as its last component. The path, and some of its parent directories, may not exist
 * yet; the nearest existing ancestor is the one that is checked.
 */
export async function confineServicePath(absolute: string): Promise<string> {
  for (let ancestor = dirname(absolute); ; ancestor = dirname(ancestor)) {
    try {
      new ConfinedRoot(ancestor).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || ancestor === dirname(ancestor))
        throw refusal(absolute, error);
    }
  }
  try {
    if ((await lstat(absolute)).isSymbolicLink())
      throw new ContractError("FORBIDDEN", "Path goes through a symbolic link", {
        path: absolute,
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return absolute;
}
