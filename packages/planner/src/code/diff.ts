import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { ContractError } from "@testmaster/contracts";
import { canonicalJson, sha256 } from "@testmaster/domain";
import { readConfinedCodeFile } from "./summary.js";
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
}
async function git(
  repoRoot: string,
  args: string[],
  filterOverrides: string[] = [],
): Promise<string> {
  // Repository reads need neither provider credentials nor operator Git configuration.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "SYSTEMROOT"].includes(key),
    ),
  );
  const result = await execFileAsync(
    "git",
    [
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
    {
      cwd: repoRoot,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
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
    },
  );
  return result.stdout;
}
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
function authPath(path: string, summary: CodeSummary | undefined): boolean {
  if (
    /(?:^|\/)(?:auth|authentication|authorization|login|session|security|acl|permissions?)(?:\/|\.|$)/iu.test(
      path,
    )
  )
    return true;
  return summary?.authPatterns.some((ref) => ref.path === path) ?? false;
}
export async function analyzeDiff(options: DiffOptions): Promise<CodeDiff> {
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
  const resolveCommit = async (value: string) => {
    if (
      value.startsWith("-") ||
      !value ||
      [...value].some((character) => character.charCodeAt(0) <= 32)
    )
      throw new ContractError("INVALID_ARGUMENT", "Invalid git revision");
    return (
      await git(root, ["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`])
    ).trim();
  };
  const base = await resolveCommit(options.base ?? "HEAD");
  const head = await resolveCommit(options.head ?? "HEAD");
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
  );
  let dirtyHash: string | null = null;
  if (options.workingTree) {
    const dirty = parseNameStatus(
      await git(
        root,
        ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "HEAD", "--"],
        filterOverrides,
      ),
    );
    const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter(Boolean);
    dirty.push(...untracked.map((path) => ({ status: "A", path })));
    const hashes: { path: string; contentHash: string | null }[] = [];
    for (const path of [...new Set(dirty.map((change) => change.path))].sort()) {
      try {
        hashes.push({
          path,
          contentHash: sha256(await readConfinedCodeFile(root, path, 25 * 1024 * 1024)),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        hashes.push({ path, contentHash: null });
      }
    }
    dirtyHash = sha256(canonicalJson(hashes));
    for (const change of dirty)
      if (!changes.some((existing) => existing.path === change.path)) changes.push(change);
  }
  const authTouched = changes.some(
    (change) =>
      authPath(change.path, options.summary) ||
      (change.previousPath ? authPath(change.previousPath, options.summary) : false),
  );
  const selected = new Set(
    changes.flatMap((change) => [
      change.path,
      ...(change.previousPath ? [change.previousPath] : []),
    ]),
  );
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const item of options.summary?.imports ?? []) {
      if (!item.source.startsWith(".")) continue;
      const target = relative(root, resolve(root, dirname(item.ref.path), item.source)).replaceAll(
        "\\",
        "/",
      );
      if (
        [...selected].some(
          (path) =>
            path === target ||
            path.replace(/\.[cm]?[jt]sx?$/u, "") === target ||
            path === `${target}/index.ts` ||
            path === `${target}/index.js`,
        ) &&
        !selected.has(item.ref.path)
      ) {
        selected.add(item.ref.path);
        expanded = true;
      }
    }
  }
  const sharedTouched = changes.some((change) =>
    /(?:schema|migration|shared|database)/iu.test(change.path),
  );
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
  const excludedFiles = (options.summary?.fileRefs ?? [])
    .filter((ref) => !selected.has(ref.path))
    .map((ref) => ({
      path: ref.path,
      reason: "outside_known_dependency_closure; uncertain dynamic dependencies require review",
    }));
  const gaps = ["Coverage is partial; route selection is not code coverage."];
  if (authTouched) gaps.push("Authentication-related change requires critical smoke coverage.");
  return {
    baseSha: base,
    headSha: head,
    mergeBase,
    includeWorkingTree: options.workingTree ?? false,
    dirtyHash,
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
    fingerprint: sha256(canonicalJson({ base, head, mergeBase, dirtyHash, changes })),
  };
}
