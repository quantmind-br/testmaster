import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeDiff } from "./diff.js";
import { summarizeDiffScope } from "./scope.js";
import { summarizeCode } from "./summary.js";

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "testmaster-scope-"));
  execFileSync("git", ["init", "-q", root]);
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  return root;
}
async function put(root: string, files: Record<string, string | Buffer>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}
function commit(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}
const TREE: Record<string, string> = {
  "src/util.ts": "export const util = 1;\n",
  "src/a.ts": "import { util } from './util';\nexport function Alpha() { return util; }\n",
  "src/b.ts": "import { Alpha } from './a';\nexport const Beta = () => Alpha();\n",
  "src/lib/index.ts": "export const lib = 1;\n",
  "src/c.ts": "import { lib } from './lib';\nexport function Gamma() { return lib; }\n",
  "src/unrelated.ts": "export function Unrelated() { return 1; }\n",
  "src/d.ts": "import { Unrelated } from './unrelated';\nexport const Delta = () => Unrelated();\n",
  "src/checkout.smoke.test.ts":
    "import { test } from 'vitest';\ntest('smoke checkout', () => {});\n",
  "README.md": "# Shop\n",
};

describe("diff-scoped code analysis", () => {
  it("selects exactly what the full-tree analysis selects while reading only that closure", async () => {
    const root = await repo();
    const staging = await mkdtemp(join(tmpdir(), "testmaster-scope-staging-"));
    try {
      await put(root, TREE);
      const base = commit(root, "base");
      await put(root, {
        "src/util.ts": "export const util = 2;\n",
        "src/lib/index.ts": "export const lib = 2;\n",
      });
      const head = commit(root, "head");
      // Oracle: the full tree summarized and then reduced by the diff.
      const full = await analyzeDiff({
        repoRoot: root,
        base,
        head,
        summary: await summarizeCode(root),
      });
      expect(full.impact.selectedFiles).toEqual([
        "src/a.ts",
        "src/b.ts",
        "src/c.ts",
        "src/checkout.smoke.test.ts",
        "src/lib/index.ts",
        "src/util.ts",
      ]);
      const pinned = await summarizeDiffScope({
        repoRoot: root,
        base,
        head,
        summary: {},
        stagingDir: staging,
      });
      const working = await summarizeDiffScope({
        repoRoot: root,
        base,
        head,
        workingTree: true,
        summary: {},
        stagingDir: staging,
      });
      for (const scoped of [pinned, working]) {
        expect(scoped.diff.impact.selectedFiles).toEqual(full.impact.selectedFiles);
        expect(scoped.diff.impact.components).toEqual(full.impact.components);
        expect(scoped.diff.impact.routes).toEqual(full.impact.routes);
        expect(scoped.diff.impact.components.map((feature) => feature.name).sort()).toEqual([
          "Alpha",
          "Beta",
          "Gamma",
        ]);
        // Only the closure was read; everything else is declared, with a reason.
        expect(scoped.summary.scannedFiles).toEqual(
          full.impact.selectedFiles.filter((path) => path.endsWith(".ts")),
        );
        expect(scoped.diff.impact.excludedFiles.map((file) => file.path).sort()).toEqual([
          "src/d.ts",
          "src/unrelated.ts",
        ]);
        expect(scoped.diff.impact.excludedFiles[0]?.reason).toContain(
          "outside_known_dependency_closure",
        );
        expect(scoped.diff.impact.gaps.join(" ")).toContain("relative specifiers");
      }
      // The working-tree variant also hashes the (clean) tree, so only the pinned one matches.
      expect(pinned.diff.fingerprint).toBe(full.fingerprint);
      // Negative control: an importer of an unchanged file stays out of the closure.
      expect(pinned.summary.scannedFiles).not.toContain("src/d.ts");
      // The staging directory is removed afterwards.
      expect(await readdir(staging)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("analyzes the code file of a pinned repository whose other blobs exceed the old byte budget", async () => {
    const root = await repo();
    const staging = await mkdtemp(join(tmpdir(), "testmaster-scope-staging-"));
    try {
      await put(root, { "README.md": "# Assets\n" });
      const base = commit(root, "base");
      const asset = Buffer.alloc(24 * 1024 * 1024);
      await put(root, {
        "assets/one.bin": asset,
        "assets/two.bin": asset,
        "assets/three.bin": asset,
        "server.ts":
          "import express from 'express';\nconst app = express();\napp.get('/health', () => 1);\n",
      });
      const head = commit(root, "assets");
      const result = await summarizeDiffScope({
        repoRoot: root,
        base,
        head,
        summary: { maxFiles: 20000 },
        stagingDir: staging,
      });
      expect(result.summary.scannedFiles).toEqual(["server.ts"]);
      expect(result.summary.endpoints).toContainEqual(
        expect.objectContaining({ framework: "express", method: "GET", path: "/health" }),
      );
      expect(result.diff.impact.selectedFiles).toContain("assets/one.bin");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("keeps the file routes of a changed Next.js page by reading the manifest above it", async () => {
    const root = await repo();
    const staging = await mkdtemp(join(tmpdir(), "testmaster-scope-staging-"));
    try {
      await put(root, {
        "web/package.json": '{"dependencies":{"next":"15.0.0"}}\n',
        "web/pages/login.tsx": "export default function Login() { return null; }\n",
      });
      const base = commit(root, "base");
      await put(root, {
        "web/pages/login.tsx": "export default function Login() { return 1; }\n",
      });
      const head = commit(root, "head");
      for (const workingTree of [false, true]) {
        const result = await summarizeDiffScope({
          repoRoot: root,
          base,
          head,
          ...(workingTree ? { workingTree } : {}),
          summary: {},
          stagingDir: staging,
        });
        expect(result.summary.routes.map((route) => route.path)).toEqual(["/login"]);
        expect(result.diff.impact.routes.map((route) => route.path)).toEqual(["/login"]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("records an oversize closure member instead of staging it", async () => {
    const root = await repo();
    const staging = await mkdtemp(join(tmpdir(), "testmaster-scope-staging-"));
    try {
      await put(root, { "a.ts": "export const a = 1;\n" });
      const base = commit(root, "base");
      await put(root, {
        "a.ts": "export const a = 2;\n",
        "big.ts": `export const big = "${"x".repeat(4096)}";\n`,
      });
      const head = commit(root, "head");
      const result = await summarizeDiffScope({
        repoRoot: root,
        base,
        head,
        summary: { maxFileBytes: 1024 },
        stagingDir: staging,
      });
      expect(result.summary.scannedFiles).toEqual(["a.ts"]);
      expect(result.summary.skippedFiles).toContainEqual({ path: "big.ts", reason: "oversize" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("refuses a narrowed analysis when git grep fails", async () => {
    const root = await repo();
    const staging = await mkdtemp(join(tmpdir(), "testmaster-scope-staging-"));
    try {
      await put(root, TREE);
      const base = commit(root, "base");
      await put(root, { "src/util.ts": "export const util = 2;\n" });
      const head = commit(root, "head");
      const options = { repoRoot: root, base, head, summary: {}, stagingDir: staging };
      // Positive control: the same request resolves while git grep works.
      await expect(summarizeDiffScope(options)).resolves.toBeDefined();
      await expect(summarizeDiffScope({ ...options, workingTree: true })).resolves.toBeDefined();
      git(root, "config", "grep.extendedRegexp", "maybe");
      await expect(summarizeDiffScope(options)).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        details: { step: "importer_closure" },
      });
      await expect(summarizeDiffScope({ ...options, workingTree: true })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        details: { step: "importer_closure" },
      });
      expect(await readdir(staging)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("selects every analyzable file for an authentication change and declares what the limits skipped", async () => {
    const root = await repo();
    const staging = await mkdtemp(join(tmpdir(), "testmaster-scope-staging-"));
    try {
      await put(root, {
        ...TREE,
        "src/auth/login.ts": "export function login() { return false; }\n",
      });
      const base = commit(root, "base");
      await put(root, { "src/auth/login.ts": "export function login() { return true; }\n" });
      const head = commit(root, "head");
      for (const workingTree of [false, true]) {
        const result = await summarizeDiffScope({
          repoRoot: root,
          base,
          head,
          ...(workingTree ? { workingTree } : {}),
          summary: {},
          stagingDir: staging,
        });
        expect(result.diff.impact.authTouched).toBe(true);
        expect(result.diff.impact.selectedFiles).toEqual(
          expect.arrayContaining(["src/d.ts", "src/unrelated.ts", "src/auth/login.ts"]),
        );
        expect(result.diff.impact.excludedFiles).toEqual([]);
        // Under a tight file limit the skipped files are declared, never dropped silently.
        const limited = await summarizeDiffScope({
          repoRoot: root,
          base,
          head,
          ...(workingTree ? { workingTree } : {}),
          summary: { maxFiles: 3 },
          stagingDir: staging,
        });
        expect(limited.summary.skippedFiles.map((item) => item.reason)).toContain(
          "file_count_limit",
        );
        expect(limited.diff.impact.gaps.join(" ")).toContain(
          "beyond the size, count or byte limits",
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("does not widen the impact for TestMaster artifacts or untracked tool caches, and does for real schema code", async () => {
    const root = await repo();
    const staging = await mkdtemp(join(tmpdir(), "testmaster-scope-staging-"));
    try {
      await put(root, {
        ...TREE,
        "src/schemaless.ts": "export const schemaless = 1;\n",
        "src/db/schema.ts": "export const users = 1;\n",
      });
      const base = commit(root, "base");
      await put(root, {
        "testmaster.config.json": '{"version":1}\n',
        ".testmaster/state.json": "{}\n",
        ".reversa/cache/schema-summary.json": "{}\n",
        ".atl/state/migration-index.json": "{}\n",
        "src/util.ts": "export const util = 2;\n",
        "src/schemaless.ts": "export const schemaless = 2;\n",
      });
      for (const scoped of [true, false]) {
        const impact = scoped
          ? (
              await summarizeDiffScope({
                repoRoot: root,
                base,
                workingTree: true,
                summary: {},
                stagingDir: staging,
              })
            ).diff
          : await analyzeDiff({
              repoRoot: root,
              base,
              workingTree: true,
              summary: await summarizeCode(root),
            });
        const changed = impact.changes.map((change) => change.path);
        // TestMaster's own artifacts are never a change of the code under test.
        expect(changed).not.toContain("testmaster.config.json");
        expect(changed.some((path) => path.startsWith(".testmaster/"))).toBe(false);
        expect(changed).toEqual(
          expect.arrayContaining([
            ".reversa/cache/schema-summary.json",
            ".atl/state/migration-index.json",
            "src/util.ts",
          ]),
        );
        // Tool caches and a look-alike name (schemaless.ts) do not select the whole repository.
        expect(impact.impact.criticalSmoke).toBe(false);
        expect(impact.impact.authTouched).toBe(false);
        expect(impact.impact.selectedFiles).not.toContain("src/unrelated.ts");
        expect(impact.impact.selectedFiles).toEqual(
          expect.arrayContaining(["src/util.ts", "src/a.ts", "src/b.ts", "src/schemaless.ts"]),
        );
        expect(impact.impact.selectedFiles.some((path) => path.startsWith("."))).toBe(false);
      }
      // Positive control: a change to real schema code still widens to every analyzable file.
      await put(root, { "src/db/schema.ts": "export const users = 2;\n" });
      const widened = await summarizeDiffScope({
        repoRoot: root,
        base,
        workingTree: true,
        summary: {},
        stagingDir: staging,
      });
      expect(widened.diff.impact.criticalSmoke).toBe(true);
      expect(widened.diff.impact.selectedFiles).toEqual(
        expect.arrayContaining(["src/unrelated.ts", "src/d.ts", "src/db/schema.ts"]),
      );
      expect(widened.diff.impact.selectedFiles.every((path) => !path.startsWith("."))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
    }
  });
});
