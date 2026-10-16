import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PLAYWRIGHT_FIXTURES_EXPORTS,
  playwrightFixturesCommonjs,
  playwrightFixturesModule,
} from "@testmaster/domain";

/** Carries the code's secret values (name to value) to the Playwright processes it runs in. */
export const CODE_SECRETS_ENV = "TESTMASTER_CODE_SECRETS";
/** Carries the auth profile session (`CodeProfile`) to the Playwright processes it runs in. */
export const CODE_PROFILE_ENV = "TESTMASTER_CODE_PROFILE";

/**
 * Where the shared fixtures module (`@testmaster/domain` `playwrightFixturesCommonjs`) gets its
 * values in the runner: only the names the host declared for this revision are readable through
 * `secrets`, so the importer's static rule and the runtime agree on what a test may read, and the
 * auth profile session is the one the host prepared for the code's `auth`.
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
