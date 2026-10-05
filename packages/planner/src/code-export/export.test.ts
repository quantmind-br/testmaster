import { readFile } from "node:fs/promises";
import { parse } from "@babel/parser";
import { type ExecutablePlan, validate } from "@testmaster/contracts";
import { describe, expect, it } from "vitest";
import { exportCode, exportImportedCode } from "./index.js";

async function fixture(name: string): Promise<ExecutablePlan> {
  const bytes = await readFile(
    new URL(`../../../contracts/fixtures/valid/${name}.json`, import.meta.url),
    "utf8",
  );
  return validate<ExecutablePlan>("ExecutablePlan", JSON.parse(bytes).value);
}

describe("standalone deterministic code export", () => {
  it.each(["playwright", "pytest"] as const)(
    "pins complete %s projects without target/backend calls",
    async (format) => {
      const plan = await fixture("backend");
      const result = exportCode(plan, { format });
      expect(result).toEqual(exportCode(plan, { format }));
      expect(result.metadata.assertionIds).toEqual(["check-status", "check-health"]);
      expect(
        result.metadata.files.every((file) => file.sha256.length === 64 && file.sizeBytes > 0),
      ).toBe(true);
      const code = result.files[result.metadata.entrypoint] ?? "";
      const embedded =
        format === "playwright"
          ? JSON.parse(/const plan = ([\s\S]*?);\ntest\(/u.exec(code)?.[1] ?? "")
          : JSON.parse(JSON.parse(/json\.loads\(("(?:\\.|[^"\\])*")\)/u.exec(code)?.[1] ?? ""));
      expect(embedded).toEqual(plan);
      expect(Object.values(result.files).join("\n")).not.toMatch(
        /@testmaster\/|testmaster_runner|TestSprite/,
      );
      if (format === "playwright") {
        const lock = JSON.parse(result.files["package-lock.json"] ?? "");
        for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
          expect(lock.packages[`node_modules/${name}`].version).toBe("1.63.0");
          expect(lock.packages[`node_modules/${name}`].integrity).toMatch(/^sha512-/);
        }
        for (const [name, source] of Object.entries(result.files))
          if (name.endsWith(".ts"))
            expect(() =>
              parse(source, { sourceType: "module", plugins: ["typescript"] }),
            ).not.toThrow();
      } else {
        expect(result.files["uv.lock"]).toContain('name = "exported-tests"');
        expect(result.files["uv.lock"]).toContain('source = { virtual = "." }');
        expect(result.files["uv.lock"]).toContain('hash = "sha256:');
        expect(result.files["uv.lock"]).not.toContain("editable =");
        expect(result.files["standalone.py"]).not.toContain("async def");
        expect(result.files["standalone.py"]).toContain("requests.Session()");
      }
    },
  );
  it("exports sync and async browser projects with exact text assertions", async () => {
    const plan = await fixture("frontend");
    for (const async of [false, true]) {
      const result = exportCode(plan, { format: "pytest", async });
      expect(result.metadata.framework).toBe(async ? "playwright-async" : "playwright-sync");
      expect(result.files["test_plan.py"]).toContain(
        async ? "async_playwright" : "sync_playwright",
      );
      expect(result.files["test_plan.py"]).toContain("Password is required");
      expect(result.files["standalone.py"]).toContain("observed == expected");
      expect(result.files["standalone.py"]).toContain("assert remaining > 0");
    }
  });
  it("preserves nested frame operations and explicit runtime references", async () => {
    const plan = await fixture("frontend");
    const assertion = plan.steps[2];
    if (assertion?.operation !== "assert") throw new Error("Bad fixture");
    assertion.expectation = { predicate: "textEquals", value: { variableRef: "expected-message" } };
    plan.dependsOn = [
      {
        producerTestId: "tst_01900000-0000-7000-8000-000000000001",
        outputName: "message",
        consumerInput: "expected-message",
        type: "string",
        required: true,
        sensitive: false,
        maximumAge: 60000,
        permittedEnvironment: "env_01900000-0000-7000-8000-000000000001",
      },
    ];
    plan.steps = [
      plan.steps[0] as ExecutablePlan["steps"][number],
      {
        id: "frame",
        kind: "action",
        operation: "frame",
        description: "Scope child actions",
        input: { locator: { by: "css", value: "iframe" }, childSteps: [assertion] },
      },
    ];
    const result = exportCode(plan, { format: "playwright" });
    expect(result.metadata.requiredInputs.variables).toContain("expected-message");
    expect(result.metadata.assertionIds).toEqual(["check-error"]);
    expect(result.files["helpers/standalone.ts"]).toContain("scope = oldScope; page = oldPage");
  });
  it("refuses unavailable or target-baked predicates rather than dropping assertions", async () => {
    const plan = await fixture("frontend");
    const assertion = plan.steps[2];
    if (assertion?.operation !== "assert") throw new Error("Bad fixture");
    assertion.expectation = { predicate: "accessibilityViolations", maximum: 0 };
    expect(() => exportCode(plan, { format: "playwright" })).toThrowError(
      expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }),
    );
    assertion.input = {};
    assertion.expectation = {
      predicate: "urlEquals",
      value: { literal: "https://target.invalid/login" },
    };
    expect(() => exportCode(plan, { format: "pytest" })).toThrow(/configured variableRef/);
    const navigate = plan.steps[0];
    if (navigate?.operation !== "navigate") throw new Error("Bad fixture");
    navigate.input.path = "https://target.invalid/login";
    expect(() => exportCode(plan, { format: "playwright" })).toThrow(/absolute navigation/);
  });
  it("refuses a schema whose source revision is absent", async () => {
    const plan = await fixture("backend");
    const assertion = plan.steps[2];
    if (assertion?.operation !== "assert") throw new Error("Bad fixture");
    assertion.expectation = {
      predicate: "jsonSchema",
      sourceRevisionId: "svr_01900000-0000-7000-8000-000000000001",
      pointer: "/schema",
    };
    expect(() => exportCode(plan, { format: "playwright" })).toThrow(/source schema revision/);
  });
  it("preserves authored source bytes and admitted runtime pins", () => {
    const source =
      "import { test, expect } from '@playwright/test';\n// Authored spacing must survive.\ntest('health', async ({request}) => { expect((await request.get('/health', {timeout:1000})).status()).toBe(200); });\n";
    const exported = exportImportedCode({
      format: "playwright",
      entrypoint: "health.spec.ts",
      files: { "health.spec.ts": source },
      contentHash: "a".repeat(64),
      dependencyLock: { imageId: `sha256:${"b".repeat(64)}`, runtimeInstalls: false },
    });
    expect(exported.files["health.spec.ts"]).toBe(source);
    expect(exported.files["runtime-lock.json"]).toContain(`sha256:${"b".repeat(64)}`);
    expect(exported.metadata.entrypoint).toBe("health.spec.ts");
    expect(exported.files["package-lock.json"]).toContain('"lockfileVersion": 3');
  });
  it("retains every browser operation and oracle in generated projects", async () => {
    const plan = await fixture("frontend");
    const locator = { by: "testId", value: "control" } as const;
    const artifactRef = "art_01900000-0000-7000-8000-000000000001";
    const actions: ExecutablePlan["steps"] = [
      {
        id: "open",
        kind: "action",
        operation: "navigate",
        description: "Open",
        input: { path: "/controls" },
      },
      ...(["click", "hover", "check", "uncheck"] as const).map((operation) => ({
        id: operation,
        kind: "action" as const,
        operation,
        description: operation,
        input: { locator },
      })),
      {
        id: "fill",
        kind: "action",
        operation: "fill",
        description: "Fill",
        input: { locator, value: { literal: "Exact input" } },
      },
      {
        id: "press",
        kind: "action",
        operation: "press",
        description: "Press",
        input: { locator, key: "Enter" },
      },
      {
        id: "select",
        kind: "action",
        operation: "select",
        description: "Select",
        input: { locator, values: [{ label: { literal: "Choice" } }] },
      },
      {
        id: "drag",
        kind: "action",
        operation: "drag",
        description: "Drag",
        input: { source: locator, destination: { by: "css", value: "#destination" } },
      },
      {
        id: "upload",
        kind: "action",
        operation: "upload",
        description: "Upload",
        input: { locator, artifactRefs: [artifactRef] },
      },
      {
        id: "download",
        kind: "action",
        operation: "download",
        description: "Download",
        input: { trigger: { operation: "click", input: { locator } }, outputName: "file" },
      },
      {
        id: "switch",
        kind: "action",
        operation: "switchPage",
        description: "Switch",
        input: { pageAlias: "popup" },
      },
      {
        id: "wait",
        kind: "action",
        operation: "waitFor",
        description: "Wait",
        input: { locator, state: "visible", deadlineMs: 1000 },
      },
      {
        id: "frame",
        kind: "action",
        operation: "frame",
        description: "Frame",
        input: {
          locator: { by: "css", value: "iframe" },
          childSteps: [
            {
              id: "nested",
              kind: "assertion",
              operation: "assert",
              description: "Nested oracle",
              input: { locator },
              expectation: { predicate: "visible" },
            },
          ],
        },
      },
      {
        id: "check-file",
        kind: "assertion",
        operation: "assert",
        description: "Exact file metadata",
        input: { outputName: "file" },
        expectation: {
          predicate: "downloadMatches",
          outputName: "file",
          sizeBytes: 12,
          mimeType: "text/plain",
        },
      },
      {
        id: "exact-text",
        kind: "assertion",
        operation: "assert",
        description: "Whitespace is significant",
        input: { locator },
        expectation: { predicate: "textEquals", value: { literal: "  Exact\\ntext  " } },
      },
    ];
    plan.steps = actions;
    for (const format of ["playwright", "pytest"] as const) {
      const exported = exportCode(plan, { format });
      expect(exported.metadata.requiredInputs.artifacts).toEqual([artifactRef]);
      expect(exported.metadata.requiredInputs.popupAliases).toEqual(["popup"]);
      expect(exported.metadata.assertionIds).toEqual(["nested", "check-file", "exact-text"]);
      const code = exported.files[exported.metadata.entrypoint] ?? "";
      for (const action of actions) expect(code).toContain(action.id);
    }
  });
});
