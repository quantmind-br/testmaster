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
import { CODE_EGRESS_ENV } from "./code-egress.js";
import {
  CODE_PROFILE_ENV,
  CODE_REDACTIONS_ENV,
  CODE_SECRETS_ENV,
  stageImportedModules,
} from "./imported-modules.js";

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
 * Stages the shim beside `spec` in a temporary project. `esm` makes the staged root a
 * `"type": "module"` package, as an exported project is.
 */
async function stage(spec: string, esm: boolean, schemas: Record<string, unknown>) {
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
  return root;
}

/** Runs the real Playwright CLI over `spec`; no browser is needed. */
async function playwright(
  spec: string,
  secrets: Record<string, string>,
  esm = false,
  env: Record<string, string> = {},
  schemas: Record<string, unknown> = {},
) {
  const root = await stage(spec, esm, schemas);
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

interface ReportedTest {
  title: string;
  status: string;
  attachments: { name: string; contentType: string; path?: string; body?: string }[];
}
/**
 * Runs `spec` in a real Chromium through the staged shim and reports, per test, its status and the
 * attachments Playwright's reporters receive (TestMaster's reporter reads exactly these).
 */
async function reportedTests(
  spec: string,
  redactions: string[],
  env: Record<string, string> = {},
): Promise<ReportedTest[]> {
  const root = await stage(spec, false, {});
  await writeFile(
    join(root, "attachments-reporter.cjs"),
    `module.exports = class { onTestEnd(test, result) { process.stdout.write(JSON.stringify({ title: test.title, status: result.status, attachments: result.attachments.map((a) => ({ name: a.name, contentType: a.contentType, path: a.path, body: a.body && a.body.toString("base64") })) }) + "\\n"); } };`,
  );
  const finish = (stdout: string) =>
    stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as ReportedTest);
  return await run(
    process.execPath,
    [
      join(runnerModules, "@playwright/test/cli.js"),
      "test",
      "--reporter=./attachments-reporter.cjs",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        ...env,
        [CODE_SECRETS_ENV]: "{}",
        [CODE_REDACTIONS_ENV]: JSON.stringify(redactions),
      },
    },
  ).then(
    ({ stdout }) => finish(stdout),
    (error: { stdout: string }) => finish(error.stdout),
  );
}
const attachment = (test: ReportedTest | undefined, name: string) =>
  test?.attachments.find((entry) => entry.name === name);
const SHOWN_SECRET = "canary-session-value";
const pageSpec = (text: string) =>
  `import { test, expect } from '@playwright/test';\n` +
  `const markup = ${JSON.stringify(
    `<form><input type="password" value="typed-password"></form><p style="font: 16px monospace">${text}</p><a href="/next" data-token="attr-token">next</a><script>window.leak = 'script-body'</script>`,
  )};\n` +
  `test('fails on its page', async ({ page }) => { await page.setContent(markup); expect(1).toBe(2); });\n` +
  `test('passes on its page', async ({ page }) => { await page.setContent(markup); });\n` +
  `test('fails after closing its page', async ({ page }) => { await page.setContent(markup); await page.close(); expect(1).toBe(2); });\n` +
  `test('fails without a page', async () => { expect(1).toBe(2); });\n`;

it("attaches a masked screenshot and a redacted DOM of the page of a failed test, and nothing for a test that passed or had no open page", async () => {
  const tests = await reportedTests(pageSpec(SHOWN_SECRET), [SHOWN_SECRET]);
  const byTitle = (title: string) => tests.find((entry) => entry.title === title);
  const failed = byTitle("fails on its page");
  // The failure is the test's own: capturing the page changed neither status.
  expect(tests.map((entry) => entry.status)).toEqual(["failed", "passed", "failed", "failed"]);
  const shot = attachment(failed, "testmaster-failure-screenshot");
  expect(shot).toMatchObject({ contentType: "image/png" });
  expect(shot?.path).toBeUndefined();
  expect(Buffer.from(shot?.body ?? "", "base64").subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  const markup = attachment(failed, "testmaster-failure-dom");
  expect(markup).toMatchObject({ contentType: "text/html" });
  const html = Buffer.from(markup?.body ?? "", "base64").toString("utf8");
  expect(html).toContain('href="/next"');
  for (const leaked of [SHOWN_SECRET, "typed-password", "attr-token", "script-body"])
    expect(html).not.toContain(leaked);
  for (const quiet of [
    "passes on its page",
    "fails after closing its page",
    "fails without a page",
  ])
    expect(
      byTitle(quiet)?.attachments.filter((entry) => entry.name.startsWith("testmaster-failure-")),
    ).toEqual([]);
}, 120_000);

it("blacks out text equal to a secret in the screenshot: same pixels as a page that shows another masked value", async () => {
  const decoy = "x".repeat(SHOWN_SECRET.length);
  const [withSecret] = await reportedTests(pageSpec(SHOWN_SECRET), [SHOWN_SECRET]);
  const [withDecoy] = await reportedTests(pageSpec(decoy), [decoy]);
  const secretShot = attachment(withSecret, "testmaster-failure-screenshot")?.body;
  expect(secretShot).toBeDefined();
  expect(secretShot).toBe(attachment(withDecoy, "testmaster-failure-screenshot")?.body);
  // Without the value in the redactions the text is drawn, so the pixels differ.
  const [unmasked] = await reportedTests(pageSpec(SHOWN_SECRET), []);
  expect(attachment(unmasked, "testmaster-failure-screenshot")?.body).not.toBe(secretShot);
}, 120_000);

const IGNORED_ORIGIN = "http://127.0.0.1:41001";
const UNAPPROVED_ORIGIN = "http://127.0.0.1:41002";
const egressEnv = {
  [CODE_EGRESS_ENV]: JSON.stringify({
    allowed: ["http://127.0.0.1:41000"],
    ignored: [IGNORED_ORIGIN],
  }),
};
const denialsOf = (test: ReportedTest | undefined) =>
  JSON.parse(
    Buffer.from(attachment(test, "testmaster-egress-denials")?.body ?? "W10=", "base64").toString(
      "utf8",
    ),
  );
const egressSpec = (markup: string, extra = "") =>
  `import { test } from '@playwright/test';\n` +
  `test('loads', async ({ page }) => { await page.setContent(${JSON.stringify(markup)}); await page.waitForLoadState('load'); ${extra} });\n`;

it("aborts and records a script of an ignored origin and a passive subresource of an unapproved one without failing the test", async () => {
  const [test] = await reportedTests(
    egressSpec(
      `<script src="${IGNORED_ORIGIN}/v3/app.js?token=url-canary"></script><img src="${UNAPPROVED_ORIGIN}/flag.png">`,
    ),
    [],
    egressEnv,
  );
  expect(test?.status).toBe("passed");
  expect(attachment(test, "testmaster-egress-denials")).toMatchObject({
    contentType: "application/json",
  });
  expect(denialsOf(test)).toEqual(
    expect.arrayContaining([
      {
        origin: IGNORED_ORIGIN,
        method: "GET",
        resourceType: "script",
        disposition: "ignored",
        count: 1,
      },
      {
        origin: UNAPPROVED_ORIGIN,
        method: "GET",
        resourceType: "image",
        disposition: "aborted",
        count: 1,
      },
    ]),
  );
  // Origin only: nothing of the path or query is attached.
  expect(JSON.stringify(denialsOf(test))).not.toContain("url-canary");
}, 120_000);

it("records a script of an unapproved origin as fatal, and attaches nothing when nothing was denied", async () => {
  const tests = await reportedTests(
    `import { test } from '@playwright/test';\n` +
      `test('blocked script', async ({ page }) => { await page.setContent(${JSON.stringify(`<script src="${UNAPPROVED_ORIGIN}/app.js"></script>`)}); await page.waitForLoadState('load'); });\n` +
      `test('quiet', async ({ page }) => { await page.setContent('<p>hello</p>'); });\n`,
    [],
    egressEnv,
  );
  expect(denialsOf(tests.find((entry) => entry.title === "blocked script"))).toEqual([
    {
      origin: UNAPPROVED_ORIGIN,
      method: "GET",
      resourceType: "script",
      disposition: "fatal",
      count: 1,
    },
  ]);
  expect(
    attachment(
      tests.find((entry) => entry.title === "quiet"),
      "testmaster-egress-denials",
    ),
  ).toBeUndefined();
}, 120_000);

it("installs no route hook without an egress policy, as in an exported project", async () => {
  const [test] = await reportedTests(
    egressSpec(`<script src="${IGNORED_ORIGIN}/v3/app.js"></script>`),
    [],
  );
  expect(test?.status).toBe("passed");
  expect(attachment(test, "testmaster-egress-denials")).toBeUndefined();
}, 120_000);
