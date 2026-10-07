import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const PLAYWRIGHT = "1b025d7e20a026371cd5f98ba0cdce48892737c8";
const CHROMIUM = "971a7443b0c9b0a9b2860529b33331b76077ec62";
const FIREFOX = "d065a04bc5610f496762935dee56604a78b91b51";
const WEBKIT = "4d05d732e5a84f32675bef4cc135a2e7a9269a87";
const CHROMIUM_FFMPEG = "53fa34a23be9054d25ac2500dbdae9a0e570bb5c";
const HISTORICAL_PLAYWRIGHT = "a07a4a25a26e2fa6a976fb2ff174f25b24414da6";
interface SourceFile {
  path: string;
  url: string;
  sha256: string;
  size: number;
}
interface Residual {
  component: string;
  code: string;
  detail: string;
}

interface FfmpegBuild {
  schemaVersion: "1.0.0";
  component: "ffmpeg";
  recipe: "containers/ffmpeg/build.sh";
  buildBase: string;
  sources: {
    name: string;
    version: string;
    license: string;
    url: string;
    sha256: string;
    signature?: string;
  }[];
}
function isFfmpegBuild(value: unknown): value is FfmpegBuild {
  if (
    !value ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== "1.0.0" ||
    !("component" in value) ||
    value.component !== "ffmpeg" ||
    !("recipe" in value) ||
    value.recipe !== "containers/ffmpeg/build.sh" ||
    !("buildBase" in value) ||
    typeof value.buildBase !== "string" ||
    !/@sha256:[a-f0-9]{64}$/u.test(value.buildBase) ||
    !("sources" in value) ||
    !Array.isArray(value.sources) ||
    value.sources.length !== 3
  )
    return false;
  return (
    value.sources.every(
      (source: unknown) =>
        source &&
        typeof source === "object" &&
        "name" in source &&
        typeof source.name === "string" &&
        ["ffmpeg", "libvpx", "zlib"].includes(source.name) &&
        "version" in source &&
        typeof source.version === "string" &&
        /^[A-Za-z0-9_.-]+$/u.test(source.version) &&
        "license" in source &&
        typeof source.license === "string" &&
        "url" in source &&
        typeof source.url === "string" &&
        /^https:\/\//u.test(source.url) &&
        "sha256" in source &&
        typeof source.sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(source.sha256) &&
        (!("signature" in source) ||
          (typeof source.signature === "string" && /^https:\/\//u.test(source.signature))),
    ) && new Set(value.sources.map((source: { name: string }) => source.name)).size === 3
  );
}
async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest("hex"), size };
}
/** Acquire immutable upstream materials. Coverage records acquired bytes, not legal certification. */
export async function acquireBrowserSources(
  audit: unknown,
  cache: string,
): Promise<{
  files: SourceFile[];
  coverage: Record<string, string[]>;
  residuals: Residual[];
}> {
  const root = resolve(cache);
  if (root === process.cwd() || root.startsWith(`${resolve(process.cwd())}${sep}`))
    throw new Error("Browser source cache must be outside the repository");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const files = new Map<string, SourceFile>();
  const pending = new Map<string, Promise<SourceFile>>();
  const coverage: Record<string, string[]> = {};
  const residuals: Residual[] = [];
  const raw = (repo: string, commit: string, path: string) =>
    `https://raw.githubusercontent.com/${repo}/${commit}/${path}`;
  const archive = (repo: string, commit: string) =>
    `https://codeload.github.com/${repo}/tar.gz/${commit}`;

  function download(path: string, url: string, expected?: string): Promise<SourceFile> {
    const existing = pending.get(path);
    if (existing) return existing;
    const task = (async () => {
      if (
        resolve(root, path) !== join(root, path) ||
        path.startsWith("/") ||
        path.split("/").includes("..")
      )
        throw new Error("Invalid source cache path");
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      try {
        const stored: unknown = JSON.parse(await readFile(`${target}.verified.json`, "utf8"));
        const actual = await hashFile(target);
        if (
          stored &&
          typeof stored === "object" &&
          "url" in stored &&
          "sha256" in stored &&
          "size" in stored &&
          stored.url === url &&
          stored.sha256 === actual.sha256 &&
          stored.size === actual.size &&
          (!expected || actual.sha256 === expected)
        ) {
          const result = { path, url, ...actual };
          files.set(path, result);
          return result;
        }
      } catch {
        /* Only verified complete bytes are cache hits; partial downloads resume below. */
      }
      await rm(target, { force: true });
      const partial = `${target}.part`;
      try {
        await exec(
          "curl",
          [
            "--fail",
            "--location",
            "--retry",
            "3",
            "--retry-delay",
            "1",
            "--connect-timeout",
            "30",
            "--max-time",
            "1800",
            "--continue-at",
            "-",
            "--output",
            partial,
            url,
          ],
          { maxBuffer: 1024 * 1024 },
        );
      } catch (error) {
        // GitHub's generated archives do not always support byte ranges. Restart only that case.
        if (!(error instanceof Error) || !/range|resume|416/iu.test(error.message)) throw error;
        await rm(partial, { force: true });
        await exec(
          "curl",
          [
            "--fail",
            "--location",
            "--retry",
            "3",
            "--connect-timeout",
            "30",
            "--max-time",
            "1800",
            "--output",
            partial,
            url,
          ],
          { maxBuffer: 1024 * 1024 },
        );
      }
      const actual = await hashFile(partial);
      if (!actual.size || (expected && actual.sha256 !== expected)) {
        await rm(partial, { force: true });
        throw new Error(
          `SHA256 verification failed for ${url}; expected ${expected ?? "nonempty bytes"}, received ${actual.sha256}`,
        );
      }
      await rename(partial, target);
      const result = { path, url, ...actual };
      await writeFile(`${target}.verified.json`, JSON.stringify(result) + "\n", { mode: 0o600 });
      files.set(path, result);
      return result;
    })();
    pending.set(path, task);
    return task;
  }
  async function derived(path: string, url: string, bytes: Buffer): Promise<SourceFile> {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600 });
    const result = { path, url, ...(await hashFile(target)) };
    files.set(path, result);
    return result;
  }
  async function obtain(
    component: string,
    path: string,
    url: string,
    expected?: string,
  ): Promise<SourceFile | undefined> {
    try {
      const file = await download(path, url, expected);
      if (!coverage[component]!.includes(file.path)) coverage[component]!.push(file.path);
      return file;
    } catch (error) {
      residuals.push({
        component,
        code: "SOURCE_ACQUISITION_FAILED",
        detail: `${url}: ${error instanceof Error ? error.message.replaceAll(root + sep, "") : String(error)}`,
      });
      return undefined;
    }
  }
  async function extract(
    component: string,
    source: SourceFile | undefined,
    member: string,
    path: string,
    zip = false,
  ) {
    if (!source) return;
    try {
      const { stdout } = await exec(
        zip ? "unzip" : "tar",
        zip ? ["-p", join(root, source.path), member] : ["-xOf", join(root, source.path), member],
        { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
      );
      const file = await derived(path, `${source.url}#${member}`, stdout);
      coverage[component]!.push(file.path);
    } catch (error) {
      residuals.push({
        component,
        code: "NOTICE_EXTRACTION_FAILED",
        detail: `${source.url}#${member}: ${error instanceof Error ? error.message.replaceAll(root + sep, "") : String(error)}`,
      });
    }
  }
  const obligations =
    audit && typeof audit === "object" && "obligations" in audit && Array.isArray(audit.obligations)
      ? audit.obligations
      : [];
  // A material shared across image components is fetched and hashed once.
  for (const obligation of obligations) {
    if (
      !obligation ||
      typeof obligation !== "object" ||
      !("component" in obligation) ||
      typeof obligation.component !== "string"
    )
      continue;
    const component = obligation.component;
    const matchedBrowser = /(?:chromium|firefox|webkit|ffmpeg)/iu
      .exec(component)?.[0]
      .toLowerCase();
    const browser =
      matchedBrowser === "chromium" ||
      matchedBrowser === "firefox" ||
      matchedBrowser === "webkit" ||
      matchedBrowser === "ffmpeg"
        ? matchedBrowser
        : undefined;
    if (!browser && !component.includes("application:node@")) continue;
    coverage[component] = [];
    if (browser === "ffmpeg") {
      const evidence =
        audit &&
        typeof audit === "object" &&
        "imageEvidence" in audit &&
        audit.imageEvidence &&
        typeof audit.imageEvidence === "object"
          ? Object.values(audit.imageEvidence)
          : [];
      const browserRows: unknown[] = evidence.flatMap((image: unknown) =>
        image && typeof image === "object" && "browsers" in image && Array.isArray(image.browsers)
          ? image.browsers
          : [],
      );
      const candidates = browserRows.filter((row): row is { name: string; ffmpegBuild: unknown } =>
        Boolean(
          row &&
            typeof row === "object" &&
            "name" in row &&
            row.name === "ffmpeg-1011" &&
            "ffmpegBuild" in row,
        ),
      );
      if (candidates.some((row) => row.ffmpegBuild)) {
        if (
          !candidates.every((row) => isFfmpegBuild(row.ffmpegBuild)) ||
          new Set(candidates.map((row) => JSON.stringify(row.ffmpegBuild))).size !== 1
        ) {
          residuals.push({
            component,
            code: "INVALID_FFMPEG_BUILD_PROVENANCE",
            detail:
              "Authored FFmpeg source provenance is invalid or differs between audited images",
          });
          continue;
        }
        const build = candidates[0]!.ffmpegBuild;
        if (!isFfmpegBuild(build)) throw new Error("Invalid FFmpeg provenance boundary");
        const provenance = await derived(
          "browser/ffmpeg-testmaster/TESTMASTER_FFMPEG_BUILD.json",
          "audit:imageEvidence/browsers/ffmpegBuild",
          Buffer.from(JSON.stringify(build, null, 2) + "\n"),
        );
        coverage[component]!.push(provenance.path);
        for (const source of build.sources) {
          try {
            const filename = new URL(source.url).pathname.split("/").at(-1)!;
            if (!/^[A-Za-z0-9_.-]+$/u.test(filename))
              throw new Error("Source URL filename is not safe");
            await obtain(
              component,
              `browser/ffmpeg-testmaster/${source.name}-${source.version}/${filename}`,
              source.url,
              source.sha256,
            );
            if (source.signature)
              await obtain(
                component,
                `browser/ffmpeg-testmaster/${source.name}-${source.version}/${filename}.asc`,
                source.signature,
              );
          } catch (error) {
            residuals.push({
              component,
              code: "INVALID_FFMPEG_BUILD_PROVENANCE",
              detail: `${source.name}: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
        // The caller bundles the exact commit-bound recipe/provenance with its source tree.
        const materials = await derived(
          "browser/ffmpeg-testmaster/material-evidence.json",
          "audit:imageEvidence/browsers/ffmpegBuild",
          Buffer.from(
            JSON.stringify(
              {
                scope: "Authored FFmpeg corresponding-source inputs",
                recipe: build.recipe,
                recipeBinding:
                  "Caller must retain this recipe and provenance in the exact release source commit",
                limitations: [
                  "Detached signatures are retained, not cryptographically authenticated by this helper",
                  "This source acquisition does not certify universal binary-license or LGPL relinking compliance",
                ],
              },
              null,
              2,
            ) + "\n",
          ),
        );
        coverage[component]!.push(materials.path);
        continue;
      }
    }
    if (!browser) {
      const version = /application:node@v?([^:]+)/u.exec(component)?.[1];
      if (version !== "24.20.0") {
        residuals.push({
          component,
          code: "UNSUPPORTED_NODE_IDENTITY",
          detail: `Audited Node version ${version ?? "missing"} is not the pinned v24.20.0`,
        });
        continue;
      }
      const base = "https://nodejs.org/dist/v24.20.0";
      const sums = await obtain(
        component,
        "browser/node-v24.20.0/SHASUMS256.txt",
        `${base}/SHASUMS256.txt`,
      );
      if (!sums) continue;
      const text = await readFile(join(root, sums.path), "utf8");
      for (const name of ["node-v24.20.0.tar.xz", "node-v24.20.0-linux-x64.tar.xz"]) {
        const sha = text
          .split("\n")
          .map((line) => line.trim().split(/\s+/u))
          .find((row) => row[1] === name)?.[0];
        if (!sha || !/^[a-f0-9]{64}$/u.test(sha)) {
          residuals.push({
            component,
            code: "OFFICIAL_CHECKSUM_MISSING",
            detail: `${name} absent from official SHASUMS256.txt`,
          });
          continue;
        }
        const file = await obtain(
          component,
          `browser/node-v24.20.0/${name}`,
          `${base}/${name}`,
          sha,
        );
        if (name.includes("linux-x64"))
          await extract(
            component,
            file,
            "node-v24.20.0-linux-x64/LICENSE",
            "browser/node-v24.20.0/LICENSE.binary",
          );
      }
      continue;
    }
    const revision = /(?:chromium(?:[_-]headless[_-]shell)?|firefox|webkit|ffmpeg)-?(\d+)/iu.exec(
      component,
    )?.[1];
    const expected = { chromium: "1243", firefox: "1543", webkit: "2359", ffmpeg: "1011" }[browser];
    if (revision !== expected) {
      residuals.push({
        component,
        code: "UNSUPPORTED_BROWSER_IDENTITY",
        detail: `Audited ${browser} revision ${revision ?? "missing"} differs from pinned ${expected}`,
      });
      continue;
    }
    await obtain(
      component,
      `browser/playwright-${PLAYWRIGHT}.tar.gz`,
      archive("microsoft/playwright", PLAYWRIGHT),
    );
    await obtain(
      component,
      "browser/playwright-1.63.0/browsers.json",
      raw("microsoft/playwright", PLAYWRIGHT, "packages/playwright-core/browsers.json"),
    );
    if (browser === "firefox" || browser === "webkit") {
      const repo = browser === "firefox" ? "mozilla-firefox/firefox" : "WebKit/WebKit";
      const commit = browser === "firefox" ? FIREFOX : WEBKIT;
      if (browser === "webkit") {
        const gitDir = join(root, "browser/webkit-source.git");
        const path = `browser/webkit-${commit}.tar.gz`;
        try {
          const target = join(root, path);
          const receiptPath = `${target}.verified.json`;
          let complete = false;
          try {
            const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as SourceFile;
            const digest = await hashFile(target);
            if (
              receipt.url === `git:https://github.com/WebKit/WebKit.git#${commit}` &&
              receipt.sha256 === digest.sha256 &&
              receipt.size === digest.size
            ) {
              files.set(path, { path, url: receipt.url, ...digest });
              coverage[component]!.push(path);
              complete = true;
            }
          } catch {
            /* Exact commit archive is generated below. */
          }
          if (!complete) {
            await mkdir(gitDir, { recursive: true, mode: 0o700 });
            await exec("git", ["init", "--bare", gitDir]);
            await exec(
              "git",
              ["-C", gitDir, "fetch", "--depth=1", "https://github.com/WebKit/WebKit.git", commit],
              { timeout: 1800000, maxBuffer: 4 * 1024 * 1024 },
            );
            const { stdout } = await exec("git", ["-C", gitDir, "rev-parse", "FETCH_HEAD"]);
            if (stdout.trim() !== commit)
              throw new Error("WebKit fetched commit differs from pinned source");
            await exec(
              "git",
              [
                "-C",
                gitDir,
                "archive",
                "--format=tar.gz",
                `--prefix=WebKit-${commit}/`,
                `--output=${target}`,
                commit,
              ],
              { timeout: 1800000 },
            );
            const file = {
              path,
              url: `git:https://github.com/WebKit/WebKit.git#${commit}`,
              ...(await hashFile(target)),
            };
            await writeFile(receiptPath, JSON.stringify(file) + "\n", { mode: 0o600 });
            files.set(path, file);
            coverage[component]!.push(path);
          }
        } catch (error) {
          residuals.push({
            component,
            code: "SOURCE_ACQUISITION_FAILED",
            detail: `Exact WebKit git archive: ${error instanceof Error ? error.message.replaceAll(root + sep, "") : String(error)}`,
          });
        }
      } else await obtain(component, `browser/${browser}-${commit}.tar.gz`, archive(repo, commit));
      await obtain(
        component,
        `browser/playwright-1.63.0/${browser}-UPSTREAM_CONFIG.sh`,
        raw("microsoft/playwright", PLAYWRIGHT, `browser_patches/${browser}/UPSTREAM_CONFIG.sh`),
      );
      const notices =
        browser === "firefox"
          ? ["LICENSE", "toolkit/content/license.html"]
          : [
              "Source/WebCore/LICENSE-APPLE",
              "Source/WebCore/LICENSE-LGPL-2",
              "Source/WebCore/LICENSE-LGPL-2.1",
            ];
      for (const notice of notices)
        await obtain(component, `browser/${browser}-notices/${notice}`, raw(repo, commit, notice));
      const materials = await derived(
        `browser/${browser}-material-evidence.json`,
        `https://github.com/${repo}/tree/${commit}`,
        Buffer.from(
          JSON.stringify(
            {
              upstreamCommit: commit,
              playwrightCommit: PLAYWRIGHT,
              browserRevision: revision,
              patchTree: `playwright-${PLAYWRIGHT}/browser_patches/${browser}`,
              scope:
                "Exact covered upstream source, Playwright modifications and requested notices; coverage records successful acquisition only",
              limitations: [
                "Archive plus patches is not universal legal certification of every embedded or system dependency",
                "Complete binary-credit enumeration is outside this acquisition scope",
              ],
            },
            null,
            2,
          ) + "\n",
        ),
      );
      coverage[component]!.push(materials.path);
    } else if (browser === "chromium") {
      await obtain(
        component,
        `browser/chromium-${CHROMIUM}.tar.gz`,
        archive("chromium/chromium", CHROMIUM),
      );
      await obtain(
        component,
        "browser/chromium-153.0.8010.12/DEPS",
        raw("chromium/chromium", CHROMIUM, "DEPS"),
      );
      for (const notice of ["LICENSE", "AUTHORS"])
        await obtain(
          component,
          `browser/chromium-153.0.8010.12/${notice}`,
          raw("chromium/chromium", CHROMIUM, notice),
        );
      const headless = component.includes("headless");
      const binaryName = headless ? "chrome-headless-shell-linux64" : "chrome-linux64";
      const binary = await obtain(
        component,
        `browser/chromium-153.0.8010.12/${binaryName}.zip`,
        `https://cdn.playwright.dev/builds/cft/153.0.8010.12/linux64/${binaryName}.zip`,
      );
      const notice = headless ? "LICENSE.headless_shell" : "WidevineCdm/LICENSE";
      await extract(
        component,
        binary,
        `${binaryName}/${notice}`,
        `browser/chromium-153.0.8010.12/${binaryName}/${notice}`,
        true,
      );
      await obtain(
        component,
        `browser/chromium-ffmpeg-${CHROMIUM_FFMPEG}.tar.gz`,
        `https://chromium.googlesource.com/chromium/third_party/ffmpeg/+archive/${CHROMIUM_FFMPEG}.tar.gz`,
      );
      for (const notice of [
        "README.chromium",
        "CREDITS.chromium",
        "COPYING.LGPLv2.1",
        "LICENSE.md",
      ]) {
        const url = `https://chromium.googlesource.com/chromium/third_party/ffmpeg/+/${CHROMIUM_FFMPEG}/${notice}?format=TEXT`;
        const file = await obtain(component, `browser/chromium-ffmpeg/${notice}.base64`, url);
        if (file) {
          const decoded = await derived(
            `browser/chromium-ffmpeg/${notice}`,
            url,
            Buffer.from(await readFile(join(root, file.path), "utf8"), "base64"),
          );
          coverage[component]!.push(decoded.path);
        }
      }
      const materials = await derived(
        "browser/chromium-153.0.8010.12/material-evidence.json",
        `https://github.com/chromium/chromium/tree/${CHROMIUM}`,
        Buffer.from(
          JSON.stringify(
            {
              browserVersion: "153.0.8010.12",
              chromiumCommit: CHROMIUM,
              ffmpegCommit: CHROMIUM_FFMPEG,
              scope:
                "Exact Chromium FFmpeg covered source plus requested license/credit materials; coverage records successful acquisition only",
              limitations: [
                "Top-level Chromium archive excludes separately pinned DEPS checkouts",
                "Other permissive dependencies require applicable notices, not universal covered-source acquisition",
                "Binary-credit exhaustive enumeration and universal legal certification are not asserted",
              ],
            },
            null,
            2,
          ) + "\n",
        ),
      );
      if (!coverage[component]!.includes(materials.path)) coverage[component]!.push(materials.path);
    } else {
      const binary = await obtain(
        component,
        "browser/ffmpeg-1011/ffmpeg-linux.zip",
        "https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1011/ffmpeg-linux.zip",
      );
      await extract(
        component,
        binary,
        "COPYING.LGPLv2.1",
        "browser/ffmpeg-1011/COPYING.LGPLv2.1",
        true,
      );
      await obtain(
        component,
        "browser/ffmpeg-1011/ffmpeg-n7.0.1.tar.xz",
        "https://ffmpeg.org/releases/ffmpeg-7.0.1.tar.xz",
      );
      await obtain(
        component,
        "browser/ffmpeg-1011/ffmpeg-af25a4bfd2503caf3ee485b27b99b620302f5718.tar.gz",
        archive("FFmpeg/FFmpeg", "af25a4bfd2503caf3ee485b27b99b620302f5718"),
      );
      for (const notice of ["COPYING.LGPLv2.1", "LICENSE.md"])
        await obtain(
          component,
          `browser/ffmpeg-1011/upstream/${notice}`,
          raw("FFmpeg/FFmpeg", "af25a4bfd2503caf3ee485b27b99b620302f5718", notice),
        );
      // Last public historical recipe is build 1007 / n4.3.1, not an invented 1011 recipe.
      await obtain(
        component,
        `browser/playwright-historical-${HISTORICAL_PLAYWRIGHT}.tar.gz`,
        archive("microsoft/playwright", HISTORICAL_PLAYWRIGHT),
      );
      await obtain(
        component,
        "browser/ffmpeg-historical/CONFIG.sh",
        raw("microsoft/playwright", HISTORICAL_PLAYWRIGHT, "browser_patches/ffmpeg/CONFIG.sh"),
      );
      await obtain(
        component,
        "browser/ffmpeg-historical/BUILD_NUMBER",
        raw("microsoft/playwright", HISTORICAL_PLAYWRIGHT, "browser_patches/ffmpeg/BUILD_NUMBER"),
      );
      await obtain(
        component,
        "browser/ffmpeg-historical/build-linux.sh",
        raw("microsoft/playwright", HISTORICAL_PLAYWRIGHT, "browser_patches/ffmpeg/build-linux.sh"),
      );
      if (binary) {
        try {
          const { stdout } = await exec("unzip", ["-p", join(root, binary.path), "ffmpeg-linux"], {
            encoding: "buffer",
            maxBuffer: 16 * 1024 * 1024,
          });
          const strings = stdout.toString("latin1").match(/[\x20-\x7e]{15,}/gu) ?? [];
          const anchors = strings.filter(
            (line) => line.includes("playwright-build-1011") || line.includes("--enable-ffmpeg"),
          );
          const file = await derived(
            "browser/ffmpeg-1011/binary-version-build-strings.txt",
            `${binary.url}#ffmpeg-linux`,
            Buffer.from(anchors.join("\n") + "\n"),
          );
          coverage[component]!.push(file.path);
          if (!anchors.some((line) => line.includes("n7.0.1-playwright-build-1011")))
            residuals.push({
              component,
              code: "FFMPEG_BINARY_VERSION_UNVERIFIED",
              detail: "Downloaded build lacks expected n7.0.1-playwright-build-1011 version anchor",
            });
        } catch (error) {
          residuals.push({
            component,
            code: "FFMPEG_BINARY_VERSION_UNVERIFIED",
            detail:
              error instanceof Error ? error.message.replaceAll(root + sep, "") : String(error),
          });
        }
      }
      residuals.push({
        component,
        code: "FFMPEG_1011_BUILD_RECIPE_UNAVAILABLE",
        detail:
          "Build 1011 binary identifies n7.0.1; v1.63.0 has no FFmpeg build tree. Last public historical tree pins n4.3.1/build1007, so it is retained only as history, not corresponding build1011 source. Exact 1011 recipe, static libvpx/zlib pins and LGPL relinking materials remain unresolved",
      });
    }
  }
  return {
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    coverage,
    residuals,
  };
}
