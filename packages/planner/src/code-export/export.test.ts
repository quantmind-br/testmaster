import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "@babel/parser";
import {
  type ExecutablePlan,
  type Expectation,
  type PlanStep,
  validate,
  validateAgainstSchema,
} from "@testmaster/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("refuses terminal plans explicitly in every format instead of taking the Playwright path", async () => {
    const plan = await fixture("cli");
    expect(plan.runner).toBe("terminal");
    for (const options of [
      { format: "playwright" },
      { format: "pytest" },
      { format: "pytest", async: true },
    ] as const)
      expect(() => exportCode(plan, options), JSON.stringify(options)).toThrow(
        expect.objectContaining({
          code: "CAPABILITY_UNAVAILABLE",
          message:
            "Code export is not available for terminal tests; replay them with the terminal runner",
        }),
      );
    // Positive control: the refusal is specific to the terminal runner.
    const backend = await fixture("backend");
    expect(() => exportCode(backend, { format: "pytest" })).not.toThrow();
  });
  it("exports manual redirects, cookie and header predicates and invalid credentials in both formats", async () => {
    const plan = await fixture("backend");
    const request = plan.steps[0];
    if (request?.operation !== "request") throw new Error("Bad fixture");
    request.input.redirect = "manual";
    request.input.headers = { Authorization: { invalidCredential: { scheme: "Bearer" } } };
    const assertion = (id: string, expectation: Expectation): PlanStep => ({
      id,
      kind: "assertion",
      operation: "assert",
      description: id,
      input: { responseStepId: "get-health" },
      expectation,
    });
    plan.steps = [
      request,
      assertion("moved", { predicate: "statusIn", values: [307] }),
      assertion("login", { predicate: "headerMatches", header: "Location", pattern: "^/login" }),
      assertion("no-cookie", { predicate: "cookieAbsent", name: "sid" }),
    ];
    const playwright = exportCode(plan, { format: "playwright" });
    const helpers = playwright.files["helpers/standalone.ts"] ?? "";
    expect(() => parse(helpers, { sourceType: "module", plugins: ["typescript"] })).not.toThrow();
    for (const fragment of [
      "input.redirect !== 'manual'",
      "case 'headerMatches'",
      "case 'cookieAbsent'",
      "testmaster-invalid-",
    ])
      expect(helpers).toContain(fragment);
    const python = exportCode(plan, { format: "pytest" }).files["standalone.py"] ?? "";
    for (const fragment of [
      'input.get("redirect") != "manual"',
      'predicate == "headerMatches"',
      'predicate == "cookieAbsent"',
      "testmaster-invalid-",
    ])
      expect(python).toContain(fragment);
    // Python regular expressions do not share every ECMAScript construct: refuse, do not translate.
    plan.steps[2] = assertion("login", {
      predicate: "headerMatches",
      header: "Location",
      pattern: "(?<scheme>[a-z]+)://",
    });
    expect(() => exportCode(plan, { format: "pytest" })).toThrow(/ECMAScript construct/);
    expect(() => exportCode(plan, { format: "playwright" })).not.toThrow();
  });
  it("exports a disabled assertion with the Playwright disabled semantics in both formats", async () => {
    const plan = await fixture("frontend");
    plan.steps = [
      {
        id: "sign-in-disabled",
        kind: "assertion",
        operation: "assert",
        description: "Sign in is disabled while the password is empty",
        input: { locator: { by: "role", role: "button", name: "Sign in", exact: true } },
        expectation: { predicate: "disabled" },
      },
    ];
    const playwright = exportCode(plan, { format: "playwright" });
    expect(playwright.metadata.assertionIds).toEqual(["sign-in-disabled"]);
    expect(playwright.files["helpers/standalone.ts"] ?? "").toContain("toBeDisabled");
    const python = exportCode(plan, { format: "pytest" }).files["standalone.py"] ?? "";
    expect(python).toContain("is_disabled");
  });
  it("refuses auth profile sessions and JSON body set entries that exported code cannot reproduce", async () => {
    const plan = await fixture("backend");
    const request = plan.steps[0];
    if (request?.operation !== "request") throw new Error("Bad fixture");
    request.input.auth = "profile";
    for (const format of ["playwright", "pytest"] as const)
      expect(() => exportCode(plan, { format })).toThrow(
        expect.objectContaining({
          code: "CAPABILITY_UNAVAILABLE",
          message: expect.stringContaining("auth profile sessions are not available"),
        }),
      );
    delete request.input.auth;
    request.input.method = "POST";
    request.input.body = {
      kind: "json",
      value: { literal: { password: null } },
      set: [
        { pointer: "/password", value: { secretRef: "sec_01900000-0000-7000-8000-000000000001" } },
      ],
    };
    for (const format of ["playwright", "pytest"] as const)
      expect(() => exportCode(plan, { format })).toThrow(/JSON body set entries/u);
  });
});

describe("imported Playwright export runner fixtures", () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });
  const spec = "import { test } from '@playwright/test';\ntest('x', async ({ secrets }) => {});\n";
  const SCHEMA_REVISION = "svr_00000000-0000-4000-8000-000000000001";
  const SCHEMA_POINTER = "/paths/~1items/get/responses/200/content/application~1json/schema";
  /** An OpenAPI-flavoured schema: annotations, a vendor extension and a numeric format. */
  const SCHEMA = {
    type: "object",
    required: ["id", "name"],
    additionalProperties: false,
    properties: {
      id: { type: "integer", format: "int64", example: 3 },
      name: { type: "string", "x-internal": true },
      tags: { type: "array", items: { type: ["string", "null"] } },
    },
    "x-vendor": { anything: true },
  };
  const exported = (
    extra: { secrets?: string[]; profile?: boolean; schemas?: Record<string, unknown> } = {},
  ) =>
    exportImportedCode({
      format: "playwright",
      entrypoint: "generated.spec.ts",
      files: { "generated.spec.ts": spec },
      contentHash: "a".repeat(64),
      dependencyLock: { runtimeInstalls: false },
      ...extra,
    });
  /** Lays the project out as `npm ci` would, with a recording stand-in for the stock package. */
  function installed(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "tm-export-"));
    directories.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const stock = join(root, "node_modules", "playwright-test-stock");
    mkdirSync(stock, { recursive: true });
    writeFileSync(
      join(stock, "package.json"),
      JSON.stringify({ name: "stock", exports: { import: "./index.mjs", require: "./index.js" } }),
    );
    writeFileSync(
      join(stock, "index.js"),
      "module.exports = { defineConfig: (config) => config, extend(fixtures) { const test = () => {}; test.fixtures = fixtures; return test; } };\n",
    );
    writeFileSync(join(stock, "index.mjs"), "export const defineConfig = (config) => config;\n");
    const link = JSON.parse(files["package.json"] ?? "").devDependencies["@playwright/test"];
    expect(link).toMatch(/^file:/u);
    mkdirSync(join(root, "node_modules", "@playwright"), { recursive: true });
    symlinkSync(
      join(root, link.slice("file:".length)),
      join(root, "node_modules", "@playwright", "test"),
    );
    return root;
  }
  type Fixture = (deps: object, use: (value: unknown) => Promise<void>) => Promise<void>;
  /** The value a fixture of the extended `test` hands to a test (setup runs, teardown after `use`). */
  async function provided<T>(root: string, name: string, deps: object): Promise<T> {
    const test = createRequire(join(root, "generated.spec.ts"))("@playwright/test");
    const fixture: Fixture = test.fixtures[name];
    const { promise, resolve } = Promise.withResolvers<T>();
    const done = fixture(deps, async (value) => {
      resolve(value as T);
    });
    return Promise.race([promise, done.then(() => Promise.reject(new Error("no value provided")))]);
  }
  interface Requester {
    get(target: string, options?: Record<string, unknown>): Promise<unknown>;
  }

  it("resolves the authored @playwright/test import to the stock package extended with the fixtures", () => {
    const root = installed(exported().files);
    const probe = "console.log(JSON.stringify([Object.keys(test.fixtures), typeof defineConfig]))";
    const commonjs = execFileSync(
      process.execPath,
      ["-e", `const test = require('@playwright/test'); const { defineConfig } = test; ${probe}`],
      { cwd: root, encoding: "utf8" },
    );
    const module = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { test, defineConfig } from '@playwright/test'; ${probe}`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    for (const output of [commonjs, module])
      expect(JSON.parse(output)).toEqual([
        ["secrets", "profileRequest", "profilePage", "sourceSchemas"],
        "function",
      ]);
  });
  it("pins every dependency of the project and of the fixtures package in the lock", () => {
    const { files } = exported();
    const lock = JSON.parse(files["package-lock.json"] ?? "");
    const manifest = JSON.parse(files["package.json"] ?? "");
    expect(lock.packages[""].devDependencies).toEqual(manifest.devDependencies);
    const harness = JSON.parse(files["testmaster-fixtures/package.json"] ?? "");
    for (const [name, wanted] of Object.entries({
      ...manifest.devDependencies,
      ...harness.dependencies,
    }) as [string, string][]) {
      const entry = lock.packages[`node_modules/${name}`];
      if (wanted.startsWith("file:")) {
        expect(entry).toEqual({ resolved: wanted.slice("file:".length), link: true });
        expect(lock.packages[entry.resolved]).toMatchObject({
          name: harness.name,
          dependencies: harness.dependencies,
        });
      } else if (wanted.startsWith("npm:")) {
        expect(wanted).toBe(`npm:${entry.name}@${entry.version}`);
        expect(entry.integrity).toMatch(/^sha512-/u);
      } else expect(entry.version).toBe(wanted);
    }
  });
  it("ships a source schema and pins its validator only for code that checks one", () => {
    const key = `${SCHEMA_REVISION}${SCHEMA_POINTER}`;
    const plain = exported();
    expect(plain.files["testmaster-fixtures/schemas.json"]).toBeUndefined();
    expect(plain.files["package-lock.json"]).not.toContain('"node_modules/ajv"');
    const withSchema = exported({ schemas: { [key]: SCHEMA } });
    expect(JSON.parse(withSchema.files["testmaster-fixtures/schemas.json"] ?? "")).toEqual({
      [key]: SCHEMA,
    });
    const harness = JSON.parse(withSchema.files["testmaster-fixtures/package.json"] ?? "");
    const lock = JSON.parse(withSchema.files["package-lock.json"] ?? "");
    // The pinned validator is the one the contracts package ships: the plan's predicate and the
    // exported check must judge a body with the same Ajv.
    const contracts = JSON.parse(
      readFileSync(new URL("../../../contracts/package.json", import.meta.url), "utf8"),
    );
    for (const name of ["ajv", "ajv-formats"]) {
      expect(harness.dependencies[name]).toBe(contracts.dependencies[name]);
      expect(lock.packages[`node_modules/${name}`].version).toBe(contracts.dependencies[name]);
      expect(lock.packages[`node_modules/${name}`].integrity).toMatch(/^sha512-/u);
    }
    expect(lock.packages["testmaster-fixtures"].dependencies).toEqual(harness.dependencies);
    for (const name of Object.keys(lock.packages["node_modules/ajv"].dependencies))
      expect(lock.packages[`node_modules/${name}`].integrity).toMatch(/^sha512-/u);
    expect(withSchema.files["SETUP.txt"]).toContain("sourceSchemas.violations");
  });
  it("checks a body against the frozen schema in the exported project exactly as the plan's jsonSchema predicate does", async () => {
    const key = `${SCHEMA_REVISION}${SCHEMA_POINTER}`;
    const root = installed(exported({ schemas: { [key]: SCHEMA } }).files);
    // `npm ci` would install the pinned validator; the workspace copy stands in for it.
    const contractsRequire = createRequire(
      new URL("../../../contracts/package.json", import.meta.url),
    );
    for (const name of ["ajv", "ajv-formats"]) {
      const entry = contractsRequire.resolve(name);
      const marker = `node_modules/${name}/`;
      symlinkSync(
        entry.slice(0, entry.lastIndexOf(marker) + marker.length - 1),
        join(root, "node_modules", name),
      );
    }
    const { violations } = await provided<{
      violations(revision: string, pointer: string, value: unknown): string[];
    }>(root, "sourceSchemas", {});
    const planAccepts = (body: unknown) => {
      try {
        validateAgainstSchema(SCHEMA, body);
        return true;
      } catch {
        return false;
      }
    };
    const bodies = [
      { id: 7, name: "a" },
      { id: "7", name: "a" },
      { id: 7 },
      { id: 7, name: "a", extra: 1 },
      { id: 7, name: "a", tags: ["x", null] },
      { id: 7, name: "a", tags: [3] },
    ];
    expect(bodies.filter(planAccepts)).toHaveLength(2);
    for (const body of bodies)
      expect(violations(SCHEMA_REVISION, SCHEMA_POINTER, body).length === 0).toBe(
        planAccepts(body),
      );
    expect(violations(SCHEMA_REVISION, SCHEMA_POINTER, { id: "7", name: "a" })).toEqual([
      "/id type: must be integer",
    ]);
    expect(() => violations(SCHEMA_REVISION, "/paths/other", {})).toThrow(
      /is not part of this test/u,
    );
  });
  it("reads secrets.get(name) from the SECRET_<name> environment variable", async () => {
    const root = installed(exported({ secrets: ["API_KEY"] }).files);
    const secrets = await provided<{ get(name: unknown): string }>(root, "secrets", {});
    vi.stubEnv("SECRET_API_KEY", "fake-secret-value");
    expect(secrets.get("API_KEY")).toBe("fake-secret-value");
    expect(() => secrets.get("MISSING")).toThrow(/SECRET_MISSING/u);
    expect(() => secrets.get(7)).toThrow(/must be a string/u);
  });
  it("gives profileRequest the storage state of the BASE_URL origin and its header credentials only", async () => {
    const state = {
      cookies: [
        { name: "sid", value: "one", domain: "app.test", path: "/" },
        { name: "sub", value: "two", domain: ".app.test", path: "/" },
        { name: "foreign", value: "three", domain: "other.test", path: "/" },
      ],
      origins: [
        { origin: "http://app.test", localStorage: [] },
        { origin: "http://other.test", localStorage: [] },
      ],
    };
    const root = installed(exported({ profile: true }).files);
    const stateFile = join(root, "state.json");
    writeFileSync(stateFile, JSON.stringify(state));
    vi.stubEnv("TESTMASTER_PROFILE_STORAGE_STATE", stateFile);
    vi.stubEnv("TESTMASTER_PROFILE_HEADERS", JSON.stringify({ "X-Api-Key": "fake-header" }));
    const contexts: unknown[] = [];
    const sent: { target: string; options: Record<string, unknown> }[] = [];
    const playwright = {
      request: {
        newContext: async (options: unknown) => {
          contexts.push(options);
          return {
            get: async (target: string, options: Record<string, unknown>) => {
              sent.push({ target, options });
              return { status: () => 200 };
            },
            dispose: async () => {},
          };
        },
      },
    };
    const request = await provided<Requester>(root, "profileRequest", {
      playwright,
      baseURL: "http://app.test",
    });
    expect(contexts).toEqual([
      {
        storageState: {
          cookies: [state.cookies[0], state.cookies[1]],
          origins: [state.origins[0]],
        },
      },
    ]);
    await request.get("/me");
    expect(sent).toEqual([
      { target: "/me", options: { headers: { "x-api-key": "fake-header" }, maxRedirects: 0 } },
    ]);
    await expect(request.get("http://other.test/me")).rejects.toThrow(/only sent to/u);
    await expect(request.get("/me", { headers: { "X-API-KEY": "x" } })).rejects.toThrow(
      /conflicts with the auth profile credential/u,
    );
    expect(sent).toHaveLength(1);
  });
  it("fails a profile fixture without a session, and profilePage without a browser session", async () => {
    const root = installed(exported({ profile: true }).files);
    const deps = { baseURL: "http://app.test" };
    await expect(provided(root, "profileRequest", deps)).rejects.toThrow(
      /TESTMASTER_PROFILE_STORAGE_STATE/u,
    );
    vi.stubEnv("TESTMASTER_PROFILE_HEADERS", JSON.stringify({ authorization: "Bearer fake" }));
    await expect(provided(root, "profilePage", deps)).rejects.toThrow(
      /only has header credentials/u,
    );
  });
  it("states the environment the fixtures read and refuses source that shadows the fixtures package", () => {
    const result = exported({ secrets: ["API_KEY"], profile: true });
    expect(result.metadata.environment).toEqual([
      "SECRET_API_KEY",
      "TESTMASTER_PROFILE_STORAGE_STATE",
      "TESTMASTER_PROFILE_HEADERS",
    ]);
    for (const name of result.metadata.environment ?? [])
      expect(result.files["SETUP.txt"]).toContain(name);
    expect(exported().metadata.environment).toBeUndefined();
    expect(() =>
      exportImportedCode({
        format: "playwright",
        entrypoint: "generated.spec.ts",
        files: { "generated.spec.ts": spec, "testmaster-fixtures/index.js": "" },
        contentHash: "a".repeat(64),
        dependencyLock: {},
      }),
    ).toThrow(/conflicts with export project metadata/u);
  });
});
