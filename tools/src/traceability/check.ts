import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Definition, extractSpecifications } from "./extract.js";

export type Milestone = `M${0 | 1 | 2 | 3 | 4 | 5 | 6}`;
export interface RegistryItem {
  id: string;
  title: string;
  sourceFile: string;
  milestone: Milestone;
  ownerRole: string;
  status: "planned" | "implemented" | "verified" | "blocked" | "waived";
  scenario: string[];
  oracle: string[];
  evidence: string[];
  code: string[];
}
export interface Registry {
  items: RegistryItem[];
}
export interface CheckResult {
  ok: boolean;
  definitionCount: number;
  errors: string[];
}

const statuses: Record<RegistryItem["status"], true> = {
  planned: true,
  implemented: true,
  verified: true,
  blocked: true,
  waived: true,
};

export async function checkRegistry(
  root: string,
  definitions: readonly Definition[],
  registry: Registry,
  gate?: Milestone,
): Promise<CheckResult> {
  const errors: string[] = [];
  const expected = new Map(definitions.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const canonicalRoot = await realpath(root);
  for (const item of registry.items) {
    if (seen.has(item.id)) errors.push(`Duplicate registry ID ${item.id}`);
    seen.add(item.id);
    const definition = expected.get(item.id);
    if (!definition) errors.push(`Unknown registry ID ${item.id}`);
    else if (item.sourceFile !== definition.sourceFile)
      errors.push(`${item.id}: sourceFile must be ${definition.sourceFile}`);
    if (!/^M[0-6]$/u.test(item.milestone))
      errors.push(`${item.id}: invalid milestone ${item.milestone}`);
    if (!Object.hasOwn(statuses, item.status))
      errors.push(`${item.id}: invalid status ${item.status}`);
    if (!item.title || !item.ownerRole) errors.push(`${item.id}: title and ownerRole are required`);
    for (const field of ["scenario", "oracle", "evidence", "code"] as const) {
      if (
        !Array.isArray(item[field]) ||
        item[field].some((value) => typeof value !== "string" || !value)
      ) {
        errors.push(`${item.id}: ${field} must be an array of non-empty strings`);
      }
    }
    if (
      gate &&
      /^M[0-6]$/u.test(item.milestone) &&
      item.milestone <= gate &&
      item.status === "planned"
    ) {
      errors.push(`${item.id}: planned ${item.milestone} item blocks milestone gate ${gate}`);
    }
    if (item.status !== "verified") continue;
    for (const field of ["scenario", "oracle", "code", "evidence"] as const) {
      if (!Array.isArray(item[field]) || item[field].length === 0)
        errors.push(`${item.id}: verified requires ${field}`);
    }
    if (!Array.isArray(item.evidence)) continue;
    for (const path of item.evidence) {
      if (typeof path !== "string") continue;
      try {
        if (isAbsolute(path)) throw new Error("absolute path");
        const target = await realpath(resolve(canonicalRoot, path));
        const confined = relative(canonicalRoot, target);
        if (confined === ".." || confined.startsWith(`..${sep}`) || isAbsolute(confined))
          throw new Error("outside repository");
        if (!(await stat(target)).isFile()) throw new Error("not a file");
      } catch {
        errors.push(`${item.id}: evidence path missing, unsafe or not a file: ${path}`);
      }
    }
  }
  for (const definition of definitions)
    if (!seen.has(definition.id))
      errors.push(
        `Missing registry ID ${definition.id} (${definition.sourceFile}:${definition.sourceLine})`,
      );
  return { ok: errors.length === 0, definitionCount: definitions.length, errors };
}

export async function checkRepository(root: string, gate?: Milestone): Promise<CheckResult> {
  const registry: unknown = JSON.parse(
    await readFile(resolve(root, "traceability/registry.json"), "utf8"),
  );
  if (
    !registry ||
    typeof registry !== "object" ||
    !("items" in registry) ||
    !Array.isArray(registry.items)
  ) {
    throw new Error("Registry must contain an items array");
  }
  if (registry.items.some((item: unknown) => !item || typeof item !== "object"))
    throw new Error("Registry items must be objects");
  return checkRegistry(root, await extractSpecifications(root), registry as Registry, gate);
}
