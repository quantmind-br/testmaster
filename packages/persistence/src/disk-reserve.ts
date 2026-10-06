import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Preallocated blocks, not a sparse file; kept outside backups and never used for artifacts. */
export function ensureControlPlaneReserve(databasePath: string): void {
  if (databasePath === ":memory:") return;
  const path = join(dirname(databasePath), ".control-plane.reserve");
  if (existsSync(path)) return;
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  try {
    const block = Buffer.alloc(65536);
    for (let offset = 0; offset < 4 * 1024 * 1024; offset += block.length) writeSync(fd, block);
    fsyncSync(fd);
  } catch (error) {
    unlinkSync(path);
    throw error;
  } finally {
    closeSync(fd);
  }
}

/** Free real blocks before control-plane recovery writes; reserve replenishment requires restart. */
export function releaseControlPlaneReserve(databasePath: string): void {
  if (databasePath === ":memory:") return;
  try {
    unlinkSync(join(dirname(databasePath), ".control-plane.reserve"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
