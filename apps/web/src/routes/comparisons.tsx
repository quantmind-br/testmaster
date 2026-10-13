import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError, api } from "../api";
import { MatrixTable } from "../components/batch-matrix";
import { ConfirmDialog } from "../components/confirm-dialog";
import { type Column, DataTable } from "../components/data-table";
import { ErrorSummary, type FieldIssue, FormField } from "../components/form";
import { useAnnounce } from "../components/live-region";
import { Icon, type Shape, StatusBadge } from "../components/status";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView, ViewState } from "../components/view-state";
import { usePageTitle } from "../hooks/use-page-title";
import { usePaged, useResource } from "../hooks/use-resource";
import { useUrlState } from "../hooks/use-url-state";
import { gateBadge, normalizeBatch, summarizeBatchCancel } from "../lib/batch-view";
import {
  asRunId,
  type ComparisonResult,
  type ComparisonRow,
  describeComparison,
  describeReason,
  displayValue,
  groupComparison,
} from "../lib/comparison-view";
import { buildMatrix } from "../lib/matrix";
import type { RunRecord } from "../lib/run-types";
import { stringField } from "../lib/url-state";
import { NotFoundPage } from "./not-found";
import type { PortalRoute } from "./types";

type Kind = "run" | "batch";

const kinds: Record<
  Kind,
  {
    title: string;
    path: string;
    leftKey: string;
    rightKey: string;
    leftLabel: string;
    rightLabel: string;
    idHint: string;
  }
> = {
  run: {
    title: "Compare Runs",
    path: "/run-comparisons",
    leftKey: "leftRunId",
    rightKey: "rightRunId",
    leftLabel: "Left Run ID",
    rightLabel: "Right Run ID",
    idHint: "Both Runs must have finished. Copy the IDs from the Run pages.",
  },
  batch: {
    title: "Compare batches",
    path: "/batch-comparisons",
    leftKey: "leftBatchId",
    rightKey: "rightBatchId",
    leftLabel: "Left batch ID",
    rightLabel: "Right batch ID",
    idHint: "Every member of both batches must have finished.",
  },
};

const compareFilters = {
  left: stringField("", 128),
  right: stringField("", 128),
};

const pageSize = 50;

interface ComparisonState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly result: ComparisonResult | null;
  readonly loaded: ComparisonResult["differences"];
  readonly loadingMore: boolean;
  readonly error: ApiError | null;
}

const idle: ComparisonState = {
  status: "idle",
  result: null,
  loaded: [],
  loadingMore: false,
  error: null,
};

function asError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError(0, "unknown", { code: "INTERNAL", message: String(error) });
}

interface ComparisonView extends ComparisonState {
  loadMore(): Promise<void>;
}

/** Loads page one for the two IDs, then follows `nextCursor` when the user asks for more. */
function useComparison(kind: Kind, left: string, right: string): ComparisonView {
  const spec = kinds[kind];
  const [state, setState] = useState<ComparisonState>(idle);
  const body = useMemo(
    () => (left && right ? { [spec.leftKey]: left, [spec.rightKey]: right } : null),
    [spec, left, right],
  );
  useEffect(() => {
    if (!body) {
      setState(idle);
      return;
    }
    const controller = new AbortController();
    setState({ ...idle, status: "loading" });
    api<ComparisonResult>("POST", spec.path, {
      body: { ...body, page: { limit: pageSize } },
      signal: controller.signal,
    })
      .then((response) => {
        setState({
          status: "ready",
          result: response.data,
          loaded: response.data.differences,
          loadingMore: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ ...idle, status: "error", error: asError(error) });
      });
    return () => controller.abort();
  }, [spec, body]);

  const loadMore = useCallback(async () => {
    const cursor = state.result?.nextCursor;
    if (!body || !cursor || state.loadingMore) return;
    setState((current) => ({ ...current, loadingMore: true }));
    try {
      const response = await api<ComparisonResult>("POST", spec.path, {
        body: { ...body, page: { limit: pageSize, cursor } },
      });
      setState((current) => ({
        status: "ready",
        result: response.data,
        loaded: [...current.loaded, ...response.data.differences],
        loadingMore: false,
        error: null,
      }));
    } catch (error) {
      setState((current) => ({ ...current, loadingMore: false, error: asError(error) }));
    }
  }, [body, spec, state.result, state.loadingMore]);

  return { ...state, loadMore };
}

function ValueCell({ field, value }: { field: string; value: unknown }): ReactNode {
  const shown = displayValue(field, value);
  const runId = asRunId(value);
  if (runId) return <Link to={`/runs/${encodeURIComponent(runId)}`}>{runId}</Link>;
  if (shown.absent) return <em>{shown.text}</em>;
  return <UntrustedText value={shown.text} maxLength={600} block={shown.text.includes("\n")} />;
}

const rowColumns: Column<ComparisonRow>[] = [
  {
    key: "field",
    header: "Field",
    render: (row) => <UntrustedText value={row.field} maxLength={200} />,
  },
  {
    key: "left",
    header: "Left",
    render: (row) => <ValueCell field={row.key} value={row.left} />,
  },
  {
    key: "right",
    header: "Right",
    render: (row) => <ValueCell field={row.key} value={row.right} />,
  },
];

const toneShape: Record<"success" | "warning" | "danger", Shape> = {
  success: "check",
  warning: "warn",
  danger: "stop",
};

function ComparisonResultView({ comparison }: { comparison: ComparisonView }): ReactNode {
  const { result, loaded } = comparison;
  if (!result) return null;
  const summary = describeComparison({ ...result, differences: loaded });
  const groups = groupComparison(loaded, { hideVerdicts: !summary.meaningful });
  const table = groups.map((group) => (
    <section key={group.id} aria-label={group.label}>
      <h3>{group.label}</h3>
      <DataTable
        caption={`Differences: ${group.label}`}
        columns={rowColumns}
        rows={group.rows}
        rowKey={(row) => row.field}
      />
    </section>
  ));
  return (
    <>
      <section aria-label="Comparability">
        <h2>Comparability</h2>
        <div
          className={`banner tone-${summary.tone}`}
          role="status"
          data-comparability={result.comparability}
        >
          <Icon shape={toneShape[summary.tone]} />
          <span>
            <strong>{summary.label}.</strong> {summary.explanation}
          </span>
        </div>
        {result.reasons.length > 0 ? (
          <>
            <h3>Why</h3>
            <ul>
              {result.reasons.map((reason) => (
                <li key={reason}>
                  <UntrustedText value={describeReason(reason)} maxLength={300} />
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <p className="hint">{summary.notice}</p>
      </section>
      <section aria-label="Differences">
        <h2>Differences</h2>
        {loaded.length === 0 ? (
          <p>
            {summary.meaningful
              ? "No differences were found in the compared fields."
              : "No field differences were reported, but the sides are still not comparable."}
          </p>
        ) : summary.meaningful ? (
          table
        ) : (
          <details>
            <summary>
              Show {loaded.length - summary.hiddenVerdictRows} difference(s) for diagnosis only
            </summary>
            {summary.hiddenVerdictRows > 0 ? (
              <p className="hint">
                {summary.hiddenVerdictRows} verdict difference(s) are not shown: the verdicts of
                sides that cannot be compared are unrelated.
              </p>
            ) : null}
            {table}
          </details>
        )}
        <div className="pager">
          <span>{loaded.length} difference(s) loaded</span>
          {result.nextCursor ? (
            <button
              type="button"
              className="button secondary"
              aria-busy={comparison.loadingMore}
              aria-disabled={comparison.loadingMore}
              onClick={() => void comparison.loadMore()}
            >
              {comparison.loadingMore ? "Loading…" : "Load more differences"}
            </button>
          ) : (
            <span>All differences loaded</span>
          )}
        </div>
        {comparison.error && comparison.status === "ready" ? (
          <ViewState kind="error" error={comparison.error} message={comparison.error.message} />
        ) : null}
      </section>
    </>
  );
}

function ComparePage({ kind }: { kind: Kind }): ReactNode {
  const spec = kinds[kind];
  usePageTitle(spec.title);
  const [url, setUrl] = useUrlState(compareFilters);
  const [left, setLeft] = useState(url.left);
  const [right, setRight] = useState(url.right);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [submitCount, setSubmitCount] = useState(0);
  const comparison = useComparison(kind, url.left, url.right);

  useEffect(() => {
    setLeft(url.left);
    setRight(url.right);
  }, [url.left, url.right]);

  function submit(event: FormEvent): void {
    event.preventDefault();
    const found: FieldIssue[] = [];
    if (left.trim() === "")
      found.push({
        fieldId: "compare-left",
        message: `Enter the ${spec.leftLabel.toLowerCase()}.`,
      });
    if (right.trim() === "")
      found.push({
        fieldId: "compare-right",
        message: `Enter the ${spec.rightLabel.toLowerCase()}.`,
      });
    if (found.length === 0 && left.trim() === right.trim())
      found.push({
        fieldId: "compare-right",
        message: "Choose two different IDs: a side compared with itself says nothing.",
      });
    setIssues(found);
    setSubmitCount((count) => count + 1);
    if (found.length === 0) setUrl({ left: left.trim(), right: right.trim() });
  }

  const issueFor = (fieldId: string) =>
    issues.find((issue) => issue.fieldId === fieldId)?.message ?? null;
  return (
    <>
      <h1>{spec.title}</h1>
      <p>
        {kind === "run" ? (
          <Link to="/compare/batches">Compare two batches instead</Link>
        ) : (
          <Link to="/compare">Compare two Runs instead</Link>
        )}
      </p>
      <form onSubmit={submit} noValidate aria-label={spec.title}>
        <ErrorSummary key={submitCount} issues={issues} />
        <FormField
          id="compare-left"
          label={spec.leftLabel}
          hint={spec.idHint}
          required
          error={issueFor("compare-left")}
        >
          {(control) => (
            <input
              {...control}
              name="left"
              autoComplete="off"
              value={left}
              onChange={(event) => setLeft(event.target.value)}
            />
          )}
        </FormField>
        <FormField
          id="compare-right"
          label={spec.rightLabel}
          required
          error={issueFor("compare-right")}
        >
          {(control) => (
            <input
              {...control}
              name="right"
              autoComplete="off"
              value={right}
              onChange={(event) => setRight(event.target.value)}
            />
          )}
        </FormField>
        <button type="submit" className="button">
          Compare
        </button>
      </form>
      {comparison.status === "loading" ? <ViewState kind="loading" /> : null}
      {comparison.status === "error" && comparison.error ? (
        comparison.error.hidesExistence ? (
          <ViewState
            kind="not-found"
            message="One of the IDs does not exist, or you do not have access to it."
          />
        ) : (
          <ViewState
            kind="error"
            error={comparison.error}
            message={comparison.error.message}
            onRetry={() => setUrl({ left: url.left, right: url.right })}
          />
        )
      ) : null}
      {comparison.status === "ready" ? <ComparisonResultView comparison={comparison} /> : null}
    </>
  );
}

interface NotDispatchedRow {
  readonly memberKey: string;
  readonly reasonCode: string;
}

const notDispatchedColumns: Column<NotDispatchedRow>[] = [
  { key: "member", header: "Member", render: (row) => <code>{row.memberKey}</code> },
  { key: "reason", header: "Reason code", render: (row) => <code>{row.reasonCode}</code> },
  {
    key: "effect",
    header: "Effect",
    render: () => "No Run exists for this member. It counts against the gate and is not a pass.",
  },
];

function BatchMatrixPage(): ReactNode {
  const { batchId = "" } = useParams();
  usePageTitle("Batch matrix");
  const announce = useAnnounce();
  const batch = useResource<unknown>(`/batches/${encodeURIComponent(batchId)}`);
  const view = useMemo(
    () => (batch.data === null ? null : normalizeBatch(batch.data, batchId)),
    [batch.data, batchId],
  );
  const runs = usePaged<RunRecord>("/runs", { batchId }, 100);
  const [confirming, setConfirming] = useState(false);
  const [cancelNote, setCancelNote] = useState<string | null>(null);

  // Load every page up to the member count, so the matrix is never built from the first page only.
  const memberCount = view?.allMembers.length ?? null;
  const { status, hasMore, loadingMore, items, loadMore } = runs;
  useEffect(() => {
    if (
      memberCount !== null &&
      status === "ready" &&
      hasMore &&
      !loadingMore &&
      items.length < memberCount
    )
      void loadMore();
  }, [memberCount, status, hasMore, loadingMore, items.length, loadMore]);

  const matrix = useMemo(() => (view ? buildMatrix(view, runs.items) : null), [view, runs.items]);
  const loadingRuns =
    runs.status === "loading" ||
    (memberCount !== null && runs.hasMore && runs.items.length < memberCount);
  const active = matrix ? matrix.summary.inFlight > 0 || (view?.counts.inFlight ?? 0) > 0 : false;

  async function cancelBatch(): Promise<void> {
    const response = await api<{
      members: { result: "requested" | "already_terminal" | "rejected" }[];
    }>("POST", `/batches/${encodeURIComponent(batchId)}/cancel`, { body: {} });
    const summary = summarizeBatchCancel(response.data.members);
    setCancelNote(summary.text);
    announce(summary.text);
    setConfirming(false);
    await Promise.all([batch.reload(), runs.reload()]);
  }

  if (batch.status === "not-found") return <NotFoundPage />;
  return (
    <>
      <h1>
        Batch <code>{batchId}</code>
      </h1>
      <StatusView status={batch.status} error={batch.error} onRetry={() => void batch.reload()}>
        {view && matrix ? (
          <>
            <section aria-label="Batch summary">
              <h2>Summary</h2>
              <div
                className={`banner tone-${matrix.completeness === "complete" ? "info" : "warning"}`}
                role="status"
                data-completeness={matrix.completeness}
              >
                <Icon shape={matrix.completeness === "complete" ? "info" : "warn"} />
                <span>
                  {loadingRuns ? "Loading the remaining Runs… " : ""}
                  {matrix.headline}
                </span>
              </div>
              <p>
                <StatusBadge
                  status={gateBadge(matrix, view.gate).status}
                  label={gateBadge(matrix, view.gate).label}
                />
              </p>
              <dl className="context">
                <div className="context-row">
                  <dt>Requested members</dt>
                  <dd>{view.requested}</dd>
                </div>
                <div className="context-row">
                  <dt>Dispatched</dt>
                  <dd>{view.accepted}</dd>
                </div>
                <div className="context-row">
                  <dt>Not dispatched</dt>
                  <dd>{view.notDispatched.length}</dd>
                </div>
                <div className="context-row">
                  <dt>Added by dependency expansion</dt>
                  <dd>{view.expandedCount}</dd>
                </div>
                <div className="context-row">
                  <dt>Runs loaded</dt>
                  <dd>
                    {runs.items.length} of {view.allMembers.length}
                  </dd>
                </div>
              </dl>
              <ul aria-label="Outcome counts" style={{ listStyle: "none", padding: 0 }}>
                {(["passed", "failed", "blocked", "cancelled", "inconclusive"] as const).map(
                  (verdict) => (
                    <li key={verdict}>
                      <StatusBadge status={verdict} /> {matrix.summary[verdict]}
                    </li>
                  ),
                )}
                <li>
                  <StatusBadge status="running" label="Still running" /> {matrix.summary.inFlight}
                </li>
              </ul>
              <div
                className="actions"
                style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}
              >
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void Promise.all([batch.reload(), runs.reload()])}
                >
                  Refresh
                </button>
                {active ? (
                  <button
                    type="button"
                    className="button danger"
                    onClick={() => setConfirming(true)}
                  >
                    Cancel batch
                  </button>
                ) : null}
                <Link
                  className="button secondary"
                  to={`/compare/batches?left=${encodeURIComponent(batchId)}`}
                >
                  Compare with another batch
                </Link>
              </div>
              {cancelNote ? <p role="status">{cancelNote}</p> : null}
            </section>
            <section aria-label="Matrix">
              <h2>Matrix</h2>
              <StatusView
                status={runs.status}
                error={runs.error}
                onRetry={() => void runs.reload()}
                empty={
                  <ViewState
                    kind="empty"
                    title="No Run was created"
                    message="This batch has no Runs. Members that were not dispatched are listed below."
                  />
                }
              >
                <MatrixTable matrix={matrix} />
              </StatusView>
            </section>
            <section aria-label="Members not dispatched">
              <h2>Members not dispatched</h2>
              {matrix.notDispatched.length === 0 ? (
                <p>Every requested member was dispatched.</p>
              ) : (
                <DataTable
                  caption="Members not dispatched"
                  columns={notDispatchedColumns}
                  rows={matrix.notDispatched}
                  rowKey={(row) => row.memberKey}
                />
              )}
            </section>
            <ConfirmDialog
              open={confirming}
              title="Cancel this batch?"
              description="Every Run in the batch that has not finished is asked to stop. Runs that already finished keep their verdicts."
              context={[
                { label: "Batch", value: batchId },
                { label: "Runs still running", value: String(matrix.summary.inFlight) },
              ]}
              confirmLabel="Cancel batch"
              cancelLabel="Keep running"
              destructive
              onConfirm={cancelBatch}
              onCancel={() => setConfirming(false)}
            />
          </>
        ) : null}
      </StatusView>
    </>
  );
}

export const routes: PortalRoute[] = [
  { path: "/compare", title: "Compare Runs", element: <ComparePage kind="run" /> },
  { path: "/compare/batches", title: "Compare batches", element: <ComparePage kind="batch" /> },
  { path: "/batches/:batchId", title: "Batch matrix", element: <BatchMatrixPage /> },
];
