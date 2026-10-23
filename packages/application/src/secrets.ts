import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  ContractError,
  type SecretReference,
  type SecretVersionRecord,
} from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import type { ObjectStore } from "@testmaster/evidence";
import {
  type EntityDocument,
  IdempotencyRepository,
  type PersistenceDatabase,
} from "@testmaster/persistence";
import type { SecretRelease } from "@testmaster/sandbox";
import { auditedOperation, auditSecurity } from "./audit.js";
import type { ResolvedConfig } from "./config.js";
import { allEntities, entity, type ServiceContext } from "./context.js";
import { acquireLease, releaseLease, renewLease } from "./controller-leases.js";
import { readObjectBytes } from "./object-bytes.js";
import type { ServerConfig } from "./server-config.js";

export type SecretMetadata = SecretReference & EntityDocument & { version: number };
export type SecretBackendHealth =
  | {
      backend: "secret-tool" | "vault" | "unavailable";
      writable: boolean;
      reasonCode?: undefined;
      path?: undefined;
    }
  | {
      backend: "unavailable";
      writable: false;
      /** The probe was refused because another process holds the vault lock. */
      reasonCode: "lock_busy";
      /** The lock file. */
      path: string;
    };
const MAX_SECRET_BYTES = 65536;

function unavailable(): ContractError {
  return new ContractError(
    "PRECONDITION_FAILED",
    "Secure secret storage is unavailable; explicit ephemeral mode is required",
  );
}
function lockBusy(path: string): ContractError {
  return new ContractError(
    "PRECONDITION_FAILED",
    "The secret vault is busy: another TestMaster process holds its lock",
    { reasonCode: "lock_busy", path },
  );
}
function validateValue(value: string): void {
  if (!value || Buffer.byteLength(value) > MAX_SECRET_BYTES || value.includes("\0"))
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Secret must be nonempty, bounded UTF-8 without NUL",
    );
}
function origins(values: string[]): string[] {
  return [
    ...new Set(
      values.map((value) => {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          throw new ContractError("INVALID_ARGUMENT", "Secret origin must be an HTTP origin");
        }
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        )
          throw new ContractError(
            "INVALID_ARGUMENT",
            "Secret origin must be a credential-free HTTP origin",
          );
        return url.origin;
      }),
    ),
  ];
}
/** No value is passed in argv, inherited environment, diagnostics, or a terminal stream. */
async function keychain(
  operation: "store" | "lookup" | "clear",
  workspace: string,
  id: string,
  version: number,
  value?: string,
): Promise<string> {
  const { promise, resolve: complete, reject } = Promise.withResolvers<string>();
  const args = operation === "store" ? ["store", "--label=TestMaster secret"] : [operation];
  args.push(
    "application",
    "testmaster",
    "workspace",
    workspace,
    "secret",
    id,
    "version",
    String(version),
  );
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG"])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  const child = spawn("secret-tool", args, { stdio: ["pipe", "pipe", "ignore"], env });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let failed = false;
  const timer = setTimeout(() => {
    failed = true;
    child.kill("SIGKILL");
  }, 5000);
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_SECRET_BYTES + 1) {
      failed = true;
      child.kill("SIGKILL");
    } else chunks.push(chunk);
  });
  child.on("error", () => {
    clearTimeout(timer);
    reject(unavailable());
  });
  child.stdin.on("error", () => {
    failed = true;
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (failed || code !== 0) {
      reject(unavailable());
      return;
    }
    const output = Buffer.concat(chunks).toString("utf8");
    complete(operation === "lookup" && output.endsWith("\n") ? output.slice(0, -1) : output);
  });
  child.stdin.end(value === undefined ? undefined : Buffer.from(value));
  return promise;
}

export type UnsafeDirectoryReason =
  | "not_owned"
  | "group_or_other_writable"
  | "symlink_or_not_directory"
  | "inaccessible";
/** A directory on a private path failed the ownership, permission or type check. */
export class UnsafeDirectoryError extends Error {
  constructor(
    /** The path segment that failed, which may be an ancestor of the requested directory. */
    readonly directory: string,
    readonly reason: UnsafeDirectoryReason,
    /** Human-readable predicate completing "<directory> ...". */
    readonly problem: string,
  ) {
    super(`${directory} ${problem}`);
    this.name = "UnsafeDirectoryError";
  }
}
function unreadableDirectory(
  directory: string,
  error: unknown,
  action: "opened" | "created" | "made private",
): UnsafeDirectoryError {
  const code = (error as NodeJS.ErrnoException).code;
  if (action === "opened" && (code === "ELOOP" || code === "ENOTDIR"))
    return new UnsafeDirectoryError(
      directory,
      "symlink_or_not_directory",
      "is a symbolic link or not a directory",
    );
  return new UnsafeDirectoryError(
    directory,
    "inaccessible",
    `cannot be ${action}${typeof code === "string" ? ` (${code})` : ""}`,
  );
}
// Pin every directory through an open FD. /proc/self/fd paths keep subsequent operations
// confined even if an ancestor is renamed; O_NOFOLLOW prevents symlink substitution.
// Failures throw UnsafeDirectoryError naming the offending segment; vault callers map them
// through `vaultDirectory`, the token issuer reports them to the operator.
export async function privateDirectory(path: string): Promise<FileHandle> {
  let handle = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let current = "/";
  try {
    const segments = resolve(path).split("/").filter(Boolean);
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      current = `/${segments.slice(0, index + 1).join("/")}`;
      const childPath = `/proc/self/fd/${handle.fd}/${segment}`;
      let child: FileHandle;
      try {
        child = await open(
          childPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw unreadableDirectory(current, error, "opened");
        try {
          await mkdir(childPath, { mode: 0o700 });
        } catch (creation) {
          if ((creation as NodeJS.ErrnoException).code !== "EEXIST")
            throw unreadableDirectory(current, creation, "created");
        }
        child = await open(
          childPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      }
      const stat = await child.stat();
      const uid = process.getuid?.();
      const last = index === segments.length - 1;
      const foreign =
        (uid !== undefined && stat.uid !== uid && stat.uid !== 0) ||
        (last && uid !== undefined && stat.uid !== uid);
      const writable = (stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0);
      if (foreign || writable) {
        await child.close();
        throw foreign
          ? new UnsafeDirectoryError(current, "not_owned", "is not owned by you")
          : new UnsafeDirectoryError(
              current,
              "group_or_other_writable",
              "is writable by group or others",
            );
      }
      // A directory that is already private needs no chmod, which also lets a deployment mount it read-only.
      if (last && (stat.mode & 0o777) !== 0o700) {
        try {
          await child.chmod(0o700);
        } catch (error) {
          await child.close();
          throw unreadableDirectory(current, error, "made private");
        }
      }
      await handle.close();
      handle = child;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error instanceof UnsafeDirectoryError
      ? error
      : unreadableDirectory(current, error, "opened");
  }
}
/** Vault storage reports any unusable directory as unavailable secure storage. */
function vaultDirectory(path: string): Promise<FileHandle> {
  return privateDirectory(path).catch(() => {
    throw unavailable();
  });
}
async function readPrivate(
  directory: FileHandle,
  name: string,
  maxBytes: number,
  maxLinks = 1,
): Promise<Buffer> {
  const handle = await open(
    `/proc/self/fd/${directory.fd}/${name}`,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink < 1 ||
      stat.nlink > maxLinks ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      stat.size > maxBytes
    )
      throw unavailable();
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
async function writePrivate(directory: FileHandle, name: string, bytes: Buffer): Promise<void> {
  const temporary = `/proc/self/fd/${directory.fd}/.${randomBytes(16).toString("hex")}.tmp`;
  const destination = `/proc/self/fd/${directory.fd}/${name}`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    // Link is an atomic no-clobber publish: existing symlinks/files cannot be overwritten.
    await link(temporary, destination);
    await unlink(temporary);
    await directory.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
function vaultName(id: string, version: number): string {
  if (!/^sec_[0-9a-f-]+$/i.test(id) || !Number.isSafeInteger(version) || version < 1)
    throw unavailable();
  return `${id}.${version}.vault`;
}
/**
 * Where the vault keeps its key and ciphertexts. The local profiles keep them under the user's
 * home and may use the OS keychain; the server profile (ADR-019) takes its key from the operator's
 * `security.masterKeyFile`, stores ciphertexts under the evidence root and never creates a key.
 * On the S3 profile the ciphertexts are objects of the evidence bucket, shared by every controller
 * (`shared`); the master key still lives only in each controller's key file, never in the bucket.
 */
export interface VaultLayout {
  readonly profile: "local" | "server";
  readonly keyDirectory: string;
  readonly keyName: string;
  readonly dataDirectory: string;
  readonly lockDirectory: string;
  readonly shared?: { store: ObjectStore; database: PersistenceDatabase };
}
/** The shared vault is locked deployment-wide through a database lease. */
const SHARED_VAULT_LEASE = "vault";
const SHARED_VAULT_LEASE_MS = 30_000;
export function serverVaultLayout(
  server: ServerConfig,
  shared?: { store: ObjectStore; database: PersistenceDatabase },
): VaultLayout {
  if (server.storage.kind === "s3") {
    if (!shared)
      throw new ContractError("INTERNAL", "The S3 vault needs the object store and the database");
    return {
      profile: "server",
      keyDirectory: dirname(server.security.masterKeyFile),
      keyName: basename(server.security.masterKeyFile),
      dataDirectory: join(server.storage.stagingRoot, "secrets"),
      lockDirectory: join(server.storage.stagingRoot, "secrets"),
      shared,
    };
  }
  const dataDirectory = join(server.storage.root, "secrets");
  return {
    profile: "server",
    keyDirectory: dirname(server.security.masterKeyFile),
    keyName: basename(server.security.masterKeyFile),
    dataDirectory,
    lockDirectory: dataDirectory,
  };
}
export function vaultLayout(
  config: ResolvedConfig,
  server?: ServerConfig,
  shared?: { store: ObjectStore; database: PersistenceDatabase },
): VaultLayout {
  if (server) return serverVaultLayout(server, shared);
  const keyDirectory = join(config.home, ".config", "testmaster");
  return {
    profile: "local",
    keyDirectory,
    keyName: "vault.key",
    dataDirectory: join(config.home, ".local", "share", "testmaster"),
    lockDirectory: keyDirectory,
  };
}
/**
 * Handle of one ciphertext: its file name in the vault directory, or its object key in the shared
 * store. Keys come from the stored reference (workspace, secret id, version), never from a caller.
 */
function ciphertextName(
  layout: VaultLayout,
  workspace: string,
  id: string,
  version: number,
): string {
  const file = vaultName(id, version);
  return layout.shared ? `vault/${workspace}/${file}` : file;
}
/** Writes a ciphertext that must not exist yet; an existing one is refused, never overwritten. */
async function ciphertextCreate(layout: VaultLayout, name: string, bytes: Buffer): Promise<void> {
  if (layout.shared) {
    const stored = await layout.shared.store.put(name, bytes, { ifNoneMatch: true });
    if (!stored.created) throw unavailable();
    return;
  }
  const directory = await vaultDirectory(layout.dataDirectory);
  try {
    await writePrivate(directory, name, bytes);
  } finally {
    await directory.close();
  }
}
async function ciphertextRead(layout: VaultLayout, name: string, limit: number): Promise<Buffer> {
  if (layout.shared) {
    const bytes = await readObjectBytes(layout.shared.store, name, limit);
    if (!bytes) throw unavailable();
    return bytes;
  }
  const directory = await vaultDirectory(layout.dataDirectory);
  try {
    return await readPrivate(directory, name, limit);
  } finally {
    await directory.close();
  }
}
/** Overwrites an existing ciphertext in place (key rewrap). */
async function ciphertextReplace(layout: VaultLayout, name: string, bytes: Buffer): Promise<void> {
  if (layout.shared) {
    await layout.shared.store.put(name, bytes);
    return;
  }
  const directory = await vaultDirectory(layout.dataDirectory);
  try {
    await replacePrivate(directory, name, bytes);
  } finally {
    await directory.close();
  }
}
async function ciphertextRemove(layout: VaultLayout, name: string): Promise<void> {
  if (layout.shared) {
    await layout.shared.store.delete(name);
    return;
  }
  const directory = await vaultDirectory(layout.dataDirectory);
  try {
    await unlink(`/proc/self/fd/${directory.fd}/${name}`);
  } finally {
    await directory.close();
  }
}
const ACTIVE_VAULT_KEY = "vault/active-key.json";
/**
 * The shared vault records which key encrypts new ciphertexts. A controller holding another key
 * (it missed a rewrap) is refused under the vault lock, so it can never write a ciphertext the
 * others cannot read or that a retired key would orphan. The first writer adopts its key.
 */
async function assertActiveVaultKey(layout: VaultLayout, keyId: string): Promise<void> {
  if (!layout.shared) return;
  const { store } = layout.shared;
  for (let attempt = 0; attempt < 2; attempt++) {
    const recorded = await readObjectBytes(store, ACTIVE_VAULT_KEY, 4096);
    if (recorded) {
      if ((JSON.parse(recorded.toString("utf8")) as { keyId?: string }).keyId === keyId) return;
      throw new ContractError(
        "PRECONDITION_FAILED",
        "This controller's vault key is not the active key; install the current key file and restart it",
        { reasonCode: "vault_key_stale" },
      );
    }
    if (
      (await store.put(ACTIVE_VAULT_KEY, JSON.stringify({ keyId }), { ifNoneMatch: true })).created
    )
      return;
  }
  throw unavailable();
}
async function publishActiveVaultKey(layout: VaultLayout, keyId: string): Promise<void> {
  await layout.shared?.store.put(ACTIVE_VAULT_KEY, JSON.stringify({ keyId }));
}
/** Handles of every ciphertext in the vault. */
async function ciphertextNames(layout: VaultLayout): Promise<string[]> {
  if (layout.shared) {
    const names: string[] = [];
    for await (const object of layout.shared.store.list("vault/"))
      if (object.key.endsWith(".vault")) names.push(object.key);
    return names;
  }
  const directory = await vaultDirectory(layout.dataDirectory);
  try {
    return (await readdir(`/proc/self/fd/${directory.fd}`)).filter((name) =>
      name.endsWith(".vault"),
    );
  } finally {
    await directory.close();
  }
}
/** A restore or a misconfigured deployment without its key must fail loudly, never mint a new one. */
function masterKeyUnavailable(): ContractError {
  return new ContractError("PRECONDITION_FAILED", "Master key is unavailable", {
    reasonCode: "master_key_unavailable",
  });
}
async function vaultKey(layout: VaultLayout, allowCreate: boolean): Promise<Buffer> {
  const directory = await vaultDirectory(layout.keyDirectory).catch((error: unknown) => {
    throw layout.profile === "server" ? masterKeyUnavailable() : error;
  });
  try {
    let key: Buffer;
    try {
      key = await readPrivate(directory, layout.keyName, 32);
    } catch (error) {
      if (layout.profile === "server") throw masterKeyUnavailable();
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!allowCreate) throw unavailable();
      const vault = await vaultDirectory(layout.dataDirectory);
      try {
        if ((await readdir(`/proc/self/fd/${vault.fd}`)).some((name) => name.endsWith(".vault")))
          throw unavailable();
      } finally {
        await vault.close();
      }
      const candidate = randomBytes(32);
      try {
        await writePrivate(directory, layout.keyName, candidate);
      } catch (creation) {
        if ((creation as NodeJS.ErrnoException).code !== "EEXIST") throw creation;
      } finally {
        candidate.fill(0);
      }
      key = await readPrivate(directory, layout.keyName, 32);
    }
    if (key.length !== 32) {
      key.fill(0);
      throw layout.profile === "server" ? masterKeyUnavailable() : unavailable();
    }
    return key;
  } finally {
    await directory.close();
  }
}
function aad(workspace: string, id: string, version: number): Buffer {
  return Buffer.from(JSON.stringify([workspace, id, version]));
}
interface VaultEnvelope {
  formatVersion: number;
  keyId: string;
  workspace: string;
  id: string;
  version: number;
  payload: string;
}
function parseVaultEnvelope(stored: Buffer): VaultEnvelope {
  const value: unknown = JSON.parse(stored.toString("utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    !("formatVersion" in value) ||
    value.formatVersion !== 1 ||
    !("keyId" in value) ||
    typeof value.keyId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.keyId) ||
    !("workspace" in value) ||
    typeof value.workspace !== "string" ||
    !/^ws_[a-f0-9-]+$/.test(value.workspace) ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !/^sec_[a-f0-9-]+$/.test(value.id) ||
    !("version" in value) ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !("payload" in value) ||
    typeof value.payload !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value.payload)
  )
    throw unavailable();
  return {
    formatVersion: 1,
    keyId: value.keyId,
    workspace: value.workspace,
    id: value.id,
    version: value.version,
    payload: value.payload,
  };
}
interface VaultLock {
  directory: FileHandle;
  /** Extends the deployment-wide lock during a long operation; a lost lock throws. */
  renew(): void;
  release(): Promise<void>;
}
/** Tail of this process's queue of vault lock holders, per lock directory. */
const vaultLockQueues = new Map<string, Promise<void>>();
/**
 * Holds the vault lock. Holders in this process wait for one another, so concurrent attempts
 * storing captures take turns instead of failing; only a live holder in another process is
 * refused as busy.
 */
async function vaultLock(layout: VaultLayout): Promise<VaultLock> {
  const key = layout.shared ? SHARED_VAULT_LEASE : layout.lockDirectory;
  const previous = vaultLockQueues.get(key) ?? Promise.resolve();
  const turn = Promise.withResolvers<void>();
  const tail = previous.then(() => turn.promise);
  vaultLockQueues.set(key, tail);
  const finish = () => {
    turn.resolve();
    if (vaultLockQueues.get(key) === tail) vaultLockQueues.delete(key);
  };
  await previous;
  let lock: VaultLock;
  try {
    lock = layout.shared
      ? await sharedVaultLock(layout.shared, layout)
      : await vaultFileLock(layout);
  } catch (error) {
    finish();
    throw error;
  }
  return {
    directory: lock.directory,
    renew: () => lock.renew(),
    release: async () => {
      try {
        await lock.release();
      } finally {
        finish();
      }
    },
  };
}
/**
 * The deployment-wide lock of the shared vault: a database lease, so a holder on another controller
 * is refused as busy and a crashed holder's lock expires on its own.
 */
async function sharedVaultLock(
  shared: { store: ObjectStore; database: PersistenceDatabase },
  layout: VaultLayout,
): Promise<VaultLock> {
  const directory = await vaultDirectory(layout.keyDirectory);
  const holder = `vault-${randomBytes(8).toString("hex")}`;
  let lease: { fence: number } | null;
  try {
    lease = acquireLease(shared.database, SHARED_VAULT_LEASE, holder, SHARED_VAULT_LEASE_MS);
  } catch (error) {
    await directory.close();
    throw error;
  }
  if (!lease) {
    await directory.close();
    throw lockBusy(SHARED_VAULT_LEASE);
  }
  const { fence } = lease;
  return {
    directory,
    renew: () => {
      if (!renewLease(shared.database, SHARED_VAULT_LEASE, holder, fence, SHARED_VAULT_LEASE_MS))
        throw lockBusy(SHARED_VAULT_LEASE);
    },
    release: async () => {
      try {
        releaseLease(shared.database, SHARED_VAULT_LEASE, holder, fence);
      } finally {
        await directory.close();
      }
    },
  };
}
/** The cross-process lock file; a live holder in another process is refused as busy. */
async function vaultFileLock(layout: VaultLayout): Promise<VaultLock> {
  const directory = await vaultDirectory(layout.keyDirectory);
  let lockDirectory = directory;
  if (layout.lockDirectory !== layout.keyDirectory)
    try {
      lockDirectory = await vaultDirectory(layout.lockDirectory);
    } catch (error) {
      await directory.close();
      throw error;
    }
  const closeAll = async () => {
    if (lockDirectory !== directory) await lockDirectory.close();
    await directory.close();
  };
  const path = `/proc/self/fd/${lockDirectory.fd}/vault.lock`;
  const busyPath = join(layout.lockDirectory, "vault.lock");
  const pidBytes = Buffer.from(String(process.pid));
  try {
    try {
      await writePrivate(lockDirectory, "vault.lock", pidBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A holder between its link and unlink steps leaves two links on a complete lock.
      const text = (await readPrivate(lockDirectory, "vault.lock", 32, 2)).toString();
      const pid = Number(text);
      if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(pid) || pid < 1) throw lockBusy(busyPath);
      try {
        process.kill(pid, 0);
        throw lockBusy(busyPath);
      } catch (owner) {
        if (owner instanceof ContractError) throw owner;
        const code = (owner as NodeJS.ErrnoException).code;
        if (code === "EPERM") throw lockBusy(busyPath);
        if (code !== "ESRCH") throw owner;
      }
      await unlink(path);
      try {
        await writePrivate(lockDirectory, "vault.lock", pidBytes);
      } catch (second) {
        // Another process reclaimed the dead holder's lock first.
        if ((second as NodeJS.ErrnoException).code === "EEXIST") throw lockBusy(busyPath);
        throw second;
      }
    }
    return {
      directory,
      renew: () => {},
      release: async () => {
        try {
          await unlink(path);
        } finally {
          await closeAll();
        }
      },
    };
  } catch (error) {
    await closeAll();
    throw error;
  }
}
async function replacePrivate(directory: FileHandle, name: string, bytes: Buffer): Promise<void> {
  const temporary = `.replace-${randomBytes(16).toString("hex")}`;
  await writePrivate(directory, temporary, bytes);
  await rename(
    `/proc/self/fd/${directory.fd}/${temporary}`,
    `/proc/self/fd/${directory.fd}/${name}`,
  );
  await directory.sync();
}
async function vaultWrite(
  layout: VaultLayout,
  workspace: string,
  id: string,
  version: number,
  value: string,
  allowCreate = true,
  /** The health probe writes a name nobody else uses, so it needs no lock. */
  locked = true,
): Promise<void> {
  const lock = locked ? await vaultLock(layout) : undefined;
  let key: Buffer | undefined;
  try {
    key = await vaultKey(layout, allowCreate);
    const nonce = randomBytes(12);
    const keyId = createHash("sha256").update(key).digest("hex");
    await assertActiveVaultKey(layout, keyId);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(workspace, id, version));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    await ciphertextCreate(
      layout,
      ciphertextName(layout, workspace, id, version),
      Buffer.from(
        JSON.stringify({
          formatVersion: 1,
          keyId,
          workspace,
          id,
          version,
          payload: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64"),
        }),
      ),
    );
  } finally {
    key?.fill(0);
    await lock?.release();
  }
}
async function vaultRead(
  layout: VaultLayout,
  workspace: string,
  id: string,
  version: number,
): Promise<string> {
  // Missing key after restore must fail, never create a replacement key when reading.
  const keys = await vaultDirectory(layout.keyDirectory).catch((error: unknown) => {
    throw layout.profile === "server" ? masterKeyUnavailable() : error;
  });
  let key: Buffer | undefined;
  try {
    key = await readPrivate(keys, layout.keyName, 32).catch((error: unknown) => {
      throw layout.profile === "server" ? masterKeyUnavailable() : error;
    });
    if (key.length !== 32)
      throw layout.profile === "server" ? masterKeyUnavailable() : unavailable();
    const stored = await ciphertextRead(
      layout,
      ciphertextName(layout, workspace, id, version),
      MAX_SECRET_BYTES * 2,
    );
    let bytes = stored;
    if (stored[0] === 123) {
      const envelope = parseVaultEnvelope(stored);
      if (
        envelope.formatVersion !== 1 ||
        !/^[a-f0-9]{64}$/.test(envelope.keyId) ||
        envelope.workspace !== workspace ||
        envelope.id !== id ||
        envelope.version !== version
      )
        throw unavailable();
      const activeId = createHash("sha256").update(key).digest("hex");
      let retired: string[] = [];
      try {
        retired = JSON.parse(
          (await readPrivate(keys, "vault-retired.json", MAX_SECRET_BYTES)).toString("utf8"),
        ) as string[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (retired.includes(envelope.keyId) || retired.includes(activeId))
        throw new ContractError("PRECONDITION_FAILED", "Vault encryption key is retired");
      if (envelope.keyId !== activeId) {
        key.fill(0);
        key = await readPrivate(keys, `${envelope.keyId}.key`, 32);
      }
      bytes = Buffer.from(envelope.payload, "base64");
    }
    if (bytes.length < 29) throw unavailable();
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAAD(aad(workspace, id, version));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw unavailable();
  } finally {
    key?.fill(0);
    await keys.close();
  }
}
async function erase(layout: VaultLayout, reference: SecretMetadata): Promise<void> {
  if (reference.provider === "secret-tool") {
    await keychain("clear", reference.workspaceId, reference.id, reference.secretVersion);
  } else if (reference.provider === "vault") {
    await ciphertextRemove(
      layout,
      ciphertextName(layout, reference.workspaceId, reference.id, reference.secretVersion),
    );
  }
}

/** Whether the master key file is present and well formed; it needs no storage round trip. */
export async function masterKeyReadable(layout: VaultLayout): Promise<boolean> {
  try {
    (await vaultKey(layout, false)).fill(0);
    return true;
  } catch {
    return false;
  }
}

/** Writable backend probe for doctor. Never reports secret bytes or backend diagnostics. */
export function health(
  config: ResolvedConfig,
  server?: ServerConfig,
): Promise<SecretBackendHealth> {
  return vaultHealth(vaultLayout(config, server));
}
export async function vaultHealth(layout: VaultLayout): Promise<SecretBackendHealth> {
  const id = `sec_${randomBytes(16).toString("hex")}`;
  const canary = randomBytes(32).toString("hex");
  // A vault envelope names a real workspace id (ws_...), so the probe uses one that no workspace has.
  const probeWorkspace = "ws_00000000-0000-4000-8000-000000000000";
  if (layout.profile === "local")
    try {
      await keychain("store", probeWorkspace, id, 1, canary);
      const matches = (await keychain("lookup", probeWorkspace, id, 1)) === canary;
      await keychain("clear", probeWorkspace, id, 1);
      if (matches) return { backend: "secret-tool", writable: true };
    } catch {
      /* Try the encrypted fallback, never plaintext persistence. */
    }
  try {
    await vaultWrite(
      layout,
      probeWorkspace,
      id,
      1,
      canary,
      layout.profile === "local",
      !layout.shared,
    );
    try {
      if ((await vaultRead(layout, probeWorkspace, id, 1)) === canary)
        return { backend: "vault", writable: true };
    } finally {
      // The canary never outlives the probe, whether or not it read back.
      await ciphertextRemove(layout, ciphertextName(layout, probeWorkspace, id, 1));
    }
  } catch (error) {
    /* A read-only or unsafe home is unavailable, not session persistence. */
    if (error instanceof ContractError && error.details.reasonCode === "lock_busy")
      return {
        backend: "unavailable",
        writable: false,
        reasonCode: "lock_busy",
        path: error.details.path as string,
      };
  }
  return { backend: "unavailable", writable: false };
}

export class SecretsService {
  private readonly layout: VaultLayout;
  private readonly distributed: boolean;
  constructor(
    private readonly ctx: ServiceContext,
    config: ResolvedConfig,
    server?: ServerConfig,
    /** Process memory shared by every scope of one runtime, so controller loops can release request-scoped ephemeral secrets. */
    private readonly ephemeral: Map<string, string> = new Map(),
    /** Where the S3 profile keeps ciphertexts; the filesystem profiles do not use it. */
    objectStore?: ObjectStore,
  ) {
    this.distributed = server?.mode === "distributed";
    this.layout = vaultLayout(
      config,
      server,
      objectStore ? { store: objectStore, database: ctx.database } : undefined,
    );
  }
  list(): SecretMetadata[] {
    this.ctx.authorize("R");
    return allEntities(this.ctx, "SecretReference") as SecretMetadata[];
  }
  get(idOrName: string): SecretMetadata {
    this.ctx.authorize("R");
    return this.lookup(idOrName);
  }
  /** Audit resource id: the resolved reference id, never the caller-supplied secret name. */
  private auditResource(idOrName: string): string {
    try {
      return this.lookup(idOrName).id;
    } catch {
      return "secret-reference";
    }
  }
  private lookup(idOrName: string): SecretMetadata {
    const byId = this.ctx.entities.get<SecretMetadata>(
      "SecretReference",
      this.ctx.workspaceId,
      idOrName,
    );
    if (byId) return byId;
    const found = (allEntities(this.ctx, "SecretReference") as SecretMetadata[]).find(
      (entry) => entry.locator === idOrName && !entry.revokedAt,
    );
    if (!found) throw new ContractError("NOT_FOUND", "Secret reference does not exist");
    return found;
  }
  private async persist(
    reference: SecretMetadata,
    value: string,
    ephemeral: boolean,
  ): Promise<string> {
    if (ephemeral) {
      // A value in one controller's memory is invisible to the others, which would run the Run
      // that needs it.
      if (this.distributed)
        throw new ContractError(
          "POLICY_DENIED",
          "Ephemeral secrets live in one controller's memory and cannot be shared across controllers",
          { reasonCode: "ephemeral_secret_not_shared" },
        );
      this.ephemeral.set(`${reference.id}:${reference.secretVersion}`, value);
      return "ephemeral";
    }
    // The server profile has no desktop keychain: secrets are always envelope-encrypted.
    if (this.layout.profile === "local")
      try {
        await keychain(
          "store",
          reference.workspaceId,
          reference.id,
          reference.secretVersion,
          value,
        );
        return "secret-tool";
      } catch {
        /* Fall back only to authenticated encryption. */
      }
    return this.persistVault(reference, value);
  }
  /** Authenticated encryption in TestMaster's own vault, never the host keyring. */
  private async persistVault(reference: SecretMetadata, value: string): Promise<string> {
    try {
      const hasVaultReferences = (
        allEntities(this.ctx, "SecretReference") as SecretMetadata[]
      ).some((entry) => entry.provider === "vault");
      await vaultWrite(
        this.layout,
        reference.workspaceId,
        reference.id,
        reference.secretVersion,
        value,
        !hasVaultReferences,
      );
      return "vault";
    } catch (error) {
      if (
        error instanceof ContractError &&
        (this.layout.profile === "server" || error.details.reasonCode === "lock_busy")
      )
        throw error;
      throw unavailable();
    }
  }
  async set(
    name: string,
    value: string,
    options: { ephemeral?: boolean; allowedOrigins?: string[]; idempotencyKey?: string } = {},
  ): Promise<SecretMetadata> {
    return auditedOperation(this.ctx, "secret.set", "secret-reference", () =>
      this.setValue(name, value, options),
    );
  }
  private async setValue(
    name: string,
    value: string,
    options: { ephemeral?: boolean; allowedOrigins?: string[]; idempotencyKey?: string } = {},
  ): Promise<SecretMetadata> {
    this.ctx.authorize("W");
    this.ctx.authorizeColumn("secret");
    validateValue(value);
    const body = {
      name,
      valueHash: semanticHash(value),
      allowedOrigins: options.allowedOrigins ?? [],
      ephemeral: options.ephemeral ?? false,
    };
    if (options.idempotencyKey) {
      if (options.idempotencyKey.length < 16 || options.idempotencyKey.length > 128)
        throw new ContractError("INVALID_ARGUMENT", "Idempotency key must have 16–128 characters");
      const row = this.ctx.database.get(
        "SELECT request_hash,response_json,expires_at FROM idempotency_receipts WHERE workspace_id=? AND actor_scope=? AND operation=? AND key=?",
        this.ctx.workspaceId,
        this.ctx.principalId,
        "secret.set",
        options.idempotencyKey,
      );
      if (row && String(row.expires_at) > new Date().toISOString()) {
        if (row.request_hash !== semanticHash(body))
          throw new ContractError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key has another secret request",
          );
        return JSON.parse(String(row.response_json)) as SecretMetadata;
      }
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name))
      throw new ContractError("INVALID_ARGUMENT", "Secret name must be a bounded identifier");
    const taken = (allEntities(this.ctx, "SecretReference") as SecretMetadata[]).find(
      (entry) => entry.locator === name && !entry.revokedAt,
    );
    if (taken)
      throw new ContractError(
        "REVISION_CONFLICT",
        "Secret name already exists; rotate it to store a new value (CLI secret rotate, MCP testmaster_rotate_secret)",
        { secretId: taken.id, name },
      );
    const reference = entity(this.ctx, "sec", {
      provider: "ephemeral",
      locator: name,
      secretVersion: 1,
      allowedOrigins: origins(options.allowedOrigins ?? []),
    }) as SecretMetadata;
    reference.provider = await this.persist(reference, value, options.ephemeral === true);
    try {
      const commit = () => {
        if (
          (allEntities(this.ctx, "SecretReference") as SecretMetadata[]).some(
            (entry) => entry.locator === name && !entry.revokedAt,
          )
        )
          throw new ContractError("REVISION_CONFLICT", "Secret name already exists");
        this.ctx.entities.insert("SecretReference", reference);
        return reference;
      };
      if (options.idempotencyKey) {
        const execution = new IdempotencyRepository(this.ctx.database).execute(
          {
            workspaceId: this.ctx.workspaceId,
            actorScope: this.ctx.principalId,
            operation: "secret.set",
            key: options.idempotencyKey,
            body,
          },
          commit,
        );
        if (execution.replayed) return execution.receipt;
      } else this.ctx.database.withTx(commit);
    } catch (error) {
      this.ephemeral.delete(`${reference.id}:1`);
      await erase(this.layout, reference).catch(() => {});
      throw error;
    }
    // The created event of the version history is keyed by the reference id, not the shared label.
    auditSecurity(this.ctx, "secret.set", reference.id, "allowed");
    return reference;
  }
  /**
   * Trusted supervisor capture path; requires execution authority and never exports plaintext.
   * A capture lives only in the encrypted vault (never the host keyring) and is erased by
   * {@link eraseCapture} once no consumer can need it.
   */
  async protectCapture(
    name: string,
    value: unknown,
    allowedOrigins: string[],
  ): Promise<SecretMetadata> {
    this.ctx.authorize("X");
    const encoded = JSON.stringify(value);
    validateValue(encoded);
    const reference = entity(this.ctx, "sec", {
      provider: "vault",
      locator: name,
      secretVersion: 1,
      allowedOrigins: origins(allowedOrigins),
    }) as SecretMetadata;
    reference.provider = await this.persistVault(reference, encoded);
    try {
      this.ctx.entities.insert("SecretReference", reference);
    } catch (error) {
      await erase(this.layout, reference).catch(() => {});
      throw error;
    }
    return reference;
  }
  /**
   * Erases the stored value of a capture reference and revokes it, keeping the metadata
   * tombstone. Idempotent; a failed erasure leaves the reference live so a later sweep retries.
   */
  async eraseCapture(id: string): Promise<boolean> {
    this.ctx.authorize("X");
    const previous = this.lookup(id);
    if (previous.revokedAt || !previous.locator.startsWith("capture-")) return false;
    this.ephemeral.delete(`${previous.id}:${previous.secretVersion}`);
    try {
      await erase(this.layout, previous);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.ctx.entities.update(
      "SecretReference",
      this.ctx.workspaceId,
      previous.id,
      previous.version,
      {
        ...previous,
        revokedAt: new Date().toISOString(),
        version: previous.version + 1,
      },
    );
    auditSecurity(this.ctx, "secret.capture.erase", previous.id, "allowed");
    return true;
  }
  async rotate(
    idOrName: string,
    value: string,
    options: { idempotencyKey?: string } = {},
  ): Promise<SecretMetadata> {
    const resource = this.auditResource(idOrName);
    auditSecurity(this.ctx, "secret.rotate", resource, "requested");
    try {
      const rotation = await this.rotateValue(idOrName, value, options.idempotencyKey);
      // A replayed request changed nothing, so it must not add a version event to the history.
      if (!rotation.replayed) auditSecurity(this.ctx, "secret.rotate", resource, "allowed");
      return rotation.reference;
    } catch (error) {
      auditSecurity(this.ctx, "secret.rotate", resource, "denied");
      throw error;
    }
  }
  /** The stored first response of an idempotent rotation, or null when the key is new or expired. */
  private rotationReplay(operation: string, key: string, body: unknown): SecretMetadata | null {
    if (key.length < 16 || key.length > 128)
      throw new ContractError("INVALID_ARGUMENT", "Idempotency key must have 16–128 characters");
    const row = this.ctx.database.get(
      "SELECT request_hash,response_json,expires_at FROM idempotency_receipts WHERE workspace_id=? AND actor_scope=? AND operation=? AND key=?",
      this.ctx.workspaceId,
      this.ctx.principalId,
      operation,
      key,
    );
    if (!row || String(row.expires_at) <= new Date().toISOString()) return null;
    if (row.request_hash !== semanticHash(body))
      throw new ContractError(
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key has another secret rotation",
      );
    return JSON.parse(String(row.response_json)) as SecretMetadata;
  }
  private async rotateValue(
    idOrName: string,
    value: string,
    idempotencyKey?: string,
  ): Promise<{ reference: SecretMetadata; replayed: boolean }> {
    this.ctx.authorize("W");
    this.ctx.authorizeColumn("secret");
    validateValue(value);
    const previous = this.lookup(idOrName);
    if (previous.managedBy)
      throw new ContractError("INVALID_ARGUMENT", "Secret is maintained by an auth profile", {
        managedBy: previous.managedBy,
      });
    const request = idempotencyKey
      ? {
          workspaceId: this.ctx.workspaceId,
          actorScope: this.ctx.principalId,
          operation: `secret.rotate:${previous.id}`,
          key: idempotencyKey,
          body: { valueHash: semanticHash(value) },
        }
      : null;
    if (request) {
      const first = this.rotationReplay(request.operation, request.key, request.body);
      if (first) return { reference: first, replayed: true };
    }
    if (previous.revokedAt) throw new ContractError("POLICY_DENIED", "Secret is revoked");
    const next = {
      ...previous,
      secretVersion: previous.secretVersion + 1,
      version: previous.version + 1,
    };
    next.provider = await this.persist(next, value, previous.provider === "ephemeral");
    const commit = () => {
      this.ctx.entities.update(
        "SecretReference",
        this.ctx.workspaceId,
        previous.id,
        previous.version,
        next,
      );
      return next;
    };
    let replayed = false;
    let reference = next;
    try {
      if (request) {
        // The receipt and the new version commit together, so a retry can never rotate twice.
        const execution = new IdempotencyRepository(this.ctx.database).execute(request, commit);
        replayed = execution.replayed;
        reference = execution.receipt;
      } else commit();
    } catch (error) {
      this.ephemeral.delete(`${next.id}:${next.secretVersion}`);
      await erase(this.layout, next).catch(() => {});
      throw error;
    }
    // A concurrent identical request already owns this version slot; nothing was superseded here.
    if (replayed) return { reference, replayed };
    this.ephemeral.delete(`${previous.id}:${previous.secretVersion}`);
    await erase(this.layout, previous).catch(() => {});
    return { reference, replayed };
  }
  /**
   * Lifecycle events of one secret, newest first, derived from the audit trail. The trail holds
   * no values, so neither does the history; versions count back from the current one and never
   * fall below 1 when part of the chain predates auditing against the reference id.
   */
  history(idOrName: string): SecretVersionRecord[] {
    this.ctx.authorize("R");
    const reference = this.lookup(idOrName);
    const rows = this.ctx.database.all<{
      id: string;
      created_at: string;
      actor: string;
      action: string;
      request_id: string;
    }>(
      "SELECT id,created_at,actor,action,request_id FROM audit_events WHERE workspace_id=? AND resource_id=? AND action IN (?,?,?) ORDER BY created_at,id",
      this.ctx.workspaceId,
      reference.id,
      "secret.set.allowed",
      "secret.rotate.allowed",
      "secret.revoke.allowed",
    );
    const names = {
      "secret.set.allowed": "created",
      "secret.rotate.allowed": "rotated",
      "secret.revoke.allowed": "revoked",
    } as const;
    const seen = new Set<string>();
    const events = rows.flatMap((row) => {
      const event = names[row.action as keyof typeof names];
      // Creation and revocation happen once; a repeated revoke request changes nothing.
      if (event !== "rotated" && seen.has(event)) return [];
      seen.add(event);
      return [{ row, event }];
    });
    let version = reference.secretVersion;
    const records: SecretVersionRecord[] = [];
    for (const { row, event } of events.reverse()) {
      const current = event === "created" ? 1 : Math.max(1, version);
      if (event === "rotated") version = Math.max(1, version - 1);
      records.push({
        id: row.id,
        createdAt: row.created_at,
        version: current,
        event,
        actor: row.actor,
        requestId: row.request_id,
      } as SecretVersionRecord);
    }
    return records;
  }
  async remove(idOrName: string, idempotencyKey?: string): Promise<SecretMetadata> {
    return auditedOperation(this.ctx, "secret.revoke", this.auditResource(idOrName), () =>
      this.removeValue(idOrName, idempotencyKey),
    );
  }
  private async removeValue(idOrName: string, idempotencyKey?: string): Promise<SecretMetadata> {
    this.ctx.authorize("W");
    this.ctx.authorizeColumn("secret");
    const previous = this.lookup(idOrName);
    if (previous.managedBy)
      throw new ContractError("INVALID_ARGUMENT", "Secret is maintained by an auth profile", {
        managedBy: previous.managedBy,
      });
    if (previous.revokedAt && !idempotencyKey) return previous;
    const next = {
      ...previous,
      revokedAt: new Date().toISOString(),
      version: previous.version + 1,
    };
    const commit = () => {
      if (previous.revokedAt) return previous;
      this.ctx.entities.update(
        "SecretReference",
        this.ctx.workspaceId,
        previous.id,
        previous.version,
        next,
      );
      return next;
    };
    const receipt = idempotencyKey
      ? new IdempotencyRepository(this.ctx.database).execute(
          {
            workspaceId: this.ctx.workspaceId,
            actorScope: this.ctx.principalId,
            operation: `secret.remove:${previous.id}`,
            key: idempotencyKey,
            body: {},
          },
          commit,
        ).receipt
      : this.ctx.database.withTx(commit);
    this.ephemeral.delete(`${previous.id}:${previous.secretVersion}`);
    await erase(this.layout, previous).catch(() => {});
    return receipt;
  }
  /**
   * Creates the vault slot an auth profile fills (access token, session, storage state, …).
   * Nothing is stored until the first `writeManaged`; resolving an empty slot reports `missing_secret`.
   */
  async createManaged(
    owner: { profileId: string; role: string },
    allowedOrigins: string[],
  ): Promise<SecretMetadata> {
    this.ctx.authorize("W");
    const reference = entity(this.ctx, "sec", {
      provider: "managed",
      locator: `auth:${owner.profileId}:${owner.role}`,
      secretVersion: 1,
      allowedOrigins: origins(allowedOrigins),
      managedBy: owner.profileId,
      managedRole: owner.role,
    }) as SecretMetadata;
    this.ctx.entities.insert("SecretReference", reference);
    return reference;
  }
  /** Widens or narrows the origins of a managed slot after the profile's bindings changed. */
  rebindManaged(id: string, allowedOrigins: string[]): SecretMetadata {
    this.ctx.authorize("W");
    const previous = this.lookup(id);
    if (!previous.managedBy)
      throw new ContractError("INVALID_ARGUMENT", "Secret is not maintained by an auth profile");
    const next = {
      ...previous,
      allowedOrigins: origins(allowedOrigins),
      version: previous.version + 1,
    };
    this.ctx.entities.update(
      "SecretReference",
      this.ctx.workspaceId,
      previous.id,
      previous.version,
      next,
    );
    return next;
  }
  /**
   * Stores a new value version for a managed slot. The previous version stays readable so a Run that
   * already released it finishes; the one before that is erased. A revoked slot refuses writes
   * until an explicit re-authentication passes `rearm`.
   */
  async writeManaged(
    id: string,
    value: string,
    options: { rearm?: boolean } = {},
  ): Promise<SecretMetadata> {
    this.ctx.authorize("X");
    validateValue(value);
    const previous = this.lookup(id);
    if (!previous.managedBy)
      throw new ContractError("INVALID_ARGUMENT", "Secret is not maintained by an auth profile");
    if (previous.revokedAt && !options.rearm)
      throw new ContractError("POLICY_DENIED", "Secret is revoked", {
        reasonCode: "credential_revoked",
      });
    const first = previous.provider === "managed";
    const next: SecretMetadata = {
      ...previous,
      secretVersion: first ? previous.secretVersion : previous.secretVersion + 1,
      version: previous.version + 1,
      revokedAt: null,
    };
    next.provider = await this.persist(next, value, false);
    try {
      this.ctx.entities.update(
        "SecretReference",
        this.ctx.workspaceId,
        previous.id,
        previous.version,
        next,
      );
    } catch (error) {
      await erase(this.layout, next).catch(() => {});
      throw error;
    }
    if (!first && previous.secretVersion > 1)
      await erase(this.layout, { ...previous, secretVersion: previous.secretVersion - 1 }).catch(
        () => {},
      );
    return next;
  }
  /** Deletes every stored version of a managed slot; `revoke` also blocks use until re-authentication. */
  async eraseManaged(id: string, options: { revoke: boolean }): Promise<SecretMetadata> {
    this.ctx.authorize("W");
    const previous = this.lookup(id);
    if (!previous.managedBy)
      throw new ContractError("INVALID_ARGUMENT", "Secret is not maintained by an auth profile");
    if (previous.provider === "managed" && (!options.revoke || previous.revokedAt)) return previous;
    const next: SecretMetadata = {
      ...previous,
      provider: "managed",
      secretVersion: previous.secretVersion + 1,
      version: previous.version + 1,
      revokedAt: options.revoke ? new Date().toISOString() : (previous.revokedAt ?? null),
    };
    this.ctx.entities.update(
      "SecretReference",
      this.ctx.workspaceId,
      previous.id,
      previous.version,
      next,
    );
    if (previous.provider !== "managed") {
      await erase(this.layout, previous).catch(() => {});
      if (previous.secretVersion > 1)
        await erase(this.layout, { ...previous, secretVersion: previous.secretVersion - 1 }).catch(
          () => {},
        );
    }
    return next;
  }
  async release(id: string): Promise<SecretRelease> {
    return auditedOperation(this.ctx, "secret.release", this.auditResource(id), () =>
      this.releaseValue(id),
    );
  }
  private async releaseValue(id: string): Promise<SecretRelease> {
    this.ctx.authorize("X");
    const reference = this.lookup(id);
    origins(reference.allowedOrigins);
    if (reference.revokedAt)
      throw new ContractError("POLICY_DENIED", "Secret is revoked", {
        reasonCode: "credential_revoked",
      });
    if (reference.provider === "managed")
      throw new ContractError("POLICY_DENIED", "Managed credential has not been issued", {
        reasonCode: "missing_secret",
      });
    if (!reference.allowedOrigins.length)
      throw new ContractError("POLICY_DENIED", "Secret has no authorized target origins");
    const revoked = async (): Promise<boolean> => {
      this.ctx.authorize("X");
      const current = this.ctx.entities.get<SecretMetadata>(
        "SecretReference",
        this.ctx.workspaceId,
        reference.id,
      );
      if (!current || current.revokedAt) return true;
      // A managed slot rotates under a running Run: the released version and its successor stay valid.
      if (reference.managedBy)
        return (
          current.provider === "managed" ||
          current.secretVersion < reference.secretVersion ||
          current.secretVersion > reference.secretVersion + 1
        );
      return current.secretVersion !== reference.secretVersion;
    };
    return {
      secretRef: reference.id,
      secretVersion: reference.secretVersion,
      revoked,
      resolve: () =>
        auditedOperation(this.ctx, "secret.resolve", reference.id, async () => {
          if (await revoked())
            throw new ContractError("POLICY_DENIED", "Secret version is revoked", {
              reasonCode: "credential_revoked",
            });
          const value = await this.plaintext(reference);
          validateValue(value);
          if (await revoked())
            throw new ContractError("POLICY_DENIED", "Secret version is revoked", {
              reasonCode: "credential_revoked",
            });
          return value;
        }),
    };
  }
  private async plaintext(reference: SecretMetadata): Promise<string> {
    if (reference.provider === "ephemeral") {
      const memory = this.ephemeral.get(`${reference.id}:${reference.secretVersion}`);
      if (memory === undefined) throw unavailable();
      return memory;
    }
    if (reference.provider === "secret-tool")
      return keychain("lookup", reference.workspaceId, reference.id, reference.secretVersion);
    if (reference.provider === "vault")
      return vaultRead(this.layout, reference.workspaceId, reference.id, reference.secretVersion);
    throw unavailable();
  }
  /**
   * Plaintext for a purpose other than worker execution, for example a step-up export. It needs an
   * explicit unexpired `secrets:export` grant: no role implies it (ADR-017, ADR-019). The value is
   * returned only to the in-process caller and is never persisted or written to the audit trail.
   */
  async reveal(idOrName: string): Promise<{ id: string; secretVersion: number; value: string }> {
    return auditedOperation(this.ctx, "secret.reveal", this.auditResource(idOrName), async () => {
      if (!this.ctx.authorizeDecrypt)
        throw new ContractError("FORBIDDEN", "Secret decryption requires a secrets:export grant");
      this.ctx.authorizeDecrypt();
      const reference = this.lookup(idOrName);
      if (reference.revokedAt)
        throw new ContractError("POLICY_DENIED", "Secret is revoked", {
          reasonCode: "credential_revoked",
        });
      const value = await this.plaintext(reference);
      validateValue(value);
      return { id: reference.id, secretVersion: reference.secretVersion, value };
    });
  }
  async keyStatus(): Promise<{ activeKeyId: string; retiredKeyIds: string[] }> {
    this.ctx.authorize("A");
    const key = await vaultKey(this.layout, false);
    const directory = await vaultDirectory(this.layout.keyDirectory);
    try {
      let retiredKeyIds: string[] = [];
      try {
        retiredKeyIds = JSON.parse(
          (await readPrivate(directory, "vault-retired.json", MAX_SECRET_BYTES)).toString("utf8"),
        ) as string[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return { activeKeyId: createHash("sha256").update(key).digest("hex"), retiredKeyIds };
    } finally {
      key.fill(0);
      await directory.close();
    }
  }
  async rewrapKeys(): Promise<{ activeKeyId: string; previousKeyId: string; rewrapped: number }> {
    this.ctx.authorize("A");
    return auditedOperation(this.ctx, "secret.key.rewrap", "vault", async () => {
      const lock = await vaultLock(this.layout);
      let old: Buffer;
      try {
        old = await vaultKey(this.layout, false);
      } catch (error) {
        await lock.release();
        throw error;
      }
      const next = randomBytes(32);
      const previousKeyId = createHash("sha256").update(old).digest("hex");
      const activeKeyId = createHash("sha256").update(next).digest("hex");
      const retired = await this.keyStatus();
      if (retired.retiredKeyIds.includes(previousKeyId)) {
        old.fill(0);
        next.fill(0);
        await lock.release();
        throw new ContractError("PRECONDITION_FAILED", "Cannot rewrap with a retired active key");
      }
      let rewrapped = 0;
      try {
        try {
          await writePrivate(lock.directory, `${previousKeyId}.key`, old);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        // A controller whose key file is not the deployment's active key must not rewrap: it
        // would encrypt under a key the others do not hold.
        await assertActiveVaultKey(this.layout, previousKeyId);
        await replacePrivate(lock.directory, this.layout.keyName, next);
        await publishActiveVaultKey(this.layout, activeKeyId);
        for (const name of await ciphertextNames(this.layout)) {
          lock.renew();
          const stored = await ciphertextRead(this.layout, name, MAX_SECRET_BYTES * 2);
          let envelope: VaultEnvelope;
          if (stored[0] === 123) envelope = parseVaultEnvelope(stored);
          else {
            const reference = this.list().find(
              (entry) =>
                ciphertextName(this.layout, entry.workspaceId, entry.id, entry.secretVersion) ===
                name,
            );
            if (!reference)
              throw new ContractError(
                "PRECONDITION_FAILED",
                "Legacy vault object requires its workspace metadata before rewrap",
              );
            envelope = {
              formatVersion: 1,
              keyId: previousKeyId,
              workspace: reference.workspaceId,
              id: reference.id,
              version: reference.secretVersion,
              payload: stored.toString("base64"),
            };
          }
          const sourceKey =
            envelope.keyId === previousKeyId
              ? old
              : await readPrivate(lock.directory, `${envelope.keyId}.key`, 32);
          try {
            const bytes = Buffer.from(envelope.payload, "base64");
            const decipher = createDecipheriv("aes-256-gcm", sourceKey, bytes.subarray(0, 12));
            decipher.setAAD(aad(envelope.workspace, envelope.id, envelope.version));
            decipher.setAuthTag(bytes.subarray(12, 28));
            const value = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
            try {
              const nonce = randomBytes(12);
              const cipher = createCipheriv("aes-256-gcm", next, nonce);
              cipher.setAAD(aad(envelope.workspace, envelope.id, envelope.version));
              const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
              await ciphertextReplace(
                this.layout,
                name,
                Buffer.from(
                  JSON.stringify({
                    ...envelope,
                    keyId: activeKeyId,
                    payload: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString(
                      "base64",
                    ),
                  }),
                ),
              );
              rewrapped++;
            } finally {
              value.fill(0);
            }
          } finally {
            if (sourceKey !== old) sourceKey.fill(0);
          }
        }
        return { activeKeyId, previousKeyId, rewrapped };
      } finally {
        old.fill(0);
        next.fill(0);
        await lock.release();
      }
    });
  }
  async retireKey(
    keyId: string,
    dryRun = true,
  ): Promise<{ keyId: string; dryRun: boolean; references: string[]; retired: boolean }> {
    this.ctx.authorize("A");
    if (!/^[a-f0-9]{64}$/.test(keyId))
      throw new ContractError("INVALID_ARGUMENT", "Invalid vault key ID");
    return auditedOperation(this.ctx, "secret.key.retire", keyId, async () => {
      const lock = await vaultLock(this.layout);
      let key: Buffer;
      try {
        key = await vaultKey(this.layout, false);
      } catch (error) {
        await lock.release();
        throw error;
      }
      try {
        if (createHash("sha256").update(key).digest("hex") === keyId)
          throw new ContractError("PRECONDITION_FAILED", "Cannot retire active vault key");
        const references: string[] = [];
        for (const name of await ciphertextNames(this.layout)) {
          lock.renew();
          const bytes = await ciphertextRead(this.layout, name, MAX_SECRET_BYTES * 2);
          if (bytes[0] !== 123) references.push(name);
          else {
            const envelope = parseVaultEnvelope(bytes);
            if (envelope.keyId === keyId) references.push(name);
          }
        }
        if (!dryRun && references.length)
          throw new ContractError(
            "PRECONDITION_FAILED",
            "Vault ciphertexts still require this key",
            { references },
          );
        if (!dryRun) {
          let retired: string[] = [];
          try {
            retired = JSON.parse(
              (await readPrivate(lock.directory, "vault-retired.json", MAX_SECRET_BYTES)).toString(
                "utf8",
              ),
            ) as string[];
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await replacePrivate(
            lock.directory,
            "vault-retired.json",
            Buffer.from(JSON.stringify([...new Set([...retired, keyId])])),
          );
          await unlink(`/proc/self/fd/${lock.directory.fd}/${keyId}.key`).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
          await lock.directory.sync();
        }
        return { keyId, dryRun, references, retired: !dryRun };
      } finally {
        key.fill(0);
        await lock.release();
      }
    });
  }
  async health(): Promise<SecretBackendHealth> {
    this.ctx.authorize("R");
    return vaultHealth(this.layout);
  }
}
