import type { RunResult } from "@testmaster/contracts";

export interface RunVerdict {
  reasonCode?: string;
  unavailableEvidence?: NonNullable<RunResult["unavailableEvidence"]>;
}

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/**
 * The reason a finished Run carries and, when its gate failed on evidence, the manifest entries
 * that were unavailable. One reading for the CLI, MCP and reports, so a run whose assertions
 * passed but whose gate failed never presents as a bare pass.
 */
export function runVerdict(
  run: { outcome?: unknown },
  events: readonly Record<string, unknown>[],
): RunVerdict {
  const reduced = asObject(events.findLast((event) => event.type === "run.reduced")?.payload);
  // A Run refused at admission is never reduced; its completion event carries the reason.
  const completed = asObject(events.findLast((event) => event.type === "run.completed")?.payload);
  const reasonCode =
    reduced.reasonCode ?? (run.outcome === "blocked" ? completed.reasonCode : undefined);
  return {
    ...(typeof reasonCode === "string" ? { reasonCode } : {}),
    ...(Array.isArray(reduced.unavailableEvidence) && reduced.unavailableEvidence.length
      ? { unavailableEvidence: reduced.unavailableEvidence as RunVerdict["unavailableEvidence"] }
      : {}),
  } as RunVerdict;
}
