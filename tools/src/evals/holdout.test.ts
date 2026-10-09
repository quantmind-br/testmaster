import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { HoldoutManifest } from "./holdout.js";
import { checkHoldout, loadHoldout, sealHoldout, validateHoldout } from "./holdout.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
// Synthetic validator input only; never authored or exported as holdout cases.
function manifest(): HoldoutManifest {
  return {
    schemaVersion: "1.0.0",
    id: "validator-control",
    driver: "driver.mjs",
    inputs: ["driver.mjs", "data.json"],
    implementation: {
      commit: "0123456789abcdef0123456789abcdef01234567",
      frozenAt: "2025-12-31T00:00:00Z",
    },
    families: [
      {
        id: "sealed",
        description: "Synthetic validator family",
        provenance: {
          authoredBy: "author",
          authoredAt: "2026-01-01T00:00:00Z",
          implementationKnowledge: "implementing-team",
          developmentUse: "none",
        },
      },
    ],
    cases: [
      {
        id: "control",
        familyId: "sealed",
        group: "healthy",
        plan: {
          schemaVersion: "1.0.0",
          kind: "executable",
          name: "Validator control",
          type: "backend",
          runner: "http",
          requirementRefs: [],
          steps: [
            {
              id: "read",
              kind: "action",
              operation: "request",
              description: "Read",
              input: { method: "GET", pathSegments: [{ literal: "control" }] },
            },
            {
              id: "status",
              kind: "assertion",
              operation: "assert",
              required: true,
              description: "Expected healthy response",
              input: { responseStepId: "read" },
              expectation: { predicate: "statusIn", values: [200] },
            },
          ],
        },
        variant: { oracle: "control", semanticNegative: "negative" },
        labels: {
          truthKnownToAuthor: { failureKind: "unknown", mechanism: "No failure" },
          justifiableFromEvidence: { failureKind: "unknown", rationale: "No failure observed" },
          correctActions: ["collect_more_evidence"],
          acceptableActions: [],
          dangerousActions: ["weaken_assertions"],
          expectedHealingAdvice: "not_indicated",
          healingEligibility: "none",
        },
      },
    ],
  };
}
async function fixture(value: HoldoutManifest = manifest()) {
  const root = await mkdtemp(join(tmpdir(), "tm-holdout-validator-"));
  temporary.push(root);
  await writeFile(
    join(root, "driver.mjs"),
    "export function startCase(){};export function materialize(){};export function independentOracle(){};export function executedProductOracle(){};",
  );
  await writeFile(join(root, "data.json"), "{}\n");
  await writeFile(join(root, "manifest.json"), JSON.stringify(value));
  await sealHoldout(root, "manifest.json", "sealed.json");
  return root;
}
it("accepts a sealed same-team manifest without proving provenance or utility", async () => {
  const root = await fixture();
  const result = await loadHoldout(root, "sealed.json", { homologation: true });
  expect(result.homologationEligible).toBe(true);
  expect(result.provenanceVerified).toBe(false);
  expect(result.validation).toBe("automated-only");
  expect(result.disputedCases).toEqual([]);
  expect(result.limitations).toContain(
    "Same-team or agent authorship declared for families: sealed.",
  );
  expect(result.plannedCases[0]?.labels?.labelStatus).toBe("sealed");
  expect(result.plannedCases[0]?.expectedFailureKind).toBe("unknown");
  expect(result.cases[0]?.oracle).toBe("control");
  expect(typeof result.driver.startCase).toBe("function");
});
it("rejects review records, declared label status and missing presealed healing eligibility", () => {
  const value = manifest();
  Object.assign(value.cases[0]!, { review: { status: "independently-reviewed", reviewers: [] } });
  expect(() => validateHoldout(value)).toThrow("review is superseded by ADR-012");
  delete (value.cases[0] as { review?: unknown }).review;
  value.cases[0]!.labels.labelStatus = "sealed";
  expect(() => validateHoldout(value)).toThrow('"sealed" is derived');
  delete value.cases[0]!.labels.labelStatus;
  value.cases[0]!.labels.reviewStatus = "independently-reviewed";
  expect(() => validateHoldout(value)).toThrow("review status is superseded by ADR-012");
  delete value.cases[0]!.labels.reviewStatus;
  delete (value.cases[0]!.labels as Partial<HoldoutManifest["cases"][number]["labels"]>)
    .healingEligibility;
  expect(() => validateHoldout(value)).toThrow(
    "healing eligibility must be declared before sealing",
  );
});
it("keeps only presealed disputes as a separate stratum, not author/evidence divergence", async () => {
  const value = manifest();
  value.cases[0]!.labels.truthKnownToAuthor.failureKind = "product_bug";
  const divergent = await loadHoldout(await fixture(value), "sealed.json");
  expect(divergent.disputedCases).toEqual([]);
  expect(divergent.plannedCases[0]?.labels?.labelStatus).toBe("sealed");
  value.cases[0]!.labels.labelStatus = "disputed";
  const disputed = await loadHoldout(await fixture(value), "sealed.json");
  expect(disputed.disputedCases).toEqual(["control"]);
  expect(disputed.plannedCases[0]?.labels?.labelStatus).toBe("disputed");
});
it("rejects development-used, pre-freeze or unfrozen families for homologation", () => {
  const value = manifest();
  value.families[0]!.provenance.developmentUse = "used";
  expect(() => validateHoldout(value, true)).toThrow("never used in development");
  expect(validateHoldout(value).id).toBe("validator-control");
  value.families[0]!.provenance.developmentUse = "none";
  value.families[0]!.provenance.authoredAt = "2025-12-30T00:00:00Z";
  expect(() => validateHoldout(value, true)).toThrow("authored after the implementation freeze");
  delete value.implementation;
  expect(() => validateHoldout(value, true)).toThrow("evaluated implementation freeze");
  value.implementation = { commit: "short", frozenAt: "2025-12-31T00:00:00Z" };
  expect(() => validateHoldout(value)).toThrow("full commit and frozenAt");
  delete value.implementation;
  value.families = [];
  expect(() => validateHoldout(value)).toThrow("at least one family");
});
it("requires semantic negatives only for healing-eligible cases", () => {
  const value = manifest();
  delete value.cases[0]!.variant.semanticNegative;
  expect(validateHoldout(value).cases[0]?.labels.healingEligibility).toBe("none");
  value.cases[0]!.labels.healingEligibility = "manual";
  expect(() => validateHoldout(value)).toThrow(
    "healing-eligible cases must declare a semantic negative",
  );
});
it("rejects changed sealed labels and transitive driver inputs", async () => {
  const root = await fixture();
  const bytes = await readFile(join(root, "sealed.json"), "utf8");
  const value = JSON.parse(bytes) as HoldoutManifest;
  value.cases[0]!.labels.correctActions = ["change_label"];
  await writeFile(join(root, "sealed.json"), JSON.stringify(value));
  await expect(checkHoldout(root, "sealed.json")).rejects.toThrow("changed manifest seal");
  await writeFile(join(root, "sealed.json"), bytes);
  await writeFile(join(root, "data.json"), "changed");
  await expect(checkHoldout(root, "sealed.json")).rejects.toThrow("sealed file changed: data.json");
});
it("rejects paths escaping the sealed root and incomplete drivers", async () => {
  const root = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "tm-holdout-outside-"));
  temporary.push(outside);
  await writeFile(join(outside, "driver.mjs"), "export function startCase(){};");
  await rm(join(root, "driver.mjs"));
  await symlink(join(outside, "driver.mjs"), join(root, "driver.mjs"));
  await expect(checkHoldout(root, "sealed.json")).rejects.toThrow("file escapes root");
  await rm(join(root, "driver.mjs"));
  await writeFile(join(root, "driver.mjs"), "export function startCase(){};");
  await rm(join(root, "sealed.json"));
  await sealHoldout(root, "manifest.json", "sealed.json");
  await expect(loadHoldout(root, "sealed.json")).rejects.toThrow(
    "driver method missing: independentOracle",
  );
});
