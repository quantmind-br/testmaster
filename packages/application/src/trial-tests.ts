import type { EntityDocument } from "@testmaster/persistence";

/**
 * Marks the hidden test and revision that hold a proposal's plan for a plan trial:
 * `{batchId, proposalId}`. Such a test is archived from birth, has no active revision and is left
 * out of test listings, so it never enters selection, suites, coverage or the feature map; only a
 * trial admission runs it.
 */
export const TRIAL_EXTENSION = "testmaster:trial";

export interface TrialMarker {
  batchId: string;
  proposalId: string;
}

export function trialMarker(value: EntityDocument): TrialMarker | null {
  const marker = (value.extensions as Record<string, unknown> | undefined)?.[TRIAL_EXTENSION];
  if (!marker || typeof marker !== "object") return null;
  const { batchId, proposalId } = marker as Record<string, unknown>;
  return typeof batchId === "string" && typeof proposalId === "string"
    ? { batchId, proposalId }
    : null;
}

export function isTrialTest(test: EntityDocument): boolean {
  return trialMarker(test) !== null;
}
