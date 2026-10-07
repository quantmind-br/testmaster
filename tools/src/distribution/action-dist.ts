import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { digestFile, LICENSE_ASSETS } from "./archive.js";

const exec = promisify(execFile);
// Action modules have only Node builtin value imports. Application imports are type-only;
// application code is dynamically loaded from the separately hash-verified installed runtime.
export const ACTION_FILES = [
  "github-action/main.js",
  "github-action/publish.js",
  "github-action/publisher.js",
  "github-action/download.js",
  "github-action/inputs.js",
  "distribution/install.js",
  "distribution/archive.js",
] as const;
export async function stageAction(root: string, out: string, sourceCommit: string) {
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error("Invalid Action source commit");
  await mkdir(out, { mode: 0o700 });
  const files: { path: string; sha256: string; size: number }[] = [];
  for (const path of [
    "action.yml",
    ...LICENSE_ASSETS,
    ...ACTION_FILES.map((file) => `tools/dist/${file}`),
  ]) {
    const source = join(root, path);
    if (path.endsWith(".js")) {
      const code = await readFile(source, "utf8");
      // No unresolved bare package imports may slip into a downloaded Action tree.
      const imports = [...code.matchAll(/(?:from\s*|import\s*\()(["'])([^"']+)\1/gu)].map(
        (match) => match[2]!,
      );
      if (imports.some((specifier) => !specifier.startsWith("node:") && !specifier.startsWith(".")))
        throw new Error(`Action has unbundled dependency: ${path}`);
    }
    await mkdir(dirname(join(out, path)), { recursive: true, mode: 0o700 });
    await copyFile(source, join(out, path));
    files.push({ path, ...(await digestFile(join(out, path))) });
  }
  await writeFile(
    join(out, "package.json"),
    JSON.stringify({
      name: "testmaster-action-distribution",
      private: true,
      type: "module",
      license: "Apache-2.0",
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  files.push({ path: "package.json", ...(await digestFile(join(out, "package.json"))) });
  const provenance = {
    schemaVersion: "1.0.0",
    sourceCommit,
    files,
    layout: "Self-contained Node builtin-only Action plus separately verified runtime",
  };
  await writeFile(join(out, "source-commit.json"), JSON.stringify(provenance, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return provenance;
}
export async function packageAction(root: string, out: string) {
  await exec("git", ["diff", "--exit-code", "HEAD", "--"], { cwd: root });
  const untracked = await exec("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: root,
  });
  if (untracked.stdout.trim())
    throw new Error("Action distribution requires a clean committed source tree");
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });
  await exec("pnpm", ["exec", "tsc", "-b"], {
    cwd: root,
    timeout: 300000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stageAction(root, out, stdout.trim());
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [root, out] = process.argv.slice(2);
  if (!root || !out)
    throw new Error("Usage: action-dist.js CLEAN_SOURCE_ROOT NEW_OUTPUT_DIRECTORY");
  await packageAction(resolve(root), resolve(out));
}
