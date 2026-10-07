import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  type ArchiveDigest,
  digestFile,
  MAX_PART_SIZE,
  safeArchivePath,
  sha256,
  writeDeterministicArchive,
} from "./archive.js";
import { acquireBrowserSources } from "./browser-sources.js";
import { splitArchive } from "./package.js";
import { acquirePythonSources } from "./python-sources.js";

const exec = promisify(execFile);
export interface SourceFile {
  path: string;
  url: string;
  sha256: string;
  size: number;
}
export interface SourceResidual {
  component: string;
  code: string;
  detail: string;
}
export interface SourcesIndex {
  schemaVersion: "1.0.0";
  auditHash: string;
  sourceCommit?: string;
  sourceTree?: SourceFile;
  files: SourceFile[];
  coverage: Record<string, string[]>;
  residuals: SourceResidual[];
  archive: {
    sha256: string;
    size: number;
    parts: { path: string; sha256: string; size: number }[];
  };
}
interface AuditDocument {
  obligations: { component: string; license: string; blockedReason?: string; notices: string[] }[];
  imageEvidence: Record<string, unknown>;
}
interface BomDocument {
  components: { "bom-ref": string; properties: { name: string; value: string }[] }[];
}
function auditDocument(value: unknown): AuditDocument {
  if (
    !value ||
    typeof value !== "object" ||
    !("obligations" in value) ||
    !Array.isArray(value.obligations) ||
    !("imageEvidence" in value) ||
    !value.imageEvidence ||
    typeof value.imageEvidence !== "object"
  )
    throw new SourceBundleError("SOURCE_METADATA_INVALID", "Invalid audit document");
  for (const item of value.obligations)
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.component !== "string" ||
      typeof item.license !== "string" ||
      !Array.isArray(item.notices) ||
      item.notices.some((notice: unknown) => typeof notice !== "string")
    )
      throw new SourceBundleError("SOURCE_METADATA_INVALID", "Invalid audit obligation");
  return value as AuditDocument;
}
function bomDocument(value: unknown): BomDocument {
  if (
    !value ||
    typeof value !== "object" ||
    !("components" in value) ||
    !Array.isArray(value.components)
  )
    throw new SourceBundleError("SOURCE_METADATA_INVALID", "Invalid SBOM");
  for (const item of value.components)
    if (
      !item ||
      typeof item !== "object" ||
      typeof item["bom-ref"] !== "string" ||
      !Array.isArray(item.properties) ||
      item.properties.some(
        (p: unknown) =>
          !p ||
          typeof p !== "object" ||
          !("name" in p) ||
          !("value" in p) ||
          typeof p.name !== "string" ||
          typeof p.value !== "string",
      )
    )
      throw new SourceBundleError("SOURCE_METADATA_INVALID", "Invalid SBOM component");
  return value as BomDocument;
}
export class SourceBundleError extends Error {
  constructor(
    public readonly code:
      | "SOURCE_UNAVAILABLE"
      | "SOURCE_HASH_MISMATCH"
      | "SOURCE_METADATA_INVALID"
      | "SOURCE_INDEX_INCOMPLETE",
    message: string,
  ) {
    super(message);
  }
}
export function parseDsc(bytes: string): {
  name: string;
  version: string;
  files: { name: string; sha256: string; size: number }[];
} {
  const name = /^Source: (\S+)$/mu.exec(bytes)?.[1];
  const version = /^Version: (\S+)$/mu.exec(bytes)?.[1];
  const block = /^Checksums-Sha256:\r?\n((?:[ \t]+[^\r\n]+\r?\n)+)/mu.exec(bytes)?.[1];
  if (!name || !version || !block)
    throw new SourceBundleError(
      "SOURCE_METADATA_INVALID",
      "Source descriptor lacks exact identity or SHA256 checksums",
    );
  const files = block
    .trim()
    .split(/\r?\n/u)
    .map((row) => {
      const match = /^\s*([a-f0-9]{64})\s+([0-9]+)\s+([^\s/]+)$/u.exec(row);
      if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) < 1)
        throw new SourceBundleError(
          "SOURCE_METADATA_INVALID",
          "Invalid source descriptor checksum row",
        );
      safeArchivePath(match[3]!);
      return { name: match[3]!, sha256: match[1]!, size: Number(match[2]) };
    });
  if (new Set(files.map((file) => file.name)).size !== files.length)
    throw new SourceBundleError("SOURCE_METADATA_INVALID", "Duplicate source descriptor entry");
  return { name, version, files };
}
async function json(url: string): Promise<unknown> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (response.ok) return response.json();
      if (response.status !== 429 && response.status < 500)
        throw new SourceBundleError(
          "SOURCE_METADATA_INVALID",
          `Source metadata HTTP ${response.status}`,
        );
      last = new SourceBundleError("SOURCE_UNAVAILABLE", `Source metadata HTTP ${response.status}`);
    } catch (error) {
      if (error instanceof SourceBundleError && error.code === "SOURCE_METADATA_INVALID")
        throw error;
      last = error;
    }
    const delay = Promise.withResolvers<void>();
    setTimeout(delay.resolve, 1000 * (attempt + 1));
    await delay.promise;
  }
  throw last instanceof SourceBundleError
    ? last
    : new SourceBundleError(
        "SOURCE_UNAVAILABLE",
        "Source metadata transport failed after bounded attempts",
      );
}
export async function downloadSource(
  cache: string,
  path: string,
  url: string,
  expected?: { sha256: string; size: number },
): Promise<SourceFile> {
  safeArchivePath(path);
  const file = join(cache, path);
  try {
    const digest = await digestFile(file);
    if (expected && (digest.sha256 !== expected.sha256 || digest.size !== expected.size))
      throw new SourceBundleError("SOURCE_HASH_MISMATCH", `Cached source hash mismatch: ${path}`);
    if (!expected) {
      const receipt = JSON.parse(await readFile(`${file}.receipt.json`, "utf8")) as SourceFile;
      if (receipt.url !== url || receipt.sha256 !== digest.sha256 || receipt.size !== digest.size)
        throw new SourceBundleError("SOURCE_HASH_MISMATCH", `Source receipt mismatch: ${path}`);
    }
    return { path, url, ...digest };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const partial = `${file}.partial`;
  let offset = 0;
  try {
    offset = (await lstat(partial)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (expected && offset > expected.size) {
    await rm(partial, { force: true });
    offset = 0;
  }
  const response = await fetch(url, {
    headers: { "Accept-Encoding": "identity", ...(offset ? { Range: `bytes=${offset}-` } : {}) },
    signal: AbortSignal.timeout(1800000),
  });
  if (!response.ok || !response.body)
    throw new SourceBundleError(
      "SOURCE_UNAVAILABLE",
      `Source download HTTP ${response.status}: ${url}`,
    );
  if (
    response.headers.get("content-encoding") &&
    response.headers.get("content-encoding") !== "identity"
  ) {
    // Fetch transparently decodes Content-Encoding; source checksums cover the original gzip bytes.
    await response.body.cancel();
    await rm(partial, { force: true });
    await exec(
      "curl",
      [
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--max-time",
        "1800",
        "--output",
        partial,
        url,
      ],
      { timeout: 1805000, maxBuffer: 1024 * 1024 },
    );
  } else {
    if (response.status !== 206) offset = 0;
    await pipeline(
      Readable.from(response.body),
      createWriteStream(partial, { flags: offset ? "a" : "w", mode: 0o600 }),
    );
  }
  const digest = await digestFile(partial);
  if (expected && (digest.sha256 !== expected.sha256 || digest.size !== expected.size)) {
    await rm(partial, { force: true });
    throw new SourceBundleError("SOURCE_HASH_MISMATCH", `Downloaded source hash mismatch: ${path}`);
  }
  await rename(partial, file);
  const receipt = { path, url, ...digest };
  await writeFile(`${file}.receipt.json`, JSON.stringify(receipt) + "\n", { mode: 0o600 });
  return receipt;
}
async function ubuntuSource(cache: string, name: string, version: string): Promise<SourceFile[]> {
  if (!/^[a-z0-9][a-z0-9+.-]*$/u.test(name) || !/^[A-Za-z0-9+:.~_-]+$/u.test(version))
    throw new SourceBundleError("SOURCE_METADATA_INVALID", "Invalid Ubuntu source identity");
  const directory = `ubuntu/${name}/${version.replace(/:/gu, "_")}`;
  const receiptPath = join(cache, directory, "source-files.json");
  let urls: string[];
  try {
    urls = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const query = new URL("https://api.launchpad.net/1.0/ubuntu/+archive/primary");
    query.search = new URLSearchParams({
      "ws.op": "getPublishedSources",
      source_name: name,
      version,
      exact_match: "true",
    }).toString();
    const response = await json(query.href);
    if (
      !response ||
      typeof response !== "object" ||
      !("entries" in response) ||
      !Array.isArray(response.entries)
    )
      throw new SourceBundleError("SOURCE_METADATA_INVALID", "Invalid Ubuntu publication metadata");
    const entries = response.entries.filter(
      (
        entry: unknown,
      ): entry is {
        source_package_name: string;
        source_package_version: string;
        self_link: string;
      } =>
        Boolean(
          entry &&
            typeof entry === "object" &&
            "source_package_name" in entry &&
            "source_package_version" in entry &&
            "self_link" in entry &&
            typeof entry.source_package_name === "string" &&
            typeof entry.source_package_version === "string" &&
            typeof entry.self_link === "string",
        ),
    );
    const result = { entries };
    const publication = result.entries.find(
      (entry) => entry.source_package_name === name && entry.source_package_version === version,
    );
    if (!publication)
      throw new SourceBundleError(
        "SOURCE_UNAVAILABLE",
        `Exact Ubuntu source publication unavailable: ${name}@${version}`,
      );
    if (
      !publication.self_link.startsWith(
        "https://api.launchpad.net/1.0/ubuntu/+archive/primary/+sourcepub/",
      )
    )
      throw new SourceBundleError(
        "SOURCE_METADATA_INVALID",
        "Foreign Ubuntu source publication URL",
      );
    const list = await json(`${publication.self_link}?ws.op=sourceFileUrls`);
    if (
      !Array.isArray(list) ||
      list.some(
        (url: unknown) => typeof url !== "string" || new URL(url).hostname !== "launchpad.net",
      )
    )
      throw new SourceBundleError("SOURCE_METADATA_INVALID", "Invalid Ubuntu source URL list");
    urls = list as string[];
    await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
    await writeFile(receiptPath, JSON.stringify(urls) + "\n", { flag: "wx", mode: 0o600 });
  }
  if (
    !Array.isArray(urls) ||
    urls.some(
      (url) =>
        typeof url !== "string" ||
        new URL(url).protocol !== "https:" ||
        new URL(url).hostname !== "launchpad.net",
    )
  )
    throw new SourceBundleError("SOURCE_METADATA_INVALID", "Invalid cached Ubuntu source URLs");
  const dscUrl = urls.find((url) => url.endsWith(".dsc"));
  if (!dscUrl)
    throw new SourceBundleError(
      "SOURCE_METADATA_INVALID",
      "Ubuntu publication lacks source descriptor",
    );
  const dsc = await downloadSource(
    cache,
    `${directory}/${new URL(dscUrl).pathname.split("/").at(-1)!}`,
    dscUrl,
  );
  const metadata = parseDsc(await readFile(join(cache, dsc.path), "utf8"));
  if (metadata.name !== name || metadata.version !== version)
    throw new SourceBundleError(
      "SOURCE_METADATA_INVALID",
      "Ubuntu source descriptor identity differs from installed image",
    );
  const files = [dsc];
  for (const entry of metadata.files) {
    const url = urls.find(
      (url) => decodeURIComponent(new URL(url).pathname.split("/").at(-1)!) === entry.name,
    );
    if (!url)
      throw new SourceBundleError(
        "SOURCE_UNAVAILABLE",
        `Publication missing checksummed source file: ${entry.name}`,
      );
    files.push(await downloadSource(cache, `${directory}/${entry.name}`, url, entry));
  }
  return files;
}
export async function verifySourcesIndex(
  cache: string,
  index: SourcesIndex,
  auditBytes: Buffer,
): Promise<void> {
  if (
    !index ||
    typeof index !== "object" ||
    !Array.isArray(index.files) ||
    !Array.isArray(index.residuals) ||
    !index.coverage ||
    typeof index.coverage !== "object" ||
    !index.archive ||
    !Array.isArray(index.archive.parts) ||
    typeof index.archive.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(index.archive.sha256) ||
    !Number.isSafeInteger(index.archive.size) ||
    index.archive.size < 1
  )
    throw new SourceBundleError("SOURCE_METADATA_INVALID", "Invalid corresponding-source index");
  const audit = auditDocument(JSON.parse(auditBytes.toString()));
  if (
    index.schemaVersion !== "1.0.0" ||
    index.auditHash !== sha256(auditBytes) ||
    index.residuals.length
  )
    throw new SourceBundleError(
      "SOURCE_INDEX_INCOMPLETE",
      "Source index does not cover this exact audit without residuals",
    );
  const paths = new Set<string>();
  for (const file of index.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      typeof file.url !== "string" ||
      !/^[a-f0-9]{64}$/u.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1
    )
      throw new SourceBundleError("SOURCE_METADATA_INVALID", "Invalid source file digest");
    safeArchivePath(file.path);
    if (paths.has(file.path))
      throw new SourceBundleError("SOURCE_METADATA_INVALID", "Duplicate bundled source path");
    paths.add(file.path);
    const stat = await lstat(join(cache, file.path));
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new SourceBundleError(
        "SOURCE_METADATA_INVALID",
        "Source bundle entry must be regular file",
      );
    const digest = await digestFile(join(cache, file.path));
    if (digest.sha256 !== file.sha256 || digest.size !== file.size)
      throw new SourceBundleError("SOURCE_HASH_MISMATCH", "Bundled source differs from index");
  }
  if (
    index.sourceTree &&
    (!paths.has(index.sourceTree.path) ||
      index.sourceTree.url !== `git:${index.sourceCommit}` ||
      !index.files.some(
        (file) =>
          file.path === index.sourceTree!.path &&
          file.sha256 === index.sourceTree!.sha256 &&
          file.size === index.sourceTree!.size,
      ))
  )
    throw new SourceBundleError(
      "SOURCE_INDEX_INCOMPLETE",
      "Committed source tree digest not covered by source index",
    );
  for (const item of audit.obligations) {
    if (
      !item.blockedReason &&
      item.notices.length &&
      !/GPL|LGPL|MPL|EPL|CDDL|CPL/iu.test(item.license)
    )
      continue;
    const coverage = index.coverage[item.component];
    if (
      !Array.isArray(coverage) ||
      !coverage.length ||
      coverage.some((path) => typeof path !== "string" || !paths.has(path))
    )
      throw new SourceBundleError(
        "SOURCE_INDEX_INCOMPLETE",
        `Missing source/notice coverage: ${item.component}`,
      );
  }
  if (
    index.archive.parts.some((part) => part.size < 1 || part.size > MAX_PART_SIZE) ||
    index.archive.parts.reduce((sum, part) => sum + part.size, 0) !== index.archive.size
  )
    throw new SourceBundleError("SOURCE_INDEX_INCOMPLETE", "Source archive parts incomplete");
}
export async function buildSources(
  auditPath: string,
  cacheOverride?: string,
  sourceCommitOverride?: string,
): Promise<{ cache: string; index: SourcesIndex }> {
  const bytes = await readFile(auditPath);
  const auditHash = sha256(bytes);
  const audit = auditDocument(JSON.parse(bytes.toString()));
  const bom = bomDocument(
    JSON.parse(await readFile(join(dirname(auditPath), "sbom.cdx.json"), "utf8")),
  );
  const cache = resolve(
    cacheOverride ?? join(homedir(), ".cache/testmaster-release-sources", auditHash),
  );
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const files: SourceFile[] = [];
  await writeFile(join(cache, "audit-obligations.json"), bytes, { mode: 0o600 });
  files.push({
    path: "audit-obligations.json",
    url: `audit:sha256:${auditHash}`,
    sha256: auditHash,
    size: bytes.length,
  });
  const coverage: Record<string, string[]> = {};
  const residuals: SourceResidual[] = [];
  const unique = new Map<string, { name: string; version: string; components: string[] }>();
  for (const component of bom.components) {
    const props = Object.fromEntries(
      component.properties.map((p: { name: string; value: string }) => [p.name, p.value]),
    );
    if (props.ecosystem !== "deb") continue;
    const name = props.sourcePackage;
    const version = props.sourceVersion;
    if (!name || !version)
      throw new SourceBundleError(
        "SOURCE_METADATA_INVALID",
        "Debian component lacks source identity",
      );
    if (name === "nodejs" && /nodesource/u.test(version)) continue;
    const key = `${name}@${version}`;
    const item = unique.get(key) ?? { name, version, components: [] as string[] };
    item.components.push(component["bom-ref"]);
    unique.set(key, item);
  }
  const queue = [...unique.values()];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        try {
          const downloaded = await ubuntuSource(cache, item.name, item.version);
          files.push(...downloaded);
          for (const component of item.components)
            coverage[component] = downloaded.map((file) => file.path);
        } catch (error) {
          for (const component of item.components)
            residuals.push({
              component,
              code: error instanceof SourceBundleError ? error.code : "SOURCE_UNAVAILABLE",
              detail: error instanceof Error ? error.message : "Source acquisition failed",
            });
        }
        await writeFile(
          join(cache, `ubuntu-acquisition-${sha256(`${item.name}@${item.version}`)}.json`),
          JSON.stringify({
            source: item.name,
            version: item.version,
            files: files.filter((file) =>
              file.path.startsWith(`ubuntu/${item.name}/${item.version.replace(/:/gu, "_")}/`),
            ),
            residuals: residuals.filter((residual) => item.components.includes(residual.component)),
          }) + "\n",
          { mode: 0o600 },
        );
        await writeFile(
          join(cache, "progress.json"),
          JSON.stringify({
            sourcePackagesCompleted: Object.keys(coverage).length,
            sourcePackagesRemaining: queue.length,
            residuals: residuals.length,
          }) + "\n",
          { mode: 0o600 },
        );
      }
    }),
  );
  for (const acquired of await Promise.all([
    acquireBrowserSources(audit, cache),
    acquirePythonSources(audit, cache),
  ])) {
    files.push(...acquired.files);
    Object.assign(coverage, acquired.coverage);
    residuals.push(...acquired.residuals);
  }
  const nodeComponent = audit.obligations.find((item) =>
    item.component.startsWith("application:node@"),
  );
  if (nodeComponent && coverage[nodeComponent.component]?.length) {
    for (const component of bom.components.filter((item) =>
      item["bom-ref"].startsWith("library:nodejs@"),
    )) {
      const props = Object.fromEntries(component.properties.map((p) => [p.name, p.value]));
      if (props.sourcePackage === "nodejs" && /nodesource/u.test(props.sourceVersion ?? ""))
        coverage[component["bom-ref"]] = [...coverage[nodeComponent.component]!];
    }
  }
  const root = resolve(new URL("../../../", import.meta.url).pathname);
  const { stdout } = await exec("git", ["rev-parse", sourceCommitOverride ?? "HEAD"], {
    cwd: root,
  });
  const sourceCommit = stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit))
    throw new SourceBundleError("SOURCE_METADATA_INVALID", "Invalid TestMaster source commit");
  const sourcePath = `testmaster-source-${sourceCommit}.tar`;
  await exec(
    "git",
    [
      "archive",
      "--format=tar",
      `--output=${join(cache, sourcePath)}`,
      sourceCommit,
      "containers/ffmpeg",
      "python",
      "LICENSE",
      "NOTICE",
    ],
    { cwd: root },
  );
  const sourceTree: SourceFile = {
    path: sourcePath,
    url: `git:${sourceCommit}`,
    ...(await digestFile(join(cache, sourcePath))),
  };
  files.push(sourceTree);
  for (const obligation of audit.obligations.filter((item) =>
    item.component.startsWith("application:ffmpeg-"),
  ))
    if (coverage[obligation.component]) coverage[obligation.component]!.push(sourcePath);
  for (const obligation of audit.obligations.filter((item) =>
    item.component.startsWith("library:testmaster-runner@"),
  ))
    if (!residuals.some((item) => item.component === obligation.component))
      coverage[obligation.component] = [sourcePath];
  for (const obligation of audit.obligations) {
    if (obligation.component.startsWith("container:")) continue;
    const bound = coverage[obligation.component];
    if (bound) bound.push("audit-obligations.json");
    else if (
      obligation.blockedReason ||
      !obligation.notices.length ||
      /GPL|LGPL|MPL|EPL|CDDL|CPL/iu.test(obligation.license)
    )
      if (!residuals.some((item) => item.component === obligation.component))
        residuals.push({
          component: obligation.component,
          code: "SOURCE_INDEX_INCOMPLETE",
          detail: "No verified corresponding-source/notice acquisition covers this obligation",
        });
  }
  const uniqueFiles = [...new Map(files.map((file) => [file.path, file])).values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  const archivePath = join(cache, "sources.tar.gz");
  await rm(archivePath, { force: true });
  const archive = await writeDeterministicArchive(
    cache,
    uniqueFiles.filter((file) => file.path !== sourceTree.path).map((file) => file.path),
    archivePath,
  );
  // Split uses exclusive paths: a completed prior bundle is retained instead of overwritten.
  const partPrefix = join(cache, `sources-${archive.sha256}.tar.gz.part-`);
  let parts: ({ path: string } & ArchiveDigest)[];
  try {
    await lstat(`${partPrefix}0000`);
    parts = [];
    for (let n = 0; ; n++) {
      const path = `${partPrefix}${String(n).padStart(4, "0")}`;
      try {
        parts.push({ path: path.slice(cache.length + 1), ...(await digestFile(path)) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        break;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    parts = (await splitArchive(archivePath, partPrefix, MAX_PART_SIZE)).map((part, n) => ({
      path: `sources-${archive.sha256}.tar.gz.part-${String(n).padStart(4, "0")}`,
      ...part,
    }));
  }
  for (const component of audit.obligations.filter((o) => o.component.startsWith("container:"))) {
    if (!residuals.length) coverage[component.component] = uniqueFiles.map((file) => file.path);
    else
      residuals.push({
        component: component.component,
        code: "SOURCE_INDEX_INCOMPLETE",
        detail: "Image has unresolved source/notice components",
      });
  }
  const index: SourcesIndex = {
    schemaVersion: "1.0.0",
    auditHash,
    sourceCommit,
    sourceTree,
    files: uniqueFiles,
    coverage,
    residuals,
    archive: { ...archive, parts },
  };
  await writeFile(join(cache, "sources-index.json"), JSON.stringify(index, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      cache,
      files: index.files.length,
      bytes: index.files.reduce((sum, file) => sum + file.size, 0),
      parts: parts.length,
      residuals: index.residuals.length,
    }),
  );
  return { cache, index };
}
export async function rebindSources(
  auditPath: string,
  cache: string,
  sourceCommit: string,
): Promise<SourcesIndex> {
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit))
    throw new SourceBundleError("SOURCE_METADATA_INVALID", "Source commit requires full SHA");
  const bytes = await readFile(auditPath);
  const index = JSON.parse(
    await readFile(join(cache, "sources-index.json"), "utf8"),
  ) as SourcesIndex;
  if (index.auditHash !== sha256(bytes) || !index.sourceTree)
    throw new SourceBundleError(
      "SOURCE_INDEX_INCOMPLETE",
      "Source index audit/tree binding unavailable for cheap rebind",
    );
  const root = resolve(new URL("../../../", import.meta.url).pathname);
  const path = `testmaster-source-${sourceCommit}.tar`;
  await exec(
    "git",
    [
      "archive",
      "--format=tar",
      `--output=${join(cache, path)}`,
      sourceCommit,
      "containers/ffmpeg",
      "python",
      "LICENSE",
      "NOTICE",
    ],
    { cwd: root },
  );
  const sourceTree = { path, url: `git:${sourceCommit}`, ...(await digestFile(join(cache, path))) };
  const old = index.sourceTree.path;
  index.files = index.files.filter((file) => file.path !== old);
  index.files.push(sourceTree);
  for (const component of Object.keys(index.coverage))
    index.coverage[component] = index.coverage[component]!.map((file) =>
      file === old ? path : file,
    );
  index.sourceTree = sourceTree;
  index.sourceCommit = sourceCommit;
  await writeFile(join(cache, "sources-index.json"), JSON.stringify(index, null, 2) + "\n", {
    mode: 0o600,
  });
  return index;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const auditPath = args.shift();
  let cache: string | undefined;
  let sourceCommit: string | undefined;
  const rebind = args.at(-1) === "--rebind";
  if (rebind) args.pop();
  for (let n = 0; n < args.length; n += 2) {
    const value = args[n + 1];
    if (!value || !["--cache", "--source-commit"].includes(args[n]!))
      throw new Error("Usage: sources.js AUDIT_JSON [--cache DIR] [--source-commit SHA]");
    if (args[n] === "--cache") cache = value;
    else if (/^[a-f0-9]{40}$/u.test(value)) sourceCommit = value;
    else throw new Error("Source commit requires full lowercase SHA");
  }
  if (!auditPath)
    throw new Error("Usage: sources.js AUDIT_JSON [--cache DIR] [--source-commit SHA]");
  if (rebind) {
    if (!cache || !sourceCommit) throw new Error("Rebind requires --cache and --source-commit");
    const index = await rebindSources(resolve(auditPath), resolve(cache), sourceCommit);
    console.log(
      JSON.stringify({
        cache,
        files: index.files.length,
        parts: index.archive.parts.length,
        residuals: index.residuals.length,
      }),
    );
    if (index.residuals.length) process.exitCode = 1;
  } else {
    const result = await buildSources(resolve(auditPath), cache, sourceCommit);
    if (result.index.residuals.length) process.exitCode = 1;
  }
}
