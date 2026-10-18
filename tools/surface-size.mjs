#!/usr/bin/env node
// Measures the agent surface from the compiled catalog: the exact MCP `tools/list` payload and the
// installed skill content, in compact JSON bytes as they travel on the wire.
//
// Usage: node tools/surface-size.mjs [--snapshot PATH]
//   --snapshot PATH  also writes the exact `tools/list` payload bytes to PATH.
// Prints one JSON report on stdout. Run `pnpm build` first: it reads apps/mcp/dist.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { listedTools } = await import(join(root, "apps/mcp/dist/index.js"));

const bytes = (value) =>
  Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : statSync(path).isFile() ? [path] : [];
    })
    .sort();
}

function git(...args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const tools = listedTools();
const payload = JSON.stringify({ tools });
const snapshot = option("--snapshot");
if (snapshot) writeFileSync(snapshot, payload);

// The worst-case prompt cost: a client that turns every announced tool into a function from its
// name, description and input schema, and drops the output schema.
const visible = tools.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));
const withoutOutput = tools.map(({ outputSchema: _output, ...rest }) => rest);
const perTool = tools.map((tool) => ({
  name: tool.name,
  descriptionBytes: bytes(tool.description),
  inputBytes: bytes(tool.inputSchema),
  outputBytes: tool.outputSchema === undefined ? 0 : bytes(tool.outputSchema),
}));
const sum = (key) => perTool.reduce((total, tool) => total + tool[key], 0);
const skillRoot = join(root, "packages/application/skill-content");
const skill = files(skillRoot).map((path) => {
  const content = readFileSync(path);
  return { path: relative(root, path), bytes: content.length, sha256: sha256(content) };
});

const status = git("status", "--porcelain", "--untracked-files=no");
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    commit: git("rev-parse", "HEAD"),
    dirty: status === null ? null : status.length > 0,
    toolCount: tools.length,
    wireBytes: bytes(payload),
    wireSha256: sha256(payload),
    modelVisibleBytes: bytes(visible),
    withoutOutputSchemaBytes: bytes({ tools: withoutOutput }),
    descriptionBytes: sum("descriptionBytes"),
    inputBytes: sum("inputBytes"),
    outputBytes: sum("outputBytes"),
    perTool,
    skill,
  })}\n`,
);
