import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { type ArtifactManifest, type BundleMeta, parseAndValidate } from "@testmaster/contracts";
import { canonicalJson, sha256 } from "@testmaster/domain";
import { ConfinedRoot, validateRelativePath } from "./path.js";
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
  rootDir: string;
  manifest: ArtifactManifest;
  meta: BundleMeta;
}
async function hashHandle(
  file: FileHandle,
  maxBytes: number,
): Promise<{ hash: string; size: number }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(128 * 1024);
  let size = 0;
  while (true) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, size);
    if (!bytesRead) break;
    size += bytesRead;
    if (size > maxBytes) throw new BundleIntegrityError("Artifact exceeds declared size/limit");
    hash.update(buffer.subarray(0, bytesRead));
  }
  return { hash: hash.digest("hex"), size };
}
export async function verifyBundle(
  rootDir: string,
  expected: BundleExpectations,
  maxObjectBytes = 64 * 1024 * 1024,
): Promise<VerifiedBundle> {
  const root = new ConfinedRoot(rootDir);
  try {
    const metaFile = await root.openFile("meta.json");
    const manifestFile = await root.openFile("manifest.json");
    let meta: BundleMeta;
    let manifest: ArtifactManifest;
    try {
      if (
        (await metaFile.stat()).size > 1024 * 1024 ||
        (await manifestFile.stat()).size > 16 * 1024 * 1024
      )
        throw new BundleIntegrityError("Bundle metadata too large");
      meta = parseAndValidate<BundleMeta>("BundleMeta", await metaFile.readFile());
      manifest = parseAndValidate<ArtifactManifest>(
        "ArtifactManifest",
        await manifestFile.readFile(),
        16 * 1024 * 1024,
      );
    } finally {
      await metaFile.close();
      await manifestFile.close();
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
      const file = await root.openFile(entry.relativePath);
      try {
        const actual = await hashHandle(file, entry.sizeBytes);
        if (actual.size !== entry.sizeBytes || actual.hash !== entry.sha256)
          throw new BundleIntegrityError(`Artifact hash/size mismatch: ${entry.relativePath}`);
      } finally {
        await file.close();
      }
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
    return { rootDir, manifest, meta };
  } finally {
    root.close();
  }
}

/** Verify on the same pinned descriptor before yielding any bytes, then stream bounded chunks. */
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
  const root = new ConfinedRoot(bundle.rootDir);
  try {
    const file = await root.openFile(relativePath);
    try {
      const actual = await hashHandle(file, entry.sizeBytes);
      if (actual.hash !== entry.sha256 || actual.size !== entry.sizeBytes)
        throw new BundleIntegrityError("Artifact changed after verification");
      const buffer = Buffer.allocUnsafe(128 * 1024);
      let offset = 0;
      while (offset < entry.sizeBytes) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, entry.sizeBytes - offset),
          offset,
        );
        if (!bytesRead) throw new BundleIntegrityError("Artifact truncated while streaming");
        offset += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    } finally {
      await file.close();
    }
  } finally {
    root.close();
  }
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
