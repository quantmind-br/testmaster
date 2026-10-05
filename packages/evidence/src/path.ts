import { closeSync, constants, fstatSync, mkdirSync, openSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, rename, rm, unlink } from "node:fs/promises";
import { isAbsolute, resolve, win32 } from "node:path";

export class UnsafePathError extends Error {
  readonly code = "UNSAFE_PATH";
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}
export function validateRelativePath(path: string): string {
  if (
    !path ||
    [...path].some((character) => (character.codePointAt(0) ?? 0) < 0x20) ||
    path.includes("\\") ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new UnsafePathError(`Unsafe relative path: ${JSON.stringify(path)}`);
  return path;
}
export function confinedPath(root: string, path: string): string {
  return resolve(root, validateRelativePath(path));
}

/** Linux fd-relative operations: every ancestor is pinned before accessing its child. */
export class ConfinedRoot {
  readonly fd: number;
  constructor(
    readonly path: string,
    create = false,
  ) {
    if (process.platform !== "linux")
      throw new UnsafePathError("Descriptor confinement requires Linux /proc/self/fd");
    let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      for (const component of resolve(path).split("/").filter(Boolean)) {
        if (create) {
          try {
            mkdirSync(`/proc/self/fd/${fd}/${component}`, { mode: 0o700 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
        const next = openSync(
          `/proc/self/fd/${fd}/${component}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        closeSync(fd);
        fd = next;
      }
      this.fd = fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  close(): void {
    closeSync(this.fd);
  }
  private parent(path: string, create: boolean): { fd: number; name: string; close: () => void } {
    const parts = validateRelativePath(path).split("/");
    const name = parts.pop() as string;
    let fd = this.fd;
    const opened: number[] = [];
    try {
      for (const part of parts) {
        const child = `/proc/self/fd/${fd}/${part}`;
        if (create) {
          try {
            mkdirSync(child, { mode: 0o700 });
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          }
        }
        fd = openSync(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        opened.push(fd);
      }
      return {
        fd,
        name,
        close: () => {
          for (const handle of opened.reverse()) closeSync(handle);
        },
      };
    } catch (e) {
      for (const handle of opened.reverse()) closeSync(handle);
      throw e;
    }
  }
  async openFile(path: string, write = false): Promise<FileHandle> {
    const parent = this.parent(path, write);
    try {
      const file = await open(
        `/proc/self/fd/${parent.fd}/${parent.name}`,
        constants.O_NOFOLLOW |
          (write ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL : constants.O_RDONLY) |
          constants.O_NONBLOCK,
        0o600,
      );
      const stat = fstatSync(file.fd);
      if (!stat.isFile() || stat.nlink !== 1) {
        await file.close();
        throw new UnsafePathError("Artifacts must be regular single-link files");
      }
      return file;
    } finally {
      parent.close();
    }
  }
  openDirectory(path: string): ConfinedRoot {
    const p = this.parent(path, false);
    try {
      const fd = openSync(
        `/proc/self/fd/${p.fd}/${p.name}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      return Object.assign(Object.create(ConfinedRoot.prototype) as ConfinedRoot, {
        fd,
        path: `${this.path}/${path}`,
      });
    } finally {
      p.close();
    }
  }
  mkdirExclusive(path: string): void {
    const p = this.parent(path, true);
    try {
      mkdirSync(`/proc/self/fd/${p.fd}/${p.name}`, { mode: 0o700 });
    } finally {
      p.close();
    }
  }
  async rename(from: string, to: string): Promise<void> {
    const a = this.parent(from, false);
    const b = this.parent(to, true);
    try {
      await rename(`/proc/self/fd/${a.fd}/${a.name}`, `/proc/self/fd/${b.fd}/${b.name}`);
    } finally {
      a.close();
      b.close();
    }
  }
  async unlink(path: string): Promise<void> {
    const p = this.parent(path, false);
    try {
      await unlink(`/proc/self/fd/${p.fd}/${p.name}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    } finally {
      p.close();
    }
  }
  async remove(path: string): Promise<void> {
    const p = this.parent(path, false);
    try {
      await rm(`/proc/self/fd/${p.fd}/${p.name}`, { recursive: true, force: true });
    } finally {
      p.close();
    }
  }
  async sync(): Promise<void> {
    const handle = await open(`/proc/self/fd/${this.fd}`, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
