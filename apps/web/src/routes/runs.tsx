import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { api } from "../api";
import { AnalysisPanel } from "../components/analysis-panel";
import {
  ArtifactSection,
  type ArtifactSelection,
  useAttemptBundles,
} from "../components/artifact-viewer";
import { ConfirmDialog } from "../components/confirm-dialog";
import { DataFlowPanel } from "../components/data-flow-panel";
import { type Column, DataTable, type SortState } from "../components/data-table";
import { FormField } from "../components/form";
import { useAnnounce } from "../components/live-region";
import { useSelectContext } from "../components/portal-context";
import {
  AttemptsTable,
  FreshnessPanel,
  RunFactsPanel,
  RunTimeline,
  StepsSection,
  useStepPrivacy,
} from "../components/run-facts";
import { Icon, StatusBadge } from "../components/status";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView, ViewState } from "../components/view-state";
import { useEventStream } from "../hooks/use-event-stream";
import { usePageTitle } from "../hooks/use-page-title";
import { usePaged, useResource } from "../hooks/use-resource";
import { useUrlState } from "../hooks/use-url-state";
import { selectArtifactViewer } from "../lib/artifact-view";
import {
  announcementFor,
  buildStepGroups,
  deriveRetryFacts,
  describeCancelControl,
  describeRunFacts,
  formatServerTime,
  humanizeCode,
  isTerminalEvent,
  sortAttempts,
  toRunEvent,
} from "../lib/run-facts";
import { applyEvent, applySnapshot, initialTimeline } from "../lib/run-timeline";
import type { AttemptRecord, CancelReceipt, RunRecord, StepRecord } from "../lib/run-types";
import { enumField, integerField, stringField } from "../lib/url-state";
import type { ProjectSummary } from "./home";
import type { PortalRoute } from "./types";

const outcomes = ["passed", "failed", "blocked", "cancelled", "inconclusive"] as const;
const phases = ["queued", "preparing", "running", "collecting", "analyzing"] as const;
const gates = ["pending", "passed", "failed", "not_applicable"] as const;

const filters = {
  testId: stringField("", 80),
  batchId: stringField("", 80),
  status: enumField(["", ...outcomes, ...phases], ""),
  mode: enumField(["", "replay", "agent"], ""),
  origin: stringField("", 80),
  gate: enumField(["", ...gates], ""),
  limit: integerField(50, 1, 100),
  sort: enumField(["", "created", "result", "phase", "gate"], ""),
  dir: enumField(["ascending", "descending"], "ascending"),
};

const pageSizes = [25, 50, 100];

function GateBadge({ gate }: { gate: RunRecord["gate"] }): ReactNode {
  if (gate === "not_applicable")
    return (
      <span className="badge tone-neutral">
        <Icon shape="info" />
        <span>Not applicable</span>
      </span>
    );
  return <StatusBadge status={gate} />;
}

const columns: Column<RunRecord>[] = [
  {
    key: "run",
    header: "Run",
    render: (run) => (
      <Link to={`/runs/${encodeURIComponent(run.id)}`}>
        <code>{run.id}</code>
      </Link>
    ),
  },
  {
    key: "result",
    header: "Result",
    sortValue: (run) => describeRunFacts(run, null).label,
    render: (run) => {
      const facts = describeRunFacts(run, null);
      return <StatusBadge status={facts.status} label={facts.label} />;
    },
  },
  {
    key: "phase",
    header: "Phase",
    sortValue: (run) => run.phase,
    render: (run) => humanizeCode(run.phase),
  },
  {
    key: "gate",
    header: "Gate",
    sortValue: (run) => run.gate,
    render: (run) => <GateBadge gate={run.gate} />,
  },
  { key: "mode", header: "Mode", render: (run) => run.mode },
  {
    key: "origin",
    header: "Origin",
    render: (run) => <UntrustedText value={run.origin} maxLength={80} />,
  },
  { key: "test", header: "Test", render: (run) => <code>{run.testId}</code> },
  {
    key: "created",
    header: "Created (server time)",
    sortValue: (run) => run.createdAt,
    render: (run) => formatServerTime(run.createdAt),
  },
];

function FilterForm(props: {
  values: {
    testId: string;
    batchId: string;
    status: string;
    mode: string;
    origin: string;
    gate: string;
    limit: number;
  };
  projectScoped: boolean;
  onApply: (next: Record<string, string | number>) => void;
}): ReactNode {
  const [draft, setDraft] = useState(props.values);
  // A shared link or Back navigation changes the URL; the form follows it.
  useEffect(() => setDraft(props.values), [props.values]);
  const set = (key: keyof typeof draft, value: string | number): void =>
    setDraft((current) => ({ ...current, [key]: value }));
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    props.onApply({ ...draft, limit: Number(draft.limit) });
  }
  return (
    <form className="filters" aria-label="Filter runs" onSubmit={submit}>
      <FormField label="Test ID">
        {(control) => (
          <input
            {...control}
            type="text"
            value={draft.testId}
            onChange={(e) => set("testId", e.target.value)}
          />
        )}
      </FormField>
      <FormField label="Batch ID">
        {(control) => (
          <input
            {...control}
            type="text"
            value={draft.batchId}
            onChange={(e) => set("batchId", e.target.value)}
          />
        )}
      </FormField>
      <FormField label="Outcome or phase">
        {(control) => (
          <select {...control} value={draft.status} onChange={(e) => set("status", e.target.value)}>
            <option value="">Any</option>
            {[...outcomes, ...phases].map((value) => (
              <option key={value} value={value}>
                {humanizeCode(value)}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField label="Mode" hint="Applied to the rows loaded so far.">
        {(control) => (
          <select {...control} value={draft.mode} onChange={(e) => set("mode", e.target.value)}>
            <option value="">Any</option>
            <option value="replay">replay</option>
            <option value="agent">agent</option>
          </select>
        )}
      </FormField>
      <FormField label="Origin" hint="Applied to the rows loaded so far.">
        {(control) => (
          <input
            {...control}
            type="text"
            value={draft.origin}
            onChange={(e) => set("origin", e.target.value)}
          />
        )}
      </FormField>
      <FormField label="Gate" hint="Applied to the rows loaded so far.">
        {(control) => (
          <select {...control} value={draft.gate} onChange={(e) => set("gate", e.target.value)}>
            <option value="">Any</option>
            {gates.map((value) => (
              <option key={value} value={value}>
                {humanizeCode(value)}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField label="Page size">
        {(control) => (
          <select
            {...control}
            value={draft.limit}
            onChange={(e) => set("limit", Number(e.target.value))}
          >
            {pageSizes.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <div className="actions-inline">
        <button type="submit" className="button">
          Apply filters
        </button>
        <button
          type="button"
          className="button secondary"
          onClick={() =>
            props.onApply({
              testId: "",
              batchId: "",
              status: "",
              mode: "",
              origin: "",
              gate: "",
              limit: 50,
            })
          }
        >
          Clear filters
        </button>
      </div>
      {props.projectScoped ? (
        <p className="truncated-note">Showing runs of this project only.</p>
      ) : null}
    </form>
  );
}

function RunHistory({ projectId }: { projectId?: string }): ReactNode {
  const [url, setUrl] = useUrlState(filters);
  const runs = usePaged<RunRecord>(
    "/runs",
    {
      projectId,
      testId: url.testId,
      batchId: url.batchId,
      status: url.status,
    },
    url.limit,
  );
  const rows = useMemo(
    () =>
      runs.items.filter(
        (run) =>
          (url.mode === "" || run.mode === url.mode) &&
          (url.gate === "" || run.gate === url.gate) &&
          (url.origin === "" || run.origin === url.origin),
      ),
    [runs.items, url.mode, url.gate, url.origin],
  );
  const sort: SortState | null = url.sort === "" ? null : { key: url.sort, direction: url.dir };
  const clientFiltered = url.mode !== "" || url.gate !== "" || url.origin !== "";
  const filterValues = useMemo(
    () => ({
      testId: url.testId,
      batchId: url.batchId,
      status: url.status,
      mode: url.mode,
      origin: url.origin,
      gate: url.gate,
      limit: url.limit,
    }),
    [url.testId, url.batchId, url.status, url.mode, url.origin, url.gate, url.limit],
  );
  return (
    <>
      <FilterForm
        values={filterValues}
        projectScoped={projectId !== undefined}
        onApply={(next) => setUrl(next as Partial<typeof url>)}
      />
      <StatusView
        status={runs.status}
        error={runs.error}
        onRetry={() => void runs.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No runs"
            message={
              url.testId || url.batchId || url.status || projectId
                ? "No run matches these filters."
                : "Runs appear here once a test has been run."
            }
          />
        }
      >
        {rows.length === 0 ? (
          <ViewState
            kind="empty"
            title="No loaded run matches"
            message={
              runs.hasMore
                ? "Load more rows: the mode, origin and gate filters apply to the rows loaded so far."
                : "No run matches these filters."
            }
            action={
              runs.hasMore ? (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void runs.loadMore()}
                >
                  Load more
                </button>
              ) : undefined
            }
          />
        ) : (
          <DataTable
            caption="Runs"
            columns={columns}
            rows={rows}
            rowKey={(run) => run.id}
            sort={sort}
            onSortChange={(next) =>
              setUrl(
                next ? { sort: next.key as typeof url.sort, dir: next.direction } : { sort: "" },
              )
            }
            pager={{
              hasMore: runs.hasMore,
              loading: runs.loadingMore,
              onLoadMore: () => void runs.loadMore(),
            }}
          />
        )}
        {clientFiltered && runs.hasMore ? (
          <p className="truncated-note">
            Mode, origin and gate filters apply to the {runs.items.length} rows loaded so far; more
            pages exist.
          </p>
        ) : null}
      </StatusView>
    </>
  );
}

function RunsPage(): ReactNode {
  usePageTitle("Runs");
  return (
    <>
      <h1>Runs</h1>
      <RunHistory />
    </>
  );
}

function ProjectRunsPage(): ReactNode {
  const { projectId = "" } = useParams();
  const project = useResource<ProjectSummary>(`/projects/${encodeURIComponent(projectId)}`);
  useSelectContext(project.data ? { id: project.data.id, name: project.data.name } : null);
  usePageTitle("Project runs");
  return (
    <>
      <h1>
        Runs
        {project.data ? (
          <>
            {" of "}
            <UntrustedText value={project.data.name} maxLength={120} />
          </>
        ) : null}
      </h1>
      <RunHistory projectId={projectId} />
    </>
  );
}

/** Streams that refresh the authoritative records: evidence, verdict and attempt changes. */
const refreshEvents: Readonly<Record<string, true>> = {
  "attempt.claimed": true,
  "step.finished": true,
  "cleanup.finished": true,
  "run.reduced": true,
  "run.completed": true,
  "run.cancel_requested": true,
};

function RunDetail({ runId }: { runId: string }): ReactNode {
  const id = encodeURIComponent(runId);
  const announce = useAnnounce();
  const run = useResource<RunRecord>(`/runs/${id}`);
  const steps = usePaged<StepRecord>(`/runs/${id}/steps`, undefined, 100);
  const attempts = usePaged<AttemptRecord>(`/runs/${id}/attempts`, undefined, 100);
  const [timeline, setTimeline] = useState(() => initialTimeline(runId));
  const [reconciled, setReconciled] = useState(false);
  const [receipt, setReceipt] = useState<CancelReceipt | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [selection, setSelection] = useState<ArtifactSelection | null>(null);
  const [streamStopped, setStreamStopped] = useState(false);
  const nonce = useRef(0);
  usePageTitle(`Run ${runId.slice(0, 14)}`);

  const refreshAll = async (): Promise<void> => {
    await Promise.all([run.reload(), steps.reload(), attempts.reload()]);
  };
  const refreshLatest = useRef(refreshAll);
  refreshLatest.current = refreshAll;
  const refreshTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  // Records fetched from the server fold into the live timeline; they never move it backwards.
  useEffect(() => {
    const record = run.data;
    if (!record) return;
    setTimeline((current) =>
      applySnapshot(current, { run: record, steps: steps.items, attempts: attempts.items }),
    );
    setReconciled(true);
  }, [run.data, steps.items, attempts.items]);

  const streamStatus = useEventStream(`/runs/${id}/events`, {
    enabled: !streamStopped,
    onEvent: (event) => {
      setTimeline((current) => applyEvent(current, toRunEvent(event)));
      if (refreshEvents[event.type] === true && refreshTimer.current === undefined)
        refreshTimer.current = window.setTimeout(() => {
          refreshTimer.current = undefined;
          void refreshLatest.current();
        }, 250);
    },
    snapshot: () => refreshLatest.current(),
    isTerminal: isTerminalEvent,
  });
  // A finished Run has nothing more to stream once its history has been replayed.
  useEffect(() => {
    if (
      run.data?.phase === "completed" &&
      (streamStatus === "reconnecting" || streamStatus === "closed")
    )
      setStreamStopped(true);
  }, [run.data?.phase, streamStatus]);

  const lastAnnouncement = useRef<string | null>(null);
  useEffect(() => {
    if (!reconciled) return;
    const message = announcementFor(timeline);
    if (lastAnnouncement.current === null) lastAnnouncement.current = message;
    else if (lastAnnouncement.current !== message) {
      lastAnnouncement.current = message;
      announce(message);
    }
  }, [reconciled, timeline, announce]);

  const privacy = useStepPrivacy(run.data?.testId ?? "", run.data?.revisionId ?? "");
  const sortedAttempts = useMemo(() => sortAttempts(attempts.items), [attempts.items]);
  const attemptIds = useMemo(() => sortedAttempts.map((attempt) => attempt.id), [sortedAttempts]);
  const bundles = useAttemptBundles(
    runId,
    attemptIds,
    `${run.data?.phase ?? ""}:${run.data?.outcome ?? ""}:${timeline.phase}`,
  );
  const stepGroups = useMemo(
    () => buildStepGroups(timeline, steps.items, attempts.items),
    [timeline, steps.items, attempts.items],
  );
  const retry = deriveRetryFacts(attempts.items, timeline.reduced);
  const cancel = describeCancelControl(run.data, timeline, receipt);
  const select = useCallback((next: Omit<ArtifactSelection, "nonce">): void => {
    nonce.current += 1;
    setSelection({ ...next, nonce: nonce.current });
  }, []);

  // `?artifact=<id>` opens that artifact's primary viewer once its bundle is known. The id is
  // only an identifier; the signed link is still minted on demand and never enters the URL.
  const [search] = useSearchParams();
  const deepLinked = search.get("artifact");
  const deepLinkHandled = useRef<string | null>(null);
  useEffect(() => {
    if (!deepLinked || deepLinkHandled.current === deepLinked) return;
    for (const [attemptId, bundle] of Object.entries(bundles)) {
      if (bundle.status !== "ready") continue;
      const entry = bundle.manifest.entries.find((item) => item.artifactId === deepLinked);
      if (!entry) continue;
      deepLinkHandled.current = deepLinked;
      const viewer = selectArtifactViewer(entry).viewers[0];
      if (viewer && viewer !== "restricted" && viewer !== "unavailable")
        select({ attemptId, artifactId: deepLinked, viewer, fromAddress: true });
      return;
    }
  }, [deepLinked, bundles, select]);

  async function requestCancel(): Promise<void> {
    const result = await api<CancelReceipt>("POST", `/runs/${id}/cancel`, { body: {} });
    setReceipt(result.data);
    setConfirming(false);
    announce(
      result.data.result === "requested"
        ? "Cancellation requested. The Run has not stopped yet."
        : result.data.result === "already_terminal"
          ? "The Run had already finished."
          : "The cancellation request was rejected.",
    );
    await refreshAll();
  }

  if (run.status === "not-found") return <ViewState kind="not-found" />;
  return (
    <StatusView status={run.status} error={run.error} onRetry={() => void run.reload()}>
      {run.data ? (
        <>
          <h1>
            Run <code>{run.data.id}</code>
          </h1>
          <RunFactsPanel run={run.data} retry={retry} streamStatus={streamStatus} />
          <section className="run-section" aria-label="Cancel Run">
            <div className="run-actions">
              <button
                type="button"
                className="button danger"
                aria-disabled={!cancel.enabled}
                aria-describedby="cancel-reason"
                data-testid="cancel-run"
                onClick={() => {
                  if (cancel.enabled) setConfirming(true);
                }}
              >
                Cancel Run
              </button>
              <span id="cancel-reason" data-testid="cancel-reason">
                {cancel.reason ??
                  "Asks the server to stop this Run; the result is confirmed separately."}
              </span>
            </div>
            {cancel.notice ? (
              <p className="banner tone-info" data-testid="cancel-notice">
                <Icon shape="info" />
                <span>{cancel.notice}</span>
              </p>
            ) : null}
          </section>
          <ConfirmDialog
            open={confirming}
            title="Cancel this Run?"
            description="Cancellation is a request. The Run keeps its evidence, and stays running until the worker confirms it has stopped; a result already proven is not changed."
            context={[
              { label: "Run", value: run.data.id },
              { label: "Current phase", value: run.data.phase },
            ]}
            confirmLabel="Request cancellation"
            cancelLabel="Keep running"
            destructive
            onConfirm={requestCancel}
            onCancel={() => setConfirming(false)}
          />
          <RunTimeline timeline={timeline} />
          <FreshnessPanel run={run.data} />
          <AttemptsTable
            attempts={attempts.items}
            {...(attempts.hasMore
              ? {
                  pager: {
                    hasMore: attempts.hasMore,
                    loading: attempts.loadingMore,
                    onLoadMore: () => void attempts.loadMore(),
                  },
                }
              : {})}
          />
          <StepsSection groups={stepGroups} bundles={bundles} onSelect={select} privacy={privacy} />
          <section className="run-section" aria-labelledby="artifacts-heading">
            <h2 id="artifacts-heading">Artifacts</h2>
            <ArtifactSection
              attempts={sortedAttempts}
              stepGroups={stepGroups}
              bundles={bundles}
              selection={selection}
              onSelect={select}
              onClose={() => setSelection(null)}
            />
          </section>
          <div className="run-section">
            <AnalysisPanel runId={run.data.id} run={run.data} />
          </div>
          <section className="run-section" aria-labelledby="dataflow-heading">
            <h2 id="dataflow-heading">Data flow</h2>
            <DataFlowPanel
              runId={run.data.id}
              testId={run.data.testId}
              revisionId={run.data.revisionId}
            />
          </section>
        </>
      ) : null}
    </StatusView>
  );
}

function RunDetailPage(): ReactNode {
  const { runId = "" } = useParams();
  // One instance per Run, so a different Run starts from a clean timeline and stream.
  return <RunDetail key={runId} runId={runId} />;
}

export const routes: PortalRoute[] = [
  {
    path: "/runs",
    title: "Runs",
    element: <RunsPage />,
    nav: { label: "Runs", section: "Workspace" },
  },
  {
    path: "/projects/:projectId/runs",
    title: "Project runs",
    element: <ProjectRunsPage />,
    projectNav: { label: "Runs", order: 80 },
  },
  { path: "/runs/:runId", title: "Run", element: <RunDetailPage /> },
];
