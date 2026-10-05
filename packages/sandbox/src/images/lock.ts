import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PolicyDenied } from "../egress/policy.js";

export interface SeccompProvenance {
  engineVersion: string;
  engineDependencySource: string;
  profileModuleVersion: string;
  inputs: Record<string, { source: string; sha256: string }>;
  profileSha256: string;
}
export interface ImageLockEntry {
  imageId: string;
  baseDigest: string;
  buildInputsHash: string;
  seccomp: SeccompProvenance;
}
export type ImageLock = Record<"testmaster-runner" | "testmaster-runner-python", ImageLockEntry>;
export const baseImages = {
  "testmaster-runner":
    "mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27",
  "testmaster-runner-python":
    "mcr.microsoft.com/playwright/python:v1.63.0-noble@sha256:72bd171a9ffc2b4b59532aaa6210e21014d07093120dc25528870c0b840da1f0",
} as const;
export async function readImageLock(path: string): Promise<ImageLock> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new PolicyDenied("invalid_image_lock");
  const values = raw as Record<string, unknown>;
  if (Object.keys(values).length !== 2) throw new PolicyDenied("invalid_image_lock");
  for (const name of Object.keys(baseImages) as (keyof ImageLock)[]) {
    const value = values[name];
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new PolicyDenied("invalid_image_lock");
    const entry = value as Record<string, unknown>;
    if (
      Object.keys(entry).sort().join(",") !== "baseDigest,buildInputsHash,imageId,seccomp" ||
      typeof entry.imageId !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(entry.imageId) ||
      entry.baseDigest !== baseImages[name] ||
      typeof entry.buildInputsHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.buildInputsHash)
    )
      throw new PolicyDenied("invalid_image_lock");
    const seccomp = entry.seccomp as SeccompProvenance | undefined;
    if (
      !seccomp ||
      typeof seccomp.profileSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(seccomp.profileSha256) ||
      !seccomp.inputs ||
      Object.values(seccomp.inputs).some(
        (input) =>
          !input || typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(input.sha256),
      )
    )
      throw new PolicyDenied("invalid_seccomp_provenance");
  }
  return raw as ImageLock;
}
// The build script hashes its exact staged build context with this same framing.
export async function hashBuildInputs(root: string, paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    if (path.startsWith("/") || path.split("/").includes("..") || path.includes("\0"))
      throw new PolicyDenied("invalid_build_input");
    const data = await readFile(join(root, path));
    hash.update(path);
    hash.update("\0");
    hash.update(String(data.length));
    hash.update("\0");
    hash.update(data);
  }
  return hash.digest("hex");
}
export async function verifyImageLock(
  path: string,
  inspectImage: (imageId: string) => Promise<string>,
): Promise<ImageLock> {
  const lock = await readImageLock(path);
  const profileHash = createHash("sha256")
    .update(await readFile(join(path, "..", "seccomp_profile.json")))
    .digest("hex");
  for (const entry of Object.values(lock))
    if (entry.seccomp.profileSha256 !== profileHash)
      throw new PolicyDenied("seccomp_hash_mismatch");
  for (const entry of Object.values(lock))
    if ((await inspectImage(entry.imageId)) !== entry.imageId)
      throw new PolicyDenied("image_lock_mismatch");
  return lock;
}
