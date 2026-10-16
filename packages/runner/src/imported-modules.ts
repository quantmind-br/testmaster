import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Carries the code's secret values (name to value) to the Playwright processes it runs in. */
export const CODE_SECRETS_ENV = "TESTMASTER_CODE_SECRETS";
/** Carries the auth profile session (`CodeProfile`) to the Playwright processes it runs in. */
export const CODE_PROFILE_ENV = "TESTMASTER_CODE_PROFILE";

/**
 * `@playwright/test` as imported code sees it: the real module (same instance, so Playwright's
 * own bookkeeping holds) whose `test` also provides the `secrets` fixture. The fixture exposes
 * only the names the host declared for this revision, so the importer's static rule and the
 * runtime agree on what a test may read. The `profileRequest` and `profilePage` fixtures are the
 * environment's auth profile session made explicit: the stock `request` and `page` stay
 * unauthenticated, and the code that wants the session asks for it per test without ever
 * reading its values.
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
const profile = JSON.parse(process.env.${CODE_PROFILE_ENV} || "null");
function sessionFor(fixture) {
  if (!profile) throw new Error("The " + fixture + " fixture needs the environment's auth profile session, and this run has none");
  return profile;
}
const VERBS = ["get", "post", "put", "patch", "delete", "head", "fetch"];
// Header credentials go to the environment's origins only, and never along a redirect.
function withProfileHeaders(context, baseURL) {
  if (Object.keys(profile.headers).length === 0) return context;
  const send = (verb) => async (target, options = {}) => {
    if (typeof target !== "string") throw new Error("A profile request takes a URL string");
    if (!profile.origins.includes(new URL(target, baseURL).origin))
      throw new Error("The auth profile session is only sent to the environment's origins");
    for (const name of Object.keys(options.headers || {}))
      if (Object.prototype.hasOwnProperty.call(profile.headers, name.toLowerCase()))
        throw new Error("A request header conflicts with the auth profile credential");
    return context[verb](target, { ...options, headers: { ...options.headers, ...profile.headers }, maxRedirects: 0 });
  };
  return new Proxy(context, {
    get(target, property) {
      if (VERBS.includes(property)) return send(property);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
const extended = base.extend({
  secrets: async ({}, use) => {
    await use(secrets);
  },
  profileRequest: async ({ playwright, baseURL }, use) => {
    const session = sessionFor("profileRequest");
    const context = await playwright.request.newContext(session.storageState ? { storageState: session.storageState } : {});
    await use(withProfileHeaders(context, baseURL));
    await context.dispose();
  },
  profilePage: async ({ browser }, use) => {
    const session = sessionFor("profilePage");
    if (!session.storageState) throw new Error("The profilePage fixture needs a browser session, and this auth profile only has header credentials");
    const context = await browser.newContext({ storageState: session.storageState });
    await use(await context.newPage());
    await context.close();
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
