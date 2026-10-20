import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Directory that test runs write result JSON into.
 * TESTMASTER_RESULTS_DIR (empty string = unset; relative = against the repository root;
 * absolute = as given) or <repository root>/validation/results/tmp.
 * Creates the directory (recursive) and returns its absolute path.
 */
export function resultsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const directory = resolve(repositoryRoot, env.TESTMASTER_RESULTS_DIR || "validation/results/tmp");
  mkdirSync(directory, { recursive: true });
  return directory;
}
