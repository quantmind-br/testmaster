import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { CODE_SECRETS_ENV, stageImportedModules } from "./imported-modules.js";

const run = promisify(execFile);
const runnerModules = fileURLToPath(new URL("../node_modules", import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/**
 * Stages the shim and runs the real Playwright CLI over `spec`; no browser is needed. `esm` makes
 * the staged root a `"type": "module"` package, as an exported project is.
 */
async function playwright(spec: string, secrets: Record<string, string>, esm = false) {
  const root = await mkdtemp(join(tmpdir(), "tm-imported-modules-"));
  roots.push(root);
  await mkdir(join(root, "node_modules"), { recursive: true });
  await stageImportedModules(runnerModules, join(root, "node_modules"));
  if (esm) await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    join(root, "playwright.config.js"),
    esm
      ? "export default { testDir: '.', workers: 1 };"
      : "module.exports = { testDir: '.', workers: 1 };",
  );
  await writeFile(join(root, "code.spec.ts"), spec);
  return await run(
    process.execPath,
    [join(runnerModules, "@playwright/test/cli.js"), "test", "--reporter=json"],
    { cwd: root, env: { ...process.env, [CODE_SECRETS_ENV]: JSON.stringify(secrets) } },
  ).then(
    ({ stdout }) => ({ code: 0, report: JSON.parse(stdout) }),
    (error: { code: number; stdout: string }) => ({
      code: error.code,
      report: JSON.parse(error.stdout),
    }),
  );
}
const spec = (body: string) =>
  `import { test, expect } from '@playwright/test';\ntest('reads', async ({ secrets }) => { ${body} });\n`;
const errorsOf = (report: { suites: unknown }) => JSON.stringify(report.suites);

it("gives imported code the secrets fixture with the declared values through the real Playwright", async () => {
  const outcome = await playwright(spec("expect(secrets.get('API_KEY')).toBe('v-1');"), {
    API_KEY: "v-1",
  });
  expect(outcome.code).toBe(0);
  expect(outcome.report.stats).toMatchObject({ expected: 1, unexpected: 0 });
}, 60_000);

it("fails a test that reads a secret the host did not declare, naming it and not the values", async () => {
  const outcome = await playwright(spec("secrets.get('OTHER');"), { API_KEY: "canary-value" });
  expect(outcome.code).toBe(1);
  expect(outcome.report.stats).toMatchObject({ unexpected: 1 });
  expect(errorsOf(outcome.report)).toContain('Secret \\"OTHER\\" is not declared for this test');
  expect(errorsOf(outcome.report)).not.toContain("canary-value");
}, 60_000);

it("keeps the module surface of @playwright/test: devices, describe and a default import", async () => {
  const outcome = await playwright(
    `import base, { devices, test, expect } from '@playwright/test';\ntest.describe('group', () => { test('surface', async ({ secrets }) => { expect(typeof devices['Desktop Chrome']).toBe('object'); expect(base).toBe(test); expect(secrets.get('A')).toBe('1'); }); });\n`,
    { A: "1" },
  );
  expect(outcome.code).toBe(0);
  expect(outcome.report.stats).toMatchObject({ expected: 1 });
}, 60_000);

it("serves the named exports and the secrets fixture to code Playwright loads as an ES module", async () => {
  const outcome = await playwright(
    `import base, { devices, test, expect } from '@playwright/test';\ntest('esm', async ({ secrets }) => { expect(typeof devices['Desktop Chrome']).toBe('object'); expect(base).toBe(test); expect(secrets.get('A')).toBe('1'); });\n`,
    { A: "1" },
    true,
  );
  expect(outcome.code).toBe(0);
  expect(outcome.report.stats).toMatchObject({ expected: 1, unexpected: 0 });
}, 60_000);
