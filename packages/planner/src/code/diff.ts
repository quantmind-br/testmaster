import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { ContractError } from "@testmaster/contracts";
import { canonicalJson, sha256 } from "@testmaster/domain";
import {
  dataDirectoryPrefixes,
  insideDataDirectory,
  testmasterArtifact,
} from "./data-directory.js";
import { analyzableCodeType, hashConfinedCodeFile } from "./summary.js";
import type { CodeDiff, CodeRoute, CodeSummary } from "./types.js";

const execFileAsync = promisify(execFile);
interface GitFile {
  status: string;
  path: string;
  previousPath?: string;
}
export interface DiffOptions {
  repoRoot: string;
  base?: string;
  head?: string;
  workingTree?: boolean;
  summary?: CodeSummary;
  /** Project data directory; never listed or read (see `dataDirectoryPrefixes`). */
  dataDir?: string;
  /**
   * Analyzable repository files a diff-scoped `summary` deliberately did not read. They are listed
   * as excluded files and the impact declares that coverage is limited to the closure.
   */
  unreadFiles?: readonly string[];
}
/** Everything about a diff that needs git and the working tree, but not the code summary. */
export type DiffChanges = Omit<CodeDiff, "impact"> & { root: string };
/** Command line and environment for git with credentials, hooks, filters and drivers neutralized. */
export function gitInvocation(
  repoRoot: string,
  args: string[],
  filterOverrides: string[] = [],
): { args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  // Repository reads need neither provider credentials nor operator Git configuration.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "SYSTEMROOT"].includes(key),
    ),
  );
  return {
    args: [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.allow=never",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "core.sshCommand=/usr/bin/false",
      "-c",
      "credential.helper=",
      "-c",
      "submodule.recurse=false",
      "-c",
      "diff.ignoreSubmodules=all",
      "-c",
      "diff.external=",
      ...filterOverrides,
      ...args,
    ],
    cwd: repoRoot,
    env: {
      ...env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_PAGER: "cat",
    },
  };
}
/** Runs git read-only and returns stdout; a non-zero exit rejects with the exit code in `code`. */
export async function readOnlyGit(
  repoRoot: string,
  args: string[],
  filterOverrides: string[] = [],
  maxBuffer = 16 * 1024 * 1024,
): Promise<string> {
  const invocation = gitInvocation(repoRoot, args, filterOverrides);
  const result = await execFileAsync("git", invocation.args, {
    cwd: invocation.cwd,
    maxBuffer,
    timeout: 30_000,
    env: invocation.env,
  });
  return result.stdout;
}
const git = readOnlyGit;
function parseNameStatus(output: string): GitFile[] {
  const files: GitFile[] = [];
  const fields = output.split("\0");
  for (let index = 0; index < fields.length; index++) {
    const code = fields[index];
    if (!code) continue;
    const first = fields[++index];
    if (!first) throw new ContractError("PRECONDITION_FAILED", "Malformed git diff output");
    if (code.startsWith("R") || code.startsWith("C")) {
      const path = fields[++index];
      if (!path) throw new ContractError("PRECONDITION_FAILED", "Malformed rename output");
      files.push({ status: code.slice(0, 1), path, previousPath: first });
    } else files.push({ status: code.slice(0, 1), path: first });
  }
  return files;
}
/** A path inside a hidden directory (`.reversa/`, `.atl/`, `.cache/`): tool state, never repository code. */
const HIDDEN_DIRECTORY = /(?:^|\/)\.[^/]+\//u;
/** Schema-like sources that are not code files but still define shared structure. */
const SHARED_DATA_FILE = /\.(?:sql|prisma|graphql|gql|proto)$/iu;
/**
 * Shared code by path segment, not by substring: a directory named `schema(s)`, `migration(s)`,
 * `shared` or `database`, or a file whose stem ends in one of those words (`schema.ts`,
 * `user.schema.ts`, `prisma/schema.prisma`). `schema-summary.json` and `unshared.ts` do not match.
 */
const SHARED_DIRECTORY = /(?:^|\/)(?:schemas?|migrations?|shared|database)\//iu;
const SHARED_FILE = /(?:^|\/)(?:[^/]*[._-])?(?:schemas?|migrations?|shared|database)\.[^/]+$/iu;
/**
 * Whether a change to this path can widen the impact (authentication or shared code): it is code or
 * a schema-like source, outside hidden tool directories, and `eligible` (when given) admits it.
 */
function mayWiden(path: string, eligible: ((path: string) => boolean) | undefined): boolean {
  if (HIDDEN_DIRECTORY.test(path)) return false;
  if (!analyzableCodeType(path) && !SHARED_DATA_FILE.test(path)) return false;
  return eligible ? eligible(path) : true;
}
function authPath(path: string, summary: Pick<CodeSummary, "authPatterns"> | undefined): boolean {
  if (
    /(?:^|\/)(?:auth|authentication|authorization|login|session|security|acl|permissions?)(?:\/|\.|$)/iu.test(
      path,
    )
  )
    return true;
  return summary?.authPatterns.some((ref) => ref.path === path) ?? false;
}
/**
 * Whether the change set touches authentication or shared code (schema, migration, database).
 * Changes to paths outside the analyzable code set (tool caches in hidden directories, binaries,
 * unsupported types, and paths `eligible` refuses, such as excluded ones) never count.
 */
export function touchesAuthOrShared(
  changes: CodeDiff["changes"],
  summary: Pick<CodeSummary, "authPatterns"> | undefined,
  eligible?: (path: string) => boolean,
): { authTouched: boolean; sharedTouched: boolean } {
  const paths = (change: CodeDiff["changes"][number]) =>
    [change.path, ...(change.previousPath ? [change.previousPath] : [])].filter((path) =>
      mayWiden(path, eligible),
    );
  return {
    authTouched: changes.some((change) => paths(change).some((path) => authPath(path, summary))),
    sharedTouched: changes.some((change) =>
      paths(change).some((path) => SHARED_DIRECTORY.test(path) || SHARED_FILE.test(path)),
    ),
  };
}
/**
 * Adds to `selected` every file that imports (relatively, transitively) a selected file and returns
 * the paths it added. A specifier matches a file by its full path, its path without extension, or
 * the directory of its `index.ts`/`index.js`; aliased specifiers are not resolved.
 */
export function expandReverseImports(
  root: string,
  selected: Set<string>,
  imports: readonly { source: string; ref: { path: string } }[],
): string[] {
  const targets = new Set<string>();
  const admit = (path: string) => {
    targets.add(path);
    targets.add(path.replace(/\.[cm]?[jt]sx?$/u, ""));
    if (path.endsWith("/index.ts") || path.endsWith("/index.js"))
      targets.add(path.slice(0, -"/index.ts".length));
  };
  for (const path of selected) admit(path);
  const edges = imports
    .filter((item) => item.source.startsWith("."))
    .map((item) => ({
      importer: item.ref.path,
      target: relative(root, resolve(root, dirname(item.ref.path), item.source)).replaceAll(
        "\\",
        "/",
      ),
    }));
  const added: string[] = [];
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const edge of edges) {
      if (selected.has(edge.importer) || !targets.has(edge.target)) continue;
      selected.add(edge.importer);
      added.push(edge.importer);
      admit(edge.importer);
      expanded = true;
    }
  }
  return added;
}
/** Resolves the compared commits and lists changed files plus the working-tree identity. */
export async function collectDiffChanges(
  options: Pick<DiffOptions, "repoRoot" | "base" | "head" | "workingTree" | "dataDir">,
): Promise<DiffChanges> {
  if (!options.base && !options.workingTree)
    throw new ContractError(
      "PRECONDITION_FAILED",
      "Explicit --base/--head or --working-tree is required",
    );
  const root = await realpath(options.repoRoot);
  // Working-tree diff can execute clean/process filters even with --no-textconv.
  // Enumerate names without reading files, then disable every repository conversion driver.
  let filterKeys: string[] = [];
  try {
    filterKeys = (
      await git(root, [
        "config",
        "--includes",
        "--null",
        "--name-only",
        "--get-regexp",
        "^filter\\..*\\.(clean|smudge|process|required)$",
      ])
    )
      .split("\0")
      .filter(Boolean);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== 1) throw error;
  }
  const filterOverrides = filterKeys.flatMap((key) => [
    "-c",
    `${key}=${key.endsWith(".required") ? "false" : ""}`,
  ]);
  const resolveCommit = async (value: string, role: "base" | "head") => {
    if (
      value.startsWith("-") ||
      !value ||
      [...value].some((character) => character.charCodeAt(0) <= 32)
    )
      throw new ContractError("INVALID_ARGUMENT", "Invalid git revision");
    try {
      return (
        await git(root, ["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`])
      ).trim();
    } catch (error) {
      // Git exits non-zero for an unknown revision. Spawn failures and timeouts carry a string
      // code or none, so they are not misreported as a bad argument.
      if (error && typeof error === "object" && "code" in error && typeof error.code === "number")
        throw new ContractError(
          "INVALID_ARGUMENT",
          `Git ${role} revision "${value.slice(0, 200)}" does not resolve to a commit in this repository`,
          { role },
        );
      throw error;
    }
  };
  const base = await resolveCommit(options.base ?? "HEAD", "base");
  const head = await resolveCommit(options.head ?? "HEAD", "head");
  const mergeBase = (await git(root, ["merge-base", base, head])).trim();
  const changes = parseNameStatus(
    await git(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-status",
      "-z",
      "--find-renames",
      base,
      head,
      "--",
    ]),
  ).filter((change) => !testmasterArtifact(change.path));
  let dirtyHash: string | null = null;
  if (options.workingTree) {
    // The project data directory holds the live SQLite database of the calling process; reading
    // it here would close a descriptor on it and drop that process's POSIX locks.
    const dataPrefixes = dataDirectoryPrefixes(root, options.dataDir);
    const dirty = parseNameStatus(
      await git(
        root,
        ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "HEAD", "--"],
        filterOverrides,
      ),
    ).filter(
      (change) =>
        !insideDataDirectory(change.path, dataPrefixes) && !testmasterArtifact(change.path),
    );
    const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter(
        (path) => path && !insideDataDirectory(path, dataPrefixes) && !testmasterArtifact(path),
      );
    dirty.push(...untracked.map((path) => ({ status: "A", path })));
    const hashes: { path: string; contentHash: string | null }[] = [];
    for (const path of [...new Set(dirty.map((change) => change.path))].sort()) {
      try {
        // Streamed, so a large untracked file (a database, an archive) has an identity too.
        hashes.push({ path, contentHash: await hashConfinedCodeFile(root, path) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        hashes.push({ path, contentHash: null });
      }
    }
    dirtyHash = sha256(canonicalJson(hashes));
    for (const change of dirty)
      if (!changes.some((existing) => existing.path === change.path)) changes.push(change);
  }
  return {
    root,
    baseSha: base,
    headSha: head,
    mergeBase,
    includeWorkingTree: options.workingTree ?? false,
    dirtyHash,
    changes,
    fingerprint: sha256(canonicalJson({ base, head, mergeBase, dirtyHash, changes })),
  };
}
/** Selects the impact of collected changes: changed files, their importers, auth/shared fan-out. */
export function assessDiffImpact(
  collected: DiffChanges,
  options: Pick<DiffOptions, "summary" | "unreadFiles"> & {
    /** Extra admission of paths that may widen the impact (for example not excluded by the scan rules). */
    fanOutEligible?: (path: string) => boolean;
  } = {},
): CodeDiff {
  const { root, changes } = collected;
  const { authTouched, sharedTouched } = touchesAuthOrShared(
    changes,
    options.summary,
    options.fanOutEligible,
  );
  // Tool state in hidden directories is a change of the repository listing but never of its code.
  const selected = new Set(
    changes
      .flatMap((change) => [change.path, ...(change.previousPath ? [change.previousPath] : [])])
      .filter((path) => !HIDDEN_DIRECTORY.test(path)),
  );
  expandReverseImports(root, selected, options.summary?.imports ?? []);
  if (authTouched || sharedTouched)
    for (const ref of options.summary?.fileRefs ?? []) selected.add(ref.path);
  for (const test of options.summary?.existingTests ?? []) {
    if (authTouched || sharedTouched || /(?:critical|smoke)/iu.test(test.name))
      selected.add(test.ref.path);
  }
  const selectedFiles = [...selected].sort();
  const routes: CodeRoute[] = [
    ...(options.summary?.routes ?? []),
    ...(options.summary?.endpoints ?? []),
  ].filter((route) => selected.has(route.ref.path));
  const components =
    options.summary?.features.filter((component) => selected.has(component.ref.path)) ?? [];
  const excludedFiles = [
    ...new Set([
      ...(options.summary?.fileRefs ?? []).map((ref) => ref.path),
      ...(options.unreadFiles ?? []),
    ]),
  ]
    .filter((path) => !selected.has(path))
    .map((path) => ({
      path,
      reason: "outside_known_dependency_closure; uncertain dynamic dependencies require review",
    }));
  const gaps = ["Coverage is partial; route selection is not code coverage."];
  if (options.unreadFiles)
    gaps.push(
      "Only changed files and the files that import them through relative specifiers were read; aliased imports, dynamic imports and other files outside that closure were not analyzed.",
    );
  if (authTouched) gaps.push("Authentication-related change requires critical smoke coverage.");
  return {
    baseSha: collected.baseSha,
    headSha: collected.headSha,
    mergeBase: collected.mergeBase,
    includeWorkingTree: collected.includeWorkingTree,
    dirtyHash: collected.dirtyHash,
    changes,
    impact: {
      coverage: "partial",
      criticalSmoke: authTouched || sharedTouched,
      authTouched,
      selectedFiles,
      excludedFiles,
      routes,
      components,
      gaps,
    },
    fingerprint: collected.fingerprint,
  };
}
export async function analyzeDiff(options: DiffOptions): Promise<CodeDiff> {
  return assessDiffImpact(await collectDiffChanges(options), options);
}
