import type { RunRecord, Verdict } from "./run-types";

/**
 * Batch matrix (UX-036). Rows are tests, columns are environments; a cell lists every Run of that
 * pair, including repetitions. A pair with no Run is shown as "not run" or "not dispatched" with its
 * reason, never as an empty cell that reads as passing, and the batch is only "complete" when every
 * requested member has a Run.
 */
export interface BatchReceiptLike {
  readonly batchId: string;
  readonly requested: number;
  readonly accepted: number;
  readonly notDispatched: readonly { readonly memberKey: string; readonly reasonCode: string }[];
  readonly allMembers: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
  readonly gate: string;
}
export interface MatrixCell {
  readonly column: string;
  readonly runs: readonly RunRecord[];
}
export interface MatrixRow {
  readonly testId: string;
  readonly cells: Readonly<Record<string, MatrixCell>>;
}
export interface MatrixNotDispatched {
  readonly memberKey: string;
  readonly reasonCode: string;
}
export interface BatchMatrix {
  readonly columns: readonly string[];
  readonly rows: readonly MatrixRow[];
  readonly notDispatched: readonly MatrixNotDispatched[];
  readonly completeness: "complete" | "incomplete";
  readonly missingRuns: number;
  readonly summary: Readonly<Record<Verdict | "inFlight", number>>;
  readonly headline: string;
}

export function environmentColumn(run: RunRecord): string {
  const cell = run.matrixCell;
  return cell?.environmentName ?? cell?.environmentId ?? run.environmentRevisionId;
}

export function buildMatrix(receipt: BatchReceiptLike, runs: readonly RunRecord[]): BatchMatrix {
  const columns = [...new Set(runs.map(environmentColumn))].sort();
  const byTest = new Map<string, Map<string, RunRecord[]>>();
  for (const run of runs) {
    const cells = byTest.get(run.testId) ?? new Map<string, RunRecord[]>();
    const column = environmentColumn(run);
    cells.set(column, [...(cells.get(column) ?? []), run]);
    byTest.set(run.testId, cells);
  }
  const rows = [...byTest.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([testId, cells]) => ({
      testId,
      cells: Object.fromEntries(
        [...cells.entries()].map(([column, list]) => [
          column,
          {
            column,
            runs: [...list].sort(
              (a, b) =>
                (a.matrixCell?.repetitionIndex ?? 0) - (b.matrixCell?.repetitionIndex ?? 0) ||
                a.createdAt.localeCompare(b.createdAt),
            ),
          },
        ]),
      ),
    }));
  const summary: Record<Verdict | "inFlight", number> = {
    passed: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    inconclusive: 0,
    inFlight: 0,
  };
  for (const run of runs) summary[run.outcome ?? "inFlight"] += 1;
  const missingRuns = Math.max(0, receipt.allMembers.length - runs.length);
  const complete = receipt.notDispatched.length === 0 && missingRuns === 0;
  const headline = complete
    ? `${runs.length} Runs, gate ${receipt.gate.replace("_", " ")}.`
    : `Incomplete: ${receipt.notDispatched.length} member(s) were not dispatched and ${missingRuns} Run(s) are not loaded. Gate ${receipt.gate.replace("_", " ")} describes only the Runs that exist.`;
  return {
    columns,
    rows,
    notDispatched: receipt.notDispatched,
    completeness: complete ? "complete" : "incomplete",
    missingRuns,
    summary,
    headline,
  };
}

/** Pairs a comparison's differences by the part of the Run they describe. */
export interface DifferenceGroup {
  readonly group: string;
  readonly items: readonly { field: string; left: unknown; right: unknown }[];
}
export function groupDifferences(
  differences: readonly { field: string; left: unknown; right: unknown }[],
): DifferenceGroup[] {
  const groups = new Map<string, { field: string; left: unknown; right: unknown }[]>();
  for (const difference of differences) {
    const group = difference.field.split(/[.[]/u)[0] || "other";
    groups.set(group, [...(groups.get(group) ?? []), difference]);
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }));
}

export const comparabilityText: Readonly<Record<string, string>> = {
  comparable: "Comparable: the two sides ran the same revision under the same conditions.",
  partially_comparable:
    "Partially comparable: some inputs differ. Read the differences before drawing a conclusion.",
  incomparable: "Not comparable: the sides differ in ways that make the verdicts unrelated.",
};
