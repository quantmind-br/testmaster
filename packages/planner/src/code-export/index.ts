import {
  ContractError,
  type ExecutablePlan,
  type PlanStep,
  validate,
  validatePlanSemantics,
} from "@testmaster/contracts";
import { semanticHash, sha256 } from "@testmaster/domain";
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
  if (reserved.some((name) => Object.hasOwn(files, name)))
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Imported source conflicts with export project metadata",
    );
  if (input.format === "playwright") {
    files["package.json"] = `${JSON.stringify(playwrightPackage, null, 2)}\n`;
    files["package-lock.json"] = `${JSON.stringify(playwrightLock, null, 2)}\n`;
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
  files["SETUP.txt"] =
    `Authored source files are unchanged. No model or backend is contacted by export.\nSetup:\n${setupCommands.join("\n")}\nRun: BASE_URL=<authorized-target> ${runCommand}\n\nThe admitted hardened image digest and build-input hash are in runtime-lock.json.\nImported tests using runner-specific fixtures require that pinned runner harness; plain authored tests run standalone.\nExport does not translate or remove authored harness imports or fixtures.\nLimitations:\n${(input.limitations ?? []).join("\n")}\n`;
  const metadata: CodeExportMetadata = {
    version: "1.0.0",
    format: input.format,
    framework: input.format === "playwright" ? "playwright-test" : "pytest",
    entrypoint: input.entrypoint,
    planHash: input.contentHash,
    assertionIds: [],
    requiredInputs: { secrets: [], variables: [], artifacts: [], popupAliases: [] },
    setupCommands,
    runCommand,
    runtime: {
      ...(input.format === "playwright" ? { node: ">=20" } : { python: "3.12" }),
      playwright: "1.63.0",
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
  countEquals: true,
  urlEquals: true,
  downloadMatches: true,
};
const httpPredicates: Record<string, true> = {
  statusIn: true,
  headerEquals: true,
  jsonEquals: true,
  countEquals: true,
};

const playwrightPackage = {
  name: "exported-tests",
  version: "0.1.0",
  private: true,
  type: "module",
  scripts: { test: "playwright test" },
  engines: { node: ">=20" },
  devDependencies: { "@playwright/test": "1.63.0" },
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
      devDependencies: { "@playwright/test": "1.63.0" },
      engines: { node: ">=20" },
    },
    "node_modules/@playwright/test": {
      version: "1.63.0",
      resolved: "https://registry.npmjs.org/@playwright/test/-/test-1.63.0.tgz",
      integrity:
        "sha512-oxMK4vllB9RK5NQ2l1pq1IfOf2AvnEuj/vYGDj0H2nMtmtZpKtCwt/l00GEO6xjGfpBNAvjovvYdCm50dRQkpQ==",
      dev: true,
      dependencies: { playwright: "1.63.0" },
      bin: { playwright: "cli.js" },
      engines: { node: ">=20" },
    },
    "node_modules/playwright": {
      version: "1.63.0",
      resolved: "https://registry.npmjs.org/playwright/-/playwright-1.63.0.tgz",
      integrity:
        "sha512-+7ziBLidS4NaNCdt57SUDT+wYmmd5fmiQejUic/kb+YsYSCPyOOE9sebzMjNmQrsnNpDJqd4WHvV/8lfKfUDUg==",
      dev: true,
      dependencies: { "playwright-core": "1.63.0" },
      bin: { playwright: "cli.js" },
      engines: { node: ">=20" },
    },
    "node_modules/playwright-core": {
      version: "1.63.0",
      resolved: "https://registry.npmjs.org/playwright-core/-/playwright-core-1.63.0.tgz",
      integrity:
        "sha512-rYCsBF/M5HjUch52bbtVONEFjv6Xu8sm8h72dNlR5bzIE1fvC/bxgspzkjSfU+MweEMmPM8KJebG6nnyxo5mCg==",
      dev: true,
      bin: { "playwright-core": "cli.js" },
      engines: { node: ">=20" },
    },
  },
};

/** Exports deterministic, model-free projects; external inputs remain explicit runtime references. */
export function exportCode(input: ExecutablePlan, options: CodeExportOptions): CodeExport {
  if (options.format !== "playwright" && options.format !== "pytest")
    throw new ContractError("INVALID_ARGUMENT", "Unknown code export format");
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
  function check(steps: PlanStep[]): void {
    for (const step of steps) {
      if (!browserOperations[step.operation])
        unsupported(step.id, step.operation, "unknown operation");
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
              : "predicate is unavailable for this assertion target",
          );
        if (plan.runner === "http" && !response)
          unsupported(step.id, predicate, "HTTP assertions need responseStepId");
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
  for (const cleanup of plan.cleanup ?? [])
    if (!httpPredicates[cleanup.successPredicate.predicate])
      unsupported(
        cleanup.resourceRef,
        cleanup.successPredicate.predicate,
        "cleanup predicate is unsupported",
      );
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
      playwright: "1.63.0",
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
