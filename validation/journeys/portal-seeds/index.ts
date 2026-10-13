import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SweepContext, SweepSeed } from "./types.js";

export interface MergedSeeds {
  readonly params: ReadonlyMap<string, (context: SweepContext) => Promise<string>>;
  readonly routes: ReadonlyMap<string, (context: SweepContext) => Promise<void>>;
  readonly allowUnseeded: ReadonlyMap<string, string>;
  readonly skipStateChecks: ReadonlyMap<string, string>;
  readonly journeySteps: ReadonlyMap<string, (context: SweepContext) => Promise<string>>;
  readonly files: readonly string[];
}

/** Loads every `portal-seeds/<area>.ts` (default export `SweepSeed`) and rejects duplicates. */
export async function loadSeeds(): Promise<MergedSeeds> {
  const directory = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(directory)
    .filter((name) => /^[a-z0-9-]+\.ts$/u.test(name) && !["index.ts", "types.ts"].includes(name))
    .sort();
  const params = new Map<string, (context: SweepContext) => Promise<string>>();
  const routes = new Map<string, (context: SweepContext) => Promise<void>>();
  const allowUnseeded = new Map<string, string>();
  const skipStateChecks = new Map<string, string>();
  const journeySteps = new Map<string, (context: SweepContext) => Promise<string>>();
  for (const file of files) {
    // Runtime-selected on purpose: slices add seed files without editing any shared module.
    const module = (await import(pathToFileURL(join(directory, file)).href)) as {
      default?: SweepSeed;
    };
    if (!module.default) throw new Error(`${file}: default export (SweepSeed) is missing`);
    const claim = <V>(target: Map<string, V>, key: string, value: V, what: string) => {
      if (target.has(key))
        throw new Error(`${file}: ${what} "${key}" is already claimed by another seed`);
      target.set(key, value);
    };
    for (const [key, value] of Object.entries(module.default.params ?? {}))
      claim(params, key, value, "route parameter");
    for (const [key, value] of Object.entries(module.default.routes ?? {}))
      claim(routes, key, value, "route seed");
    for (const [key, value] of Object.entries(module.default.allowUnseeded ?? {}))
      claim(allowUnseeded, key, value, "unseeded route");
    for (const [key, value] of Object.entries(module.default.skipStateChecks ?? {}))
      claim(skipStateChecks, key, value, "state-check exemption");
    for (const [key, value] of Object.entries(module.default.journeySteps ?? {}))
      if (value) claim(journeySteps, key, value, "journey step");
  }
  return { params, routes, allowUnseeded, skipStateChecks, journeySteps, files };
}
