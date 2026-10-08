import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkRegistry, type Registry, type RegistryItem } from "./check.js";
import {
  checkReleaseDecision,
  checkReleaseItem,
  type ReleaseDecision,
  releaseSummary,
} from "./release.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tm-release-"));
  roots.push(root);
  const assertion = 'expect(mutant.outcome).toBe("failed")';
  await writeFile(
    join(root, "acceptance.test.ts"),
    `it("healthy", () => {}); it("mutant", () => { ${assertion}; });`,
  );
  const item: RegistryItem = {
    id: "VAL-019",
    title: "critical mutation controls",
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
  return { root, item };
}
function decision(): ReleaseDecision {
  return {
    findings: [],
    areas: [
      {
        area: "security",
        proposedTarget: "zero critical",
        approvedTarget: "zero critical",
        observation: 0,
        interval: [0, 0],
        n: 12,
        decision: "passed",
        reason: "real controls pass",
      },
    ],
  };
}
it("blocks uncovered release items and accepts only explicitly explained unverified scope", async () => {
  const { root, item } = await fixture();
  const definitions = [
    {
      id: item.id,
      title: item.title,
      sourceFile: "SPEC.md",
      sourceLine: 1,
      declaredMilestones: ["M0"],
    },
  ];
  const registry: Registry = { items: [item], release: decision() };
  expect((await checkRegistry(root, definitions, registry, "M0")).ok).toBe(true);
  delete item.coverage;
  expect((await checkRegistry(root, definitions, registry, "M0")).errors.join()).toContain(
    "positive and negative",
  );
  item.status = "implemented";
  item.blockedReason = "Independent reviewer unavailable; review required before release";
  const blocked = await checkRegistry(root, definitions, registry, "M0");
  expect(blocked.errors).toEqual([
    "VAL-019: unverified release scope blocked (Independent reviewer unavailable; review required before release)",
  ]);
});
it("detects removed negative controls and removed critical assertions rather than green fewer tests", async () => {
  const { root, item } = await fixture();
  item.scenario = ["acceptance.test.ts::healthy"];
  const missingNegative: string[] = [];
  await checkReleaseItem(root, item, missingNegative, Date.now());
  expect(missingNegative.join()).toContain("positive and negative");
  item.scenario.push("acceptance.test.ts::mutant");
  await writeFile(
    join(root, "acceptance.test.ts"),
    'it("healthy", () => {}); expect(mutant.outcome).toBe("failed");',
  );
  const deletedTest: string[] = [];
  await checkReleaseItem(root, item, deletedTest, Date.now());
  expect(deletedTest.join()).toContain("scenario implementation missing");
  await writeFile(join(root, "acceptance.test.ts"), "// assertion deleted\n");
  const missingAssertion: string[] = [];
  await checkReleaseItem(root, item, missingAssertion, Date.now());
  expect(missingAssertion.join()).toContain("protected critical assertion missing");
});
it("rejects critical, expired, ownerless and capability-silent waivers", async () => {
  const { root, item } = await fixture();
  item.status = "waived";
  item.waiver = {
    severity: "low",
    owner: "release-owner",
    expiresAt: "2099-01-01T00:00:00Z",
    requirement: item.id,
    reason: "Limited profile coverage",
    capabilityEffect: "Unverified profile remains unsupported",
  };
  const valid: string[] = [];
  await checkReleaseItem(root, item, valid, Date.now());
  expect(valid).toEqual([]);
  for (const change of [
    { severity: "critical" },
    { owner: "" },
    { expiresAt: "2000-01-01T00:00:00Z" },
    { requirement: "OTHER" },
    { capabilityEffect: "" },
    { reason: "secret escape" },
  ]) {
    const errors: string[] = [];
    await checkReleaseItem(
      root,
      { ...item, waiver: { ...item.waiver, ...change } } as RegistryItem,
      errors,
      Date.now(),
    );
    expect(errors.join()).toContain("invalid waiver");
    const criticalInvariant: string[] = [];
    await checkReleaseItem(
      root,
      {
        ...item,
        id: "INV-001",
        title: "Conteúdo imutável",
        waiver: { ...item.waiver, requirement: "INV-001" },
      },
      criticalInvariant,
      Date.now(),
    );
    expect(criticalInvariant.join()).toContain("invalid waiver");
  }
});
it("keeps every public advanced capability in summary with scenario oracle and gate", async () => {
  const { item } = await fixture();
  item.status = "blocked";
  item.blockedReason = "M5 surface unavailable";
  const registry: Registry = {
    items: [item],
    capabilities: [{ id: "visualMatches", milestone: "M5", requirements: [item.id], gate: "M5" }],
  };
  const errors: string[] = [];
  const summary = releaseSummary(registry, ["visualMatches", "healing"], errors);
  expect(summary[0]).toMatchObject({
    status: "blocked",
    scenarios: ["acceptance.test.ts::healthy", "acceptance.test.ts::mutant"],
    oracles: ["independent state"],
    gate: "M5",
  });
  expect(errors.join()).toContain("Capability healing: missing");
});
it("critical security defects block release despite every numeric score passing", () => {
  const release = decision();
  const security = release.areas[0];
  if (!security) throw new Error("Missing area fixture");
  release.areas.push({ ...security, area: "performance", observation: 100 });
  release.findings.push({
    id: "secret-leak-1",
    severity: "critical",
    status: "open",
    requirement: "SEC-020",
  });
  const errors: string[] = [];
  checkReleaseDecision(release, errors);
  expect(errors.join()).toContain("critical finding secret-leak-1");
  const finding = release.findings[0];
  if (!finding) throw new Error("Missing finding fixture");
  finding.status = "resolved";
  const closed: string[] = [];
  checkReleaseDecision(release, closed);
  expect(closed).toEqual([]);
  security.observation = null;
  const unmeasured: string[] = [];
  checkReleaseDecision(release, unmeasured);
  expect(unmeasured.join()).toContain("unmeasured");
});

it("passes a measured capability independently of blocked milestone areas", async () => {
  const { root, item } = await fixture();
  const definitions = [
    {
      id: item.id,
      title: item.title,
      sourceFile: "SPEC.md",
      sourceLine: 1,
      declaredMilestones: ["M0"],
    },
  ];
  const release = decision();
  const area = release.areas[0];
  if (!area) throw new Error("Missing area fixture");
  release.areas.push({
    ...area,
    area: "fork-isolation",
    decision: "blocked",
    reason: "Second GitHub identity unavailable",
  });
  release.capabilityGates = [
    {
      id: "assistive",
      requiredAreas: ["security"],
      requiredItems: [item.id],
      nonNegotiable: [item.id],
    },
  ];
  const registry: Registry = { items: [item], release };
  const scoped = await checkRegistry(
    root,
    definitions,
    registry,
    undefined,
    [],
    Date.now(),
    "assistive",
  );
  expect(scoped.ok).toBe(true);
  expect(scoped.capabilityGate).toEqual({ id: "assistive", status: "passed", reasons: [] });
  const milestone = await checkRegistry(root, definitions, registry, "M3");
  expect(milestone.ok).toBe(false);
  expect(milestone.errors.join()).toContain("Second GitHub identity unavailable");
});

it("blocks a capability with the genuine missing evidence reason without unrelated milestone failures", async () => {
  const { root, item } = await fixture();
  const definitions = [
    {
      id: item.id,
      title: item.title,
      sourceFile: "SPEC.md",
      sourceLine: 1,
      declaredMilestones: ["M0"],
    },
  ];
  const release = decision();
  const area = release.areas[0];
  if (!area) throw new Error("Missing area fixture");
  area.decision = "blocked";
  area.approvedTarget = null;
  area.observation = null;
  area.interval = null;
  area.n = 0;
  area.reason = "Independent holdout with reviewed action labels has not been authored";
  release.areas.push({
    ...area,
    area: "fork-isolation",
    reason: "Second GitHub identity unavailable",
  });
  release.capabilityGates = [
    {
      id: "assistive",
      requiredAreas: ["security"],
      requiredItems: [item.id],
      nonNegotiable: [item.id],
    },
  ];
  const scoped = await checkRegistry(
    root,
    definitions,
    { items: [item], release },
    undefined,
    [],
    Date.now(),
    "assistive",
  );
  expect(scoped.ok).toBe(false);
  expect(scoped.capabilityGate?.status).toBe("blocked");
  expect(scoped.errors).toEqual([
    "Release area security: blocked (Independent holdout with reviewed action labels has not been authored)",
  ]);
});

it("does not accept waived invariants or removed critical controls for a capability", async () => {
  const { root, item } = await fixture();
  const definitions = [
    {
      id: item.id,
      title: item.title,
      sourceFile: "SPEC.md",
      sourceLine: 1,
      declaredMilestones: ["M0"],
    },
  ];
  const release = decision();
  release.capabilityGates = [
    {
      id: "healing",
      requiredAreas: ["security"],
      requiredItems: [item.id],
      nonNegotiable: [item.id],
    },
  ];
  const registry: Registry = { items: [item], release };
  await writeFile(
    join(root, "acceptance.test.ts"),
    'it("healthy", () => {}); it("mutant", () => {});',
  );
  const removed = await checkRegistry(
    root,
    definitions,
    registry,
    undefined,
    [],
    Date.now(),
    "healing",
  );
  expect(removed.errors.join()).toContain("protected critical assertion missing");
  item.status = "implemented";
  item.blockedReason = "Independent safety review unavailable";
  const unverified = await checkRegistry(
    root,
    definitions,
    registry,
    undefined,
    [],
    Date.now(),
    "healing",
  );
  expect(unverified.capabilityGate?.reasons).toContain(
    "VAL-019: capability evidence not verified (Independent safety review unavailable)",
  );
  item.status = "waived";
  delete item.blockedReason;
  item.waiver = {
    severity: "low",
    owner: "release-owner",
    expiresAt: "2099-01-01T00:00:00Z",
    requirement: item.id,
    reason: "Limited profile coverage",
    capabilityEffect: "Unverified profile remains unsupported",
  };
  const waived = await checkRegistry(
    root,
    definitions,
    registry,
    undefined,
    [],
    Date.now(),
    "healing",
  );
  expect(waived.capabilityGate?.reasons).toContain(
    "VAL-019: capability evidence not verified (waived)",
  );
});

it("rejects unknown gates and missing referenced areas rather than silently passing", async () => {
  const { root, item } = await fixture();
  const definitions = [
    {
      id: item.id,
      title: item.title,
      sourceFile: "SPEC.md",
      sourceLine: 1,
      declaredMilestones: ["M0"],
    },
  ];
  const registry: Registry = { items: [item], release: decision() };
  const unknown = await checkRegistry(
    root,
    definitions,
    registry,
    undefined,
    [],
    Date.now(),
    "missing",
  );
  expect(unknown.capabilityGate).toEqual({
    id: "missing",
    status: "blocked",
    reasons: ["Capability gate missing: unknown gate"],
  });
  if (!registry.release) throw new Error("Missing release fixture");
  registry.release.capabilityGates = [
    {
      id: "healing",
      requiredAreas: ["missing-area"],
      requiredItems: [item.id],
      nonNegotiable: [item.id],
    },
  ];
  const malformed = await checkRegistry(
    root,
    definitions,
    registry,
    undefined,
    [],
    Date.now(),
    "healing",
  );
  expect(malformed.ok).toBe(false);
  expect(malformed.errors.join()).toContain("requiredAreas requires unique existing references");
});

it("blocks a required critical finding despite passed numeric capability targets", async () => {
  const { root, item } = await fixture();
  const definitions = [
    {
      id: item.id,
      title: item.title,
      sourceFile: "SPEC.md",
      sourceLine: 1,
      declaredMilestones: ["M0"],
    },
  ];
  const release = decision();
  release.capabilityGates = [
    {
      id: "healing",
      requiredAreas: ["security"],
      requiredItems: [item.id],
      nonNegotiable: [item.id],
    },
  ];
  release.findings.push({
    id: "unsafe-autoapply",
    severity: "critical",
    status: "open",
    requirement: item.id,
  });
  const result = await checkRegistry(
    root,
    definitions,
    { items: [item], release },
    undefined,
    [],
    Date.now(),
    "healing",
  );
  expect(result.ok).toBe(false);
  expect(result.errors).toContain("Release blocked by critical finding unsafe-autoapply (VAL-019)");
});
