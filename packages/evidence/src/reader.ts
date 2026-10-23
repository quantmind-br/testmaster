import { createHash } from "node:crypto";
import {
  type ArtifactManifest,
  type BundleMeta,
  ContractError,
  parseAndValidate,
} from "@testmaster/contracts";
import { canonicalJson, sha256 } from "@testmaster/domain";
import { type ObjectStore, readObjectChunks } from "./object-store.js";
import { validateRelativePath } from "./path.js";
import type { AttemptIds } from "./store.js";

export class BundleIntegrityError extends Error {
  readonly code = "BUNDLE_INTEGRITY_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "BundleIntegrityError";
  }
}
export interface BundleExpectations extends AttemptIds {
  manifestSha256?: string;
  /** Supervisor-authorized tombstones; never supplied directly by download clients. */
  expiredArtifactIds?: readonly string[];
}
export interface VerifiedBundle {
  store: ObjectStore;
  /** `runs/<workspace>/<run>/<attempt>`, derived from the bundle's ids. */
  bundleKey: string;
  manifest: ArtifactManifest;
  meta: BundleMeta;
}
/** An object the bundle needs is not in the store: never committed, or removed afterwards. */
export class BundleNotFoundError extends Error {
  readonly code = "BUNDLE_NOT_FOUND";
  constructor(readonly key: string) {
    super(`Bundle object is missing: ${key}`);
    this.name = "BundleNotFoundError";
  }
}
/** Hashes a whole object, refusing more bytes than `maxBytes` before they are hashed. */
async function hashObject(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<{ hash: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new BundleIntegrityError("Artifact exceeds declared size/limit");
    hash.update(chunk);
  }
  return { hash: hash.digest("hex"), size };
}
async function openObject(store: ObjectStore, key: string): Promise<AsyncIterable<Uint8Array>> {
  const body = await readObjectChunks(store, key);
  if (!body) throw new BundleNotFoundError(key);
  return body;
}
async function readMetadata(store: ObjectStore, key: string, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of await openObject(store, key)) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new BundleIntegrityError("Bundle metadata too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export async function verifyBundle(
  store: ObjectStore,
  bundleKey: string,
  expected: BundleExpectations,
  maxObjectBytes = 64 * 1024 * 1024,
): Promise<VerifiedBundle> {
  let meta: BundleMeta;
  let manifest: ArtifactManifest;
  try {
    meta = parseAndValidate<BundleMeta>(
      "BundleMeta",
      await readMetadata(store, `${bundleKey}/meta.json`, 1024 * 1024),
    );
    manifest = parseAndValidate<ArtifactManifest>(
      "ArtifactManifest",
      await readMetadata(store, `${bundleKey}/manifest.json`, 16 * 1024 * 1024),
      16 * 1024 * 1024,
    );
  } catch (error) {
    if (
      error instanceof ContractError &&
      ["INVALID_ARGUMENT", "LIMIT_EXCEEDED"].includes(error.code)
    )
      throw new BundleIntegrityError(`Invalid bundle metadata: ${error.message}`);
    throw error;
  }
  for (const key of ["workspaceId", "runId", "attemptId", "revisionId", "snapshotId"] as const) {
    if (meta[key] !== expected[key] || manifest[key] !== expected[key])
      throw new BundleIntegrityError(`Foreign bundle ${key}`);
  }
  const hash = sha256(canonicalJson(manifest));
  if (
    meta.manifestHash !== hash ||
    (expected.manifestSha256 !== undefined && hash !== expected.manifestSha256)
  )
    throw new BundleIntegrityError("Manifest hash mismatch");
  const seen = new Set<string>();
  let total = 0;
  for (const entry of manifest.entries) {
    validateRelativePath(entry.relativePath);
    if (
      seen.has(entry.relativePath) ||
      ["manifest.json", "meta.json", ".partial"].includes(entry.relativePath)
    )
      throw new BundleIntegrityError("Duplicate or reserved manifest path");
    seen.add(entry.relativePath);
    if (entry.state !== "available") {
      if (!entry.omissionReason) throw new BundleIntegrityError("Missing artifact has no reason");
      continue;
    }
    total += entry.sizeBytes;
    if (entry.sizeBytes > maxObjectBytes || total > 256 * 1024 * 1024)
      throw new BundleIntegrityError("Bundle exceeds quota");
    if (expected.expiredArtifactIds?.includes(entry.artifactId)) continue;
    const actual = await hashObject(
      await openObject(store, `${bundleKey}/${entry.relativePath}`),
      entry.sizeBytes,
    );
    if (actual.size !== entry.sizeBytes || actual.hash !== entry.sha256)
      throw new BundleIntegrityError(`Artifact hash/size mismatch: ${entry.relativePath}`);
  }
  if (expected.expiredArtifactIds?.length)
    manifest = {
      ...manifest,
      entries: manifest.entries.map((entry) =>
        expected.expiredArtifactIds?.includes(entry.artifactId)
          ? { ...entry, state: "expired", omissionReason: "artifact_expired" }
          : entry,
      ),
    };
  return { store, bundleKey, manifest, meta };
}

/**
 * Verifies the object's bytes before yielding any, then streams them. A second read follows the
 * first (published objects are immutable, but the store is not trusted to keep them so): the
 * stream is hashed again and refused at its end if the bytes changed in between. A chunk may be
 * borrowed from a reused buffer: consume it before requesting the next.
 */
export async function* streamBundleArtifact(
  bundle: VerifiedBundle,
  relativePath: string,
  options: { allowRestrictedRaw?: boolean; maxBytes?: number } = {},
): AsyncGenerator<Uint8Array> {
  validateRelativePath(relativePath);
  const entry = bundle.manifest.entries.find((item) => item.relativePath === relativePath);
  if (entry?.state !== "available") throw new BundleIntegrityError("Artifact unavailable");
  if (entry.redactionStatus === "restrictedRaw" && !options.allowRestrictedRaw)
    throw new BundleIntegrityError("Restricted artifact requires raw authorization");
  if (entry.sizeBytes > (options.maxBytes ?? 64 * 1024 * 1024))
    throw new BundleIntegrityError("Artifact exceeds download limit");
  const key = `${bundle.bundleKey}/${relativePath}`;
  const actual = await hashObject(await openObject(bundle.store, key), entry.sizeBytes);
  if (actual.hash !== entry.sha256 || actual.size !== entry.sizeBytes)
    throw new BundleIntegrityError("Artifact changed after verification");
  const hash = createHash("sha256");
  let offset = 0;
  for await (const chunk of await openObject(bundle.store, key)) {
    offset += chunk.byteLength;
    if (offset > entry.sizeBytes)
      throw new BundleIntegrityError("Artifact changed after verification");
    hash.update(chunk);
    yield chunk;
  }
  if (offset !== entry.sizeBytes)
    throw new BundleIntegrityError("Artifact truncated while streaming");
  if (hash.digest("hex") !== entry.sha256)
    throw new BundleIntegrityError("Artifact changed after verification");
}

export function deriveFailedOnly(
  manifest: ArtifactManifest,
  failedArtifactPaths: readonly string[],
): ArtifactManifest {
  const paths = new Set(failedArtifactPaths);
  for (const path of paths)
    if (!manifest.entries.some((entry) => entry.relativePath === path))
      throw new BundleIntegrityError("Subset references unknown artifact");
  return {
    ...manifest,
    entries: manifest.entries.filter((entry) => paths.has(entry.relativePath)),
    parentSnapshot: manifest.snapshotId,
    subset: true,
  };
}
