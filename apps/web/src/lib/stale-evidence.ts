import type { RunRecord } from "./run-types";

/**
 * Evidence freshness (UX-034). A passed Run keeps saying "passed at <revision>"; when the test,
 * the environment or the source moved on, the portal adds a stale marker instead of rewriting or
 * hiding the historical verdict. A dimension the portal could not load is "unknown", never "current".
 */
export interface CurrentContext {
  /** Active test revision, or `undefined` when the lookup failed. */
  readonly testRevisionId?: string | null;
  readonly environmentRevisionId?: string | null;
  /** Commit the viewer asked about, for example the head of a pull request. */
  readonly commitSha?: string | null;
}
export type FreshnessDimension = "test revision" | "environment revision" | "source commit";
export interface FreshnessFinding {
  readonly dimension: FreshnessDimension;
  readonly state: "current" | "stale" | "unknown";
  readonly recorded: string | null;
  readonly current: string | null;
}
export interface Freshness {
  readonly state: "current" | "stale" | "unknown";
  readonly findings: readonly FreshnessFinding[];
  readonly headline: string;
}

function compare(
  dimension: FreshnessDimension,
  recorded: string | null,
  current: string | null | undefined,
): FreshnessFinding {
  if (current === undefined || recorded === null)
    return { dimension, state: "unknown", recorded, current: current ?? null };
  return {
    dimension,
    state: recorded === current ? "current" : "stale",
    recorded,
    current,
  };
}

export function shortId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 14)}…` : value;
}

export function describeFreshness(
  run: Pick<RunRecord, "revisionId" | "environmentRevisionId" | "outcome" | "matrixCell">,
  current: CurrentContext,
): Freshness {
  const recordedCommit = run.matrixCell?.admissionSnapshot?.repository?.commitSha ?? null;
  const findings: FreshnessFinding[] = [
    compare("test revision", run.revisionId, current.testRevisionId),
    compare("environment revision", run.environmentRevisionId, current.environmentRevisionId),
  ];
  if (current.commitSha !== undefined)
    findings.push(compare("source commit", recordedCommit, current.commitSha));
  const stale = findings.filter((finding) => finding.state === "stale");
  const unknown = findings.filter((finding) => finding.state === "unknown");
  const verdict = run.outcome ?? "not finished";
  const recorded = `${verdict === "passed" ? "Passed" : verdict} at revision ${shortId(run.revisionId)}`;
  if (stale.length > 0) {
    const what = stale.map((finding) => finding.dimension).join(", ");
    return {
      state: "stale",
      findings,
      headline: `${recorded}. Stale: the ${what} changed since, so this result does not describe the current state.`,
    };
  }
  if (unknown.length > 0)
    return {
      state: "unknown",
      findings,
      headline: `${recorded}. Freshness could not be verified for the ${unknown
        .map((finding) => finding.dimension)
        .join(", ")}.`,
    };
  return { state: "current", findings, headline: `${recorded}. Matches the current state.` };
}
