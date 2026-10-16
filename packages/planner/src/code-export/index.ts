import {
  ContractError,
  type ExecutablePlan,
  type PlanStep,
  validate,
  validatePlanSemantics,
} from "@testmaster/contracts";
import { semanticHash, sha256 } from "@testmaster/domain";
import {
  FIXTURES_DIRECTORY,
  fixturesCommonjs,
  fixturesModule,
  fixturesPackageJson,
  fixturesPackageJsonWithSchemas,
  PLAYWRIGHT_VERSION,
  PROFILE_HEADERS_ENV,
  PROFILE_STORAGE_STATE_ENV,
  SCHEMA_VALIDATOR_DEPENDENCIES,
  SCHEMAS_FILE,
  SECRET_ENV_PREFIX,
  STOCK_PACKAGE,
  schemaValidatorLockPackages,
} from "./playwright-fixtures.js";
import { pythonRuntime } from "./python.js";
import { pythonLock } from "./python-lock.js";
import { typescriptRuntime } from "./typescript.js";

export interface CodeExportOptions {
  format: "playwright" | "pytest";
  async?: boolean;
}
export interface CodeExportMetadata {
  version: "1.0.0";
  format: CodeExportOptions["format"];
  framework: "playwright-test" | "playwright-sync" | "playwright-async" | "requests" | "pytest";
  entrypoint: string;
  planHash: string;
  assertionIds: string[];
  requiredInputs: {
    secrets: string[];
    variables: string[];
    artifacts: string[];
    popupAliases: string[];
  };
  /** Environment variables the project reads besides BASE_URL; absent when it reads none. */
  environment?: string[];
  setupCommands: string[];
  runCommand: string;
  runtime: { node?: string; python?: string; playwright: string };
  files: { path: string; sha256: string; sizeBytes: number }[];
}
export interface CodeExport {
  files: Record<string, string>;
  metadata: CodeExportMetadata;
}

export interface ImportedCodeExportInput {
  format: CodeExportOptions["format"];
  entrypoint: string;
  files: Record<string, string>;
  contentHash: string;
  dependencyLock: Record<string, unknown>;
  limitations?: string[];
  /** Secret names the code reads through the `secrets` fixture. */
  secrets?: string[];
  /** True when the code uses the `profileRequest` or `profilePage` fixtures. */
  profile?: boolean;
  /** Source schemas the code checks values against (`sourceSchemas`), keyed by revision id + pointer. */
  schemas?: Record<string, unknown>;
}

/** Preserves authored source bytes and its admitted runtime lock without translation. */
export function exportImportedCode(input: ImportedCodeExportInput): CodeExport {
  const files = { ...input.files };
  const reserved = [
    "package.json",
    "package-lock.json",
    "playwright.config.ts",
    "pyproject.toml",
    "uv.lock",
    ".python-version",
    "runtime-lock.json",
    "export-metadata.json",
    "SETUP.txt",
  ];
  if (
    reserved.some((name) => Object.hasOwn(files, name)) ||
    Object.keys(files).some(
      (path) => path === FIXTURES_DIRECTORY || path.startsWith(`${FIXTURES_DIRECTORY}/`),
    )
  )
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Imported source conflicts with export project metadata",
    );
  if (input.format === "playwright") {
    const withSchemas = Object.keys(input.schemas ?? {}).length > 0;
    files["package.json"] = `${JSON.stringify(importedPlaywrightPackage, null, 2)}\n`;
    files["package-lock.json"] =
      `${JSON.stringify(withSchemas ? importedPlaywrightLockWithSchemas : importedPlaywrightLock, null, 2)}\n`;
    files[`${FIXTURES_DIRECTORY}/package.json`] =
      `${JSON.stringify(withSchemas ? fixturesPackageJsonWithSchemas : fixturesPackageJson, null, 2)}\n`;
    if (withSchemas)
      files[`${FIXTURES_DIRECTORY}/${SCHEMAS_FILE}`] =
        `${JSON.stringify(input.schemas, null, 2)}\n`;
    files[`${FIXTURES_DIRECTORY}/index.js`] = fixturesCommonjs;
    files[`${FIXTURES_DIRECTORY}/index.mjs`] = fixturesModule;
    files["playwright.config.ts"] =
      `import { defineConfig } from '@playwright/test';\nif(!process.env.BASE_URL) throw new Error('Set BASE_URL');\nexport default defineConfig({testDir:'.',testMatch:${JSON.stringify(input.entrypoint)},timeout:30000,workers:1,retries:0,use:{baseURL:process.env.BASE_URL,headless:true,launchOptions:{chromiumSandbox:true}}});\n`;
  } else {
    files["pyproject.toml"] =
      `[project]\nname = "exported-tests"\nversion = "0.1.0"\nrequires-python = "==3.12.*"\ndependencies = ["pytest==9.1.1", "pytest-asyncio==1.4.0", "requests==2.34.2", "playwright==1.63.0"]\n\n[tool.uv]\npackage = false\n\n[tool.pytest.ini_options]\nasyncio_mode = "strict"\ntestpaths = [${JSON.stringify(input.entrypoint)}]\n`;
    files["uv.lock"] = pythonLock;
    files[".python-version"] = "3.12\n";
  }
  files["runtime-lock.json"] = `${JSON.stringify(input.dependencyLock, null, 2)}\n`;
  const setupCommands =
    input.format === "playwright"
      ? ["npm ci", "npx playwright install chromium"]
      : ["uv sync --frozen", "uv run playwright install chromium"];
  const runCommand = input.format === "playwright" ? "npm test" : "uv run --frozen pytest";
  const environment = input.format === "playwright" ? fixtureEnvironment(input) : [];
  files["SETUP.txt"] =
    `Authored source files are unchanged. No model or backend is contacted by export.\nSetup:\n${setupCommands.join("\n")}\nRun: BASE_URL=<authorized-target> ${runCommand}\n\nThe admitted hardened image digest and build-input hash are in runtime-lock.json.\n${input.format === "playwright" ? playwrightFixturesSetup(input) : "Export does not translate or remove authored source."}\nLimitations:\n${(input.limitations ?? []).join("\n")}\n`;
  const metadata: CodeExportMetadata = {
    version: "1.0.0",
    format: input.format,
    framework: input.format === "playwright" ? "playwright-test" : "pytest",
    entrypoint: input.entrypoint,
    planHash: input.contentHash,
    assertionIds: [],
    requiredInputs: {
      secrets: [...(input.secrets ?? [])],
      variables: [],
      artifacts: [],
      popupAliases: [],
    },
    ...(environment.length > 0 ? { environment } : {}),
    setupCommands,
    runCommand,
    runtime: {
      ...(input.format === "playwright" ? { node: ">=20" } : { python: "3.12" }),
      playwright: PLAYWRIGHT_VERSION,
    },
    files: Object.entries(files).map(([path, content]) => ({
      path,
      sha256: sha256(content),
      sizeBytes: Buffer.byteLength(content),
    })),
  };
  files["export-metadata.json"] = `${JSON.stringify(metadata, null, 2)}\n`;
  return { files, metadata };
}

const browserOperations: Record<string, true> = {
  navigate: true,
  click: true,
  fill: true,
  press: true,
  select: true,
  check: true,
  uncheck: true,
  hover: true,
  drag: true,
  upload: true,
  download: true,
  switchPage: true,
  frame: true,
  waitFor: true,
  request: true,
  assert: true,
};
const uiPredicates: Record<string, true> = {
  visible: true,
  hidden: true,
  textEquals: true,
  textContains: true,
  valueEquals: true,
  enabled: true,
  disabled: true,
  countEquals: true,
  countAtLeast: true,
  countAtMost: true,
  urlEquals: true,
  urlMatches: true,
  downloadMatches: true,
};
const httpPredicates: Record<string, true> = {
  statusIn: true,
  headerEquals: true,
  headerMatches: true,
  cookieAbsent: true,
  jsonEquals: true,
  countEquals: true,
  countAtLeast: true,
  countAtMost: true,
};
/** ECMAScript pattern syntax that has no identical Python `re` meaning. */
const pythonIncompatiblePattern = /\(\?<|\\[pPkuc]|\[\^?\]/u;
const pythonIncompatibleReason =
  "the pattern uses an ECMAScript construct (named group, lookbehind, \\u, \\p, \\k, \\c or an empty class) that Python regular expressions do not share; export to playwright instead";

const playwrightPackage = {
  name: "exported-tests",
  version: "0.1.0",
  private: true,
  type: "module",
  scripts: { test: "playwright test" },
  engines: { node: ">=20" },
  devDependencies: { "@playwright/test": PLAYWRIGHT_VERSION },
};
const playwrightLock = {
  name: "exported-tests",
  version: "0.1.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": {
      name: "exported-tests",
      version: "0.1.0",
      devDependencies: { "@playwright/test": PLAYWRIGHT_VERSION },
      engines: { node: ">=20" },
    },
    "node_modules/@playwright/test": {
      version: PLAYWRIGHT_VERSION,
      resolved: `https://registry.npmjs.org/@playwright/test/-/test-${PLAYWRIGHT_VERSION}.tgz`,
      integrity:
        "sha512-oxMK4vllB9RK5NQ2l1pq1IfOf2AvnEuj/vYGDj0H2nMtmtZpKtCwt/l00GEO6xjGfpBNAvjovvYdCm50dRQkpQ==",
      dev: true,
      dependencies: { playwright: PLAYWRIGHT_VERSION },
      bin: { playwright: "cli.js" },
      engines: { node: ">=20" },
    },
    "node_modules/playwright": {
      version: PLAYWRIGHT_VERSION,
      resolved: `https://registry.npmjs.org/playwright/-/playwright-${PLAYWRIGHT_VERSION}.tgz`,
      integrity:
        "sha512-+7ziBLidS4NaNCdt57SUDT+wYmmd5fmiQejUic/kb+YsYSCPyOOE9sebzMjNmQrsnNpDJqd4WHvV/8lfKfUDUg==",
      dev: true,
      dependencies: { "playwright-core": PLAYWRIGHT_VERSION },
      bin: { playwright: "cli.js" },
      engines: { node: ">=20" },
    },
    "node_modules/playwright-core": {
      version: PLAYWRIGHT_VERSION,
      resolved: `https://registry.npmjs.org/playwright-core/-/playwright-core-${PLAYWRIGHT_VERSION}.tgz`,
      integrity:
        "sha512-rYCsBF/M5HjUch52bbtVONEFjv6Xu8sm8h72dNlR5bzIE1fvC/bxgspzkjSfU+MweEMmPM8KJebG6nnyxo5mCg==",
      dev: true,
      bin: { "playwright-core": "cli.js" },
      engines: { node: ">=20" },
    },
  },
};

/**
 * Imported Playwright code keeps its `@playwright/test` import, which resolves to the local fixtures
 * package (see playwright-fixtures.ts); the stock package is installed under an npm alias. The
 * `playwright` dependency supplies the `playwright` binary of `npm test` and `npx playwright install`.
 */
const importedDevDependencies = {
  "@playwright/test": `file:${FIXTURES_DIRECTORY}`,
  playwright: PLAYWRIGHT_VERSION,
};
const importedPlaywrightPackage = {
  ...playwrightPackage,
  devDependencies: importedDevDependencies,
};
const importedPlaywrightLock = {
  ...playwrightLock,
  packages: {
    "": { ...playwrightLock.packages[""], devDependencies: importedDevDependencies },
    "node_modules/@playwright/test": { resolved: FIXTURES_DIRECTORY, link: true },
    "node_modules/playwright": playwrightLock.packages["node_modules/playwright"],
    "node_modules/playwright-core": playwrightLock.packages["node_modules/playwright-core"],
    [`node_modules/${STOCK_PACKAGE}`]: {
      name: "@playwright/test",
      ...playwrightLock.packages["node_modules/@playwright/test"],
    },
    [FIXTURES_DIRECTORY]: {
      name: fixturesPackageJson.name,
      version: fixturesPackageJson.version,
      dev: true,
      dependencies: fixturesPackageJson.dependencies,
    },
  },
};
/** The same lock for code that checks source schemas: the validator is pinned with the fixtures. */
const importedPlaywrightLockWithSchemas = {
  ...importedPlaywrightLock,
  packages: {
    ...importedPlaywrightLock.packages,
    ...schemaValidatorLockPackages,
    [FIXTURES_DIRECTORY]: {
      ...importedPlaywrightLock.packages[FIXTURES_DIRECTORY],
      dependencies: fixturesPackageJsonWithSchemas.dependencies,
    },
  },
};

/** Environment variables the fixtures of imported Playwright code read (besides BASE_URL). */
function fixtureEnvironment(input: ImportedCodeExportInput): string[] {
  return [
    ...(input.secrets ?? []).map((name) => `${SECRET_ENV_PREFIX}${name}`),
    ...(input.profile ? [PROFILE_STORAGE_STATE_ENV, PROFILE_HEADERS_ENV] : []),
  ];
}
function playwrightFixturesSetup(input: ImportedCodeExportInput): string {
  const secrets = input.secrets ?? [];
  const schemaCount = Object.keys(input.schemas ?? {}).length;
  return [
    `The authored "@playwright/test" import resolves to ./${FIXTURES_DIRECTORY}, which adds the runner fixtures to the pinned Playwright ${PLAYWRIGHT_VERSION}; tests that use none of them behave as under stock Playwright. Export does not translate or remove authored imports or fixtures.`,
    `secrets.get("NAME") reads the environment variable ${SECRET_ENV_PREFIX}NAME${secrets.length > 0 ? `; this code reads: ${secrets.map((name) => `${SECRET_ENV_PREFIX}${name}`).join(", ")}` : ""}.`,
    `profileRequest and profilePage carry the auth profile session; the stock request and page stay unauthenticated. The session is sent to the BASE_URL origin only${input.profile ? " and this code needs it" : ""}:`,
    `  ${PROFILE_STORAGE_STATE_ENV}=<file>  Playwright storage-state JSON (cookies and web storage; entries for other origins are ignored)`,
    `  ${PROFILE_HEADERS_ENV}='{"x-api-key":"..."}'  header credentials of the profile, JSON object (profileRequest only; never sent along a redirect)`,
    "Without either, a test that uses these fixtures fails.",
    ...(schemaCount > 0
      ? [
          `sourceSchemas.violations(sourceRevisionId, pointer, value) checks a value against a source schema frozen into ./${FIXTURES_DIRECTORY}/${SCHEMAS_FILE} (${schemaCount} in this code) with ajv ${SCHEMA_VALIDATOR_DEPENDENCIES.ajv} and ajv-formats ${SCHEMA_VALIDATOR_DEPENDENCIES["ajv-formats"]}, the validator and options TestMaster's runner uses for a plan's jsonSchema assertion.`,
        ]
      : []),
  ].join("\n");
}

/** Exports deterministic, model-free projects; external inputs remain explicit runtime references. */
export function exportCode(input: ExecutablePlan, options: CodeExportOptions): CodeExport {
  if (options.format !== "playwright" && options.format !== "pytest")
    throw new ContractError("INVALID_ARGUMENT", "Unknown code export format");
  if (input.runner === "terminal")
    throw new ContractError(
      "CAPABILITY_UNAVAILABLE",
      "Code export is not available for terminal tests; replay them with the terminal runner",
      { operation: "export", runner: "terminal", format: options.format },
    );
  if (options.async && (options.format !== "pytest" || input.runner !== "playwright"))
    throw new ContractError("INVALID_ARGUMENT", "Async export requires pytest Playwright");
  const plan = validate<ExecutablePlan>("ExecutablePlan", input);
  const secrets = new Set<string>();
  const variables = new Set<string>();
  const artifacts = new Set<string>();
  const popupAliases = new Set<string>();
  const assertionIds: string[] = [];
  function references(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.pageAlias === "string" && record.pageAlias !== "main")
      popupAliases.add(record.pageAlias);
    if (typeof record.secretRef === "string") secrets.add(record.secretRef);
    if (typeof record.variableRef === "string") variables.add(record.variableRef);
    if (typeof record.artifactRef === "string") artifacts.add(record.artifactRef);
    if (Array.isArray(record.artifactRefs))
      for (const ref of record.artifactRefs) artifacts.add(String(ref));
    for (const child of Object.values(record)) references(child);
  }
  function unsupported(stepId: string, operation: string, reason: string): never {
    throw new ContractError(
      "CAPABILITY_UNAVAILABLE",
      `Code export cannot represent ${operation}: ${reason}`,
      { stepId, operation, format: options.format },
    );
  }
  /** Exported code has no auth profile and sends JSON bodies as written. */
  function unsupportedRequestFeature(
    stepId: string,
    input: Extract<PlanStep, { operation: "request" }>["input"],
  ): void {
    if (input.auth === "profile")
      unsupported(
        stepId,
        "request",
        "auth profile sessions are not available in exported code; cite the credential with a secretRef header",
      );
    if (input.body?.kind === "json" && input.body.set?.length)
      unsupported(stepId, "request", "JSON body set entries are not available in exported code");
  }
  function check(steps: PlanStep[]): void {
    for (const step of steps) {
      if (!browserOperations[step.operation])
        unsupported(step.id, step.operation, "unknown operation");
      if (step.operation === "request") unsupportedRequestFeature(step.id, step.input);
      if (
        options.format === "pytest" &&
        step.operation === "select" &&
        new Set(step.input.values.map((choice) => Object.keys(choice)[0])).size > 1
      )
        unsupported(
          step.id,
          step.operation,
          "Python Playwright cannot express mixed value/label/index choices in one selection",
        );
      if (plan.runner === "http" && step.operation !== "request" && step.operation !== "assert")
        unsupported(step.id, step.operation, "browser operation in an HTTP plan");
      if (step.operation === "navigate" && /^(?:[a-z][a-z0-9+.-]*:)?\/\//iu.test(step.input.path))
        unsupported(
          step.id,
          step.operation,
          "absolute navigation must be authored relative to configured BASE_URL",
        );
      if (step.operation === "switchPage") popupAliases.add(step.input.pageAlias);
      if (
        step.operation === "waitFor" &&
        "response" in step.input &&
        /^(?:[a-z][a-z0-9+.-]*:)?\/\//iu.test(step.input.response.url)
      )
        unsupported(
          step.id,
          step.operation,
          "absolute response URL must be relative to configured BASE_URL",
        );
      if (step.operation === "assert") {
        assertionIds.push(step.id);
        const response = "responseStepId" in step.input;
        const predicate = step.expectation.predicate;
        if (!(response ? httpPredicates : uiPredicates)[predicate])
          unsupported(
            step.id,
            predicate,
            predicate === "jsonSchema"
              ? "source schema revision is not available in the plan; resolve the schema before export"
              : predicate === "jsonConforms"
                ? "exported code ships no JSON Schema validator; the runner judges this assertion"
                : "predicate is unavailable for this assertion target",
          );
        if (plan.runner === "http" && !response)
          unsupported(step.id, predicate, "HTTP assertions need responseStepId");
        if (
          options.format === "pytest" &&
          (step.expectation.predicate === "headerMatches" ||
            step.expectation.predicate === "urlMatches") &&
          pythonIncompatiblePattern.test(step.expectation.pattern)
        )
          unsupported(step.id, predicate, pythonIncompatibleReason);
        if (
          predicate === "urlEquals" &&
          "value" in step.expectation &&
          "literal" in step.expectation.value
        )
          unsupported(
            step.id,
            predicate,
            "absolute expected URLs require a configured variableRef, not a baked target",
          );
      }
      if (step.operation === "frame") check(step.input.childSteps);
    }
  }
  check(plan.steps);
  validatePlanSemantics(plan);
  for (const cleanup of plan.cleanup ?? []) {
    unsupportedRequestFeature(cleanup.resourceRef, cleanup.input);
    const success = cleanup.successPredicate;
    if (!httpPredicates[success.predicate])
      unsupported(cleanup.resourceRef, success.predicate, "cleanup predicate is unsupported");
    if (
      options.format === "pytest" &&
      success.predicate === "headerMatches" &&
      pythonIncompatiblePattern.test(success.pattern)
    )
      unsupported(cleanup.resourceRef, success.predicate, pythonIncompatibleReason);
  }
  references(plan);
  const captures = new Set<string>();
  function produced(steps: PlanStep[]): void {
    for (const step of steps) {
      if (step.operation === "request") {
        for (const capture of step.input.capture ?? []) {
          captures.add(capture.name);
          captures.add(`${step.id}.${capture.name}`);
        }
        if (step.input.resource) captures.add(`${step.id}.handle`);
      }
      if (step.operation === "frame") produced(step.input.childSteps);
    }
  }
  produced(plan.steps);
  for (const capture of captures) variables.delete(capture);
  for (const binding of plan.dependsOn ?? []) variables.add(binding.consumerInput);
  const files: Record<string, string> = {};
  const serialized = JSON.stringify(plan, null, 2);
  const framework =
    options.format === "playwright"
      ? "playwright-test"
      : plan.runner === "http"
        ? "requests"
        : options.async
          ? "playwright-async"
          : "playwright-sync";
  const entrypoint = options.format === "playwright" ? "tests/plan.spec.ts" : "test_plan.py";
  const setupCommands =
    options.format === "playwright"
      ? ["npm ci", "npx playwright install chromium"]
      : ["uv sync --frozen", "uv run playwright install chromium"];
  const runCommand = options.format === "playwright" ? "npm test" : "uv run --frozen pytest";
  if (options.format === "playwright") {
    files["package.json"] = `${JSON.stringify(playwrightPackage, null, 2)}\n`;
    files["package-lock.json"] = `${JSON.stringify(playwrightLock, null, 2)}\n`;
    files["playwright.config.ts"] =
      `import { defineConfig } from '@playwright/test';\nif (!process.env.BASE_URL) throw new Error('Set BASE_URL to the authorized target');\nexport default defineConfig({ testDir: './tests', timeout: 300000, workers: 1, retries: 0, use: { baseURL: process.env.BASE_URL, locale: 'en-US', timezoneId: 'UTC', viewport: {width:1280,height:720}, serviceWorkers: 'block', acceptDownloads: true, headless: true, launchOptions: {chromiumSandbox:true}, ...(process.env.HTTPS_PROXY ? {proxy:{server:process.env.HTTPS_PROXY,bypass:'<-loopback>'}} : {}) } });\n`;
    files["helpers/standalone.ts"] = typescriptRuntime;
    files[entrypoint] =
      `import { test } from '@playwright/test';\nimport { executePlan } from '../helpers/standalone';\nconst plan = ${serialized};\ntest(${JSON.stringify(plan.name)}, async ({page,request,baseURL}) => { await executePlan(plan,page,request,baseURL ?? process.env.BASE_URL ?? ''); });\n`;
  } else {
    files["pyproject.toml"] =
      `[project]\nname = "exported-tests"\nversion = "0.1.0"\nrequires-python = "==3.12.*"\ndependencies = ["pytest==9.1.1", "pytest-asyncio==1.4.0", "requests==2.34.2", "playwright==1.63.0"]\n\n[tool.uv]\npackage = false\n\n[tool.pytest.ini_options]\nasyncio_mode = "strict"\ntestpaths = ["."]\n`;
    files["uv.lock"] = pythonLock;
    files[".python-version"] = "3.12\n";
    files["standalone.py"] = pythonRuntime(options.async === true);
    const literal = `json.loads(${JSON.stringify(serialized)})`;
    const imports = `import json\nimport os\nfrom standalone import PlanRuntime\n`;
    if (plan.runner === "http")
      files[entrypoint] =
        `${imports}\ndef test_plan():\n    PlanRuntime(os.environ['BASE_URL']).run(${literal})\n`;
    else {
      const async = options.async === true;
      const awaitToken = async ? "await " : "";
      const prefix = async ? "async " : "";
      files[entrypoint] =
        `${imports}import pytest\nfrom playwright.${async ? "async_api import async_playwright" : "sync_api import sync_playwright"}\n\n${async ? "@pytest.mark.asyncio\n" : ""}${prefix}def test_plan():\n    base_url = os.environ['BASE_URL']\n    ${prefix}with ${async ? "async_playwright" : "sync_playwright"}() as playwright:\n        proxy = {'server': os.environ['HTTPS_PROXY'], 'bypass': '<-loopback>'} if os.environ.get('HTTPS_PROXY') else None\n        browser = ${awaitToken}playwright.chromium.launch(headless=True, chromium_sandbox=True, proxy=proxy)\n        context = ${awaitToken}browser.new_context(base_url=base_url, viewport={'width':1280, 'height':720}, locale='en-US', timezone_id='UTC', service_workers='block', accept_downloads=True)\n        try:\n            page = ${awaitToken}context.new_page()\n            ${awaitToken}PlanRuntime(base_url, page).run(${literal})\n        finally:\n            ${awaitToken}context.close()\n            ${awaitToken}browser.close()\n`;
    }
  }
  files["inputs.example.json"] =
    `${JSON.stringify({ variables: Object.fromEntries([...variables].map((name) => [name, null])), artifacts: Object.fromEntries([...artifacts].map((id) => [id, { path: "inputs/file", sizeBytes: 0, mimeType: "application/octet-stream", sha256: sha256("") }])), popupAliases: [...popupAliases] }, null, 2)}\n`;
  files["SETUP.txt"] =
    `Standalone ${framework} project. No backend or model is required.\n\nSetup:\n${setupCommands.join("\n")}\nRun: BASE_URL=<authorized-target> ${runCommand}\n\nSet TEST_INPUTS_JSON to the runtime input JSON (variables, artifact manifest, popupAliases).\nDependencies require explicitly supplied producer outputs; no previous runs are queried.\nSet SECRET_<secretRef> environment variables for secret references; secrets are never embedded.\nSet INPUT_DIR for artifacts. Manifest entries require relative path, sizeBytes, mimeType and sha256.\nExpected page aliases must be supplied in popup creation order. Main page alias is main.\nHTTPS_PROXY/HTTP_PROXY may be supplied by an isolated runtime.\nLocks pin Playwright 1.63.0 (including Chromium revision via its bundled browser metadata).\nOptional step errors are nonfatal; required assertions retain exact comparisons.\nStandalone code does not enforce TestMaster grants, approvals, egress policy, or redact third-party reporter output. Run only against an authorized target with appropriate external isolation.\n`;
  const metadata: CodeExportMetadata = {
    version: "1.0.0",
    format: options.format,
    framework,
    entrypoint,
    planHash: semanticHash(plan, "plan"),
    assertionIds,
    requiredInputs: {
      secrets: [...secrets],
      variables: [...variables],
      artifacts: [...artifacts],
      popupAliases: [...popupAliases],
    },
    setupCommands,
    runCommand,
    runtime: {
      ...(options.format === "playwright" ? { node: ">=20" } : { python: "3.12" }),
      playwright: PLAYWRIGHT_VERSION,
    },
    files: Object.entries(files).map(([path, content]) => ({
      path,
      sha256: sha256(content),
      sizeBytes: Buffer.byteLength(content),
    })),
  };
  files["export-metadata.json"] = `${JSON.stringify(metadata, null, 2)}\n`;
  return { files, metadata };
}
