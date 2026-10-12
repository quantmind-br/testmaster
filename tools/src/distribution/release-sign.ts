import { createPrivateKey } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { digestFile, sha256 } from "./archive.js";
import { verifyManifest } from "./install.js";
import {
  INSTALLER_MODULES,
  type InstallerScriptInput,
  renderInstallerScript,
} from "./installer-script.js";
import {
  assertPrivateKeyFileSafe,
  generateReleaseKey,
  loadReleaseSignature,
  loadReleaseTrust,
  parseKeyring,
  type ReleaseKey,
  signManifestBytes,
  verifyReleaseSignature,
} from "./signing.js";
import { verifyVulnerabilityReport } from "./vulnerabilities.js";

/** Maintainer-only signing workflow. The private key is read from a file and never logged. */
export const SIGNING_KEY_ENV = "TESTMASTER_RELEASE_SIGNING_KEY_FILE";

/** Creates a fresh private key (mode 0600, never overwritten) and appends its public half. */
export async function createSigningKey(options: {
  privateKeyPath: string;
  keyringPath: string;
  description: string;
}): Promise<ReleaseKey> {
  const { privateKeyPem, key } = generateReleaseKey(options.description);
  const existing = await readFile(options.keyringPath, "utf8").then(
    (text) => parseKeyring(JSON.parse(text)),
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return { schemaVersion: "1.0.0" as const, keys: [] };
      throw error;
    },
  );
  const keyring = parseKeyring({ ...existing, keys: [...existing.keys, key] });
  await mkdir(dirname(resolve(options.privateKeyPath)), { recursive: true, mode: 0o700 });
  await writeFile(options.privateKeyPath, privateKeyPem, { flag: "wx", mode: 0o600 });
  await writeFile(options.keyringPath, `${JSON.stringify(keyring, null, 2)}\n`);
  return key;
}
/**
 * Signs `<releaseDir>/manifest.json` and writes `manifest.json.sig`. The manifest must be a
 * structurally valid distribution manifest that pins a passing, correctly bound vulnerability
 * report (SEC-045), and the signature is verified against the committed keyring and advisories
 * before it is written, so a key that is unregistered or revoked cannot produce a release asset.
 */
export async function signRelease(options: {
  releaseDir: string;
  privateKeyPath: string;
  keyringPath: string;
  advisoryPaths: string[];
  /** Repository checkout holding the scanner pin and exception register; defaults to this one. */
  repositoryRoot?: string;
}): Promise<{ keyId: string; manifestSha256: string; signaturePath: string }> {
  const manifestPath = join(options.releaseDir, "manifest.json");
  const manifest = await readFile(manifestPath);
  await verifyVulnerabilityReport(
    options.releaseDir,
    verifyManifest(manifest, sha256(manifest)),
    options.repositoryRoot === undefined ? {} : { root: options.repositoryRoot },
  );
  await assertPrivateKeyFileSafe(options.privateKeyPath);
  const privateKey = createPrivateKey(await readFile(options.privateKeyPath));
  const signature = signManifestBytes(manifest, privateKey);
  const signatureBytes = Buffer.from(`${JSON.stringify(signature, null, 2)}\n`);
  verifyReleaseSignature({
    manifest,
    signature: signatureBytes,
    trust: await loadReleaseTrust(options.keyringPath, options.advisoryPaths),
  });
  const signaturePath = `${manifestPath}.sig`;
  await writeFile(signaturePath, signatureBytes, { flag: "wx", mode: 0o644 });
  return { keyId: signature.keyId, manifestSha256: signature.manifestSha256, signaturePath };
}
/** Verifies a release the way the installer does, without installing. */
export async function verifyRelease(options: {
  manifestPath: string;
  signaturePath: string;
  keyringPath: string;
  advisoryPaths: string[];
  manifestSha256?: string;
}) {
  return verifyReleaseSignature({
    manifest: await readFile(options.manifestPath),
    signature: await loadReleaseSignature(options.signaturePath),
    trust: await loadReleaseTrust(options.keyringPath, options.advisoryPaths),
    ...(options.manifestSha256 !== undefined
      ? { pinnedManifestSha256: options.manifestSha256 }
      : {}),
  });
}
/**
 * Copies the standalone installer modules next to the signed manifest and renders the hash-pinned
 * `install-runtime.sh` embedding the keyring and advisories snapshot.
 */
export async function assembleInstaller(options: {
  releaseDir: string;
  distributionDir: string;
  repository: string;
  tag: string;
  keyringPath: string;
  advisoryPath: string;
}): Promise<string> {
  const manifestBytes = await readFile(join(options.releaseDir, "manifest.json"));
  const manifest = verifyManifest(manifestBytes, sha256(manifestBytes));
  await writeFile(join(options.releaseDir, "package.json"), '{"type":"module"}\n', {
    flag: "wx",
  });
  for (const name of INSTALLER_MODULES.filter((module) => module.endsWith(".js")))
    await copyFile(join(options.distributionDir, name), join(options.releaseDir, name));
  const moduleHashes = {} as InstallerScriptInput["moduleHashes"];
  for (const name of INSTALLER_MODULES)
    moduleHashes[name] = (await digestFile(join(options.releaseDir, name))).sha256;
  const script = renderInstallerScript({
    repository: options.repository,
    tag: options.tag,
    manifestSha256: sha256(manifestBytes),
    moduleHashes,
    manifest,
    keyring: JSON.parse(await readFile(options.keyringPath, "utf8")),
    advisories: JSON.parse(await readFile(options.advisoryPath, "utf8")),
  });
  const scriptPath = join(options.releaseDir, "install-runtime.sh");
  await writeFile(scriptPath, script, { flag: "wx", mode: 0o755 });
  return scriptPath;
}

const USAGE = `Usage:
  release-sign.js keygen --private-key PATH --keyring PATH --description TEXT
  release-sign.js sign --release-dir DIR --keyring PATH --advisories PATH [--private-key PATH]
      (private key path defaults to $${SIGNING_KEY_ENV})
  release-sign.js verify --manifest PATH --keyring PATH --advisories PATH [--signature PATH] [--manifest-sha256 HEX]
  release-sign.js assemble --release-dir DIR --repository OWNER/REPO --tag TAG --keyring PATH --advisories PATH`;
function parseFlags(args: string[], allowed: string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !allowed.includes(key) || !value) throw new Error(USAGE);
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  return flags;
}
async function main(argv: string[]): Promise<unknown> {
  const [command, ...rest] = argv;
  const need = (flags: Map<string, string[]>, name: string): string => {
    const value = flags.get(name)?.[0];
    if (value === undefined || flags.get(name)!.length !== 1) throw new Error(USAGE);
    return value;
  };
  if (command === "keygen") {
    const flags = parseFlags(rest, ["--private-key", "--keyring", "--description"]);
    const key = await createSigningKey({
      privateKeyPath: need(flags, "--private-key"),
      keyringPath: need(flags, "--keyring"),
      description: need(flags, "--description"),
    });
    return { keyId: key.keyId, publicKeyAddedTo: need(flags, "--keyring") };
  }
  if (command === "sign") {
    const flags = parseFlags(rest, ["--release-dir", "--keyring", "--advisories", "--private-key"]);
    const privateKeyPath = flags.get("--private-key")?.[0] ?? process.env[SIGNING_KEY_ENV];
    if (!privateKeyPath)
      throw new Error(`Signing key path required: --private-key or ${SIGNING_KEY_ENV}`);
    return signRelease({
      releaseDir: need(flags, "--release-dir"),
      privateKeyPath,
      keyringPath: need(flags, "--keyring"),
      advisoryPaths: flags.get("--advisories") ?? [],
    });
  }
  if (command === "verify") {
    const flags = parseFlags(rest, [
      "--manifest",
      "--keyring",
      "--advisories",
      "--signature",
      "--manifest-sha256",
    ]);
    const manifestPath = need(flags, "--manifest");
    const pin = flags.get("--manifest-sha256")?.[0];
    return verifyRelease({
      manifestPath,
      signaturePath: flags.get("--signature")?.[0] ?? `${manifestPath}.sig`,
      keyringPath: need(flags, "--keyring"),
      advisoryPaths: flags.get("--advisories") ?? [],
      ...(pin !== undefined ? { manifestSha256: pin } : {}),
    });
  }
  if (command === "assemble") {
    const flags = parseFlags(rest, [
      "--release-dir",
      "--repository",
      "--tag",
      "--keyring",
      "--advisories",
    ]);
    return {
      installer: await assembleInstaller({
        releaseDir: need(flags, "--release-dir"),
        distributionDir: dirname(fileURLToPath(import.meta.url)),
        repository: need(flags, "--repository"),
        tag: need(flags, "--tag"),
        keyringPath: need(flags, "--keyring"),
        advisoryPath: need(flags, "--advisories"),
      }),
    };
  }
  throw new Error(USAGE);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(
    (result) => console.log(JSON.stringify(result)),
    (error: unknown) => {
      console.error(String(error));
      process.exitCode = 1;
    },
  );
}
