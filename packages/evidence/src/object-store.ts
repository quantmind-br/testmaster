import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { Agent as HttpsAgent } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  ListObjectVersionsCommand,
  type ListObjectVersionsCommandOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { ContractError } from "@testmaster/contracts";
import { ConfinedRoot, UnsafePathError, validateRelativePath } from "./path.js";

export interface ObjectInfo {
  key: string;
  sizeBytes: number;
  modifiedAt: Date;
}
export type ObjectBody = Uint8Array | string | AsyncIterable<Uint8Array>;
/**
 * Where published evidence lives. Keys are `/`-separated relative paths (`validateRelativePath`);
 * the caller derives them server-side, never from a client string. Objects are immutable once
 * published: `ifNoneMatch` is the only way a writer claims a key, atomically.
 */
export interface ObjectStore {
  readonly kind: "filesystem" | "s3";
  /** Writes the whole object; with `ifNoneMatch` an existing key is left untouched and `created` is false. */
  put(
    key: string,
    body: ObjectBody,
    options?: { ifNoneMatch?: boolean },
  ): Promise<{ created: boolean; sizeBytes: number; sha256: string }>;
  /** null when absent. `range` is inclusive [start, end]. */
  get(key: string, range?: { start: number; end: number }): Promise<Readable | null>;
  head(key: string): Promise<{ sizeBytes: number } | null>;
  /** Keys under `prefix`, any depth. */
  list(prefix: string): AsyncIterable<ObjectInfo>;
  /** Idempotent. */
  delete(key: string): Promise<void>;
}

async function* chunksOf(body: ObjectBody): AsyncGenerator<Uint8Array> {
  if (typeof body === "string") yield Buffer.from(body);
  else if (body instanceof Uint8Array) yield body;
  else yield* body;
}
function errnoOf(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Scratch directory of in-flight writes; never listed, always on the same file system as the keys. */
export const temporaryObjectDirectory = ".tm-put";

/** Reads a pinned file through one buffer that every chunk reuses, closing the file at the end. */
async function* borrowedChunks(file: FileHandle): AsyncGenerator<Uint8Array> {
  const buffer = Buffer.allocUnsafe(128 * 1024);
  try {
    for (let position = 0; ; ) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (!bytesRead) return;
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await file.close();
  }
}

/**
 * The bytes of `key` for a reader that consumes each chunk before asking for the next (hashing,
 * forwarding): borrowed from a reused buffer on the file system, fresh chunks on S3. Null when absent.
 */
export async function readObjectChunks(
  store: ObjectStore,
  key: string,
): Promise<AsyncIterable<Uint8Array> | null> {
  return store instanceof FileObjectStore ? store.borrow(key) : store.get(key);
}

/**
 * Objects as files under one directory: the layout evidence has always had on disk. A write goes
 * to a temporary file that is fsynced and then linked (`ifNoneMatch`, fails with EEXIST instead of
 * replacing) or renamed into place, so a reader sees the whole object or none and a claim has
 * exactly one winner without a check-then-write gap.
 */
export class FileObjectStore implements ObjectStore {
  readonly kind = "filesystem" as const;
  constructor(readonly rootDir: string) {}

  /** The absolute path of `key`; for operators and compatibility fields only, never for reading. */
  locate(key: string): string {
    return `${this.rootDir}/${validateRelativePath(key)}`;
  }

  async put(
    key: string,
    body: ObjectBody,
    options: { ifNoneMatch?: boolean } = {},
  ): Promise<{ created: boolean; sizeBytes: number; sha256: string }> {
    validateRelativePath(key);
    const root = new ConfinedRoot(this.rootDir, true);
    const temporary = `${temporaryObjectDirectory}/${randomUUID()}`;
    try {
      const hash = createHash("sha256");
      let sizeBytes = 0;
      const file = await root.openFile(temporary, true);
      try {
        for await (const chunk of chunksOf(body)) {
          hash.update(chunk);
          sizeBytes += chunk.byteLength;
          await file.writeFile(chunk);
        }
        await file.sync();
      } finally {
        await file.close();
      }
      let created = true;
      for (let attempt = 0; ; attempt++) {
        try {
          if (options.ifNoneMatch) await root.link(temporary, key);
          else await root.rename(temporary, key);
          break;
        } catch (error) {
          if (options.ifNoneMatch && errnoOf(error) === "EEXIST") {
            created = false;
            break;
          }
          // `delete` prunes empty directories, which can race a directory this call just created.
          if (errnoOf(error) === "ENOENT" && attempt < 4) continue;
          throw error;
        }
      }
      if (created) await root.syncParent(key);
      return { created, sizeBytes, sha256: hash.digest("hex") };
    } finally {
      await root.unlink(temporary).catch(() => undefined);
      root.close();
    }
  }

  async get(key: string, range?: { start: number; end: number }): Promise<Readable | null> {
    const file = await this.open(key);
    if (!file) return null;
    return file.createReadStream(range ? { start: range.start, end: range.end } : {});
  }

  /**
   * Reads `key` through one reused buffer, or null when absent. A chunk is valid only until the
   * next one is requested, so verifying or serving a large object allocates nothing per chunk.
   */
  async borrow(key: string): Promise<AsyncGenerator<Uint8Array> | null> {
    const file = await this.open(key);
    return file ? borrowedChunks(file) : null;
  }

  async head(key: string): Promise<{ sizeBytes: number } | null> {
    const file = await this.open(key);
    if (!file) return null;
    try {
      return { sizeBytes: (await file.stat()).size };
    } finally {
      await file.close();
    }
  }

  async *list(prefix: string): AsyncGenerator<ObjectInfo> {
    if (prefix) validateRelativePath(prefix.replace(/\/$/, ""));
    const slash = prefix.lastIndexOf("/");
    const directory = slash < 0 ? "" : prefix.slice(0, slash);
    yield* this.walk(directory, prefix);
  }

  async delete(key: string): Promise<void> {
    validateRelativePath(key);
    let root: ConfinedRoot;
    try {
      root = new ConfinedRoot(this.rootDir);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return;
      throw error;
    }
    try {
      try {
        await root.unlink(key);
      } catch (error) {
        // A directory is a prefix, not an object: there is nothing to delete at that key.
        if (["ENOENT", "ENOTDIR", "EISDIR"].includes(errnoOf(error) ?? "")) return;
        throw error;
      }
      // Directories exist only to hold keys: an emptied bundle leaves no residue behind.
      const parts = key.split("/");
      parts.pop();
      while (parts.length && (await root.removeEmptyDirectory(parts.join("/")))) parts.pop();
    } finally {
      root.close();
    }
  }

  private async open(key: string): Promise<FileHandle | null> {
    validateRelativePath(key);
    let root: ConfinedRoot;
    try {
      root = new ConfinedRoot(this.rootDir);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return null;
      throw error;
    }
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await root.openFile(key);
        } catch (error) {
          if (["ENOENT", "ENOTDIR"].includes(errnoOf(error) ?? "")) return null;
          // A `ifNoneMatch` write holds the object under two names for an instant before it drops the temporary one.
          if (error instanceof UnsafePathError && attempt < 3) {
            await delay(5);
            continue;
          }
          throw error;
        }
      }
    } finally {
      root.close();
    }
  }

  private async *walk(directory: string, prefix: string): AsyncGenerator<ObjectInfo> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory ? join(this.rootDir, directory) : this.rootDir, {
        withFileTypes: true,
      });
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(errnoOf(error) ?? "")) return;
      throw error;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const key = directory ? `${directory}/${entry.name}` : entry.name;
      if (!directory && entry.name === temporaryObjectDirectory) continue;
      if (entry.isDirectory()) {
        if (`${key}/`.startsWith(prefix) || prefix.startsWith(`${key}/`))
          yield* this.walk(key, prefix);
      } else if (entry.isFile() && key.startsWith(prefix)) {
        try {
          const details = await lstat(join(this.rootDir, key));
          yield { key, sizeBytes: details.size, modifiedAt: details.mtime };
        } catch (error) {
          if (errnoOf(error) !== "ENOENT") throw error;
        }
      }
    }
  }
}

export interface S3StoreOptions {
  endpoint: string;
  region: string;
  bucket: string;
  /** Key prefix inside the bucket (a deployment choice, never taken from a client). */
  prefix?: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  /** PEM of the CA that signed the endpoint's certificate. */
  caPem?: string;
}

/** The HTTP status the service answered with, when the failure came from a response. */
function status(error: unknown): number | undefined {
  if (!(error instanceof Error) || !("$metadata" in error)) return undefined;
  const metadata = error.$metadata;
  return typeof metadata === "object" && metadata !== null && "httpStatusCode" in metadata
    ? Number(metadata.httpStatusCode)
    : undefined;
}
function notFound(error: unknown): boolean {
  return (
    status(error) === 404 ||
    (error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name))
  );
}

/** Every failure the store cannot attribute to an absent key or a lost claim is an outage, never a fallback. */
function storageUnavailable(operation: string, error: unknown): ContractError {
  if (error instanceof ContractError) return error;
  const name = error instanceof Error ? error.name : undefined;
  return new ContractError("UNAVAILABLE", `Object store ${operation} failed`, {
    reasonCode: "storage_unavailable",
    operation,
    ...(name ? { errorName: name } : {}),
    ...(status(error) ? { httpStatus: status(error) } : {}),
  });
}

/**
 * Whether the service refused a version removal because of Object Lock. MinIO answers
 * `InvalidRequest` (400, "WORM protected"); AWS answers `AccessDenied` naming the lock. A plain
 * `AccessDenied` is a missing permission, not a lock.
 */
function retentionRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "InvalidRequest" && status(error) === 400) return true;
  return error.name === "AccessDenied" && /object lock|WORM|retention/iu.test(error.message);
}

/**
 * Objects in an S3-compatible bucket. Every put carries its SHA-256 (`ChecksumSHA256`, verified by
 * the service) and is confirmed by a HEAD before it returns (spec 08 §7.1.2), so a reference is
 * never published for bytes the store does not hold. A body of unknown length is spooled to a
 * private temporary file first: the checksum must precede the bytes and the size is needed up
 * front. Bodies are bounded by the evidence quotas, far below the 5 GiB single-PUT limit, so no
 * multipart upload is used. Claims (`ifNoneMatch`) are never retried by the SDK: a retry after a
 * lost response would report the caller's own object as someone else's.
 */
export class S3ObjectStore implements ObjectStore {
  readonly kind = "s3" as const;
  private readonly client: S3Client;
  private readonly claimClient: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: S3StoreOptions) {
    const common = {
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      requestChecksumCalculation: "WHEN_REQUIRED" as const,
      responseChecksumValidation: "WHEN_REQUIRED" as const,
      ...(options.caPem
        ? { requestHandler: { httpsAgent: new HttpsAgent({ ca: options.caPem, keepAlive: true }) } }
        : {}),
    };
    this.client = new S3Client({ ...common, maxAttempts: 3 });
    this.claimClient = new S3Client({ ...common, maxAttempts: 1 });
    this.bucket = options.bucket;
    this.prefix = options.prefix ? `${options.prefix.replace(/\/+$/, "")}/` : "";
  }

  /** Releases the connection pools; the store is unusable afterwards. */
  close(): void {
    this.client.destroy();
    this.claimClient.destroy();
  }

  private keyFor(key: string): string {
    return `${this.prefix}${validateRelativePath(key)}`;
  }

  async put(
    key: string,
    body: ObjectBody,
    options: { ifNoneMatch?: boolean } = {},
  ): Promise<{ created: boolean; sizeBytes: number; sha256: string }> {
    const objectKey = this.keyFor(key);
    const hash = createHash("sha256");
    let buffer: Buffer | undefined;
    let spoolDirectory: string | undefined;
    let spoolPath: string | undefined;
    let sizeBytes = 0;
    try {
      if (typeof body === "string" || body instanceof Uint8Array) {
        buffer = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
        hash.update(buffer);
        sizeBytes = buffer.byteLength;
      } else {
        spoolDirectory = await mkdtemp(join(tmpdir(), "tm-s3-spool-"));
        spoolPath = join(spoolDirectory, "body");
        const spool = await open(spoolPath, "wx", 0o600);
        try {
          for await (const chunk of body) {
            hash.update(chunk);
            sizeBytes += chunk.byteLength;
            await spool.writeFile(chunk);
          }
        } finally {
          await spool.close();
        }
      }
      const digest = hash.digest();
      const checksum = digest.toString("base64");
      const client = options.ifNoneMatch ? this.claimClient : this.client;
      for (let attempt = 0; ; attempt++) {
        try {
          await client.send(
            new PutObjectCommand({
              Bucket: this.bucket,
              Key: objectKey,
              Body: buffer ?? createReadStream(spoolPath as string),
              ContentLength: sizeBytes,
              ChecksumSHA256: checksum,
              ...(options.ifNoneMatch ? { IfNoneMatch: "*" } : {}),
            }),
          );
          break;
        } catch (error) {
          if (options.ifNoneMatch && status(error) === 412)
            return { created: false, sizeBytes, sha256: digest.toString("hex") };
          // A concurrent claim of the same key asks the loser to retry; the retry then sees 412.
          if (options.ifNoneMatch && status(error) === 409 && attempt < 3) {
            await delay(20 * (attempt + 1));
            continue;
          }
          throw storageUnavailable("put", error);
        }
      }
      let stored: HeadObjectCommandOutput;
      try {
        stored = await this.client.send(
          new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey, ChecksumMode: "ENABLED" }),
        );
      } catch (error) {
        throw storageUnavailable("head", error);
      }
      if (
        stored.ContentLength !== sizeBytes ||
        (stored.ChecksumSHA256 !== undefined && stored.ChecksumSHA256 !== checksum)
      )
        throw new ContractError("UNAVAILABLE", "Object store kept different bytes than were sent", {
          reasonCode: "storage_unavailable",
          operation: "put",
        });
      return { created: true, sizeBytes, sha256: digest.toString("hex") };
    } finally {
      if (spoolDirectory) await rm(spoolDirectory, { recursive: true, force: true });
    }
  }

  async get(key: string, range?: { start: number; end: number }): Promise<Readable | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.keyFor(key),
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
      );
      return response.Body as Readable;
    } catch (error) {
      if (notFound(error)) return null;
      throw storageUnavailable("get", error);
    }
  }

  async head(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.keyFor(key) }),
      );
      return { sizeBytes: response.ContentLength ?? 0 };
    } catch (error) {
      if (notFound(error)) return null;
      throw storageUnavailable("head", error);
    }
  }

  async *list(prefix: string): AsyncGenerator<ObjectInfo> {
    if (prefix) validateRelativePath(prefix.replace(/\/$/, ""));
    let token: string | undefined;
    do {
      let page: ListObjectsV2CommandOutput;
      try {
        page = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: `${this.prefix}${prefix}`,
            ...(token ? { ContinuationToken: token } : {}),
          }),
        );
      } catch (error) {
        throw storageUnavailable("list", error);
      }
      for (const item of page.Contents ?? [])
        if (item.Key)
          yield {
            key: item.Key.slice(this.prefix.length),
            sizeBytes: item.Size ?? 0,
            modifiedAt: item.LastModified ?? new Date(0),
          };
      token = page.NextContinuationToken;
    } while (token);
  }

  /**
   * The first-level "directories" under `prefix` (`prefix` must end in `/`), found with a
   * delimiter, so the cost follows the number of directories and not the number of objects below
   * them. Each result is a full prefix ending in `/`.
   */
  async *listPrefixes(prefix: string): AsyncGenerator<string> {
    if (prefix) validateRelativePath(prefix.replace(/\/$/, ""));
    let token: string | undefined;
    do {
      let page: ListObjectsV2CommandOutput;
      try {
        page = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: `${this.prefix}${prefix}`,
            Delimiter: "/",
            ...(token ? { ContinuationToken: token } : {}),
          }),
        );
      } catch (error) {
        throw storageUnavailable("list", error);
      }
      for (const item of page.CommonPrefixes ?? [])
        if (item.Prefix) yield item.Prefix.slice(this.prefix.length);
      token = page.NextContinuationToken;
    } while (token);
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: this.keyFor(key) }),
      );
    } catch (error) {
      if (!notFound(error)) throw storageUnavailable("delete", error);
    }
  }

  /**
   * Removes every version of `key`, delete markers included, so nothing of it stays recoverable.
   * An Object Lock retention that has not expired refuses the removal of its version: that is
   * reported as `locked` (nothing is thrown, and the versions already removed stay removed), while
   * any other refusal, a missing permission included, is an outage. A plain `delete` on a locked
   * bucket would only add a delete marker and hide the object, which is why backups use this.
   */
  async deleteVersions(key: string): Promise<{ deleted: true } | { deleted: false; locked: true }> {
    const objectKey = this.keyFor(key);
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    const versions: { versionId: string }[] = [];
    do {
      let page: ListObjectVersionsCommandOutput;
      try {
        page = await this.client.send(
          new ListObjectVersionsCommand({
            Bucket: this.bucket,
            Prefix: objectKey,
            ...(keyMarker ? { KeyMarker: keyMarker } : {}),
            ...(versionMarker ? { VersionIdMarker: versionMarker } : {}),
          }),
        );
      } catch (error) {
        throw storageUnavailable("list", error);
      }
      for (const item of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])])
        if (item.Key === objectKey && item.VersionId) versions.push({ versionId: item.VersionId });
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker || versionMarker);
    for (const { versionId } of versions) {
      try {
        await this.client.send(
          new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey, VersionId: versionId }),
        );
      } catch (error) {
        if (retentionRefusal(error)) return { deleted: false, locked: true };
        if (!notFound(error)) throw storageUnavailable("delete", error);
      }
    }
    return { deleted: true };
  }
}
