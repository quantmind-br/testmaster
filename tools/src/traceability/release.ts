import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Milestone, Registry, RegistryItem } from "./check.js";

export interface Coverage {
  positive: string[];
  negative: string[];
  criticalAssertions: { path: string; assertion: string }[];
}
export interface Waiver {
  severity: "medium" | "low";
  owner: string;
  expiresAt: string;
  requirement: string;
  reason: string;
  capabilityEffect: string;
}
export interface CapabilityLink {
  id: string;
  milestone: Milestone;
  requirements: string[];
  gate: string;
}
export interface CapabilityGate {
  id: string;
  requiredAreas: string[];
  requiredItems: string[];
  nonNegotiable: string[];
}
export interface CapabilityGateDecision {
  id: string;
  status: "passed" | "blocked";
  reasons: string[];
}
export interface ReleaseDecision {
  findings: {
    id: string;
    severity: "critical" | "high" | "medium" | "low";
    status: "open" | "resolved";
    requirement: string;
  }[];
  areas: {
    area: string;
    proposedTarget: string;
    approvedTarget: string | null;
    observation: number | null;
    interval: [number, number] | null;
    n: number;
    decision: "passed" | "failed" | "blocked";
    reason: string;
  }[];
  capabilityGates?: CapabilityGate[];
}
export interface CapabilitySummary extends Omit<CapabilityLink, "milestone"> {
  milestone: Milestone | null;
  status: "verified" | "blocked";
  scenarios: string[];
  oracles: string[];
  limitations: string[];
}
const forbiddenWaiver =
  /false.?passed|secret.?escape|assertion.?weakening|tenant.?leak|immutable.?rewrite|terminal.?rewrite|evidence.?falsification/iu;
const nonwaivableRequirements: Record<string, true> = {
  "INV-001": true,
  "INV-004": true,
  "INV-005": true,
  "INV-006": true,
  "INV-007": true,
  "INV-009": true,
  "SEC-020": true,
  "SEC-031": true,
  "SEC-033": true,
  "VAL-046": true,
};

export async function checkReleaseItem(
  root: string,
  item: RegistryItem,
  errors: string[],
  now: number,
): Promise<void> {
  if (item.status === "waived") {
    const waiver = item.waiver;
    if (
      !waiver ||
      !["low", "medium"].includes(waiver.severity) ||
      !waiver.owner?.trim() ||
      !waiver.reason?.trim() ||
      !waiver.capabilityEffect?.trim() ||
      waiver.requirement !== item.id ||
      !Number.isFinite(Date.parse(waiver.expiresAt)) ||
      Date.parse(waiver.expiresAt) <= now ||
      Object.hasOwn(nonwaivableRequirements, item.id) ||
      forbiddenWaiver.test(`${item.title} ${waiver.reason}`)
    )
      errors.push(
        `${item.id}: invalid waiver (noncritical severity, owner, future expiry, exact requirement, reason and public capability effect required; critical invariants cannot be waived)`,
      );
    return;
  }
  if (item.status !== "verified" && item.blockedReason?.trim()) {
    errors.push(`${item.id}: unverified release scope blocked (${item.blockedReason})`);
    return;
  }
  const coverage = item.coverage;
  for (const field of ["scenario", "oracle", "code", "evidence"] as const)
    if (!Array.isArray(item[field]) || !item[field].length)
      errors.push(`${item.id}: release coverage requires ${field}`);
  if (
    !coverage ||
    !Array.isArray(coverage.positive) ||
    !coverage.positive.length ||
    !Array.isArray(coverage.negative) ||
    !coverage.negative.length ||
    [...coverage.positive, ...coverage.negative].some(
      (scenario) => !Array.isArray(item.scenario) || !item.scenario.includes(scenario),
    )
  )
    errors.push(
      `${item.id}: release requires explicit positive and negative scenario links or a blockedReason for unverified scope`,
    );
  if (!coverage || !Array.isArray(coverage.positive) || !Array.isArray(coverage.negative)) return;
  for (const scenario of [...coverage.positive, ...coverage.negative]) {
    const delimiter = scenario.indexOf("::");
    if (delimiter < 1) {
      errors.push(`${item.id}: release scenario must name path::test: ${scenario}`);
      continue;
    }
    const file = scenario.slice(0, delimiter);
    const name = scenario.slice(delimiter + 2);
    try {
      const path = await realpath(resolve(root, file));
      const confined = relative(root, path);
      if (isAbsolute(file) || confined === ".." || confined.startsWith(`..${sep}`) || !name)
        throw new Error("unsafe scenario");
      const source = await readFile(path, "utf8");
      if (
        !source.includes(JSON.stringify(name)) &&
        !source.includes(`'${name.replaceAll("'", "\\'")}'`)
      )
        throw new Error("removed scenario");
    } catch {
      errors.push(`${item.id}: positive/negative scenario implementation missing: ${scenario}`);
    }
  }
  if (!Array.isArray(coverage.criticalAssertions) || !coverage.criticalAssertions.length) {
    errors.push(`${item.id}: release requires protected critical assertions`);
    return;
  }
  for (const control of coverage.criticalAssertions) {
    try {
      if (!control.assertion?.trim() || isAbsolute(control.path))
        throw new Error("invalid control");
      const path = await realpath(resolve(root, control.path));
      const confined = relative(root, path);
      if (confined === ".." || confined.startsWith(`..${sep}`) || isAbsolute(confined))
        throw new Error("outside root");
      if (!(await readFile(path, "utf8")).includes(control.assertion))
        throw new Error("removed assertion");
    } catch {
      errors.push(`${item.id}: protected critical assertion missing or unsafe: ${control.path}`);
    }
  }
}

export function releaseSummary(
  registry: Registry,
  advertised: readonly string[],
  errors: string[],
): CapabilitySummary[] {
  const links = registry.capabilities ?? [];
  const seen = new Set<string>();
  const summary: CapabilitySummary[] = [];
  for (const link of links) {
    if (seen.has(link.id)) errors.push(`Capability ${link.id}: duplicate mapping`);
    seen.add(link.id);
    const items = link.requirements.map((id) => registry.items.find((item) => item.id === id));
    if (
      !advertised.includes(link.id) ||
      !link.gate?.trim() ||
      !/^M[0-6]$/u.test(link.milestone) ||
      !items.length ||
      items.some((item) => !item)
    )
      errors.push(`Capability ${link.id}: invalid requirement/milestone/gate mapping`);
    const mapped = items.filter((item): item is RegistryItem => !!item);
    const scenarios = mapped.flatMap((item) => item.scenario);
    const oracles = mapped.flatMap((item) => item.oracle);
    const limitations = mapped
      .filter((item) => item.status !== "verified")
      .map((item) => `${item.id}: ${item.blockedReason ?? item.note ?? "uncovered"}`);
    if (!scenarios.length || !oracles.length)
      errors.push(`Capability ${link.id}: missing scenario/oracle linkage`);
    summary.push({
      ...link,
      status: limitations.length ? "blocked" : "verified",
      scenarios,
      oracles,
      limitations,
    });
  }
  for (const id of advertised)
    if (!seen.has(id)) {
      errors.push(`Capability ${id}: missing requirement/scenario/oracle/gate mapping`);
      summary.push({
        id,
        milestone: null,
        requirements: [],
        gate: "unmapped",
        status: "blocked",
        scenarios: [],
        oracles: [],
        limitations: ["Missing versioned capability mapping; milestone unverified."],
      });
    }
  return summary;
}

export function checkReleaseDecision(release: ReleaseDecision | undefined, errors: string[]): void {
  if (!release) {
    errors.push(
      "Release decision: missing per-area targets, observations, intervals, n and findings register",
    );
    return;
  }
  for (const finding of release.findings ?? []) {
    if (
      !["critical", "high", "medium", "low"].includes(finding.severity) ||
      !["open", "resolved"].includes(finding.status) ||
      !finding.id ||
      !finding.requirement
    )
      errors.push("Release finding: malformed finding");
    if (finding.status === "open" && ["critical", "high"].includes(finding.severity))
      errors.push(
        `Release blocked by ${finding.severity} finding ${finding.id} (${finding.requirement})`,
      );
  }
  if (!release.areas?.length || !Array.isArray(release.findings))
    errors.push("Release decision: areas and findings register required");
  for (const area of release.areas ?? []) {
    if (
      !area.area ||
      !area.proposedTarget ||
      !area.reason ||
      !Number.isInteger(area.n) ||
      area.n < 0 ||
      !["passed", "failed", "blocked"].includes(area.decision) ||
      (area.decision === "passed" &&
        (!area.approvedTarget ||
          area.observation === null ||
          !Number.isFinite(area.observation) ||
          area.n === 0 ||
          !area.interval ||
          area.interval.length !== 2 ||
          area.interval.some((value) => !Number.isFinite(value)) ||
          area.interval[0] > area.interval[1]))
    )
      errors.push(`Release area ${area.area}: unmeasured or malformed decision cannot pass`);
    if (area.decision !== "passed")
      errors.push(`Release area ${area.area}: ${area.decision} (${area.reason})`);
  }
}

export function checkCapabilityGateDefinitions(registry: Registry, errors: string[]): void {
  const gates = registry.release?.capabilityGates;
  if (gates === undefined) return;
  if (!Array.isArray(gates)) {
    errors.push("Capability gates: expected an array");
    return;
  }
  if (!Array.isArray(registry.release?.areas) || !Array.isArray(registry.release?.findings)) {
    errors.push("Capability gates: release areas and findings arrays required");
    return;
  }
  const ids = new Set<string>();
  const areas = new Set(registry.release?.areas?.map((area) => area.area));
  const items = new Set(registry.items.map((item) => item.id));
  if (areas.size !== registry.release.areas.length)
    errors.push("Capability gates: duplicate release area references");
  for (const gate of gates) {
    if (!gate || typeof gate.id !== "string" || !gate.id.trim()) {
      errors.push("Capability gate: non-empty id required");
      continue;
    }
    if (ids.has(gate.id)) errors.push(`Capability gate ${gate.id}: duplicate id`);
    ids.add(gate.id);
    for (const field of ["requiredAreas", "requiredItems", "nonNegotiable"] as const) {
      const values = gate[field];
      const known = field === "requiredAreas" ? areas : items;
      if (
        !Array.isArray(values) ||
        !values.length ||
        values.some((value) => typeof value !== "string" || !known.has(value)) ||
        new Set(values).size !== values.length
      )
        errors.push(`Capability gate ${gate.id}: ${field} requires unique existing references`);
    }
  }
}

export async function checkCapabilityGate(
  root: string,
  registry: Registry,
  id: string,
  now: number,
): Promise<CapabilityGateDecision> {
  const reasons: string[] = [];
  checkCapabilityGateDefinitions(registry, reasons);
  const gate = Array.isArray(registry.release?.capabilityGates)
    ? registry.release.capabilityGates.find((entry) => entry?.id === id)
    : undefined;
  if (!gate) reasons.push(`Capability gate ${id}: unknown gate`);
  if (!gate || reasons.length) return { id, status: "blocked", reasons };
  const required = new Set([...gate.requiredItems, ...gate.nonNegotiable]);
  for (const itemId of required) {
    const item = registry.items.find((entry) => entry.id === itemId);
    if (!item) continue; // Definition validation reports unknown references.
    if (item.status !== "verified") {
      reasons.push(
        `${itemId}: capability evidence not verified (${item.blockedReason ?? item.note ?? item.status})`,
      );
      continue;
    }
    await checkReleaseItem(root, item, reasons, now);
  }
  const release = registry.release;
  if (release)
    checkReleaseDecision(
      {
        findings: release.findings.filter((finding) => required.has(finding.requirement)),
        areas: release.areas.filter((area) => gate.requiredAreas.includes(area.area)),
      },
      reasons,
    );
  return { id, status: reasons.length ? "blocked" : "passed", reasons };
}
