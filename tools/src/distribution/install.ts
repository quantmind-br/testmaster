import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ArchiveDigest,
  type DistributionManifest,
  digestFile,
  extractSafeArchive,
  MAX_IMAGE_SIZE,
  MAX_PART_SIZE,
  MAX_RUNTIME_SIZE,
  safeArchivePath,
  sha256,
} from "./archive.js";

export interface InstallRuntimeOptions {
  manifestPath: string;
  manifestSha256: string;
  destination: string;
}
export interface InstalledRuntime {
  runtimeDir: string;
  cliPath: string;
  sourceCommit: string;
  manifestSha256: string;
}
function validDigest(value: unknown, bound: number): value is ArchiveDigest {
  if (!value || typeof value !== "object") return false;
  const item = value as ArchiveDigest;
  return (
    /^[a-f0-9]{64}$/u.test(item.sha256) &&
    Number.isSafeInteger(item.size) &&
    item.size > 0 &&
    item.size <= bound
  );
}
export function verifyManifest(bytes: Buffer, expectedSha256: string): DistributionManifest {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256) || sha256(bytes) !== expectedSha256)
    throw new Error("Manifest hash mismatch");
  if (bytes.length > 32 * 1024 * 1024) throw new Error("Oversized distribution manifest");
  const value = JSON.parse(bytes.toString("utf8")) as DistributionManifest;
  if (
    value.schemaVersion !== "1.0.0" ||
    !/^[a-f0-9]{40}$/u.test(value.sourceCommit) ||
    !/^[a-f0-9]{64}$/u.test(value.imageLockHash) ||
    !validDigest(value.runtimeArchive, MAX_RUNTIME_SIZE) ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.images) ||
    !Array.isArray(value.dependencies) ||
    value.files.length > 200_000 ||
    value.images.length !== 2
  )
    throw new Error("Invalid distribution manifest");
  const paths = new Set<string>();
  for (const file of value.files) {
    if (
      typeof file.path !== "string" ||
      file.path === ".install" ||
      file.path.startsWith(".install/")
    )
      throw new Error("Invalid or reserved manifest file path");
    safeArchivePath(file.path);
    if (
      paths.has(file.path) ||
      !/^[a-f0-9]{64}$/u.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_RUNTIME_SIZE
    )
      throw new Error("Invalid manifest file");
    paths.add(file.path);
  }
  for (const dependency of value.dependencies)
    if (
      typeof dependency.name !== "string" ||
      typeof dependency.version !== "string" ||
      typeof dependency.license !== "string"
    )
      throw new Error("Invalid dependency inventory");
  const names = new Set<string>();
  for (const image of value.images) {
    if (
      !["testmaster-runner", "testmaster-runner-python"].includes(image.name) ||
      names.has(image.name) ||
      !/^sha256:[a-f0-9]{64}$/u.test(image.imageId) ||
      !validDigest(image.archive, MAX_IMAGE_SIZE) ||
      !Array.isArray(image.archive.parts) ||
      image.archive.parts.length < 1 ||
      image.archive.parts.length > 64 ||
      image.archive.parts.some((part) => !validDigest(part, MAX_PART_SIZE)) ||
      image.archive.parts.reduce((sum, part) => sum + part.size, 0) !== image.archive.size
    )
      throw new Error("Invalid manifest image");
    names.add(image.name);
  }
  return value;
}
export async function reassembleParts(
  paths: string[],
  parts: ArchiveDigest[],
  expected: ArchiveDigest,
  output: string,
): Promise<void> {
  if (
    paths.length !== parts.length ||
    !paths.length ||
    paths.length > 64 ||
    !validDigest(expected, MAX_IMAGE_SIZE) ||
    parts.some((part) => !validDigest(part, MAX_PART_SIZE)) ||
    parts.reduce((sum, part) => sum + part.size, 0) !== expected.size
  )
    throw new Error("Invalid reassembly bounds");
  const full = createHash("sha256");
  let total = 0;
  const destination = await open(output, "wx", 0o600);
  try {
    for (let index = 0; index < paths.length; index++) {
      const part = parts[index]!;
      const hash = createHash("sha256");
      let size = 0;
      const input = await open(paths[index]!, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await input.stat()).isFile()) throw new Error("Image part is not a regular file");
        for await (const value of input.createReadStream({ autoClose: false })) {
          const chunk = value as Buffer;
          size += chunk.length;
          total += chunk.length;
          if (size > part.size || total > expected.size || total > MAX_IMAGE_SIZE)
            throw new Error("Image reassembly size mismatch");
          hash.update(chunk);
          full.update(chunk);
          await destination.writeFile(chunk);
        }
      } finally {
        await input.close();
      }
      if (size !== part.size || hash.digest("hex") !== part.sha256)
        throw new Error("Image part hash mismatch");
    }
    if (total !== expected.size || full.digest("hex") !== expected.sha256)
      throw new Error("Image archive hash mismatch");
  } finally {
    await destination.close();
  }
}
async function docker(args: string[], timeout: number): Promise<string> {
  const child = spawn("docker", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = (stdout + chunk.toString()).slice(-8192);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  return new Promise<string>((done, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Docker installation timeout"));
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) done(stdout.trim());
      else reject(new Error(`Docker installation failed: ${stderr}`));
    });
  });
}
export async function installRuntime(options: InstallRuntimeOptions): Promise<InstalledRuntime> {
  const manifestPath = resolve(options.manifestPath);
  const manifest = verifyManifest(await readFile(manifestPath), options.manifestSha256);
  const destination = resolve(options.destination);
  const parent = await realpath(dirname(destination));
  if (parent !== dirname(destination))
    throw new Error("Runtime destination parent must not contain symlinks");
  await mkdir(destination, { mode: 0o700 });
  let installed = false;
  try {
    const stat = await lstat(destination);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o777) !== 0o700 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error("Runtime directory must be private and owned");
    const downloads = join(destination, ".install");
    await mkdir(downloads, { mode: 0o700 });
    const archive = join(downloads, "runtime.tar.gz");
    const source = join(dirname(manifestPath), "runtime.tar.gz");
    const sourceStat = await lstat(source);
    if (!sourceStat.isFile() || sourceStat.size !== manifest.runtimeArchive.size)
      throw new Error("Runtime archive size mismatch");
    await copyFile(source, archive, constants.COPYFILE_EXCL);
    const digest = await digestFile(archive);
    if (
      digest.sha256 !== manifest.runtimeArchive.sha256 ||
      digest.size !== manifest.runtimeArchive.size
    )
      throw new Error("Runtime archive hash mismatch");
    const extracted = await extractSafeArchive(archive, destination);
    const expectedFiles = [...manifest.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    if (
      extracted.length !== expectedFiles.length ||
      extracted.some((file, index) => {
        const expected = expectedFiles[index]!;
        return (
          file.path !== expected.path ||
          file.size !== expected.size ||
          file.sha256 !== expected.sha256
        );
      })
    )
      throw new Error("Runtime file inventory mismatch");
    const lockBytes = await readFile(join(destination, "containers/images.lock.json"));
    if (sha256(lockBytes) !== manifest.imageLockHash) throw new Error("Image lock hash mismatch");
    const lock = JSON.parse(lockBytes.toString("utf8")) as Record<string, { imageId: string }>;
    if (
      Object.keys(lock).length !== manifest.images.length ||
      manifest.images.some((image) => lock[image.name]?.imageId !== image.imageId)
    )
      throw new Error("Image manifest does not match runtime lock");
    const archives: { path: string; imageId: string }[] = [];
    // Verify every archive before changing Docker state.
    for (const image of manifest.images) {
      const path = join(downloads, `${image.name}.tar.gz`);
      const parts = image.archive.parts.map((_, index) =>
        join(
          dirname(manifestPath),
          "images",
          `${image.name}.tar.gz.part-${String(index).padStart(4, "0")}`,
        ),
      );
      await reassembleParts(parts, image.archive.parts, image.archive, path);
      archives.push({ path, imageId: image.imageId });
    }
    for (const image of archives) {
      await docker(["load", "--input", image.path], 600_000);
      const loaded = await docker(
        ["image", "inspect", image.imageId, "--format", "{{.Id}}"],
        30_000,
      );
      if (loaded !== image.imageId) throw new Error("Loaded image identity mismatch");
    }
    const cliPath = join(destination, "apps/cli/dist/main.js");
    if (!(await lstat(cliPath)).isFile()) throw new Error("CLI runtime entrypoint missing");
    await rm(downloads, { recursive: true });
    installed = true;
    return {
      runtimeDir: destination,
      cliPath,
      sourceCommit: manifest.sourceCommit,
      manifestSha256: options.manifestSha256,
    };
  } finally {
    if (!installed) await rm(destination, { recursive: true, force: true });
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const values: Record<string, string> = {};
  try {
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index]!;
      const value = args[index + 1];
      if (!["--manifest", "--manifest-sha256", "--dest"].includes(key) || !value || values[key])
        throw new Error("Usage: install.js --manifest PATH --manifest-sha256 HEX --dest DIR");
      values[key] = value;
    }
    if (!values["--manifest"] || !values["--manifest-sha256"] || !values["--dest"])
      throw new Error("Missing installation argument");
    installRuntime({
      manifestPath: values["--manifest"],
      manifestSha256: values["--manifest-sha256"],
      destination: values["--dest"],
    })
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error: unknown) => {
        console.error(String(error));
        process.exitCode = 1;
      });
  } catch (error) {
    console.error(String(error));
    process.exitCode = 5;
  }
}
