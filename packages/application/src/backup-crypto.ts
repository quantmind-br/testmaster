import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { Transform } from "node:stream";
import { ContractError } from "@testmaster/contracts";

/**
 * Server-profile backup encryption (ADR-019): AES-256-GCM over a chunked stream.
 *
 * Layout: `"TMBKP001" | chunkBytes u32 | nonce prefix (8 bytes)` followed by records
 * `final u8 | plaintextLength u32 | ciphertext | tag (16 bytes)`. The nonce of chunk `n` is the
 * prefix plus `n` as u32, so no nonce repeats within a stream. The additional authenticated data
 * binds the header, the stream context (the file's path inside the backup), the counter and the
 * final flag, so chunks cannot be reordered, dropped, truncated or moved to another file.
 */
export const backupChunkBytes = 64 * 1024;
const magic = Buffer.from("TMBKP001", "ascii");
const headerBytes = magic.length + 4 + 8;
const tagBytes = 16;
const maxChunkBytes = 1024 * 1024;

export interface BackupKey {
  key: Buffer;
  /** sha256 of the raw key, hex; recorded in manifests, never the key. */
  keyId: string;
}

/** Subkey for a purpose; the raw key only ever encrypts data. */
export function deriveSubkey(key: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), `testmaster:${purpose}`, 32));
}

/**
 * Reads a 32-byte key file: a regular, non-symlink file, mode 0600, owned by the current user.
 */
export async function readKeyFile(path: string, label: string): Promise<BackupKey> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ContractError(
      code === "ENOENT" ? "NOT_FOUND" : "PRECONDITION_FAILED",
      `${label} is not readable`,
      { reasonCode: "key_file_unavailable", errno: code },
    );
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.() ||
      info.size !== 32
    )
      throw new ContractError(
        "PRECONDITION_FAILED",
        `${label} must be a 32-byte regular file with mode 0600 owned by the current user`,
        { reasonCode: "key_file_invalid" },
      );
    const key = await handle.readFile();
    return { key, keyId: createHash("sha256").update(key).digest("hex") };
  } finally {
    await handle.close();
  }
}

function header(chunkBytes: number, prefix: Buffer): Buffer {
  const out = Buffer.alloc(headerBytes);
  magic.copy(out, 0);
  out.writeUInt32BE(chunkBytes, magic.length);
  prefix.copy(out, magic.length + 4);
  return out;
}

function chunkMaterial(
  head: Buffer,
  context: string,
  counter: number,
  final: boolean,
): { nonce: Buffer; aad: Buffer } {
  const counterBytes = Buffer.alloc(4);
  counterBytes.writeUInt32BE(counter);
  return {
    nonce: Buffer.concat([head.subarray(magic.length + 4, headerBytes), counterBytes]),
    aad: Buffer.concat([
      head,
      Buffer.from(context, "utf8"),
      counterBytes,
      Buffer.from([final ? 1 : 0]),
    ]),
  };
}

/** Encrypts a byte stream; `context` is authenticated but not stored (use the backup-relative path). */
export function encryptStream(
  key: BackupKey,
  context: string,
  chunkBytes = backupChunkBytes,
): Transform {
  const head = header(chunkBytes, randomBytes(8));
  let pending = Buffer.alloc(0);
  let counter = 0;
  let started = false;
  const seal = (plain: Buffer, final: boolean): Buffer => {
    if (counter > 0xffffffff) throw new ContractError("INTERNAL", "Backup stream too long");
    const { nonce, aad } = chunkMaterial(head, context, counter, final);
    counter += 1;
    const cipher = createCipheriv("aes-256-gcm", key.key, nonce);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    const record = Buffer.alloc(5);
    record.writeUInt8(final ? 1 : 0, 0);
    record.writeUInt32BE(plain.length, 1);
    return Buffer.concat([record, body, cipher.getAuthTag()]);
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        if (!started) {
          started = true;
          this.push(head);
        }
        pending = Buffer.concat([pending, chunk]);
        // The last chunk must be marked final, so a full chunk is only sealed once more data follows.
        while (pending.length > chunkBytes) {
          this.push(seal(pending.subarray(0, chunkBytes), false));
          pending = pending.subarray(chunkBytes);
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        if (!started) this.push(head);
        this.push(seal(pending, true));
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

const corrupt = (message: string): ContractError =>
  new ContractError("PRECONDITION_FAILED", message, { reasonCode: "backup_integrity" });

/** Decrypts and authenticates a stream produced by `encryptStream` with the same context. */
export function decryptStream(key: BackupKey, context: string): Transform {
  let buffer = Buffer.alloc(0);
  let head: Buffer | null = null;
  let chunkBytes = 0;
  let counter = 0;
  let finished = false;
  const open_ = (plainLength: number, final: boolean, body: Buffer): Buffer => {
    if (!head) throw corrupt("Backup header missing");
    const { nonce, aad } = chunkMaterial(head, context, counter, final);
    counter += 1;
    const decipher = createDecipheriv("aes-256-gcm", key.key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(body.subarray(plainLength));
    try {
      return Buffer.concat([decipher.update(body.subarray(0, plainLength)), decipher.final()]);
    } catch {
      throw corrupt("Backup chunk failed authentication");
    }
  };
  const drain = (push: (data: Buffer) => void): void => {
    if (!head) {
      if (buffer.length < headerBytes) return;
      head = buffer.subarray(0, headerBytes);
      if (!head.subarray(0, magic.length).equals(magic))
        throw corrupt("Not a TestMaster backup stream");
      chunkBytes = head.readUInt32BE(magic.length);
      if (chunkBytes < 1 || chunkBytes > maxChunkBytes) throw corrupt("Unsupported chunk size");
      buffer = buffer.subarray(headerBytes);
    }
    for (;;) {
      if (finished) {
        if (buffer.length) throw corrupt("Unexpected data after the final chunk");
        return;
      }
      if (buffer.length < 5) return;
      const final = buffer.readUInt8(0);
      const plainLength = buffer.readUInt32BE(1);
      if ((final !== 0 && final !== 1) || plainLength > chunkBytes)
        throw corrupt("Invalid chunk record");
      const total = 5 + plainLength + tagBytes;
      if (buffer.length < total) return;
      const plain = open_(plainLength, final === 1, buffer.subarray(5, total));
      buffer = buffer.subarray(total);
      if (final === 1) finished = true;
      if (plain.length) push(plain);
    }
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        drain((data) => this.push(data));
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      if (!finished) callback(corrupt("Backup stream is truncated"));
      else callback();
    },
  });
}

/** HMAC over the canonical manifest (without `mac`), keyed with a subkey of the backup key. */
export function manifestMac(key: BackupKey, manifest: object): string {
  const { mac: _ignored, ...rest } = manifest as Record<string, unknown>;
  return createHmac("sha256", deriveSubkey(key.key, "backup-manifest-v1"))
    .update(canonicalJson(rest))
    .digest("hex");
}

export function verifyManifestMac(key: BackupKey, manifest: { mac?: string }): boolean {
  const expected = Buffer.from(manifestMac(key, manifest), "hex");
  const actual = Buffer.from(typeof manifest.mac === "string" ? manifest.mac : "", "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, item]) => `${JSON.stringify(name)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
