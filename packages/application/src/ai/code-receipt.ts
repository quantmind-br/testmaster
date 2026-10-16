import type { DiscoveryDetail } from "./discovery.js";

/** Longest list the code-analysis receipt carries inline; the rest is counted, not sent. */
const CODE_RECEIPT_CAP = { skippedFiles: 50, warnings: 25, features: 100, diffFiles: 200 } as const;

/** The first `limit` entries and how many were left out. */
function capped<T>(items: readonly T[], limit: number) {
  return { shown: items.slice(0, limit), omitted: Math.max(0, items.length - limit) };
}

/**
 * The bounded answer to a code analysis, shared by MCP `testmaster_analyze_code` and
 * `testmaster discover`: counts, the first entries of each list and how many were left out. A
 * large repository produces megabytes of detail (every skipped file, every feature); the full
 * lists stay in the stored discovery and the project features resource.
 */
export function codeAnalysisReceipt(detail: DiscoveryDetail) {
  const { codeSnapshot, diff } = detail;
  const { skippedFiles: storedSkipped, ...snapshot } = codeSnapshot;
  const skipped = storedSkipped ?? detail.summary.skippedFiles;
  const byReason = new Map<string, number>();
  for (const file of skipped) byReason.set(file.reason, (byReason.get(file.reason) ?? 0) + 1);
  const skippedShown = capped(skipped, CODE_RECEIPT_CAP.skippedFiles);
  const warnings = capped(detail.summary.warnings, CODE_RECEIPT_CAP.warnings);
  const features = capped(
    detail.featureMap.features
      .map((feature) => ({ id: feature.id, stableKey: feature.stableKey }))
      .sort((left, right) =>
        left.stableKey < right.stableKey ? -1 : left.stableKey > right.stableKey ? 1 : 0,
      ),
    CODE_RECEIPT_CAP.features,
  );
  const changes = diff ? capped(diff.changes, CODE_RECEIPT_CAP.diffFiles) : undefined;
  const selected = diff ? capped(diff.impact.selectedFiles, CODE_RECEIPT_CAP.diffFiles) : undefined;
  const excluded = diff ? capped(diff.impact.excludedFiles, CODE_RECEIPT_CAP.diffFiles) : undefined;
  return {
    codeSnapshot: snapshot,
    scannedFileCount: detail.summary.scannedFiles.length,
    skippedFileCount: skipped.length,
    skippedByReason: [...byReason]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count || (left.reason < right.reason ? -1 : 1)),
    skippedFiles: skippedShown.shown,
    omittedSkippedFiles: skippedShown.omitted,
    warnings: warnings.shown,
    omittedWarnings: warnings.omitted,
    featureCount: detail.featureMap.features.length,
    features: features.shown,
    omittedFeatures: features.omitted,
    ...(diff && changes && selected && excluded
      ? {
          diff: {
            baseSha: diff.baseSha,
            headSha: diff.headSha,
            mergeBase: diff.mergeBase,
            includeWorkingTree: diff.includeWorkingTree,
            dirtyHash: diff.dirtyHash,
            changes: changes.shown,
            impact: {
              criticalSmoke: diff.impact.criticalSmoke,
              authTouched: diff.impact.authTouched,
              selectedFiles: selected.shown,
              excludedFiles: excluded.shown,
              gaps: diff.impact.gaps,
            },
            fingerprint: diff.fingerprint,
            omitted: {
              changes: changes.omitted,
              selectedFiles: selected.omitted,
              excludedFiles: excluded.omitted,
            },
          },
        }
      : {}),
  };
}
