import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { parse } from "@babel/parser";
import { ContractError } from "@testmaster/contracts";
import { canonicalJson, sha256 } from "@testmaster/domain";
import ignore from "ignore";
import type { CodeRef, CodeSummary, CodeSummaryOptions } from "./types.js";

export const CODE_DETECTOR_VERSION = "1.0.0";
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
/** Opens only an admitted regular file, never a symlink or hardlink. */
export async function readConfinedCodeFile(
  root: string,
  path: string,
  maxBytes: number,
): Promise<Buffer> {
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
    if (stat.size > maxBytes)
      throw new ContractError("PAYLOAD_TOO_LARGE", "Code file exceeds limit", { path });
    // Verify the opened descriptor, not only its pathname, against concurrent directory swaps.
    const actual = await realpath(`/proc/self/fd/${handle.fd}`);
    if (!actual.startsWith(`${root}${sep}`))
      throw new ContractError("POLICY_DENIED", "Opened file escapes repository", { path });
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes)
      throw new ContractError("PAYLOAD_TOO_LARGE", "Code file exceeds limit", { path });
    return bytes;
  } finally {
    await handle.close();
  }
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
  const defaults = ignore().add(DEFAULT_IGNORES);
  const configured = ignore().add(options.excludes ?? []);
  const python: string[] = [];
  let total = 0;
  let files = 0;
  const inspect = (path: string, text: string, hash: string, lineOffset = 0) => {
    const ref = (line = 1): CodeRef => ({ path, contentHash: hash, line: line + lineOffset });
    const ast = parse(text, {
      sourceType: "unambiguous",
      plugins: ["typescript", "jsx", "decorators-legacy"],
      errorRecovery: false,
    });
    const visit = (node: AstNode) => {
      const evidence = ref(node.loc?.start.line ?? 1);
      if (node.type === "ImportDeclaration") {
        const source = literal(node.source);
        if (source) {
          summary.imports.push({ source, ref: evidence });
          if (["express", "react", "next", "@playwright/test", "vitest"].includes(source))
            summary.techStack.push({
              name: source,
              detectorVersion: CODE_DETECTOR_VERSION,
              ref: evidence,
            });
        }
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
          const symbol = { name, kind, ref: evidence };
          summary.symbols.push(symbol);
          if (
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
      if (node.type === "BinaryExpression" && ["===", "=="].includes(String(node.operator))) {
        const right = literal(node.right);
        const left = literal(node.left);
        if (right?.startsWith("/") && ["path", "pathname", "route"].includes(left ?? ""))
          summary.routes.push({
            framework: "node-http",
            method: "UNKNOWN",
            path: right,
            ref: evidence,
          });
      }
      if (node.type === "CallExpression" && Array.isArray(node.arguments)) {
        const args = node.arguments;
        if (astNode(node.callee) && node.callee.type === "MemberExpression") {
          const method = literal(node.callee.property);
          const receiver = literal(node.callee.object);
          const target = literal(args[0]);
          if (
            method &&
            ["get", "post", "put", "patch", "delete", "head", "options", "all", "use"].includes(
              method,
            ) &&
            target?.startsWith("/") &&
            receiver &&
            /app|router|server/iu.test(receiver)
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
        if (["test", "it", "describe"].includes(call ?? "") && literal(args[0]))
          summary.existingTests.push({
            name: literal(args[0]) ?? "",
            kind: call ?? "test",
            ref: evidence,
          });
        if (call === "require" && literal(args[0]))
          summary.imports.push({ source: literal(args[0]) ?? "", ref: evidence });
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
      const testPath = entry.isDirectory() ? `${path}/` : path;
      let excluded = defaults.ignores(testPath)
        ? "default_exclude"
        : configured.ignores(testPath)
          ? "config_exclude"
          : null;
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
        await walk(path, rules);
        continue;
      }
      if (!entry.isFile()) {
        summary.skippedFiles.push({ path, reason: "non_regular" });
        continue;
      }
      if (++files > (options.maxFiles ?? 10000)) {
        summary.skippedFiles.push({ path, reason: "file_count_limit" });
        continue;
      }
      if (!/\.(?:[cm]?[jt]sx?|py|html)$/iu.test(path) && entry.name !== "package.json") {
        summary.skippedFiles.push({ path, reason: "unsupported_or_binary" });
        continue;
      }
      try {
        const bytes = await readConfinedCodeFile(root, path, options.maxFileBytes ?? 1024 * 1024);
        if (total + bytes.length > (options.maxTotalBytes ?? 25 * 1024 * 1024)) {
          summary.skippedFiles.push({ path, reason: "total_byte_limit" });
          continue;
        }
        total += bytes.length;
        if (bytes.includes(0)) {
          summary.skippedFiles.push({ path, reason: "binary" });
          continue;
        }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const hash = sha256(bytes);
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
        } else inspect(path, text, hash);
        if (/(?:^|\/)(?:src\/)?(?:server|index|main)\.[cm]?[jt]s$/u.test(path))
          summary.entrypoints.push({ path, contentHash: hash, line: 1 });
        const next = /(?:^|\/)(?:src\/)?(pages|app)\/(.*)\.[jt]sx?$/u.exec(path);
        if (next?.[1] && next[2]) {
          let route = next[2];
          if (next[1] === "pages" && /(?:^|\/)(?:_app|_document|_error)$/u.test(route)) continue;
          if (next[1] === "app" && !/(?:^|\/)(?:page|route)$/u.test(route)) continue;
          route = route
            .replace(/(?:^|\/)(?:index|page|route)$/u, "")
            .split("/")
            .filter((part) => part && !/^\(.+\)$/u.test(part))
            .join("/");
          summary.routes.push({
            framework: "next",
            method: next[2].endsWith("route") ? "UNKNOWN" : "GET",
            path: `/${route}`,
            ref: { path, contentHash: hash, line: 1 },
          });
        }
      } catch (error) {
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
      for (const file of result.summary.files) {
        const source = summary.fileRefs.find((ref) => ref.path === file.path);
        if (!admitted.has(file.path) || !source)
          throw new ContractError("POLICY_DENIED", "Python summary referenced an unadmitted file");
        for (const route of file.routes)
          summary.endpoints.push({
            framework: route.framework,
            method: route.method,
            path: route.path,
            handler: route.handler,
            ref: { ...source, line: route.line },
          });
        for (const test of file.tests)
          summary.existingTests.push({
            name: test.name,
            kind: "pytest",
            ref: { ...source, line: test.line },
          });
        for (const symbol of file.symbols)
          summary.symbols.push({
            name: symbol.name,
            kind: symbol.kind,
            ref: { ...source, line: symbol.line },
          });
      }
      summary.warnings.push(...result.summary.diagnostics);
    }
  }
  summary.manifestHash = sha256(
    canonicalJson({
      detectorVersion: CODE_DETECTOR_VERSION,
      files: summary.fileRefs,
      excludes: options.excludes ?? [],
      skipped: summary.skippedFiles,
    }),
  );
  return summary;
}
