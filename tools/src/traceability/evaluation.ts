import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { type CheckResult, checkRepository, type Milestone, type Registry } from "./check.js";
import type {
  AreaSummary,
  CapabilityGateDecision,
  CapabilitySummary,
  ReleaseArea,
  ReleaseDecision,
} from "./release.js";

const git = promisify(execFile);
const recordRoot = "validation/results/release-evaluations";
const recordPath =
  /^validation\/results\/release-evaluations\/[A-Za-z0-9][A-Za-z0-9._-]*\/[0-9a-f]{40}\.json$/u;
const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const milestonePattern = /^M[0-6]$/u;

/** Claim limits copied from ADR-012; a record is an automated decision, never a human sign-off. */
export const evaluationLimitations: readonly string[] = [
  "Validation is automated-only (ADR-012): no independent review, human usability, human decision-time or workload gain is claimed.",
  "The record states the gate decision of the checker at one commit; it does not prove that a release target was met beyond the registry evidence it cites.",
  "A superseded area keeps its historical decision; supersession narrows the claim scope to the superseding area (ADR-013).",
  "Deferred residual scope is not verified by this record; it blocks the later milestone gate it names.",
];

export interface ReleaseEvaluationRecord {
  schemaVersion: "1.0.0";
  kind: "release-evaluation";
  /** Milestone gate evaluated, or null for a capability gate evaluation. */
  gate: Milestone | null;
  capabilityGate: string | null;
  commit: string;
  observedAt: string;
  method: "automatic";
  reviewer: "traceability-checker";
  validation: "automated-only";
  registrySha256: string;
  ok: boolean;
  errors: string[];
  capabilitySummary: CapabilitySummary[] | null;
  capabilityGateDecision: CapabilityGateDecision | null;
  areaSummary: AreaSummary[] | null;
  areas: ReleaseArea[];
  findings: ReleaseDecision["findings"];
  limitations: readonly string[];
}

export type ReleaseEvaluationOptions = { root: string; now?: Date } & (
  | { gate: Milestone; capabilityGate?: undefined }
  | { capabilityGate: string; gate?: undefined }
);

async function gitOutput(root: string, args: string[]): Promise<string> {
  const { stdout } = await git("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/**
 * The tree must be committed. Untracked records written by an earlier evaluation of the same commit
 * are tolerated so several gates (and the refusal to overwrite) can be evaluated before one commit
 * of the evidence; any other untracked or modified path refuses.
 */
async function assertCleanTree(root: string): Promise<void> {
  const status = await gitOutput(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const dirty = status
    .split("\0")
    .filter(Boolean)
    .some((entry) => !(entry.startsWith("?? ") && recordPath.test(entry.slice(3))));
  if (dirty) throw new Error("Release evaluation requires a clean committed tree");
}

export async function recordReleaseEvaluation(
  options: ReleaseEvaluationOptions,
): Promise<{ path: string; ok: boolean; record: ReleaseEvaluationRecord }> {
  const { root, gate, capabilityGate } = options;
  let directory: string;
  if (capabilityGate === undefined) {
    if (gate === undefined || !milestonePattern.test(gate))
      throw new Error(`Release evaluation requires a milestone gate M0..M6, received ${gate}`);
    directory = gate;
  } else if (!safeSegment.test(capabilityGate))
    throw new Error(`Release evaluation capability gate id is not a safe name: ${capabilityGate}`);
  else directory = capabilityGate;
  await assertCleanTree(root);
  const commit = (await gitOutput(root, ["rev-parse", "HEAD"])).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("Release evaluation requires a git commit");
  const registryBytes = await readFile(resolve(root, "traceability/registry.json"));
  const result: CheckResult =
    capabilityGate === undefined
      ? await checkRepository(root, gate)
      : await checkRepository(root, undefined, capabilityGate);
  if (
    capabilityGate !== undefined &&
    result.errors.includes(`Capability gate ${capabilityGate}: unknown gate`)
  )
    throw new Error(`Release evaluation refused: unknown capability gate ${capabilityGate}`);
  const registry: Registry = JSON.parse(registryBytes.toString("utf8"));
  const release = registry.release;
  const record: ReleaseEvaluationRecord = {
    schemaVersion: "1.0.0",
    kind: "release-evaluation",
    gate: capabilityGate === undefined ? (gate ?? null) : null,
    capabilityGate: capabilityGate ?? null,
    commit,
    observedAt: (options.now ?? new Date()).toISOString(),
    method: "automatic",
    reviewer: "traceability-checker",
    validation: "automated-only",
    registrySha256: createHash("sha256").update(registryBytes).digest("hex"),
    ok: result.ok,
    errors: result.errors,
    capabilitySummary: result.capabilitySummary ?? null,
    capabilityGateDecision: result.capabilityGate ?? null,
    areaSummary: result.areaSummary ?? null,
    areas: release?.areas ?? [],
    findings: release?.findings ?? [],
    limitations: evaluationLimitations,
  };
  const path = resolve(root, recordRoot, directory, `${commit}.json`);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error(
        "Release evaluation already recorded for this gate and commit; commit a new revision",
      );
    throw error;
  }
  return { path, ok: record.ok, record };
}
