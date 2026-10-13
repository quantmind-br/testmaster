import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  access,
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
import { createInterface } from "node:readline";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ContractError, validate } from "@testmaster/contracts";
import {
  applyRestoreTightening,
  type BackupManifest,
  defaultPgTools,
  finalizeRestore,
  loadMigrationsSync,
  PersistenceDatabase,
  type PgTools,
  type PostgresConfig,
  parseCopyRows,
  prepareRestoreTarget,
  type RestoreTighteningOptions,
  type SqlRow,
  startPgDump,
  startPgRestore,
  startPgRestoreDataExport,
  startPgRestoreList,
} from "@testmaster/persistence";
import {
  type BackupKey,
  backupChunkBytes,
  canonicalJson,
  decryptStream,
  encryptStream,
  manifestMac,
  readKeyFile,
  verifyManifestMac,
} from "./backup-crypto.js";
import { filesystemRoot, type ServerConfig } from "./server-config.js";

/**
 * Server-profile backup and restore (ADR-019, OPS-024).
 *
 * Backup layout: `<destination>/<UTC timestamp>-<backupId>/` holds `manifest.json` (authenticated
 * with an HMAC, listing ciphertext hashes), `database.dump.enc` (a `pg_dump` custom archive taken
 * with `--serializable-deferrable`), `evidence-index.json.enc` and `evidence/<storage key>.enc`.
 * Everything is written to `.partial-<backupId>` and renamed last, so a listing never shows an
 * unfinished backup.
 */
export type BackupFaultHook = (point: string) => void;

export interface ServerBackupResult {
  backupId: string;
  directory: string;
  manifest: BackupManifest;
  evidenceComplete: boolean;
  missingObjects: string[];
}

export interface ServerBackupParams {
  database: PersistenceDatabase;
  server: ServerConfig;
  tools?: PgTools;
  now?: () => Date;
  backupId?: string;
  /** Test seam: called at every write boundary; throwing simulates a crash there. */
  faultHook?: BackupFaultHook;
}

interface EvidenceRef {
  workspace_id: string;
  id: string;
  storage_key: string;
  hash: string;
  bytes: number;
  state: string;
}
interface EvidenceIndexDocument {
  exportVersion: "1.0.0";
  createdAt: string;
  artifactRefs: EvidenceRef[];
  missingObjects: string[];
  complete: boolean;
  configDigests: string[];
  keyIds: string[];
}

const holdHours = 48;
const exportedTables = [
  "artifacts",
  "fixture_inputs",
  "snapshots",
  "operational_state",
  "schema_migrations",
];

export function backupSettings(server: ServerConfig): NonNullable<ServerConfig["backup"]> {
  if (!server.backup)
    throw new ContractError("PRECONDITION_FAILED", "Server backup is not configured", {
      reasonCode: "backup_not_configured",
      nextActions: ["Set backup.destination in the server configuration"],
    });
  return server.backup;
}

export function pgToolsFor(server: ServerConfig): PgTools {
  const settings = server.backup;
  return {
    pgDump: settings?.pgDump ?? defaultPgTools.pgDump,
    pgRestore: settings?.pgRestore ?? defaultPgTools.pgRestore,
  };
}

const compactTime = (date: Date): string =>
  date.toISOString().replace(/[-:]/gu, "").replace(/\.\d+/u, "");

function safeStorageKey(key: string): boolean {
  return !(
    key.startsWith("/") ||
    key.split(/[\\/]/u).some((part) => part === ".." || part === "." || !part)
  );
}

interface WrittenFile {
  sizeBytes: number;
  sha256: string;
  plainBytes: number;
}

/** Streams `source` through encryption into `target`, hashing the ciphertext as it is written. */
async function writeEncrypted(
  target: string,
  source: NodeJS.ReadableStream,
  key: BackupKey,
  context: string,
): Promise<WrittenFile> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const hash = createHash("sha256");
  let sizeBytes = 0;
  let plainBytes = 0;
  const count = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      plainBytes += chunk.length;
      callback(null, chunk);
    },
  });
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      sizeBytes += chunk.length;
      callback(null, chunk);
    },
  });
  await pipeline(
    source,
    count,
    encryptStream(key, context),
    tap,
    createWriteStream(target, { mode: 0o600, flags: "wx" }),
  );
  const handle = await open(target, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { sizeBytes, sha256: hash.digest("hex"), plainBytes };
}

async function fileDigest(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    sizeBytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

/** A read-only `pg_restore` may exit once it has what it needs; a closed stdin is then not an error. */
function ignoreClosedInput(error: unknown): void {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code !== "EPIPE" && code !== "ERR_STREAM_PREMATURE_CLOSE" && code !== "ERR_STREAM_DESTROYED")
    throw error;
}

/** Reads artifact and snapshot references out of an encrypted dump without a database. */
async function readDumpState(
  dumpPath: string,
  key: BackupKey,
  tools: PgTools,
): Promise<{
  refs: EvidenceRef[];
  snapshots: { workspace_id: string; run_id: string; attempt_id: string }[];
  version: number;
}> {
  const reader = startPgRestoreDataExport(exportedTables, tools);
  const feeding = pipeline(
    createReadStream(dumpPath),
    decryptStream(key, "database.dump"),
    reader.stdin,
  ).catch(ignoreClosedInput);
  const refs: EvidenceRef[] = [];
  const fixtures: EvidenceRef[] = [];
  const snapshots: { workspace_id: string; run_id: string; attempt_id: string }[] = [];
  const retired = new Set<string>();
  let version = 0;
  const consume = (async () => {
    const lines = createInterface({ input: reader.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const row of parseCopyRows(lines)) {
      const values = row.values;
      if (row.table === "artifacts")
        refs.push({
          workspace_id: String(values.workspace_id),
          id: String(values.id),
          storage_key: String(values.storage_key),
          hash: String(values.hash ?? ""),
          bytes: Number(values.bytes),
          state: String(values.state),
        });
      else if (row.table === "fixture_inputs")
        fixtures.push({
          workspace_id: String(values.workspace_id),
          id: String(values.id),
          storage_key: String(values.storage_key),
          hash: String(values.content_hash),
          bytes: Number(values.size_bytes),
          state: "available",
        });
      else if (row.table === "snapshots")
        snapshots.push({
          workspace_id: String(values.workspace_id),
          run_id: String(values.run_id),
          attempt_id: String(values.attempt_id),
        });
      else if (row.table === "operational_state") {
        const match = /^retention:(?:artifact|deletion):(ws_[0-9a-f-]+):(art_[0-9a-f-]+)$/u.exec(
          String(values.key),
        );
        if (match) retired.add(`${match[1]}:${match[2]}`);
      } else if (row.table === "schema_migrations")
        version = Math.max(version, Number(values.version));
    }
  })();
  await Promise.all([feeding, consume, reader.done]);
  for (const fixture of fixtures)
    if (retired.has(`${fixture.workspace_id}:${fixture.id}`)) fixture.state = "expired";
  return { refs: [...refs, ...fixtures], snapshots, version };
}

/**
 * Takes one consistent, encrypted backup of the database and the evidence tree. Holds are written
 * before the dump so retention cannot remove an object the dump references while it is copied.
 */
export async function createServerBackup(params: ServerBackupParams): Promise<ServerBackupResult> {
  const { database, server } = params;
  const settings = backupSettings(server);
  const tools = params.tools ?? pgToolsFor(server);
  const now = params.now ?? (() => new Date());
  const fault = params.faultHook ?? (() => undefined);
  const key = await readKeyFile(server.security.backupKeyFile, "security.backupKeyFile");
  const evidenceRoot = resolve(filesystemRoot(server.storage));
  const backupId = params.backupId ?? randomUUID();
  const createdAt = now();
  const name = `${compactTime(createdAt)}-${backupId}`;
  const destination = resolve(settings.destination);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const partial = join(destination, `.partial-${backupId}`);
  await mkdir(partial, { mode: 0o700 });
  const final = join(destination, name);
  try {
    const expiresAt = new Date(createdAt.getTime() + holdHours * 3_600_000).toISOString();
    database.withTx(() => {
      for (const artifact of database.all<{ workspace_id: string; id: string }>(
        "SELECT workspace_id,id FROM artifacts WHERE state='available'",
      ))
        database.run(
          "INSERT INTO backup_object_holds(workspace_id,artifact_id,backup_id,expires_at) VALUES(?,?,?,?)",
          artifact.workspace_id,
          artifact.id,
          backupId,
          expiresAt,
        );
      for (const fixture of database.all<{ workspace_id: string; id: string }>(
        "SELECT workspace_id,id FROM fixture_inputs",
      ))
        database.run(
          "INSERT INTO operational_state(key,value) VALUES(?,?)",
          `retention:fixture-backup:${fixture.workspace_id}:${fixture.id}:${backupId}`,
          expiresAt,
        );
    });
    fault("backup.holds");
    const files: BackupManifest["files"] = [];
    const dumpPath = join(partial, "database.dump.enc");
    const dump = startPgDump(database_config(server), tools);
    const [written] = await Promise.all([
      writeEncrypted(dumpPath, dump.stdout, key, "database.dump"),
      dump.done,
    ]).catch((error) => {
      dump.kill();
      throw error;
    });
    files.push({
      relativePath: "database.dump.enc",
      sizeBytes: written.sizeBytes,
      sha256: written.sha256,
    });
    fault("backup.dump");
    const state = await readDumpState(dumpPath, key, tools);
    const missingObjects: string[] = [];
    const copied = new Set<string>();
    const copy = async (storageKey: string, expected: { hash?: string; bytes?: number }) => {
      if (!safeStorageKey(storageKey))
        throw new ContractError("INTERNAL", "Unsafe evidence storage key");
      if (copied.has(storageKey)) return true;
      const source = join(evidenceRoot, storageKey);
      try {
        const info = await lstat(source);
        const digest = await fileDigest(source);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.nlink !== 1 ||
          (expected.bytes !== undefined && info.size !== expected.bytes) ||
          (expected.hash && digest.sha256 !== expected.hash)
        )
          return false;
        const relativePath = `evidence/${storageKey}.enc`;
        const result = await writeEncrypted(
          join(partial, relativePath),
          createReadStream(source),
          key,
          relativePath.slice(0, -4),
        );
        if (result.plainBytes !== info.size) return false;
        files.push({ relativePath, sizeBytes: result.sizeBytes, sha256: result.sha256 });
        copied.add(storageKey);
        return true;
      } catch {
        return false;
      }
    };
    for (const ref of state.refs) {
      if (ref.state !== "available") {
        missingObjects.push(ref.id);
        continue;
      }
      if (!(await copy(ref.storage_key, { hash: ref.hash, bytes: ref.bytes })))
        missingObjects.push(ref.id);
    }
    for (const row of state.snapshots)
      for (const file of ["manifest.json", "meta.json"]) {
        const storageKey = `runs/${row.workspace_id}/${row.run_id}/${row.attempt_id}/${file}`;
        if (!(await copy(storageKey, {}))) missingObjects.push(storageKey);
      }
    fault("backup.evidence");
    const configDigests = [
      createHash("sha256")
        .update(canonicalJson({ ...server, security: undefined }))
        .digest("hex"),
    ];
    const keyIds: string[] = [];
    try {
      keyIds.push(
        (await readKeyFile(server.security.masterKeyFile, "security.masterKeyFile")).keyId,
      );
    } catch {
      // The agent may be denied the master key; the manifest then omits its identifier.
    }
    const index: EvidenceIndexDocument = {
      exportVersion: "1.0.0",
      createdAt: createdAt.toISOString(),
      artifactRefs: state.refs,
      missingObjects,
      complete: missingObjects.length === 0,
      configDigests,
      keyIds,
    };
    const indexFile = await writeEncrypted(
      join(partial, "evidence-index.json.enc"),
      (() => {
        const stream = new PassThrough();
        stream.end(JSON.stringify(index));
        return stream;
      })(),
      key,
      "evidence-index.json",
    );
    files.push({
      relativePath: "evidence-index.json.enc",
      sizeBytes: indexFile.sizeBytes,
      sha256: indexFile.sha256,
    });
    fault("backup.index");
    const unsigned = {
      schemaVersion: "1.0.0" as const,
      createdAt: createdAt.toISOString(),
      files,
      databaseVersion: state.version,
      secretIncluded: false as const,
      keyIds,
      configDigests,
      missingObjects,
      engine: "postgres" as const,
      backupId,
      encryption: {
        algorithm: "aes-256-gcm-chunked" as const,
        keyId: key.keyId,
        chunkBytes: backupChunkBytes,
      },
    };
    const manifest = validate<BackupManifest & { mac: string }>("BackupManifest", {
      ...unsigned,
      mac: manifestMac(key, unsigned),
    });
    await writeFile(join(partial, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    const handle = await open(join(partial, "manifest.json"), "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    fault("backup.manifest");
    await rename(partial, final);
    fault("backup.renamed");
    database.run(
      "INSERT INTO operational_state(key,value) VALUES('backup:last-success',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      JSON.stringify({
        backupId,
        at: createdAt.toISOString(),
        complete: index.complete,
        keyId: key.keyId,
      }),
    );
    return {
      backupId,
      directory: final,
      manifest,
      evidenceComplete: index.complete,
      missingObjects,
    };
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    database.run(
      "INSERT INTO operational_state(key,value) VALUES('backup:last-failure',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      JSON.stringify({
        backupId,
        at: now().toISOString(),
        reasonCode:
          error instanceof ContractError
            ? String(error.details.reasonCode ?? error.code)
            : "backup_failed",
      }),
    );
    throw error;
  }
}

function database_config(server: ServerConfig): PostgresConfig {
  const { engine: _engine, ...config } = server.database;
  return config;
}

export interface BackupListing {
  backupId: string;
  directory: string;
  createdAt: string;
  databaseVersion: number;
  /** True when the manifest MAC verified with the backup key. */
  authentic: boolean;
  complete: boolean;
}

async function readManifest(directory: string): Promise<BackupManifest & { mac?: string }> {
  return validate<BackupManifest & { mac?: string }>(
    "BackupManifest",
    JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")),
  );
}

/** Lists finished backups in the destination, newest first. */
export async function listServerBackups(
  destination: string,
  key: BackupKey,
): Promise<BackupListing[]> {
  let names: string[];
  try {
    names = await readdir(resolve(destination));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const listings: BackupListing[] = [];
  for (const name of names.filter((entry) => /^\d{8}T\d{6}Z-/u.test(entry))) {
    const directory = join(resolve(destination), name);
    try {
      const manifest = await readManifest(directory);
      listings.push({
        backupId: String(manifest.backupId ?? name),
        directory,
        createdAt: manifest.createdAt,
        databaseVersion: manifest.databaseVersion,
        authentic: manifest.engine === "postgres" && verifyManifestMac(key, manifest),
        complete: (manifest.missingObjects ?? []).length === 0,
      });
    } catch {
      listings.push({
        backupId: name,
        directory,
        createdAt: new Date(0).toISOString(),
        databaseVersion: 0,
        authentic: false,
        complete: false,
      });
    }
  }
  return listings.sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
}

export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
}
export const defaultRetention: RetentionPolicy = { daily: 7, weekly: 4, monthly: 3 };

function isoWeek(date: Date): string {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - day);
  const first = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((copy.getTime() - first.getTime()) / 86_400_000 + 1) / 7);
  return `${copy.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Chooses which backups to keep: the newest backup of each of the last `daily` days, `weekly`
 * ISO weeks and `monthly` months that have one. Unauthentic entries are never selected for
 * deletion automatically. Pure, so the policy is testable without a filesystem.
 */
export function selectRetention(
  backups: readonly { backupId: string; createdAt: string; authentic: boolean }[],
  policy: RetentionPolicy,
): { keep: string[]; remove: string[] } {
  const sorted = [...backups]
    .filter((backup) => backup.authentic)
    .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
  const keep = new Set<string>();
  const buckets: [number, (date: Date) => string][] = [
    [policy.daily, (date) => date.toISOString().slice(0, 10)],
    [policy.weekly, isoWeek],
    [policy.monthly, (date) => date.toISOString().slice(0, 7)],
  ];
  for (const [limit, bucketOf] of buckets) {
    const seen = new Set<string>();
    for (const backup of sorted) {
      const bucket = bucketOf(new Date(backup.createdAt));
      if (seen.has(bucket)) continue;
      if (seen.size >= limit) break;
      seen.add(bucket);
      keep.add(backup.backupId);
    }
  }
  return {
    keep: sorted.filter((backup) => keep.has(backup.backupId)).map((backup) => backup.backupId),
    remove: sorted.filter((backup) => !keep.has(backup.backupId)).map((backup) => backup.backupId),
  };
}

/** Applies the retention policy to the destination and removes expired backups. */
export async function applyServerBackupRetention(
  server: ServerConfig,
  options: { faultHook?: BackupFaultHook } = {},
): Promise<{ kept: string[]; removed: string[]; unauthentic: string[] }> {
  const settings = backupSettings(server);
  const key = await readKeyFile(server.security.backupKeyFile, "security.backupKeyFile");
  const listings = await listServerBackups(settings.destination, key);
  const policy = settings.retention ?? defaultRetention;
  const decision = selectRetention(listings, policy);
  for (const id of decision.remove) {
    const target = listings.find((listing) => listing.backupId === id);
    if (!target) continue;
    options.faultHook?.("retention.remove");
    await rm(target.directory, { recursive: true, force: true });
  }
  return {
    kept: decision.keep,
    removed: decision.remove,
    unauthentic: listings
      .filter((listing) => !listing.authentic)
      .map((listing) => listing.backupId),
  };
}

export interface VerificationReport {
  backupId: string;
  createdAt: string;
  filesChecked: number;
  evidenceObjects: number;
  archiveEntries: number;
  keyId: string;
  complete: boolean;
}

async function verifyFiles(
  directory: string,
  manifest: BackupManifest & { mac?: string },
  key: BackupKey,
): Promise<void> {
  if (manifest.engine !== "postgres" || !manifest.encryption)
    throw new ContractError("PRECONDITION_FAILED", "Not an encrypted server-profile backup", {
      reasonCode: "backup_not_server_profile",
    });
  if (!verifyManifestMac(key, manifest))
    throw new ContractError("PRECONDITION_FAILED", "Backup manifest authentication failed", {
      reasonCode: "backup_manifest_mac",
    });
  if (manifest.encryption.keyId !== key.keyId)
    throw new ContractError("PRECONDITION_FAILED", "Backup was encrypted with a different key", {
      reasonCode: "backup_key_mismatch",
    });
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (seen.has(file.relativePath))
      throw new ContractError("PRECONDITION_FAILED", "Duplicate backup file");
    seen.add(file.relativePath);
    const path = join(directory, file.relativePath);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== file.sizeBytes)
      throw new ContractError(
        "PRECONDITION_FAILED",
        `Backup integrity failure: ${file.relativePath}`,
        {
          reasonCode: "backup_integrity",
        },
      );
    if ((await fileDigest(path)).sha256 !== file.sha256)
      throw new ContractError(
        "PRECONDITION_FAILED",
        `Backup integrity failure: ${file.relativePath}`,
        {
          reasonCode: "backup_integrity",
        },
      );
  }
  if (!seen.has("database.dump.enc") || !seen.has("evidence-index.json.enc"))
    throw new ContractError("PRECONDITION_FAILED", "Backup requires database and evidence index");
}

async function readIndex(directory: string, key: BackupKey): Promise<EvidenceIndexDocument> {
  const chunks: Buffer[] = [];
  await pipeline(
    createReadStream(join(directory, "evidence-index.json.enc")),
    decryptStream(key, "evidence-index.json"),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    }),
  );
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as EvidenceIndexDocument;
}

/** Decrypts and hashes every evidence object, returning the plaintext digest. */
async function decryptTo(
  source: string,
  key: BackupKey,
  context: string,
  target: string | null,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  if (target) {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await pipeline(
      createReadStream(source),
      decryptStream(key, context),
      tap,
      createWriteStream(target, { mode: 0o600, flags: "wx" }),
    );
  } else {
    await pipeline(
      createReadStream(source),
      decryptStream(key, context),
      tap,
      new Transform({ transform: (_chunk, _encoding, callback) => callback() }),
    );
  }
  return { sha256: hash.digest("hex"), bytes };
}

/**
 * Verifies a backup without touching a database: manifest MAC, key id, ciphertext hashes, full
 * authenticated decryption of every file, evidence digests and `pg_restore --list` over the dump.
 */
export async function verifyServerBackup(
  directory: string,
  server: ServerConfig,
  tools: PgTools = pgToolsFor(server),
): Promise<VerificationReport> {
  const key = await readKeyFile(server.security.backupKeyFile, "security.backupKeyFile");
  const absolute = resolve(directory);
  const manifest = await readManifest(absolute);
  await verifyFiles(absolute, manifest, key);
  const index = await readIndex(absolute, key);
  const expected = new Map(index.artifactRefs.map((ref) => [ref.storage_key, ref]));
  let evidenceObjects = 0;
  for (const file of manifest.files.filter((entry) => entry.relativePath.startsWith("evidence/"))) {
    const context = file.relativePath.slice(0, -4);
    const storageKey = context.slice("evidence/".length);
    const result = await decryptTo(join(absolute, file.relativePath), key, context, null);
    const ref = expected.get(storageKey);
    if (ref?.hash && result.sha256 !== ref.hash)
      throw new ContractError(
        "PRECONDITION_FAILED",
        `Backup integrity failure: ${file.relativePath}`,
        {
          reasonCode: "backup_integrity",
        },
      );
    evidenceObjects += 1;
  }
  const list = startPgRestoreList(tools);
  let archiveEntries = 0;
  const reading = (async () => {
    const lines = createInterface({ input: list.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) if (line && !line.startsWith(";")) archiveEntries += 1;
  })();
  // `pg_restore --list` stops after the table of contents; the whole dump is authenticated here.
  await decryptTo(join(absolute, "database.dump.enc"), key, "database.dump", null);
  await Promise.all([
    pipeline(
      createReadStream(join(absolute, "database.dump.enc")),
      decryptStream(key, "database.dump"),
      list.stdin,
    ).catch(ignoreClosedInput),
    reading,
    list.done,
  ]);
  return {
    backupId: String(manifest.backupId),
    createdAt: manifest.createdAt,
    filesChecked: manifest.files.length,
    evidenceObjects,
    archiveEntries,
    keyId: key.keyId,
    complete: index.complete,
  };
}

/** Post-backup revocations and tombstones read from the live ledger of a still-reachable database. */
export function readLiveLedger(
  database: PersistenceDatabase,
): Omit<RestoreTighteningOptions, "evidenceComplete"> {
  return {
    ledgerAvailable: true,
    revocations: database.all<SqlRow>(
      "SELECT workspace_id,id,secret_version,revoked_at FROM secret_references",
    ),
    tombstones: database.all<SqlRow>(
      "SELECT key,value FROM operational_state WHERE key LIKE 'retention:%' OR key LIKE 'image:revoked:%' OR key LIKE 'integration:revoked:%'",
    ),
    consentRevocations: database.all<SqlRow>(
      "SELECT workspace_id,id,revoked_at FROM consents WHERE revoked_at IS NOT NULL",
    ),
    approvalRevocations: database.all<SqlRow>(
      "SELECT workspace_id,id,revoked_at FROM approvals WHERE revoked_at IS NOT NULL",
    ),
  };
}

export interface ServerRestoreParams {
  /** Backup directory produced by `createServerBackup`. */
  directory: string;
  /** Server configuration of the target stack: fresh database, empty evidence root and the backup key. */
  server: ServerConfig;
  tools?: PgTools;
  /** Keep the backup's schema version instead of migrating forward. */
  keepSchema?: boolean;
  /** Post-backup ledger to replay (from `readLiveLedger`); absent means it was unavailable. */
  ledger?: Omit<RestoreTighteningOptions, "evidenceComplete">;
  /** Test seam: called at every write boundary; throwing simulates a crash there. */
  faultHook?: BackupFaultHook;
}
export interface ServerRestoreResult {
  manifest: BackupManifest;
  evidenceComplete: boolean;
  evidenceRestored: number;
  wipedInterruptedRestore: boolean;
  postBackupLedger: "replayed" | "unavailable";
  requiresOperatorReview: true;
}

const evidenceMarker = ".tm-restore-pending";

async function prepareEvidenceRoot(root: string): Promise<void> {
  const entries = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (entries && entries.length > 0 && !entries.includes(evidenceMarker))
    throw new ContractError("PRECONDITION_FAILED", "Restore evidence root is not empty", {
      reasonCode: "restore_target_not_empty",
    });
  if (entries)
    for (const entry of entries) await rm(join(root, entry), { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await writeFile(join(root, evidenceMarker), new Date().toISOString(), { mode: 0o600 });
}

/**
 * Restores a backup into a fresh PostgreSQL database and evidence root with isolation. Crash-safe:
 * a `tm_restore_pending` table and an evidence-root marker exist until every step finished, the
 * database refuses to open while the first exists, and running the restore again wipes the
 * half-restored target and produces the same result as an uninterrupted run.
 */
export async function restoreServerBackup(
  params: ServerRestoreParams,
): Promise<ServerRestoreResult> {
  const { server } = params;
  const tools = params.tools ?? pgToolsFor(server);
  const fault = params.faultHook ?? (() => undefined);
  const key = await readKeyFile(server.security.backupKeyFile, "security.backupKeyFile");
  const directory = resolve(params.directory);
  const manifest = await readManifest(directory);
  await verifyFiles(directory, manifest, key);
  const index = await readIndex(directory, key);
  fault("restore.verified");
  const evidenceRoot = resolve(filesystemRoot(server.storage));
  const database = PersistenceDatabase.openPostgres(database_config(server), { restore: true });
  try {
    const available = loadMigrationsSync("postgres");
    if (manifest.databaseVersion > available.length)
      throw new ContractError("PRECONDITION_FAILED", "Backup database version is unsupported", {
        reasonCode: "backup_version_unsupported",
      });
    const { wiped } = database.withTx(() => prepareRestoreTarget(database));
    await prepareEvidenceRoot(evidenceRoot);
    fault("restore.target_prepared");
    const expected = new Map(index.artifactRefs.map((ref) => [ref.storage_key, ref]));
    let evidenceRestored = 0;
    for (const file of manifest.files.filter((entry) =>
      entry.relativePath.startsWith("evidence/"),
    )) {
      const context = file.relativePath.slice(0, -4);
      const storageKey = context.slice("evidence/".length);
      if (!safeStorageKey(storageKey))
        throw new ContractError("INTERNAL", "Unsafe evidence storage key");
      const result = await decryptTo(
        join(directory, file.relativePath),
        key,
        context,
        join(evidenceRoot, storageKey),
      );
      const ref = expected.get(storageKey);
      if (ref?.hash && result.sha256 !== ref.hash)
        throw new ContractError(
          "PRECONDITION_FAILED",
          `Backup integrity failure: ${file.relativePath}`,
          {
            reasonCode: "backup_integrity",
          },
        );
      evidenceRestored += 1;
    }
    fault("restore.evidence_restored");
    const restoring = startPgRestore(database_config(server), tools);
    await Promise.all([
      pipeline(
        createReadStream(join(directory, "database.dump.enc")),
        decryptStream(key, "database.dump"),
        restoring.stdin,
      ),
      restoring.done,
    ]).catch((error) => {
      restoring.kill();
      throw error;
    });
    fault("restore.database_restored");
    const restoredVersion = Number(
      database.get("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations")?.version,
    );
    if (restoredVersion !== manifest.databaseVersion)
      throw new ContractError("PRECONDITION_FAILED", "Backup database schema version mismatch", {
        reasonCode: "backup_version_mismatch",
      });
    if (!params.keepSchema) await database.migrate();
    fault("restore.migrated");
    const ledger = params.ledger;
    database.withTx(() => {
      applyRestoreTightening(database, {
        ...(ledger ?? { ledgerAvailable: false }),
        evidenceComplete: index.complete,
      });
      fault("restore.finalizing");
      finalizeRestore(database);
    });
    fault("restore.finalized");
    await rm(join(evidenceRoot, evidenceMarker), { force: true });
    return {
      manifest,
      evidenceComplete: index.complete,
      evidenceRestored,
      wipedInterruptedRestore: wiped,
      postBackupLedger: ledger ? "replayed" : "unavailable",
      requiresOperatorReview: true,
    };
  } finally {
    database.close();
  }
}

/** Whether the current process can read or write `path`; the server uses it for separation checks. */
export async function probeAccess(path: string, mode: "read" | "write"): Promise<boolean> {
  try {
    await access(path, mode === "read" ? constants.R_OK : constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The server process must not hold the backup key or write the backup destination: a server
 * compromise then cannot read or tamper with backups. `backup.allowSharedAccess` waives the
 * check for single-user deployments and says so in the configuration.
 */
export async function assertBackupSeparation(server: ServerConfig): Promise<void> {
  const settings = server.backup;
  if (!settings || settings.allowSharedAccess) return;
  if (await probeAccess(server.security.backupKeyFile, "read"))
    throw new ContractError("PRECONDITION_FAILED", "The server process can read the backup key", {
      reasonCode: "backup_access_not_separated",
      path: "security.backupKeyFile",
      nextActions: [
        "Make the backup key readable only by the backup agent user",
        "Set backup.allowSharedAccess only for single-user deployments",
      ],
    });
  if (await probeAccess(settings.destination, "write"))
    throw new ContractError("PRECONDITION_FAILED", "The server process can write the backup destination", {
      reasonCode: "backup_access_not_separated",
      path: "backup.destination",
      nextActions: [
        "Make the backup destination writable only by the backup agent user",
        "Set backup.allowSharedAccess only for single-user deployments",
      ],
    });
}
