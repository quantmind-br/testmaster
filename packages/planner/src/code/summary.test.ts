import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256 } from "@testmaster/domain";
import { describe, expect, it } from "vitest";
import { analyzeDiff } from "./diff.js";
import { retainRelativeImports, summarizeCode } from "./summary.js";
import type { PythonCodeSummary } from "./types.js";

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "testmaster-planner-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  return root;
}
type PythonFile = PythonCodeSummary["files"][number];
/** A Python summary entry as the hardened runner emits it, with every fact list empty unless given. */
function pythonFile(path: string, facts: Partial<PythonFile> = {}): PythonFile {
  return {
    path,
    routes: [],
    routers: [],
    includes: [],
    calls: [],
    functions: [],
    imports: [],
    tests: [],
    symbols: [],
    ...facts,
  };
}
/** A manifest that makes the repository root a Next.js project. */
const NEXT_MANIFEST = '{"dependencies":{"next":"15.0.0"}}\n';
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
      await writeFile(join(root, "package.json"), NEXT_MANIFEST);
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
                version: "1.1.0",
                files: [
                  pythonFile("api.py", {
                    routes: [
                      {
                        framework: "fastapi",
                        method: "GET",
                        path: "/python",
                        handler: "health",
                        line: 1,
                        router: null,
                      },
                    ],
                  }),
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
  it("reports FastAPI routes under the prefixes of the routers and includes that reach them", async () => {
    const root = await repo();
    try {
      const sources = {
        "app/main.py": "# create_app(): FastAPI(), include_router(...)\n",
        "app/routes/auth.py": "# create_auth_router(): APIRouter() with POST /login\n",
        "app/routes/sessions/__init__.py":
          "# create_sessions_router() registers the events routes\n",
        "app/routes/sessions/events.py": "# register_events_routes(router: APIRouter)\n",
        "app/routes/legacy.py": "# router = APIRouter(prefix='/legacy')\n",
        "app/routes/orphan.py": "# router = APIRouter(prefix='/orphan'), never included\n",
      };
      for (const [path, text] of Object.entries(sources)) {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), text);
      }
      const route = (method: string, path: string, handler: string, line: number, router: number) =>
        ({ framework: "fastapi", method, path, handler, line, router }) as const;
      const router = (id: number, name: string, prefix: string | null, module = false) => ({
        id,
        kind: "router" as const,
        name,
        line: 4,
        prefix,
        module,
      });
      const summary = await summarizeCode(root, {
        pythonRunner: {
          async summarize(_repoRoot, files) {
            expect([...files].sort()).toEqual(Object.keys(sources).sort());
            return {
              available: true,
              summary: {
                version: "1.1.0",
                files: [
                  pythonFile("app/main.py", {
                    routers: [{ ...router(0, "app", ""), kind: "app" }],
                    includes: [
                      {
                        parent: 0,
                        child: { name: "create_auth_router", call: true },
                        prefix: "/auth",
                        line: 7,
                      },
                      {
                        parent: 0,
                        child: { name: "sessions.create_sessions_router", call: true },
                        prefix: "/v1",
                        line: 8,
                      },
                      {
                        parent: 0,
                        child: { name: "legacy.router", call: false },
                        prefix: null,
                        line: 9,
                      },
                    ],
                    imports: [
                      {
                        local: "create_auth_router",
                        module: "app.routes.auth",
                        name: "create_auth_router",
                        level: 0,
                      },
                      { local: "sessions", module: "app.routes", name: "sessions", level: 0 },
                      { local: "legacy", module: "routes", name: "legacy", level: 1 },
                    ],
                  }),
                  pythonFile("app/routes/auth.py", {
                    routers: [router(0, "router", "")],
                    routes: [route("POST", "/login", "login", 6, 0)],
                    functions: [
                      {
                        name: "create_auth_router",
                        parameters: [],
                        routerParameters: {},
                        returns: [0],
                      },
                    ],
                  }),
                  pythonFile("app/routes/sessions/__init__.py", {
                    routers: [router(0, "router", "")],
                    calls: [
                      {
                        callee: "register_events_routes",
                        arguments: [{ router: 0, index: 0, keyword: null }],
                        line: 6,
                      },
                    ],
                    functions: [
                      {
                        name: "create_sessions_router",
                        parameters: [],
                        routerParameters: {},
                        returns: [0],
                      },
                    ],
                    imports: [
                      {
                        local: "register_events_routes",
                        module: "app.routes.sessions.events",
                        name: "register_events_routes",
                        level: 0,
                      },
                    ],
                  }),
                  pythonFile("app/routes/sessions/events.py", {
                    routers: [
                      { ...router(0, "router", ""), kind: "parameter" },
                      router(1, "event_router", "/events"),
                    ],
                    routes: [
                      route("GET", "/{session_id}", "read_event", 6, 1),
                      route("GET", "/sessions", "list_sessions", 9, 0),
                    ],
                    includes: [{ parent: 0, child: { router: 1 }, prefix: "", line: 12 }],
                    functions: [
                      {
                        name: "register_events_routes",
                        parameters: ["router"],
                        routerParameters: { router: 0 },
                        returns: [],
                      },
                    ],
                  }),
                  pythonFile("app/routes/legacy.py", {
                    routers: [router(0, "router", "/legacy", true)],
                    routes: [route("GET", "/ping", "ping", 6, 0)],
                  }),
                  pythonFile("app/routes/orphan.py", {
                    routers: [router(0, "router", "/orphan", true)],
                    routes: [route("GET", "/x", "orphan", 6, 0)],
                  }),
                ],
                diagnostics: [],
              },
            };
          },
        },
      });
      expect(
        summary.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).sort(),
      ).toEqual([
        "GET /legacy/ping",
        "GET /orphan/x",
        "GET /v1/events/{session_id}",
        "GET /v1/sessions",
        "POST /auth/login",
      ]);
      expect(summary.endpoints.find((endpoint) => endpoint.handler === "login")?.ref).toMatchObject(
        {
          path: "app/routes/auth.py",
          line: 6,
        },
      );
      // An unresolvable include prefix and a router nobody includes are declared, never guessed.
      expect(summary.warnings.filter((warning) => warning.code.startsWith("fastapi_"))).toEqual([
        expect.objectContaining({
          code: "fastapi_prefix_unresolved",
          path: "app/routes/legacy.py",
        }),
        expect.objectContaining({ code: "fastapi_router_unmounted", path: "app/routes/orphan.py" }),
      ]);
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
  it("analyzes a file whose only NUL byte lies past the first 8000 bytes", async () => {
    const root = await repo();
    try {
      const padding = "// padding\n".repeat(800);
      expect(Buffer.byteLength(padding)).toBeGreaterThan(8000);
      await writeFile(join(root, "late.ts"), `${padding}export const SEP = "a\0b";\n`);
      const summary = await summarizeCode(root);
      expect(summary.scannedFiles).toContain("late.ts");
      expect(summary.skippedFiles).not.toContainEqual({ path: "late.ts", reason: "binary" });
      expect(summary.symbols.map((symbol) => symbol.name)).toContain("SEP");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("analyzes a source file with a literal NUL near its start and skips non-text bytes as binary", async () => {
    const root = await repo();
    try {
      // OmniRoute's serviceKindIndex.ts: a NUL separator inside a template literal at byte 857.
      await writeFile(
        join(root, "index.ts"),
        'export function key(id: string, declared: string[]) {\n  return `${id}\0${declared.join(",")}`;\n}\n',
      );
      // A one-line file whose separator is a NUL (about 4% of its bytes).
      await writeFile(join(root, "sep.ts"), 'export const SEP = "\0";\n');
      // UTF-16 source is half NULs; an MPEG transport stream named .ts is not UTF-8 (no NUL here).
      await writeFile(join(root, "wide.ts"), Buffer.from("export const wide = 1;\n", "utf16le"));
      await writeFile(
        join(root, "video.ts"),
        Buffer.from([0x47, 0x40, 0x11, 0x10, 0xff, 0xfe, 0x80]),
      );
      const summary = await summarizeCode(root);
      expect([...summary.scannedFiles].sort()).toEqual(["index.ts", "sep.ts"]);
      expect(summary.symbols.map((symbol) => symbol.name)).toEqual(
        expect.arrayContaining(["key", "SEP"]),
      );
      expect(summary.skippedFiles).toEqual(
        expect.arrayContaining([
          { path: "wide.ts", reason: "binary" },
          { path: "video.ts", reason: "binary" },
        ]),
      );
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
      await writeFile(join(root, "package.json"), NEXT_MANIFEST);
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
      await writeFile(join(root, "package.json"), NEXT_MANIFEST);
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
      await writeFile(join(root, "package.json"), NEXT_MANIFEST);
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
      await writeFile(join(root, "package.json"), NEXT_MANIFEST);
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
  it("records React Router routes with their full paths and ignores fixtures", async () => {
    const root = await repo();
    try {
      await mkdir(join(root, "web", "src"), { recursive: true });
      await writeFile(
        join(root, "web", "src", "App.tsx"),
        [
          'import { Navigate, Route, Routes } from "react-router-dom";',
          "export default function App({ basename }: { basename?: string }) {",
          '  const prefix = basename ?? "";',
          "  return (",
          "    <Routes>",
          "      {accounts && (",
          "        <>",
          "          <Route path={`${prefix}/login`} element={<LoginPage />} />",
          "        </>",
          "      )}",
          '      <Route path="approve/:sessionId" element={<ApprovePage />} />',
          "      <Route element={<AppShell />}>",
          '        <Route path={prefix || "/"} element={<ChatPage />} />',
          "        <Route path={`${prefix}/c/:conversationId`} element={<ChatPage />} />",
          '        <Route path={`${prefix}/settings`} element={<Navigate to="/settings/general" />} />',
          "        <Route path={`${prefix}/settings/:section/:subSection?`} element={<SettingsPage />} />",
          "        <Route path={`${prefix}/extensions/:id/*`} element={<ExtensionPage />} />",
          '        <Route path="team" element={<TeamLayout />}>',
          "          <Route index element={<TeamHome />} />",
          '          <Route path="members" element={<Members />} />',
          "        </Route>",
          '        <Route path={basename ? `${prefix}/*` : "*"} element={<NotFoundPage />} />',
          "        <Route path={dynamicPath()} element={<Dynamic />} />",
          "      </Route>",
          "    </Routes>",
          "  );",
          "}",
          "",
        ].join("\n"),
      );
      // Fixtures and look-alikes: a memory-router test, and a `Route` that is not React Router's.
      await writeFile(
        join(root, "web", "src", "App.test.tsx"),
        'import { Route, Routes } from "react-router-dom";\nexport const Fixture = () => <Routes><Route path="/fixture" element={null} /></Routes>;\n',
      );
      await writeFile(
        join(root, "web", "src", "Other.tsx"),
        'import { Route } from "./Route";\nexport const Other = () => <Route path="/other" />;\n',
      );
      const summary = await summarizeCode(root);
      const found = summary.routes.filter((route) => route.framework === "react-router");
      expect(found.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
        "GET /",
        "GET /approve/{sessionId}",
        "GET /c/{conversationId}",
        "GET /extensions/{id}/{splat}",
        "GET /login",
        "GET /settings",
        "GET /settings/{section}",
        "GET /settings/{section}/{subSection}",
        "GET /team",
        "GET /team/members",
      ]);
      expect(new Set(found.map((route) => route.ref.path))).toEqual(new Set(["web/src/App.tsx"]));
      expect(found.find((route) => route.path === "/login")?.ref.line).toBe(8);
      expect(summary.warnings).toContainEqual(
        expect.objectContaining({
          path: "web/src/App.tsx",
          code: "route_path_unresolved",
          message: expect.stringContaining("line 23"),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("derives file routes only inside Next.js projects and never from test, spec or story files", async () => {
    const root = await repo();
    try {
      // A Vite SPA: `pages/` holds components and their tests, and `next` is not a dependency.
      await mkdir(join(root, "web", "src", "pages"), { recursive: true });
      await writeFile(
        join(root, "web", "package.json"),
        '{"dependencies":{"react":"19.0.0","react-router-dom":"7.0.0"}}\n',
      );
      for (const name of ["LoginPage.tsx", "LoginPage.test.tsx"])
        await writeFile(
          join(root, "web", "src", "pages", name),
          "export default function LoginPage() { return null; }\n",
        );
      // A Next.js project: pages and an App Router page are routes, their tests and stories are not.
      await mkdir(join(root, "site", "pages", "__tests__"), { recursive: true });
      await mkdir(join(root, "site", "app", "dashboard"), { recursive: true });
      await mkdir(join(root, "site", "components", "pages"), { recursive: true });
      await writeFile(join(root, "site", "package.json"), NEXT_MANIFEST);
      for (const path of [
        "pages/login.tsx",
        "pages/login.test.tsx",
        "pages/login.spec.tsx",
        "pages/login.stories.tsx",
        "pages/__tests__/login.tsx",
        "app/dashboard/page.tsx",
        "app/dashboard/page.test.tsx",
        "components/pages/Widget.tsx",
      ])
        await writeFile(
          join(root, "site", path),
          "export default function Page() { return null; }\n",
        );
      // `next.config.*` marks a project without a manifest; no signal at all marks none.
      await mkdir(join(root, "config", "pages"), { recursive: true });
      await mkdir(join(root, "loose", "pages"), { recursive: true });
      await writeFile(join(root, "config", "next.config.js"), "module.exports = {};\n");
      await writeFile(
        join(root, "config", "pages", "about.tsx"),
        "export default function About() { return null; }\n",
      );
      await writeFile(
        join(root, "loose", "pages", "about.tsx"),
        "export default function About() { return null; }\n",
      );
      const summary = await summarizeCode(root);
      expect(
        summary.routes.map((route) => `${route.framework} ${route.path} ${route.ref.path}`).sort(),
      ).toEqual([
        "next /about config/pages/about.tsx",
        "next /dashboard site/app/dashboard/page.tsx",
        "next /login site/pages/login.tsx",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("records no Express or Python endpoint declared in a test file", async () => {
    const root = await repo();
    try {
      await mkdir(join(root, "tests"), { recursive: true });
      await mkdir(join(root, "e2e", "fixtures"), { recursive: true });
      await mkdir(join(root, "fixtures"), { recursive: true });
      const express =
        "import express from 'express'; const app = express(); app.get('/stub', () => 1);\n";
      await writeFile(join(root, "server.ts"), express.replace("/stub", "/health"));
      await writeFile(join(root, "server.test.ts"), express);
      await writeFile(join(root, "fixtures", "api.ts"), express.replace("/stub", "/fixture-api"));
      const httpServer = (path: string) =>
        `import { createServer } from 'node:http';\ncreateServer((req, res) => { if (req.url === '${path}') res.end(); });\n`;
      await writeFile(join(root, "status.ts"), httpServer("/status"));
      // An e2e fixture server, like Omnigent's web/electron/e2e/fixtures/designModalFixture.js.
      await writeFile(join(root, "e2e", "fixtures", "modal.js"), httpServer("/modal"));
      await writeFile(join(root, "api.py"), "# FastAPI app\n");
      await writeFile(join(root, "tests", "test_api.py"), "# FastAPI app used by a test\n");
      const route = (path: string) => ({
        framework: "fastapi" as const,
        method: "GET",
        path,
        handler: "handler",
        line: 1,
        router: null,
      });
      const summary = await summarizeCode(root, {
        pythonRunner: {
          async summarize() {
            return {
              available: true,
              summary: {
                version: "1.1.0",
                files: [
                  pythonFile("api.py", { routes: [route("/python")] }),
                  pythonFile("tests/test_api.py", { routes: [route("/python-fixture")] }),
                ],
                diagnostics: [],
              },
            };
          },
        },
      });
      expect(summary.endpoints.map((endpoint) => endpoint.path).sort()).toEqual([
        "/health",
        "/python",
      ]);
      expect(summary.routes.map((route) => route.path)).toEqual(["/status"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("reads every source file however many bytes the repository holds", async () => {
    const root = await repo();
    try {
      await mkdir(join(root, "src"), { recursive: true });
      // 28 files of 1 MB: over the former 25 MiB total-bytes limit, which skipped the last ones.
      const comment = `// ${"x".repeat(999_990)}\n`;
      for (let index = 0; index < 28; index++)
        await writeFile(join(root, "src", `file-${String(index).padStart(2, "0")}.ts`), comment);
      await writeFile(join(root, "src", "zz-last.ts"), "export const last = 1;\n");
      const summary = await summarizeCode(root);
      expect(summary.skippedFiles.map((file) => file.reason)).not.toContain("total_byte_limit");
      expect(summary.scannedFiles).toHaveLength(29);
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
      // `.testmaster/` is always excluded; a custom data directory is excluded only via `dataDir`.
      const dataDir = join(root, "tm-data");
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
