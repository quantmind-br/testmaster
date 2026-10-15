import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256 } from "@testmaster/domain";
import { describe, expect, it } from "vitest";
import { analyzeDiff } from "./diff.js";
import { retainRelativeImports, summarizeCode } from "./summary.js";

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
  it("labels non-code files unsupported_type and warns when nothing was analyzable", async () => {
    const root = await repo();
    const control = await repo();
    try {
      await writeFile(join(root, "main.go"), "package main\n");
      await writeFile(join(root, "README.md"), "# Notes\n");
      await writeFile(join(root, "Makefile"), "all:\n");
      const summary = await summarizeCode(root);
      expect(summary.scannedFiles).toEqual([]);
      expect(summary.skippedFiles).toEqual(
        expect.arrayContaining([
          { path: "main.go", reason: "unsupported_type" },
          { path: "README.md", reason: "unsupported_type" },
          { path: "Makefile", reason: "unsupported_type" },
        ]),
      );
      expect(summary.warnings).toContainEqual(
        expect.objectContaining({ path: "", code: "no_analyzable_files" }),
      );
      await writeFile(join(control, "a.js"), "export const a = 1;\n");
      const controlSummary = await summarizeCode(control);
      expect(controlSummary.scannedFiles).toEqual(["a.js"]);
      expect(controlSummary.warnings.map((warning) => warning.code)).not.toContain(
        "no_analyzable_files",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(control, { recursive: true, force: true });
    }
  });
  it("reports NUL-containing allowlisted files as binary", async () => {
    const root = await repo();
    try {
      await writeFile(join(root, "blob.js"), Buffer.from([0x61, 0, 0x62]));
      const summary = await summarizeCode(root);
      expect(summary.skippedFiles).toContainEqual({ path: "blob.js", reason: "binary" });
      expect(summary.scannedFiles).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("caps symbols per file and per run and reports symbols_truncated", async () => {
    const root = await repo();
    try {
      const declarations = (prefix: string, count: number) =>
        Array.from({ length: count }, (_, index) => `export const ${prefix}${index} = ${index};`);
      await writeFile(join(root, "a.ts"), `${declarations("a", 12).join("\n")}\n`);
      await writeFile(join(root, "b.ts"), `${declarations("b", 3).join("\n")}\n`);
      const perFile = await summarizeCode(root, { maxSymbolsPerFile: 5 });
      expect(perFile.symbols.filter((symbol) => symbol.ref.path === "a.ts")).toHaveLength(5);
      expect(perFile.symbols.filter((symbol) => symbol.ref.path === "b.ts")).toHaveLength(3);
      const truncated = perFile.warnings.filter((warning) => warning.code === "symbols_truncated");
      expect(truncated).toHaveLength(1);
      expect(truncated[0]).toMatchObject({ path: "" });
      expect(truncated[0]?.message).toContain("Kept 8 of 15 symbols");
      const perRun = await summarizeCode(root, { maxSymbols: 10 });
      expect(perRun.symbols).toHaveLength(10);
      expect(perRun.warnings.map((warning) => warning.code)).toContain("symbols_truncated");
      // Positive control: under the caps nothing is dropped and no warning is raised.
      const unbounded = await summarizeCode(root);
      expect(unbounded.symbols).toHaveLength(15);
      expect(unbounded.warnings.map((warning) => warning.code)).not.toContain("symbols_truncated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps only relative imports and declares the cap with imports_truncated", async () => {
    const root = await repo();
    try {
      await writeFile(
        join(root, "a.ts"),
        "import express from 'express';\nimport { b } from './b';\nimport { c } from '../c';\nexport const a = b + c;\n",
      );
      const summary = await summarizeCode(root);
      expect(summary.imports.map((item) => item.source)).toEqual(["express", "./b", "../c"]);
      retainRelativeImports(summary, 1);
      expect(summary.imports.map((item) => item.source)).toEqual(["./b"]);
      expect(summary.warnings).toContainEqual(
        expect.objectContaining({ path: "", code: "imports_truncated" }),
      );
      // Negative control: within the cap only the non-relative specifier is dropped, silently.
      const within = await summarizeCode(root);
      retainRelativeImports(within);
      expect(within.imports.map((item) => item.source)).toEqual(["./b", "../c"]);
      expect(within.warnings.map((warning) => warning.code)).not.toContain("imports_truncated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("skips a file over the size limit as oversize instead of failing the analysis", async () => {
    const root = await repo();
    try {
      await writeFile(join(root, "small.js"), "export const small = 1;\n");
      await writeFile(join(root, "big.js"), `export const big = "${"x".repeat(4096)}";\n`);
      const summary = await summarizeCode(root, { maxFileBytes: 1024 });
      expect(summary.scannedFiles).toEqual(["small.js"]);
      expect(summary.skippedFiles).toContainEqual({ path: "big.js", reason: "oversize" });
      expect(summary.skippedFiles.map((item) => item.reason)).not.toContain("analysis_failed");
      expect(summary.warnings.map((warning) => warning.code)).not.toContain("analysis_failed");
      // Positive control: within the limit the same file is analyzed.
      expect((await summarizeCode(root)).scannedFiles).toEqual(["big.js", "small.js"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("reads App Router route handlers per exported HTTP method", async () => {
    const root = await repo();
    try {
      await mkdir(join(root, "app", "api", "items"), { recursive: true });
      await mkdir(join(root, "lib"), { recursive: true });
      await writeFile(
        join(root, "app", "api", "items", "route.ts"),
        [
          "export const runtime = 'edge';",
          "async function helper() { return 1; }",
          "export async function GET() { return Response.json(await helper()); }",
          "export const POST = async () => new Response();",
          "const handler = () => new Response();",
          "export { handler as DELETE };",
          "export function Widget() { return null; }",
          "",
        ].join("\n"),
      );
      // Negative control: the same export outside a route file is not an endpoint.
      await writeFile(join(root, "lib", "handlers.ts"), "export function GET() { return 1; }\n");
      const summary = await summarizeCode(root);
      const served = summary.endpoints
        .filter((endpoint) => endpoint.framework === "next")
        .map((endpoint) => ({
          method: endpoint.method,
          path: endpoint.path,
          handler: endpoint.handler,
        }));
      expect(served).toEqual([
        { method: "GET", path: "/api/items", handler: "GET" },
        { method: "POST", path: "/api/items", handler: "POST" },
        { method: "DELETE", path: "/api/items", handler: "handler" },
      ]);
      expect(
        summary.endpoints.some(
          (endpoint) => endpoint.path === "/api/items" && endpoint.ref.line === 3,
        ),
      ).toBe(true);
      expect(summary.routes.map((route) => route.method)).not.toContain("UNKNOWN");
      expect(summary.routes.some((route) => route.path === "/api/items")).toBe(false);
      expect(summary.endpoints.some((endpoint) => endpoint.ref.path === "lib/handlers.ts")).toBe(
        false,
      );
      expect(summary.warnings.map((warning) => warning.code)).not.toContain(
        "route_methods_unresolved",
      );
      // Components never come from route files.
      expect(summary.features.map((feature) => feature.name)).not.toContain("Widget");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("resolves re-exported route methods and warns instead of guessing for export *", async () => {
    const root = await repo();
    try {
      await mkdir(join(root, "app", "a"), { recursive: true });
      await mkdir(join(root, "app", "b"), { recursive: true });
      await mkdir(join(root, "app", "c"), { recursive: true });
      await writeFile(
        join(root, "app", "a", "route.ts"),
        "export { GET, 'POST' as PUT } from './handlers';\n",
      );
      await writeFile(join(root, "app", "b", "route.ts"), "export * from './handlers';\n");
      await writeFile(
        join(root, "app", "c", "route.ts"),
        "export const dynamic = 'force-dynamic';\n",
      );
      const summary = await summarizeCode(root);
      expect(
        summary.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).sort(),
      ).toEqual(["GET /a", "PUT /a"]);
      const unresolved = summary.warnings.filter(
        (warning) => warning.code === "route_methods_unresolved",
      );
      expect(unresolved.map((warning) => warning.path).sort()).toEqual([
        "app/b/route.ts",
        "app/c/route.ts",
      ]);
      expect(summary.routes).toEqual([]);
      expect(summary.endpoints.some((endpoint) => endpoint.path === "/b")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("records node-http comparisons only in files that serve HTTP, with the method of the same condition", async () => {
    const root = await repo();
    try {
      await mkdir(join(root, "app", "lib"), { recursive: true });
      await mkdir(join(root, "components"), { recursive: true });
      await mkdir(join(root, "scripts"), { recursive: true });
      await writeFile(
        join(root, "server.js"),
        [
          "import { createServer } from 'node:http';",
          "createServer((req, res) => {",
          "  const path = req.url;",
          "  const method = req.method;",
          "  if (path === '/health' && req.method === 'GET') return res.end('ok');",
          "  if (method === 'POST' && path === '/orders') return res.end('created');",
          "  if (path === '/status') return res.end('up');",
          "  if (req.method === 'GET') { if (path === '/nested') return res.end('n'); }",
          "});",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(root, "legacy.cjs"),
        [
          "const http = require('http');",
          "http.createServer((req, res) => { if (req.url === '/x') res.end(); const route = req.url; if (route === '/ping') res.end('pong'); });",
          "",
        ].join("\n"),
      );
      // Negative controls: same comparison, but none of these files is a Node HTTP server.
      await writeFile(
        join(root, "scripts", "cli.js"),
        "import https from 'node:https';\nexport function build(path) { return path === '/v1/models' ? 1 : 2; }\n",
      );
      await writeFile(
        join(root, "scripts", "client.ts"),
        "export function pick(pathname: string) { return pathname === '/api/settings'; }\n",
      );
      await writeFile(
        join(root, "components", "Widget.tsx"),
        "import { createServer } from 'node:http';\ncreateServer();\nexport function Widget({ path }) { return path === '/' ? <b /> : null; }\n",
      );
      await writeFile(
        join(root, "app", "lib", "server.ts"),
        "import { createServer } from 'node:http';\ncreateServer((req) => { const path = req.url; return path === '/inside-app'; });\n",
      );
      const summary = await summarizeCode(root);
      expect(
        summary.routes.map((route) => `${route.framework} ${route.method} ${route.path}`).sort(),
      ).toEqual([
        "node-http GET /health",
        "node-http POST /orders",
        "node-http UNKNOWN /nested",
        "node-http UNKNOWN /ping",
        "node-http UNKNOWN /status",
        "node-http UNKNOWN /x",
      ]);
      expect(new Set(summary.routes.map((route) => route.ref.path))).toEqual(
        new Set(["server.js", "legacy.cjs"]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("never records node-http routes from test files, only the same stub server in application code", async () => {
    const root = await repo();
    try {
      await mkdir(join(root, "tests", "unit"), { recursive: true });
      await mkdir(join(root, "src", "__tests__"), { recursive: true });
      await mkdir(join(root, "server"), { recursive: true });
      const stub = [
        "import { createServer } from 'node:http';",
        "export const stub = createServer((req, res) => {",
        "  const path = new URL(req.url, 'http://x').pathname;",
        "  if (path === '/v1/models' && req.method === 'GET') return res.end('[]');",
        "});",
        "",
      ].join("\n");
      await writeFile(join(root, "tests", "unit", "x.test.ts"), stub);
      await writeFile(join(root, "src", "__tests__", "y.ts"), stub);
      await writeFile(join(root, "src", "z.spec.js"), stub);
      await writeFile(join(root, "server", "index.ts"), stub);
      const summary = await summarizeCode(root);
      expect(
        summary.routes.map((route) => `${route.ref.path} ${route.method} ${route.path}`),
      ).toEqual(["server/index.ts GET /v1/models"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("reads member pathname and url comparisons in either operand order, within the server-file gate", async () => {
    const root = await repo();
    try {
      await mkdir(join(root, "server"), { recursive: true });
      await mkdir(join(root, "lib"), { recursive: true });
      await writeFile(
        join(root, "server", "index.js"),
        [
          "import http from 'node:http';",
          "http.createServer((req, res) => {",
          "  const url = new URL(req.url, 'http://localhost');",
          "  if (url.pathname === '/a' && req.method === 'POST') return res.end('a');",
          "  if (req.url === '/b') return res.end('b');",
          "  if ('/rev' === req.url && req.method === 'DELETE') return res.end('r');",
          "  if (new URL(req.url, 'http://x').pathname === '/inline') return res.end('i');",
          "  if (req.url === '/c?x=1') return res.end('query');",
          "  if (req.url === '/' + 'dynamic') return res.end('dynamic');",
          "  if (req.url === other) return res.end('identifier');",
          "  if (url.search === '/ignored') return res.end('search');",
          "});",
          "",
        ].join("\n"),
      );
      // Negative control: the same comparisons in a file that does not serve HTTP.
      await writeFile(
        join(root, "lib", "client.js"),
        "export function pick(url, req) { return url.pathname === '/client' || req.url === '/client2'; }\n",
      );
      const summary = await summarizeCode(root);
      expect(summary.routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
        "DELETE /rev",
        "POST /a",
        "UNKNOWN /b",
        "UNKNOWN /inline",
      ]);
      expect(new Set(summary.routes.map((route) => route.ref.path))).toEqual(
        new Set(["server/index.js"]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("resolves destructured route exports by the names they bind and warns only when none resolves", async () => {
    const root = await repo();
    try {
      for (const name of ["search", "rename", "rest", "all"])
        await mkdir(join(root, "app", name), { recursive: true });
      await writeFile(
        join(root, "app", "search", "route.ts"),
        "export const { GET, POST } = createFromSource(source);\n",
      );
      // `{ handler: PUT }` binds PUT; `{ GET: renamed }` binds `renamed`, which is no HTTP method.
      await writeFile(
        join(root, "app", "rename", "route.ts"),
        "export const { handler: PUT, GET: renamed, ...others } = factory();\n",
      );
      await writeFile(
        join(root, "app", "rest", "route.ts"),
        "export const { ...others } = factory();\n",
      );
      await writeFile(join(root, "app", "all", "route.ts"), "export * from './handlers';\n");
      const summary = await summarizeCode(root);
      expect(
        summary.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).sort(),
      ).toEqual(["GET /search", "POST /search", "PUT /rename"]);
      expect(summary.endpoints.find((endpoint) => endpoint.path === "/rename")?.handler).toBe(
        "PUT",
      );
      expect(
        summary.warnings
          .filter((warning) => warning.code === "route_methods_unresolved")
          .map((warning) => warning.path)
          .sort(),
      ).toEqual(["app/all/route.ts", "app/rest/route.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("normalizes dynamic Next segments and does not invent a method for Pages API files", async () => {
    const root = await repo();
    try {
      await mkdir(join(root, "app", "products", "[id]"), { recursive: true });
      await mkdir(join(root, "app", "docs", "[...slug]"), { recursive: true });
      await mkdir(join(root, "app", "shop", "[[...rest]]"), { recursive: true });
      await mkdir(join(root, "app", "@modal", "photo"), { recursive: true });
      await mkdir(join(root, "pages", "api"), { recursive: true });
      await writeFile(
        join(root, "app", "products", "[id]", "route.ts"),
        "export const GET = () => 1;\n",
      );
      await writeFile(
        join(root, "app", "docs", "[...slug]", "page.tsx"),
        "export default function Docs() { return null; }\n",
      );
      await writeFile(
        join(root, "app", "shop", "[[...rest]]", "page.tsx"),
        "export default function Shop() { return null; }\n",
      );
      await writeFile(
        join(root, "app", "@modal", "photo", "page.tsx"),
        "export default function Photo() { return null; }\n",
      );
      await writeFile(
        join(root, "pages", "api", "legacy.ts"),
        "export default function handler() {}\n",
      );
      const summary = await summarizeCode(root);
      expect(summary.endpoints).toContainEqual(
        expect.objectContaining({ framework: "next", method: "GET", path: "/products/{id}" }),
      );
      expect(summary.routes.map((route) => route.path).sort()).toEqual([
        "/docs/{slug}",
        "/photo",
        "/shop/{rest}",
      ]);
      expect(summary.routes.some((route) => route.path.startsWith("/api"))).toBe(false);
      expect(summary.warnings).toContainEqual(
        expect.objectContaining({ path: "pages/api/legacy.ts", code: "route_methods_unresolved" }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("lists exported components only as features", async () => {
    const root = await repo();
    try {
      await mkdir(join(root, "components"), { recursive: true });
      await writeFile(
        join(root, "components", "Card.tsx"),
        [
          "function Helper() { return null; }",
          "const Hidden = () => null;",
          "const Listed = () => null;",
          "export function Card() { return <div />; }",
          "export const Badge = () => <span />;",
          "export { Listed };",
          "export default function Panel() { return null; }",
          "export function render() { function Inner() { return null; } return Inner; }",
          "",
        ].join("\n"),
      );
      const summary = await summarizeCode(root);
      expect(summary.features.map((feature) => feature.name).sort()).toEqual([
        "Badge",
        "Card",
        "Listed",
        "Panel",
      ]);
      expect(summary.features.every((feature) => feature.kind === "component")).toBe(true);
      // Non-exported functions remain symbols, so the cut is on features and not on discovery.
      expect(summary.symbols.map((symbol) => symbol.name)).toEqual(
        expect.arrayContaining(["Helper", "Hidden", "Inner"]),
      );
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
  it("rejects an unknown base or head ref as INVALID_ARGUMENT naming the ref", async () => {
    const root = await repo();
    try {
      await writeFile(join(root, "a.js"), "export const a = 1;\n");
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
      await expect(
        analyzeDiff({ repoRoot: root, base: "no-such-base", head: "HEAD" }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining("no-such-base"),
        details: { role: "base" },
      });
      await expect(
        analyzeDiff({ repoRoot: root, base: "HEAD", head: "no-such-head" }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining("no-such-head"),
        details: { role: "head" },
      });
      await expect(analyzeDiff({ repoRoot: root, base: "HEAD", head: "HEAD" })).resolves.toEqual(
        expect.objectContaining({ changes: expect.any(Array) }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("never reads the project data directory when hashing the working tree", async () => {
    const root = await repo();
    try {
      await writeFile(join(root, "a.js"), "export const a = 1;\n");
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
      const dataDir = join(root, ".testmaster");
      await mkdir(dataDir);
      await writeFile(join(dataDir, "testmaster.db"), "database");
      // Positive control 1: without the exclusion a change inside the data directory moves the hash.
      const listed = await analyzeDiff({ repoRoot: root, base: "HEAD", workingTree: true });
      await writeFile(join(dataDir, "testmaster.db"), "database with more bytes");
      const relisted = await analyzeDiff({ repoRoot: root, base: "HEAD", workingTree: true });
      expect(relisted.dirtyHash).not.toBe(listed.dirtyHash);
      // Positive control 2: an unreadable file is listed by git and fails with EACCES when read.
      // Root ignores file modes, so skip it there.
      if (process.getuid?.() !== 0) {
        const unreadable = join(dataDir, "locked.bin");
        await writeFile(unreadable, "locked");
        await chmod(unreadable, 0o000);
        await expect(
          analyzeDiff({ repoRoot: root, base: "HEAD", workingTree: true }),
        ).rejects.toMatchObject({ code: "EACCES" });
      }
      const clean = await analyzeDiff({ repoRoot: root, base: "HEAD", workingTree: true, dataDir });
      expect(clean.changes).toEqual([]);
      await writeFile(join(dataDir, "testmaster.db"), "database changed");
      const again = await analyzeDiff({ repoRoot: root, base: "HEAD", workingTree: true, dataDir });
      expect(again.dirtyHash).toBe(clean.dirtyHash);
      expect(again.fingerprint).toBe(clean.fingerprint);
      await writeFile(join(root, "b.js"), "export const b = 1;\n");
      const dirty = await analyzeDiff({ repoRoot: root, base: "HEAD", workingTree: true, dataDir });
      expect(dirty.changes).toEqual([{ status: "A", path: "b.js" }]);
      expect(dirty.dirtyHash).not.toBe(clean.dirtyHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("hashes an untracked file over the old size limit by streaming, with the same digest", async () => {
    const root = await repo();
    try {
      await writeFile(join(root, "a.js"), "export const a = 1;\n");
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
      const size = 26 * 1024 * 1024;
      const dump = join(root, "dump.js");
      const created = await open(dump, "w");
      await created.truncate(size);
      await created.close();
      const digest = createHash("sha256").update(Buffer.alloc(size)).digest("hex");
      const first = await analyzeDiff({ repoRoot: root, base: "HEAD", workingTree: true });
      expect(first.changes).toEqual([{ status: "A", path: "dump.js" }]);
      expect(first.dirtyHash).toBe(
        sha256(canonicalJson([{ path: "dump.js", contentHash: digest }])),
      );
      const edited = await open(dump, "r+");
      await edited.write(Buffer.from([1]), 0, 1, size - 1);
      await edited.close();
      const second = await analyzeDiff({ repoRoot: root, base: "HEAD", workingTree: true });
      expect(second.dirtyHash).not.toBe(first.dirtyHash);
      expect(second.fingerprint).not.toBe(first.fingerprint);
      // The summary reports the same file as oversize instead of aborting.
      const summary = await summarizeCode(root);
      expect(summary.scannedFiles).toEqual(["a.js"]);
      expect(summary.skippedFiles).toContainEqual({ path: "dump.js", reason: "oversize" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
