import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  statfs,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ContractError, validate } from "@testmaster/contracts";
import { ensureControlPlaneReserve, releaseControlPlaneReserve } from "./disk-reserve.js";

export type SqlRow = Record<string, unknown>;
export interface MigrationStatus {
  version: number;
  name: string;
  appliedAt: string;
  checksum: string;
}
export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}
export interface DatabaseStatus {
  currentVersion: number;
  migrations: MigrationStatus[];
  pending: number[];
}
export class MigrationChecksumError extends Error {
  constructor(
    public readonly version: number,
    expected: string,
    actual: string,
  ) {
    super(`Migration ${version} checksum mismatch (expected ${expected}, found ${actual})`);
  }
}
export async function loadMigrations(
  engine: "sqlite" | "postgres" = "sqlite",
  directory = fileURLToPath(new URL(`../migrations/${engine}/`, import.meta.url)),
): Promise<Migration[]> {
  const names = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort();
  const result: Migration[] = [];
  for (const name of names) {
    const match = /^(\d{4})_(.+)\.sql$/u.exec(name);
    if (!match?.[1] || !match[2]) continue;
    const sql = await readFile(join(directory, name), "utf8");
    const version = Number(match[1]);
    if (version !== result.length + 1)
      throw new Error("Migration versions must be contiguous and unique");
    result.push({
      version,
      name: match[2],
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }
  if (!result.length) throw new Error("No database migrations available");
  return result;
}
export type TxDatabase = DatabaseSync;
export class PersistenceDatabase {
  private migrations: Migration[] = [];
  private constructor(
    readonly db: DatabaseSync,
    readonly path: string,
  ) {}
  static async open(
    path: string,
    options: { migrate?: boolean; migrationsDir?: string } = {},
  ): Promise<PersistenceDatabase> {
    const actual = resolve(path);
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 });
    const filesystem = await statfs(dirname(actual));
    if ([0x6969, 0xff534d42, 0xfe534d42, 0x65735546].includes(Number(filesystem.type) >>> 0))
      throw new ContractError("PRECONDITION_FAILED", "SQLite requires compatible local storage");
    try {
      const info = await lstat(actual);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new Error("Database must be a regular private file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Number(filesystem.bavail) * Number(filesystem.bsize) > 8 * 1024 * 1024)
      ensureControlPlaneReserve(actual);
    const db = new DatabaseSync(actual);
    try {
      await chmod(actual, 0o600);
      db.exec(
        "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
      );
      const journal = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
      const locking = db.prepare("PRAGMA locking_mode").get()?.locking_mode;
      if (journal !== "wal" || locking !== "normal")
        throw new ContractError(
          "PRECONDITION_FAILED",
          "SQLite storage must support WAL with normal locking",
        );
      const instance = new PersistenceDatabase(db, actual);
      if (options.migrate !== false) await instance.migrate(options.migrationsDir);
      else instance.verifyCompatibility(await loadMigrations("sqlite", options.migrationsDir));
      return instance;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  static memory(): PersistenceDatabase {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    return new PersistenceDatabase(db, ":memory:");
  }
  close(): void {
    this.db.close();
  }
  withTx<T>(fn: (db: DatabaseSync) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn(this.db);
      if (value instanceof Promise) throw new Error("withTx callback must be synchronous");
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      if (error instanceof Error && /database or disk is full|SQLITE_FULL/.test(error.message))
        releaseControlPlaneReserve(this.path);
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get<T = SqlRow>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined;
  }
  all<T = SqlRow>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
  }
  run(
    sql: string,
    ...params: unknown[]
  ): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.db.prepare(sql).run(...(params as SQLInputValue[]));
  }
  private verifyCompatibility(available: Migration[]): void {
    const exists = this.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    );
    const applied = exists
      ? this.all<{ version: number; name: string; checksum: string }>(
          "SELECT version,name,checksum FROM schema_migrations ORDER BY version",
        )
      : [];
    for (const [index, row] of applied.entries()) {
      const migration = available[row.version - 1];
      if (!migration || row.version !== index + 1)
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Controller is incompatible with database schema",
          { databaseVersion: row.version, supportedVersion: available.length },
        );
      if (migration.name !== row.name || migration.checksum !== row.checksum)
        throw new MigrationChecksumError(row.version, row.checksum, migration.checksum);
    }
    this.migrations = available;
  }
  async migrate(directory?: string): Promise<void> {
    const available = await loadMigrations("sqlite", directory);
    if (this.db.isTransaction) throw new Error("Database migrations require their own transaction");
    this.verifyCompatibility(available);
    const currentVersion =
      this.migrations.length &&
      this.get("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
        ? Number(
            this.get("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations")?.version,
          )
        : 0;
    if (currentVersion === available.length) return;
    const rebuildsArtifacts = available.some(
      (migration) =>
        migration.version > currentVersion && migration.name === "authored_code_artifacts",
    );
    if (rebuildsArtifacts) this.db.exec("PRAGMA foreign_keys=OFF");
    this.db.exec("PRAGMA busy_timeout=0");
    try {
      try {
        this.db.exec("BEGIN EXCLUSIVE");
      } catch {
        throw new ContractError("PRECONDITION_FAILED", "Another instance owns the migration lock");
      }
      this.verifyCompatibility(available);
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)",
      );
      const applied = Number(this.get("SELECT COUNT(*) AS n FROM schema_migrations")?.n);
      for (const migration of available.slice(applied)) {
        this.db.exec(migration.sql);
        this.db
          .prepare(
            "INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)",
          )
          .run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      }
      if (rebuildsArtifacts && this.all("PRAGMA foreign_key_check").length)
        throw new Error("Migration produced a foreign key violation");
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.db.exec("PRAGMA busy_timeout=5000");
      if (rebuildsArtifacts) this.db.exec("PRAGMA foreign_keys=ON");
    }
  }
  status(): DatabaseStatus {
    const rows = this.all<MigrationStatus>(
      "SELECT version,name,checksum,applied_at AS appliedAt FROM schema_migrations ORDER BY version",
    );
    const currentVersion = rows.at(-1)?.version ?? 0;
    return {
      currentVersion,
      migrations: rows,
      pending: this.migrations
        .filter((migration) => migration.version > currentVersion)
        .map((migration) => migration.version),
    };
  }
  async backup(destinationDir: string, options: BackupOptions = {}): Promise<BackupManifest> {
    const destination = resolve(destinationDir);
    await mkdir(destination, { mode: 0o700 });
    const dbPath = join(destination, "testmaster.db");
    await backup(this.db, dbPath, { rate: 100 });
    await chmod(dbPath, 0o600);
    const snapshot = new DatabaseSync(dbPath, { readOnly: true });
    let index: EvidenceIndex;
    let databaseVersion: number;
    const metadataFiles: BackupManifestFile[] = [];
    try {
      const refs = snapshot
        .prepare(
          "SELECT workspace_id,id,run_id,attempt_id,snapshot_id,storage_key,hash,bytes,state FROM artifacts ORDER BY workspace_id,id",
        )
        .all();
      if (
        snapshot
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fixture_inputs'")
          .get()
      ) {
        refs.push(
          ...snapshot
            .prepare(
              "SELECT workspace_id,id,NULL AS run_id,NULL AS attempt_id,NULL AS snapshot_id,storage_key,content_hash AS hash,size_bytes AS bytes,CASE WHEN EXISTS(SELECT 1 FROM operational_state d WHERE d.key='retention:artifact:' || f.workspace_id || ':' || f.id OR d.key='retention:deletion:' || f.workspace_id || ':' || f.id) THEN 'expired' ELSE 'available' END AS state FROM fixture_inputs f ORDER BY workspace_id,id",
            )
            .all(),
        );
      }
      databaseVersion = Number(
        snapshot.prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations").get()
          ?.version,
      );
      index = {
        exportVersion: "1.0.0",
        createdAt: new Date().toISOString(),
        artifactRefs: refs,
        missingObjects: refs
          .filter((row) => row.state !== "available")
          .map((row) => String(row.id)),
        complete: false,
        configDigests: options.configDigests ?? [],
        keyIds: options.keyIds ?? [],
      };
      // Database/index backup intentionally does not claim that evidence blobs were copied.
      index.complete = refs.length === 0;
      if (options.evidenceRoot) {
        for (const row of refs) {
          const key = String(row.storage_key);
          if (
            key.startsWith("/") ||
            key.split(/[\\/]/u).some((part) => part === ".." || part === "." || !part)
          )
            throw new Error("Unsafe evidence storage key");
          if (row.state !== "available") continue;
          const source = join(resolve(options.evidenceRoot), key);
          try {
            const info = await lstat(source);
            if (
              !info.isFile() ||
              info.isSymbolicLink() ||
              info.nlink !== 1 ||
              info.size !== Number(row.bytes) ||
              (await fileSha256(source)) !== row.hash
            )
              throw new Error("Evidence object unavailable or corrupt");
            const target = join(destination, "evidence", key);
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await copyFile(source, target);
            if ((await fileSha256(target)) !== row.hash)
              throw new Error("Copied evidence hash mismatch");
            await chmod(target, 0o600);
          } catch {
            index.missingObjects.push(String(row.id));
          }
        }
        const snapshots = snapshot
          .prepare("SELECT workspace_id,run_id,attempt_id FROM snapshots ORDER BY workspace_id,id")
          .all();
        for (const row of snapshots) {
          for (const name of ["manifest.json", "meta.json"]) {
            const key = `runs/${String(row.workspace_id)}/${String(row.run_id)}/${String(row.attempt_id)}/${name}`;
            try {
              const source = join(resolve(options.evidenceRoot), key);
              const info = await lstat(source);
              if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
                throw new Error("Unsafe snapshot metadata");
              const target = join(destination, "evidence", key);
              await mkdir(dirname(target), { recursive: true, mode: 0o700 });
              await copyFile(source, target);
              metadataFiles.push({
                relativePath: `evidence/${key}`,
                sizeBytes: info.size,
                sha256: await fileSha256(target),
              });
            } catch {
              index.missingObjects.push(key);
            }
          }
        }
        index.complete = index.missingObjects.length === 0;
      }
    } finally {
      snapshot.close();
    }
    const indexPath = join(destination, "evidence-index.json");
    await writeAtomic(indexPath, JSON.stringify(index));
    const files: BackupManifestFile[] = [...metadataFiles];
    for (const relativePath of ["testmaster.db", "evidence-index.json"]) {
      const path = join(destination, relativePath);
      files.push({
        relativePath,
        sizeBytes: (await lstat(path)).size,
        sha256: await fileSha256(path),
      });
    }
    if (options.evidenceRoot)
      for (const ref of index.artifactRefs) {
        const id = String(ref.id);
        if (index.missingObjects.includes(id)) continue;
        const relativePath = `evidence/${String(ref.storage_key)}`;
        if (files.some((file) => file.relativePath === relativePath)) continue;
        files.push({ relativePath, sizeBytes: Number(ref.bytes), sha256: String(ref.hash) });
      }
    const manifest = validate<BackupManifest>("BackupManifest", {
      schemaVersion: "1.0.0",
      createdAt: index.createdAt,
      files,
      databaseVersion,
      secretIncluded: false,
      keyIds: options.keyIds ?? [],
      configDigests: options.configDigests ?? [],
    });
    for (const file of files) {
      const fd = await open(join(destination, file.relativePath), "r");
      try {
        await fd.sync();
      } finally {
        await fd.close();
      }
    }
    await writeAtomic(join(destination, "manifest.json"), JSON.stringify(manifest));
    return manifest;
  }
  static async restore(
    backupDir: string,
    destinationDir: string,
    options: { revocations?: SqlRow[]; tombstones?: SqlRow[] } = {},
  ): Promise<RestoreResult> {
    const source = resolve(backupDir);
    const destination = resolve(destinationDir);
    const manifest = validate<BackupManifest>(
      "BackupManifest",
      JSON.parse(await readFile(join(source, "manifest.json"), "utf8")),
    );
    const available = await loadMigrations();
    if (manifest.databaseVersion > available.length)
      throw new Error("Backup database version is unsupported");
    const paths: Record<string, true> = {};
    for (const file of manifest.files) {
      if (paths[file.relativePath]) throw new Error("Duplicate backup file");
      paths[file.relativePath] = true;
      const path = join(source, file.relativePath);
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size !== file.sizeBytes ||
        (await fileSha256(path)) !== file.sha256
      )
        throw new Error(`Backup integrity failure: ${file.relativePath}`);
    }
    if (!paths["testmaster.db"] || !paths["evidence-index.json"])
      throw new Error("Backup requires database and evidence index");
    const index = JSON.parse(
      await readFile(join(source, "evidence-index.json"), "utf8"),
    ) as EvidenceIndex;
    await mkdir(destination, { mode: 0o700 });
    for (const file of manifest.files) {
      const target = join(destination, file.relativePath);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(join(source, file.relativePath), target);
      await chmod(target, 0o600);
    }
    const restored = await PersistenceDatabase.open(join(destination, "testmaster.db"), {
      migrate: false,
    });
    try {
      if (
        restored.get("PRAGMA integrity_check")?.integrity_check !== "ok" ||
        restored.all("PRAGMA foreign_key_check").length
      )
        throw new Error("Restored database integrity check failed");
      if (restored.status().currentVersion !== manifest.databaseVersion)
        throw new Error("Backup database schema version mismatch");
      await restored.migrate();
      restored.withTx(() => {
        for (const current of options.revocations ?? []) {
          const row = restored.get(
            "SELECT data_json FROM secret_references WHERE workspace_id=? AND id=?",
            current.workspace_id,
            current.id,
          );
          if (!row) continue;
          const reference = JSON.parse(String(row.data_json)) as Record<string, unknown>;
          if (
            !current.revoked_at &&
            Number(current.secret_version) <= Number(reference.secretVersion)
          )
            continue;
          const revokedAt = current.revoked_at ?? new Date().toISOString();
          reference.revokedAt = revokedAt;
          reference.version = Number(reference.version ?? 1) + 1;
          restored.run(
            "UPDATE secret_references SET revoked_at=?,data_json=?,version=version+1 WHERE workspace_id=? AND id=?",
            revokedAt,
            JSON.stringify(reference),
            current.workspace_id,
            current.id,
          );
        }
        for (const tombstone of options.tombstones ?? []) {
          restored.run(
            "INSERT OR REPLACE INTO operational_state(key,value) VALUES(?,?)",
            tombstone.key,
            tombstone.value,
          );
          const match = /^retention:artifact:(ws_[0-9a-f-]+):(art_[0-9a-f-]+)$/.exec(
            String(tombstone.key),
          );
          if (match) {
            const retention = JSON.parse(String(tombstone.value)) as { stage?: string };
            if (["marked", "tombstoned", "deleted"].includes(retention.stage ?? ""))
              restored.run(
                "UPDATE artifacts SET state='expired',version=version+1 WHERE workspace_id=? AND id=? AND state<>'expired'",
                match[1],
                match[2],
              );
          }
        }
        restored.run(
          "UPDATE workers SET state='offline',last_heartbeat_at=?",
          new Date(0).toISOString(),
        );
        restored.run(
          "UPDATE operational_state SET value='suspended_restore' WHERE key='admission'",
        );
        restored.run(
          "INSERT OR REPLACE INTO operational_state(key,value) VALUES('restore_review','post_backup_revocations_and_tombstones_unverified')",
        );
        restored.run(
          "INSERT OR REPLACE INTO operational_state(key,value) VALUES('restore:evidence-complete',?)",
          String(index.complete),
        );
        restored.run(
          "UPDATE job_leases SET dispatchable=0,state=CASE WHEN state IN ('leased','queued') THEN 'reconciliation_required' ELSE state END,lease_owner=NULL,lease_expires_at=NULL,fence=fence+1",
        );
        restored.run("UPDATE outbox SET dispatchable=0");
        restored.run("DELETE FROM server_tokens");
        restored.run("UPDATE cursor_signing_keys SET revoked_at=?", new Date().toISOString());
      });
      return {
        database: restored,
        manifest,
        evidenceComplete: index.complete,
        requiresOperatorReview: true,
      };
    } catch (error) {
      restored.close();
      await rm(destination, { recursive: true });
      throw error;
    }
  }
}
export interface BackupManifestFile {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}
export interface BackupManifest {
  schemaVersion: "1.0.0";
  createdAt: string;
  files: BackupManifestFile[];
  databaseVersion: number;
  secretIncluded: false;
  keyIds?: string[];
  configDigests?: string[];
}
export interface BackupOptions {
  evidenceRoot?: string;
  configDigests?: string[];
  keyIds?: string[];
}
export interface EvidenceIndex {
  exportVersion: string;
  createdAt: string;
  artifactRefs: SqlRow[];
  missingObjects: string[];
  complete: boolean;
  configDigests: string[];
  keyIds: string[];
}
export interface RestoreResult {
  database: PersistenceDatabase;
  manifest: BackupManifest;
  evidenceComplete: boolean;
  requiresOperatorReview: true;
}
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.partial`;
  const fd = await open(temporary, "wx", 0o600);
  try {
    await fd.writeFile(text);
    await fd.sync();
  } finally {
    await fd.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
