import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PLAYWRIGHT_FIXTURES_EXPORTS,
  playwrightFixturesCommonjs,
  playwrightFixturesModule,
} from "@testmaster/domain";
import {
  FAILURE_ATTACHMENTS,
  FAILURE_WARNING_ATTACHMENT,
  FAILURE_WARNING_CHARS,
} from "./code-evidence.js";
import { pageMarkup, redactMarkup, screenshotPage } from "./page-evidence.js";

/** Carries the code's secret values (name to value) to the Playwright processes it runs in. */
export const CODE_SECRETS_ENV = "TESTMASTER_CODE_SECRETS";
/** Carries the auth profile session (`CodeProfile`) to the Playwright processes it runs in. */
export const CODE_PROFILE_ENV = "TESTMASTER_CODE_PROFILE";
/** Carries every value the runner scrubs from evidence (a JSON array) to the Playwright processes. */
export const CODE_REDACTIONS_ENV = "TESTMASTER_CODE_REDACTIONS";
/**
 * Where the shared fixtures module (`@testmaster/domain` `playwrightFixturesCommonjs`) gets its
 * values in the runner: only the names the host declared for this revision are readable through
 * `secrets`, so the importer's static rule and the runtime agree on what a test may read, and the
 * auth profile session is the one the host prepared for the code's `auth`. The fixtures call
 * `capturePageFailure` when a test that used a page fails: it attaches the page as the
 * declarative runner records it (`screenshotPage`, `pageMarkup` and `redactMarkup`, embedded as
 * source), masked and redacted against every value the runner scrubs, for the reporter to
 * forward. The screenshot has no time limit of its own (`timeout: 0`): the test's timeout and the
 * attempt's deadline bound it. A capture that fails attaches the reason instead and never throws.
 */
const hostValues = `const values = JSON.parse(process.env.${CODE_SECRETS_ENV} || "{}");
function secretValue(name) {
  if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(values, name))
    throw new Error("Secret " + JSON.stringify(String(name).slice(0, 100)) + " is not declared for this test");
  return values[name];
}
const profile = JSON.parse(process.env.${CODE_PROFILE_ENV} || "null");
function sessionFor(fixture) {
  if (!profile) throw new Error("The " + fixture + " fixture needs the environment's auth profile session, and this run has none");
  return profile;
}
${screenshotPage.toString()}
${pageMarkup.toString()}
${redactMarkup.toString()}
async function capturePageFailure(page, testInfo) {
  try {
    if (page.isClosed()) return;
    const redactions = JSON.parse(process.env.${CODE_REDACTIONS_ENV} || "[]");
    const png = await screenshotPage(page, redactions, 0);
    await testInfo.attach(${JSON.stringify(FAILURE_ATTACHMENTS.screenshot.name)}, { body: png, contentType: ${JSON.stringify(FAILURE_ATTACHMENTS.screenshot.mimeType)} });
    const documents = (await pageMarkup(page)).map((markup) => redactMarkup(markup, redactions));
    await testInfo.attach(${JSON.stringify(FAILURE_ATTACHMENTS.dom.name)}, { body: Buffer.from(documents.join("\\n")), contentType: ${JSON.stringify(FAILURE_ATTACHMENTS.dom.mimeType)} });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await testInfo.attach(${JSON.stringify(FAILURE_WARNING_ATTACHMENT)}, { body: Buffer.from(("Page evidence of the failed test is unavailable: " + reason).slice(0, ${FAILURE_WARNING_CHARS})), contentType: "text/plain" }).catch(() => undefined);
  }
}`;

/**
 * Builds the `node_modules` the staged code resolves: every entry of the runner's own
 * `node_modules` is linked, except `@playwright/test`, which is the shared fixtures module. The
 * source schemas the code was generated against (`schemas`, keyed by source revision id + pointer)
 * are written beside that module, where its `sourceSchemas` fixture reads them.
 */
export async function stageImportedModules(
  source: string,
  target: string,
  schemas: Record<string, unknown> = {},
): Promise<void> {
  const scope = join(source, "@playwright");
  const shim = join(target, "@playwright", "test");
  await mkdir(shim, { recursive: true });
  for (const entry of await readdir(source))
    if (entry !== "@playwright") await symlink(join(source, entry), join(target, entry));
  for (const entry of await readdir(scope))
    if (entry !== "test") await symlink(join(scope, entry), join(target, "@playwright", entry));
  await writeFile(join(shim, "schemas.json"), JSON.stringify(schemas));
  await writeFile(
    join(shim, "package.json"),
    JSON.stringify({
      name: "@playwright/test",
      version: "0.0.0",
      exports: PLAYWRIGHT_FIXTURES_EXPORTS,
    }),
  );
  const realModule = join(scope, "test");
  await writeFile(
    join(shim, "index.js"),
    playwrightFixturesCommonjs({ realModule, preamble: hostValues }),
  );
  await writeFile(
    join(shim, "index.mjs"),
    playwrightFixturesModule({
      realModule: pathToFileURL(join(realModule, "index.mjs")).href,
    }),
  );
}
