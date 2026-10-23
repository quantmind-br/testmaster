import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ContractError, validate } from "@testmaster/contracts";
import type { ObjectStore, S3ObjectStore } from "@testmaster/evidence";
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
  manifestMac,
  readKeyFile,
  verifyManifestMac,
} from "./backup-crypto.js";
import {
  type BackupDestination,
  type BackupReader,
  type BackupWriter,
  catalogKey,
  type EvidenceSink,
  integrityFailure,
  isS3Destination,
  listS3Catalog,
  listS3Data,
  listS3DataNames,
  manifestFile,
  openBackupReader,
  openBackupWriter,
  openEvidenceSink,
  openEvidenceSource,
  readStoreJson,
  streamDigest,
} from "./server-backup-media.js";
import type { ServerConfig } from "./server-config.js";
import { openS3Store } from "./storage-config.js";

export { type BackupDestination, isS3Destination } from "./server-backup-media.js";

/*
 * Server-profile backup and restore (ADR-019, OPS-024).
 *
 * Backup layout: `<destination>/<UTC timestamp>-<backupId>/` holds `manifest.json` (authenticated
 * with an HMAC, listing ciphertext hashes), `database.dump.enc` (a `pg_dump` custom archive taken
 * with `--serializable-deferrable`), `evidence-index.json.enc` and `evidence/<storage key>.enc`.
 * On a filesystem everything is written to `.partial-<backupId>` and renamed last, so a listing
 * never shows an unfinished backup. In an S3 destination (an Object Lock bucket written with its
 * own credential) the same files are objects under the prefix `<name>/` and the manifest is put
 * last, conditionally; see `server-backup-media.ts`.
 */
/** Every write boundary of a backup, its retention and a restore, in execution order. */
export const backupFaultPoints = [
  "backup.holds",
  "backup.dump",
  "backup.evidence_object",
  "backup.evidence",
  "backup.index",
  "backup.manifest",
  "backup.renamed",
] as const;
export const restoreFaultPoints = [
  "restore.verified",
  "restore.marker_written",
  "restore.target_prepared",
  "restore.evidence_object",
  "restore.evidence_restored",
  "restore.database_restored",
  "restore.migrated",
  "restore.finalizing",
  "restore.finalized",
  "restore.marker_cleared",
] as const;
export const retentionFaultPoints = ["retention.remove", "retention.object_deleted"] as const;
export type BackupFaultHook = (
  point:
    | (typeof backupFaultPoints)[number]
    | (typeof restoreFaultPoints)[number]
    | (typeof retentionFaultPoints)[number],
) => void;

export interface ServerBackupResult {
  backupId: string;
  /** The backup's absolute directory; its name (the key prefix) in an S3 destination. */
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
  /** The evidence store to read; defaults to the one `server.storage` describes. */
  objectStore?: ObjectStore;
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

/** A read-only `pg_restore` may exit once it has what it needs; a closed stdin is then not an error. */
function ignoreClosedInput(error: unknown): void {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code !== "EPIPE" && code !== "ERR_STREAM_PREMATURE_CLOSE" && code !== "ERR_STREAM_DESTROYED")
    throw error;
}

/** Reads artifact and snapshot references out of an encrypted dump without a database. */
async function readDumpState(
  openDump: () => Promise<Readable>,
  key: BackupKey,
  tools: PgTools,
): Promise<{
  refs: EvidenceRef[];
  snapshots: { workspace_id: string; run_id: string; attempt_id: string }[];
  version: number;
}> {
  const reader = startPgRestoreDataExport(exportedTables, tools);
  const feeding = pipeline(
    await openDump(),
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
  const backupId = params.backupId ?? randomUUID();
  const createdAt = now();
  const name = `${compactTime(createdAt)}-${backupId}`;
  const evidence = await openEvidenceSource(server, params.objectStore);
  let writer: BackupWriter;
  try {
    writer = await openBackupWriter(settings.destination, backupId, name);
  } catch (error) {
    evidence.close();
    throw error;
  }
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
    const dump = startPgDump(database_config(server), tools);
    const [written] = await Promise.all([
      writer.writeEncrypted("database.dump.enc", dump.stdout, key, "database.dump"),
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
    const state = await readDumpState(() => writer.open("database.dump.enc"), key, tools);
    const missingObjects: string[] = [];
    const copied = new Set<string>();
    // Reading the source object is the only failure that makes an object "missing"; an outage of
    // either store is not, so a ContractError (storage_unavailable, backup_object_exists) fails the backup.
    const copyObject = async (
      storageKey: string,
      expected: { hash?: string; bytes?: number },
    ): Promise<boolean> => {
      try {
        const info = await evidence.store.head(storageKey);
        const source = await evidence.store.get(storageKey);
        if (!info || !source) return false;
        const digest = await streamDigest(source);
        if (
          (expected.bytes !== undefined && info.sizeBytes !== expected.bytes) ||
          (expected.hash && digest.sha256 !== expected.hash)
        )
          return false;
        const relativePath = `evidence/${storageKey}.enc`;
        const reread = await evidence.store.get(storageKey);
        if (!reread) return false;
        const result = await writer.writeEncrypted(
          relativePath,
          reread,
          key,
          relativePath.slice(0, -4),
        );
        if (result.plainBytes !== info.sizeBytes) return false;
        files.push({ relativePath, sizeBytes: result.sizeBytes, sha256: result.sha256 });
        return true;
      } catch (error) {
        if (error instanceof ContractError) throw error;
        return false;
      }
    };
    const copy = async (storageKey: string, expected: { hash?: string; bytes?: number }) => {
      if (!safeStorageKey(storageKey))
        throw new ContractError("INTERNAL", "Unsafe evidence storage key");
      if (copied.has(storageKey)) return true;
      if (!(await copyObject(storageKey, expected))) return false;
      copied.add(storageKey);
      fault("backup.evidence_object");
      return true;
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
    const indexFile = await writer.writeEncrypted(
      "evidence-index.json.enc",
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
    await writer.stageManifest(JSON.stringify(manifest));
    fault("backup.manifest");
    await writer.commit();
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
      directory: writer.location,
      manifest,
      evidenceComplete: index.complete,
      missingObjects,
    };
  } catch (error) {
    await writer.abort();
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
  } finally {
    writer.close();
    evidence.close();
  }
}

function database_config(server: ServerConfig): PostgresConfig {
  const { engine: _engine, ...config } = server.database;
  return config;
}

export interface BackupListing {
  backupId: string;
  /** The backup's absolute directory; its name (the key prefix) in an S3 destination. */
  directory: string;
  createdAt: string;
  databaseVersion: number;
  /** True when the manifest MAC verified with the backup key. */
  authentic: boolean;
  complete: boolean;
}

function validManifest(raw: unknown): BackupManifest & { mac?: string } {
  return validate<BackupManifest & { mac?: string }>("BackupManifest", raw);
}

async function readManifest(reader: BackupReader): Promise<BackupManifest & { mac?: string }> {
  return validManifest(await reader.readJson(manifestFile));
}

async function listingOf(
  name: string,
  directory: string,
  key: BackupKey,
  readRaw: () => Promise<unknown>,
): Promise<BackupListing> {
  try {
    const manifest = validManifest(await readRaw());
    return {
      backupId: String(manifest.backupId ?? name),
      directory,
      createdAt: manifest.createdAt,
      databaseVersion: manifest.databaseVersion,
      authentic: manifest.engine === "postgres" && verifyManifestMac(key, manifest),
      complete: (manifest.missingObjects ?? []).length === 0,
    };
  } catch {
    return {
      backupId: name,
      directory,
      createdAt: new Date(0).toISOString(),
      databaseVersion: 0,
      authentic: false,
      complete: false,
    };
  }
}

const newestFirst = (left: BackupListing, right: BackupListing): number =>
  left.createdAt < right.createdAt ? 1 : -1;

/**
 * Lists finished backups in the destination, newest first. On S3 a backup is finished when its
 * manifest exists; the objects of a crashed backup are not listed.
 */
export async function listServerBackups(
  destination: BackupDestination,
  key: BackupKey,
): Promise<BackupListing[]> {
  if (isS3Destination(destination)) {
    const store = await openS3Store(destination);
    try {
      const listings = await Promise.all(
        (await listS3Catalog(store)).map((name) =>
          listingOf(name, name, key, () => readStoreJson(store, catalogKey(name))),
        ),
      );
      return listings.sort(newestFirst);
    } finally {
      store.close();
    }
  }
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
    listings.push(
      await listingOf(name, directory, key, async () =>
        JSON.parse(await readFile(join(directory, manifestFile), "utf8")),
      ),
    );
  }
  return listings.sort(newestFirst);
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

export interface RetentionOutcome {
  kept: string[];
  removed: string[];
  unauthentic: string[];
  /** Backups whose Object Lock has not expired: they stay listed and the next pass retries them. */
  locked: string[];
  /** Unfinished backups (objects without a manifest) whose leftovers were collected. */
  orphansCollected: string[];
}

/** Leftovers of an unfinished backup are not touched before the longest hold a backup can still run under. */
const orphanGraceMs = holdHours * 3_600_000;

/**
 * Removes one backup from a locked bucket, catalog entry first: while it is locked nothing is
 * removed and the backup stays listed whole, and once it is gone the backup is no longer listed,
 * so a crash between two deletions leaves orphans a later pass collects. Each object is removed
 * with every version (`deleteVersions`): a plain delete on a locked bucket only hides it.
 * `finished` says the catalog entry exists; without it the backup is a crashed one.
 */
async function deleteS3Backup(
  store: S3ObjectStore,
  name: string,
  finished: boolean,
  faultHook: BackupFaultHook | undefined,
): Promise<"deleted" | "locked"> {
  const catalog = catalogKey(name);
  const keys = (await listS3Data(store, name)).keys;
  let locked = false;
  for (const key of finished ? [catalog, ...keys] : keys) {
    const outcome = await store.deleteVersions(key);
    if (outcome.deleted) faultHook?.("retention.object_deleted");
    else if (key === catalog) return "locked";
    else locked = true;
  }
  return locked && !finished ? "locked" : "deleted";
}

/**
 * Applies the retention policy to the destination and removes expired backups. On S3 only backups
 * whose Object Lock has expired go: a removal the lock refuses is not an error, the backup stays
 * listed and counts as `locked`.
 */
export async function applyServerBackupRetention(
  server: ServerConfig,
  options: { faultHook?: BackupFaultHook; now?: () => Date } = {},
): Promise<RetentionOutcome> {
  const settings = backupSettings(server);
  const key = await readKeyFile(server.security.backupKeyFile, "security.backupKeyFile");
  const listings = await listServerBackups(settings.destination, key);
  const policy = settings.retention ?? defaultRetention;
  const decision = selectRetention(listings, policy);
  const outcome: RetentionOutcome = {
    kept: decision.keep,
    removed: [],
    unauthentic: listings
      .filter((listing) => !listing.authentic)
      .map((listing) => listing.backupId),
    locked: [],
    orphansCollected: [],
  };
  if (!isS3Destination(settings.destination)) {
    for (const id of decision.remove) {
      const target = listings.find((listing) => listing.backupId === id);
      if (!target) continue;
      options.faultHook?.("retention.remove");
      await rm(target.directory, { recursive: true, force: true });
    }
    outcome.removed = decision.remove;
    return outcome;
  }
  const store = await openS3Store(settings.destination);
  try {
    const finished = new Set(await listS3Catalog(store));
    const unfinished = new Set(
      (await listS3DataNames(store)).filter((name) => !finished.has(name)),
    );
    for (const id of decision.remove) {
      const target = listings.find((listing) => listing.backupId === id);
      if (!target || !finished.has(target.directory)) continue;
      options.faultHook?.("retention.remove");
      const result = await deleteS3Backup(store, target.directory, true, options.faultHook);
      (result === "deleted" ? outcome.removed : outcome.locked).push(id);
    }
    const cutoff = (options.now ?? (() => new Date()))().getTime() - orphanGraceMs;
    for (const name of unfinished) {
      const { keys, newest } = await listS3Data(store, name);
      if (keys.length === 0 || newest.getTime() > cutoff) continue;
      if ((await deleteS3Backup(store, name, false, options.faultHook)) === "deleted")
        outcome.orphansCollected.push(name);
    }
  } finally {
    store.close();
  }
  return outcome;
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
  reader: BackupReader,
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
    if ((await reader.size(file.relativePath)) !== file.sizeBytes)
      throw integrityFailure(file.relativePath);
    if ((await streamDigest(await reader.open(file.relativePath))).sha256 !== file.sha256)
      throw integrityFailure(file.relativePath);
  }
  if (!seen.has("database.dump.enc") || !seen.has("evidence-index.json.enc"))
    throw new ContractError("PRECONDITION_FAILED", "Backup requires database and evidence index");
}

async function readIndex(reader: BackupReader, key: BackupKey): Promise<EvidenceIndexDocument> {
  const chunks: Buffer[] = [];
  await pipeline(
    await reader.open("evidence-index.json.enc"),
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

/**
 * Decrypts and hashes one evidence object, returning the plaintext digest. With `sink` the
 * plaintext is also handed to it while it is hashed.
 */
async function decryptInto(
  source: Readable,
  key: BackupKey,
  context: string,
  sink?: (plain: Readable) => Promise<void>,
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
  const plain = new PassThrough();
  const consuming = sink
    ? sink(plain)
    : pipeline(plain, new Transform({ transform: (_chunk, _encoding, callback) => callback() }));
  try {
    await Promise.all([pipeline(source, decryptStream(key, context), tap, plain), consuming]);
  } catch (error) {
    plain.destroy();
    source.destroy();
    throw error;
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
  const reader = await openBackupReader(server, directory);
  try {
    const manifest = await readManifest(reader);
    await verifyFiles(reader, manifest, key);
    const index = await readIndex(reader, key);
    const expected = new Map(index.artifactRefs.map((ref) => [ref.storage_key, ref]));
    let evidenceObjects = 0;
    for (const file of manifest.files.filter((entry) =>
      entry.relativePath.startsWith("evidence/"),
    )) {
      const context = file.relativePath.slice(0, -4);
      const storageKey = context.slice("evidence/".length);
      const result = await decryptInto(await reader.open(file.relativePath), key, context);
      const ref = expected.get(storageKey);
      if (ref?.hash && result.sha256 !== ref.hash) throw integrityFailure(file.relativePath);
      evidenceObjects += 1;
    }
    const list = startPgRestoreList(tools);
    let archiveEntries = 0;
    const reading = (async () => {
      const lines = createInterface({ input: list.stdout, crlfDelay: Number.POSITIVE_INFINITY });
      for await (const line of lines) if (line && !line.startsWith(";")) archiveEntries += 1;
    })();
    // `pg_restore --list` stops after the table of contents; the whole dump is authenticated here.
    await decryptInto(await reader.open("database.dump.enc"), key, "database.dump");
    await Promise.all([
      pipeline(
        await reader.open("database.dump.enc"),
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
  } finally {
    reader.close();
  }
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
    approvalRevocations: database.all<SqlRow>(
      "SELECT workspace_id,id,revoked_at FROM approvals WHERE revoked_at IS NOT NULL",
    ),
  };
}

export interface ServerRestoreParams {
  /** Backup produced by `createServerBackup`: its directory, or its name in an S3 destination. */
  directory: string;
  /** Server configuration of the target stack: fresh database, empty evidence store and the backup key. */
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

/** A bundle is committed by its `meta.json`, so a restore writes those objects after everything else. */
const committedLast = (file: { relativePath: string }): number =>
  Number(file.relativePath.endsWith("/meta.json.enc"));

/**
 * Restores a backup into a fresh PostgreSQL database and evidence store (a directory, or the
 * evidence bucket) with isolation. Crash-safe: a `tm_restore_pending` table and an evidence marker
 * exist until every step finished, the database refuses to open while the first exists, and
 * running the restore again wipes the half-restored target and produces the same result as an
 * uninterrupted run.
 */
export async function restoreServerBackup(
  params: ServerRestoreParams,
): Promise<ServerRestoreResult> {
  const { server } = params;
  const tools = params.tools ?? pgToolsFor(server);
  const fault = params.faultHook ?? (() => undefined);
  const key = await readKeyFile(server.security.backupKeyFile, "security.backupKeyFile");
  const reader = await openBackupReader(server, params.directory);
  let sink: EvidenceSink | undefined;
  try {
    const manifest = await readManifest(reader);
    await verifyFiles(reader, manifest, key);
    const index = await readIndex(reader, key);
    fault("restore.verified");
    sink = await openEvidenceSink(server.storage);
    const database = PersistenceDatabase.openPostgres(database_config(server), { restore: true });
    try {
      const available = loadMigrationsSync("postgres");
      if (manifest.databaseVersion > available.length)
        throw new ContractError("PRECONDITION_FAILED", "Backup database version is unsupported", {
          reasonCode: "backup_version_unsupported",
        });
      const { wiped } = database.withTx(() => prepareRestoreTarget(database));
      await sink.prepare(fault);
      fault("restore.target_prepared");
      const expected = new Map(index.artifactRefs.map((ref) => [ref.storage_key, ref]));
      let evidenceRestored = 0;
      const evidenceFiles = manifest.files
        .filter((entry) => entry.relativePath.startsWith("evidence/"))
        .sort((left, right) => committedLast(left) - committedLast(right));
      for (const file of evidenceFiles) {
        const context = file.relativePath.slice(0, -4);
        const storageKey = context.slice("evidence/".length);
        if (!safeStorageKey(storageKey))
          throw new ContractError("INTERNAL", "Unsafe evidence storage key");
        const target = sink;
        const result = await decryptInto(
          await reader.open(file.relativePath),
          key,
          context,
          (plain) => target.write(storageKey, plain),
        );
        const ref = expected.get(storageKey);
        if (ref?.hash && result.sha256 !== ref.hash) {
          await sink.discard(storageKey);
          throw integrityFailure(file.relativePath);
        }
        evidenceRestored += 1;
        fault("restore.evidence_object");
      }
      fault("restore.evidence_restored");
      const restoring = startPgRestore(database_config(server), tools);
      await Promise.all([
        pipeline(
          await reader.open("database.dump.enc"),
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
      await sink.complete();
      fault("restore.marker_cleared");
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
  } finally {
    sink?.close();
    reader.close();
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
 * compromise then cannot read or tamper with backups. For an S3 destination "write" means holding
 * the backup bucket's credential files, which the server's user must not be able to read.
 * `backup.allowSharedAccess` waives the check for single-user deployments and says so in the
 * configuration.
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
  const destination = settings.destination;
  if (isS3Destination(destination)) {
    for (const [field, path] of [
      ["accessKeyIdFile", destination.accessKeyIdFile],
      ["secretAccessKeyFile", destination.secretAccessKeyFile],
    ] as const)
      if (await probeAccess(path, "read"))
        throw new ContractError(
          "PRECONDITION_FAILED",
          "The server process can read the backup bucket credential",
          {
            reasonCode: "backup_access_not_separated",
            path: `backup.destination.${field}`,
            nextActions: [
              "Make the backup bucket credential readable only by the backup agent user",
              "Set backup.allowSharedAccess only for single-user deployments",
            ],
          },
        );
    return;
  }
  if (await probeAccess(destination, "write"))
    throw new ContractError(
      "PRECONDITION_FAILED",
      "The server process can write the backup destination",
      {
        reasonCode: "backup_access_not_separated",
        path: "backup.destination",
        nextActions: [
          "Make the backup destination writable only by the backup agent user",
          "Set backup.allowSharedAccess only for single-user deployments",
        ],
      },
    );
}
