import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const idPattern =
  "(?:REQ|NFR|INV|ARCH|DATA|API|CLI|MCP|AI|EXEC|HEAL|DISC|SEC|OPS|UX|INT|VAL|CONTRACT)-\\d{3}|J\\d{2}|M[0-6]-\\d{2}";
const tableDefinition = new RegExp(`^\\|\\s*(${idPattern})\\s*\\|\\s*([^|]+)`);
const proseDefinition = new RegExp(
  `(?:^|\\s)(${idPattern}):\\s*(.*?)(?=\\s(?:${idPattern}):|$)`,
  "g",
);
const boldDefinition = new RegExp(`^\\*\\*(${idPattern}) — (.*?) \\((M[0-6][^)]*)\\)\\.\\*\\*`);
const taskDefinition = /^- \[ \] \*\*(M[0-6]-\d{2}) — (.*?)\*\*/;
const journeyDefinition = /^### (J\d{2}) — (.+)/;

export interface Definition {
  id: string;
  title: string;
  sourceFile: string;
  sourceLine: number;
  declaredMilestones: string[];
}

/** Only definitions are extracted: references, ranges and fenced examples are not IDs. */
export function extractDocument(sourceFile: string, text: string): Definition[] {
  const result: Definition[] = [];
  let fence: string | undefined;
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const add = (id: string, title: string, milestones = "") => {
      result.push({
        id,
        title: title.trim(),
        sourceFile,
        sourceLine: index + 1,
        declaredMilestones: [...new Set(milestones.match(/M[0-6]/gu) ?? [])],
      });
    };
    const task = taskDefinition.exec(line);
    if (task?.[1] && task[2]) {
      add(task[1], task[2], task[1]);
      continue;
    }
    const journey = journeyDefinition.exec(line);
    if (journey?.[1] && journey[2]) {
      add(journey[1], journey[2]);
      continue;
    }
    const bold = boldDefinition.exec(line);
    if (bold?.[1] && bold[2]) {
      add(bold[1], bold[2], bold[3]);
      continue;
    }
    const table = tableDefinition.exec(line);
    // ROADMAP's REQ rows map requirements; their definitions live in spec 01.
    if (table?.[1] && table[2] && sourceFile !== "ROADMAP.md") {
      add(table[1], table[2], line);
      continue;
    }
    const prose = line.replace(/^- /u, "");
    for (const match of prose.matchAll(proseDefinition)) {
      if (match[1] && match[2]) add(match[1], match[2]);
    }
  }
  return result;
}

export async function extractSpecifications(root: string): Promise<Definition[]> {
  const thematic = (await readdir(join(root, "specs")))
    .filter((name) => /^\d{2}-.*\.md$/u.test(name))
    .sort();
  const files = ["SPEC.md", "ROADMAP.md", ...thematic.map((name) => `specs/${name}`)];
  const byId = new Map<string, Definition>();
  for (const sourceFile of files) {
    for (const definition of extractDocument(
      sourceFile,
      await readFile(join(root, sourceFile), "utf8"),
    )) {
      if (byId.has(definition.id))
        throw new Error(
          `Duplicate normative definition ${definition.id} in ${sourceFile}:${definition.sourceLine}`,
        );
      byId.set(definition.id, definition);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, "en"));
}
