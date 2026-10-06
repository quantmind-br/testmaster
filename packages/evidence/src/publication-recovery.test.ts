import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { expect, it } from "vitest";
import { collectGarbage, FileEvidenceStore, findOrphanStaging, verifyBundle } from "./index.js";

it("OPS-020 interrupted multipart artifacts and mismatched hashes never become available", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "tm-partial-"));
  try {
    const ids = {
      workspaceId: uuidV7IdGenerator.next("ws"),
      runId: uuidV7IdGenerator.next("run"),
      attemptId: uuidV7IdGenerator.next("att"),
      revisionId: uuidV7IdGenerator.next("rev"),
      snapshotId: uuidV7IdGenerator.next("snp"),
    };
    const stage = await new FileEvidenceStore({ rootDir }).openAttempt(ids);
    const upload = await stage.beginArtifact({
      relativePath: "partial.bin",
      mimeType: "application/octet-stream",
      kind: "download",
      declaredSizeBytes: 1024,
    });
    await upload.write(Buffer.alloc(128));
    await expect(stage.commit({ redactionPolicyHash: "0".repeat(64) })).rejects.toThrow(
      "unfinished",
    );
    await upload.abort("upload_aborted");
    const corrupt = await stage.beginArtifact({
      relativePath: "corrupt.bin",
      mimeType: "application/octet-stream",
      kind: "download",
    });
    await corrupt.write(Buffer.from("real bytes"));
    await expect(corrupt.end("0".repeat(64))).rejects.toThrow("SHA-256 mismatch");
    const committed = await stage.commit({ redactionPolicyHash: "0".repeat(64) });
    const bundle = await verifyBundle(committed.bundleDir, ids);
    expect(bundle.manifest.entries.map((entry) => [entry.state, entry.omissionReason])).toEqual([
      ["missing", "upload_aborted"],
      ["missing", "hash_mismatch"],
    ]);
    await expect(stat(join(committed.bundleDir, "partial.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(committed.bundleDir, "corrupt.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

it("OPS-021 filesystem publication concurrent with orphan GC keeps objects protected by the live DB reference recheck", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "tm-gc-publish-"));
  try {
    const ids = {
      workspaceId: uuidV7IdGenerator.next("ws"),
      runId: uuidV7IdGenerator.next("run"),
      attemptId: uuidV7IdGenerator.next("att"),
      revisionId: uuidV7IdGenerator.next("rev"),
      snapshotId: uuidV7IdGenerator.next("snp"),
    };
    const stage = await new FileEvidenceStore({ rootDir }).openAttempt(ids);
    const upload = await stage.beginArtifact({
      relativePath: "result.txt",
      mimeType: "text/plain",
      kind: "log",
    });
    await upload.write(Buffer.from("immutable"));
    await upload.end();
    const committed = await stage.commit({ redactionPolicyHash: "0".repeat(64) });
    const candidates = await findOrphanStaging(rootDir, 0);
    expect(candidates).toHaveLength(1);
    let published = false;
    const removed = await collectGarbage(
      rootDir,
      candidates.map((candidate) => ({ relativePath: candidate.relativePath, version: 1 })),
      {
        inspect: async () => ({
          activeAttempt: false,
          validUploadLease: false,
          legalHold: false,
          liveReferences: 0,
        }),
        mark: async () => {
          published = true;
          return { version: 2 };
        },
        tombstone: async () => (published ? null : { version: 3 }),
        deleted: async () => {
          throw new Error("Live object deleted");
        },
      },
    );
    expect(removed).toEqual([]);
    expect((await verifyBundle(committed.bundleDir, ids)).manifest.entries[0]?.state).toBe(
      "available",
    );
    expect(await readFile(join(committed.bundleDir, "result.txt"), "utf8")).toBe("immutable");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
