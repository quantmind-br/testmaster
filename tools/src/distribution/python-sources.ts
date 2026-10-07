import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { ajv } from "@testmaster/contracts";
import { digestFile, safeArchivePath } from "./archive.js";

type SourceFile = { path: string; url: string; sha256: string; size: number };
type Residual = { component: string; code: string; detail: string };
interface AuditInput {
  obligations: { component: string }[];
  imageEvidence: Record<
    string,
    { python?: { name: string; version: string; license?: string; notices?: string[] }[] }
  >;
}
interface PythonRelease {
  info: { name: string; version: string };
  urls: {
    packagetype: string;
    filename: string;
    url: string;
    size: number;
    digests: { sha256: string };
  }[];
}
const validateAudit = ajv.compile<AuditInput>({
  type: "object",
  required: ["obligations", "imageEvidence"],
  properties: {
    obligations: {
      type: "array",
      items: {
        type: "object",
        required: ["component"],
        properties: { component: { type: "string" } },
      },
    },
    imageEvidence: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          python: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "version"],
              properties: {
                name: { type: "string", minLength: 1 },
                version: { type: "string", minLength: 1 },
                license: { type: "string" },
                notices: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
  },
});
const validateRelease = ajv.compile<PythonRelease>({
  type: "object",
  required: ["info", "urls"],
  properties: {
    info: {
      type: "object",
      required: ["name", "version"],
      properties: { name: { type: "string" }, version: { type: "string" } },
    },
    urls: {
      type: "array",
      items: {
        type: "object",
        required: ["packagetype", "filename", "url", "size", "digests"],
        properties: {
          packagetype: { type: "string" },
          filename: { type: "string" },
          url: { type: "string" },
          size: { type: "integer", minimum: 1 },
          digests: {
            type: "object",
            required: ["sha256"],
            properties: { sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } },
          },
        },
      },
    },
  },
});
const normalizeName = (name: string): string => name.toLowerCase().replace(/[-_.]+/gu, "-");
const README_URL = "https://raw.githubusercontent.com/jsumners/abstract-logging/v2.0.1/Readme.md";
const NOTICE_URL = "https://jsumners.mit-license.org/license.txt";
// Exact upstream notice snapshot; the site uses the current copyright year.
const NOTICE_SHA256 = "af15a41ce02371f77476b7a201e036c0ae6c5d6d2a233b4e5f0fd5fca123457e";

export async function acquirePythonSources(
  audit: unknown,
  cache: string,
): Promise<{ files: SourceFile[]; coverage: Record<string, string[]>; residuals: Residual[] }> {
  if (!validateAudit(audit))
    throw new Error(`Invalid distribution audit: ${ajv.errorsText(validateAudit.errors)}`);
  const files: SourceFile[] = [];
  const coverage: Record<string, string[]> = {};
  const residuals: Residual[] = [];
  async function acquire(
    path: string,
    url: string,
    expected?: { sha256: string; size?: number },
  ): Promise<SourceFile> {
    safeArchivePath(path);
    const target = join(cache, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if (expected) {
      try {
        const cached = await digestFile(target);
        if (
          cached.sha256 === expected.sha256 &&
          (expected.size === undefined || cached.size === expected.size)
        ) {
          const file = { path, url, ...cached };
          files.push(file);
          return file;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const response = await fetch(url, { redirect: "error" });
    if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
    const hash = createHash("sha256");
    let size = 0;
    const partial = `${target}.partial`;
    try {
      await pipeline(
        Readable.fromWeb(response.body as ReadableStream),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            size += chunk.length;
            callback(null, chunk);
          },
        }),
        createWriteStream(partial, { flags: "wx", mode: 0o600 }),
      );
      const sha256 = hash.digest("hex");
      if (
        expected &&
        (sha256 !== expected.sha256 || (expected.size !== undefined && size !== expected.size))
      ) {
        throw new Error(`Official source digest/size mismatch: ${url}`);
      }
      await rename(partial, target);
      const file = { path, url, sha256, size };
      files.push(file);
      return file;
    } finally {
      await rm(partial, { force: true });
    }
  }

  const packages = new Map<
    string,
    { name: string; version: string; components: Set<string>; licensedOriginal: boolean }
  >();
  for (const inventory of Object.values(audit.imageEvidence)) {
    for (const pkg of inventory.python ?? []) {
      const name = normalizeName(pkg.name);
      const matching = audit.obligations.filter((item) => {
        const identity = /^library:(.+)@([^:]+):\d+$/u.exec(item.component);
        return identity && normalizeName(identity[1]!) === name && identity[2] === pkg.version;
      });
      const key = `${name}@${pkg.version}`;
      const entry = packages.get(key) ?? {
        name,
        version: pkg.version,
        components: new Set<string>(),
        licensedOriginal: true,
      };
      entry.licensedOriginal &&= pkg.license === "Apache-2.0" && Boolean(pkg.notices?.length);
      for (const item of matching) entry.components.add(item.component);
      packages.set(key, entry);
    }
  }
  for (const pkg of packages.values()) {
    if (!pkg.components.size) continue;
    if (pkg.name === "testmaster-runner") {
      // The parent binds actual committed original source/license files, not a PyPI substitute.
      if (pkg.licensedOriginal) continue;
      for (const component of pkg.components)
        residuals.push({
          component,
          code: "HISTORICAL_PYTHON_LICENSE_METADATA",
          detail:
            "At least one locked image runner distribution lacks Apache-2.0 metadata or installed notices. Historical images predating the source cutover retain UNKNOWN metadata/no notices. Bundle the actual matching original repository source with root and Python licenses separately; current source licensing does not change old image metadata.",
        });
      continue;
    }
    try {
      const prefix = safeArchivePath(`python/${pkg.name}/${pkg.version}`);
      const metadata = await acquire(
        `${prefix}/pypi.json`,
        `https://pypi.org/pypi/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}/json`,
      );
      const release: unknown = JSON.parse(await readFile(join(cache, metadata.path), "utf8"));
      if (!validateRelease(release))
        throw new Error(`Invalid PyPI release metadata: ${ajv.errorsText(validateRelease.errors)}`);
      if (normalizeName(release.info.name) !== pkg.name || release.info.version !== pkg.version) {
        throw new Error("PyPI release identity differs from the locked image distribution");
      }
      const sdists = release.urls.filter((file) => file.packagetype === "sdist");
      if (!sdists.length)
        throw new Error(
          "Exact PyPI release has no source distribution; a wheel is not corresponding source",
        );
      const paths = [metadata.path];
      for (const source of sdists) {
        const url = new URL(source.url);
        if (
          url.protocol !== "https:" ||
          url.hostname !== "files.pythonhosted.org" ||
          !Number.isSafeInteger(source.size) ||
          source.filename.includes("/")
        ) {
          throw new Error("PyPI source URL, filename, official SHA256 or size is invalid");
        }
        const file = await acquire(`${prefix}/${source.filename}`, source.url, {
          sha256: source.digests.sha256,
          size: source.size,
        });
        paths.push(file.path);
      }
      for (const component of pkg.components) coverage[component] = paths;
    } catch (error) {
      for (const component of pkg.components)
        residuals.push({ component, code: "PYTHON_SOURCE_UNAVAILABLE", detail: String(error) });
    }
  }

  const logging = audit.obligations.filter((item) =>
    /^library:abstract-logging@2\.0\.1:\d+$/u.test(item.component),
  );
  if (logging.length) {
    try {
      const readme = await acquire("notices/abstract-logging/2.0.1/Readme.md", README_URL);
      const text = await readFile(join(cache, readme.path), "utf8");
      if (!text.includes("[MIT License](http://jsumners.mit-license.org/)"))
        throw new Error("Tagged upstream README no longer establishes the MIT notice reference");
      const notice = await acquire("notices/abstract-logging/2.0.1/LICENSE.txt", NOTICE_URL, {
        sha256: NOTICE_SHA256,
      });
      for (const item of logging) coverage[item.component] = [readme.path, notice.path];
    } catch (error) {
      for (const item of logging)
        residuals.push({
          component: item.component,
          code: "UPSTREAM_NOTICE_UNAVAILABLE",
          detail: String(error),
        });
    }
  }
  return { files, coverage, residuals };
}
