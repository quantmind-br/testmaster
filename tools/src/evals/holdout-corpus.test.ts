import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { checkHoldout, loadHoldout } from "./holdout.js";
import { emptyLedger, scoreM3 } from "./m3-scoring.js";

/**
 * VAL-014 / M0-04 / VAL-018 under ADR-012 (automated-only): the sealed holdout families are
 * versioned corpora whose seals verify, whose declared provenance is recorded, and whose frozen
 * model-free controls reproduce healthy pass and defective failure with an independent oracle.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const hex = /^[a-f0-9]{64}$/u;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const families = [
  {
    name: "library",
    round: "m3-round5-holdout-muse-spark-contributor",
    family: "reference-library",
  },
  {
    name: "helpdesk",
    round: "m3-round6-holdout-muse-spark-contributor",
    family: "reference-helpdesk",
  },
  {
    name: "dockyard",
    round: "m3-round7-holdout-muse-spark-contributor",
    family: "reference-dockyard",
  },
  { name: "clinic", round: "m3-round8-holdout-muse-spark-contributor", family: "reference-clinic" },
] as const;
const groups = { healthy: 4, bug: 8, drift: 12, env: 3, adversarial: 3 };

interface ControlRun {
  outcome: string | null;
  gate: string;
  steps: { id: string; status: string }[];
}
interface OracleVerdict {
  healthy: boolean;
  defective: boolean;
}
interface ControlEvidence {
  id: string;
  status: string;
  modelCalls: number;
  healthy: ControlRun | null;
  transformed: ControlRun | null;
  semantic: ControlRun | null;
  healthyOracle: OracleVerdict | null;
  transformedOracle: OracleVerdict | null;
  semanticOracle: OracleVerdict | null;
}
interface ControlsManifest {
  corpusHash: string;
  cases: { id: string; status: string; path: string; sha256: string }[];
}
const failed = (run: ControlRun | null) =>
  run?.steps.filter((step) => step.status === "failed").map((step) => step.id) ?? [];
/**
 * Independent re-derivation of the reproduction precondition from retained evidence: the healthy
 * baseline passes under the independent oracle and the defect (or drift) is observed by both the
 * executed test and the oracle. False means the case would fail its reproduction precondition.
 */
function reproduces(
  e: ControlEvidence,
  item: { group: string; variant: { expectedFailingStepIds?: string[] } },
): boolean {
  if (
    e.status !== "passed" ||
    e.modelCalls !== 0 ||
    e.healthy?.outcome !== "passed" ||
    e.healthy.gate !== "passed" ||
    e.healthyOracle?.healthy !== true ||
    e.healthyOracle.defective !== false ||
    !e.transformed
  )
    return false;
  if (item.group === "healthy")
    return e.transformed.outcome === "passed" && e.transformedOracle?.healthy === true;
  if (item.group === "env") return e.transformed.outcome !== "passed";
  const expected = item.variant.expectedFailingStepIds ?? [];
  const observed = expected.length > 0 && expected.some((id) => failed(e.transformed).includes(id));
  if (e.semantic)
    // Drift: the product stays healthy, the plan breaks, and the semantic mutant is still caught.
    return (
      e.transformed.outcome === "failed" &&
      observed &&
      e.transformedOracle?.healthy === true &&
      e.semantic.outcome === "failed" &&
      e.semanticOracle?.defective === true
    );
  return (
    e.transformed.outcome === "failed" &&
    observed &&
    e.transformedOracle?.defective === true &&
    e.transformedOracle.healthy === false
  );
}

type Family = (typeof families)[number];
async function verifySealedCorpus(entry: Family) {
  const path = `evals/holdout/m3-${entry.name}/sealed.json`;
  const checked = await checkHoldout(root, path, true);
  expect(checked.homologationEligible).toBe(true);
  expect(checked.validation).toBe("automated-only");
  expect(checked.provenanceVerified).toBe(false);
  expect(checked.disputedCases).toEqual([]);
  const manifest = checked.manifest;
  expect(manifest.implementation?.commit).toMatch(/^[a-f0-9]{40}$/u);
  expect(manifest.seal?.manifestHash).toMatch(hex);
  expect(Object.keys(manifest.seal!.files).sort()).toEqual([...manifest.inputs].sort());
  for (const digest of Object.values(manifest.seal!.files)) expect(digest).toMatch(hex);
  expect(manifest.families).toHaveLength(1);
  const provenance = manifest.families[0]!.provenance;
  expect(manifest.families[0]!.id).toBe(entry.family);
  expect(provenance).toMatchObject({
    implementationKnowledge: "implementing-team",
    developmentUse: "none",
  });
  expect(provenance.authoredBy.length).toBeGreaterThan(0);
  expect(Date.parse(provenance.authoredAt)).toBeGreaterThanOrEqual(
    Date.parse(manifest.implementation!.frozenAt),
  );
  expect(Date.parse(provenance.authoredAt)).toBeLessThanOrEqual(
    Date.parse(manifest.seal!.sealedAt),
  );
  const counts: Record<string, number> = {};
  const baselines = new Set<string>();
  for (const item of manifest.cases) {
    counts[item.group] = (counts[item.group] ?? 0) + 1;
    const variant = item.variant as {
      oracle: string;
      mutant?: string;
      semanticNegative?: string;
      expectedFailingStepIds?: string[];
      digests: { healthy: Record<string, string>; transformed: Record<string, string> };
    };
    // Baseline hash, deterministic oracle and expected failing step are declared per case.
    expect(variant.oracle.length).toBeGreaterThan(0);
    expect(Array.isArray(variant.expectedFailingStepIds)).toBe(true);
    expect(Object.values(variant.digests.healthy).length).toBeGreaterThan(0);
    for (const digest of [
      ...Object.values(variant.digests.healthy),
      ...Object.values(variant.digests.transformed),
    ])
      expect(digest).toMatch(hex);
    if (!(item.variant as { baselinePatches?: unknown }).baselinePatches)
      baselines.add(JSON.stringify(variant.digests.healthy));
    // Defect: a named mutant (bug) or a named semantic negative plus a source transformation (drift).
    if (item.group === "bug") expect(variant.mutant).toEqual(expect.any(String));
    if (item.group === "drift") {
      expect(variant.semanticNegative).toEqual(expect.any(String));
      expect(JSON.stringify(variant.digests.transformed)).not.toBe(
        JSON.stringify(variant.digests.healthy),
      );
      expect(item.labels.healingEligibility).not.toBe("none");
    }
    // Violated requirement and labels: author truth, evidence-justifiable label, declared actions.
    expect(item.labels.truthKnownToAuthor.mechanism.length).toBeGreaterThan(0);
    expect(item.labels.justifiableFromEvidence.rationale.length).toBeGreaterThan(0);
    expect(item.labels.correctActions.length).toBeGreaterThan(0);
    expect(item.labels.labelSource).toBe("sealed-before-first-evaluated-call");
    expect((item as { review?: unknown }).review).toBeUndefined();
  }
  expect(counts).toEqual(groups);
  expect(manifest.cases).toHaveLength(30);
  // One fixed baseline per family; only cases declaring baselinePatches start elsewhere.
  expect(baselines.size).toBe(1);
}
async function verifyRetainedControls(entry: Family) {
  const corpusPath = `evals/holdout/m3-${entry.name}/sealed.json`;
  const holdout = await loadHoldout(root, corpusPath, { homologation: true });
  const directory = join(root, "evals/rounds", entry.round);
  const manifestBytes = await readFile(join(directory, "controls/manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString()) as ControlsManifest;
  const registration = JSON.parse(await readFile(join(directory, "preregistration.json"), "utf8"));
  expect(registration.corpus).toBe(corpusPath);
  expect(registration.readiness.controlsHash).toBe(sha256(manifestBytes));
  expect(manifest.corpusHash).toBe(sha256(await readFile(join(root, corpusPath))));
  expect(manifest.cases.map((row) => row.id).sort()).toEqual(
    holdout.cases.map((item) => item.id).sort(),
  );
  let healthyOk = 0;
  let defectiveOk = 0;
  for (const item of holdout.cases) {
    const row = manifest.cases.find((candidate) => candidate.id === item.id)!;
    const bytes = await readFile(join(root, row.path));
    expect(sha256(bytes), `${item.id} evidence hash`).toBe(row.sha256);
    const evidence = JSON.parse(bytes.toString()) as ControlEvidence;
    expect(reproduces(evidence, item), `${item.id} reproduction precondition`).toBe(true);
    healthyOk++;
    if (!["healthy", "env"].includes(item.group)) defectiveOk++;
  }
  expect(healthyOk).toBe(30);
  expect(defectiveOk).toBe(23);
}

it("sealed holdout corpora verify, declare provenance and link baseline, defect, oracle and expected step in all four families", async () => {
  for (const entry of families) await verifySealedCorpus(entry);
});

it("retained model-free controls bind to each sealed corpus and reproduce healthy pass and defective failure", async () => {
  for (const entry of families) await verifyRetainedControls(entry);
});

it("negative controls: tampered evidence fails the reproduction precondition", async () => {
  const directory = join(root, "evals/rounds/m3-round8-holdout-muse-spark-contributor/controls");
  const holdout = await loadHoldout(root, "evals/holdout/m3-clinic/sealed.json", {
    homologation: true,
  });
  const read = async (id: string) =>
    JSON.parse(await readFile(join(directory, `${id}.json`), "utf8")) as ControlEvidence;
  const item = (id: string) => holdout.cases.find((row) => row.id === id)!;
  const bug = await read("cl-bug-01");
  expect(reproduces(bug, item("cl-bug-01"))).toBe(true);
  // The healthy baseline is reported as defective by the oracle.
  expect(
    reproduces({ ...bug, healthyOracle: { healthy: false, defective: true } }, item("cl-bug-01")),
  ).toBe(false);
  // The defective side passes: a test that passes on both sides is not a detector.
  expect(
    reproduces(
      { ...bug, transformed: { ...bug.transformed!, outcome: "passed" } },
      item("cl-bug-01"),
    ),
  ).toBe(false);
  // The oracle does not confirm the defect.
  expect(
    reproduces(
      { ...bug, transformedOracle: { healthy: true, defective: false } },
      item("cl-bug-01"),
    ),
  ).toBe(false);
  // The failing step is not the declared one.
  expect(
    reproduces(
      {
        ...bug,
        transformed: {
          ...bug.transformed!,
          steps: bug.transformed!.steps.map((step) => ({ ...step, status: "passed" })),
        },
      },
      item("cl-bug-01"),
    ),
  ).toBe(false);
  const drift = await read("cl-drift-02");
  expect(reproduces(drift, item("cl-drift-02"))).toBe(true);
  expect(
    reproduces(
      { ...drift, semanticOracle: { healthy: true, defective: false } },
      item("cl-drift-02"),
    ),
  ).toBe(false);
  expect(reproduces({ ...drift, status: "blocked" }, item("cl-drift-02"))).toBe(false);
});

it("VAL-018: sealed families contain no disputed case and score the disputed stratum separately and empty", async () => {
  for (const entry of families) {
    const holdout = await loadHoldout(root, `evals/holdout/m3-${entry.name}/sealed.json`, {
      homologation: true,
    });
    expect(holdout.disputedCases).toEqual([]);
    expect(holdout.cases.every((item) => item.labels.labelStatus === "sealed")).toBe(true);
    const score = scoreM3(holdout.plannedCases.map(emptyLedger), holdout.plannedCases);
    // Nothing was removed or relabelled: every sealed case is in the undisputed denominator.
    expect(score.utility.plannedCases).toBe(30);
    expect(score.utility.disputed.caseIds).toEqual([]);
    expect(score.utility.disputed.plannedCases).toBe(0);
    expect(score.utility.missingLabels).toEqual([]);
    expect(score.utility.unsealedLabels).toEqual([]);
    expect(score.healingUtility.disputed.caseIds).toEqual([]);
  }
  // Retained scored rounds report the same separate, empty stratum.
  for (const round of [6, 7, 8]) {
    const results = join(root, "evals/results");
    const found = (await readdir(results)).filter((name) =>
      name.startsWith(`m3-round${round}-holdout-`),
    );
    expect(found).toHaveLength(1);
    const report = JSON.parse(await readFile(join(results, found[0]!, "report.json"), "utf8"));
    expect(report.score.utility.plannedCases).toBe(30);
    expect(report.score.utility.disputed.caseIds).toEqual([]);
    expect(report.score.utility.disputed.plannedCases).toBe(0);
    expect(report.score.utility.unsealedLabels).toEqual([]);
    expect(report.score.healingUtility.disputed.caseIds).toEqual([]);
  }
});
