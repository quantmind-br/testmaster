import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const layers: Record<string, number> = {
  contracts: 0,
  domain: 1,
  persistence: 2,
  evidence: 2,
  sandbox: 3,
  "model-gateway": 3,
  planner: 3,
  reporting: 3,
  application: 4,
  // apps: MCP is mounted by the server; the CLI hosts both (`server start`, `mcp serve`).
  mcp: 5,
  server: 6,
  cli: 7,
  web: 7,
  runner: 1,
  "reference-shop": 0,
  tools: 8,
  validation: 8,
};
const allowedRunner: Record<string, true> = {
  "@testmaster/contracts": true,
  "@testmaster/domain": true,
  "playwright-core": true,
  // Reporter API host for imported @playwright/test projects (plan D8).
  "@playwright/test": true,
  undici: true,
};
const testFrameworks: Record<string, true> = { vitest: true, "fast-check": true };
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
interface Workspace {
  name: string;
  directory: string;
  layer: number;
  manifest: Record<string, unknown>;
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(path, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function sources(path: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...(await sources(resolve(path, entry.name))));
    else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) files.push(resolve(path, entry.name));
  }
  return files;
}
/**
 * Files that load the application only from a hash-verified installed runtime archive, never
 * from the workspace graph. Only their dynamic `import()` expressions may be non-literal.
 */
const verifiedRuntimeLoaders = new Set([
  "tools/src/github-action/main.ts",
  "tools/src/github-action/publisher.ts",
]);
/** Trusted evaluation drivers are path-confined and reviewed separately from workspace layers. */
const evaluationDriverLoaders = new Set(["tools/src/evals/m3.ts", "tools/src/evals/holdout.ts"]);
function importSpecifiers(source: string, filename: string): string[] {
  const tree = parse(source, {
    sourceType: "unambiguous",
    plugins: ["typescript", "jsx"],
    createImportExpressions: true,
  });
  const queue: unknown[] = [tree];
  const imports: string[] = [];
  while (queue.length) {
    const node = queue.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }
    const record = node as Record<string, unknown>;
    const type = record.type;
    let specifier: unknown;
    if (
      type === "ImportDeclaration" ||
      type === "ExportNamedDeclaration" ||
      type === "ExportAllDeclaration" ||
      type === "ImportExpression"
    )
      specifier = record.source;
    if (type === "TSImportType") specifier = record.argument;
    if (type === "TSExternalModuleReference") specifier = record.expression;
    if (type === "CallExpression") {
      const callee = record.callee as Record<string, unknown> | undefined;
      if (callee?.type === "Identifier" && callee.name === "require")
        specifier = (record.arguments as unknown[])[0];
    }
    if (specifier) {
      const literal = specifier as Record<string, unknown>;
      if (literal.type !== "StringLiteral" || typeof literal.value !== "string") {
        if (
          type === "ImportExpression" &&
          (verifiedRuntimeLoaders.has(filename) || evaluationDriverLoaders.has(filename))
        )
          continue;
        throw new Error(`${filename}: non-literal module loading cannot be checked`);
      }
      imports.push(literal.value);
    }
    for (const [key, value] of Object.entries(record)) {
      if (
        !["loc", "start", "end", "comments", "tokens"].includes(key) &&
        value &&
        typeof value === "object"
      )
        queue.push(value);
    }
  }
  return imports;
}
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}
function denial(from: Workspace, to: Workspace): string | undefined {
  if (from.name === to.name) return undefined;
  if (from.name === "@testmaster/runner")
    return Object.hasOwn(allowedRunner, to.name) ? undefined : "runner allowlist";
  return to.layer < from.layer ? undefined : "dependencies must point toward a lower layer";
}

describe("NFR-009 module boundaries", () => {
  it("checks every workspace manifest and AST import edge against the layer table", async () => {
    const candidates = [resolve(root, "tools")];
    for (const group of ["packages", "apps", "fixtures"])
      candidates.push(...(await directories(resolve(root, group))));
    const workspaces: Workspace[] = [];
    const errors: string[] = [];
    for (const directory of candidates) {
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const shortName = relative(root, directory).split(sep).at(-1) ?? "";
      const layer = layers[shortName];
      if (layer === undefined) {
        errors.push(
          `Unknown package ${String(manifest.name)} (${shortName}); allowed layer table: ${JSON.stringify(layers)}`,
        );
        continue;
      }
      if (typeof manifest.name !== "string") throw new Error(`${directory}: manifest name missing`);
      workspaces.push({ name: manifest.name, directory, layer, manifest });
    }
    const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
    for (const workspace of workspaces) {
      for (const section of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        const dependencies = workspace.manifest[section] as Record<string, string> | undefined;
        for (const dependency of Object.keys(dependencies ?? {})) {
          const target = byName.get(dependency);
          if (dependency.startsWith("@testmaster/") && !target)
            errors.push(`${workspace.name}: unknown workspace dependency ${dependency}`);
          if (target && denial(workspace, target))
            errors.push(`${workspace.name} -> ${target.name}: ${denial(workspace, target)}`);
          if (
            workspace.name === "@testmaster/runner" &&
            section !== "devDependencies" &&
            !Object.hasOwn(allowedRunner, dependency)
          )
            errors.push(`runner runtime dependency not allowed: ${dependency}`);
        }
      }
      const sourceDir = resolve(workspace.directory, "src");
      let files: string[];
      try {
        files = await sources(sourceDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const file of files) {
        const test = /\.(?:docker\.|live\.)?test\.tsx?$/u.test(file);
        for (const specifier of importSpecifiers(
          await readFile(file, "utf8"),
          relative(root, file),
        )) {
          if (builtins.has(specifier)) continue;
          const name = packageName(specifier);
          if (test && Object.hasOwn(testFrameworks, name)) continue;
          const target =
            specifier.startsWith(".") || specifier.startsWith("/")
              ? workspaces.find((candidate) => {
                  const path = relative(candidate.directory, resolve(dirname(file), specifier));
                  return path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
                })
              : byName.get(name);
          if (specifier.startsWith("@testmaster/") && !target)
            errors.push(`${relative(root, file)}: unknown workspace import ${specifier}`);
          if (target && denial(workspace, target))
            errors.push(`${relative(root, file)} -> ${target.name}: ${denial(workspace, target)}`);
          if (
            workspace.name === "@testmaster/runner" &&
            !target &&
            !specifier.startsWith(".") &&
            !Object.hasOwn(allowedRunner, name)
          )
            errors.push(`${relative(root, file)}: runner import not allowed: ${specifier}`);
        }
      }
    }
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
