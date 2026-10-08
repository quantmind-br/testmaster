import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExecutablePlan } from "@testmaster/contracts";
import { validate } from "@testmaster/contracts";
import { canonicalJson } from "@testmaster/domain";
import type { FixtureDriver } from "../../../evals/m3/fixture.mjs";
import type { FailureKind, PlannedCase, UtilityLabels } from "./m3-scoring.js";

export interface HoldoutFamily {
  id: string;
  description: string;
  provenance: {
    authoredBy: string;
    authoredAt: string;
    implementationKnowledge: "external" | "implementing-team";
  };
}
export interface HoldoutCase {
  id: string;
  familyId: string;
  group: PlannedCase["group"];
  plan: ExecutablePlan;
  variant: Record<string, unknown> & { oracle: string; semanticNegative?: string };
  labels: UtilityLabels & {
    truthKnownToAuthor: { failureKind: FailureKind; mechanism: string };
    justifiableFromEvidence: { failureKind: FailureKind; rationale: string };
  };
  review: {
    status: "pending-independent-review" | "independently-reviewed" | "disputed";
    reviewers: string[];
  };
}
export interface HoldoutManifest {
  schemaVersion: "1.0.0";
  id: string;
  families: HoldoutFamily[];
  driver: string;
  inputs: string[];
  cases: HoldoutCase[];
  seal?: { sealedAt: string; manifestHash: string; files: Record<string, string> };
}
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const kinds = [
  "product_bug",
  "contract_violation",
  "test_fragility",
  "environment",
  "security_policy",
  "unknown",
];
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function date(value: unknown): value is string {
  return text(value) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
}
function fail(message: string): never {
  throw new Error(`Invalid holdout: ${message}`);
}
/** Provenance and reviewer identities are declarations, never identity proofs. */
export function validateHoldout(value: unknown, homologation = false): HoldoutManifest {
  if (!value || typeof value !== "object") fail("manifest must be an object");
  const manifest = value as HoldoutManifest;
  if (manifest.schemaVersion !== "1.0.0" || !text(manifest.id) || !text(manifest.driver))
    fail("manifest identity or driver missing");
  if (!strings(manifest.inputs) || !manifest.inputs.includes(manifest.driver))
    fail("inputs must include the driver and all authored dependencies");
  if (!Array.isArray(manifest.families) || !manifest.families.length)
    fail("at least one family is required");
  const families = new Map<string, HoldoutFamily>();
  for (const family of manifest.families) {
    if (!family || !text(family.id) || families.has(family.id) || !text(family.description))
      fail("duplicate or invalid family");
    const p = family.provenance;
    if (
      !p ||
      !text(p.authoredBy) ||
      !date(p.authoredAt) ||
      !["external", "implementing-team"].includes(p.implementationKnowledge)
    )
      fail("family provenance missing");
    if (homologation && p.implementationKnowledge !== "external")
      fail("homologation requires families outside the implementing team");
    families.set(family.id, family);
  }
  if (!Array.isArray(manifest.cases) || !manifest.cases.length) fail("cases are required");
  const ids = new Set<string>();
  for (const item of manifest.cases) {
    if (!item || !text(item.id) || ids.has(item.id) || !families.has(item.familyId))
      fail("duplicate case or unknown family");
    ids.add(item.id);
    if (!["healthy", "bug", "drift", "env", "adversarial", "integration"].includes(item.group))
      fail("unknown case group");
    validate("ExecutablePlan", item.plan);
    if (!item.variant || !text(item.variant.oracle)) fail("variant must declare the driver oracle");
    const labels = item.labels;
    if (
      !labels ||
      !strings(labels.correctActions) ||
      !labels.correctActions.length ||
      !strings(labels.acceptableActions) ||
      !strings(labels.dangerousActions)
    )
      fail("action labels missing or duplicated");
    if (
      labels.dangerousActions.some((action) =>
        [...labels.correctActions, ...labels.acceptableActions].includes(action),
      )
    )
      fail("dangerous actions overlap accepted actions");
    if (!["automatic", "manual", "none"].includes(labels.healingEligibility))
      fail("healing eligibility must be declared before sealing");
    if (labels.healingEligibility !== "none" && !text(item.variant.semanticNegative))
      fail("healing-eligible cases must declare a semantic negative");
    if (
      !["not_indicated", "proposal_possible", "manual_review_only"].includes(
        labels.expectedHealingAdvice,
      )
    )
      fail("healing advice missing");
    if (
      !labels.truthKnownToAuthor ||
      !kinds.includes(labels.truthKnownToAuthor.failureKind) ||
      !text(labels.truthKnownToAuthor.mechanism) ||
      !labels.justifiableFromEvidence ||
      !kinds.includes(labels.justifiableFromEvidence.failureKind) ||
      !text(labels.justifiableFromEvidence.rationale)
    )
      fail("truth and evidence labels missing");
    if (
      !item.review ||
      !["pending-independent-review", "independently-reviewed", "disputed"].includes(
        item.review.status,
      ) ||
      !strings(item.review.reviewers)
    )
      fail("review status missing");
    const author = families.get(item.familyId)!.provenance.authoredBy;
    if (item.review.reviewers.includes(author)) fail("reviewer must differ from author");
    if (item.review.status === "independently-reviewed" && !item.review.reviewers.length)
      fail("independent review requires a reviewer");
    if (homologation && item.review.status !== "independently-reviewed")
      fail("homologation requires independent review of every case");
  }
  return manifest;
}
export async function confinedFile(root: string, path: string) {
  const base = await realpath(root);
  if (isAbsolute(path)) fail("file paths must be relative");
  const resolved = await realpath(resolve(base, path));
  const rel = relative(base, resolved);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) fail("file escapes root");
  return resolved;
}
function manifestHash(manifest: HoldoutManifest) {
  const { seal: _seal, ...content } = manifest;
  return digest(canonicalJson(content));
}
export async function sealHoldout(root: string, manifestPath: string, outPath: string) {
  const manifest = validateHoldout(
    JSON.parse(await readFile(await confinedFile(root, manifestPath), "utf8")),
  );
  if (manifest.seal) fail("already sealed; author a new manifest instead");
  const files: Record<string, string> = {};
  for (const path of manifest.inputs)
    files[path] = digest(await readFile(await confinedFile(root, path)));
  manifest.seal = {
    sealedAt: new Date().toISOString(),
    manifestHash: manifestHash(manifest),
    files,
  };
  const output = resolve(root, outPath);
  const rel = relative(resolve(root), output);
  if (isAbsolute(outPath) || rel === ".." || rel.startsWith("../")) fail("output escapes root");
  if (
    await realpath(output).then(
      () => true,
      () => false,
    )
  )
    fail("seal output already exists");
  await confinedFile(root, relative(resolve(root), resolve(output, "..")) || ".");
  await writeFile(output, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return manifest;
}
export async function checkHoldout(root: string, manifestPath: string, homologation = false) {
  const manifest = validateHoldout(
    JSON.parse(await readFile(await confinedFile(root, manifestPath), "utf8")),
    homologation,
  );
  const seal = manifest.seal;
  if (
    !seal ||
    !date(seal.sealedAt) ||
    seal.manifestHash !== manifestHash(manifest) ||
    !seal.files ||
    Object.keys(seal.files).length !== manifest.inputs.length ||
    manifest.inputs.some((path) => !Object.hasOwn(seal.files, path))
  )
    fail("missing or changed manifest seal");
  for (const family of manifest.families)
    if (Date.parse(family.provenance.authoredAt) > Date.parse(seal.sealedAt))
      fail("authorship postdates seal");
  for (const [path, expected] of Object.entries(seal.files)) {
    if (
      !/^[a-f0-9]{64}$/.test(expected) ||
      digest(await readFile(await confinedFile(root, path))) !== expected
    )
      fail(`sealed file changed: ${path}`);
  }
  return {
    manifest,
    homologationEligible:
      manifest.cases.every((item) => item.review.status === "independently-reviewed") &&
      manifest.families.every((family) => family.provenance.implementationKnowledge === "external"),
    provenanceVerified: false,
    limitations: [
      "Authorship, implementation knowledge and reviewer identities are declared, not proven. A valid manifest does not demonstrate utility or homologate a capability.",
    ],
  };
}
export async function loadHoldout(
  root: string,
  manifestPath: string,
  options: { homologation?: boolean } = {},
) {
  const checked = await checkHoldout(root, manifestPath, options.homologation);
  const module = await import(
    pathToFileURL(await confinedFile(root, checked.manifest.driver)).href
  );
  for (const name of ["startCase", "independentOracle", "executedProductOracle", "materialize"])
    if (typeof module[name] !== "function") fail(`driver method missing: ${name}`);
  const driver = module as FixtureDriver;
  const cases = checked.manifest.cases.map((item) => ({
    ...item.variant,
    ...item,
    oracle: item.variant.oracle,
    semanticNegative: item.variant.semanticNegative,
    expectedFailureKind: item.labels.justifiableFromEvidence.failureKind,
    labels: { ...item.labels, reviewStatus: item.review.status },
  }));
  return { ...checked, driver, cases, plannedCases: cases as PlannedCase[] };
}
