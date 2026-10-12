import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RegistryItem } from "./check.js";
import { recordReleaseEvaluation } from "./evaluation.js";
import type { ReleaseArea } from "./release.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const assertion = 'expect(outcome.state).toBe("failed")';
function git(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd: root, encoding: "utf8" },
  );
}
function area(overrides: Partial<ReleaseArea> = {}): ReleaseArea {
  return {
    area: "performance",
    gate: "M0",
    series: "performance",
    proposedTarget: "p95 under 2 s",
    approvedTarget: "p95 under 2 s",
    observation: 1.4,
    interval: [1.1, 1.8],
    n: 40,
    decision: "passed",
    reason: "measured on the reference fixture",
    ...overrides,
  };
}
function verified(): RegistryItem {
  return {
    id: "SEC-001",
    title: "Threat model",
    sourceFile: "SPEC.md",
    milestone: "M0",
    ownerRole: "Security",
    status: "verified",
    scenario: ["acceptance.test.ts::healthy", "acceptance.test.ts::mutant"],
    oracle: ["independent state"],
    code: ["implementation.ts"],
    evidence: ["acceptance.test.ts"],
    coverage: {
      positive: ["acceptance.test.ts::healthy"],
      negative: ["acceptance.test.ts::mutant"],
      criticalAssertions: [{ path: "acceptance.test.ts", assertion }],
    },
  };
}
/** Temporary git repository with a minimal registry that the real checker accepts at gate M0. */
async function repository(
  options: { item?: Partial<RegistryItem>; areas?: ReleaseArea[] } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tm-eval-"));
  roots.push(root);
  await mkdir(join(root, "specs"));
  await mkdir(join(root, "traceability"));
  await mkdir(join(root, "packages/contracts/src"), { recursive: true });
  await writeFile(join(root, "SPEC.md"), "| SEC-001 | Threat model |\n");
  await writeFile(join(root, "ROADMAP.md"), "References: SEC-001\n");
  await writeFile(join(root, "specs/01-test.md"), "No identifiers here.\n");
  await writeFile(
    join(root, "packages/contracts/src/registries.ts"),
    'const features: Record<string, boolean> = {\n  "alpha": true,\n};\n',
  );
  await writeFile(
    join(root, "acceptance.test.ts"),
    `it("healthy", () => {}); it("mutant", () => { ${assertion}; });\n`,
  );
  await writeFile(join(root, "implementation.ts"), "export {};\n");
  const areas = options.areas ?? [area()];
  await writeFile(
    join(root, "traceability/registry.json"),
    `${JSON.stringify(
      {
        items: [{ ...verified(), ...options.item }],
        capabilities: [{ id: "alpha", milestone: "M0", requirements: ["SEC-001"], gate: "M0" }],
        release: {
          findings: [],
          areas,
          capabilityGates: [
            {
              id: "alpha-gate",
              requiredAreas: [areas[0]?.area ?? "performance"],
              requiredItems: ["SEC-001"],
              nonNegotiable: ["SEC-001"],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  return root;
}
const recordDirectory = (root: string) => join(root, "validation/results/release-evaluations");

describe("release evaluation record", () => {
  it("records one immutable release evaluation per gate and commit and refuses overwrite", async () => {
    const root = await repository();
    const first = await recordReleaseEvaluation({ root, gate: "M0" });
    const commit = git(root, "rev-parse", "HEAD").trim();
    expect(first.ok).toBe(true);
    expect(first.path).toBe(join(recordDirectory(root), "M0", `${commit}.json`));
    const written = await readFile(first.path, "utf8");
    await expect(recordReleaseEvaluation({ root, gate: "M0" })).rejects.toThrow("already recorded");
    expect(await readFile(first.path, "utf8")).toBe(written);
    const stored = JSON.parse(written);
    expect(stored).toMatchObject({
      kind: "release-evaluation",
      gate: "M0",
      capabilityGate: null,
      commit,
      method: "automatic",
      validation: "automated-only",
      ok: true,
      errors: [],
    });
    const registry = await readFile(join(root, "traceability/registry.json"));
    expect(stored.registrySha256).toBe(createHash("sha256").update(registry).digest("hex"));
    expect(stored.limitations.length).toBeGreaterThan(0);
  });

  it("refuses a dirty worktree before writing evaluation evidence", async () => {
    const root = await repository();
    await writeFile(join(root, "stray.txt"), "untracked\n");
    await expect(recordReleaseEvaluation({ root, gate: "M0" })).rejects.toThrow(
      "clean committed tree",
    );
    await expect(access(recordDirectory(root))).rejects.toThrow();
    await rm(join(root, "stray.txt"));
    await writeFile(join(root, "implementation.ts"), "export const changed = true;\n");
    await expect(recordReleaseEvaluation({ root, gate: "M0" })).rejects.toThrow(
      "clean committed tree",
    );
    await expect(access(recordDirectory(root))).rejects.toThrow();
  });

  it("tolerates only exact untracked records of earlier evaluations and refuses other files beside them", async () => {
    const root = await repository();
    await recordReleaseEvaluation({ root, gate: "M0" });
    const capability = await recordReleaseEvaluation({ root, capabilityGate: "alpha-gate" });
    expect(capability.ok).toBe(true);
    await writeFile(join(recordDirectory(root), "M0", "notes.txt"), "not a record\n");
    await expect(recordReleaseEvaluation({ root, gate: "M1" })).rejects.toThrow(
      "clean committed tree",
    );
    await expect(access(join(recordDirectory(root), "M1"))).rejects.toThrow();
  });

  it("keeps failed gates as evidence with exact blocking reasons instead of replacing them", async () => {
    const root = await repository({
      item: { status: "planned", coverage: undefined, evidence: [], code: [] },
    });
    const outcome = await recordReleaseEvaluation({ root, gate: "M0" });
    expect(outcome.ok).toBe(false);
    const stored = JSON.parse(await readFile(outcome.path, "utf8"));
    expect(stored.ok).toBe(false);
    expect(stored.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("SEC-001: planned M0 item blocks")]),
    );
    expect(stored.commit).toBe(git(root, "rev-parse", "HEAD").trim());
    await expect(recordReleaseEvaluation({ root, gate: "M0" })).rejects.toThrow("already recorded");
  });

  it("copies per-area targets, observations, intervals and n without a compensatory score", async () => {
    const areas = [
      area(),
      area({
        area: "security",
        series: "security",
        proposedTarget: "zero critical",
        approvedTarget: null,
        observation: null,
        interval: null,
        n: 0,
        decision: "failed",
        reason: "sandbox escape reproduced",
      }),
    ];
    const root = await repository({ areas });
    const outcome = await recordReleaseEvaluation({ root, gate: "M0" });
    expect(outcome.ok).toBe(false);
    const stored = JSON.parse(await readFile(outcome.path, "utf8"));
    expect(stored.areas).toEqual(areas);
    expect(stored.areaSummary).toEqual([
      {
        area: "performance",
        gate: "M0",
        series: "performance",
        decision: "passed",
        effect: "passed",
      },
      { area: "security", gate: "M0", series: "security", decision: "failed", effect: "blocking" },
    ]);
    expect(stored.errors).toContain("Release area security: failed (sandbox escape reproduced)");
    expect(stored).not.toHaveProperty("score");
  });

  it("evaluates a capability gate into its own directory and refuses unknown or unsafe gate ids", async () => {
    const root = await repository();
    const outcome = await recordReleaseEvaluation({ root, capabilityGate: "alpha-gate" });
    const commit = git(root, "rev-parse", "HEAD").trim();
    expect(outcome.path).toBe(join(recordDirectory(root), "alpha-gate", `${commit}.json`));
    expect(outcome.record).toMatchObject({
      gate: null,
      capabilityGate: "alpha-gate",
      ok: true,
      capabilityGateDecision: { id: "alpha-gate", status: "passed", reasons: [] },
    });
    await expect(recordReleaseEvaluation({ root, capabilityGate: "missing-gate" })).rejects.toThrow(
      "unknown capability gate",
    );
    await expect(recordReleaseEvaluation({ root, capabilityGate: "../escape" })).rejects.toThrow(
      "not a safe name",
    );
    await expect(access(join(recordDirectory(root), "missing-gate"))).rejects.toThrow();
    await expect(access(join(root, "validation/results/escape"))).rejects.toThrow();
  });
});
