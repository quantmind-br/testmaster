import type { BatchMatrix, BatchReceiptLike } from "./matrix";
import type { RunRecord } from "./run-types";

/**
 * View helpers for the batch matrix (UX-036). `GET /batches/{id}` returns the stored BatchRun with
 * its live aggregate rather than the admission receipt, so the page normalises either shape into
 * the receipt the matrix library reads, and never invents a member that the server did not list.
 */
const unrecorded = "Not recorded";

interface RawAggregateMember {
  readonly runId?: string | null;
}
interface RawBatch {
  readonly id?: string;
  readonly batchId?: string;
  readonly requested?: number;
  readonly requestedCount?: number;
  readonly accepted?: number;
  readonly notDispatched?: readonly { memberKey: string; reasonCode: string }[];
  readonly rejectedMembers?: readonly { memberKey: string; reasonCode: string }[];
  readonly memberRuns?: readonly (string | { runId: string })[];
  readonly allMembers?: readonly (string | RawAggregateMember)[];
  readonly counts?: Readonly<Record<string, number>>;
  readonly gate?: string;
  readonly expanded?: unknown;
  readonly aggregate?: {
    readonly counts?: Readonly<Record<string, number>>;
    readonly gate?: string;
    readonly allMembers?: readonly (string | RawAggregateMember)[];
    readonly expanded?: { readonly count?: number };
  };
}

export interface BatchView extends BatchReceiptLike {
  /** Runs added by dependency expansion rather than requested directly. */
  readonly expandedCount: number;
}

const zeroCounts: Readonly<Record<string, number>> = {
  passed: 0,
  failed: 0,
  blocked: 0,
  cancelled: 0,
  inconclusive: 0,
  inFlight: 0,
};

function runIds(members: readonly (string | RawAggregateMember)[] | undefined): string[] {
  return (members ?? []).flatMap((member) => {
    const id = typeof member === "string" ? member : member.runId;
    return typeof id === "string" && id !== "" ? [id] : [];
  });
}

/** `allMembers` lists Run IDs only: a member that was never dispatched has no Run to count. */
export function normalizeBatch(raw: unknown, fallbackId: string): BatchView {
  const batch = (raw ?? {}) as RawBatch;
  const notDispatched = batch.notDispatched ?? batch.rejectedMembers ?? [];
  const members = runIds(batch.allMembers ?? batch.aggregate?.allMembers);
  const fromRuns = (batch.memberRuns ?? []).map((member) =>
    typeof member === "string" ? member : member.runId,
  );
  const allMembers = members.length > 0 ? members : fromRuns;
  const expandedCount =
    batch.aggregate?.expanded?.count ?? (Array.isArray(batch.expanded) ? batch.expanded.length : 0);
  return {
    batchId: batch.batchId ?? batch.id ?? fallbackId,
    requested: batch.requested ?? batch.requestedCount ?? allMembers.length + notDispatched.length,
    accepted: batch.accepted ?? allMembers.length - expandedCount,
    notDispatched,
    allMembers,
    counts: batch.counts ?? batch.aggregate?.counts ?? zeroCounts,
    gate: batch.gate ?? batch.aggregate?.gate ?? "pending",
    expandedCount,
  };
}

export interface GateBadge {
  readonly status: string;
  readonly label: string;
}

/**
 * An incomplete batch never reads as green: a `passed` gate over missing Runs is shown as
 * degraded with the reason, and every other gate keeps its own wording.
 */
export function gateBadge(matrix: Pick<BatchMatrix, "completeness">, gate: string): GateBadge {
  const words = gate.replace(/_/g, " ");
  if (matrix.completeness === "incomplete")
    return {
      status: gate === "failed" ? "failed" : "degraded",
      label:
        gate === "failed"
          ? "Gate failed (batch incomplete)"
          : `Gate ${words} is not final: the batch is incomplete`,
    };
  if (gate === "not_applicable") return { status: "paused", label: "Gate not applicable" };
  return { status: gate, label: `Gate ${words}` };
}

export interface RunContext {
  readonly environment: string;
  readonly browser: string;
  readonly browserVersion: string;
  readonly runnerImage: string;
  readonly viewport: string;
  readonly locale: string;
  readonly timezone: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" && value !== "" ? value : unrecorded;
}

/** Everything a cell needs to explain itself. A value the Run did not record says so. */
export function describeRunContext(run: RunRecord): RunContext {
  const cell = record(run.matrixCell);
  const snapshot = record(cell.admissionSnapshot);
  const runtime = record(snapshot.runtimeIdentity);
  const config = record(record(record(cell.effectiveConfig).config));
  const browser = record(config.browser);
  const environment = record(config.environment);
  const viewport = record(browser.viewport);
  const width = viewport.width;
  const height = viewport.height;
  const image = snapshot.runnerImageDigest ?? runtime.imageId;
  return {
    environment: text(cell.environmentName ?? cell.environmentId),
    browser: text(browser.name ?? runtime.browserName),
    browserVersion: text(runtime.browserVersion),
    runnerImage: text(image),
    viewport:
      typeof width === "number" && typeof height === "number" ? `${width}×${height}` : unrecorded,
    locale: text(environment.locale),
    timezone: text(environment.timezone),
  };
}

export function shortId(id: string): string {
  const separator = id.indexOf("_");
  const body = separator >= 0 ? id.slice(separator + 1) : id;
  return body.slice(0, 8);
}

export interface CancelSummary {
  readonly requested: number;
  readonly alreadyTerminal: number;
  readonly rejected: number;
  readonly text: string;
}

export function summarizeBatchCancel(
  members: readonly { readonly result: "requested" | "already_terminal" | "rejected" }[],
): CancelSummary {
  const count = (result: string) => members.filter((member) => member.result === result).length;
  const requested = count("requested");
  const alreadyTerminal = count("already_terminal");
  const rejected = count("rejected");
  return {
    requested,
    alreadyTerminal,
    rejected,
    text: `Cancellation requested for ${requested} Run(s); ${alreadyTerminal} had already finished and ${rejected} could not be cancelled.`,
  };
}
