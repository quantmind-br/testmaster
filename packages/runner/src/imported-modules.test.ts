import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ContractError, validateAgainstSchema } from "@testmaster/contracts";
import { afterEach, expect, it } from "vitest";
import { CODE_PROFILE_ENV, CODE_SECRETS_ENV, stageImportedModules } from "./imported-modules.js";

const run = promisify(execFile);
const runnerModules = fileURLToPath(new URL("../node_modules", import.meta.url));
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/**
 * Stages the shim and runs the real Playwright CLI over `spec`; no browser is needed. `esm` makes
 * the staged root a `"type": "module"` package, as an exported project is.
 */
async function playwright(
  spec: string,
  secrets: Record<string, string>,
  esm = false,
  env: Record<string, string> = {},
  schemas: Record<string, unknown> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "tm-imported-modules-"));
  roots.push(root);
  await mkdir(join(root, "node_modules"), { recursive: true });
  await stageImportedModules(runnerModules, join(root, "node_modules"), schemas);
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
    {
      cwd: root,
      env: { ...process.env, ...env, [CODE_SECRETS_ENV]: JSON.stringify(secrets) },
    },
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

/** A target whose `/me` answers 200 only to the profile's session cookie or `x-api-key`. */
async function target() {
  const server = createServer((request, response) => {
    const signedIn =
      String(request.headers.cookie).includes("ap_session=tm-session-cookie") ||
      request.headers["x-api-key"] === "tm-header-key";
    if (request.url === "/go") response.writeHead(302, { location: "/me" }).end();
    else response.writeHead(signedIn ? 200 : 401).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, env: { PLAYWRIGHT_TEST_BASE_URL: origin } };
}
/** The environment of a run whose profile session is `profile`, for a target at `origin`. */
const withSession = (profile: object, origin: string, env: Record<string, string>) => ({
  ...env,
  [CODE_PROFILE_ENV]: JSON.stringify({ origins: [origin], headers: {}, ...profile }),
});
const SESSION_COOKIE = {
  name: "ap_session",
  value: "tm-session-cookie",
  domain: "127.0.0.1",
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: false,
  sameSite: "Lax",
};

it("gives profileRequest the profile's cookies while the stock request fixture stays unauthenticated", async () => {
  const { origin, env } = await target();
  const outcome = await playwright(
    `import { test, expect } from '@playwright/test';\ntest('session', async ({ request, profileRequest }) => { const anonymous = await request.get('/me'); const signedIn = await profileRequest.get('/me'); expect(anonymous.status()).toBe(401); expect(signedIn.status()).toBe(200); });\n`,
    {},
    false,
    withSession({ storageState: { cookies: [SESSION_COOKIE], origins: [] } }, origin, env),
  );
  expect(outcome.report.stats).toMatchObject({ expected: 1, unexpected: 0 });
  expect(outcome.code).toBe(0);
}, 60_000);

it("sends a header credential only to the environment's origins, never along a redirect, and never over the caller's header", async () => {
  const { origin, env } = await target();
  const outcome = await playwright(
    `import { test, expect } from '@playwright/test';\ntest('header', async ({ profileRequest }) => {\n  expect((await profileRequest.get('/me')).status()).toBe(200);\n  expect((await profileRequest.get('/go')).status()).toBe(302);\n  await expect(profileRequest.get('http://127.0.0.2:9/me')).rejects.toThrow("only sent to the environment's origins");\n  await expect(profileRequest.get('/me', { headers: { 'X-API-Key': 'other' } })).rejects.toThrow('conflicts with the auth profile credential');\n});\n`,
    {},
    false,
    withSession({ headers: { "x-api-key": "tm-header-key" } }, origin, env),
  );
  expect(outcome.report.stats).toMatchObject({ expected: 1, unexpected: 0 });
  expect(outcome.code).toBe(0);
}, 60_000);

it("fails a test that asks for the profile session when the run has none, naming the fixture", async () => {
  const outcome = await playwright(
    `import { test, expect } from '@playwright/test';\ntest('none', async ({ profileRequest }) => { expect((await profileRequest.get('/me')).status()).toBe(200); });\n`,
    {},
  );
  expect(outcome.code).toBe(1);
  expect(errorsOf(outcome.report)).toContain("The profileRequest fixture needs the environment");
}, 60_000);

const SCHEMA_REVISION = "svr_00000000-0000-4000-8000-000000000001";
const SCHEMA_POINTER = "/paths/~1items/get/responses/200/content/application~1json/schema";
/** An OpenAPI-flavoured schema: annotations, a vendor extension and a numeric format. */
const SOURCE_SCHEMA = {
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
/** What the plan's `jsonSchema` predicate (`validateAgainstSchema`) reports for `body`, as violation lines. */
function planViolations(body: unknown): string[] {
  try {
    validateAgainstSchema(SOURCE_SCHEMA, body);
    return [];
  } catch (error) {
    const issues = (error as ContractError).details.issues as {
      instancePath: string;
      keyword: string;
      message: string;
      params: { missingProperty?: string; additionalProperty?: string };
    }[];
    return issues.map((issue) => {
      const property = issue.params.missingProperty ?? issue.params.additionalProperty;
      return `${issue.instancePath || "/"} ${issue.keyword}: ${issue.message}${property === undefined ? "" : ` (${property})`}`;
    });
  }
}
const checkSchema = (body: unknown) =>
  `sourceSchemas.violations(${JSON.stringify(SCHEMA_REVISION)}, ${JSON.stringify(SCHEMA_POINTER)}, ${JSON.stringify(body)})`;

it("checks a value against a frozen source schema with the validator of the plan's jsonSchema predicate", async () => {
  const valid = { id: 7, name: "a", tags: ["x", null] };
  const invalid = { id: "7", tags: [1], extra: true };
  expect(planViolations(valid)).toEqual([]);
  expect(planViolations(invalid).length).toBeGreaterThan(2);
  const outcome = await playwright(
    `import { test, expect } from '@playwright/test';\n` +
      `test('matching body', async ({ sourceSchemas }) => { expect(${checkSchema(valid)}).toEqual(${JSON.stringify(planViolations(valid))}); });\n` +
      `test('same violations as the plan', async ({ sourceSchemas }) => { expect(${checkSchema(invalid)}).toEqual(${JSON.stringify(planViolations(invalid))}); });\n` +
      `test('mismatching body fails', async ({ sourceSchemas }) => { expect(${checkSchema(invalid)}).toEqual([]); });\n`,
    {},
    false,
    {},
    { [`${SCHEMA_REVISION}${SCHEMA_POINTER}`]: SOURCE_SCHEMA },
  );
  expect(outcome.report.stats).toMatchObject({ expected: 2, unexpected: 1 });
  expect(errorsOf(outcome.report)).toContain("/id type: must be integer");
}, 60_000);

it("fails a test that names a schema it was not given, or a schema that cannot be compiled, instead of passing", async () => {
  const outcome = await playwright(
    `import { test, expect } from '@playwright/test';\n` +
      `test('absent', async ({ sourceSchemas }) => { expect(sourceSchemas.violations('svr_other', '/x', {})).toEqual([]); });\n` +
      `test('unusable', async ({ sourceSchemas }) => { expect(sourceSchemas.violations('svr_bad', '/x', {})).toEqual([]); });\n`,
    {},
    false,
    {},
    { "svr_bad/x": { type: "object", bogus: true } },
  );
  expect(outcome.report.stats).toMatchObject({ expected: 0, unexpected: 2 });
  expect(errorsOf(outcome.report)).toContain(
    'Source schema \\"svr_other/x\\" is not part of this test',
  );
  expect(errorsOf(outcome.report)).toContain(
    'Source schema \\"svr_bad/x\\" cannot be used for validation',
  );
}, 60_000);
