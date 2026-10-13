import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ContractError, type SecretReference } from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import { type EntityDocument, IdempotencyRepository } from "@testmaster/persistence";
import type { SecretRelease } from "@testmaster/sandbox";
import { auditedOperation } from "./audit.js";
import type { ResolvedConfig } from "./config.js";
import { allEntities, entity, type ServiceContext } from "./context.js";
import { filesystemRoot, type ServerConfig } from "./server-config.js";

export type SecretMetadata = SecretReference & EntityDocument & { version: number };
export interface SecretBackendHealth {
  backend: "secret-tool" | "vault" | "unavailable";
  writable: boolean;
}
const MAX_SECRET_BYTES = 65536;

function unavailable(): ContractError {
  return new ContractError(
    "PRECONDITION_FAILED",
    "Secure secret storage is unavailable; explicit ephemeral mode is required",
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

// Pin every directory through an open FD. /proc/self/fd paths keep subsequent operations
// confined even if an ancestor is renamed; O_NOFOLLOW prevents symlink substitution.
export async function privateDirectory(path: string): Promise<FileHandle> {
  let handle = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const segments = resolve(path).split("/").filter(Boolean);
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      const childPath = `/proc/self/fd/${handle.fd}/${segment}`;
      let child: FileHandle;
      try {
        child = await open(
          childPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable();
        try {
          await mkdir(childPath, { mode: 0o700 });
        } catch (creation) {
          if ((creation as NodeJS.ErrnoException).code !== "EEXIST") throw creation;
        }
        child = await open(
          childPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      }
      const stat = await child.stat();
      const uid = process.getuid?.();
      const last = index === segments.length - 1;
      if (
        (uid !== undefined && stat.uid !== uid && stat.uid !== 0) ||
        ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0)) ||
        (last && uid !== undefined && stat.uid !== uid)
      ) {
        await child.close();
        throw unavailable();
      }
      // A directory that is already private needs no chmod, which also lets a deployment mount it read-only.
      if (last && (stat.mode & 0o777) !== 0o700) await child.chmod(0o700);
      await handle.close();
      handle = child;
    }
    return handle;
  } catch {
    await handle.close();
    throw unavailable();
  }
}
async function readPrivate(directory: FileHandle, name: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(
    `/proc/self/fd/${directory.fd}/${name}`,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
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
 */
export interface VaultLayout {
  readonly profile: "local" | "server";
  readonly keyDirectory: string;
  readonly keyName: string;
  readonly dataDirectory: string;
  readonly lockDirectory: string;
}
export function serverVaultLayout(server: ServerConfig): VaultLayout {
  const dataDirectory = join(filesystemRoot(server.storage), "secrets");
  return {
    profile: "server",
    keyDirectory: dirname(server.security.masterKeyFile),
    keyName: basename(server.security.masterKeyFile),
    dataDirectory,
    lockDirectory: dataDirectory,
  };
}
export function vaultLayout(config: ResolvedConfig, server?: ServerConfig): VaultLayout {
  if (server) return serverVaultLayout(server);
  const keyDirectory = join(config.home, ".config", "testmaster");
  return {
    profile: "local",
    keyDirectory,
    keyName: "vault.key",
    dataDirectory: join(config.home, ".local", "share", "testmaster"),
    lockDirectory: keyDirectory,
  };
}
/** A restore or a misconfigured deployment without its key must fail loudly, never mint a new one. */
function masterKeyUnavailable(): ContractError {
  return new ContractError("PRECONDITION_FAILED", "Master key is unavailable", {
    reasonCode: "master_key_unavailable",
  });
}
async function vaultKey(layout: VaultLayout, allowCreate: boolean): Promise<Buffer> {
  const directory = await privateDirectory(layout.keyDirectory).catch((error: unknown) => {
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
      const vault = await privateDirectory(layout.dataDirectory);
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
async function vaultLock(
  layout: VaultLayout,
): Promise<{ directory: FileHandle; release(): Promise<void> }> {
  const directory = await privateDirectory(layout.keyDirectory);
  let lockDirectory = directory;
  if (layout.lockDirectory !== layout.keyDirectory)
    try {
      lockDirectory = await privateDirectory(layout.lockDirectory);
    } catch (error) {
      await directory.close();
      throw error;
    }
  const closeAll = async () => {
    if (lockDirectory !== directory) await lockDirectory.close();
    await directory.close();
  };
  const path = `/proc/self/fd/${lockDirectory.fd}/vault.lock`;
  try {
    try {
      const lock = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await lock.writeFile(String(process.pid));
      await lock.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number((await readPrivate(lockDirectory, "vault.lock", 32)).toString());
      if (!Number.isSafeInteger(pid) || pid < 1) throw unavailable();
      try {
        process.kill(pid, 0);
        throw new ContractError("PRECONDITION_FAILED", "Vault key maintenance is busy");
      } catch (owner) {
        if ((owner as NodeJS.ErrnoException).code !== "ESRCH") throw owner;
      }
      await unlink(path);
      const lock = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await lock.writeFile(String(process.pid));
      await lock.close();
    }
    return {
      directory,
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
): Promise<void> {
  const lock = await vaultLock(layout);
  let key: Buffer | undefined;
  let directory: FileHandle | undefined;
  try {
    key = await vaultKey(layout, allowCreate);
    directory = await privateDirectory(layout.dataDirectory);
    const nonce = randomBytes(12);
    const keyId = createHash("sha256").update(key).digest("hex");
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(workspace, id, version));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    await writePrivate(
      directory,
      vaultName(id, version),
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
    await directory?.close();
    await lock.release();
  }
}
async function vaultRead(
  layout: VaultLayout,
  workspace: string,
  id: string,
  version: number,
): Promise<string> {
  // Missing key after restore must fail, never create a replacement key when reading.
  const keys = await privateDirectory(layout.keyDirectory).catch((error: unknown) => {
    throw layout.profile === "server" ? masterKeyUnavailable() : error;
  });
  let key: Buffer | undefined;
  let directory: FileHandle | undefined;
  try {
    key = await readPrivate(keys, layout.keyName, 32).catch((error: unknown) => {
      throw layout.profile === "server" ? masterKeyUnavailable() : error;
    });
    if (key.length !== 32)
      throw layout.profile === "server" ? masterKeyUnavailable() : unavailable();
    directory = await privateDirectory(layout.dataDirectory);
    const stored = await readPrivate(directory, vaultName(id, version), MAX_SECRET_BYTES * 2);
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
    await directory?.close();
    await keys.close();
  }
}
async function erase(layout: VaultLayout, reference: SecretMetadata): Promise<void> {
  if (reference.provider === "secret-tool") {
    await keychain("clear", reference.workspaceId, reference.id, reference.secretVersion);
  } else if (reference.provider === "vault") {
    const directory = await privateDirectory(layout.dataDirectory);
    try {
      await unlink(
        `/proc/self/fd/${directory.fd}/${vaultName(reference.id, reference.secretVersion)}`,
      );
    } finally {
      await directory.close();
    }
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
  // The server profile has no desktop keychain, and its workspace ids are real ones.
  const probeWorkspace =
    layout.profile === "server" ? "ws_00000000-0000-4000-8000-000000000000" : "doctor";
  if (layout.profile === "local")
    try {
      await keychain("store", "doctor", id, 1, canary);
      const matches = (await keychain("lookup", "doctor", id, 1)) === canary;
      await keychain("clear", "doctor", id, 1);
      if (matches) return { backend: "secret-tool", writable: true };
    } catch {
      /* Try the encrypted fallback, never plaintext persistence. */
    }
  try {
    await vaultWrite(layout, probeWorkspace, id, 1, canary, layout.profile === "local");
    const matches = (await vaultRead(layout, probeWorkspace, id, 1)) === canary;
    const directory = await privateDirectory(layout.dataDirectory);
    try {
      await unlink(`/proc/self/fd/${directory.fd}/${vaultName(id, 1)}`);
    } finally {
      await directory.close();
    }
    if (matches) return { backend: "vault", writable: true };
  } catch {
    /* A read-only or unsafe home is unavailable, not session persistence. */
  }
  return { backend: "unavailable", writable: false };
}

export class SecretsService {
  private readonly ephemeral = new Map<string, string>();
  private readonly layout: VaultLayout;
  constructor(
    private readonly ctx: ServiceContext,
    config: ResolvedConfig,
    server?: ServerConfig,
  ) {
    this.layout = vaultLayout(config, server);
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
      if (this.layout.profile === "server" && error instanceof ContractError) throw error;
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
    if (
      (allEntities(this.ctx, "SecretReference") as SecretMetadata[]).some(
        (entry) => entry.locator === name && !entry.revokedAt,
      )
    )
      throw new ContractError("REVISION_CONFLICT", "Secret name already exists; use rotate");
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
      if (options.idempotencyKey)
        return new IdempotencyRepository(this.ctx.database).execute(
          {
            workspaceId: this.ctx.workspaceId,
            actorScope: this.ctx.principalId,
            operation: "secret.set",
            key: options.idempotencyKey,
            body,
          },
          commit,
        ).receipt;
      this.ctx.database.withTx(commit);
    } catch (error) {
      this.ephemeral.delete(`${reference.id}:1`);
      await erase(this.layout, reference).catch(() => {});
      throw error;
    }
    return reference;
  }
  /** Trusted supervisor capture path; requires execution authority and never exports plaintext. */
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
    reference.provider = await this.persist(reference, encoded, false);
    try {
      this.ctx.entities.insert("SecretReference", reference);
    } catch (error) {
      await erase(this.layout, reference).catch(() => {});
      throw error;
    }
    return reference;
  }
  async rotate(idOrName: string, value: string): Promise<SecretMetadata> {
    return auditedOperation(this.ctx, "secret.rotate", this.auditResource(idOrName), () =>
      this.rotateValue(idOrName, value),
    );
  }
  private async rotateValue(idOrName: string, value: string): Promise<SecretMetadata> {
    this.ctx.authorize("W");
    this.ctx.authorizeColumn("secret");
    validateValue(value);
    const previous = this.lookup(idOrName);
    if (previous.revokedAt) throw new ContractError("POLICY_DENIED", "Secret is revoked");
    const next = {
      ...previous,
      secretVersion: previous.secretVersion + 1,
      version: previous.version + 1,
    };
    next.provider = await this.persist(next, value, previous.provider === "ephemeral");
    try {
      this.ctx.entities.update(
        "SecretReference",
        this.ctx.workspaceId,
        previous.id,
        previous.version,
        next,
      );
    } catch (error) {
      this.ephemeral.delete(`${next.id}:${next.secretVersion}`);
      await erase(this.layout, next).catch(() => {});
      throw error;
    }
    this.ephemeral.delete(`${previous.id}:${previous.secretVersion}`);
    await erase(this.layout, previous).catch(() => {});
    return next;
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
    if (!reference.allowedOrigins.length)
      throw new ContractError("POLICY_DENIED", "Secret has no authorized target origins");
    const revoked = async (): Promise<boolean> => {
      this.ctx.authorize("X");
      const current = this.ctx.entities.get<SecretMetadata>(
        "SecretReference",
        this.ctx.workspaceId,
        reference.id,
      );
      return (
        !current || Boolean(current.revokedAt) || current.secretVersion !== reference.secretVersion
      );
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
    const directory = await privateDirectory(this.layout.keyDirectory);
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
      let directory: FileHandle;
      let old: Buffer;
      try {
        directory = await privateDirectory(this.layout.dataDirectory);
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
        await directory.close();
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
        await replacePrivate(lock.directory, this.layout.keyName, next);
        for (const name of (await readdir(`/proc/self/fd/${directory.fd}`)).filter((name) =>
          name.endsWith(".vault"),
        )) {
          const stored = await readPrivate(directory, name, MAX_SECRET_BYTES * 2);
          let envelope: VaultEnvelope;
          if (stored[0] === 123) envelope = parseVaultEnvelope(stored);
          else {
            const reference = this.list().find(
              (entry) => vaultName(entry.id, entry.secretVersion) === name,
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
              await replacePrivate(
                directory,
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
        await directory.close();
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
      let directory: FileHandle;
      let key: Buffer;
      try {
        directory = await privateDirectory(this.layout.dataDirectory);
        key = await vaultKey(this.layout, false);
      } catch (error) {
        await lock.release();
        throw error;
      }
      try {
        if (createHash("sha256").update(key).digest("hex") === keyId)
          throw new ContractError("PRECONDITION_FAILED", "Cannot retire active vault key");
        const references: string[] = [];
        for (const name of (await readdir(`/proc/self/fd/${directory.fd}`)).filter((name) =>
          name.endsWith(".vault"),
        )) {
          const bytes = await readPrivate(directory, name, MAX_SECRET_BYTES * 2);
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
        await directory.close();
        await lock.release();
      }
    });
  }
  async health(): Promise<SecretBackendHealth> {
    this.ctx.authorize("R");
    return vaultHealth(this.layout);
  }
}
