import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { expect, it } from "vitest";
import {
  type BackupKey,
  decryptStream,
  encryptStream,
  manifestMac,
  readKeyFile,
  verifyManifestMac,
} from "./backup-crypto.js";

const key: BackupKey = { key: Buffer.alloc(32, 7), keyId: "a".repeat(64) };

async function collect(source: Buffer, ...transforms: NodeJS.ReadWriteStream[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline(
    Readable.from([source]),
    ...transforms,
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    }),
  );
  return Buffer.concat(chunks);
}

const seal = (plain: Buffer, context = "database.dump", chunkBytes = 64) =>
  collect(plain, encryptStream(key, context, chunkBytes));
const open = (cipher: Buffer, context = "database.dump") =>
  collect(cipher, decryptStream(key, context));

it("OPS-024 chunked backup encryption round-trips an empty stream, one chunk and many chunks", async () => {
  for (const size of [0, 1, 63, 64, 65, 64 * 5, 64 * 5 + 17]) {
    const plain = Buffer.alloc(size, size % 251);
    const cipher = await seal(plain);
    expect(cipher.includes(plain.subarray(0, 8)) && size > 8).toBe(false);
    expect((await open(cipher)).equals(plain)).toBe(true);
  }
});

it("OPS-024 a flipped ciphertext byte, a reordered chunk, a truncated tail and extra trailing bytes are refused", async () => {
  const plain = Buffer.alloc(64 * 4 + 5, 3);
  const cipher = await seal(plain);
  const flipped = Buffer.from(cipher);
  flipped[40] = (flipped[40] ?? 0) ^ 0xff;
  await expect(open(flipped)).rejects.toMatchObject({
    details: { reasonCode: "backup_integrity" },
  });
  // Truncating after a whole non-final chunk drops the final marker.
  const recordBytes = 5 + 64 + 16;
  const truncated = cipher.subarray(0, 20 + recordBytes * 2);
  await expect(open(truncated)).rejects.toMatchObject({
    details: { reasonCode: "backup_integrity" },
  });
  const trailing = Buffer.concat([cipher, Buffer.from([1])]);
  await expect(open(trailing)).rejects.toMatchObject({
    details: { reasonCode: "backup_integrity" },
  });
  // Marking a non-final chunk final and dropping the tail is caught by the authenticated flag.
  const forged = Buffer.from(cipher.subarray(0, 20 + recordBytes * 2));
  forged[20 + recordBytes] = 1;
  await expect(open(forged)).rejects.toMatchObject({
    details: { reasonCode: "backup_integrity" },
  });
  const swapped = Buffer.concat([
    cipher.subarray(0, 20),
    cipher.subarray(20 + recordBytes, 20 + recordBytes * 2),
    cipher.subarray(20, 20 + recordBytes),
    cipher.subarray(20 + recordBytes * 2),
  ]);
  await expect(open(swapped)).rejects.toMatchObject({
    details: { reasonCode: "backup_integrity" },
  });
  // Control: the unmodified stream still opens.
  expect((await open(cipher)).equals(plain)).toBe(true);
});

it("OPS-024 a stream cannot be opened under another context or another key", async () => {
  const cipher = await seal(Buffer.from("payload"), "evidence/runs/a.bin");
  await expect(open(cipher, "evidence/runs/b.bin")).rejects.toMatchObject({
    details: { reasonCode: "backup_integrity" },
  });
  const other: BackupKey = { key: Buffer.alloc(32, 9), keyId: "b".repeat(64) };
  await expect(collect(cipher, decryptStream(other, "evidence/runs/a.bin"))).rejects.toMatchObject({
    details: { reasonCode: "backup_integrity" },
  });
  expect((await open(cipher, "evidence/runs/a.bin")).toString()).toBe("payload");
});

it("OPS-024 the manifest MAC covers every field and rejects another key", () => {
  const manifest = { files: [{ relativePath: "a", sha256: "0".repeat(64) }], databaseVersion: 13 };
  const mac = manifestMac(key, manifest);
  expect(verifyManifestMac(key, { ...manifest, mac })).toBe(true);
  expect(verifyManifestMac(key, { ...manifest, databaseVersion: 12, mac })).toBe(false);
  const other: BackupKey = { key: Buffer.alloc(32, 9), keyId: "b".repeat(64) };
  expect(verifyManifestMac(other, { ...manifest, mac })).toBe(false);
  expect(verifyManifestMac(key, manifest)).toBe(false);
});

it("OPS-024 a key file must be a private 32-byte regular file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tm-keyfile-"));
  try {
    const good = join(dir, "good.key");
    await writeFile(good, Buffer.alloc(32, 1), { mode: 0o600 });
    const read = await readKeyFile(good, "key");
    expect(read.keyId).toHaveLength(64);
    const loose = join(dir, "loose.key");
    await writeFile(loose, Buffer.alloc(32, 1), { mode: 0o644 });
    await chmod(loose, 0o644);
    await expect(readKeyFile(loose, "key")).rejects.toMatchObject({
      details: { reasonCode: "key_file_invalid" },
    });
    const short = join(dir, "short.key");
    await writeFile(short, Buffer.alloc(31, 1), { mode: 0o600 });
    await expect(readKeyFile(short, "key")).rejects.toMatchObject({
      details: { reasonCode: "key_file_invalid" },
    });
    const link = join(dir, "link.key");
    await symlink(good, link);
    await expect(readKeyFile(link, "key")).rejects.toMatchObject({
      details: { reasonCode: "key_file_unavailable" },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
