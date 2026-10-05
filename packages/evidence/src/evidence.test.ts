import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfinedRoot,
  collectGarbage,
  deriveFailedOnly,
  EvidenceQuotaError,
  extractTar,
  extractZip,
  FileEvidenceStore,
  findOrphanStaging,
  streamBundleArtifact,
  validateRelativePath,
  verifyBundle,
} from "./index.js";

const roots: string[] = [];
async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "tm-evidence-"));
  roots.push(rootDir);
  const ids = {
    workspaceId: uuidV7IdGenerator.next("ws"),
    runId: uuidV7IdGenerator.next("run"),
    attemptId: uuidV7IdGenerator.next("att"),
    revisionId: uuidV7IdGenerator.next("rev"),
    snapshotId: uuidV7IdGenerator.next("snp"),
  };
  return { rootDir, ids };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe("evidence integrity boundaries", () => {
  it("commits manifest and streams validated bytes, rejects tamper/foreign IDs", async () => {
    const { rootDir, ids } = await fixture();
    const stage = await new FileEvidenceStore({ rootDir }).openAttempt(ids);
    const writer = await stage.beginArtifact({
      relativePath: "evidence/result.txt",
      kind: "dom",
      mimeType: "text/plain",
    });
    await writer.write(Buffer.from("hello"));
    await writer.end();
    const result = await stage.commit({ redactionPolicyHash: "0".repeat(64) });
    const bundle = await verifyBundle(result.bundleDir, {
      ...ids,
      manifestSha256: result.manifestSha256,
    });
    let text = "";
    for await (const chunk of streamBundleArtifact(bundle, "evidence/result.txt"))
      text += Buffer.from(chunk).toString();
    expect(text).toBe("hello");
    expect(deriveFailedOnly(bundle.manifest, ["evidence/result.txt"]).parentSnapshot).toBe(
      ids.snapshotId,
    );
    await expect(
      verifyBundle(result.bundleDir, { ...ids, workspaceId: uuidV7IdGenerator.next("ws") }),
    ).rejects.toThrow("Foreign");
    await expect(
      verifyBundle(result.bundleDir, { ...ids, snapshotId: uuidV7IdGenerator.next("snp") }),
    ).rejects.toThrow("Foreign");
    await writeFile(join(result.bundleDir, "evidence/result.txt"), "tampered");
    await expect(verifyBundle(result.bundleDir, ids)).rejects.toThrow();
    const manifest = JSON.parse(await readFile(join(result.bundleDir, "manifest.json"), "utf8"));
    manifest.entries[0].relativePath = "../outside";
    await writeFile(join(result.bundleDir, "manifest.json"), JSON.stringify(manifest));
    await expect(verifyBundle(result.bundleDir, ids)).rejects.toThrow();
  });
  it("withholds canary and typed quota failures, never raw fallback", async () => {
    const { rootDir, ids } = await fixture();
    const stage = await new FileEvidenceStore({
      rootDir,
      maxObjectBytes: 10,
      scanText: (text) => ({ hit: text.includes("CANARY") }),
    }).openAttempt(ids);
    const secret = await stage.beginArtifact({
      relativePath: "secret.txt",
      kind: "dom",
      mimeType: "text/plain",
    });
    await secret.write(Buffer.from("CANARY"));
    expect((await secret.end()).omissionReason).toBe("redaction_failed");
    const large = await stage.beginArtifact({
      relativePath: "large.bin",
      kind: "download",
      mimeType: "application/octet-stream",
    });
    await expect(large.write(Buffer.alloc(11))).rejects.toBeInstanceOf(EvidenceQuotaError);
    const result = await stage.commit({ redactionPolicyHash: "0".repeat(64) });
    const bundle = await verifyBundle(result.bundleDir, ids);
    expect(bundle.manifest.entries.every((entry) => entry.state === "missing")).toBe(true);
    await expect(readFile(join(result.bundleDir, "secret.txt"))).rejects.toThrow();
  });
  it("interrupted commit leaves orphan without meta marker", async () => {
    const { rootDir, ids } = await fixture();
    const stage = await new FileEvidenceStore({
      rootDir,
      beforeCommit: async () => {
        throw new Error("simulated kill");
      },
    }).openAttempt(ids);
    const artifact = await stage.beginArtifact({
      relativePath: "result.json",
      kind: "result",
      mimeType: "application/json",
    });
    await artifact.write(Buffer.from("{}"));
    await artifact.end();
    await expect(stage.commit({ redactionPolicyHash: "0".repeat(64) })).rejects.toThrow(
      "simulated kill",
    );
    const orphans = await findOrphanStaging(rootDir, 0);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.committed).toBe(false);
    await expect(
      readFile(join(rootDir, orphans[0]?.relativePath ?? "", "meta.json")),
    ).rejects.toThrow();
    await stage.abandon("test");
  });
  it("refuses path, hardlink, symlink and swapped ancestor escapes", async () => {
    const { rootDir } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "tm-outside-"));
    roots.push(outside);
    for (const path of [
      "../escape",
      "/absolute",
      "C:foo",
      "\\\\server\\share",
      "a\\b",
      "a\0b",
      "a/../b",
    ])
      expect(() => validateRelativePath(path)).toThrow();
    const root = new ConfinedRoot(rootDir);
    await writeFile(join(outside, "value"), "secret");
    await symlink(outside, join(rootDir, "link"));
    await expect(root.openFile("link/value")).rejects.toThrow();
    await link(join(outside, "value"), join(rootDir, "hard"));
    await expect(root.openFile("hard")).rejects.toThrow();
    await mkdir(join(rootDir, "swap"));
    await rm(join(rootDir, "swap"), { recursive: true });
    await symlink(outside, join(rootDir, "swap"));
    await expect(root.openFile("swap/write", true)).rejects.toThrow();
    expect(await readdir(outside)).toEqual(["value"]);
    root.close();
  });
  it("refuses adversarial archives and leaves no destination", async () => {
    const { rootDir } = await fixture();
    for (const file of [
      "zip-slip.zip",
      "duplicate-member.zip",
      "symlink.zip",
      "zip-bomb.zip",
      "absolute-path.tar",
      "symlink.tar",
    ]) {
      const target = join(rootDir, file);
      const input = new URL(`../../../fixtures/adversarial/archives/${file}`, import.meta.url);
      await expect(
        file.endsWith(".zip")
          ? extractZip(input.pathname, target)
          : extractTar(input.pathname, target),
      ).rejects.toThrow();
      await expect(readdir(target)).rejects.toThrow();
    }
    expect(await readdir(rootDir)).toEqual([]);
  });
  it("GC rechecks CAS safety before deletion", async () => {
    const { rootDir } = await fixture();
    await mkdir(join(rootDir, "old"));
    await writeFile(join(rootDir, "old", "data"), "data");
    let tombstone = false;
    const port = {
      inspect: async () => ({
        activeAttempt: false,
        validUploadLease: false,
        legalHold: false,
        liveReferences: 0,
      }),
      mark: async () => ({ version: 2 }),
      tombstone: async () => (tombstone ? { version: 3 } : null),
      deleted: async () => {},
    };
    expect(await collectGarbage(rootDir, [{ relativePath: "old", version: 1 }], port)).toEqual([]);
    expect(await readdir(rootDir)).toContain("old");
    tombstone = true;
    expect(await collectGarbage(rootDir, [{ relativePath: "old", version: 2 }], port)).toEqual([
      "old",
    ]);
    expect(await readdir(rootDir)).not.toContain("old");
  });
});
