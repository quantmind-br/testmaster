import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeDiff } from "./diff.js";
import { summarizeCode } from "./summary.js";

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "testmaster-planner-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  return root;
}
describe("confined AST code summary", () => {
  it("summarizes reference-shop route logic and test hooks without executing it", async () => {
    const summary = await summarizeCode(join(process.cwd(), "fixtures/reference-shop"));
    expect(summary.scannedFiles).toContain("src/index.js");
    expect(summary.testHooks.some((hook) => hook.name === "password")).toBe(true);
    expect(summary.routes.length + summary.endpoints.length).toBeGreaterThan(0);
  });
  it("applies defaults, gitignore and symlink confinement", async () => {
    const root = await repo();
    try {
      await mkdir(join(root, "src"));
      await writeFile(
        join(root, "src/app.js"),
        "export const app = () => fetch('https://example.invalid');\n",
      );
      await writeFile(join(root, ".env"), "SECRET=never");
      await writeFile(join(root, "ignored.js"), "throw new Error('never');");
      await writeFile(join(root, ".gitignore"), "ignored.js\n");
      await symlink("/etc/passwd", join(root, "escape.js"));
      const summary = await summarizeCode(root);
      expect(summary.scannedFiles).toEqual(["src/app.js"]);
      expect(summary.skippedFiles).toEqual(
        expect.arrayContaining([
          { path: ".env", reason: "default_exclude" },
          { path: "ignored.js", reason: "gitignore" },
          { path: "escape.js", reason: "symlink_escape" },
        ]),
      );
      expect(summary.externalServices[0]?.url).toBe("https://example.invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("finds Express, React and Next routes and respects configured excludes", async () => {
    const root = await repo();
    try {
      await mkdir(join(root, "app", "(shop)", "products"), { recursive: true });
      await writeFile(
        join(root, "server.ts"),
        "import express from 'express'; const app = express(); app.get('/health', (req,res) => res.send('ok'));\n",
      );
      await writeFile(
        join(root, "app", "(shop)", "products", "page.tsx"),
        "export default function Products() { return <div data-testid='products'/>; }\n",
      );
      await writeFile(join(root, "excluded.js"), "throw new Error('must not load');\n");
      await writeFile(join(root, "api.py"), "raise RuntimeError('must not load')\n");
      const summary = await summarizeCode(root, {
        excludes: ["excluded.js"],
        pythonRunner: {
          async summarize(_repoRoot, files) {
            expect(files).toEqual(["api.py"]);
            return {
              available: true,
              summary: {
                version: "1.0.0",
                files: [
                  {
                    path: "api.py",
                    routes: [
                      {
                        framework: "fastapi",
                        method: "GET",
                        path: "/python",
                        handler: "health",
                        line: 1,
                      },
                    ],
                    tests: [],
                    symbols: [],
                  },
                ],
                diagnostics: [],
              },
            };
          },
        },
      });
      expect(summary.endpoints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ framework: "express", method: "GET", path: "/health" }),
          expect.objectContaining({ framework: "fastapi", path: "/python" }),
        ]),
      );
      expect(summary.routes).toEqual(
        expect.arrayContaining([expect.objectContaining({ framework: "next", path: "/products" })]),
      );
      expect(summary.features.some((feature) => feature.name === "Products")).toBe(true);
      expect(summary.testHooks.some((hook) => hook.name === "products")).toBe(true);
      expect(summary.skippedFiles).toContainEqual({
        path: "excluded.js",
        reason: "config_exclude",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
describe("explicit diff provenance", () => {
  it("refuses no-base automation and flags auth changes", async () => {
    const root = await repo();
    try {
      await writeFile(join(root, "auth.js"), "export function login() { return true; }\n");
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
      const base = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      await writeFile(join(root, "auth.js"), "export function login() { return false; }\n");
      await expect(analyzeDiff({ repoRoot: root })).rejects.toThrow(
        "Explicit --base/--head or --working-tree is required",
      );
      const diff = await analyzeDiff({ repoRoot: root, base, workingTree: true });
      expect(diff.impact.authTouched).toBe(true);
      expect(diff.impact.criticalSmoke).toBe(true);
      expect(diff.dirtyHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
