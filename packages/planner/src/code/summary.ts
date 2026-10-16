import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { parse } from "@babel/parser";
import { ContractError } from "@testmaster/contracts";
import { canonicalJson, sha256 } from "@testmaster/domain";
import ignore from "ignore";
import { resolvePythonRoutes } from "./python-routes.js";
import type { CodeRef, CodeSummary, CodeSummaryOptions, CodeSymbol } from "./types.js";

export const CODE_DETECTOR_VERSION = "1.8.0";
const DEFAULT_MAX_SYMBOLS_PER_FILE = 200;
const DEFAULT_MAX_SYMBOLS = 20_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });
/**
 * Source text of a file, or `null` when its bytes are binary. Text is valid UTF-8 in which NUL
 * bytes are at most a tenth of the bytes: a source file may carry a few literal NULs inside strings
 * (a join separator, a control-character fixture), even near its start or in a one-line file,
 * while UTF-16 text is about half NULs, zero-filled data is all NULs, and images, archives or MPEG
 * transport streams named `.ts` are not valid UTF-8.
 */
function sourceText(bytes: Uint8Array): string | null {
  let nul = 0;
  for (let at = bytes.indexOf(0); at !== -1; at = bytes.indexOf(0, at + 1))
    if (++nul * 10 > bytes.length) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}
/** Relative import specifiers stored per summary; see `retainRelativeImports`. */
export const MAX_RETAINED_IMPORTS = 20_000;
/** Per-run limits applied when `CodeSummaryOptions` does not set them. */
export const CODE_SUMMARY_DEFAULT_LIMITS = {
  maxFiles: 10_000,
  maxFileBytes: 1024 * 1024,
} as const;
const ROUTE_METHODS: Record<string, true> = {
  GET: true,
  HEAD: true,
  OPTIONS: true,
  POST: true,
  PUT: true,
  PATCH: true,
  DELETE: true,
};
const DEFAULT_IGNORES = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  "coverage/",
  ".testmaster/",
  ".venv/",
  "__pycache__/",
  ".env*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ed25519*",
  "*storageState*",
  "*storage-state*",
  "*.db",
  "*.sqlite*",
  "*.lock",
];
/**
 * Opens an admitted regular file, never a symlink or hardlink; the caller closes the handle.
 * `maxBytes` refuses larger files with PAYLOAD_TOO_LARGE before any byte is read.
 */
async function openConfinedRegularFile(root: string, path: string, maxBytes?: number) {
  const absolute = resolve(root, path);
  if (absolute === root || !absolute.startsWith(`${root}${sep}`))
    throw new ContractError("POLICY_DENIED", "File escapes repository", { path });
  const parent = await realpath(dirname(absolute));
  if (!parent.startsWith(`${root}${sep}`) && parent !== root)
    throw new ContractError("POLICY_DENIED", "Parent escapes repository", { path });
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1)
      throw new ContractError("POLICY_DENIED", "Non-regular or hardlinked input", { path });
    if (maxBytes !== undefined && stat.size > maxBytes)
      throw new ContractError("PAYLOAD_TOO_LARGE", "Code file exceeds limit", { path });
    // Verify the opened descriptor, not only its pathname, against concurrent directory swaps.
    const actual = await realpath(`/proc/self/fd/${handle.fd}`);
    if (!actual.startsWith(`${root}${sep}`))
      throw new ContractError("POLICY_DENIED", "Opened file escapes repository", { path });
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
/** Opens only an admitted regular file, never a symlink or hardlink. */
export async function readConfinedCodeFile(
  root: string,
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  const { handle } = await openConfinedRegularFile(root, path, maxBytes);
  try {
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes)
      throw new ContractError("PAYLOAD_TOO_LARGE", "Code file exceeds limit", { path });
    return bytes;
  } finally {
    await handle.close();
  }
}
/**
 * SHA-256 (hex) of an admitted regular file, streamed in bounded chunks with the same confinement
 * as `readConfinedCodeFile` and no size limit. The digest equals `sha256(await readFile(...))`.
 * A file that changes while it is read is refused rather than given an unreliable identity.
 */
export async function hashConfinedCodeFile(root: string, path: string): Promise<string> {
  const { handle, stat: before } = await openConfinedRegularFile(root, path);
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      highWaterMark: 1024 * 1024,
    }))
      hash.update(chunk);
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new ContractError("PRECONDITION_FAILED", "File changed while it was being hashed", {
        path,
      });
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
/** Default and configured exclusion rules of a code summary; `null` admits the path. */
export function createPathAdmission(
  excludes: readonly string[] = [],
): (path: string, directory?: boolean) => "default_exclude" | "config_exclude" | null {
  const defaults = ignore().add(DEFAULT_IGNORES);
  const configured = ignore().add([...excludes]);
  return (path, directory = false) => {
    const testPath = directory ? `${path}/` : path;
    return defaults.ignores(testPath)
      ? "default_exclude"
      : configured.ignores(testPath)
        ? "config_exclude"
        : null;
  };
}
/** True for the file types the summary reads (JS/TS family, `.html`, `.py`, `package.json`). */
export function analyzableCodeType(path: string): boolean {
  return (
    /\.(?:[cm]?[jt]sx?|py|html)$/iu.test(path) ||
    path === "package.json" ||
    path.endsWith("/package.json")
  );
}
/** Hash that binds a summary to the files, exclusions and skips it was computed from. */
export function computeManifestHash(
  summary: Pick<CodeSummary, "fileRefs" | "skippedFiles">,
  excludes: readonly string[] = [],
): string {
  return sha256(
    canonicalJson({
      detectorVersion: CODE_DETECTOR_VERSION,
      files: summary.fileRefs,
      excludes,
      skipped: summary.skippedFiles,
    }),
  );
}
/**
 * Keeps only relative import specifiers (the only ones the impact closure resolves; `techStack`
 * already keeps framework names) and bounds them. Call after any import-graph computation.
 */
export function retainRelativeImports(
  summary: CodeSummary,
  limit: number = MAX_RETAINED_IMPORTS,
): void {
  const relative = summary.imports.filter((item) => item.source.startsWith("."));
  summary.imports = relative.slice(0, limit);
  if (relative.length > summary.imports.length)
    summary.warnings.push({
      path: "",
      code: "imports_truncated",
      message: `Kept ${summary.imports.length} of ${relative.length} relative imports (limit ${limit}). Non-relative specifiers are not stored; techStack keeps framework names.`,
    });
}
interface AstNode {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start: { line: number } } | null;
  [key: string]: unknown;
}
function astNode(value: unknown): value is AstNode {
  return !!value && typeof value === "object" && "type" in value && typeof value.type === "string";
}
function literal(value: unknown): string | undefined {
  if (!astNode(value)) return undefined;
  if (value.type === "StringLiteral") return String(value.value);
  if (value.type === "Identifier" || value.type === "JSXIdentifier") return String(value.name);
  if (
    value.type === "TemplateLiteral" &&
    Array.isArray(value.expressions) &&
    value.expressions.length === 0 &&
    Array.isArray(value.quasis)
  )
    return value.quasis
      .map((q) =>
        astNode(q) && q.value && typeof q.value === "object" && "raw" in q.value
          ? String(q.value.raw)
          : "",
      )
      .join("");
  return undefined;
}
type NextRouteTarget = { kind: "page" | "route" | "api"; path: string };
/** `next.config.*` marks a Next.js project even where no manifest lists `next`. */
const NEXT_CONFIG_FILE = /^next\.config\.[cm]?[jt]s$/u;
/** Cheap prefilter: a source file under some `pages/` or `app/` directory. */
const NEXT_ROUTE_DIRECTORY = /(?:^|\/)(?:pages|app)\/.*\.[jt]sx?$/u;
/**
 * Next.js file-router target of a source path relative to its project root: a page, an App Router
 * handler or a Pages API file. `pages/` and `app/` count only at the project root or under `src/`.
 */
export function nextRouteTarget(path: string): NextRouteTarget | null {
  const next = /^(?:src\/)?(pages|app)\/(.*)\.[jt]sx?$/u.exec(path);
  if (!next?.[1] || !next[2]) return null;
  const route = next[2];
  if (next[1] === "pages" && /(?:^|\/)(?:_app|_document|_error)$/u.test(route)) return null;
  if (next[1] === "app" && !/(?:^|\/)(?:page|route)$/u.test(route)) return null;
  const segments = route
    .replace(/(?:^|\/)(?:index|page|route)$/u, "")
    .split("/")
    .filter((part) => part && !/^\(.+\)$/u.test(part) && !part.startsWith("@"))
    // `[id]` -> `{id}`, `[...slug]` and `[[...slug]]` -> `{slug}`, matching OpenAPI templating.
    .map((part) => {
      const dynamic = /^\[{1,2}(?:\.\.\.)?([^[\]]+)\]{1,2}$/u.exec(part);
      return dynamic?.[1] ? `{${dynamic[1]}}` : part;
    });
  const kind =
    next[1] === "pages" && (route === "api" || route.startsWith("api/"))
      ? "api"
      : next[1] === "app" && /(?:^|\/)route$/u.test(route)
        ? "route"
        : "page";
  return { kind, path: `/${segments.join("/")}` };
}
/** Modules whose `Route` component declares client routes. */
const REACT_ROUTER_MODULE = /^react-router(?:-dom|\/dom)?$/u;
/**
 * Test, spec and Storybook files (and anything under `__tests__/`) render pages inside memory
 * routers or beside the component they cover: fixtures, never application routes.
 */
const ROUTE_FIXTURE_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec|stories)\.[cm]?[jt]sx?$/u;
function templateText(quasi: unknown): string {
  if (!astNode(quasi) || !quasi.value || typeof quasi.value !== "object") return "";
  const { cooked, raw } = quasi.value as { cooked?: unknown; raw?: unknown };
  return String(cooked ?? raw ?? "");
}
/**
 * The literal values a `<Route path>` expression can take, or undefined when it cannot be resolved
 * statically. A leading identifier is the mount prefix of an embedded app (`${prefix}/login`,
 * `prefix || "/"`); it is empty when the app is served from the root, so it is dropped. A
 * conditional yields both branches only when both resolve.
 */
function routePathValues(node: unknown): string[] | undefined {
  if (!astNode(node)) return undefined;
  if (node.type === "StringLiteral") return [String(node.value)];
  if (node.type === "JSXExpressionContainer") return routePathValues(node.expression);
  if (node.type === "TemplateLiteral") {
    const quasis = Array.isArray(node.quasis) ? node.quasis : [];
    const expressions = Array.isArray(node.expressions) ? node.expressions : [];
    if (!expressions.length) return [quasis.map(templateText).join("")];
    const [prefix] = expressions;
    if (expressions.length === 1 && templateText(quasis[0]) === "" && astNode(prefix))
      return prefix.type === "Identifier" ? [templateText(quasis[1])] : undefined;
    return undefined;
  }
  if (node.type === "LogicalExpression" && ["||", "??"].includes(String(node.operator)))
    return astNode(node.left) && node.left.type === "Identifier"
      ? routePathValues(node.right)
      : undefined;
  if (node.type === "ConditionalExpression") {
    const branches = [routePathValues(node.consequent), routePathValues(node.alternate)];
    return branches.every((branch) => branch !== undefined)
      ? [...new Set(branches.flat() as string[])]
      : undefined;
  }
  return undefined;
}
/** A child `path` under its parent's full path: absolute when it starts with `/`. */
function joinRoutePath(parent: string, child: string): string {
  if (child.startsWith("/")) return child;
  return parent.endsWith("/") ? `${parent}${child}` : `${parent}/${child}`;
}
/**
 * Templated URL paths of a React Router pattern, as OpenAPI templating like the Next detector:
 * `:id` -> `{id}`, a splat `*` -> `{splat}`, an optional segment (`:id?`) yields the path with and
 * without it. The catch-all `*` that renders a not-found page is not a route and yields none.
 */
function reactRoutePatterns(pattern: string): string[] {
  const segments = pattern.split("/").filter(Boolean);
  if (segments.length === 1 && segments[0] === "*") return [];
  let paths: string[][] = [[]];
  for (const segment of segments) {
    const optional = segment.endsWith("?");
    const name = optional ? segment.slice(0, -1) : segment;
    const text = name === "*" ? "{splat}" : name.startsWith(":") ? `{${name.slice(1)}}` : name;
    paths = paths.flatMap((path) => (optional ? [path, [...path, text]] : [[...path, text]]));
  }
  return paths.map((path) => `/${path.join("/")}`);
}
/**
 * `<Route>` elements of React Router (JSX route tables, `<Routes>`/`createRoutesFromElements`) with
 * their full paths: a relative `path` extends its parent route's, a `path`-less `<Route element>`
 * is a layout, `index` serves the parent's path. A route is recorded when it renders something
 * (`element`, `Component`, `lazy`, `index`) or has no nested route. `unresolved` lists the lines of
 * routes whose `path` is not a statically known string; they and their nested routes are not
 * recorded. Route tables a component renders under another file's route are not followed.
 */
function reactRouterRoutes(
  program: AstNode,
  routeNames: ReadonlySet<string>,
): { routes: { path: string; line: number }[]; unresolved: number[] } {
  const routes: { path: string; line: number }[] = [];
  const unresolved: number[] = [];
  const isRoute = (node: AstNode): boolean =>
    node.type === "JSXElement" &&
    astNode(node.openingElement) &&
    routeNames.has(literal(node.openingElement.name) ?? "");
  const attribute = (opening: AstNode, name: string): AstNode | undefined =>
    (Array.isArray(opening.attributes) ? opening.attributes : []).find(
      (item): item is AstNode =>
        astNode(item) && item.type === "JSXAttribute" && literal(item.name) === name,
    );
  let elements = 0;
  const walk = (node: AstNode, parents: string[]): void => {
    if (!isRoute(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (["loc", "tokens", "comments"].includes(key)) continue;
        if (Array.isArray(value)) {
          for (const child of value) if (astNode(child)) walk(child, parents);
        } else if (astNode(value)) walk(value, parents);
      }
      return;
    }
    elements += 1;
    const opening = node.openingElement as AstNode;
    const line = node.loc?.start.line ?? 1;
    const pathAttribute = attribute(opening, "path");
    const own = pathAttribute ? routePathValues(pathAttribute.value) : undefined;
    if (pathAttribute && !own) unresolved.push(line);
    const paths = own
      ? parents.flatMap((parent) => own.map((child) => joinRoutePath(parent, child)))
      : pathAttribute
        ? []
        : parents;
    const before = elements;
    for (const child of Array.isArray(node.children) ? node.children : [])
      if (astNode(child)) walk(child, paths);
    const index = attribute(opening, "index") !== undefined;
    const renders = ["element", "Component", "lazy"].some((name) => attribute(opening, name));
    if ((pathAttribute || index) && (index || renders || elements === before))
      for (const path of paths.flatMap(reactRoutePatterns)) routes.push({ path, line });
  };
  walk(program, ["/"]);
  // A layout route and its index route serve the same URL: the first (outermost) one is kept.
  const sorted = routes.sort((a, b) => a.line - b.line);
  return {
    routes: sorted.filter(
      (route, at) => sorted.findIndex((item) => item.path === route.path) === at,
    ),
    unresolved,
  };
}
interface ExportScan {
  /** Exported top-level function declarations and declarators, by node identity. */
  nodes: Set<AstNode>;
  /** Exported HTTP-method handlers, in source order. */
  methods: { method: string; handler: string; line: number }[];
  /** `export * from ...` hides names this scan cannot resolve. */
  exportsAll: boolean;
}
/** Identifiers a binding pattern declares, in source order; rest elements are ignored. */
function boundNames(pattern: unknown): string[] {
  if (!astNode(pattern)) return [];
  if (pattern.type === "Identifier") return [String(pattern.name)];
  if (pattern.type === "AssignmentPattern") return boundNames(pattern.left);
  if (pattern.type === "ObjectPattern" && Array.isArray(pattern.properties))
    return pattern.properties.flatMap((property) =>
      astNode(property) && property.type === "ObjectProperty" ? boundNames(property.value) : [],
    );
  if (pattern.type === "ArrayPattern" && Array.isArray(pattern.elements))
    return pattern.elements.flatMap((element) => boundNames(element));
  return [];
}
/** `http`, `https`, `http2` and their `node:` forms: the modules that make a file a Node HTTP server. */
const NODE_HTTP_MODULE = /^(?:node:)?(?:https?|http2)$/u;
/** Files whose route comparisons are never server routes: React/Next app files and JSX. */
const CLIENT_ROUTE_FILE = /(?:^|\/)(?:app|pages)\/|\.[jt]sx$/u;
/**
 * Test files (`*.test.*`, `*.spec.*`, or anywhere under `__tests__/`, `test/`, `tests/`): a stub
 * `node:http` server there is a fixture, not a route of the application.
 */
export const TEST_FILE = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/u;
/** Python test modules: `test_*.py`, `*_test.py`, `conftest.py`, or anything under `tests/`. */
const PYTHON_TEST_FILE = /(?:^|\/)(?:tests?\/|(?:test_[^/]*|[^/]*_test|conftest)\.py$)/u;
/** Directories that hold test servers and mocks (`e2e/`, `fixtures/`, `__fixtures__/`, `__mocks__/`). */
const FIXTURE_DIRECTORY = /(?:^|\/)(?:e2e|fixtures?|__fixtures__|__mocks__)\//u;
/**
 * Test, spec, story and Python test files, and files under fixture directories: routes and
 * endpoints declared there are fixtures.
 */
function isFixtureFile(path: string): boolean {
  return (
    TEST_FILE.test(path) ||
    ROUTE_FIXTURE_FILE.test(path) ||
    PYTHON_TEST_FILE.test(path) ||
    FIXTURE_DIRECTORY.test(path)
  );
}
/**
 * Manifests and `next.config.*` files of `files` that decide whether the Next.js route candidates
 * among `paths` are file routes. A scoped scan must read them too: without them every such file
 * would silently stop being a route.
 */
export function nextProjectFiles(paths: readonly string[], files: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    if (ROUTE_FIXTURE_FILE.test(path) || !NEXT_ROUTE_DIRECTORY.test(path)) continue;
    let directory = path.slice(0, Math.max(path.lastIndexOf("/"), 0));
    for (;;) {
      directories.add(directory);
      if (!directory) break;
      directory = directory.slice(0, Math.max(directory.lastIndexOf("/"), 0));
    }
  }
  return files.filter((file) => {
    const slash = file.lastIndexOf("/");
    const name = file.slice(slash + 1);
    return (
      directories.has(slash < 0 ? "" : file.slice(0, slash)) &&
      (name === "package.json" || NEXT_CONFIG_FILE.test(name))
    );
  });
}
const ROUTE_IDENTIFIER = /^(?:path|pathname|route)$/u;
/**
 * The request path a `===` operand reads: a bare `path`/`pathname`/`route`, any `<object>.pathname`
 * (`url.pathname`, `new URL(req.url).pathname`) or any `<object>.url` (`req.url`). A `.url` value
 * can carry a query string, so it only matches a literal without one.
 */
function routeOperand(side: unknown): "path" | "url" | undefined {
  if (!astNode(side)) return undefined;
  if (side.type === "Identifier")
    return ROUTE_IDENTIFIER.test(String(side.name)) ? "path" : undefined;
  if (
    (side.type === "MemberExpression" || side.type === "OptionalMemberExpression") &&
    side.computed !== true &&
    astNode(side.property) &&
    side.property.type === "Identifier"
  ) {
    if (side.property.name === "pathname") return "path";
    if (side.property.name === "url") return "url";
  }
  return undefined;
}
/** The route literal compared with a request path by `a === b` (either order), or undefined. */
function comparedRoute(node: AstNode): string | undefined {
  const pair: [unknown, unknown][] = [
    [node.left, node.right],
    [node.right, node.left],
  ];
  for (const [operand, other] of pair) {
    const kind = routeOperand(operand);
    const value = astNode(other) && other.type !== "Identifier" ? literal(other) : undefined;
    if (kind && value?.startsWith("/") && (kind === "path" || !value.includes("?"))) return value;
  }
  return undefined;
}
/** The operands of an `a && b && c` chain, with every nested `&&` expression it flattened. */
function conjuncts(node: AstNode, logicals: AstNode[] = []): AstNode[] {
  if (node.type !== "LogicalExpression" || node.operator !== "&&") return [node];
  logicals.push(node);
  return [node.left, node.right].flatMap((side) =>
    astNode(side) ? conjuncts(side, logicals) : [],
  );
}
/** The HTTP method named by `method === "GET"` or `req.method === "GET"`, or undefined. */
function comparedMethod(node: AstNode): string | undefined {
  if (node.type !== "BinaryExpression" || !["===", "=="].includes(String(node.operator)))
    return undefined;
  const isMethodRef = (side: unknown): boolean =>
    astNode(side) &&
    ((side.type === "Identifier" && side.name === "method") ||
      (side.type === "MemberExpression" &&
        side.computed !== true &&
        astNode(side.property) &&
        side.property.type === "Identifier" &&
        side.property.name === "method"));
  const value = isMethodRef(node.left)
    ? literal(node.right)
    : isMethodRef(node.right)
      ? literal(node.left)
      : undefined;
  return value && Object.hasOwn(ROUTE_METHODS, value) ? value : undefined;
}
/** Reads the top-level exports of a module without resolving other files. */
function scanExports(body: AstNode[]): ExportScan {
  const declarations = (statement: AstNode): [string, AstNode][] => {
    if (statement.type === "FunctionDeclaration") {
      const name = literal(statement.id);
      return name ? [[name, statement]] : [];
    }
    if (statement.type !== "VariableDeclaration" || !Array.isArray(statement.declarations))
      return [];
    return statement.declarations.flatMap((declarator): [string, AstNode][] =>
      astNode(declarator)
        ? boundNames(declarator.id).map((name): [string, AstNode] => [name, declarator])
        : [],
    );
  };
  const declared = new Map<string, AstNode>();
  for (const statement of body) {
    const inner =
      (statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportDefaultDeclaration") &&
      astNode(statement.declaration)
        ? statement.declaration
        : statement;
    for (const [name, node] of declarations(inner)) declared.set(name, node);
  }
  const scan: ExportScan = { nodes: new Set(), methods: [], exportsAll: false };
  const method = (name: string | undefined, handler: string | undefined, node: AstNode) => {
    if (name && handler && Object.hasOwn(ROUTE_METHODS, name))
      scan.methods.push({ method: name, handler, line: node.loc?.start.line ?? 1 });
  };
  for (const statement of body) {
    if (statement.type === "ExportAllDeclaration") scan.exportsAll = true;
    else if (statement.type === "ExportDefaultDeclaration") {
      if (!astNode(statement.declaration)) continue;
      const target =
        statement.declaration.type === "Identifier"
          ? declared.get(String(statement.declaration.name))
          : statement.declaration.type === "FunctionDeclaration" &&
              literal(statement.declaration.id)
            ? statement.declaration
            : undefined;
      if (target) scan.nodes.add(target);
    } else if (statement.type === "ExportNamedDeclaration") {
      if (astNode(statement.declaration)) {
        for (const [name, node] of declarations(statement.declaration)) {
          scan.nodes.add(node);
          method(name, name, statement);
        }
        continue;
      }
      if (!Array.isArray(statement.specifiers)) continue;
      for (const specifier of statement.specifiers) {
        if (!astNode(specifier) || specifier.type !== "ExportSpecifier") continue;
        const local = literal(specifier.local);
        method(literal(specifier.exported), local, statement);
        const target = !statement.source && local ? declared.get(local) : undefined;
        if (target) scan.nodes.add(target);
      }
    }
  }
  return scan;
}
export async function summarizeCode(
  repoRoot: string,
  options: CodeSummaryOptions = {},
): Promise<CodeSummary> {
  const root = await realpath(repoRoot);
  const summary: CodeSummary = {
    detectorVersion: CODE_DETECTOR_VERSION,
    manifestHash: "",
    coverage: "partial",
    techStack: [],
    entrypoints: [],
    features: [],
    fileRefs: [],
    routes: [],
    endpoints: [],
    schemas: [],
    externalServices: [],
    authPatterns: [],
    testHooks: [],
    existingTests: [],
    symbols: [],
    imports: [],
    warnings: [],
    scannedFiles: [],
    skippedFiles: [],
  };
  const admit = createPathAdmission(options.excludes);
  const python: string[] = [];
  const only = options.only ? new Set(options.only) : null;
  const onlyDirectories = new Set<string>();
  for (const path of only ?? []) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth++)
      onlyDirectories.add(parts.slice(0, depth).join("/"));
  }
  const maxSymbolsPerFile = options.maxSymbolsPerFile ?? DEFAULT_MAX_SYMBOLS_PER_FILE;
  const maxSymbols = options.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
  const symbolsPerFile = new Map<string, number>();
  const truncatedFiles = new Set<string>();
  let symbolsSeen = 0;
  /** Symbols are context only; beyond the caps they are dropped and declared once per run. */
  const keepSymbol = (symbol: CodeSymbol): void => {
    symbolsSeen += 1;
    const kept = symbolsPerFile.get(symbol.ref.path) ?? 0;
    if (kept >= maxSymbolsPerFile || summary.symbols.length >= maxSymbols) {
      truncatedFiles.add(symbol.ref.path);
      return;
    }
    symbolsPerFile.set(symbol.ref.path, kept + 1);
    summary.symbols.push(symbol);
  };
  let files = 0;
  const maxFileBytes = options.maxFileBytes ?? CODE_SUMMARY_DEFAULT_LIMITS.maxFileBytes;
  /** Per directory: `undefined` without a manifest, else whether it is the root of a Next.js project. */
  const projectRoots = new Map<string, Promise<boolean | undefined>>();
  const readProjectRoot = async (directory: string): Promise<boolean | undefined> => {
    const names = await readdir(resolve(root, directory)).catch(() => [] as string[]);
    const present = (name: string) =>
      names.includes(name) && !admit(directory ? `${directory}/${name}` : name);
    if (names.some((name) => NEXT_CONFIG_FILE.test(name) && present(name))) return true;
    if (!present("package.json")) return undefined;
    try {
      const manifest = JSON.parse(
        (
          await readConfinedCodeFile(
            root,
            directory ? `${directory}/package.json` : "package.json",
            maxFileBytes,
          )
        ).toString("utf8"),
      ) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
      return "next" in { ...manifest.dependencies, ...manifest.devDependencies };
    } catch {
      return false;
    }
  };
  /** The directory of the nearest manifest (or `next.config.*`) above `path` when it is a Next.js project. */
  const nextProjectDirectory = async (path: string): Promise<string | undefined> => {
    let directory = path.slice(0, Math.max(path.lastIndexOf("/"), 0));
    for (;;) {
      let known = projectRoots.get(directory);
      if (!known) {
        known = readProjectRoot(directory);
        projectRoots.set(directory, known);
      }
      const isNext = await known;
      if (isNext !== undefined) return isNext ? directory : undefined;
      if (!directory) return undefined;
      directory = directory.slice(0, Math.max(directory.lastIndexOf("/"), 0));
    }
  };
  /** The Next.js file route of `path`, only when it is not a fixture and belongs to a Next.js project. */
  const nextFileRoute = async (path: string): Promise<NextRouteTarget | null> => {
    if (ROUTE_FIXTURE_FILE.test(path) || !NEXT_ROUTE_DIRECTORY.test(path)) return null;
    const project = await nextProjectDirectory(path);
    if (project === undefined) return null;
    return nextRouteTarget(project ? path.slice(project.length + 1) : path);
  };
  const inspect = (
    path: string,
    text: string,
    hash: string,
    lineOffset = 0,
    /** Set for an App Router `route.*` file: the URL path its exported methods serve. */
    routePath?: string,
  ) => {
    const ref = (line = 1): CodeRef => ({ path, contentHash: hash, line: line + lineOffset });
    const ast = parse(text, {
      sourceType: "unambiguous",
      plugins: ["typescript", "jsx", "decorators-legacy"],
      errorRecovery: false,
    });
    // Babel's `File.program` is a Program node, which `visit` reads through the loose `AstNode`.
    const program = ast.program as unknown as AstNode;
    const exported = scanExports(Array.isArray(program.body) ? program.body.filter(astNode) : []);
    /** Node-server evidence: `path === "/x"` comparisons only count in files that serve HTTP. */
    let importsNodeHttp = false;
    let createsServer = false;
    const comparedRoutes: { path: string; method: string; ref: CodeRef }[] = [];
    /** Method named by the `&&` chain a comparison sits in, keyed by the chain's operands. */
    const conditionMethods = new Map<AstNode, string>();
    const groupedLogicals = new Set<AstNode>();
    /** Local names `Route` of react-router is imported as: a `<Route>` is a client route only then. */
    const routeComponents = new Set<string>();
    const visit = (node: AstNode) => {
      const evidence = ref(node.loc?.start.line ?? 1);
      if (node.type === "ImportDeclaration") {
        const source = literal(node.source);
        if (source) {
          if (node.importKind !== "type" && NODE_HTTP_MODULE.test(source)) importsNodeHttp = true;
          summary.imports.push({ source, ref: evidence });
          if (["express", "react", "next", "@playwright/test", "vitest"].includes(source))
            summary.techStack.push({
              name: source,
              detectorVersion: CODE_DETECTOR_VERSION,
              ref: evidence,
            });
        }
        if (
          source &&
          REACT_ROUTER_MODULE.test(source) &&
          node.importKind !== "type" &&
          Array.isArray(node.specifiers)
        )
          for (const specifier of node.specifiers)
            if (
              astNode(specifier) &&
              specifier.type === "ImportSpecifier" &&
              specifier.importKind !== "type" &&
              literal(specifier.imported) === "Route"
            )
              routeComponents.add(literal(specifier.local) ?? "Route");
      }
      if (["FunctionDeclaration", "ClassDeclaration", "VariableDeclarator"].includes(node.type)) {
        const name = literal(node.id);
        if (name) {
          const kind =
            node.type === "ClassDeclaration"
              ? "class"
              : node.type === "VariableDeclarator"
                ? "binding"
                : "function";
          const symbol: CodeSymbol = { name, kind, ref: evidence };
          keepSymbol(symbol);
          // Components are exported PascalCase functions; route handlers and helpers are not.
          if (
            routePath === undefined &&
            exported.nodes.has(node) &&
            /^[A-Z]/u.test(name) &&
            (node.type === "FunctionDeclaration" ||
              (astNode(node.init) &&
                ["ArrowFunctionExpression", "FunctionExpression"].includes(node.init.type)))
          )
            summary.features.push({ ...symbol, kind: "component" });
          if (/schema|model/iu.test(name)) summary.schemas.push(symbol);
        }
      }
      if (node.type === "JSXAttribute" && literal(node.name) === "data-testid") {
        const name = literal(node.value);
        if (name) summary.testHooks.push({ name, ref: evidence });
      }
      if (node.type === "StringLiteral" || node.type === "TemplateElement") {
        const value =
          node.type === "StringLiteral"
            ? String(node.value)
            : node.value && typeof node.value === "object" && "raw" in node.value
              ? String(node.value.raw)
              : "";
        for (const hook of value.matchAll(/data-testid\s*=\s*["']([^"']+)["']/gu))
          if (hook[1]) summary.testHooks.push({ name: hook[1], ref: evidence });
        if (/^https?:\/\//u.test(value)) {
          try {
            summary.externalServices.push({ url: new URL(value).origin, ref: evidence });
          } catch {
            /* Dynamic URLs remain unknown. */
          }
        }
      }
      if (
        node.type === "LogicalExpression" &&
        node.operator === "&&" &&
        !groupedLogicals.has(node)
      ) {
        const logicals: AstNode[] = [];
        const parts = conjuncts(node, logicals);
        for (const nested of logicals) groupedLogicals.add(nested);
        const methods = new Set(parts.flatMap((part) => comparedMethod(part) ?? []));
        const [only] = methods;
        if (only && methods.size === 1) for (const part of parts) conditionMethods.set(part, only);
      }
      if (node.type === "BinaryExpression" && ["===", "=="].includes(String(node.operator))) {
        const route = comparedRoute(node);
        if (route !== undefined)
          comparedRoutes.push({
            path: route,
            method: conditionMethods.get(node) ?? "UNKNOWN",
            ref: evidence,
          });
      }
      if (node.type === "CallExpression" && Array.isArray(node.arguments)) {
        const args = node.arguments;
        if (astNode(node.callee) && node.callee.type === "MemberExpression") {
          const method = literal(node.callee.property);
          if (method === "createServer" || method === "createSecureServer") createsServer = true;
          const receiver = literal(node.callee.object);
          const target = literal(args[0]);
          if (
            method &&
            ["get", "post", "put", "patch", "delete", "head", "options", "all", "use"].includes(
              method,
            ) &&
            target?.startsWith("/") &&
            receiver &&
            /app|router|server/iu.test(receiver) &&
            !isFixtureFile(path)
          )
            summary.endpoints.push({
              framework: "express",
              method: method.toUpperCase(),
              path: target,
              ref: evidence,
            });
          if (method === "getByTestId" && target)
            summary.testHooks.push({ name: target, ref: evidence });
        }
        const call = literal(node.callee);
        if (call === "createServer" || call === "createSecureServer") createsServer = true;
        if (["test", "it", "describe"].includes(call ?? "") && literal(args[0]))
          summary.existingTests.push({
            name: literal(args[0]) ?? "",
            kind: call ?? "test",
            ref: evidence,
          });
        if (call === "require" && literal(args[0])) {
          if (NODE_HTTP_MODULE.test(literal(args[0]) ?? "")) importsNodeHttp = true;
          summary.imports.push({ source: literal(args[0]) ?? "", ref: evidence });
        }
      }
      if (
        node.type === "Identifier" &&
        /^(authenticate|authorization|authorize|jwt|session|password|login|token|csrf)$/iu.test(
          String(node.name),
        )
      )
        summary.authPatterns.push(evidence);
      for (const [key, value] of Object.entries(node)) {
        if (["loc", "tokens", "comments"].includes(key)) continue;
        if (Array.isArray(value)) {
          for (const child of value) if (astNode(child)) visit(child);
        } else if (astNode(value)) visit(value);
      }
    };
    visit(ast as unknown as AstNode);
    if (importsNodeHttp && createsServer && !CLIENT_ROUTE_FILE.test(path) && !isFixtureFile(path))
      for (const route of comparedRoutes) summary.routes.push({ framework: "node-http", ...route });
    if (routeComponents.size && !isFixtureFile(path)) {
      const client = reactRouterRoutes(program, routeComponents);
      for (const route of client.routes)
        summary.routes.push({
          framework: "react-router",
          method: "GET",
          path: route.path,
          ref: ref(route.line),
        });
      if (client.unresolved.length)
        summary.warnings.push({
          path,
          code: "route_path_unresolved",
          message: `React Router <Route> at line ${client.unresolved.join(", ")} has a path that is not a static string; that route and the routes nested in it are not recorded.`,
        });
    }
    if (routePath !== undefined) {
      const served = new Set<string>();
      for (const item of exported.methods) {
        if (served.has(item.method)) continue;
        served.add(item.method);
        summary.endpoints.push({
          framework: "next",
          method: item.method,
          path: routePath,
          handler: item.handler,
          ref: ref(item.line),
        });
      }
      if (exported.exportsAll || !served.size)
        summary.warnings.push({
          path,
          code: "route_methods_unresolved",
          message: exported.exportsAll
            ? "Route file re-exports with `export *`; the HTTP methods it serves cannot be resolved statically, so its endpoints may be incomplete."
            : "Route file exports no statically resolvable HTTP method handler (GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE); it contributes no endpoint.",
        });
    }
  };
  const walk = async (
    directory: string,
    rules: { base: string; matcher: ignore.Ignore }[],
  ): Promise<void> => {
    if (directory.split("/").length > 100) {
      summary.skippedFiles.push({ path: directory, reason: "directory_depth_limit" });
      return;
    }
    const actualDirectory = await realpath(resolve(root, directory));
    if (actualDirectory !== root && !actualDirectory.startsWith(`${root}${sep}`))
      throw new ContractError("POLICY_DENIED", "Directory escapes repository");
    const entries = (await readdir(resolve(root, directory), { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name, "en"),
    );
    const gitignore = entries.find((entry) => entry.name === ".gitignore" && entry.isFile());
    if (gitignore) {
      const path = directory ? `${directory}/.gitignore` : ".gitignore";
      try {
        const bytes = await readConfinedCodeFile(root, path, 1024 * 1024);
        rules = [...rules, { base: directory, matcher: ignore().add(bytes.toString("utf8")) }];
      } catch {
        throw new ContractError("POLICY_DENIED", "Cannot safely read repository ignore file", {
          path,
        });
      }
    }
    for (const entry of entries) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (only && !entry.isDirectory() && !only.has(path)) continue;
      let excluded: string | null = admit(path, entry.isDirectory());
      let ignored = false;
      for (const rule of rules) {
        const local = rule.base ? path.slice(rule.base.length + 1) : path;
        const result = rule.matcher.test(entry.isDirectory() ? `${local}/` : local);
        if (result.ignored) ignored = true;
        else if (result.unignored) ignored = false;
      }
      if (!excluded && ignored) excluded = "gitignore";
      if (excluded) {
        summary.skippedFiles.push({ path, reason: excluded });
        continue;
      }
      if (entry.isSymbolicLink()) {
        const actual = await realpath(resolve(root, path)).catch(() => "");
        summary.skippedFiles.push({
          path,
          reason:
            actual === root || actual.startsWith(`${root}${sep}`)
              ? "symlink_not_followed"
              : "symlink_escape",
        });
        continue;
      }
      if (entry.isDirectory()) {
        if (!only || onlyDirectories.has(path)) await walk(path, rules);
        continue;
      }
      if (!entry.isFile()) {
        summary.skippedFiles.push({ path, reason: "non_regular" });
        continue;
      }
      if (++files > (options.maxFiles ?? CODE_SUMMARY_DEFAULT_LIMITS.maxFiles)) {
        summary.skippedFiles.push({ path, reason: "file_count_limit" });
        continue;
      }
      if (!analyzableCodeType(path)) {
        summary.skippedFiles.push({ path, reason: "unsupported_type" });
        continue;
      }
      try {
        const bytes = await readConfinedCodeFile(
          root,
          path,
          options.maxFileBytes ?? CODE_SUMMARY_DEFAULT_LIMITS.maxFileBytes,
        );
        const text = sourceText(bytes);
        if (text === null) {
          summary.skippedFiles.push({ path, reason: "binary" });
          continue;
        }
        const hash = sha256(bytes);
        const target = await nextFileRoute(path);
        summary.scannedFiles.push(path);
        summary.fileRefs.push({ path, contentHash: hash, line: 1 });
        if (path.endsWith(".py")) {
          python.push(path);
          continue;
        }
        if (entry.name === "package.json") {
          const manifest = JSON.parse(text) as {
            dependencies?: Record<string, unknown>;
            devDependencies?: Record<string, unknown>;
          };
          for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }))
            if (["express", "react", "next"].includes(name))
              summary.techStack.push({
                name,
                detectorVersion: CODE_DETECTOR_VERSION,
                ref: { path, contentHash: hash, line: 1 },
              });
          continue;
        }
        if (path.endsWith(".html")) {
          for (const hook of text.matchAll(/data-testid\s*=\s*["']([^"']+)["']/gu))
            if (hook[1])
              summary.testHooks.push({
                name: hook[1],
                ref: {
                  path,
                  contentHash: hash,
                  line: text.slice(0, hook.index).split("\n").length,
                },
              });
          for (const script of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu))
            if (script[1])
              inspect(
                path,
                script[1],
                hash,
                text.slice(0, (script.index ?? 0) + script[0].indexOf(">") + 1).split("\n").length -
                  1,
              );
        } else inspect(path, text, hash, 0, target?.kind === "route" ? target.path : undefined);
        if (/(?:^|\/)(?:src\/)?(?:server|index|main)\.[cm]?[jt]s$/u.test(path))
          summary.entrypoints.push({ path, contentHash: hash, line: 1 });
        if (target?.kind === "page")
          summary.routes.push({
            framework: "next",
            method: "GET",
            path: target.path,
            ref: { path, contentHash: hash, line: 1 },
          });
        else if (target?.kind === "api")
          summary.warnings.push({
            path,
            code: "route_methods_unresolved",
            message:
              "Pages Router API file: its handler is a single function whose HTTP methods are not resolved statically, so it contributes no endpoint.",
          });
      } catch (error) {
        if (error instanceof ContractError && error.code === "PAYLOAD_TOO_LARGE") {
          summary.skippedFiles.push({ path, reason: "oversize" });
          continue;
        }
        summary.warnings.push({
          path,
          code: "analysis_failed",
          message: error instanceof Error ? error.message : "Analysis failed",
        });
        summary.skippedFiles.push({ path, reason: "analysis_failed" });
      }
    }
  };
  await walk("", []);
  if (python.length) {
    const result = options.pythonRunner
      ? await options.pythonRunner.summarize(root, python)
      : { available: false as const, reason: "Hardened Python summary runner is unavailable" };
    if (!result.available)
      summary.warnings.push({ path: "", code: "python_unavailable", message: result.reason });
    else {
      const admitted = new Set(python);
      const sources = new Map(summary.fileRefs.map((ref) => [ref.path, ref]));
      for (const file of result.summary.files)
        if (!admitted.has(file.path) || !sources.has(file.path))
          throw new ContractError("POLICY_DENIED", "Python summary referenced an unadmitted file");
      const routes = resolvePythonRoutes(result.summary.files);
      for (const route of routes.endpoints.filter((item) => !isFixtureFile(item.file)))
        summary.endpoints.push({
          framework: route.framework,
          method: route.method,
          path: route.path,
          handler: route.handler,
          ref: { ...(sources.get(route.file) as CodeRef), line: route.line },
        });
      summary.warnings.push(...routes.warnings);
      for (const file of result.summary.files) {
        const source = sources.get(file.path) as CodeRef;
        for (const test of file.tests)
          summary.existingTests.push({
            name: test.name,
            kind: "pytest",
            ref: { ...source, line: test.line },
          });
        for (const symbol of file.symbols)
          keepSymbol({
            name: symbol.name,
            kind: symbol.kind,
            ref: { ...source, line: symbol.line },
          });
      }
      summary.warnings.push(...result.summary.diagnostics);
    }
  }
  if (truncatedFiles.size)
    summary.warnings.push({
      path: "",
      code: "symbols_truncated",
      message: `Kept ${summary.symbols.length} of ${symbolsSeen} symbols in ${symbolsPerFile.size} files; ${truncatedFiles.size} files exceeded a limit (${maxSymbolsPerFile} per file, ${maxSymbols} per run). Routes, endpoints and features are not affected.`,
    });
  if (!summary.scannedFiles.length)
    summary.warnings.push({
      path: "",
      code: "no_analyzable_files",
      message:
        "No file with a supported type was analyzed (JS/TS family, .html, .py, package.json); the code summary is empty, which is not proof that the code has no routes or features.",
    });
  summary.manifestHash = computeManifestHash(summary, options.excludes);
  return summary;
}
