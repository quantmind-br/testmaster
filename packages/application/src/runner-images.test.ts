import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError } from "@testmaster/contracts";
import { baseImages, verifyImageLock } from "@testmaster/sandbox";
import { afterEach, expect, it } from "vitest";
import { runnerImageProblem } from "./application.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const pinned = `sha256:${"a".repeat(64)}`;
async function lockDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tm-image-problem-"));
  roots.push(root);
  const profile = "reviewed-profile";
  await writeFile(join(root, "seccomp_profile.json"), profile);
  const seccomp = {
    inputs: { baseline: { source: "https://example.test/profile", sha256: "b".repeat(64) } },
    profileSha256: createHash("sha256").update(profile).digest("hex"),
  };
  const lock = Object.fromEntries(
    Object.entries(baseImages).map(([name, baseDigest]) => [
      name,
      {
        imageId: pinned,
        baseDigest,
        buildInputsHash: "c".repeat(64),
        seccomp,
      },
    ]),
  );
  await writeFile(join(root, "images.lock.json"), JSON.stringify(lock));
  return root;
}
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );

it("names why the pinned runner images are unusable and how to recover", async () => {
  const root = await lockDir();
  const path = join(root, "images.lock.json");
  // An image the local store does not hold (as after rebuilding over an installed lock).
  const absent = runnerImageProblem(
    await failure(
      verifyImageLock(path, async (imageId) => {
        throw new ContractError("POLICY_DENIED", "Pinned runner image is unavailable", {
          diagnostic: "image_unavailable",
          imageId,
        });
      }),
    ),
  );
  expect(absent).toMatchObject({ diagnostic: "image_unavailable", imageId: pinned });
  expect(absent.message).toContain(pinned);
  expect(absent.message).toContain("make install");
  // The store holds a different image under the pinned name.
  const substituted = runnerImageProblem(
    await failure(verifyImageLock(path, async () => `sha256:${"d".repeat(64)}`)),
  );
  expect(substituted.diagnostic).toBe("image_lock_mismatch");
  // A tampered seccomp profile is its own diagnostic, checked before any image.
  await writeFile(join(root, "seccomp_profile.json"), "modified");
  expect(
    runnerImageProblem(await failure(verifyImageLock(path, async (id) => id))).diagnostic,
  ).toBe("seccomp_hash_mismatch");
  // A missing lock file names the file; positive control: the intact lock verifies.
  const missing = runnerImageProblem(
    await failure(verifyImageLock(join(root, "nested", "images.lock.json"), async (id) => id)),
  );
  expect(missing).toMatchObject({ diagnostic: "image_lock_missing" });
  expect(missing.message).toContain("images.lock.json");
  await writeFile(join(root, "seccomp_profile.json"), "reviewed-profile");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(
    await verifyImageLock(path, async (id) => id),
  );
});

it("does not call a missing docker binary a missing image lock", () => {
  const spawnError = Object.assign(new Error("spawn docker ENOENT"), {
    code: "ENOENT",
    path: "docker",
  });
  expect(runnerImageProblem(spawnError).diagnostic).toBe("image_verification_failed");
});
