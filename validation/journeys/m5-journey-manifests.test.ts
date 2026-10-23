import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root } from "./harness.js";

/**
 * VAL-035 for the M5 journeys: the J13 tracker half and J18, which composes the M5-03 to M5-06
 * journeys. Each harness manifest under `validation/results/` is written by a versioned script that
 * names it, is cited as evidence of its journey's registry item next to that script, and records a
 * passing automatic run with the named automated reviewer and no claim of human sign-off.
 */
interface M5Manifest {
  /** Registry item of the journey the manifest belongs to. */
  readonly id: "J13" | "J18";
  readonly script: string;
  /** Harness journey name; the manifest is `validation/results/<journey>.json`. */
  readonly journey: string;
}

export const m5Manifests: readonly M5Manifest[] = [
  { id: "J13", script: "validation/journeys/j13-tracker.pg.test.ts", journey: "j13-tracker" },
  ...[
    ["m5-matrix-visual", "M5-03-visual-baselines"],
    ["m5-accessibility", "M5-04-accessibility-mutant"],
    ["m5-accessibility", "M5-04-accessibility-healthy"],
    ["m5-api-property", "M5-05-property-openapi"],
    ["m5-api-property", "M5-05-property-auth"],
    ["m5-security-load", "M5-06-access"],
    ["m5-security-load", "M5-06-dast"],
    ["m5-security-load", "M5-06-load"],
  ].map(([script, journey]) => ({
    id: "J18" as const,
    script: `validation/journeys/${script}.docker.test.ts`,
    journey: String(journey),
  })),
];

interface RegistryItem {
  scenario: string[];
  evidence: string[];
}
interface HarnessManifest {
  journey: string;
  method: string;
  reviewer: string;
  passed: boolean;
  observedAt: string;
  reviewLimitations: string[];
}

/** Problems with one M5 journey manifest; empty when it is complete. */
export function manifestProblems(
  entry: M5Manifest,
  scriptText: string,
  item: RegistryItem,
  manifest: HarnessManifest | null,
): string[] {
  const problems: string[] = [];
  const label = `${entry.id} ${entry.journey}`;
  if (!scriptText.includes(`"${entry.journey}"`))
    problems.push(`${label}: the script never writes this manifest`);
  if (!item.scenario.some((scenario) => scenario.startsWith(`${entry.script}::`)))
    problems.push(`${label}: the registry item does not cite the script`);
  if (!item.evidence.includes(`validation/results/${entry.journey}.json`))
    problems.push(`${label}: the registry item does not cite the manifest`);
  if (!manifest) {
    problems.push(`${label}: the manifest is missing`);
    return problems;
  }
  if (manifest.journey !== entry.journey)
    problems.push(`${label}: the manifest names ${manifest.journey}`);
  if (manifest.method !== "automatic")
    problems.push(`${label}: method is ${manifest.method}, not automatic`);
  if (manifest.reviewer !== "testmaster-automated-acceptance")
    problems.push(`${label}: reviewer is ${manifest.reviewer}`);
  if (!manifest.passed) problems.push(`${label}: the manifest records a failure`);
  if (Number.isNaN(Date.parse(manifest.observedAt)))
    problems.push(`${label}: observedAt is not a timestamp`);
  if (!manifest.reviewLimitations.some((line) => /no independent human sign-off/u.test(line)))
    problems.push(`${label}: the no-human-sign-off limitation is missing`);
  return problems;
}

async function load(entry: M5Manifest): Promise<{
  text: string;
  item: RegistryItem;
  manifest: HarnessManifest;
}> {
  const read = (path: string) => readFile(join(root, path), "utf8");
  const registry = JSON.parse(await read("traceability/registry.json")) as {
    items: (RegistryItem & { id: string })[];
  };
  const item = registry.items.find((candidate) => candidate.id === entry.id);
  if (!item) throw new Error(`${entry.id} is not in the registry`);
  return {
    text: await read(entry.script),
    item,
    manifest: JSON.parse(await read(`validation/results/${entry.journey}.json`)) as HarnessManifest,
  };
}

describe("M5 journey manifests", () => {
  it("VAL-035 J13 tracker and J18 manifests come from versioned scripts the registry cites and record an automatic, reviewer-named pass", async () => {
    for (const entry of m5Manifests) {
      const { text, item, manifest } = await load(entry);
      expect(manifestProblems(entry, text, item, manifest), entry.journey).toEqual([]);
    }
  });

  it("VAL-035 rejects an M5 manifest its script does not write, the registry does not cite, or that claims a human", async () => {
    const entry = m5Manifests.find((candidate) => candidate.journey === "j13-tracker");
    if (!entry) throw new Error("j13-tracker missing");
    const { text, item, manifest } = await load(entry);
    const label = "J13 j13-tracker";
    expect(manifestProblems(entry, text, item, manifest)).toEqual([]);
    expect(manifestProblems(entry, "no journey here", item, manifest)).toContain(
      `${label}: the script never writes this manifest`,
    );
    // J13 keeps citing its M4 script and manifest; only this journey's own citation is removed.
    const otherScenarios = item.scenario.filter((scenario) => !scenario.startsWith(entry.script));
    expect(
      manifestProblems(entry, text, { ...item, scenario: otherScenarios }, manifest),
    ).toContain(`${label}: the registry item does not cite the script`);
    const otherEvidence = item.evidence.filter((path) => !path.endsWith("/j13-tracker.json"));
    expect(manifestProblems(entry, text, { ...item, evidence: otherEvidence }, manifest)).toContain(
      `${label}: the registry item does not cite the manifest`,
    );
    expect(manifestProblems(entry, text, item, { ...manifest, passed: false })).toContain(
      `${label}: the manifest records a failure`,
    );
    expect(manifestProblems(entry, text, item, { ...manifest, method: "manual" })).toContain(
      `${label}: method is manual, not automatic`,
    );
    expect(manifestProblems(entry, text, item, { ...manifest, reviewLimitations: [] })).toContain(
      `${label}: the no-human-sign-off limitation is missing`,
    );
    expect(manifestProblems(entry, text, item, null)).toContain(
      `${label}: the manifest is missing`,
    );
  });
});
