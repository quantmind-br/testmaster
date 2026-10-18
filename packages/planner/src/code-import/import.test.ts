import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { importCode } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true });
});
async function source(text: string, format: "playwright" | "pytest" = "playwright") {
  const root = await mkdtemp(join(tmpdir(), "tm-code-import-"));
  directories.push(root);
  const path = format === "pytest" ? "test_health.py" : "health.spec.ts";
  await writeFile(join(root, path), text);
  return { root, path, format };
}
const typescript = `import { test, expect } from '@playwright/test';\ntest('health', async ({ request }) => { const response = await request.get('/health'); expect(response.status()).toBe(200); });\n`;
const python = `import pytest\ndef test_health(tm_request):\n    response = tm_request.get('/health', timeout=3)\n    assert response.status_code == 200\n`;
it.each(["playwright", "pytest"] as const)(
  "imports valid %s code without executing its source",
  async (format) => {
    const options = await source(format === "pytest" ? python : typescript, format);
    const bundle = await importCode(options);
    expect(bundle.entrypoint).toBe(options.path);
    expect(bundle.files[options.path]).toBe(
      await readFile(join(options.root, options.path), "utf8"),
    );
    expect(bundle.tests).toEqual(format === "pytest" ? ["test_health"] : ["health"]);
    expect(bundle.limitations).not.toHaveLength(0);
  },
);
it("bundles checked relative helpers while preserving bytes", async () => {
  const options = await source(
    typescript
      .replace("expect(response.status())", "expect(status(response))")
      .replace("test('health'", "import { status } from './helpers.js';\ntest('health'"),
  );
  await writeFile(
    join(options.root, "helpers.ts"),
    "export const status = (response: {status(): number}) => response.status();\n",
  );
  const bundle = await importCode(options);
  expect(Object.keys(bundle.files).sort()).toEqual(["health.spec.ts", "helpers.ts"]);
});
it.each([
  "import { execSync } from 'node:child_process'; execSync('npm install evil');",
  "import os from 'node:os';",
  "eval('anything');",
  "await import('@playwright/test');",
  "test.setTimeout(0);",
  "test.use({ actionTimeout: 0 });",
  "const timeout=0; test.setTimeout(timeout);",
  "test('empty', async () => {});",
  "test('empty', async () => {expect(true).toBe(true);});",
  "test('empty', async () => {const a=true; expect(a).toBe(true);});",
  "test('empty', async ({page}) => {expect(page.url()).toBe(page.url());});",
  "this['require']('node:child_process');",
  "module['require']('node:child_process').execSync('id');",
  "const host = self; host['process'].exit(1);",
  "const sink = {} as Record<string, unknown>; sink[`eval`]('1');",
  "const make = async () => {}; make?.constructor('return 1')();",
])("refuses unsafe or empty TypeScript: %s", async (body) => {
  const prefix = "import { test, expect } from '@playwright/test';\n";
  const options = await source(prefix + body);
  await expect(importCode(options)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});
const execPrefix = "import { test, expect } from '@playwright/test';\n";
const execTest = (before: string, observation: string) =>
  `${execPrefix}${before}\ntest('url', async ({ page }) => { await page.goto('/'); ${observation} });\n`;
it.each([
  [
    "a const bound to new RegExp",
    'const destination = new RegExp("^/$", "u");',
    "expect(destination.exec(page.url())).not.toBeNull();",
  ],
  [
    "a const bound to RegExp()",
    'const destination = RegExp("^/$", "u");',
    "expect(destination.exec(page.url())).not.toBeNull();",
  ],
  [
    "a typed const bound to a regex literal",
    "const destination: RegExp = /^\\/$/u;",
    "expect(destination.exec(page.url())).not.toBeNull();",
  ],
  ["a regex literal", "", "expect(/^\\/$/u.exec(page.url())).not.toBeNull();"],
  ["new RegExp(...)", "", "expect(new RegExp('^/$', 'u').exec(page.url())).not.toBeNull();"],
  [
    "a string key on a const regex",
    "const destination = /^\\/$/u;",
    "expect(destination['exec'](page.url())).not.toBeNull();",
  ],
])("accepts .exec() on a provable RegExp: %s", async (_label, before, observation) => {
  const bundle = await importCode(await source(execTest(before, observation)));
  expect(bundle.tests).toEqual(["url"]);
});
it.each([
  ["a child process handle", "const cp = make();", "cp.exec('id');"],
  ["an unknown receiver", "", "const child = page; child.exec('id');"],
  ["a let bound to a regex", "let re = /x/u;", "expect(re.exec(page.url())).not.toBeNull();"],
  [
    "a const bound to a call that is not RegExp",
    "const re = make();",
    "expect(re.exec(page.url())).not.toBeNull();",
  ],
  [
    "a const regex shadowed by a parameter",
    "const re = /x/u; const run = (re: { exec(text: string): void }) => re.exec('id');",
    "run(page);",
  ],
  [
    "a const regex redeclared in an inner scope",
    "const re = /x/u;",
    "{ const re = make(); re.exec('id'); }",
  ],
  [
    "a RegExp that is rebound",
    "const RegExp = make();",
    "expect(new RegExp('x').exec('y')).toBe(1);",
  ],
  ["a call receiver", "", "expect(make().exec('x')).toBe(1);"],
  ["an optional call", "const child = make();", "child?.exec('id');"],
  ["a member receiver", "", "page.child.exec('id');"],
  ["execSync", "const re = /x/u;", "foo.execSync('id');"],
  ["spawn", "", "x.spawn('id');"],
  ["spawnSync", "", "x.spawnSync('id');"],
  ["system", "", "x.system('id');"],
  ["install", "", "x.install('pkg');"],
  ["execSync on a RegExp", "const re = /x/u;", "re.execSync('id');"],
  ["a string key", "const child = make();", "child['exec']('id');"],
])("still refuses shell calls: %s", async (_label, before, observation) => {
  const body = `${before}\ntest('url', async ({ page }) => { await page.goto('/'); expect(page.url()).toContain('/'); ${observation} });\n`;
  await expect(importCode(await source(execPrefix + body))).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    message: expect.stringContaining("Runtime installs and shell calls are forbidden"),
  });
});
it("reports the line of a refused shell call", async () => {
  const error = await importCode(
    await source(execTest("const child = make();", "child.exec('id');")),
  ).catch((reason: unknown) => reason);
  expect(error).toMatchObject({
    message: "Runtime installs and shell calls are forbidden at line 3",
  });
});
it("names the forbidden identifier and the line, never the code around it", async () => {
  const prefix = "import { test, expect } from '@playwright/test';\n";
  const refusal = async (body: string) =>
    importCode(await source(prefix + body)).catch((error: unknown) => error);
  expect(await refusal("const base = process.env.BASE_URL;")).toMatchObject({
    code: "INVALID_ARGUMENT",
    message: 'Runtime code, shell and host access are forbidden: "process" at line 2',
  });
  // The same names are refused as string keys, where no Identifier node names them.
  expect(await refusal("\n\nthis['require']('node:fs');")).toMatchObject({
    message: 'Runtime code, shell and host access are forbidden: "require" at line 4',
  });
  expect(await refusal("const host = self; host[`process`].exit(1);")).toMatchObject({
    message: 'Runtime code, shell and host access are forbidden: "process" at line 2',
  });
  const error = await refusal("const secret = process.env.CANARY_VALUE;");
  expect(String((error as Error).message)).not.toContain("CANARY_VALUE");
});
it("keeps accepting property reads and string keys that name no host access", async () => {
  const options = await source(
    "import { test, expect } from '@playwright/test';\ntest('health', async ({ request }) => { const response = await request.get('/health'); expect(response.statusText()).toBe('OK'); expect(response.headers()['content-type']).toContain('json'); });\n",
  );
  const bundle = await importCode(options);
  expect(bundle.tests).toEqual(["health"]);
  expect(bundle.files["health.spec.ts"]).toContain("statusText");
});
it.each([
  "import subprocess\ndef test_bad():\n    subprocess.run(['pip','install','evil'])\n    assert True\n",
  "import os\ndef test_bad():\n    assert os.name == 'posix'\n",
  "def test_bad():\n    eval('1')\n    assert True\n",
  "def test_bad(tm_request):\n    tm_request.get('/health', timeout=None)\n    assert tm_request is not None\n",
  "def test_bad(tm_request):\n    tm_request.get('/health', timeout=0)\n    assert tm_request is not None\n",
  "def test_bad():\n    assert 1 == 1\n",
  "def test_bad(tm_request):\n    assert tm_request == tm_request\n",
  "def test_bad():\n    pass\n",
])("refuses unsafe or empty Python: %s", async (text) => {
  await expect(importCode(await source(text, "pytest"))).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});
it("does not execute Python module-level payloads while parsing", async () => {
  const options = await source(`while True:\n    pass\n${python}`, "pytest");
  await expect(importCode(options)).resolves.toMatchObject({ tests: ["test_health"] });
});
it("refuses hardlinks, file symlinks, parent symlinks and traversal", async () => {
  const options = await source(typescript);
  await link(join(options.root, options.path), join(options.root, "hard.ts"));
  await expect(importCode(options)).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await symlink(join(options.root, options.path), join(options.root, "sym.ts"));
  await expect(importCode({ ...options, path: "sym.ts" })).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
  await mkdir(join(options.root, "inside"));
  await symlink(join(options.root, "inside"), join(options.root, "linked"));
  await writeFile(join(options.root, "inside", "test.ts"), typescript);
  await expect(importCode({ ...options, path: "linked/test.ts" })).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
  await expect(importCode({ ...options, path: "../test.ts" })).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
});
it("refuses invalid UTF-8, syntax and excessive bytes before parsing", async () => {
  const options = await source("import {");
  await expect(importCode(options)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await writeFile(join(options.root, options.path), Buffer.from([0xff, 0xfe]));
  await expect(importCode(options)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await writeFile(join(options.root, options.path), Buffer.alloc(1024 * 1024 + 1));
  await expect(importCode(options)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
});
const secretPrefix = "import { test, expect } from '@playwright/test';\n";
const secretTest = (body: string, fixture = "{ request, secrets }") =>
  `${secretPrefix}test('login', async (${fixture}) => { ${body} });\n`;
it("accepts secrets.get for declared names and records which ones the code reads", async () => {
  const options = await source(
    secretTest(
      "const key = secrets.get('API_KEY'); const response = await request.get('/me', { headers: { authorization: key } }); expect(response.status()).toBe(200); expect(secrets.get('API_KEY')).not.toBe(secrets.get(\"OTHER\"));",
    ),
  );
  const bundle = await importCode({ ...options, secrets: ["API_KEY", "OTHER", "UNUSED"] });
  expect(bundle.secrets).toEqual(["API_KEY", "OTHER"]);
});
it("reports no secrets for code that never reads one", async () => {
  const bundle = await importCode({
    ...(await source(typescript)),
    secrets: ["API_KEY"],
  });
  expect(bundle.secrets).toEqual([]);
});
it("records that code destructures a profile fixture and never marks code that only uses request and page", async () => {
  const signedIn = await importCode(
    await source(
      secretTest(
        "const response = await profileRequest.get('/me'); expect(response.status()).toBe(200);",
        "{ profileRequest }",
      ),
    ),
  );
  expect(signedIn.profile).toBe(true);
  const browser = await importCode(
    await source(
      secretTest(
        "await profilePage.goto('/'); expect(profilePage.url()).toContain('/');",
        "{ profilePage: profilePage }",
      ),
    ),
  );
  expect(browser.profile).toBe(true);
  const anonymous = await importCode(
    await source(
      secretTest(
        "const response = await request.get('/me'); expect(response.status()).toBe(401);",
        "{ request }",
      ),
    ),
  );
  expect(anonymous).not.toHaveProperty("profile");
});
it("refuses a secret the project did not declare for the test, without echoing the value", async () => {
  const options = await source(
    secretTest("expect(secrets.get('MISSING')).toBe('x'); expect(1).toBe(1);"),
  );
  await expect(importCode({ ...options, secrets: ["API_KEY"] })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    message: 'Secret "MISSING" is not declared for this test at line 2',
  });
  await expect(importCode(options)).rejects.toMatchObject({
    message: 'Secret "MISSING" is not declared for this test at line 2',
  });
});
it.each([
  "const name = 'API_KEY'; expect(secrets.get(name)).toBe('x');",
  "expect(secrets.get(`API_${'KEY'}`)).toBe('x');",
  "expect(secrets.get()).toBe('x');",
  "expect(secrets.get('API_KEY', 'x')).toBe('x');",
  "const read = secrets.get; expect(read('API_KEY')).toBe('x');",
  "const { get } = secrets; expect(get('API_KEY')).toBe('x');",
  "expect(secrets['get']('API_KEY')).toBe('x');",
  "const alias = secrets; expect(alias.get('API_KEY')).toBe('x');",
  "expect(Object.keys(secrets)).toEqual([]);",
])("refuses secret access other than a literal secrets.get call: %s", async (body) => {
  const options = await source(secretTest(body));
  await expect(importCode({ ...options, secrets: ["API_KEY"] })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});
it("refuses a renamed secrets fixture and environment access even when a secret is declared", async () => {
  const renamed = await source(
    secretTest("expect(vault.get('API_KEY')).toBe('x');", "{ secrets: vault }"),
  );
  await expect(importCode({ ...renamed, secrets: ["API_KEY"] })).rejects.toMatchObject({
    message: 'The "secrets" fixture cannot be renamed at line 2',
  });
  const environment = await source(
    secretTest("expect(process.env.API_KEY).toBe(secrets.get('API_KEY'));"),
  );
  await expect(importCode({ ...environment, secrets: ["API_KEY"] })).rejects.toMatchObject({
    message: 'Runtime code, shell and host access are forbidden: "process" at line 2',
  });
});
const schemaRevision = "svr_00000000-0000-4000-8000-000000000001";
const schemaPointer = "/paths/~1items/get/responses/200/content/application~1json/schema";
const offeredSchemas = {
  [`${schemaRevision}${schemaPointer}`]: { type: "object" },
  [`${schemaRevision}/components/schemas/Unused`]: { type: "string" },
};
const schemaTest = (body: string) => secretTest(body, "{ request, sourceSchemas }");
it("accepts sourceSchemas.violations for an offered schema and freezes only the schemas the code checks", async () => {
  const options = await source(
    schemaTest(
      `const body = await (await request.get('/items')).json(); expect(sourceSchemas.violations('${schemaRevision}', '${schemaPointer}', body)).toEqual([]);`,
    ),
  );
  const bundle = await importCode({ ...options, schemas: offeredSchemas });
  expect(bundle.schemas).toEqual({
    [`${schemaRevision}${schemaPointer}`]: offeredSchemas[`${schemaRevision}${schemaPointer}`],
  });
  expect(
    await importCode({ ...(await source(typescript)), schemas: offeredSchemas }),
  ).not.toHaveProperty("schemas");
});
it("refuses a schema the test was not offered, including every code that has no schemas at all", async () => {
  const options = await source(
    schemaTest(
      `expect(sourceSchemas.violations('${schemaRevision}', '/paths/other', {})).toEqual([]);`,
    ),
  );
  await expect(importCode({ ...options, schemas: offeredSchemas })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    message: `Source schema "${schemaRevision}/paths/other" is not available to this test (code checks only the schemas its test's plan cites in jsonSchema assertions) at line 2`,
  });
  await expect(importCode(options)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});
it.each([
  "const pointer = '/p'; expect(sourceSchemas.violations('svr_x', pointer, {})).toEqual([]);",
  "expect(sourceSchemas.violations(`svr_${'x'}`, '/p', {})).toEqual([]);",
  "expect(sourceSchemas.violations('svr_x', '/p')).toEqual([]);",
  "const check = sourceSchemas.violations; expect(check('svr_x', '/p', {})).toEqual([]);",
  "expect(sourceSchemas['violations']('svr_x', '/p', {})).toEqual([]);",
  "const alias = sourceSchemas; expect(alias.violations('svr_x', '/p', {})).toEqual([]);",
  "expect(Object.keys(sourceSchemas)).toEqual([]);",
])("refuses source-schema access other than a literal violations call: %s", async (body) => {
  const options = await source(schemaTest(body));
  await expect(
    importCode({ ...options, schemas: { "svr_x/p": { type: "object" } } }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});
