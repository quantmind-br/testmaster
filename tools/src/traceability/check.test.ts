import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkRegistry, checkRepository, type RegistryItem } from "./check.js";
import { type Definition, extractDocument } from "./extract.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tm-trace-"));
  roots.push(root);
  return root;
}
const definition: Definition = {
  id: "SEC-001",
  title: "Threat model",
  sourceFile: "SPEC.md",
  sourceLine: 1,
  declaredMilestones: ["M0"],
};
function item(overrides: Partial<RegistryItem> = {}): RegistryItem {
  return {
    id: "SEC-001",
    title: "Threat model",
    sourceFile: "SPEC.md",
    milestone: "M0",
    ownerRole: "Security",
    status: "planned",
    scenario: [],
    oracle: [],
    evidence: [],
    code: [],
    ...overrides,
  };
}

describe("normative extraction", () => {
  it("distinguishes definitions, inline acceptance IDs, journeys and roadmap tasks from references", () => {
    const text = [
      "| SEC-001 | Threat model | M0 |",
      "SEC-002: deny. CLI-001: safe output.",
      "### J01 — Local journey",
      "- [ ] **M0-01 — Contracts** (`Core`).",
      "See SEC-099 and SEC-002–008.",
      "```text",
      "SEC-099: example only",
      "```",
    ].join("\n");
    expect(extractDocument("SPEC.md", text).map((entry) => entry.id)).toEqual([
      "SEC-001",
      "SEC-002",
      "CLI-001",
      "J01",
      "M0-01",
    ]);
    expect(extractDocument("ROADMAP.md", "| REQ-001 | M1 | M1-01 |")).toEqual([]);
  });
  it("uses the same extraction when checking a temporary repository", async () => {
    const root = await temp();
    await mkdir(join(root, "specs"));
    await mkdir(join(root, "traceability"));
    await writeFile(join(root, "SPEC.md"), "| SEC-001 | Threat model |\n");
    await writeFile(join(root, "ROADMAP.md"), "References: SEC-001\n");
    await writeFile(join(root, "specs/01-test.md"), "CLI-001: output. CLI-002: no writes.\n");
    await writeFile(join(root, "traceability/registry.json"), JSON.stringify({ items: [item()] }));
    const result = await checkRepository(root);
    expect(result.definitionCount).toBe(3);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Missing registry ID CLI-001"),
        expect.stringContaining("Missing registry ID CLI-002"),
      ]),
    );
  });
});

describe("traceability release denials", () => {
  it("permits a complete planned inventory but blocks planned obligations at or before the gate", async () => {
    const root = await temp();
    expect((await checkRegistry(root, [definition], { items: [item()] })).ok).toBe(true);
    expect((await checkRegistry(root, [definition], { items: [item()] }, "M0")).ok).toBe(false);
    expect(
      (
        await checkRegistry(root, [definition], { items: [item({ milestone: "M2" })] }, "M1")
      ).errors.some((error) => error.includes("SEC-001")),
    ).toBe(false);
  });
  it("rejects missing, unknown and duplicate IDs", async () => {
    const root = await temp();
    const result = await checkRegistry(root, [definition], {
      items: [item({ id: "SEC-999" }), item({ id: "SEC-999" })],
    });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Missing registry ID SEC-001"),
        "Unknown registry ID SEC-999",
        "Duplicate registry ID SEC-999",
      ]),
    );
  });
  it("requires actual evidence and trace links for verified items", async () => {
    const root = await temp();
    const verified = item({
      status: "verified",
      scenario: ["positive and negative"],
      oracle: ["independent oracle"],
      code: ["implementation.ts"],
      evidence: ["result.json"],
    });
    expect((await checkRegistry(root, [definition], { items: [verified] })).ok).toBe(false);
    await writeFile(join(root, "result.json"), "{}\n");
    expect((await checkRegistry(root, [definition], { items: [verified] })).ok).toBe(true);
    expect(
      (await checkRegistry(root, [definition], { items: [item({ status: "verified" })] })).ok,
    ).toBe(false);
  });
  it("rejects outside paths, symlink escape and directories as evidence", async () => {
    const root = await temp();
    const outside = await temp();
    await writeFile(join(outside, "secret"), "private");
    await symlink(join(outside, "secret"), join(root, "escape"));
    await mkdir(join(root, "folder"));
    const result = await checkRegistry(root, [definition], {
      items: [
        item({
          status: "verified",
          scenario: ["scenario"],
          oracle: ["oracle"],
          code: ["code"],
          evidence: ["escape", "folder", join(outside, "secret"), "../missing"],
        }),
      ],
    });
    expect(result.errors.filter((error) => error.includes("evidence path"))).toHaveLength(4);
  });
});
