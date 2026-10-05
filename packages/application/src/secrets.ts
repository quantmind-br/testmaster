import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, mkdir, open, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ContractError, type SecretReference } from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import { type EntityDocument, IdempotencyRepository } from "@testmaster/persistence";
import type { SecretRelease } from "@testmaster/sandbox";
import type { ResolvedConfig } from "./config.js";
import { allEntities, entity, type ServiceContext } from "./context.js";

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
      if (last) await child.chmod(0o700);
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
async function vaultKey(config: ResolvedConfig, allowCreate: boolean): Promise<Buffer> {
  const directory = await privateDirectory(join(config.home, ".config", "testmaster"));
  try {
    let key: Buffer;
    try {
      key = await readPrivate(directory, "vault.key", 32);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!allowCreate) throw unavailable();
      const vault = await privateDirectory(join(config.home, ".local", "share", "testmaster"));
      try {
        if ((await readdir(`/proc/self/fd/${vault.fd}`)).some((name) => name.endsWith(".vault")))
          throw unavailable();
      } finally {
        await vault.close();
      }
      const candidate = randomBytes(32);
      try {
        await writePrivate(directory, "vault.key", candidate);
      } catch (creation) {
        if ((creation as NodeJS.ErrnoException).code !== "EEXIST") throw creation;
      } finally {
        candidate.fill(0);
      }
      key = await readPrivate(directory, "vault.key", 32);
    }
    if (key.length !== 32) {
      key.fill(0);
      throw unavailable();
    }
    return key;
  } finally {
    await directory.close();
  }
}
function aad(workspace: string, id: string, version: number): Buffer {
  return Buffer.from(JSON.stringify([workspace, id, version]));
}
async function vaultWrite(
  config: ResolvedConfig,
  workspace: string,
  id: string,
  version: number,
  value: string,
  allowCreate = true,
): Promise<void> {
  const key = await vaultKey(config, allowCreate);
  let directory: FileHandle | undefined;
  try {
    directory = await privateDirectory(join(config.home, ".local", "share", "testmaster"));
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(workspace, id, version));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    await writePrivate(
      directory,
      vaultName(id, version),
      Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]),
    );
  } finally {
    key.fill(0);
    await directory?.close();
  }
}
async function vaultRead(
  config: ResolvedConfig,
  workspace: string,
  id: string,
  version: number,
): Promise<string> {
  // Missing key after restore must fail, never create a replacement key when reading.
  const keys = await privateDirectory(join(config.home, ".config", "testmaster"));
  let key: Buffer | undefined;
  let directory: FileHandle | undefined;
  try {
    key = await readPrivate(keys, "vault.key", 32);
    if (key.length !== 32) throw unavailable();
    directory = await privateDirectory(join(config.home, ".local", "share", "testmaster"));
    const bytes = await readPrivate(directory, vaultName(id, version), MAX_SECRET_BYTES + 28);
    if (bytes.length < 29) throw unavailable();
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAAD(aad(workspace, id, version));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    throw unavailable();
  } finally {
    key?.fill(0);
    await directory?.close();
    await keys.close();
  }
}
async function erase(config: ResolvedConfig, reference: SecretMetadata): Promise<void> {
  if (reference.provider === "secret-tool") {
    await keychain("clear", reference.workspaceId, reference.id, reference.secretVersion);
  } else if (reference.provider === "vault") {
    const directory = await privateDirectory(join(config.home, ".local", "share", "testmaster"));
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
export async function health(config: ResolvedConfig): Promise<SecretBackendHealth> {
  const id = `sec_${randomBytes(16).toString("hex")}`;
  const canary = randomBytes(32).toString("hex");
  try {
    await keychain("store", "doctor", id, 1, canary);
    const matches = (await keychain("lookup", "doctor", id, 1)) === canary;
    await keychain("clear", "doctor", id, 1);
    if (matches) return { backend: "secret-tool", writable: true };
  } catch {
    /* Try the encrypted fallback, never plaintext persistence. */
  }
  try {
    await vaultWrite(config, "doctor", id, 1, canary);
    const matches = (await vaultRead(config, "doctor", id, 1)) === canary;
    const directory = await privateDirectory(join(config.home, ".local", "share", "testmaster"));
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
  constructor(
    private readonly ctx: ServiceContext,
    private readonly config: ResolvedConfig,
  ) {}
  list(): SecretMetadata[] {
    this.ctx.authorize("R");
    return allEntities(this.ctx, "SecretReference") as SecretMetadata[];
  }
  get(idOrName: string): SecretMetadata {
    this.ctx.authorize("R");
    return this.lookup(idOrName);
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
    try {
      await keychain("store", reference.workspaceId, reference.id, reference.secretVersion, value);
      return "secret-tool";
    } catch {
      /* Fall back only to authenticated encryption. */
    }
    try {
      const hasVaultReferences = (
        allEntities(this.ctx, "SecretReference") as SecretMetadata[]
      ).some((entry) => entry.provider === "vault");
      await vaultWrite(
        this.config,
        reference.workspaceId,
        reference.id,
        reference.secretVersion,
        value,
        !hasVaultReferences,
      );
      return "vault";
    } catch {
      throw unavailable();
    }
  }
  async set(
    name: string,
    value: string,
    options: { ephemeral?: boolean; allowedOrigins?: string[]; idempotencyKey?: string } = {},
  ): Promise<SecretMetadata> {
    this.ctx.authorize("W");
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
      await erase(this.config, reference).catch(() => {});
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
      await erase(this.config, reference).catch(() => {});
      throw error;
    }
    return reference;
  }
  async rotate(idOrName: string, value: string): Promise<SecretMetadata> {
    this.ctx.authorize("W");
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
      await erase(this.config, next).catch(() => {});
      throw error;
    }
    this.ephemeral.delete(`${previous.id}:${previous.secretVersion}`);
    await erase(this.config, previous).catch(() => {});
    return next;
  }
  async remove(idOrName: string, idempotencyKey?: string): Promise<SecretMetadata> {
    this.ctx.authorize("W");
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
            operation: `secret.remove:${idOrName}`,
            key: idempotencyKey,
            body: {},
          },
          commit,
        ).receipt
      : this.ctx.database.withTx(commit);
    this.ephemeral.delete(`${previous.id}:${previous.secretVersion}`);
    await erase(this.config, previous).catch(() => {});
    return receipt;
  }
  async release(id: string): Promise<SecretRelease> {
    this.ctx.authorize("X");
    const reference = this.lookup(id);
    origins(reference.allowedOrigins);
    if (reference.revokedAt) throw new ContractError("POLICY_DENIED", "Secret is revoked");
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
      resolve: async () => {
        if (await revoked()) throw new ContractError("POLICY_DENIED", "Secret version is revoked");
        let value: string;
        if (reference.provider === "ephemeral") {
          const memory = this.ephemeral.get(`${reference.id}:${reference.secretVersion}`);
          if (memory === undefined) throw unavailable();
          value = memory;
        } else if (reference.provider === "secret-tool")
          value = await keychain(
            "lookup",
            reference.workspaceId,
            reference.id,
            reference.secretVersion,
          );
        else if (reference.provider === "vault")
          value = await vaultRead(
            this.config,
            reference.workspaceId,
            reference.id,
            reference.secretVersion,
          );
        else throw unavailable();
        validateValue(value);
        if (await revoked()) throw new ContractError("POLICY_DENIED", "Secret version is revoked");
        return value;
      },
    };
  }
  async health(): Promise<SecretBackendHealth> {
    this.ctx.authorize("R");
    return health(this.config);
  }
}
