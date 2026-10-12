import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { capabilityRegistry, ProjectConfig } from "@testmaster/contracts";

/** The five boundaries SEC-001 requires a boundary and control for, with the word the spec uses. */
export const requiredBoundaryClasses = {
  import: "importação",
  llm: "LLM",
  worker: "worker",
  viewer: "viewer",
  tunnel: "túnel",
} as const;

export interface CapabilityState {
  id: string;
  enabled: boolean;
}
/** Components found in code, not in the document. */
export interface CodeComponents {
  executors: string[];
  transports: string[];
  capabilities: CapabilityState[];
}
export interface ThreatBoundary {
  id: string;
  boundary: string;
  class: string;
  status: string;
  asset: string;
  control: string;
  abuse: string;
  residual: string;
  evidence: string[];
}
export interface ParsedThreatModel {
  version: string | undefined;
  boundaries: ThreatBoundary[];
  /** Component token (`kind:name`) to the boundary IDs that list it. */
  coverage: Map<string, string[]>;
  errors: string[];
}

const boundaryColumns = [
  "ID",
  "Boundary",
  "Class",
  "Status",
  "Untrusted input → protected asset",
  "Enforcing control",
  "Expected abuse",
  "Residual risk",
  "Enforcement evidence",
];

function table(markdown: string, heading: string): string[][] | undefined {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return undefined;
  const rows: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (!line.startsWith("|")) continue;
    rows.push(
      line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim()),
    );
  }
  return rows.length >= 2 ? rows.slice(2) : [];
}

function headerRow(markdown: string, heading: string): string[] | undefined {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  const header = lines.slice(start + 1).find((line) => line.startsWith("|"));
  return start < 0 || !header
    ? undefined
    : header
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim());
}

export function citations(cell: string): string[] {
  return [...cell.matchAll(/`([^`]*::[^`]*)`/g)].map((match) => match[1] as string);
}

/** Parses the boundary and component-coverage tables of the threat model. */
export function parseThreatModel(markdown: string): ParsedThreatModel {
  const errors: string[] = [];
  const version = /^- Version: (\d+\.\d+\.\d+)/m.exec(markdown)?.[1];
  if (!version) errors.push("Threat model has no semantic Version line");
  const boundaries: ThreatBoundary[] = [];
  const header = headerRow(markdown, "Boundaries and responsible enforcement");
  if (JSON.stringify(header) !== JSON.stringify(boundaryColumns))
    errors.push(`Boundary table columns must be exactly: ${boundaryColumns.join(" | ")}`);
  const boundaryRows = table(markdown, "Boundaries and responsible enforcement") ?? [];
  if (!boundaryRows.length) errors.push("Threat model has no boundary rows");
  for (const row of boundaryRows) {
    const [id = "", boundary = "", klass = "", status = "", asset = "", control = ""] = row;
    const [abuse = "", residual = "", evidence = ""] = row.slice(6);
    if (row.length !== boundaryColumns.length || !/^B-\d{2}$/.test(id)) {
      errors.push(`Malformed boundary row: ${row[0] ?? ""} ${row[1] ?? ""}`.trim());
      continue;
    }
    if (boundaries.some((entry) => entry.id === id)) errors.push(`${id}: duplicate boundary ID`);
    for (const [name, value] of Object.entries({
      boundary,
      class: klass,
      asset,
      control,
      abuse,
      residual,
      evidence,
    }))
      if (!value) errors.push(`${id}: missing ${name}`);
    if (!["enabled", "disabled"].includes(status))
      errors.push(`${id}: status must be enabled or disabled`);
    boundaries.push({
      id,
      boundary,
      class: klass,
      status,
      asset,
      control,
      abuse,
      residual,
      evidence: citations(evidence),
    });
  }
  const coverage = new Map<string, string[]>();
  const coverageRows = table(markdown, "Component coverage");
  if (!coverageRows?.length) errors.push("Threat model has no component coverage table");
  for (const [id = "", components = ""] of coverageRows ?? []) {
    if (!boundaries.some((entry) => entry.id === id))
      errors.push(`Component coverage names unknown boundary ${id}`);
    if (components !== "none" && !/`[a-z]+:[^`]+`/.test(components))
      errors.push(`${id}: component coverage must list components or none`);
    for (const match of components.matchAll(/`([a-z]+:[^`]+)`/g)) {
      const token = match[1] as string;
      coverage.set(token, [...(coverage.get(token) ?? []), id]);
    }
  }
  return { version, boundaries, coverage, errors };
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derives the executors, transports and capabilities that really exist: executors are the sandbox
 * directories with an executor module plus the configurable `execution.executor` values, transports
 * are the application entry points under apps/, capabilities come from the shared registry.
 */
export async function deriveCodeComponents(
  root: string,
  capabilities: readonly CapabilityState[] = Object.values(capabilityRegistry),
): Promise<CodeComponents> {
  const executors = new Set<string>();
  const sandbox = join(root, "packages", "sandbox", "src");
  for (const name of await directories(sandbox))
    if (await exists(join(sandbox, name, "executor.ts"))) executors.add(name);
  for (const entry of ProjectConfig.properties.execution.properties.executor.anyOf)
    executors.add(entry.const);
  return {
    executors: [...executors].sort(),
    transports: await directories(join(root, "apps")),
    capabilities: capabilities.map(({ id, enabled }) => ({ id, enabled })),
  };
}

function tokens(components: CodeComponents): Map<string, boolean | undefined> {
  return new Map<string, boolean | undefined>([
    ...components.executors.map((name) => [`executor:${name}`, undefined] as const),
    ...components.transports.map((name) => [`transport:${name}`, undefined] as const),
    ...components.capabilities.map(({ id, enabled }) => [`capability:${id}`, enabled] as const),
  ]);
}

async function checkCitation(root: string, citation: string): Promise<string | undefined> {
  const delimiter = citation.indexOf("::");
  const file = citation.slice(0, delimiter);
  const name = citation.slice(delimiter + 2);
  if (!file || !name || isAbsolute(file) || !/\.test\.ts$/.test(file))
    return `evidence must name a relative path/to/file.test.ts::test name: ${citation}`;
  try {
    const path = await realpath(resolve(root, file));
    const confined = relative(await realpath(root), path);
    if (confined === ".." || confined.startsWith(`..${sep}`))
      return `evidence escapes root: ${citation}`;
    const source = await readFile(path, "utf8");
    if (
      !source.includes(JSON.stringify(name)) &&
      !source.includes(`'${name.replaceAll("'", "\\'")}'`) &&
      !source.includes(`\`${name}\``)
    )
      return `evidence test name not found in file: ${citation}`;
  } catch {
    return `evidence file missing: ${citation}`;
  }
  return undefined;
}

/**
 * Returns every reason the threat model is not an acceptable SEC-001 model of the implementation;
 * an empty list means each boundary has asset, control, abuse, residual risk and existing enforcing
 * tests, SEC-001's five named boundaries are present, and every executor, transport and capability
 * found in code is modelled with a status that matches the code.
 */
export async function checkThreatModel(options: {
  root: string;
  markdown: string;
  spec: string;
  components: CodeComponents;
}): Promise<string[]> {
  const { root, markdown, spec, components } = options;
  const parsed = parseThreatModel(markdown);
  const errors = [...parsed.errors];
  const sec001 = spec.split("\n").find((line) => line.includes("**SEC-001")) ?? "";
  for (const [klass, word] of Object.entries(requiredBoundaryClasses)) {
    if (!sec001.includes(word))
      errors.push(`SEC-001 no longer names ${word}; update the required boundary classes`);
    if (!parsed.boundaries.some((entry) => entry.class === klass))
      errors.push(`No boundary of class ${klass} required by SEC-001`);
  }
  for (const entry of parsed.boundaries) {
    if (entry.evidence.length < (entry.status === "enabled" ? 2 : 1))
      errors.push(
        `${entry.id}: enforcement evidence needs ${entry.status === "enabled" ? "at least two" : "a"} path::test citation`,
      );
    for (const citation of entry.evidence) {
      const problem = await checkCitation(root, citation);
      if (problem) errors.push(`${entry.id}: ${problem}`);
    }
  }
  const sandbox = parsed.boundaries.find((entry) => entry.class === "executor");
  if (!sandbox || !/shared kernel/i.test(sandbox.residual))
    errors.push("Executor boundary must keep the shared-kernel residual risk explicit");
  if (!/host administrator/i.test(markdown))
    errors.push("Threat model must keep the host administrator residual risk explicit");
  if (
    !/must update this versioned model before enabling a new executor, transport, integration/.test(
      markdown,
    )
  )
    errors.push(
      "Threat model must require an update before enabling a new executor, transport or integration",
    );

  const status = new Map(parsed.boundaries.map((entry) => [entry.id, entry.status]));
  const derived = tokens(components);
  for (const [token, enabled] of derived) {
    const owners = parsed.coverage.get(token);
    if (!owners) {
      errors.push(`${token} exists in code but is absent from the threat model`);
      continue;
    }
    for (const owner of owners) {
      const state = status.get(owner);
      if (state === "disabled" && (enabled === undefined || enabled))
        errors.push(`${token} is enabled in code but modelled under disabled boundary ${owner}`);
      if (state === "enabled" && enabled === false)
        errors.push(`${token} is disabled in code but modelled under enabled boundary ${owner}`);
    }
  }
  for (const token of parsed.coverage.keys())
    if (!derived.has(token)) errors.push(`${token} is in the threat model but not in code`);
  return errors;
}
