import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ContractError } from "@testmaster/contracts";
import { dataDirectoryPrefixes, insideDataDirectory } from "./data-directory.js";
import {
  assessDiffImpact,
  collectDiffChanges,
  expandReverseImports,
  gitInvocation,
  readOnlyGit,
  touchesAuthOrShared,
} from "./diff.js";
import {
  analyzableCodeType,
  CODE_SUMMARY_DEFAULT_LIMITS,
  computeManifestHash,
  createPathAdmission,
  summarizeCode,
} from "./summary.js";
import type { CodeDiff, CodeRef, CodeSummary, CodeSummaryOptions } from "./types.js";

const MAX_LISTING_BYTES = 256 * 1024 * 1024;
const SCAN_CHUNK_FILES = 200;
const SCAN_CHUNK_BYTES = 16 * 1024 * 1024;
const GREP_PATTERNS_PER_CALL = 100;
const MAX_IGNORE_FILE_BYTES = 1024 * 1024;
const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?|html)$/iu;
const CRITICAL_TEST = /(?:critical|smoke)/iu;
const LIMIT_REASONS = ["file_count_limit", "total_byte_limit", "oversize"];

export interface DiffScopeOptions {
  repoRoot: string;
  base: string;
  head?: string;
  /** Analyze the working tree (tracked changes and untracked files) instead of the pinned head. */
  workingTree?: boolean;
  /** Project data directory; never read. */
  dataDir?: string;
  /** Limits and rules of the summary. `only` is decided here. */
  summary: Omit<CodeSummaryOptions, "only">;
  /** Private directory under which a pinned head is staged. It is created when missing. */
  stagingDir: string;
}

interface TreeEntry {
  oid: string;
  size: number;
}
interface Skipped {
  path: string;
  reason: string;
}
/** The files a diff-scoped analysis may read, and how to put chosen ones where `summarizeCode` can. */
interface TreeSource {
  /** Directory `summarizeCode` reads; for a pinned head this is the staging directory. */
  root(): string;
  /** Regular files of the analyzed tree, repository-relative. */
  files: string[];
  /** Tree entries that cannot be analyzed (submodules, symlinks) and were never regular files. */
  unreadable: Skipped[];
  chunks(paths: readonly string[]): string[][];
  /** Makes the files readable under `root()`. Returns files it refused, with the reason. */
  stage(paths: readonly string[], enforceLimits: boolean): Promise<Skipped[]>;
  unstage(paths: readonly string[]): Promise<void>;
  /** Paths whose content matches every argument given to git grep (`-e` patterns). */
  grep(flags: string[], patterns: string[]): Promise<string[]>;
  dispose(): Promise<void>;
}

function closureError(exitCode: unknown): ContractError {
  return new ContractError(
    "PRECONDITION_FAILED",
    "The importer closure of the diff could not be computed because git grep failed; the analysis is refused instead of being narrowed silently.",
    { step: "importer_closure", exitCode: typeof exitCode === "number" ? exitCode : null },
  );
}
/** `git grep -l` as a path list. Exit status 1 means "no match"; anything else fails closed. */
async function grepPaths(root: string, args: string[], prefix: string): Promise<string[]> {
  let output: string;
  try {
    output = await readOnlyGit(root, ["grep", "-l", "-z", "-I", ...args], [], MAX_LISTING_BYTES);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === 1) return [];
    throw closureError(code);
  }
  return output
    .split("\0")
    .filter(Boolean)
    .map((path) => (prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path));
}
const patternArguments = (flags: string[], patterns: string[]): string[][] => {
  const calls: string[][] = [];
  for (let index = 0; index < patterns.length; index += GREP_PATTERNS_PER_CALL)
    calls.push([
      ...flags,
      ...patterns
        .slice(index, index + GREP_PATTERNS_PER_CALL)
        .flatMap((pattern) => ["-e", pattern]),
    ]);
  return calls;
};

async function worktreeSource(root: string, dataDir: string | undefined): Promise<TreeSource> {
  const prefixes = dataDirectoryPrefixes(root, dataDir);
  const listed = await readOnlyGit(
    root,
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    [],
    MAX_LISTING_BYTES,
  );
  const files = [
    ...new Set(listed.split("\0").filter((path) => path && !insideDataDirectory(path, prefixes))),
  ].sort();
  // The data directory is excluded so git never opens the project's live database.
  const pathspec = [".", ...prefixes.map((prefix) => `:(exclude,literal)${prefix}`)];
  return {
    root: () => root,
    files,
    unreadable: [],
    chunks(paths) {
      const out: string[][] = [];
      for (let index = 0; index < paths.length; index += SCAN_CHUNK_FILES)
        out.push(paths.slice(index, index + SCAN_CHUNK_FILES));
      return out;
    },
    async stage() {
      return [];
    },
    async unstage() {},
    async grep(flags, patterns) {
      const found = new Set<string>();
      for (const args of patternArguments(flags, patterns))
        for (const path of await grepPaths(root, ["--untracked", ...args, "--", ...pathspec], ""))
          found.add(path);
      return [...found];
    },
    async dispose() {},
  };
}

/** Streams blobs out of one long-lived `git cat-file --batch`, one request at a time. */
class BlobReader {
  private child: ChildProcess | undefined;
  private buffer = Buffer.alloc(0);
  private signal: (() => void) | undefined;
  private failure: Error | undefined;
  private ended = false;
  constructor(private readonly root: string) {}
  private notify(): void {
    const signal = this.signal;
    this.signal = undefined;
    signal?.();
  }
  private start() {
    const invocation = gitInvocation(this.root, ["cat-file", "--batch"]);
    const child = spawn("git", invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.notify();
    });
    child.stdin?.on("error", (error) => {
      this.failure = error;
      this.notify();
    });
    child.on("error", (error) => {
      this.failure = error;
      this.notify();
    });
    child.on("close", () => {
      this.ended = true;
      this.notify();
    });
    this.child = child;
    return child;
  }
  private async until(ready: () => boolean): Promise<void> {
    while (!ready()) {
      if (this.failure) throw this.failure;
      if (this.ended)
        throw new ContractError(
          "PRECONDITION_FAILED",
          "git cat-file ended before the blob was read",
        );
      await new Promise<void>((resolve) => {
        this.signal = resolve;
      });
    }
  }
  async read(oid: string, expectedSize: number): Promise<Buffer> {
    const child = this.child ?? this.start();
    child.stdin?.write(`${oid}\n`);
    await this.until(() => this.buffer.includes(10));
    const newline = this.buffer.indexOf(10);
    const header = this.buffer.subarray(0, newline).toString("utf8").split(" ");
    if (header[0] !== oid || header[1] !== "blob" || Number(header[2]) !== expectedSize)
      throw new ContractError("PRECONDITION_FAILED", "Git blob is missing or its size changed");
    const end = newline + 1 + expectedSize;
    await this.until(() => this.buffer.length >= end + 1);
    const content = Buffer.from(this.buffer.subarray(newline + 1, end));
    this.buffer = this.buffer.subarray(end + 1);
    return content;
  }
  async close(): Promise<void> {
    const child = this.child;
    if (!child || this.ended) return;
    child.stdin?.end();
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.kill();
    });
  }
}

async function pinnedSource(
  root: string,
  sha: string,
  stagingDir: string,
  limits: Omit<CodeSummaryOptions, "only">,
): Promise<TreeSource> {
  const maxFileBytes = limits.maxFileBytes ?? CODE_SUMMARY_DEFAULT_LIMITS.maxFileBytes;
  const maxTotalBytes = limits.maxTotalBytes ?? CODE_SUMMARY_DEFAULT_LIMITS.maxTotalBytes;
  const maxFiles = limits.maxFiles ?? CODE_SUMMARY_DEFAULT_LIMITS.maxFiles;
  const tree = await readOnlyGit(
    root,
    ["ls-tree", "-r", "-z", "-l", sha, "--"],
    [],
    MAX_LISTING_BYTES,
  );
  const entries = new Map<string, TreeEntry>();
  const unreadable: Skipped[] = [];
  for (const entry of tree.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const path = entry.slice(tab + 1);
    const metadata = entry.slice(0, tab).trim().split(/\s+/u);
    if (tab < 0 || path.startsWith("/") || path.includes("\\") || path.split("/").includes(".."))
      throw new ContractError("POLICY_DENIED", "Git tree contains an unconfined path");
    if (!metadata[0]?.startsWith("100") || metadata[1] !== "blob") {
      unreadable.push({ path, reason: "git_link_or_nonregular" });
      continue;
    }
    const size = Number(metadata[3]);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new ContractError("PRECONDITION_FAILED", "Git tree has an invalid blob size");
    entries.set(path, { oid: metadata[2] as string, size });
  }
  // The Python summary runner reads this directory from a container as another user.
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(stagingDir, "head-"));
  await chmod(staging, 0o755);
  const reader = new BlobReader(root);
  const staged = new Map<string, number>();
  const ignoreFiles = new Set<string>();
  let stagedBytes = 0;
  const write = async (path: string, entry: TreeEntry): Promise<void> => {
    const blob = await reader.read(entry.oid, entry.size);
    await mkdir(dirname(join(staging, path)), { recursive: true, mode: 0o755 });
    await writeFile(join(staging, path), blob, { mode: 0o644, flag: "wx" });
  };
  // Ancestor `.gitignore` files steer the walk exactly as they do in a checkout.
  const stageIgnoreFiles = async (paths: readonly string[]): Promise<void> => {
    for (const path of paths) {
      const parts = path.split("/");
      for (let depth = 0; depth < parts.length; depth++) {
        const candidate = [...parts.slice(0, depth), ".gitignore"].join("/");
        const entry = entries.get(candidate);
        if (!entry || ignoreFiles.has(candidate) || entry.size > MAX_IGNORE_FILE_BYTES) continue;
        ignoreFiles.add(candidate);
        await write(candidate, entry);
      }
    }
  };
  return {
    root: () => staging,
    files: [...entries.keys()].sort(),
    unreadable,
    chunks(paths) {
      const out: string[][] = [];
      let current: string[] = [];
      let bytes = 0;
      for (const path of paths) {
        const size = entries.get(path)?.size ?? 0;
        if (
          current.length >= SCAN_CHUNK_FILES ||
          (current.length && bytes + size > SCAN_CHUNK_BYTES)
        ) {
          out.push(current);
          current = [];
          bytes = 0;
        }
        current.push(path);
        bytes += size;
      }
      if (current.length) out.push(current);
      return out;
    },
    async stage(paths, enforceLimits) {
      const refused: Skipped[] = [];
      await stageIgnoreFiles(paths);
      for (const path of paths) {
        const entry = entries.get(path);
        if (!entry || staged.has(path)) continue;
        if (entry.size > maxFileBytes) refused.push({ path, reason: "oversize" });
        else if (enforceLimits && staged.size >= maxFiles)
          refused.push({ path, reason: "file_count_limit" });
        else if (enforceLimits && stagedBytes + entry.size > maxTotalBytes)
          refused.push({ path, reason: "total_byte_limit" });
        else {
          await write(path, entry);
          staged.set(path, entry.size);
          stagedBytes += entry.size;
        }
      }
      return refused;
    },
    async unstage(paths) {
      for (const path of paths) {
        const size = staged.get(path);
        if (size === undefined) continue;
        await rm(join(staging, path), { force: true });
        staged.delete(path);
        stagedBytes -= size;
      }
    },
    async grep(flags, patterns) {
      const found = new Set<string>();
      for (const args of patternArguments(flags, patterns))
        for (const path of await grepPaths(root, [...args, sha, "--"], `${sha}:`)) found.add(path);
      return [...found];
    },
    async dispose() {
      await reader.close();
      await rm(staging, { recursive: true, force: true });
    },
  };
}

/** Fixed strings a relative specifier of an importer of `targets` must contain. */
function importerPatterns(targets: readonly string[]): { fixed: string[]; dotsOnly: boolean } {
  const fixed = new Set<string>();
  let dotsOnly = false;
  for (const target of targets) {
    const segments = target.split("/");
    const name = segments.at(-1) ?? "";
    const base = name.replace(/\.[cm]?[jt]sx?$/u, "");
    // A relative specifier always has a `/` (`./x`, `../x`) unless it is exactly `.` or `..`.
    if (base) fixed.add(`/${base}`);
    if (/^index\.[cm]?[jt]sx?$/u.test(name)) {
      // `from "./dir"`, `from "."` and `from ".."` resolve to the directory's index file.
      dotsOnly = true;
      const directory = segments.at(-2);
      if (directory) fixed.add(`/${directory}`);
    }
  }
  return { fixed: [...fixed], dotsOnly };
}

interface ScannedFile {
  imports: { source: string; ref: CodeRef }[];
  criticalTest: boolean;
  authPatterns: CodeRef[];
}

/**
 * Summarizes only what a diff needs: the changed files, the files that import them (transitively,
 * through relative specifiers) and the files with critical or smoke tests. An authentication or
 * shared-code change selects every analyzable file, as `analyzeDiff` always did, under the
 * configured limits. Importer candidates come from `git grep`; when git fails the analysis is
 * refused with PRECONDITION_FAILED, never narrowed. The returned diff lists every analyzable file
 * that was not read as excluded, so partial coverage is declared.
 */
export async function summarizeDiffScope(
  options: DiffScopeOptions,
): Promise<{ summary: CodeSummary; diff: CodeDiff }> {
  const collected = await collectDiffChanges(options);
  const { root, changes } = collected;
  const source = options.workingTree
    ? await worktreeSource(root, options.dataDir)
    : await pinnedSource(root, collected.headSha, options.stagingDir, options.summary);
  try {
    const { pythonRunner, ...scanOptions } = options.summary;
    const admit = createPathAdmission(options.summary.excludes);
    const present = new Set(source.files);
    const admitted = (path: string) =>
      present.has(path) && !admit(path) && analyzableCodeType(path);
    const analyzable = source.files.filter(admitted);
    const finish = (summary: CodeSummary, refused: Skipped[]): void => {
      const extra = [...source.unreadable, ...refused];
      if (!extra.length) return;
      summary.skippedFiles.push(...extra);
      summary.manifestHash = computeManifestHash(summary, options.summary.excludes);
    };

    const scanned = new Map<string, ScannedFile>();
    const scan = async (paths: readonly string[]): Promise<void> => {
      const fresh = [...new Set(paths)].filter(
        (path) => !scanned.has(path) && SCRIPT_FILE.test(path) && admitted(path),
      );
      for (const chunk of source.chunks(fresh)) {
        await source.stage(chunk, false);
        try {
          const batch = await summarizeCode(source.root(), {
            ...scanOptions,
            maxSymbols: 0,
            only: chunk,
          });
          for (const path of chunk)
            scanned.set(path, { imports: [], criticalTest: false, authPatterns: [] });
          for (const item of batch.imports) scanned.get(item.ref.path)?.imports.push(item);
          for (const ref of batch.authPatterns) scanned.get(ref.path)?.authPatterns.push(ref);
          for (const test of batch.existingTests) {
            const file = scanned.get(test.ref.path);
            if (file && CRITICAL_TEST.test(test.name)) file.criticalTest = true;
          }
        } finally {
          await source.unstage(chunk);
        }
      }
    };

    const changed = [
      ...new Set(
        changes.flatMap((change) => [
          change.path,
          ...(change.previousPath ? [change.previousPath] : []),
        ]),
      ),
    ];
    await scan(changed);
    const { authTouched, sharedTouched } = touchesAuthOrShared(changes, {
      authPatterns: changed.flatMap((path) => scanned.get(path)?.authPatterns ?? []),
    });

    const withPython = pythonRunner ? { pythonRunner } : {};
    if (authTouched || sharedTouched) {
      const refused = options.workingTree ? [] : await source.stage(analyzable, true);
      const summary = await summarizeCode(source.root(), { ...scanOptions, ...withPython });
      finish(summary, refused);
      const diff = assessDiffImpact(collected, { summary });
      if (summary.skippedFiles.some((item) => LIMIT_REASONS.includes(item.reason)))
        diff.impact.gaps.push(
          "An authentication or shared-code change selects every analyzable file, but files beyond the size, count or byte limits were skipped (see skippedFiles); their impact is not analyzed.",
        );
      return { summary, diff };
    }

    // Files that mention a critical or smoke test are read once; the ones that define one are kept.
    await scan(await source.grep(["-i", "-F"], ["critical", "smoke"]));
    const selected = new Set(changed);
    const searched = new Set<string>();
    for (;;) {
      const targets = [...selected].filter((path) => !searched.has(path));
      if (!targets.length) break;
      const { fixed, dotsOnly } = importerPatterns(targets);
      const candidates = new Set(fixed.length ? await source.grep(["-F"], fixed) : []);
      if (dotsOnly)
        for (const path of await source.grep(["-E"], ["['\"]\\.{1,2}/?['\"]"]))
          candidates.add(path);
      await scan([...candidates]);
      for (const path of targets) searched.add(path);
      expandReverseImports(
        root,
        selected,
        [...scanned.values()].flatMap((file) => file.imports),
      );
    }
    const keep = new Set(
      [
        ...selected,
        ...[...scanned].filter(([, file]) => file.criticalTest).map(([path]) => path),
      ].filter((path) => present.has(path)),
    );
    // Non-code files (a changed README, a binary asset) are selected by the diff but never read.
    const code = [...keep].filter(analyzableCodeType).sort();
    // A pinned head is staged from git objects, so excluded files are recorded instead of staged;
    // the working-tree walk records its own exclusions.
    const excluded = options.workingTree
      ? []
      : code.flatMap((path) => {
          const reason = admit(path);
          return reason ? [{ path, reason }] : [];
        });
    const only = options.workingTree ? code : code.filter((path) => !admit(path));
    const refused = [...excluded, ...(options.workingTree ? [] : await source.stage(only, true))];
    const summary = await summarizeCode(source.root(), { ...scanOptions, ...withPython, only });
    finish(summary, refused);
    const diff = assessDiffImpact(collected, {
      summary,
      unreadFiles: analyzable.filter((path) => !keep.has(path)),
    });
    return { summary, diff };
  } finally {
    await source.dispose();
  }
}
