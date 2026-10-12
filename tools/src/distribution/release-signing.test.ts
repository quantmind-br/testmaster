import { execFile } from "node:child_process";
import { createPrivateKey, type KeyObject } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestFile, sha256, writeDeterministicArchive } from "./archive.js";
import { installRuntime } from "./install.js";
import { renderInstallerScript } from "./installer-script.js";
import { assembleInstaller, createSigningKey, signRelease, verifyRelease } from "./release-sign.js";
import {
  type Advisories,
  generateReleaseKey,
  type Keyring,
  parseAdvisories,
  parseKeyring,
  type ReleaseKey,
  ReleaseTrustError,
  signManifestBytes,
} from "./signing.js";

const exec = promisify(execFile);
const roots: string[] = [];
const originalPath = process.env.PATH;
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tm-sign-"));
  roots.push(root);
  return root;
}
async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
/** Number of `docker load` invocations recorded by the shim (the script's own `docker info` is not one). */
async function dockerLoads(log: string): Promise<number> {
  const text = await readFile(log, "utf8").catch(() => "");
  return (text.match(/^load /gmu) ?? []).length;
}
afterEach(async () => {
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const emptyAdvisories: Advisories = {
  schemaVersion: "1.0.0",
  updatedAt: "2026-10-11T00:00:00Z",
  advisories: [],
  revokedKeys: [],
  revokedReleases: [],
};
interface TestKey {
  key: ReleaseKey;
  privateKey: KeyObject;
  privateKeyPem: string;
}
function testKey(description = "throwaway test key"): TestKey {
  const { privateKeyPem, key } = generateReleaseKey(description);
  return { key, privateKey: createPrivateKey(privateKeyPem), privateKeyPem };
}
const IMAGE_NAMES = ["testmaster-runner", "testmaster-runner-python"];
interface Release {
  dir: string;
  manifestPath: string;
  manifestBytes: Buffer;
  sourceCommit: string;
}
/** A complete, internally consistent release directory (manifest, runtime, image parts). */
async function buildRelease(root: string, sourceCommit = "a".repeat(40)): Promise<Release> {
  const dir = join(root, "release");
  const stage = join(root, "stage");
  await mkdir(join(dir, "images"), { recursive: true });
  const lock: Record<string, { imageId: string }> = {};
  for (const name of IMAGE_NAMES) lock[name] = { imageId: `sha256:${sha256(name)}` };
  const contents: Record<string, string> = {
    LICENSE: "license",
    NOTICE: "notice",
    "containers/NOTICE": "container notice",
    "containers/images.lock.json": JSON.stringify(lock),
    "apps/cli/dist/main.js": "console.log('runtime');",
  };
  for (const [path, content] of Object.entries(contents)) {
    await mkdir(join(stage, path, ".."), { recursive: true });
    await writeFile(join(stage, path), content);
  }
  const paths = Object.keys(contents).sort();
  const runtimeArchive = await writeDeterministicArchive(stage, paths, join(dir, "runtime.tar.gz"));
  const files = await Promise.all(
    paths.map(async (path) => ({ path, ...(await digestFile(join(stage, path))) })),
  );
  const images = [];
  for (const name of IMAGE_NAMES) {
    const part = join(dir, "images", `${name}.tar.gz.part-0000`);
    await writeFile(part, `image archive ${name}`);
    const digest = await digestFile(part);
    images.push({
      name,
      imageId: lock[name]!.imageId,
      archive: { ...digest, parts: [digest] },
    });
  }
  const manifest = {
    schemaVersion: "1.0.0",
    sourceCommit,
    runtimeArchive,
    files,
    dependencies: [],
    imageLockHash: sha256(contents["containers/images.lock.json"]!),
    images,
  };
  const manifestPath = join(dir, "manifest.json");
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, manifestBytes);
  return { dir, manifestPath, manifestBytes, sourceCommit };
}
async function writeSignature(release: Release, privateKey: KeyObject): Promise<string> {
  const path = `${release.manifestPath}.sig`;
  await writeFile(path, JSON.stringify(signManifestBytes(release.manifestBytes, privateKey)));
  return path;
}
async function writeTrust(
  root: string,
  keys: ReleaseKey[],
  advisories: Advisories = emptyAdvisories,
): Promise<{ keyringPath: string; advisoryPaths: string[] }> {
  const keyring: Keyring = { schemaVersion: "1.0.0", keys };
  await mkdir(join(root, "trust"), { recursive: true });
  const keyringPath = join(root, "trust/keyring.json");
  const advisoriesPath = join(root, "trust/advisories.json");
  await writeFile(keyringPath, JSON.stringify(keyring));
  await writeFile(advisoriesPath, JSON.stringify(advisories));
  return { keyringPath, advisoryPaths: [advisoriesPath] };
}
/** A docker stand-in that records every invocation and reports the requested image ID. */
async function dockerShim(root: string): Promise<string> {
  const bin = join(root, "bin");
  const log = join(root, "docker.log");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "docker"),
    `#!/usr/bin/env bash\necho "$*" >> '${log}'\nif [[ "$1" == image && "$2" == inspect ]]; then echo "$3"; fi\nexit 0\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${originalPath}`;
  return log;
}

describe("signed release installation", () => {
  let root: string;
  let dockerLog: string;
  beforeEach(async () => {
    root = await temporary();
    dockerLog = await dockerShim(root);
  });
  async function install(
    release: Release,
    trust: { keyringPath: string; advisoryPaths: string[] },
    extra: { manifestSha256?: string } = {},
  ) {
    return installRuntime({
      manifestPath: release.manifestPath,
      signaturePath: `${release.manifestPath}.sig`,
      destination: join(root, "runtime"),
      ...trust,
      ...extra,
    });
  }
  async function assertNothingHappened(): Promise<void> {
    expect(await exists(join(root, "runtime"))).toBe(false);
    expect(await exists(dockerLog)).toBe(false);
  }

  it("installs a runtime whose manifest carries a valid signature from a trusted key", async () => {
    const release = await buildRelease(root);
    const signer = testKey();
    await writeSignature(release, signer.privateKey);
    const trust = await writeTrust(root, [signer.key]);
    const result = await install(release, trust, { manifestSha256: sha256(release.manifestBytes) });
    expect(result.signingKeyId).toBe(signer.key.keyId);
    expect(result.manifestSha256).toBe(sha256(release.manifestBytes));
    expect(await readFile(join(root, "runtime/apps/cli/dist/main.js"), "utf8")).toBe(
      "console.log('runtime');",
    );
    expect((await readFile(dockerLog, "utf8")).match(/^load /gmu)).toHaveLength(2);
  });

  it("refuses an unsigned manifest before reading any archive or touching Docker", async () => {
    const release = await buildRelease(root);
    const trust = await writeTrust(root, [testKey().key]);
    await expect(install(release, trust)).rejects.toThrow("Release manifest is unsigned");
    await assertNothingHappened();
  });

  it("refuses a manifest with one tampered byte, including a rewritten manifest hash in the signature", async () => {
    const release = await buildRelease(root);
    const signer = testKey();
    await writeSignature(release, signer.privateKey);
    const trust = await writeTrust(root, [signer.key]);
    const tampered = Buffer.from(release.manifestBytes);
    const position = tampered.indexOf("a".repeat(40));
    tampered[position] = "b".charCodeAt(0);
    await writeFile(release.manifestPath, tampered);
    await expect(install(release, trust)).rejects.toThrow(
      "Signature does not belong to this manifest",
    );
    // An attacker who also rewrites the manifest hash inside the envelope still lacks the key.
    const envelope = JSON.parse(await readFile(`${release.manifestPath}.sig`, "utf8"));
    envelope.manifestSha256 = sha256(tampered);
    await writeFile(`${release.manifestPath}.sig`, JSON.stringify(envelope));
    await expect(install(release, trust)).rejects.toThrow("Release signature is invalid");
    await assertNothingHappened();
  });

  it("refuses tampered asset bytes under a valid signature before any Docker load", async () => {
    const release = await buildRelease(root);
    const signer = testKey();
    await writeSignature(release, signer.privateKey);
    const trust = await writeTrust(root, [signer.key]);
    await writeFile(join(release.dir, "images/testmaster-runner.tar.gz.part-0000"), "tampered");
    await expect(install(release, trust)).rejects.toThrow("Image part hash mismatch");
    expect(await exists(dockerLog)).toBe(false);
    await writeFile(join(release.dir, "runtime.tar.gz"), "tampered runtime");
    await expect(install(release, trust)).rejects.toThrow(
      /Runtime archive (?:size|hash) mismatch/u,
    );
    expect(await exists(join(root, "runtime"))).toBe(false);
  });

  it("refuses a signature by an unknown key", async () => {
    const release = await buildRelease(root);
    const attacker = testKey("attacker");
    await writeSignature(release, attacker.privateKey);
    const trust = await writeTrust(root, [testKey("maintainer").key]);
    await expect(install(release, trust)).rejects.toThrow(
      `Release signed by unknown key ${attacker.key.keyId}`,
    );
    await assertNothingHappened();
  });

  it("refuses a signature by a revoked key even though the key is still in the keyring", async () => {
    const release = await buildRelease(root);
    const signer = testKey();
    await writeSignature(release, signer.privateKey);
    const trust = await writeTrust(root, [signer.key], {
      ...emptyAdvisories,
      revokedKeys: [
        { keyId: signer.key.keyId, revokedAt: "2026-10-11T12:00:00Z", reason: "key compromise" },
      ],
    });
    await expect(install(release, trust)).rejects.toThrow(
      `Signing key ${signer.key.keyId} is revoked: key compromise`,
    );
    await assertNothingHappened();
  });

  it("refuses a revoked release by manifest digest and by source commit", async () => {
    const release = await buildRelease(root);
    const signer = testKey();
    await writeSignature(release, signer.privateKey);
    const byDigest = await writeTrust(root, [signer.key], {
      ...emptyAdvisories,
      revokedReleases: [
        {
          manifestSha256: sha256(release.manifestBytes),
          revokedAt: "2026-10-11T12:00:00Z",
          reason: "backdoored image",
        },
      ],
    });
    await expect(install(release, byDigest)).rejects.toThrow(
      "Release is revoked: backdoored image",
    );
    const byCommit = await writeTrust(root, [signer.key], {
      ...emptyAdvisories,
      revokedReleases: [
        {
          sourceCommit: release.sourceCommit,
          revokedAt: "2026-10-11T12:00:00Z",
          reason: "vulnerable source commit",
        },
      ],
    });
    await expect(install(release, byCommit)).rejects.toThrow(
      "Release is revoked: vulnerable source commit",
    );
    await assertNothingHappened();
  });

  it("refuses a signature made over a different manifest", async () => {
    const release = await buildRelease(root);
    const other = await buildRelease(await temporary(), "c".repeat(40));
    const signer = testKey();
    await writeFile(
      `${release.manifestPath}.sig`,
      JSON.stringify(signManifestBytes(other.manifestBytes, signer.privateKey)),
    );
    const trust = await writeTrust(root, [signer.key]);
    await expect(install(release, trust)).rejects.toThrow(
      "Signature does not belong to this manifest",
    );
    // Relabelling the foreign signature with this manifest's digest does not make it verify.
    const envelope = JSON.parse(await readFile(`${release.manifestPath}.sig`, "utf8"));
    envelope.manifestSha256 = sha256(release.manifestBytes);
    await writeFile(`${release.manifestPath}.sig`, JSON.stringify(envelope));
    await expect(install(release, trust)).rejects.toThrow("Release signature is invalid");
    await assertNothingHappened();
  });

  it("requires an advisory list and honours a separately pinned manifest hash", async () => {
    const release = await buildRelease(root);
    const signer = testKey();
    await writeSignature(release, signer.privateKey);
    const trust = await writeTrust(root, [signer.key]);
    await expect(install(release, { ...trust, advisoryPaths: [] })).rejects.toThrow(
      "At least one advisory/revocation list is required",
    );
    await expect(install(release, trust, { manifestSha256: "0".repeat(64) })).rejects.toThrow(
      "Manifest hash mismatch",
    );
    await assertNothingHappened();
  });

  it("executes and extracts nothing before verification passes", async () => {
    // The runtime archive and image parts are absent: reading any of them would fail with a
    // filesystem error, so the signature error proves they were never opened.
    const release = await buildRelease(root);
    await rm(join(release.dir, "runtime.tar.gz"));
    await rm(join(release.dir, "images"), { recursive: true });
    const signer = testKey();
    const attacker = testKey("attacker");
    await writeSignature(release, attacker.privateKey);
    const trust = await writeTrust(root, [signer.key]);
    await expect(install(release, trust)).rejects.toThrow("Release signed by unknown key");
    await assertNothingHappened();
    // The same release with a valid signature proceeds to the archive step, which then fails.
    await writeSignature(release, signer.privateKey);
    await expect(install(release, trust)).rejects.toThrow(/ENOENT/u);
    expect(await exists(join(root, "runtime"))).toBe(false);
    expect(await exists(dockerLog)).toBe(false);
  });
});

describe("keyring, advisory and signing mechanics", () => {
  it("rejects malformed trust documents", () => {
    const signer = testKey();
    expect(() =>
      parseKeyring({ schemaVersion: "1.0.0", keys: [{ ...signer.key, keyId: "f".repeat(64) }] }),
    ).toThrow("keyId does not match the public key");
    expect(() => parseKeyring({ schemaVersion: "1.0.0", keys: [], extra: 1 })).toThrow(
      "unknown field",
    );
    expect(() => parseAdvisories({ ...emptyAdvisories, schemaVersion: "2.0.0" })).toThrow(
      ReleaseTrustError,
    );
    expect(() =>
      parseAdvisories({
        ...emptyAdvisories,
        revokedReleases: [{ revokedAt: "2026-10-11T12:00:00Z", reason: "no identifier" }],
      }),
    ).toThrow("needs manifestSha256 or sourceCommit");
    expect(parseAdvisories(emptyAdvisories).revokedKeys).toEqual([]);
  });

  it("generates a key without overwriting, registers only its public half and signs only for registered keys", async () => {
    const root = await temporary();
    const privateKeyPath = join(root, "secret/release.pem");
    const keyringPath = join(root, "keyring.json");
    const key = await createSigningKey({
      privateKeyPath,
      keyringPath,
      description: "test maintainer",
    });
    expect((await stat(privateKeyPath)).mode & 0o777).toBe(0o600);
    const keyringText = await readFile(keyringPath, "utf8");
    expect(keyringText).toContain(key.keyId);
    expect(keyringText).not.toContain("PRIVATE KEY");
    await expect(
      createSigningKey({ privateKeyPath, keyringPath, description: "again" }),
    ).rejects.toThrow(/EEXIST/u);
    expect(parseKeyring(JSON.parse(await readFile(keyringPath, "utf8"))).keys).toHaveLength(1);

    const release = await buildRelease(root);
    const advisoriesPath = join(root, "advisories.json");
    await writeFile(advisoriesPath, JSON.stringify(emptyAdvisories));
    const signed = await signRelease({
      releaseDir: release.dir,
      privateKeyPath,
      keyringPath,
      advisoryPaths: [advisoriesPath],
    });
    expect(signed.keyId).toBe(key.keyId);
    const verified = await verifyRelease({
      manifestPath: release.manifestPath,
      signaturePath: signed.signaturePath,
      keyringPath,
      advisoryPaths: [advisoriesPath],
      manifestSha256: sha256(release.manifestBytes),
    });
    expect(verified).toEqual({ keyId: key.keyId, manifestSha256: sha256(release.manifestBytes) });

    // A key file readable by others is refused, and the error never carries key material.
    const second = await buildRelease(await temporary());
    await chmod(privateKeyPath, 0o644);
    const refusal = await signRelease({
      releaseDir: second.dir,
      privateKeyPath,
      keyringPath,
      advisoryPaths: [advisoriesPath],
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ReleaseTrustError);
    expect(String(refusal)).toContain("Signing key must be a regular file with mode 0600");
    expect(String(refusal)).not.toContain(await readFile(privateKeyPath, "utf8"));
    await chmod(privateKeyPath, 0o600);

    // An unregistered or revoked key cannot produce a release signature.
    const unregistered = join(root, "unregistered.pem");
    await writeFile(unregistered, testKey().privateKeyPem, { mode: 0o600 });
    await expect(
      signRelease({
        releaseDir: second.dir,
        privateKeyPath: unregistered,
        keyringPath,
        advisoryPaths: [advisoriesPath],
      }),
    ).rejects.toThrow("Release signed by unknown key");
    await writeFile(
      advisoriesPath,
      JSON.stringify({
        ...emptyAdvisories,
        revokedKeys: [{ keyId: key.keyId, revokedAt: "2026-10-11T12:00:00Z", reason: "rotated" }],
      }),
    );
    await expect(
      signRelease({
        releaseDir: second.dir,
        privateKeyPath,
        keyringPath,
        advisoryPaths: [advisoriesPath],
      }),
    ).rejects.toThrow("is revoked: rotated");
    expect(await exists(`${second.manifestPath}.sig`)).toBe(false);
  });
});

describe("generated install-runtime.sh", () => {
  /** Compiles the standalone installer modules (type stripping only) into a directory. */
  async function standaloneModules(root: string): Promise<string> {
    const out = join(root, "modules");
    await mkdir(out);
    for (const name of ["install", "archive", "signing"])
      await writeFile(
        join(out, `${name}.js`),
        stripTypeScriptTypes(await readFile(join(import.meta.dirname, `${name}.ts`), "utf8")),
      );
    return out;
  }
  async function shellRelease(options: {
    liveAdvisories?: Advisories;
    sign?: boolean;
    revokeEmbedded?: boolean;
  }) {
    const root = await temporary();
    const dockerLog = await dockerShim(root);
    const release = await buildRelease(root);
    const signer = testKey();
    if (options.sign !== false) await writeSignature(release, signer.privateKey);
    const trust = await writeTrust(root, [signer.key]);
    const script = await assembleInstaller({
      releaseDir: release.dir,
      distributionDir: await standaloneModules(root),
      repository: "example/testmaster",
      tag: "runtime-test",
      keyringPath: trust.keyringPath,
      advisoryPath: trust.advisoryPaths[0]!,
    });
    const live = join(root, "live-advisories.json");
    if (options.liveAdvisories) await writeFile(live, JSON.stringify(options.liveAdvisories));
    // Offline stand-in for curl: serves the release directory and the live advisory list.
    await writeFile(
      join(root, "bin/curl"),
      `#!/usr/bin/env bash
url=""; out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
name="\${url##*/}"
if [[ "$url" == https://raw.githubusercontent.com/* ]]; then src='${live}'
elif [[ -f '${release.dir}'/"$name" ]]; then src='${release.dir}'/"$name"
else src='${release.dir}'/images/"$name"; fi
[[ -f "$src" ]] || exit 22
cp "$src" "$out"
`,
      { mode: 0o755 },
    );
    const run = (env: Record<string, string> = {}) =>
      exec("bash", [script, join(root, "runtime")], {
        env: { ...process.env, HOME: root, ...env },
      });
    return { root, run, dockerLog, release, script, signer };
  }

  it("verifies the signature and embedded advisories before installing, and reports the signing key", async () => {
    const { run, root, signer } = await shellRelease({ liveAdvisories: emptyAdvisories });
    const { stdout } = await run();
    expect(stdout).toContain(`"signingKeyId":"${signer.key.keyId}"`);
    expect(await exists(join(root, "runtime/apps/cli/dist/main.js"))).toBe(true);
  });

  it("refuses a release whose signature asset is missing before running the installer", async () => {
    const { run, root, dockerLog } = await shellRelease({ sign: false });
    // curl --fail exits 22 for the absent manifest.json.sig asset, so install.js never starts.
    await expect(run()).rejects.toMatchObject({ code: 22 });
    expect(await exists(join(root, "runtime"))).toBe(false);
    expect(await dockerLoads(dockerLog)).toBe(0);
  });

  it("refuses a release revoked in the live advisory list published after the script was created", async () => {
    const { run, root, release, dockerLog } = await shellRelease({});
    await writeFile(
      join(root, "live-advisories.json"),
      JSON.stringify({
        ...emptyAdvisories,
        revokedReleases: [
          {
            manifestSha256: sha256(release.manifestBytes),
            revokedAt: "2026-10-12T00:00:00Z",
            reason: "revoked after publication",
          },
        ],
      }),
    );
    await expect(run()).rejects.toThrow("Release is revoked: revoked after publication");
    expect(await exists(join(root, "runtime"))).toBe(false);
    expect(await dockerLoads(dockerLog)).toBe(0);
  });

  it("falls back to the embedded advisory snapshot offline with a warning unless live advisories are required", async () => {
    const { run, root } = await shellRelease({});
    const { stderr } = await run();
    expect(stderr).toContain("WARNING: live advisory list unreachable");
    expect(await exists(join(root, "runtime/apps/cli/dist/main.js"))).toBe(true);
    const strict = await shellRelease({});
    await expect(strict.run({ TESTMASTER_REQUIRE_LIVE_ADVISORIES: "1" })).rejects.toThrow(
      "Live advisory list unreachable",
    );
    expect(await exists(join(strict.root, "runtime"))).toBe(false);
  });

  it("pins installer modules by hash and embeds the keyring", async () => {
    const { script } = await shellRelease({ liveAdvisories: emptyAdvisories });
    const text = await readFile(script, "utf8");
    expect(text).toMatch(/^[a-f0-9]{64} {2}signing\.js$/mu);
    expect(text).toContain("TESTMASTER_KEYRING_EOF");
    expect(() =>
      renderInstallerScript({
        repository: "example/testmaster",
        tag: "runtime-test",
        manifestSha256: "0".repeat(64),
        moduleHashes: {
          "install.js": "0".repeat(64),
          "archive.js": "0".repeat(64),
          "signing.js": "0".repeat(64),
          "package.json": "0".repeat(64),
        },
        manifest: { images: [] },
        keyring: { schemaVersion: "1.0.0", keys: [] },
        advisories: emptyAdvisories,
      }),
    ).toThrow("at least one trusted release key");
  });
});
