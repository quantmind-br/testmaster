import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PassThrough, type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ContractError } from "@testmaster/contracts";
import { FileObjectStore, type ObjectStore, type S3ObjectStore } from "@testmaster/evidence";
import { type BackupKey, encryptStream } from "./backup-crypto.js";
import type { S3BackupDestination, ServerConfig } from "./server-config.js";
import { openS3Store } from "./storage-config.js";

/*
 * Where a backup lives. A filesystem destination keeps `<destination>/<name>/` and renames it from
 * `.partial-<backupId>` last. An S3 destination keeps the same files under the key prefix
 * `<name>/` and publishes the backup by putting `manifest.json` last with a conditional put: S3
 * has no rename, so a backup whose manifest is absent was never finished, whatever else exists.
 * Nothing is ever overwritten, and nothing is deleted by a crashed or failed backup (the bucket's
 * Object Lock would refuse it anyway), so the objects of an unfinished backup stay as invisible
 * orphans that retention collects once their lock has expired.
 */

export type BackupDestination = string | S3BackupDestination;

export const isS3Destination = (
  destination: BackupDestination,
): destination is S3BackupDestination => typeof destination !== "string";

/** `<UTC timestamp>-<backupId>`: the directory name on a filesystem, the key prefix on S3. */
export const backupNamePattern = /^\d{8}T\d{6}Z-[A-Za-z0-9-]+$/u;
export const manifestFile = "manifest.json";

/**
 * S3 layout. `catalog/<name>.json` is the backup's manifest and its commit marker, put last; every
 * other file is `data/<name>/<relative path>`. A backup is listed only by its catalog entry.
 */
export const catalogPrefix = "catalog/";
export const dataPrefix = "data/";
export const catalogKey = (name: string): string => `${catalogPrefix}${name}.json`;
const objectKey = (name: string, relativePath: string): string =>
  relativePath === manifestFile ? catalogKey(name) : `${dataPrefix}${name}/${relativePath}`;

export interface WrittenFile {
  sizeBytes: number;
  sha256: string;
  plainBytes: number;
}

export const integrityFailure = (relativePath: string): ContractError =>
  new ContractError("PRECONDITION_FAILED", `Backup integrity failure: ${relativePath}`, {
    reasonCode: "backup_integrity",
  });

/** SHA-256 and length of everything `source` yields. */
export async function streamDigest(
  source: AsyncIterable<unknown>,
): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of source) {
    hash.update(chunk as Buffer);
    sizeBytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

async function readAll(source: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** The JSON document stored at `key`; a missing object is an integrity failure of the backup. */
export async function readStoreJson(store: ObjectStore, key: string): Promise<unknown> {
  const body = await store.get(key);
  if (!body) throw integrityFailure(key);
  return JSON.parse((await readAll(body)).toString("utf8"));
}

/** Encrypts `source` and reports the ciphertext hash and size next to the plaintext length. */
function encryptingTap(source: NodeJS.ReadableStream, key: BackupKey, context: string) {
  const hash = createHash("sha256");
  const counted = { sizeBytes: 0, plainBytes: 0 };
  const count = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      counted.plainBytes += chunk.length;
      callback(null, chunk);
    },
  });
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      counted.sizeBytes += chunk.length;
      callback(null, chunk);
    },
  });
  return {
    stages: [source, count, encryptStream(key, context), tap] as const,
    finish: (): WrittenFile => ({ ...counted, sha256: hash.digest("hex") }),
  };
}

export interface BackupReader {
  readJson(relativePath: string): Promise<unknown>;
  /** The size of a regular, unshared file; anything else is an integrity failure. */
  size(relativePath: string): Promise<number>;
  open(relativePath: string): Promise<Readable>;
  close(): void;
}

export interface BackupWriter extends BackupReader {
  /** The finished backup's directory, or its name (key prefix) in an S3 destination. */
  readonly location: string;
  writeEncrypted(
    relativePath: string,
    source: NodeJS.ReadableStream,
    key: BackupKey,
    context: string,
  ): Promise<WrittenFile>;
  /** Keeps the manifest until `commit`; a filesystem writes it into the unfinished directory. */
  stageManifest(json: string): Promise<void>;
  /** Makes the backup visible: a rename on a filesystem, the conditional manifest put on S3. */
  commit(): Promise<void>;
  /** Drops what an unfinished backup left that can be dropped. */
  abort(): Promise<void>;
}

class FileBackupReader implements BackupReader {
  constructor(protected readonly directory: string) {}

  async readJson(relativePath: string): Promise<unknown> {
    return JSON.parse(await readFile(join(this.directory, relativePath), "utf8"));
  }

  async size(relativePath: string): Promise<number> {
    const info = await lstat(join(this.directory, relativePath));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw integrityFailure(relativePath);
    return info.size;
  }

  async open(relativePath: string): Promise<Readable> {
    return createReadStream(join(this.directory, relativePath));
  }

  close(): void {}
}

class S3BackupReader implements BackupReader {
  constructor(
    protected readonly store: S3ObjectStore,
    protected readonly name: string,
  ) {}

  async readJson(relativePath: string): Promise<unknown> {
    return readStoreJson(this.store, objectKey(this.name, relativePath));
  }

  async size(relativePath: string): Promise<number> {
    const head = await this.store.head(objectKey(this.name, relativePath));
    if (!head) throw integrityFailure(relativePath);
    return head.sizeBytes;
  }

  async open(relativePath: string): Promise<Readable> {
    const body = await this.store.get(objectKey(this.name, relativePath));
    if (!body) throw integrityFailure(relativePath);
    return body;
  }

  close(): void {
    this.store.close();
  }
}

class FileBackupWriter extends FileBackupReader implements BackupWriter {
  readonly location: string;

  constructor(destination: string, backupId: string, name: string) {
    super(join(destination, `.partial-${backupId}`));
    this.location = join(destination, name);
  }

  async writeEncrypted(
    relativePath: string,
    source: NodeJS.ReadableStream,
    key: BackupKey,
    context: string,
  ): Promise<WrittenFile> {
    const target = join(this.directory, relativePath);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const tap = encryptingTap(source, key, context);
    await pipeline(...tap.stages, createWriteStream(target, { mode: 0o600, flags: "wx" }));
    const handle = await open(target, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return tap.finish();
  }

  async stageManifest(json: string): Promise<void> {
    const path = join(this.directory, manifestFile);
    await writeFile(path, json, { mode: 0o600 });
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async commit(): Promise<void> {
    await rename(this.directory, this.location);
  }

  async abort(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }
}

class S3BackupWriter extends S3BackupReader implements BackupWriter {
  private manifest: string | undefined;

  get location(): string {
    return this.name;
  }

  async writeEncrypted(
    relativePath: string,
    source: NodeJS.ReadableStream,
    key: BackupKey,
    context: string,
  ): Promise<WrittenFile> {
    const tap = encryptingTap(source, key, context);
    const through = new PassThrough();
    const encrypting = pipeline(...tap.stages, through);
    let stored: { created: boolean; sizeBytes: number; sha256: string };
    try {
      [, stored] = await Promise.all([
        encrypting,
        this.store.put(objectKey(this.name, relativePath), through, { ifNoneMatch: true }),
      ]);
    } catch (error) {
      through.destroy();
      throw error;
    }
    const written = tap.finish();
    if (!stored.created)
      throw new ContractError("PRECONDITION_FAILED", "A backup object already exists", {
        reasonCode: "backup_object_exists",
        relativePath,
      });
    if (stored.sha256 !== written.sha256 || stored.sizeBytes !== written.sizeBytes)
      throw integrityFailure(relativePath);
    return written;
  }

  async stageManifest(json: string): Promise<void> {
    this.manifest = json;
  }

  async commit(): Promise<void> {
    if (this.manifest === undefined) throw new Error("The manifest was not staged");
    const stored = await this.store.put(catalogKey(this.name), this.manifest, {
      ifNoneMatch: true,
    });
    if (!stored.created)
      throw new ContractError("PRECONDITION_FAILED", "A backup manifest already exists", {
        reasonCode: "backup_object_exists",
        relativePath: manifestFile,
      });
  }

  async abort(): Promise<void> {
    // Written objects may be under Object Lock and are never removed here; without a manifest
    // they are invisible and retention collects them once their lock expires.
  }
}

export async function openBackupWriter(
  destination: BackupDestination,
  backupId: string,
  name: string,
): Promise<BackupWriter> {
  if (isS3Destination(destination)) return new S3BackupWriter(await openS3Store(destination), name);
  const root = resolve(destination);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const writer = new FileBackupWriter(root, backupId, name);
  await mkdir(join(root, `.partial-${backupId}`), { mode: 0o700 });
  return writer;
}

/** Reads the finished backup `directory` of the configured destination (a name on S3). */
export async function openBackupReader(
  server: ServerConfig,
  directory: string,
): Promise<BackupReader> {
  const destination = server.backup?.destination;
  if (destination && isS3Destination(destination)) {
    if (!backupNamePattern.test(directory))
      throw new ContractError("INVALID_ARGUMENT", "Not a backup name", {
        reasonCode: "backup_name_invalid",
      });
    return new S3BackupReader(await openS3Store(destination), directory);
  }
  return new FileBackupReader(resolve(directory));
}

/**
 * Names of the finished backups: one small `catalog/<name>.json` object each, so the cost of
 * listing follows the number of backups and never the number of evidence objects.
 */
export async function listS3Catalog(store: Pick<ObjectStore, "list">): Promise<string[]> {
  const names: string[] = [];
  for await (const object of store.list(catalogPrefix)) {
    const match = /^catalog\/(.+)\.json$/u.exec(object.key);
    if (match?.[1] && backupNamePattern.test(match[1])) names.push(match[1]);
  }
  return names;
}

/** Names that hold data objects, finished or not, found with a delimiter and without reading below. */
export async function listS3DataNames(store: S3ObjectStore): Promise<string[]> {
  const names: string[] = [];
  for await (const prefix of store.listPrefixes(dataPrefix)) {
    const name = prefix.slice(dataPrefix.length, -1);
    if (backupNamePattern.test(name)) names.push(name);
  }
  return names;
}

/** Every data object of one backup and the newest modification time among them. */
export async function listS3Data(
  store: ObjectStore,
  name: string,
): Promise<{ keys: string[]; newest: Date }> {
  const keys: string[] = [];
  let newest = new Date(0);
  for await (const object of store.list(`${dataPrefix}${name}/`)) {
    keys.push(object.key);
    if (object.modifiedAt > newest) newest = object.modifiedAt;
  }
  return { keys, newest };
}

/** The evidence store a backup reads, built from the profile's storage unless one is supplied. */
export async function openEvidenceSource(
  server: ServerConfig,
  supplied?: ObjectStore,
): Promise<{ store: ObjectStore; close(): void }> {
  if (supplied) return { store: supplied, close: () => undefined };
  if (server.storage.kind === "s3") {
    const store = await openS3Store(server.storage);
    return { store, close: () => store.close() };
  }
  return { store: new FileObjectStore(server.storage.root), close: () => undefined };
}

/**
 * Where a restore puts evidence. The target must be empty, or hold only an interrupted restore
 * (recognised by its marker), which is wiped. The marker stays until every step finished.
 */
export interface EvidenceSink {
  prepare(fault: (point: "restore.marker_written") => void): Promise<void>;
  write(storageKey: string, plain: Readable): Promise<void>;
  /** Removes what `write` stored, after the plaintext turned out not to match the index. */
  discard(storageKey: string): Promise<void>;
  complete(): Promise<void>;
  close(): void;
}

const fileMarker = ".tm-restore-pending";
const objectMarker = "tm-restore-pending";

class FileEvidenceSink implements EvidenceSink {
  constructor(private readonly root: string) {}

  async prepare(): Promise<void> {
    const entries = await readdir(this.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (entries && entries.length > 0 && !entries.includes(fileMarker)) throw notEmpty();
    if (entries)
      for (const entry of entries)
        await rm(join(this.root, entry), { recursive: true, force: true });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await writeFile(join(this.root, fileMarker), new Date().toISOString(), { mode: 0o600 });
  }

  async write(storageKey: string, plain: Readable): Promise<void> {
    const target = join(this.root, storageKey);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await pipeline(plain, createWriteStream(target, { mode: 0o600, flags: "wx" }));
  }

  async discard(storageKey: string): Promise<void> {
    await rm(join(this.root, storageKey), { force: true });
  }

  async complete(): Promise<void> {
    await rm(join(this.root, fileMarker), { force: true });
  }

  close(): void {}
}

class ObjectEvidenceSink implements EvidenceSink {
  constructor(private readonly store: S3ObjectStore) {}

  async prepare(fault: (point: "restore.marker_written") => void): Promise<void> {
    const keys: string[] = [];
    for await (const object of this.store.list("")) keys.push(object.key);
    if (keys.length > 0 && !keys.includes(objectMarker)) throw notEmpty();
    // The marker goes first: a crash while wiping then still leaves a target a rerun may wipe.
    await this.store.put(objectMarker, new Date().toISOString());
    fault("restore.marker_written");
    for (const key of keys) if (key !== objectMarker) await this.store.delete(key);
  }

  async write(storageKey: string, plain: Readable): Promise<void> {
    const stored = await this.store.put(storageKey, plain, { ifNoneMatch: true });
    if (!stored.created) throw notEmpty();
  }

  async discard(storageKey: string): Promise<void> {
    await this.store.delete(storageKey);
  }

  async complete(): Promise<void> {
    await this.store.delete(objectMarker);
  }

  close(): void {
    this.store.close();
  }
}

const notEmpty = (): ContractError =>
  new ContractError("PRECONDITION_FAILED", "Restore evidence root is not empty", {
    reasonCode: "restore_target_not_empty",
  });

export async function openEvidenceSink(storage: ServerConfig["storage"]): Promise<EvidenceSink> {
  if (storage.kind === "s3") return new ObjectEvidenceSink(await openS3Store(storage));
  return new FileEvidenceSink(resolve(storage.root));
}
