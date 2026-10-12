import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Definition, extractSpecifications } from "./extract.js";
import {
  type AreaSummary,
  type CapabilityGateDecision,
  type CapabilityLink,
  type CapabilitySummary,
  type Coverage,
  checkCapabilityGate,
  checkCapabilityGateDefinitions,
  checkReleaseDecision,
  checkReleaseItem,
  type ReleaseDecision,
  releaseSummary,
  type Waiver,
} from "./release.js";

export type Milestone = `M${0 | 1 | 2 | 3 | 4 | 5 | 6}`;
export interface Deferred {
  milestone: Milestone;
  scope: string;
  specQuote: { path: string; text: string };
}
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
  note?: string;
  blockedReason?: string;
  coverage?: Coverage;
  waiver?: Waiver;
  /** Residual scope of a verified item that a later milestone still owns. */
  deferred?: Deferred[];
}
export interface Registry {
  items: RegistryItem[];
  capabilities?: CapabilityLink[];
  release?: ReleaseDecision;
}
export interface CheckResult {
  ok: boolean;
  definitionCount: number;
  errors: string[];
  capabilitySummary?: CapabilitySummary[];
  capabilityGate?: CapabilityGateDecision;
  areaSummary?: AreaSummary[];
}

const statuses: Record<RegistryItem["status"], true> = {
  planned: true,
  implemented: true,
  verified: true,
  blocked: true,
  waived: true,
};

/** True when `path` is a repository-relative entry that resolves inside `root` after symlinks. */
async function confinedEntry(root: string, path: string, fileOnly: boolean): Promise<boolean> {
  try {
    if (isAbsolute(path)) return false;
    const target = await realpath(resolve(root, path));
    const confined = relative(root, target);
    if (confined === ".." || confined.startsWith(`..${sep}`) || isAbsolute(confined)) return false;
    return fileOnly ? (await stat(target)).isFile() : true;
  } catch {
    return false;
  }
}

const deferredQuotePath = /^(SPEC\.md|ROADMAP\.md|specs\/[^/]+\.md|docs\/adr\/[^/]+\.md)$/u;

async function checkDeferred(root: string, item: RegistryItem, errors: string[]): Promise<void> {
  if (item.status !== "verified")
    errors.push(`${item.id}: deferred residual scope is only allowed on verified items`);
  if (!Array.isArray(item.deferred) || !item.deferred.length) {
    errors.push(`${item.id}: deferred must be a non-empty array`);
    return;
  }
  for (const entry of item.deferred) {
    const label = `${item.id}: deferred ${entry?.milestone ?? "?"}`;
    if (
      !entry ||
      !/^M[0-6]$/u.test(entry.milestone) ||
      entry.milestone <= item.milestone ||
      typeof entry.scope !== "string" ||
      !entry.scope.trim()
    ) {
      errors.push(`${label}: milestone later than ${item.milestone} and a scope are required`);
      continue;
    }
    const quote = entry.specQuote;
    if (
      !quote ||
      typeof quote.path !== "string" ||
      !deferredQuotePath.test(quote.path) ||
      typeof quote.text !== "string" ||
      !quote.text.trim()
    ) {
      errors.push(`${label}: specQuote requires a normative document path and literal text`);
      continue;
    }
    if (!new RegExp(`(^|[^A-Za-z0-9])${entry.milestone}([^0-9]|$)`, "u").test(quote.text)) {
      errors.push(`${label}: specQuote text must name ${entry.milestone}`);
      continue;
    }
    try {
      if (!(await confinedEntry(root, quote.path, true))) throw new Error("unsafe path");
      const source = await readFile(resolve(root, quote.path), "utf8");
      if (!source.includes(quote.text)) throw new Error("quote not found");
    } catch {
      errors.push(`${label}: specQuote not found literally in ${quote.path}`);
    }
  }
}

export async function checkRegistry(
  root: string,
  definitions: readonly Definition[],
  registry: Registry,
  gate?: Milestone,
  advertisedCapabilities: readonly string[] = [],
  now = Date.now(),
  capabilityGate?: string,
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
    if (item.status === "verified" && item.blockedReason?.trim())
      errors.push(`${item.id}: verified item must not keep a blockedReason`);
    if (
      item.status === "waived" ||
      item.status === "verified" ||
      (gate && /^M[0-6]$/u.test(item.milestone) && item.milestone <= gate)
    )
      await checkReleaseItem(canonicalRoot, item, errors, now);
    if (item.deferred !== undefined) await checkDeferred(canonicalRoot, item, errors);
    if (gate && item.status === "verified")
      for (const entry of Array.isArray(item.deferred) ? item.deferred : [])
        if (entry && /^M[0-6]$/u.test(entry.milestone) && entry.milestone <= gate)
          errors.push(
            `${item.id}: deferred ${entry.milestone} scope blocks milestone gate ${gate} (${entry.scope})`,
          );
    if (
      item.status !== "verified" &&
      !(gate && item.milestone <= gate && item.coverage && !item.blockedReason)
    )
      continue;
    for (const field of ["scenario", "oracle", "code", "evidence"] as const) {
      if (!Array.isArray(item[field]) || item[field].length === 0)
        errors.push(`${item.id}: verified requires ${field}`);
    }
    for (const field of ["evidence", "code"] as const) {
      if (!Array.isArray(item[field])) continue;
      for (const path of item[field]) {
        if (typeof path !== "string") continue;
        if (!(await confinedEntry(canonicalRoot, path, field === "evidence")))
          errors.push(
            `${item.id}: ${field} path missing, unsafe${field === "evidence" ? " or not a file" : ""}: ${path}`,
          );
      }
    }
  }
  for (const definition of definitions)
    if (!seen.has(definition.id))
      errors.push(
        `Missing registry ID ${definition.id} (${definition.sourceFile}:${definition.sourceLine})`,
      );
  if (capabilityGate) {
    const decision = await checkCapabilityGate(canonicalRoot, registry, capabilityGate, now);
    errors.push(...decision.reasons);
    return {
      ok: errors.length === 0,
      definitionCount: definitions.length,
      errors,
      capabilityGate: decision,
    };
  }
  checkCapabilityGateDefinitions(registry, errors);
  if (gate) {
    const capabilitySummary = releaseSummary(registry, advertisedCapabilities, errors);
    const areaSummary = checkReleaseDecision(registry.release, errors, { kind: "milestone", gate });
    return {
      ok: errors.length === 0,
      definitionCount: definitions.length,
      errors,
      capabilitySummary,
      areaSummary,
    };
  }
  return { ok: errors.length === 0, definitionCount: definitions.length, errors };
}

export async function checkRepository(
  root: string,
  gate?: Milestone,
  capabilityGate?: string,
): Promise<CheckResult> {
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
  const catalog = await readFile(
    resolve(root, "packages/contracts/src/registries.ts"),
    "utf8",
  ).catch(() => "");
  const featureBlock = /const features:[\s\S]*?=\s*\{([\s\S]*?)\n\};/u.exec(catalog)?.[1] ?? "";
  const advertised = [...featureBlock.matchAll(/"([A-Za-z_][A-Za-z0-9_-]*)"/gu)].map(
    (match) => match[1] ?? "",
  );
  if (gate && !advertised.length) throw new Error("Cannot discover public capability catalog");
  return checkRegistry(
    root,
    await extractSpecifications(root),
    registry as Registry,
    gate,
    advertised,
    Date.now(),
    capabilityGate,
  );
}
