import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const inputs = {
  engineDefault: {
    path: "seccomp/upstream-moby-seccomp-v0.2.3.json",
    source: "https://raw.githubusercontent.com/moby/profiles/seccomp/v0.2.3/seccomp/default.json",
  },
  originalDefault: {
    path: "seccomp/upstream-moby-d0d99b04.json",
    source:
      "https://raw.githubusercontent.com/moby/moby/d0d99b04cf6e00ed3fc27e81fc3d94e7eda70af3/profiles/seccomp/default.json",
  },
  playwright: {
    path: "seccomp/upstream-playwright-v1.63.0.json",
    source:
      "https://raw.githubusercontent.com/microsoft/playwright/v1.63.0/utils/docker/seccomp_profile.json",
  },
};
export async function generateSeccomp() {
  const profiles = {};
  const provenance = {
    engineVersion: "29.8.1",
    engineDependencySource: "https://raw.githubusercontent.com/moby/moby/docker-v29.8.1/go.mod",
    profileModuleVersion: "v0.2.3",
    inputs: {},
  };
  for (const [name, input] of Object.entries(inputs)) {
    const data = await readFile(new URL(input.path, import.meta.url));
    profiles[name] = JSON.parse(data);
    provenance.inputs[name] = {
      source: input.source,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  }
  const [delta, ...remainder] = profiles.playwright.syscalls;
  assert.deepEqual(
    { ...profiles.playwright, syscalls: remainder },
    profiles.originalDefault,
    "Playwright differs from original Docker baseline beyond its namespace delta",
  );
  assert.deepEqual(delta.names, ["clone", "setns", "unshare"]);
  assert.equal(delta.action, "SCMP_ACT_ALLOW");
  assert.deepEqual(delta.args, []);
  assert.deepEqual(delta.includes, {});
  assert.deepEqual(delta.excludes, {});
  // SEC-014: chroot does not grant capabilities. The kernel permits it only in
  // Chromium's new user namespace; the cap-dropped container process gets EPERM.
  const chromiumConfinement = {
    names: ["chroot"],
    action: "SCMP_ACT_ALLOW",
    args: [],
    includes: {},
    excludes: {},
  };
  const profile = {
    ...profiles.engineDefault,
    syscalls: [delta, chromiumConfinement, ...profiles.engineDefault.syscalls],
  };
  const data = `${JSON.stringify(profile, null, 2)}\n`;
  await writeFile(new URL("seccomp_profile.json", import.meta.url), data);
  provenance.profileSha256 = createHash("sha256").update(data).digest("hex");
  await writeFile(
    new URL("seccomp/provenance.json", import.meta.url),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  return provenance;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await generateSeccomp();
