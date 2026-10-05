import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import yauzl from "yauzl";
import { ConfinedRoot, validateRelativePath } from "./path.js";

export interface ArchiveLimits {
  maxMembers?: number;
  maxBytes?: number;
  maxRatio?: number;
}
export class ArchiveLimitError extends Error {
  readonly code = "ARCHIVE_REJECTED";
  constructor(message: string) {
    super(message);
    this.name = "ArchiveLimitError";
  }
}
function memberName(name: string): string {
  validateRelativePath(name);
  if (/\.(zip|tar|tgz|gz|bz2|xz|7z|rar)$/i.test(name))
    throw new ArchiveLimitError("Nested archives are prohibited");
  return name;
}
function archiveMagic(bytes: Uint8Array): boolean {
  const b = Buffer.from(bytes);
  return (
    b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4])) ||
    b.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])) ||
    b.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0])) ||
    b.subarray(0, 3).toString() === "BZh" ||
    b.subarray(0, 6).toString() === "7z\xbc\xaf\x27\x1c" ||
    b.subarray(0, 4).toString() === "Rar!" ||
    b.subarray(257, 262).toString() === "ustar"
  );
}
async function copyMember(
  root: ConfinedRoot,
  name: string,
  stream: Readable,
  declared: number,
  limit: number,
): Promise<number> {
  const file = await root.openFile(name, true);
  let size = 0;
  let prefix = Buffer.alloc(0);
  try {
    for await (const raw of stream) {
      const chunk = Buffer.from(raw as Uint8Array);
      size += chunk.length;
      if (size > declared || size > limit)
        throw new ArchiveLimitError("Archive real byte limit exceeded");
      if (prefix.length < 512) {
        prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)]);
        if (archiveMagic(prefix))
          throw new ArchiveLimitError("Nested archive content is prohibited");
      }
      await file.writeFile(chunk);
    }
    if (size !== declared) throw new ArchiveLimitError("Archive member size mismatch");
    await file.sync();
    return size;
  } finally {
    await file.close();
  }
}
async function staging(
  destination: string,
): Promise<{ parent: ConfinedRoot; root: ConfinedRoot; temp: string; name: string }> {
  const absolute = resolve(destination);
  const parent = new ConfinedRoot(dirname(absolute), true);
  const temp = `.tm-archive-${randomUUID()}`;
  parent.mkdirExclusive(temp);
  return {
    parent,
    root: parent.openDirectory(temp),
    temp,
    name: validateRelativePath(basename(absolute)),
  };
}
export async function extractZip(
  input: string | Uint8Array,
  destination: string,
  limits: ArchiveLimits = {},
): Promise<void> {
  const maxMembers = limits.maxMembers ?? 10_000,
    maxBytes = limits.maxBytes ?? 256 * 1024 * 1024,
    maxRatio = limits.maxRatio ?? 100;
  const stage = await staging(destination);
  let zip: yauzl.ZipFile | undefined;
  try {
    zip = await new Promise<yauzl.ZipFile>((resolveZip, reject) => {
      const callback = (error: Error | null, file?: yauzl.ZipFile): void => {
        if (error) reject(error);
        else if (file) resolveZip(file);
        else reject(new Error("Unable to open ZIP"));
      };
      if (typeof input === "string")
        yauzl.open(input, { lazyEntries: true, strictFileNames: true }, callback);
      else
        yauzl.fromBuffer(
          Buffer.from(input),
          { lazyEntries: true, strictFileNames: true },
          callback,
        );
    });
    const archive = zip;
    const seen = new Set<string>();
    let count = 0,
      total = 0;
    await new Promise<void>((resolveDone, reject) => {
      archive.once("error", reject);
      archive.once("end", resolveDone);
      archive.on("entry", (entry) => {
        void (async () => {
          const name = memberName(entry.fileName);
          if (++count > maxMembers || seen.has(name))
            throw new ArchiveLimitError("Archive duplicate/member count violation");
          seen.add(name);
          if (
            !Number.isSafeInteger(entry.uncompressedSize) ||
            entry.uncompressedSize > Math.max(1, entry.compressedSize) * maxRatio ||
            total + entry.uncompressedSize > maxBytes
          )
            throw new ArchiveLimitError("Archive expansion limit exceeded");
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (mode !== 0 && mode !== 0x8000)
            throw new ArchiveLimitError("Archive links/devices are prohibited");
          const stream = await new Promise<Readable>((res, rej) =>
            archive.openReadStream(entry, (error, stream) => {
              if (error) rej(error);
              else if (stream) res(stream);
              else rej(new Error("ZIP entry unavailable"));
            }),
          );
          total += await copyMember(
            stage.root,
            name,
            stream,
            entry.uncompressedSize,
            maxBytes - total,
          );
          archive.readEntry();
        })().catch(reject);
      });
      archive.readEntry();
    });
    await stage.root.sync();
    await stage.parent.rename(stage.temp, stage.name);
    await stage.parent.sync();
  } catch (error) {
    zip?.close();
    await stage.parent.remove(stage.temp);
    throw error;
  } finally {
    zip?.close();
    stage.root.close();
    stage.parent.close();
  }
}
export async function extractTar(
  input: string | Uint8Array,
  destination: string,
  limits: ArchiveLimits = {},
): Promise<void> {
  const maxMembers = limits.maxMembers ?? 10_000,
    maxBytes = limits.maxBytes ?? 256 * 1024 * 1024;
  const stage = await staging(destination);
  const extractor = tar.extract();
  const seen = new Set<string>();
  let count = 0,
    total = 0;
  const done = new Promise<void>((resolveDone, reject) => {
    extractor.once("finish", resolveDone);
    extractor.once("error", reject);
  });
  extractor.on("entry", (header, stream, next) => {
    void (async () => {
      const name = memberName(header.name);
      if (++count > maxMembers || seen.has(name))
        throw new ArchiveLimitError("Archive duplicate/member count violation");
      seen.add(name);
      if (header.type !== "file" || header.linkname)
        throw new ArchiveLimitError("Tar links/devices are prohibited");
      const size = Number(header.size);
      if (!Number.isSafeInteger(size) || size < 0 || total + size > maxBytes)
        throw new ArchiveLimitError("Archive expansion limit exceeded");
      total += await copyMember(
        stage.root,
        name,
        stream as unknown as Readable,
        size,
        maxBytes - total,
      );
      next();
    })().catch((error) => {
      stream.resume();
      next(error as Error);
    });
  });
  try {
    if (typeof input === "string")
      await Promise.all([pipeline(createReadStream(input), extractor), done]);
    else {
      extractor.end(Buffer.from(input));
      await done;
    }
    await stage.root.sync();
    await stage.parent.rename(stage.temp, stage.name);
    await stage.parent.sync();
  } catch (error) {
    extractor.destroy();
    await stage.parent.remove(stage.temp);
    throw error;
  } finally {
    stage.root.close();
    stage.parent.close();
  }
}
