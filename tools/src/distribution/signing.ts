import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import { lstat, open } from "node:fs/promises";

/**
 * Release trust: a detached Ed25519 signature over the exact bytes of `manifest.json`, a keyring
 * of trusted public keys and revocation/advisory lists. This module is shipped as a standalone
 * installer asset next to `install.js`, so it may import only Node builtins.
 */
export type ReleaseTrustErrorCode =
  | "SIGNATURE_MISSING"
  | "SIGNATURE_MALFORMED"
  | "SIGNATURE_INVALID"
  | "SIGNATURE_MANIFEST_MISMATCH"
  | "UNKNOWN_KEY"
  | "KEY_REVOKED"
  | "RELEASE_REVOKED"
  | "MANIFEST_PIN_MISMATCH"
  | "KEYRING_INVALID"
  | "ADVISORIES_INVALID"
  | "ADVISORIES_REQUIRED"
  | "SIGNING_KEY_UNSAFE";
export class ReleaseTrustError extends Error {
  readonly code: ReleaseTrustErrorCode;
  constructor(code: ReleaseTrustErrorCode, message: string) {
    super(message);
    this.name = "ReleaseTrustError";
    this.code = code;
  }
}
export const SIGNATURE_ALGORITHM = "ed25519";
/** Domain separation: a manifest signature can never be replayed as another kind of signature. */
export const SIGNATURE_CONTEXT = "testmaster-release-manifest-v1\n";
const MAX_SIGNATURE_BYTES = 4096;
const MAX_KEYRING_BYTES = 256 * 1024;
const MAX_ADVISORIES_BYTES = 1024 * 1024;

export interface ReleaseSignature {
  schemaVersion: "1.0.0";
  algorithm: typeof SIGNATURE_ALGORITHM;
  keyId: string;
  manifestSha256: string;
  /** Base64 Ed25519 signature over SIGNATURE_CONTEXT followed by the manifest bytes. */
  signature: string;
}
export interface ReleaseKey {
  keyId: string;
  /** SPKI PEM. */
  publicKey: string;
  createdAt: string;
  description: string;
}
export interface Keyring {
  schemaVersion: "1.0.0";
  keys: ReleaseKey[];
}
export interface Advisory {
  id: string;
  publishedAt: string;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  /** Runtime tags or source commits the advisory concerns; informational. */
  affects: string[];
}
export interface RevokedKey {
  keyId: string;
  revokedAt: string;
  reason: string;
}
export interface RevokedRelease {
  /** At least one of manifestSha256 and sourceCommit identifies the revoked release(s). */
  manifestSha256?: string;
  sourceCommit?: string;
  runtimeTag?: string;
  revokedAt: string;
  reason: string;
  advisoryId?: string;
}
export interface Advisories {
  schemaVersion: "1.0.0";
  updatedAt: string;
  advisories: Advisory[];
  revokedKeys: RevokedKey[];
  revokedReleases: RevokedRelease[];
}
export interface VerifiedRelease {
  keyId: string;
  manifestSha256: string;
}

const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const HEX64 = /^[a-f0-9]{64}$/u;
const HEX40 = /^[a-f0-9]{40}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

export function keyIdOf(publicKey: KeyObject): string {
  return sha256Hex(publicKey.export({ type: "spki", format: "der" }));
}
function record(value: unknown, fail: (message: string) => never, what: string) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${what} must be an object`);
  return value as Record<string, unknown>;
}
function exactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  fail: (message: string) => never,
  what: string,
): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) fail(`${what} has unknown field ${JSON.stringify(extra[0])}`);
}
function text(value: unknown, fail: (message: string) => never, what: string, max = 2000): string {
  if (typeof value !== "string" || !value || value.length > max || /[\0]/u.test(value))
    fail(`${what} must be a non-empty string`);
  return value as string;
}
function timestamp(value: unknown, fail: (message: string) => never, what: string): string {
  if (typeof value !== "string" || !TIMESTAMP.test(value) || Number.isNaN(Date.parse(value)))
    fail(`${what} must be an ISO-8601 UTC timestamp`);
  return value as string;
}

export function parseKeyring(value: unknown): Keyring {
  const fail = (message: string): never => {
    throw new ReleaseTrustError("KEYRING_INVALID", `Invalid release keyring: ${message}`);
  };
  const root = record(value, fail, "keyring");
  exactKeys(root, ["schemaVersion", "keys"], fail, "keyring");
  if (root.schemaVersion !== "1.0.0" || !Array.isArray(root.keys) || root.keys.length > 64)
    fail("unsupported schema or key list");
  const seen = new Set<string>();
  const keys = (root.keys as unknown[]).map((entry) => {
    const item = record(entry, fail, "key");
    exactKeys(item, ["keyId", "publicKey", "createdAt", "description"], fail, "key");
    const publicKey = text(item.publicKey, fail, "publicKey", 4096);
    let object: KeyObject;
    try {
      object = createPublicKey(publicKey);
    } catch {
      return fail("publicKey is not a PEM public key");
    }
    if (object.asymmetricKeyType !== "ed25519") fail("publicKey must be Ed25519");
    const keyId = text(item.keyId, fail, "keyId", 64);
    if (!HEX64.test(keyId) || keyId !== keyIdOf(object) || seen.has(keyId))
      fail("keyId does not match the public key or is duplicated");
    seen.add(keyId);
    return {
      keyId,
      publicKey,
      createdAt: timestamp(item.createdAt, fail, "createdAt"),
      description: text(item.description, fail, "description", 500),
    };
  });
  return { schemaVersion: "1.0.0", keys };
}
export function parseAdvisories(value: unknown): Advisories {
  const fail = (message: string): never => {
    throw new ReleaseTrustError("ADVISORIES_INVALID", `Invalid advisories: ${message}`);
  };
  const root = record(value, fail, "advisories");
  exactKeys(
    root,
    ["schemaVersion", "updatedAt", "advisories", "revokedKeys", "revokedReleases"],
    fail,
    "advisories",
  );
  if (
    root.schemaVersion !== "1.0.0" ||
    !Array.isArray(root.advisories) ||
    !Array.isArray(root.revokedKeys) ||
    !Array.isArray(root.revokedReleases) ||
    root.advisories.length > 5000 ||
    root.revokedKeys.length > 1000 ||
    root.revokedReleases.length > 5000
  )
    fail("unsupported schema or list bounds");
  const advisories = (root.advisories as unknown[]).map((entry) => {
    const item = record(entry, fail, "advisory");
    exactKeys(item, ["id", "publishedAt", "severity", "summary", "affects"], fail, "advisory");
    if (
      !["low", "medium", "high", "critical"].includes(item.severity as string) ||
      !Array.isArray(item.affects) ||
      item.affects.length > 200
    )
      fail("advisory severity or affects is invalid");
    return {
      id: text(item.id, fail, "advisory id", 100),
      publishedAt: timestamp(item.publishedAt, fail, "publishedAt"),
      severity: item.severity as Advisory["severity"],
      summary: text(item.summary, fail, "summary"),
      affects: (item.affects as unknown[]).map((affected) => text(affected, fail, "affects", 100)),
    };
  });
  const revokedKeys = (root.revokedKeys as unknown[]).map((entry) => {
    const item = record(entry, fail, "revoked key");
    exactKeys(item, ["keyId", "revokedAt", "reason"], fail, "revoked key");
    const keyId = text(item.keyId, fail, "keyId", 64);
    if (!HEX64.test(keyId)) fail("revoked keyId must be a SHA-256 hex digest");
    return {
      keyId,
      revokedAt: timestamp(item.revokedAt, fail, "revokedAt"),
      reason: text(item.reason, fail, "reason"),
    };
  });
  const revokedReleases = (root.revokedReleases as unknown[]).map((entry) => {
    const item = record(entry, fail, "revoked release");
    exactKeys(
      item,
      ["manifestSha256", "sourceCommit", "runtimeTag", "revokedAt", "reason", "advisoryId"],
      fail,
      "revoked release",
    );
    const release: RevokedRelease = {
      revokedAt: timestamp(item.revokedAt, fail, "revokedAt"),
      reason: text(item.reason, fail, "reason"),
    };
    if (item.manifestSha256 !== undefined) {
      if (typeof item.manifestSha256 !== "string" || !HEX64.test(item.manifestSha256))
        fail("manifestSha256 must be a SHA-256 hex digest");
      release.manifestSha256 = item.manifestSha256 as string;
    }
    if (item.sourceCommit !== undefined) {
      if (typeof item.sourceCommit !== "string" || !HEX40.test(item.sourceCommit))
        fail("sourceCommit must be a full commit SHA");
      release.sourceCommit = item.sourceCommit as string;
    }
    if (!release.manifestSha256 && !release.sourceCommit)
      fail("a revoked release needs manifestSha256 or sourceCommit");
    if (item.runtimeTag !== undefined)
      release.runtimeTag = text(item.runtimeTag, fail, "runtimeTag", 100);
    if (item.advisoryId !== undefined)
      release.advisoryId = text(item.advisoryId, fail, "advisoryId", 100);
    return release;
  });
  return {
    schemaVersion: "1.0.0",
    updatedAt: timestamp(root.updatedAt, fail, "updatedAt"),
    advisories,
    revokedKeys,
    revokedReleases,
  };
}
function parseSignature(bytes: Uint8Array): ReleaseSignature {
  const fail = (message: string): never => {
    throw new ReleaseTrustError("SIGNATURE_MALFORMED", `Malformed release signature: ${message}`);
  };
  if (bytes.length > MAX_SIGNATURE_BYTES) fail("oversized");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return fail("not JSON");
  }
  const root = record(value, fail, "signature");
  exactKeys(
    root,
    ["schemaVersion", "algorithm", "keyId", "manifestSha256", "signature"],
    fail,
    "signature",
  );
  if (
    root.schemaVersion !== "1.0.0" ||
    root.algorithm !== SIGNATURE_ALGORITHM ||
    typeof root.keyId !== "string" ||
    !HEX64.test(root.keyId) ||
    typeof root.manifestSha256 !== "string" ||
    !HEX64.test(root.manifestSha256) ||
    typeof root.signature !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/u.test(root.signature)
  )
    fail("unsupported fields");
  return root as unknown as ReleaseSignature;
}

export function generateReleaseKey(description: string): {
  privateKeyPem: string;
  key: ReleaseKey;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key: ReleaseKey = {
    keyId: keyIdOf(publicKey),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    createdAt: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
    description,
  };
  return { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), key };
}
/** Signs the exact manifest bytes. The private key is only ever used in memory. */
export function signManifestBytes(manifest: Uint8Array, privateKey: KeyObject): ReleaseSignature {
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new ReleaseTrustError("SIGNING_KEY_UNSAFE", "Signing key must be Ed25519");
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(SIGNATURE_CONTEXT), manifest]),
    privateKey,
  );
  return {
    schemaVersion: "1.0.0",
    algorithm: SIGNATURE_ALGORITHM,
    keyId: keyIdOf(createPublicKey(privateKey)),
    manifestSha256: sha256Hex(manifest),
    signature: signature.toString("base64"),
  };
}
export interface ReleaseTrust {
  keyring: Keyring;
  /** Every list is honoured; a revocation in any one of them refuses the release. */
  advisories: Advisories[];
}
/**
 * Authenticates manifest bytes. Nothing is parsed from the manifest before the signature
 * verifies; the source commit is read from authenticated bytes only for revocation matching.
 */
export function verifyReleaseSignature(input: {
  manifest: Uint8Array;
  signature: Uint8Array;
  trust: ReleaseTrust;
  pinnedManifestSha256?: string;
}): VerifiedRelease {
  const { trust } = input;
  if (!trust.advisories.length)
    throw new ReleaseTrustError(
      "ADVISORIES_REQUIRED",
      "At least one advisory/revocation list is required",
    );
  const envelope = parseSignature(input.signature);
  const key = trust.keyring.keys.find((candidate) => candidate.keyId === envelope.keyId);
  if (!key)
    throw new ReleaseTrustError("UNKNOWN_KEY", `Release signed by unknown key ${envelope.keyId}`);
  const revokedKey = trust.advisories
    .flatMap((list) => list.revokedKeys)
    .find((revoked) => revoked.keyId === envelope.keyId);
  if (revokedKey)
    throw new ReleaseTrustError(
      "KEY_REVOKED",
      `Signing key ${envelope.keyId} is revoked: ${revokedKey.reason}`,
    );
  const manifestSha256 = sha256Hex(input.manifest);
  if (envelope.manifestSha256 !== manifestSha256)
    throw new ReleaseTrustError(
      "SIGNATURE_MANIFEST_MISMATCH",
      "Signature does not belong to this manifest",
    );
  const valid = verify(
    null,
    Buffer.concat([Buffer.from(SIGNATURE_CONTEXT), input.manifest]),
    createPublicKey(key.publicKey),
    Buffer.from(envelope.signature, "base64"),
  );
  if (!valid) throw new ReleaseTrustError("SIGNATURE_INVALID", "Release signature is invalid");
  if (input.pinnedManifestSha256 !== undefined && input.pinnedManifestSha256 !== manifestSha256)
    throw new ReleaseTrustError("MANIFEST_PIN_MISMATCH", "Manifest hash mismatch");
  let sourceCommit: unknown;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(input.manifest).toString("utf8"));
    if (parsed && typeof parsed === "object" && "sourceCommit" in parsed)
      sourceCommit = parsed.sourceCommit;
  } catch {
    sourceCommit = undefined;
  }
  const revokedRelease = trust.advisories
    .flatMap((list) => list.revokedReleases)
    .find(
      (revoked) =>
        revoked.manifestSha256 === manifestSha256 ||
        (revoked.sourceCommit !== undefined && revoked.sourceCommit === sourceCommit),
    );
  if (revokedRelease)
    throw new ReleaseTrustError("RELEASE_REVOKED", `Release is revoked: ${revokedRelease.reason}`);
  return { keyId: envelope.keyId, manifestSha256 };
}

async function readBounded(
  path: string,
  max: number,
  missing?: ReleaseTrustError,
): Promise<Buffer> {
  const handle = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
    if (missing && error.code === "ENOENT") throw missing;
    throw error;
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max) throw new Error(`Unsupported trust file: ${path}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
export async function loadReleaseSignature(path: string): Promise<Buffer> {
  return readBounded(
    path,
    MAX_SIGNATURE_BYTES,
    new ReleaseTrustError(
      "SIGNATURE_MISSING",
      `Release manifest is unsigned: signature file not found (${path})`,
    ),
  );
}
export async function loadReleaseTrust(
  keyringPath: string,
  advisoryPaths: string[],
): Promise<ReleaseTrust> {
  if (!advisoryPaths.length)
    throw new ReleaseTrustError(
      "ADVISORIES_REQUIRED",
      "At least one advisory/revocation list is required",
    );
  const parse = async (path: string, max: number): Promise<unknown> => {
    try {
      return JSON.parse((await readBounded(path, max)).toString("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  };
  return {
    keyring: parseKeyring(await parse(keyringPath, MAX_KEYRING_BYTES)),
    advisories: await Promise.all(
      advisoryPaths.map(async (path) => parseAdvisories(await parse(path, MAX_ADVISORIES_BYTES))),
    ),
  };
}
/**
 * A private signing key must be a regular file owned by the caller and unreadable by group and
 * others, like an SSH key. The path comes from the caller; the key bytes are never logged.
 */
export async function assertPrivateKeyFileSafe(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new ReleaseTrustError(
      "SIGNING_KEY_UNSAFE",
      "Signing key must be a regular file with mode 0600 (no group/other access)",
    );
  if (process.getuid && stat.uid !== process.getuid())
    throw new ReleaseTrustError("SIGNING_KEY_UNSAFE", "Signing key must be owned by the caller");
}
