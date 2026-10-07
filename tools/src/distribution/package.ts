import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGzip } from "node:zlib";
import {
  type ArchiveDigest,
  type DistributionManifest,
  digestFile,
  type FileDigest,
  MAX_IMAGE_SIZE,
  MAX_PART_SIZE,
  safeArchivePath,
  safeLink,
  sha256,
  writeDeterministicArchive,
} from "./archive.js";
import { auditLicenses } from "./licenses.js";
import { type SourcesIndex, verifySourcesIndex } from "./sources.js";

interface PackageDocument {
  name: string;
  version: string;
  license?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}
interface PackageNode {
  source: string;
  destination: string;
  document: PackageDocument;
}
// The paths mirror import.meta.url-relative resource lookups in the built runtime.
export const RUNTIME_RESOURCES = [
  "LICENSE",
  "NOTICE",
  "containers/NOTICE",
  "packages/contracts/schemas",
  "packages/contracts/openapi.json",
  "packages/persistence/migrations/sqlite",
  "packages/persistence/migrations/postgres",
  "containers/images.lock.json",
  "containers/seccomp_profile.json",
  "packages/application/skill-content/1.0.0/SKILL.md",
] as const;
/**
 * Workspace packages contribute only their built output, so repository-private directories
 * (sources, tests, validation, evaluation results) are dropped by name. Third-party packages are
 * copied as published: directory names such as `validation` or `src` can be runtime modules
 * there (graphql ships `validation/`), so only nested dependency trees, VCS metadata, type
 * declarations/maps and credential-shaped files are excluded.
 */
type CopyScope = "workspace" | "dependency";
function excluded(name: string, scope: CopyScope): boolean {
  if (
    name === "node_modules" ||
    name === ".git" ||
    name === ".npmrc" ||
    name.startsWith(".env") ||
    name.endsWith(".d.ts") ||
    name.endsWith(".d.cts") ||
    name.endsWith(".d.mts") ||
    name.endsWith(".map") ||
    /\.(?:pem|key|tsbuildinfo)$/u.test(name)
  )
    return true;
  return (
    scope === "workspace" &&
    ([
      "src",
      "test",
      "tests",
      "__tests__",
      ".github",
      "validation",
      "evals",
      "results",
      "coverage",
      "private",
      "secrets",
      ".pnpmfile.cjs",
      ".yarnrc",
      ".yarnrc.yml",
      ".ai-memory.toml",
    ].includes(name) ||
      /(?:^|\.)(?:test|spec)\.[cm]?js$/u.test(name))
  );
}
async function copyTree(source: string, destination: string, scope: CopyScope): Promise<void> {
  const stat = await lstat(source);
  if (stat.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const name of (await readdir(source)).sort()) {
      if (excluded(name, scope)) continue;
      await copyTree(join(source, name), join(destination, name), scope);
    }
  } else if (stat.isSymbolicLink()) {
    const target = await readlink(source);
    // Package-local links are preserved; dependency links are generated separately.
    safeLink(basename(destination), target);
    await symlink(target, destination);
  } else if (stat.isFile()) {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
  } else throw new Error(`Unsupported package file: ${source}`);
}
async function packageDocument(path: string): Promise<PackageDocument> {
  const value = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as PackageDocument;
  if (typeof value.name !== "string" || typeof value.version !== "string")
    throw new Error(`Invalid package manifest: ${path}`);
  return value;
}
async function resolveDependency(source: string, name: string): Promise<string> {
  if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/u.test(name))
    throw new Error(`Invalid package name: ${name}`);
  for (let directory = source; ; directory = dirname(directory)) {
    try {
      return await realpath(join(directory, "node_modules", name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(directory) === directory)
      throw new Error(`Production dependency unavailable: ${name} from ${source}`);
  }
}
async function runtimeFiles(root: string, directory = ""): Promise<FileDigest[]> {
  const files: FileDigest[] = [];
  for (const name of (await readdir(join(root, directory))).sort()) {
    const path = directory ? `${directory}/${name}` : name;
    safeArchivePath(path);
    const stat = await lstat(join(root, path));
    if (stat.isDirectory()) files.push(...(await runtimeFiles(root, path)));
    else if (stat.isSymbolicLink()) {
      const target = await readlink(join(root, path));
      safeLink(path, target);
      files.push({ path, sha256: sha256(target), size: Buffer.byteLength(target) });
    } else if (stat.isFile()) files.push({ path, ...(await digestFile(join(root, path))) });
    else throw new Error(`Unsupported runtime file: ${path}`);
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
export async function stageRuntime(
  root: string,
  destination: string,
  entries: string[] = ["apps/cli", "packages/runner"],
): Promise<{ files: FileDigest[]; dependencies: DistributionManifest["dependencies"] }> {
  const workspace = new Map<string, string>();
  for (const group of ["apps", "packages"])
    for (const name of (await readdir(join(root, group))).sort()) {
      const path = join(root, group, name);
      try {
        const document = await packageDocument(path);
        workspace.set(document.name, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  const nodes = new Map<string, PackageNode>();
  async function add(source: string): Promise<PackageNode> {
    source = await realpath(source);
    const existing = nodes.get(source);
    if (existing) return existing;
    const document = await packageDocument(source);
    const workspaceSource = workspace.get(document.name);
    const destinationPath =
      workspaceSource === source
        ? relative(root, source).split("\\").join("/")
        : `node_modules/.runtime/${sha256(relative(root, source)).slice(0, 24)}`;
    safeArchivePath(destinationPath);
    const node = { source, destination: destinationPath, document };
    nodes.set(source, node);
    const target = join(destination, destinationPath);
    if (workspaceSource === source) {
      await mkdir(target, { recursive: true, mode: 0o700 });
      await copyFile(join(source, "package.json"), join(target, "package.json"));
      await copyTree(join(source, "dist"), join(target, "dist"), "workspace");
    } else await copyTree(source, target, "dependency");
    const dependencies = {
      ...document.peerDependencies,
      ...document.dependencies,
      ...document.optionalDependencies,
    };
    for (const [name, range] of Object.entries(dependencies).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      let dependencySource: string;
      try {
        dependencySource = range.startsWith("workspace:")
          ? (workspace.get(name) ??
            (() => {
              throw new Error(`Missing workspace package: ${name}`);
            })())
          : await resolveDependency(source, name);
      } catch (error) {
        if (
          (document.optionalDependencies?.[name] ||
            document.peerDependenciesMeta?.[name]?.optional) &&
          String(error).includes("Production dependency unavailable")
        )
          continue;
        throw error;
      }
      const dependency = await add(dependencySource);
      const link = `${destinationPath}/node_modules/${name}`;
      const targetLink = relative(
        dirname(join(destination, link)),
        join(destination, dependency.destination),
      )
        .split("\\")
        .join("/");
      safeLink(link, targetLink);
      await mkdir(dirname(join(destination, link)), { recursive: true, mode: 0o700 });
      await symlink(targetLink, join(destination, link));
    }
    return node;
  }
  for (const entry of entries) await add(join(root, entry));
  for (const resource of RUNTIME_RESOURCES)
    await copyTree(join(root, resource), join(destination, resource), "workspace");
  const dependencies = [...nodes.values()]
    .map(({ document }) => ({
      name: document.name,
      version: document.version,
      license: document.license ?? "UNKNOWN",
    }))
    .filter(
      (value, index, values) =>
        values.findIndex(
          (other) =>
            other.name === value.name &&
            other.version === value.version &&
            other.license === value.license,
        ) === index,
    )
    .sort((a, b) =>
      `${a.name}@${a.version}` < `${b.name}@${b.version}`
        ? -1
        : `${a.name}@${a.version}` > `${b.name}@${b.version}`
          ? 1
          : 0,
    );
  return { files: await runtimeFiles(destination), dependencies };
}
export async function splitArchive(
  path: string,
  prefix: string,
  partSize = MAX_PART_SIZE,
): Promise<ArchiveDigest[]> {
  if (!Number.isInteger(partSize) || partSize < 1 || partSize > MAX_PART_SIZE)
    throw new Error("Invalid archive part size");
  const parts: ArchiveDigest[] = [];
  let handle: FileHandle | undefined;
  let size = 0;
  let fullSize = 0;
  async function finish(): Promise<void> {
    if (!handle) return;
    await handle.close();
    handle = undefined;
    parts.push(await digestFile(`${prefix}${String(parts.length).padStart(4, "0")}`));
    size = 0;
  }
  try {
    for await (const value of createReadStream(path)) {
      const chunk = value as Buffer;
      fullSize += chunk.length;
      if (fullSize > MAX_IMAGE_SIZE) throw new Error("Image exceeds distribution bound");
      for (let offset = 0; offset < chunk.length; ) {
        if (!handle)
          handle = await open(`${prefix}${String(parts.length).padStart(4, "0")}`, "wx", 0o600);
        const count = Math.min(partSize - size, chunk.length - offset);
        await handle.writeFile(chunk.subarray(offset, offset + count));
        size += count;
        offset += count;
        if (size === partSize) await finish();
      }
    }
    await finish();
    if (!parts.length) throw new Error("Empty image archive");
    return parts;
  } finally {
    await handle?.close();
  }
}
async function dockerSave(imageId: string, output: string): Promise<void> {
  const child = spawn("docker", ["save", imageId], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  const completion = new Promise<void>((done, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? done() : reject(new Error(`docker save failed: ${stderr}`)),
    );
  });
  try {
    await Promise.all([
      pipeline(
        child.stdout,
        createGzip({ level: 9 }),
        createWriteStream(output, { flags: "wx", mode: 0o600 }),
      ),
      completion,
    ]);
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}
async function sourceCommit(root: string): Promise<string> {
  const status = spawn("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: root,
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let changes = "";
  status.stdout.on("data", (chunk: Buffer) => {
    changes += chunk.toString();
  });
  await new Promise<void>((done, reject) => {
    status.on("error", reject);
    status.on("close", (code) =>
      code === 0 && !changes.trim()
        ? done()
        : reject(new Error("Runtime distribution requires a clean committed source tree")),
    );
  });
  const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "rev-parse", "HEAD"], {
    cwd: root,
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  await new Promise<void>((done, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? done() : reject(new Error("Cannot resolve source commit")),
    );
  });
  const sha = stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("Invalid source commit");
  return sha;
}
export async function packageRuntime(
  root: string,
  out: string,
  sourcesIndexPath?: string,
): Promise<DistributionManifest> {
  root = await realpath(root);
  out = resolve(out);
  await mkdir(out, { mode: 0o700 });
  const stage = await mkdtemp(join(tmpdir(), "testmaster-runtime-"));
  try {
    const commit = await sourceCommit(root);
    const staged = await stageRuntime(root, stage);
    await auditLicenses(root, stage, join(out, "licenses"));
    if (!sourcesIndexPath)
      throw new Error("Image binary distribution requires a verified corresponding-source index");
    const sourcesBytes = await readFile(sourcesIndexPath);
    const sourcesIndex = JSON.parse(sourcesBytes.toString()) as SourcesIndex;
    if (sourcesIndex.sourceCommit !== commit)
      throw new Error("Corresponding-source recipe commit differs from runtime source commit");
    const sourceCache = dirname(resolve(sourcesIndexPath));
    await verifySourcesIndex(
      sourceCache,
      sourcesIndex,
      await readFile(join(out, "licenses/obligations.json")),
    );
    await copyFile(sourcesIndexPath, join(out, "licenses/sources-index.json"));
    await mkdir(join(out, "sources"), { mode: 0o700 });
    for (const part of sourcesIndex.archive.parts) {
      safeArchivePath(part.path);
      const digest = await digestFile(join(sourceCache, part.path));
      if (digest.sha256 !== part.sha256 || digest.size !== part.size)
        throw new Error("Corresponding-source archive part hash mismatch");
      await copyFile(join(sourceCache, part.path), join(out, "sources", basename(part.path)));
    }
    await copyTree(join(out, "licenses"), join(stage, "licenses"), "dependency");
    for (const file of sourcesIndex.files) {
      if (
        !file.path.startsWith("notices/") &&
        !/(?:LICENSE|COPYING|CREDITS|AUTHORS|license\.html|redistribution-limitations|material-evidence)/iu.test(
          file.path,
        )
      )
        continue;
      const noticePath = join(stage, "licenses/upstream", file.path);
      await mkdir(dirname(noticePath), { recursive: true, mode: 0o700 });
      await copyFile(join(sourceCache, file.path), noticePath);
    }
    staged.files = await runtimeFiles(stage);
    const runtimeArchive = await writeDeterministicArchive(
      stage,
      staged.files.map((file) => file.path),
      join(out, "runtime.tar.gz"),
    );
    const lockBytes = await readFile(join(root, "containers/images.lock.json"));
    const lock = JSON.parse(lockBytes.toString("utf8")) as Record<string, { imageId: string }>;
    await mkdir(join(out, "images"), { mode: 0o700 });
    const images: DistributionManifest["images"] = [];
    for (const [name, image] of Object.entries(lock).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      if (!/^[a-z0-9-]+$/u.test(name) || !/^sha256:[a-f0-9]{64}$/u.test(image.imageId))
        throw new Error("Invalid image lock");
      const archivePath = join(stage, `${name}.tar.gz`);
      await dockerSave(image.imageId, archivePath);
      const archive = await digestFile(archivePath);
      const parts = await splitArchive(archivePath, join(out, "images", `${name}.tar.gz.part-`));
      images.push({ name, imageId: image.imageId, archive: { ...archive, parts } });
    }
    const manifest: DistributionManifest = {
      schemaVersion: "1.0.0",
      sourceCommit: commit,
      runtimeArchive,
      ...staged,
      imageLockHash: sha256(lockBytes),
      sourcesIndexHash: sha256(sourcesBytes),
      sourcesArchive: sourcesIndex.archive,
      images,
    };
    const manifestBytes = JSON.stringify(manifest, null, 2) + "\n";
    await writeFile(join(out, "manifest.json"), manifestBytes, { flag: "wx", mode: 0o600 });
    return manifest;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (
    args.length !== 4 ||
    args[0] !== "--out" ||
    !args[1] ||
    args[2] !== "--sources-index" ||
    !args[3]
  ) {
    console.error("Usage: package.js --out DIR --sources-index VERIFIED_INDEX_JSON");
    process.exitCode = 5;
  } else
    packageRuntime(fileURLToPath(new URL("../../../", import.meta.url)), args[1], args[3])
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error: unknown) => {
        console.error(String(error));
        process.exitCode = 1;
      });
}
