import { type Feature, validate } from "@testmaster/contracts";
export interface StaticFeatureMap {
  projectId: string;
  version: number;
  features: Feature[];
  sourceRevisionIds: string[];
  status: "ready" | "partial" | "needs_input";
}
/** Source/AST facts are desired/implemented, never live-observed coverage. */
export function buildStaticFeatureMap(
  projectId: string,
  sourceRevisionIds: string[],
  features: Feature[],
  needsInput: boolean,
): StaticFeatureMap {
  const keys = new Set<string>();
  const unique = features.filter((feature) => {
    if (keys.has(feature.stableKey)) return false;
    keys.add(feature.stableKey);
    return true;
  });
  return validate<StaticFeatureMap>("FeatureMap", {
    projectId,
    version: 1,
    features: unique,
    sourceRevisionIds: [...new Set(sourceRevisionIds)].sort(),
    status: needsInput || !unique.length ? "needs_input" : "partial",
  });
}
