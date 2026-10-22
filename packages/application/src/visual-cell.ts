import type { EffectiveConfig, ExecutablePlan, PlanStep } from "@testmaster/contracts";
import { visualMaskHash, visualMatrixDigest } from "@testmaster/domain";
import { allEntities, type ServiceContext } from "./context.js";
import type { AdmissionSnapshot } from "./provenance.js";
import { browserCellOf } from "./run-config.js";

/**
 * The visual matrix digest of a Run's cell (ADR-032), or null for a Run admitted without a pinned
 * runner image (the process executor): such a Run has no comparable cell, so no baseline applies.
 */
export function runVisualDigest(cell: Record<string, unknown>): string | null {
  const snapshot = cell.admissionSnapshot as AdmissionSnapshot | undefined;
  const effective = cell.effectiveConfig as EffectiveConfig | undefined;
  if (!snapshot?.runnerImageDigest || !effective) return null;
  const browser = browserCellOf(effective);
  return visualMatrixDigest({
    engine: browser.browser,
    viewport: browser.viewport,
    locale: effective.config.environment?.locale ?? "en-US",
    timezone: effective.config.environment?.timezone ?? "UTC",
    colorScheme: browser.colorScheme,
    reducedMotion: browser.reducedMotion,
    imageId: snapshot.runnerImageDigest,
  });
}

/** Every `visualMatches` assertion of a plan, frames included, by step id. */
export function visualSteps(
  plan: ExecutablePlan | null,
): Extract<PlanStep, { kind: "assertion" }>[] {
  const found: Extract<PlanStep, { kind: "assertion" }>[] = [];
  const visit = (steps: readonly PlanStep[]) => {
    for (const step of steps) {
      if (step.kind === "assertion" && step.expectation.predicate === "visualMatches")
        found.push(step);
      if (step.operation === "frame") visit(step.input.childSteps);
    }
  };
  visit(plan?.steps ?? []);
  return found;
}

/** What a Run compares one visual step against, frozen at admission (ADR-032). */
export type FrozenVisualBaseline =
  | { state: "available"; baselineId: string; sha256: string }
  | { state: "missing" }
  | { state: "stale"; baselineId: string };

/**
 * The approved baseline of each visual step for this test and cell. A baseline approved for other
 * masks is stale: comparing it would hide or expose regions the reviewer never saw.
 */
export function resolveVisualBaselines(
  ctx: ServiceContext,
  testId: string,
  plan: ExecutablePlan | null,
  digest: string | null,
): Record<string, FrozenVisualBaseline> {
  const steps = visualSteps(plan);
  if (!steps.length) return {};
  const approved = digest
    ? allEntities(ctx, "VisualBaseline").filter(
        (baseline) =>
          baseline.testId === testId &&
          baseline.matrixDigest === digest &&
          baseline.status === "approved",
      )
    : [];
  const result: Record<string, FrozenVisualBaseline> = {};
  for (const step of steps) {
    const expectation = step.expectation;
    if (expectation.predicate !== "visualMatches") continue;
    const baseline = approved.find((item) => item.name === expectation.baseline);
    result[step.id] = !baseline
      ? { state: "missing" }
      : baseline.maskHash !== visualMaskHash(expectation.masks)
        ? { state: "stale", baselineId: baseline.id }
        : { state: "available", baselineId: baseline.id, sha256: String(baseline.sha256) };
  }
  return result;
}
