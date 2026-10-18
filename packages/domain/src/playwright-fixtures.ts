import { xmlPathSource } from "@testmaster/contracts";
import { sourceSchemaValidatorSource } from "./source-schema-validator.js";

/**
 * `@playwright/test` as imported Playwright code sees it: the real module (same instance, so
 * Playwright's own bookkeeping holds) whose `test` also provides the `secrets`, `profileRequest`,
 * `profilePage` and `sourceSchemas` fixtures. The runner stages this module for imported code it
 * executes, and a code export ships the same source in a standalone project; only where the values
 * come from differs, which the caller supplies as a preamble. The stock `request` and `page` stay
 * unauthenticated: code that wants the auth profile session asks for it per test without ever
 * reading its values. `sourceSchemas.violations(sourceRevisionId, pointer, value)` checks a value
 * against a source schema frozen into the test (`schemas.json` beside this module) exactly as the
 * `jsonSchema` predicate of a plan does.
 * `xml.select(body, path)` evaluates the `xmlPath` of a plan's response check on an XML body text
 * with the runner's own evaluator and returns `{ count, text }` (text: the string value of the
 * first selected node, null when none); it throws when the body is not well-formed XML.
 */
export interface PlaywrightFixturesOptions {
  /** Module specifier of the real `@playwright/test`, resolved by the generated module itself. */
  realModule: string;
  /**
   * CommonJS statements placed before the shared part (they may `require`). They MUST define:
   * - `secretValue(name)`: the value of the secret `name`, or throw when it is not available;
   * - `sessionFor(fixture, baseURL)`: `{ storageState?, headers, origins }` of the auth profile
   *   session (`headers` keyed by lowercase name, `origins` the only origins it is sent to), or
   *   throw when there is none.
   * It MAY define `capturePageFailure(page, testInfo)`, which the `page` and `profilePage`
   * fixtures call once a test that used them has failed, while the page is still open. Without
   * it (an exported project run outside TestMaster) nothing is captured.
   * It MAY define `guardContext(context)`, an async function that installs the egress policy on a
   * browser context and returns `undefined` or an async `finish(testInfo)` for the end of the test.
   * The `context` fixture (so `page` too) and `profilePage` call it on the context they hand to the
   * test. Without it (an exported project) no policy is installed.
   */
  preamble: string;
}

/** `exports` of the package that holds the generated module: `index.js` (CJS) and `index.mjs` (ESM). */
export const PLAYWRIGHT_FIXTURES_EXPORTS = {
  ".": { import: "./index.mjs", require: "./index.js", default: "./index.js" },
};

/**
 * Header credentials go to the session's origins only, and never along a redirect; the profile's
 * storage state goes to a request context or a browser context.
 */
export function playwrightFixturesCommonjs(options: PlaywrightFixturesOptions): string {
  return `"use strict";
const base = require(${JSON.stringify(options.realModule)});
${options.preamble}
const afterPageFailure = typeof capturePageFailure === "function" ? capturePageFailure : undefined;
const guardBrowserContext = typeof guardContext === "function" ? guardContext : undefined;
async function capturePageOfFailedTest(page, testInfo) {
  if (!afterPageFailure || testInfo.status === testInfo.expectedStatus || testInfo.status === "skipped") return;
  try {
    await afterPageFailure(page, testInfo);
  } catch {
    // Evidence is a courtesy: it never changes what the test proved.
  }
}
const secrets = Object.freeze({
  get(name) {
    return secretValue(name);
  },
});
${sourceSchemaValidatorSource()}
${xmlPathSource()}
const xml = Object.freeze({
  select(body, path) {
    return selectXmlPath(String(body), path);
  },
});
const VERBS = ["get", "post", "put", "patch", "delete", "head", "fetch"];
function withProfileHeaders(context, session, baseURL) {
  if (Object.keys(session.headers).length === 0) return context;
  const send = (verb) => async (target, options = {}) => {
    if (typeof target !== "string") throw new Error("A profile request takes a URL string");
    if (!session.origins.includes(new URL(target, baseURL).origin))
      throw new Error("The auth profile session is only sent to the environment's origins");
    for (const name of Object.keys(options.headers || {}))
      if (Object.prototype.hasOwnProperty.call(session.headers, name.toLowerCase()))
        throw new Error("A request header conflicts with the auth profile credential");
    return context[verb](target, { ...options, headers: { ...options.headers, ...session.headers }, maxRedirects: 0 });
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
  // Only the runner's preamble installs the egress policy; an exported project keeps the stock context.
  ...(guardBrowserContext
    ? {
        context: async ({ context }, use, testInfo) => {
          const finishGuard = await guardBrowserContext(context);
          await use(context);
          if (finishGuard) await finishGuard(testInfo);
        },
      }
    : {}),
  // Only the runner's preamble captures failures; an exported project keeps the stock page.
  ...(afterPageFailure
    ? {
        page: async ({ page }, use, testInfo) => {
          await use(page);
          await capturePageOfFailedTest(page, testInfo);
        },
      }
    : {}),
  profileRequest: async ({ playwright, baseURL }, use) => {
    const session = sessionFor("profileRequest", baseURL);
    const context = await playwright.request.newContext(session.storageState ? { storageState: session.storageState } : {});
    await use(withProfileHeaders(context, session, baseURL));
    await context.dispose();
  },
  profilePage: async ({ browser, baseURL }, use, testInfo) => {
    const session = sessionFor("profilePage", baseURL);
    if (!session.storageState) throw new Error("The profilePage fixture needs a browser session, and this auth profile only has header credentials");
    const context = await browser.newContext({ storageState: session.storageState });
    const finishGuard = guardBrowserContext ? await guardBrowserContext(context) : undefined;
    const page = await context.newPage();
    await use(page);
    await capturePageOfFailedTest(page, testInfo);
    if (finishGuard) await finishGuard(testInfo);
    await context.close();
  },
  sourceSchemas: async ({}, use) => {
    await use(sourceSchemas);
  },
  xml: async ({}, use) => {
    await use(xml);
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
 * The ES module face of the same module, for code that Playwright loads as ESM (a package with
 * `"type": "module"`). Named exports cannot be detected on the CommonJS module, so they come from the
 * real module's own ESM entry (`realModule`), with `test` and the default replaced.
 */
export function playwrightFixturesModule(options: { realModule: string }): string {
  return `import extended from "./index.js";
export * from ${JSON.stringify(options.realModule)};
export const test = extended;
export default extended;
`;
}
