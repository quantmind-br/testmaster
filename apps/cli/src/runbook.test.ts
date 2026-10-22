import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { expect, it } from "vitest";
import { createCli } from "./cli.js";
import { Runtime } from "./runtime.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const runbook = join(repo, "docs/operations/local-operations.md");
const unavailableGroups = ["auth", "suite", "schedule", "memory", "export", "import"];

function sink(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}
/** Every `testmaster ...` command a reader can copy: fenced blocks and inline code spans. */
function runbookCommands(doc: string): string[] {
  const found: string[] = [];
  const add = (text: string): void => {
    const command = text
      .replace(/\s+#.*$/u, "")
      .trim()
      .replace(/^(?:[A-Z][A-Z0-9_]*=\S+\s+)+/u, "");
    if (command.startsWith("testmaster ")) found.push(command);
  };
  let fenced = false;
  for (const line of doc.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    else if (fenced) add(line);
    else for (const span of line.matchAll(/`([^`]+)`/gu)) add(span[1] ?? "");
  }
  return found;
}
function optionNames(command: Command): Set<string> {
  const names = new Set<string>(["--help"]);
  for (let node: Command | null = command; node; node = node.parent)
    for (const option of node.options) if (option.long) names.add(option.long);
  return names;
}
/** Walks the CLI tree; returns what the documented command line asks for that does not exist. */
function unresolved(root: Command, line: string): string[] {
  const tokens = [...line.matchAll(/"[^"]*"|'[^']*'|\S+/gu)].map((match) =>
    match[0].replace(/^["']|["']$/gu, ""),
  );
  const problems: string[] = [];
  let command = root;
  let descending = true;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (token.startsWith("--")) {
      const name = token.split("=")[0] as string;
      const known = optionNames(command);
      if (!known.has(name)) {
        problems.push(`${line} -> unknown option ${name}`);
        continue;
      }
      let node: Command | null = command;
      let takesValue = false;
      for (; node; node = node.parent) {
        const option = node.options.find((candidate) => candidate.long === name);
        if (option) {
          takesValue = Boolean(option.required || option.optional);
          break;
        }
      }
      if (takesValue && !token.includes("=")) index += 1;
      continue;
    }
    if (!descending) continue;
    const child = command.commands.find(
      (candidate) => candidate.name() === token || candidate.aliases().includes(token),
    );
    if (child) command = child;
    else {
      if (command.commands.length > 0) problems.push(`${line} -> unknown command ${token}`);
      descending = false;
    }
  }
  return problems;
}

it("every runbook command and option resolves in the implemented CLI tree", async () => {
  const root = createCli(new Runtime(sink(), sink()));
  const doc = await readFile(runbook, "utf8");
  const commands = runbookCommands(doc);
  // The walker must be able to fail: a misspelt subcommand and a misspelt option are both reported.
  expect(unresolved(root, "testmaster worker frobnicate")).toHaveLength(1);
  expect(unresolved(root, "testmaster worker drain --nope")).toHaveLength(1);
  expect(unresolved(root, "testmaster --output json audit verify out.json --sha256 abc")).toEqual(
    [],
  );
  expect(commands.length).toBeGreaterThan(30);
  const missing = commands.flatMap((line) => unresolved(root, line));
  expect(missing).toEqual([]);
  const groups = commands.map(
    (line) => line.replace(/^testmaster (?:--output \S+ |--json )*/u, "").split(/\s+/u)[0] ?? "",
  );
  expect(groups.filter((group) => unavailableGroups.includes(group))).toEqual([]);
  for (const group of ["worker", "db", "backup", "secret", "image", "audit"])
    expect(groups).toContain(group);
});

function sectionOf(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  const end = doc.indexOf("\n## ", start + heading.length);
  return doc.slice(start, end === -1 ? undefined : end);
}

it("tabletop record names the unexercised incidents and the resumption decider", async () => {
  const doc = await readFile(runbook, "utf8");
  expect(doc).toMatch(/## Tabletop record/u);
  const table = sectionOf(doc, "## Incident containment")
    .split("\n")
    .filter((line) => line.startsWith("| "));
  const incidents = table.slice(1).map((row) => (row.split("|")[1] as string).trim());
  expect(incidents).toHaveLength(6);
  const section = sectionOf(doc, "## Tabletop record");
  const decider = section.slice(section.indexOf("### Resumption decider"));
  const unexercised = section.slice(
    section.indexOf("### Unexercised incidents"),
    section.indexOf("### Resumption decider"),
  );
  expect(section).toContain("Resumption decider");
  expect(section).toContain("Unexercised incidents");
  // Every incident row names the role that decides resumption.
  for (const incident of incidents) {
    const line = decider.split("\n").find((candidate) => candidate.startsWith(`- ${incident}: `));
    expect(line, incident).toMatch(/: [AWXR] decides/u);
  }
  // The gaps are real incidents of the table, and each exercised claim cites a test file that exists.
  const gaps = [...unexercised.matchAll(/^- ([^:]+):/gmu)].map((entry) => entry[1] as string);
  expect(gaps).toEqual(["Suspected sandbox or egress bypass", "Secret/token exposure"]);
  for (const gap of gaps) expect(incidents).toContain(gap);
  const cited = [...section.matchAll(/`([^`\s]+\.test\.ts)`/gu)].map((match) => match[1] as string);
  expect(cited.length).toBeGreaterThanOrEqual(8);
  for (const path of cited) await expect(access(join(repo, path))).resolves.toBeUndefined();
});
