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
])("refuses unsafe or empty TypeScript: %s", async (body) => {
  const prefix = "import { test, expect } from '@playwright/test';\n";
  const options = await source(prefix + body);
  await expect(importCode(options)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
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
