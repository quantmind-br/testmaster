import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Carries the code's secret values (name to value) to the Playwright processes it runs in. */
export const CODE_SECRETS_ENV = "TESTMASTER_CODE_SECRETS";

/**
 * `@playwright/test` as imported code sees it: the real module (same instance, so Playwright's
 * own bookkeeping holds) whose `test` also provides the `secrets` fixture. The fixture exposes
 * only the names the host declared for this revision, so the importer's static rule and the
 * runtime agree on what a test may read.
 */
function secretsShim(realModule: string): string {
  return `"use strict";
const base = require(${JSON.stringify(realModule)});
const values = JSON.parse(process.env.${CODE_SECRETS_ENV} || "{}");
const secrets = Object.freeze({
  get(name) {
    if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(values, name))
      throw new Error("Secret " + JSON.stringify(String(name).slice(0, 100)) + " is not declared for this test");
    return values[name];
  },
});
const extended = base.extend({
  secrets: async ({}, use) => {
    await use(secrets);
  },
});
for (const key of Reflect.ownKeys(base)) {
  if (key === "test" || Object.prototype.hasOwnProperty.call(extended, key)) continue;
  Object.defineProperty(extended, key, Object.getOwnPropertyDescriptor(base, key));
}
extended.test = extended;
module.exports = extended;
`;
}

/**
 * The ES module face of the shim, for code that Playwright loads as ESM (a package with
 * `"type": "module"`, such as an exported project). Named exports cannot be detected on the CommonJS
 * shim, so they come from the real module's own ESM entry, with `test` and the default replaced.
 */
function secretsShimModule(realModule: string): string {
  return `import extended from "./index.js";
export * from ${JSON.stringify(pathToFileURL(join(realModule, "index.mjs")).href)};
export const test = extended;
export default extended;
`;
}

/**
 * Builds the `node_modules` the staged code resolves: every entry of the runner's own
 * `node_modules` is linked, except `@playwright/test`, which is the shim above.
 */
export async function stageImportedModules(source: string, target: string): Promise<void> {
  const scope = join(source, "@playwright");
  const shim = join(target, "@playwright", "test");
  await mkdir(shim, { recursive: true });
  for (const entry of await readdir(source))
    if (entry !== "@playwright") await symlink(join(source, entry), join(target, entry));
  for (const entry of await readdir(scope))
    if (entry !== "test") await symlink(join(scope, entry), join(target, "@playwright", entry));
  await writeFile(
    join(shim, "package.json"),
    JSON.stringify({
      name: "@playwright/test",
      version: "0.0.0",
      exports: { ".": { import: "./index.mjs", require: "./index.js", default: "./index.js" } },
    }),
  );
  await writeFile(join(shim, "index.js"), secretsShim(join(scope, "test")));
  await writeFile(join(shim, "index.mjs"), secretsShimModule(join(scope, "test")));
}
