import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { type ArtifactManifest, type BundleMeta, validate } from "@testmaster/contracts";
import { assertEntityId, canonicalJson, sha256, uuidV7IdGenerator } from "@testmaster/domain";
import { ConfinedRoot, validateRelativePath } from "./path.js";

export type ManifestEntry = ArtifactManifest["entries"][number];
export interface AttemptIds {
  workspaceId: string;
  runId: string;
  attemptId: string;
  revisionId: string;
  snapshotId: string;
}
export interface ArtifactInput {
  relativePath: string;
  kind: string;
  mimeType: string;
  declaredSizeBytes?: number;
  sensitivity?: "public" | "internal" | "restricted";
}
export interface ArtifactWriter {
  write(chunk: Uint8Array): Promise<void>;
  end(expectedSha256?: string): Promise<ManifestEntry>;
  abort(reason: string): Promise<void>;
}
export interface AttemptStaging {
  beginArtifact(a: ArtifactInput): Promise<ArtifactWriter>;
  withhold(relativePath: string, reasonCode: string): Promise<void>;
  usage(): { bytes: number; objects: number };
  commit(meta: Record<string, unknown>): Promise<{ bundleDir: string; manifestSha256: string }>;
  abandon(reason: string): Promise<void>;
}
export interface EvidenceStore {
  openAttempt(ids: AttemptIds, options?: { scanText?: TextScanner }): Promise<AttemptStaging>;
}
export type TextScanner = (text: string) => { hit: boolean };
export interface EvidenceStoreOptions {
  rootDir: string;
  maxObjectBytes?: number;
  maxAttemptBytes?: number;
  scanText?: TextScanner;
  beforeCommit?: () => Promise<void>;
}
export class EvidenceQuotaError extends Error {
  readonly reasonCode = "quota_exceeded";
  constructor(readonly limit: "object" | "attempt") {
    super(`Evidence ${limit} quota exceeded`);
    this.name = "EvidenceQuotaError";
  }
}
const reserved: Record<string, true> = {
  "meta.json": true,
  "manifest.json": true,
  ".partial": true,
};
function artifactPath(path: string): string {
  validateRelativePath(path);
  if (path.split("/").some((part) => reserved[part] || part.startsWith(".tm-")))
    throw new Error("Reserved artifact path");
  return path;
}
export class FileEvidenceStore implements EvidenceStore {
  constructor(private readonly options: EvidenceStoreOptions) {}
  async openAttempt(
    ids: AttemptIds,
    options?: { scanText?: TextScanner },
  ): Promise<AttemptStaging> {
    for (const [key, prefix] of [
      ["workspaceId", "ws"],
      ["runId", "run"],
      ["attemptId", "att"],
      ["revisionId", "rev"],
      ["snapshotId", "snp"],
    ] as const)
      assertEntityId(ids[key], prefix);
    const root = new ConfinedRoot(this.options.rootDir, true);
    const stagingPath = `staging/${ids.workspaceId}/${ids.runId}/${ids.attemptId}-${randomUUID()}`;
    // Exclusive marker creation creates descriptor-checked ancestors as well.
    const marker = await root.openFile(`${stagingPath}/.partial`, true);
    await marker.writeFile(canonicalJson(ids));
    await marker.sync();
    await marker.close();
    const staging = new Staging(
      root,
      root.openDirectory(stagingPath),
      stagingPath,
      { ...ids },
      { ...this.options, ...(options?.scanText ? { scanText: options.scanText } : {}) },
    );
    return staging;
  }
}
class Staging implements AttemptStaging {
  private state: "open" | "committing" | "committed" | "abandoned" = "open";
  private bytes = 0;
  private readonly entries = new Map<string, ManifestEntry>();
  private readonly writers = new Map<string, { abort(reason: string): Promise<void> }>();
  private currentPath: string | undefined;
  constructor(
    private readonly base: ConfinedRoot,
    private readonly root: ConfinedRoot,
    private readonly stagingPath: string,
    private readonly ids: AttemptIds,
    private readonly options: EvidenceStoreOptions,
  ) {}
  usage(): { bytes: number; objects: number } {
    return { bytes: this.bytes, objects: this.entries.size };
  }
  async beginArtifact(input: ArtifactInput): Promise<ArtifactWriter> {
    if (this.state !== "open") throw new Error("Attempt is closed");
    const path = artifactPath(input.relativePath);
    if (this.entries.has(path)) throw new Error("Duplicate artifact path");
    const entry: ManifestEntry = {
      relativePath: path,
      artifactId: uuidV7IdGenerator.next("art"),
      kind: input.kind,
      mimeType: input.mimeType,
      sizeBytes: 0,
      sha256: null,
      state: "partial",
      redactionStatus: input.sensitivity === "restricted" ? "restrictedRaw" : "not_applicable",
      omissionReason: "incomplete",
    };
    this.entries.set(path, entry);
    if (
      input.declaredSizeBytes !== undefined &&
      (!Number.isSafeInteger(input.declaredSizeBytes) || input.declaredSizeBytes < 0)
    ) {
      await this.withhold(path, "invalid_size");
      throw new Error("Invalid declared size");
    }
    const objectLimit = this.options.maxObjectBytes ?? 64 * 1024 * 1024;
    const attemptLimit = this.options.maxAttemptBytes ?? 256 * 1024 * 1024;
    if ((input.declaredSizeBytes ?? 0) > objectLimit) {
      await this.withhold(path, "quota_exceeded");
      throw new EvidenceQuotaError("object");
    }
    const temp = `.tm-${randomUUID()}`;
    let file: FileHandle;
    try {
      file = await this.root.openFile(temp, true);
    } catch (error) {
      entry.state = "missing";
      entry.omissionReason = "storage_unavailable";
      throw error;
    }
    const hash = createHash("sha256");
    let size = 0;
    let ended = false;
    let queue: Promise<unknown> = Promise.resolve();
    const abort = async (reason: string): Promise<void> => {
      if (ended) return;
      ended = true;
      await file.close();
      await this.root.unlink(temp);
      entry.state = "missing";
      entry.omissionReason = reason;
      entry.sha256 = null;
      entry.sizeBytes = 0;
      this.writers.delete(path);
    };
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = queue.then(operation);
      queue = result.catch(() => {});
      return result;
    };
    const writer: ArtifactWriter = {
      write: (chunk) =>
        enqueue(async () => {
          if (ended || this.state !== "open") throw new Error("Artifact is closed");
          if (
            size + chunk.byteLength > objectLimit ||
            this.bytes + chunk.byteLength > attemptLimit
          ) {
            const limit = size + chunk.byteLength > objectLimit ? "object" : "attempt";
            await abort("quota_exceeded");
            throw new EvidenceQuotaError(limit);
          }
          this.bytes += chunk.byteLength;
          size += chunk.byteLength;
          try {
            await file.writeFile(chunk);
            hash.update(chunk);
          } catch (error) {
            await abort("storage_unavailable");
            throw error;
          }
        }),
      end: (expected) =>
        enqueue(async () => {
          if (ended || this.state !== "open") throw new Error("Artifact is closed");
          const digest = hash.digest("hex");
          if (expected !== undefined && expected !== digest) {
            await abort("hash_mismatch");
            throw new Error("Artifact SHA-256 mismatch");
          }
          if (input.declaredSizeBytes !== undefined && size !== input.declaredSizeBytes) {
            await abort("size_mismatch");
            throw new Error("Artifact size mismatch");
          }
          await file.sync();
          await file.close();
          // Reopen through confinement, never trusting a pathname after validation.
          if (
            this.options.scanText &&
            /^(text\/|application\/(json|.*\+json|xml|.*\+xml|javascript|x-ndjson))/.test(
              input.mimeType,
            )
          ) {
            const scanFile = await this.root.openFile(temp);
            let hit: boolean;
            try {
              const bytes = await scanFile.readFile();
              hit = this.options.scanText(
                new TextDecoder("utf-8", { fatal: true }).decode(bytes),
              ).hit;
            } catch {
              hit = true;
            } finally {
              await scanFile.close();
            }
            if (hit) {
              ended = true;
              await this.root.unlink(temp);
              entry.state = "missing";
              entry.omissionReason = "redaction_failed";
              this.writers.delete(path);
              return entry;
            }
            entry.redactionStatus = "redacted";
          }
          await this.root.rename(temp, path);
          await this.root.sync();
          ended = true;
          this.writers.delete(path);
          entry.sizeBytes = size;
          entry.sha256 = digest;
          entry.state = "available";
          delete entry.omissionReason;
          return { ...entry };
        }),
      abort: (reason) => enqueue(() => abort(reason)),
    };
    this.writers.set(path, writer);
    return writer;
  }
  async withhold(path: string, reasonCode: string): Promise<void> {
    if (this.state !== "open") throw new Error("Attempt is closed");
    artifactPath(path);
    const active = this.writers.get(path);
    if (active) {
      await active.abort(reasonCode);
      return;
    }
    const entry = this.entries.get(path);
    if (entry?.state === "available") await this.root.unlink(path);
    this.entries.set(path, {
      ...(entry ?? {
        relativePath: path,
        artifactId: uuidV7IdGenerator.next("art"),
        kind: "withheld",
        mimeType: "application/octet-stream",
        redactionStatus: "not_applicable" as const,
      }),
      state: "missing",
      sizeBytes: 0,
      sha256: null,
      omissionReason: reasonCode,
    });
  }
  async commit(
    meta: Record<string, unknown>,
  ): Promise<{ bundleDir: string; manifestSha256: string }> {
    if (this.state !== "open" || this.writers.size)
      throw new Error("Attempt is closed or has unfinished artifacts");
    this.state = "committing";
    const manifest = validate<ArtifactManifest>("ArtifactManifest", {
      schemaVersion: "1.0.0",
      ...this.ids,
      entries: [...this.entries.values()],
    });
    const manifestText = canonicalJson(manifest);
    const manifestSha256 = sha256(manifestText);
    const bundleMeta = validate<BundleMeta>("BundleMeta", {
      ...meta,
      schemaVersion: "1.0.0",
      ...this.ids,
      manifestHash: manifestSha256,
      committedAt: new Date().toISOString(),
    });
    const manifestFile = await this.root.openFile(".tm-manifest", true);
    await manifestFile.writeFile(manifestText);
    await manifestFile.sync();
    await manifestFile.close();
    await this.root.rename(".tm-manifest", "manifest.json");
    await this.root.sync();
    await this.options.beforeCommit?.();
    const target = `runs/${this.ids.workspaceId}/${this.ids.runId}/${this.ids.attemptId}`;
    // No overwrite: final Attempt directories are immutable and unique.
    const publicationLock = await this.base.openFile(
      `runs/${this.ids.workspaceId}/${this.ids.runId}/.tm-publish-${this.ids.attemptId}`,
      true,
    );
    await publicationLock.close();
    await this.base.rename(this.stagingPath, target);
    this.currentPath = target;
    await this.base.sync();
    const finalRoot = this.root;
    const file = await finalRoot.openFile(".tm-meta", true);
    await file.writeFile(canonicalJson(bundleMeta));
    await file.sync();
    await file.close();
    await finalRoot.rename(".tm-meta", "meta.json");
    await finalRoot.sync();
    await finalRoot.unlink(".partial");
    await finalRoot.sync();
    finalRoot.close();
    this.base.close();
    this.state = "committed";
    return { bundleDir: `${this.options.rootDir}/${target}`, manifestSha256 };
  }
  async abandon(_reason: string): Promise<void> {
    if (this.state === "committed" || this.state === "abandoned") return;
    for (const writer of this.writers.values()) await writer.abort("abandoned");
    this.state = "abandoned";
    this.root.close();
    await this.base.remove(this.currentPath ?? this.stagingPath);
    this.base.close();
  }
}
