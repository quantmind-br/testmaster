import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { extname, posix, relative, resolve, sep } from "node:path";
import { parse } from "@babel/parser";
import { ContractError } from "@testmaster/contracts";
import { sha256 } from "@testmaster/domain";
import { readConfinedCodeFile } from "../code/summary.js";

export const CODE_IMPORT_VERSION = "1.0.0";
export const CODE_IMPORT_MAX_BYTES = 1024 * 1024;
export type CodeImportFormat = "playwright" | "pytest";
export interface ImportedCodeBundle {
  schemaVersion: "1.0.0";
  validatorVersion: string;
  format: CodeImportFormat;
  entrypoint: string;
  files: Record<string, string>;
  sourceHashes: Record<string, string>;
  tests: string[];
  limitations: string[];
}
export interface CodeImportOptions {
  root: string;
  path: string;
  format: CodeImportFormat;
}
interface Node {
  type: string;
  [key: string]: unknown;
}
function node(value: unknown): value is Node {
  return !!value && typeof value === "object" && "type" in value;
}
function walk(value: unknown, visit: (value: Node) => void): void {
  if (!node(value)) return;
  visit(value);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) for (const item of child) walk(item, visit);
    else if (node(child)) walk(child, visit);
  }
}
function name(value: unknown): string | undefined {
  if (!node(value)) return undefined;
  if (value.type === "Identifier") return String(value.name);
  if (["StringLiteral", "NumericLiteral", "BooleanLiteral"].includes(value.type))
    return String(value.value);
  if (
    value.type === "MemberExpression" &&
    (!value.computed || (node(value.property) && value.property.type === "StringLiteral"))
  ) {
    const owner = name(value.object);
    const property = name(value.property);
    return owner && property ? `${owner}.${property}` : undefined;
  }
  return undefined;
}
const CONSTANT_NODES: Record<string, true> = {
  StringLiteral: true,
  NumericLiteral: true,
  BooleanLiteral: true,
  NullLiteral: true,
  ObjectExpression: true,
  ArrayExpression: true,
};
function same(left: unknown, right: unknown): boolean {
  if (!node(left) || !node(right)) return false;
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            ![
              "start",
              "end",
              "loc",
              "extra",
              "leadingComments",
              "trailingComments",
              "innerComments",
            ].includes(key),
        )
        .map(([key, item]) => [key, clean(item)]),
    );
  };
  return JSON.stringify(clean(left)) === JSON.stringify(clean(right));
}
function refuse(message: string): never {
  throw new ContractError("INVALID_ARGUMENT", message);
}
interface Inspection {
  imports: string[];
  tests: string[];
  assertions: number;
}
function inspectTypescript(text: string): Inspection {
  let ast: unknown;
  try {
    ast = parse(text, { sourceType: "module", plugins: ["typescript"], errorRecovery: false });
  } catch {
    return refuse("Imported TypeScript has invalid syntax");
  }
  const result: Inspection = { imports: [], tests: [], assertions: 0 };
  const testNames = new Set<string>();
  const expectNames = new Set<string>();
  const constants = new Set<string>();
  walk(ast, (item) => {
    if (
      item.type === "VariableDeclarator" &&
      node(item.init) &&
      CONSTANT_NODES[item.init.type] &&
      name(item.id)
    )
      constants.add(name(item.id) as string);
    if (item.type === "ImportDeclaration") {
      const source = name(item.source);
      if (!source) refuse("Import source must be literal");
      result.imports.push(source);
      if (source === "@playwright/test")
        for (const specifier of item.specifiers as Node[]) {
          if (name(specifier.imported) === "test") testNames.add(name(specifier.local) ?? "test");
          if (name(specifier.imported) === "expect")
            expectNames.add(name(specifier.local) ?? "expect");
        }
    }
  });
  walk(ast, (item) => {
    if (
      ["ImportExpression", "NewExpression"].includes(item.type) &&
      (item.type === "ImportExpression" || name(item.callee) === "Function")
    )
      refuse("Dynamic code loading is forbidden");
    if (
      item.type === "Identifier" &&
      ["process", "globalThis", "global", "Function", "eval", "require"].includes(String(item.name))
    )
      refuse("Runtime code, shell and host access are forbidden");
    if (
      item.type === "MemberExpression" &&
      ["constructor", "__proto__"].includes(name(item.property) ?? "")
    )
      refuse("Runtime constructor access is forbidden");
    if (
      item.type === "BinaryExpression" &&
      same(item.left, item.right) &&
      ["===", "==", ">=", "<="].includes(String(item.operator))
    )
      refuse("Self-comparison assertions are forbidden");
    if (item.type === "ExportNamedDeclaration" && item.source)
      result.imports.push(name(item.source) ?? "");
    if (item.type === "ExportAllDeclaration") result.imports.push(name(item.source) ?? "");
    if (
      item.type === "ObjectProperty" &&
      ["timeout", "timeoutMs", "actionTimeout", "navigationTimeout"].includes(
        name(item.key) ?? "",
      ) &&
      (!node(item.value) || item.value.type !== "NumericLiteral" || Number(item.value.value) <= 0)
    )
      refuse("Timeouts must be positive numeric literals");
    if (item.type !== "CallExpression") return;
    const callee = name(item.callee) ?? "";
    const args = item.arguments as unknown[];
    if (node(item.callee) && item.callee.type === "Import") refuse("Dynamic imports are forbidden");
    if (
      /\.(?:setTimeout|setDefaultTimeout|setDefaultNavigationTimeout)$/u.test(callee) &&
      (!node(args[0]) || args[0].type !== "NumericLiteral" || Number(args[0].value) <= 0)
    )
      refuse("Timeouts must be positive numeric literals");
    if (/\.(?:exec|execSync|spawn|spawnSync|system|install)$/u.test(callee))
      refuse("Runtime installs and shell calls are forbidden");
    const root = callee.split(".")[0] ?? "";
    if (
      testNames.has(root) &&
      [root, `${root}.only`, `${root}.skip`, `${root}.fixme`].includes(callee)
    ) {
      if (callee !== root) refuse("Skipped or exclusive tests are forbidden");
      if (!node(args[0]) || args[0].type !== "StringLiteral") refuse("Tests require literal names");
      if (
        node(args[1]) &&
        ["ArrowFunctionExpression", "FunctionExpression"].includes(args[1].type) &&
        node(args[1].body) &&
        args[1].body.type === "BlockStatement" &&
        Array.isArray(args[1].body.body) &&
        !args[1].body.body.length
      )
        refuse("Empty tests are forbidden");
      result.tests.push(String(args[0].value));
    }
    if (expectNames.has(root) && [root, `${root}.soft`, `${root}.poll`].includes(callee)) {
      if (
        args.length === 0 ||
        (node(args[0]) &&
          (CONSTANT_NODES[args[0].type] ||
            (args[0].type === "Identifier" && constants.has(String(args[0].name)))))
      )
        refuse("Assertions need a nonconstant observation");
    }
    if (node(item.callee) && item.callee.type === "MemberExpression") {
      let chain: unknown = item.callee.object;
      while (node(chain) && chain.type === "MemberExpression") chain = chain.object;
      if (
        node(chain) &&
        chain.type === "CallExpression" &&
        expectNames.has((name(chain.callee) ?? "").split(".")[0] ?? "")
      ) {
        const actual = (chain.arguments as unknown[])[0];
        if (args.length && same(actual, args[0]))
          refuse("Self-comparison assertions are forbidden");
        const matcher = name(item.callee.property) ?? "";
        if (matcher.startsWith("to")) result.assertions++;
      }
    }
  });
  return result;
}

// This fixed program only parses source text. No submitted module is imported or executed.
const PYTHON_AST = `
import ast, json, resource, sys
resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
def dotted(n):
    if isinstance(n, ast.Name): return n.id
    if isinstance(n, ast.Attribute): return dotted(n.value) + '.' + n.attr
    return ''
try:
    tree = ast.parse(sys.stdin.read(1048577))
    imports, tests, errors, assertions = [], [], [], 0
    constants = {n.targets[0].id for n in ast.walk(tree) if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name) and isinstance(n.value, ast.Constant)}
    for n in ast.walk(tree):
        if isinstance(n, ast.Import): imports.extend(a.name for a in n.names)
        if isinstance(n, ast.ImportFrom):
            if n.level: imports.append('.' * n.level + (n.module or ''))
            else: imports.append(n.module or '')
            if any(a.name == '*' for a in n.names): errors.append('Wildcard imports are forbidden')
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name.startswith('test_'): tests.append(n.name)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name.startswith('test_') and all(isinstance(x, ast.Pass) or (isinstance(x, ast.Expr) and isinstance(x.value, ast.Constant)) for x in n.body): errors.append('Empty tests are forbidden')
        if isinstance(n, ast.Name) and n.id in ('eval', 'exec', 'compile', '__import__', '__builtins__', 'globals', 'locals', 'vars', 'getattr', 'setattr', 'open', 'breakpoint', 'input'): errors.append('Dynamic code and host access are forbidden')
        if isinstance(n, ast.Attribute) and n.attr.startswith('__'): errors.append('Runtime introspection is forbidden')
        if isinstance(n, ast.Call):
            call = dotted(n.func)
            if call.split('.')[-1] in ('system', 'popen', 'run', 'Popen', 'check_call', 'check_output', 'install', 'create_subprocess_exec', 'create_subprocess_shell'): errors.append('Runtime installs and shell calls are forbidden')
            for key in n.keywords:
                if key.arg in ('timeout', 'timeout_ms') and (not isinstance(key.value, ast.Constant) or not isinstance(key.value.value, (int, float)) or key.value.value <= 0): errors.append('Timeouts must be positive numeric literals')
            if call.endswith(('set_default_timeout', 'set_default_navigation_timeout')) and (not n.args or not isinstance(n.args[0], ast.Constant) or not isinstance(n.args[0].value, (int, float)) or n.args[0].value <= 0): errors.append('Timeouts must be positive numeric literals')
        if isinstance(n, ast.Assert):
            assertions += 1
            if isinstance(n.test, ast.Constant) or (isinstance(n.test, ast.Name) and n.test.id in constants): errors.append('Assertions need a nonconstant observation')
            if isinstance(n.test, ast.Compare):
                operands = [n.test.left] + n.test.comparators
                if all(isinstance(x, ast.Constant) for x in operands) or any(ast.dump(a) == ast.dump(b) for a, b in zip(operands, operands[1:])): errors.append('Constant and self-comparison assertions are forbidden')
    print(json.dumps(dict(imports=imports, tests=tests, assertions=assertions, errors=errors)))
except (SyntaxError, ValueError, MemoryError, RecursionError):
    print(json.dumps(dict(errors=['Imported Python has invalid or excessive syntax'])))
`;
function inspectPython(text: string): Promise<Inspection> {
  const { promise, resolve: resolveResult, reject } = Promise.withResolvers<Inspection>();
  const child = execFile(
    "python3",
    ["-I", "-S", "-c", PYTHON_AST],
    {
      timeout: 5000,
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
    },
    (error, stdout) => {
      if (error) {
        reject(
          new ContractError(
            error.code === "ENOENT" ? "CAPABILITY_UNAVAILABLE" : "INVALID_ARGUMENT",
            "Bounded Python syntax parser failed",
          ),
        );
        return;
      }
      try {
        const result = JSON.parse(stdout) as Inspection & { errors?: string[] };
        if (result.errors?.length) {
          reject(
            new ContractError("INVALID_ARGUMENT", result.errors[0] ?? "Python import refused"),
          );
          return;
        }
        resolveResult(result);
      } catch {
        reject(new ContractError("INVALID_ARGUMENT", "Python parser returned invalid diagnostics"));
      }
    },
  );
  child.stdin?.on("error", () => {});
  child.stdin?.end(text);
  return promise;
}
const PYTHON_MODULES: Record<string, true> = {
  pytest: true,
  pytest_asyncio: true,
  requests: true,
  playwright: true,
  testmaster_runner: true,
  json: true,
  re: true,
  math: true,
  decimal: true,
  datetime: true,
  typing: true,
  collections: true,
  dataclasses: true,
  asyncio: true,
};
export async function importCode(options: CodeImportOptions): Promise<ImportedCodeBundle> {
  if (!["playwright", "pytest"].includes(options.format)) refuse("Unsupported code format");
  const root = await realpath(options.root);
  const absolute = resolve(root, options.path);
  if (!absolute.startsWith(`${root}${sep}`))
    throw new ContractError("POLICY_DENIED", "Code path escapes project root");
  // Reject symlinks in every component, not merely those pointing outside the root.
  let current = root;
  for (const part of relative(root, absolute).split(sep)) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw new ContractError("POLICY_DENIED", "Symlink code paths are forbidden");
  }
  const entrypoint = relative(root, absolute).split(sep).join("/");
  const files: Record<string, string> = {};
  const sourceHashes: Record<string, string> = {};
  const tests: string[] = [];
  let total = 0;
  let assertions = 0;
  const load = async (file: string): Promise<void> => {
    if (file in files) return;
    if (Object.keys(files).length >= 64)
      throw new ContractError("PAYLOAD_TOO_LARGE", "Code bundle exceeds file limit");
    const expected = options.format === "pytest" ? ".py" : ".ts";
    if (extname(file) !== expected) refuse(`Code files must use ${expected}`);
    let path = root;
    for (const part of file.split("/")) {
      path = resolve(path, part);
      if ((await lstat(path)).isSymbolicLink())
        throw new ContractError("POLICY_DENIED", "Symlink code paths are forbidden");
    }
    const bytes = await readConfinedCodeFile(root, file, CODE_IMPORT_MAX_BYTES);
    total += bytes.length;
    if (total > CODE_IMPORT_MAX_BYTES)
      throw new ContractError("PAYLOAD_TOO_LARGE", "Code bundle exceeds byte limit");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return refuse("Code must be UTF-8");
    }
    files[file] = text;
    sourceHashes[file] = sha256(bytes);
    const result =
      options.format === "pytest" ? await inspectPython(text) : inspectTypescript(text);
    if (file === entrypoint) tests.push(...result.tests);
    assertions += result.assertions;
    for (const source of result.imports) {
      if (options.format === "playwright" && source === "@playwright/test") continue;
      if (options.format === "pytest" && Object.hasOwn(PYTHON_MODULES, source.split(".")[0] ?? ""))
        continue;
      let helper: string | undefined;
      if (options.format === "playwright" && /^\.\.?\//u.test(source))
        helper = posix.normalize(posix.join(posix.dirname(file), source.replace(/\.js$/u, ".ts")));
      if (options.format === "pytest") {
        if (source.startsWith(".")) {
          const level = source.match(/^\.+/u)?.[0].length ?? 1;
          helper = posix.join(
            posix.dirname(file),
            ...Array.from({ length: level - 1 }, () => ".."),
            `${source.slice(level).replaceAll(".", "/")}.py`,
          );
        } else if (/^[a-zA-Z_]\w*$/u.test(source))
          helper = posix.join(posix.dirname(file), `${source}.py`);
      }
      if (!helper || helper.startsWith("../") || posix.isAbsolute(helper))
        refuse(`Import outside runner dependency allowlist: ${source}`);
      if (!extname(helper)) helper += ".ts";
      try {
        await load(helper);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          refuse(`Dependency is not bundled or allowlisted: ${source}`);
        throw error;
      }
    }
  };
  await load(entrypoint);
  if (!tests.length || !assertions)
    refuse("Imported tests require named tests and nonempty assertions");
  return {
    schemaVersion: "1.0.0",
    validatorVersion: CODE_IMPORT_VERSION,
    format: options.format,
    entrypoint,
    files,
    sourceHashes,
    tests,
    limitations: [
      "AST validation does not establish sandbox safety or passing behavior.",
      "Assertions in imported code use the runner reporter/process contract; static checks are not independent business-oracle proof.",
    ],
  };
}
