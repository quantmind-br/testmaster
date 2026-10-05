import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { baseImages, hashBuildInputs, verifyImageLock } from "./lock.js";

it("refuses image substitution and seccomp tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-lock-"));
  try {
    const profile = "reviewed-profile";
    await writeFile(join(root, "seccomp_profile.json"), profile);
    const seccomp = {
      engineVersion: "29.8.1",
      engineDependencySource: "https://example.test/go.mod",
      profileModuleVersion: "v0.2.3",
      inputs: { baseline: { source: "https://example.test/profile", sha256: "b".repeat(64) } },
      profileSha256: createHash("sha256").update(profile).digest("hex"),
    };
    const lock = Object.fromEntries(
      Object.entries(baseImages).map(([name, baseDigest]) => [
        name,
        {
          imageId: `sha256:${"a".repeat(64)}`,
          baseDigest,
          buildInputsHash: "c".repeat(64),
          seccomp,
        },
      ]),
    );
    const path = join(root, "images.lock.json");
    await writeFile(path, JSON.stringify(lock));
    expect(await verifyImageLock(path, async (id) => id)).toEqual(lock);
    await expect(verifyImageLock(path, async () => `sha256:${"d".repeat(64)}`)).rejects.toThrow(
      "image_lock_mismatch",
    );
    await writeFile(join(root, "seccomp_profile.json"), "modified");
    await expect(verifyImageLock(path, async (id) => id)).rejects.toThrow("seccomp_hash_mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("hashes build contents independent of input ordering, sensitive to path and bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-build-hash-"));
  try {
    await writeFile(join(root, "a"), "first");
    await writeFile(join(root, "b"), "second");
    const initial = await hashBuildInputs(root, ["a", "b"]);
    expect(await hashBuildInputs(root, ["b", "a"])).toBe(initial);
    await writeFile(join(root, "a"), "changed");
    expect(await hashBuildInputs(root, ["a", "b"])).not.toBe(initial);
    await expect(hashBuildInputs(root, ["../escape"])).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
