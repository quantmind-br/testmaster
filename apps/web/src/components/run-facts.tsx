import { type ReactNode, useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { type ApiResult, api, type Page } from "../api";
import type { StreamStatus } from "../api/sse";
import type { PlanLike } from "../lib/data-flow";
import {
  buildCurrentContext,
  describeAttempt,
  describeRunFacts,
  formatDuration,
  formatServerTime,
  formatStructured,
  humanizeCode,
  phaseLabels,
  type RetryFacts,
  type StepGroup,
  sensitiveStepIds,
  sortAttempts,
} from "../lib/run-facts";
import { describeStages, serverDuration, type TimelineState } from "../lib/run-timeline";
import type { AttemptRecord, RunRecord } from "../lib/run-types";
import { describeFreshness } from "../lib/stale-evidence";
import { type ArtifactSelection, type BundleState, StepEvidence } from "./artifact-viewer";
import { type Column, DataTable } from "./data-table";
import { Icon, type Shape, StatusBadge } from "./status";
import { UntrustedText } from "./untrusted-text";
import { ViewState } from "./view-state";
import "./run-facts.css";

const streamText: Record<StreamStatus, string> = {
  idle: "Live updates not started",
  connecting: "Live updates connecting",
  live: "Live updates connected",
  reconnecting: "Live updates reconnecting; the latest snapshot is shown",
  closed: "Live updates ended",
  failed: "Live updates lost; reload the page to resume",
};

const stageShape: Record<"done" | "active" | "pending", Shape> = {
  done: "check",
  active: "spinner",
  pending: "clock",
};
const stageText: Record<"done" | "active" | "pending", string> = {
  done: "Done",
  active: "In progress",
  pending: "Pending",
};

/** The Run's result in words that never overstate a pass, plus its identifying facts. */
export function RunFactsPanel(props: {
  run: RunRecord;
  retry: RetryFacts;
  streamStatus: StreamStatus;
}): ReactNode {
  const { run } = props;
  const headingId = useId();
  const facts = describeRunFacts(run, props.retry);
  return (
    <section className="run-section" aria-labelledby={headingId} data-testid="run-facts">
      <h2 id={headingId}>Result</h2>
      <p>
        <StatusBadge status={facts.status} label={facts.label} />
      </p>
      {facts.notes.length > 0 ? (
        <ul>
          {facts.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      <dl className="context">
        <dt>Run</dt>
        <dd>
          <code>{run.id}</code>
        </dd>
        <dt>Test</dt>
        <dd>
          <code>{run.testId}</code>
        </dd>
        <dt>Test revision</dt>
        <dd>
          <code>{run.revisionId}</code>
        </dd>
        <dt>Environment</dt>
        <dd>
          {run.matrixCell?.environmentName ? (
            <UntrustedText value={run.matrixCell.environmentName} maxLength={120} />
          ) : (
            "Unknown"
          )}{" "}
          (revision <code>{run.environmentRevisionId}</code>)
        </dd>
        <dt>Phase</dt>
        <dd>{phaseLabels[run.phase]}</dd>
        <dt>Cleanup</dt>
        <dd>{humanizeCode(run.cleanupOutcome)}</dd>
        <dt>Gate</dt>
        <dd>{humanizeCode(run.gate)}</dd>
        <dt>Mode</dt>
        <dd>{run.mode}</dd>
        <dt>Origin</dt>
        <dd>
          <UntrustedText value={run.origin} maxLength={80} />
        </dd>
        <dt>Batch</dt>
        <dd>
          {run.batchId ? (
            <Link to={`/runs?batchId=${encodeURIComponent(run.batchId)}`}>
              <code>{run.batchId}</code>
            </Link>
          ) : (
            "None"
          )}
        </dd>
        <dt>Created</dt>
        <dd>{formatServerTime(run.createdAt)}</dd>
        <dt>Live updates</dt>
        <dd data-testid="stream-status">{streamText[props.streamStatus]}</dd>
      </dl>
    </section>
  );
}

/** The six stages of a Run with server-time durations; a live Run shows the current stage as in progress. */
export function RunTimeline({ timeline }: { timeline: TimelineState }): ReactNode {
  const headingId = useId();
  return (
    <section className="run-section" aria-labelledby={headingId} data-testid="run-timeline">
      <h2 id={headingId}>Timeline</h2>
      <ol className="timeline" aria-label="Run stages">
        {describeStages(timeline).map((stage) => (
          <li key={stage.key} data-stage={stage.key} data-state={stage.state}>
            <span className="timeline-title">
              <Icon shape={stageShape[stage.state]} spin={stage.state === "active"} />
              <span>{stage.label}</span>
              <span>— {stageText[stage.state]}</span>
            </span>
            <span className="timeline-meta">
              {stage.at ? (
                <>
                  <time dateTime={stage.at}>{formatServerTime(stage.at)}</time>
                  {stage.durationMs === null
                    ? ""
                    : `, +${formatDuration(stage.durationMs)} after the previous stage (server time)`}
                </>
              ) : (
                "No timestamp yet"
              )}
            </span>
            <span>{stage.detail}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

type Lookup =
  | { readonly status: "loading" }
  | { readonly status: "unknown" }
  | { readonly status: "ready"; readonly activeRevisionId: string | null };

/** The active revision behind `path`; any failure is `unknown`, never a current-looking value. */
function useActiveRevision(path: string | null): Lookup {
  const [lookup, setLookup] = useState<Lookup>(
    path === null ? { status: "unknown" } : { status: "loading" },
  );
  useEffect(() => {
    if (path === null) {
      setLookup({ status: "unknown" });
      return;
    }
    const controller = new AbortController();
    setLookup({ status: "loading" });
    api<{ activeRevisionId: string | null }>("GET", path, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted)
          setLookup({ status: "ready", activeRevisionId: result.data.activeRevisionId ?? null });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLookup({ status: "unknown" });
      });
    return () => controller.abort();
  }, [path]);
  return lookup;
}

const freshnessBadge = {
  current: { status: "verified", label: "Current" },
  stale: { status: "degraded", label: "Stale" },
  unknown: { status: "inconclusive", label: "Unknown" },
} as const;

interface FreshnessRow {
  readonly dimension: string;
  readonly recorded: string | null;
  readonly current: string | null;
  readonly state: "current" | "stale" | "unknown";
}

const freshnessColumns: Column<FreshnessRow>[] = [
  { key: "dimension", header: "Dimension", render: (row) => row.dimension },
  {
    key: "recorded",
    header: "Recorded in this Run",
    render: (row) => (row.recorded ? <code>{row.recorded}</code> : "—"),
  },
  {
    key: "current",
    header: "Current now",
    render: (row) => (row.current ? <code>{row.current}</code> : "Not known"),
  },
  {
    key: "state",
    header: "Freshness",
    render: (row) => <StatusBadge {...freshnessBadge[row.state]} />,
  },
];

/**
 * Stale-evidence check (UX-034): compares the revisions this Run recorded with the test's and the
 * environment's active revisions now. The recorded verdict is never changed, only qualified.
 */
export function FreshnessPanel({ run }: { run: RunRecord }): ReactNode {
  const headingId = useId();
  const environmentId = run.matrixCell?.environmentId;
  const test = useActiveRevision(`/tests/${encodeURIComponent(run.testId)}`);
  const environment = useActiveRevision(
    environmentId ? `/environments/${encodeURIComponent(environmentId)}` : null,
  );
  let body: ReactNode;
  if (test.status === "loading" || environment.status === "loading")
    body = (
      <ViewState
        kind="loading"
        title="Checking freshness"
        message="Comparing this result with the current test and environment revisions."
      />
    );
  else {
    const freshness = describeFreshness(
      run,
      buildCurrentContext(
        test.status === "ready" ? { activeRevisionId: test.activeRevisionId } : null,
        environment.status === "ready" && environment.activeRevisionId
          ? { activeRevisionId: environment.activeRevisionId }
          : null,
      ),
    );
    const tone =
      freshness.state === "current"
        ? "success"
        : freshness.state === "stale"
          ? "warning"
          : "neutral";
    const shape: Shape =
      freshness.state === "current" ? "check" : freshness.state === "stale" ? "warn" : "question";
    body = (
      <>
        <p
          className={`banner tone-${tone}`}
          data-testid="freshness-headline"
          data-freshness={freshness.state}
        >
          <Icon shape={shape} />
          <span>{freshness.headline}</span>
        </p>
        <DataTable
          caption="Evidence freshness by dimension"
          columns={freshnessColumns}
          rows={freshness.findings.map((finding) => ({
            dimension: finding.dimension,
            recorded: finding.recorded,
            current: finding.current,
            state: finding.state,
          }))}
          rowKey={(row) => row.dimension}
        />
      </>
    );
  }
  return (
    <section className="run-section" aria-labelledby={headingId} data-testid="freshness-panel">
      <h2 id={headingId}>Evidence freshness</h2>
      {body}
    </section>
  );
}

function attemptBadge(attempt: AttemptRecord): ReactNode {
  if (attempt.outcome) return <StatusBadge status={attempt.outcome} />;
  if (attempt.phase === "completed")
    return <StatusBadge status="inconclusive" label="No verdict" />;
  return <StatusBadge status="running" label="In progress" />;
}

/** Every Attempt with its own number, policy, retry reason, times and result. */
export function AttemptsTable(props: {
  attempts: readonly AttemptRecord[];
  pager?: { hasMore: boolean; loading: boolean; onLoadMore: () => void };
}): ReactNode {
  const headingId = useId();
  const attempts = sortAttempts(props.attempts);
  const columns: Column<AttemptRecord>[] = [
    {
      key: "attempt",
      header: "Attempt",
      render: (attempt) => (
        <>
          <strong>{describeAttempt(attempt, attempts).title}</strong> <code>{attempt.id}</code>
        </>
      ),
    },
    {
      key: "policy",
      header: "Policy",
      render: (attempt) => describeAttempt(attempt, attempts).policy,
    },
    {
      key: "origin",
      header: "How it started",
      render: (attempt) => describeAttempt(attempt, attempts).origin,
    },
    { key: "started", header: "Started", render: (attempt) => formatServerTime(attempt.startedAt) },
    { key: "ended", header: "Ended", render: (attempt) => formatServerTime(attempt.endedAt) },
    {
      key: "duration",
      header: "Duration (server time)",
      render: (attempt) => formatDuration(serverDuration(attempt.startedAt, attempt.endedAt)),
    },
    { key: "result", header: "Result", render: (attempt) => attemptBadge(attempt) },
  ];
  return (
    <section className="run-section" aria-labelledby={headingId} data-testid="attempts">
      <h2 id={headingId}>Attempts</h2>
      {attempts.length === 0 ? (
        <ViewState
          kind="empty"
          title="No attempts yet"
          message="The Run has not been claimed by a worker."
        />
      ) : (
        <DataTable
          caption="Attempts of this Run"
          columns={columns}
          rows={attempts}
          rowKey={(attempt) => attempt.id}
          {...(props.pager ? { pager: props.pager } : {})}
        />
      )}
    </section>
  );
}

export type StepPrivacy =
  | { readonly status: "loading" }
  | { readonly status: "unknown" }
  | { readonly status: "ready"; readonly sensitive: ReadonlySet<string> };

interface PlanRevision {
  readonly id: string;
  readonly plan: PlanLike;
}

/**
 * Which steps of the Run's revision capture sensitive values. Fails closed: until the plan is
 * read (or when it cannot be), no step's expected or observed data is shown.
 */
export function useStepPrivacy(testId: string, revisionId: string): StepPrivacy {
  const [privacy, setPrivacy] = useState<StepPrivacy>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setPrivacy({ status: "loading" });
    if (!testId || !revisionId) return () => controller.abort();
    (async () => {
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const result: ApiResult<Page<PlanRevision>> = await api<Page<PlanRevision>>(
          "GET",
          `/tests/${encodeURIComponent(testId)}/revisions`,
          { query: { limit: 100, cursor }, signal: controller.signal },
        );
        const revision = result.data.items.find((item) => item.id === revisionId);
        if (revision) {
          setPrivacy({ status: "ready", sensitive: sensitiveStepIds(revision.plan) });
          return;
        }
        if (!result.data.hasMore || !result.data.nextCursor) break;
        cursor = result.data.nextCursor;
      }
      setPrivacy({ status: "unknown" });
    })().catch(() => {
      if (!controller.signal.aborted) setPrivacy({ status: "unknown" });
    });
    return () => controller.abort();
  }, [testId, revisionId]);
  return privacy;
}

/** Steps per Attempt; expected and observed values are untrusted text. */
export function StepsSection(props: {
  groups: readonly StepGroup[];
  bundles: Readonly<Record<string, BundleState>>;
  onSelect: (selection: Omit<ArtifactSelection, "nonce">) => void;
  privacy: StepPrivacy;
}): ReactNode {
  const headingId = useId();
  const withheld = (stepId: string): ReactNode =>
    props.privacy.status === "ready" && !props.privacy.sensitive.has(stepId) ? null : (
      <span className="truncated-note" data-withheld="">
        {props.privacy.status === "ready"
          ? "Withheld: this step captures a sensitive value."
          : props.privacy.status === "loading"
            ? "Withheld until the plan confirms this step captures no sensitive value."
            : "Withheld: the plan could not be read to check for sensitive values."}
      </span>
    );
  return (
    <section className="run-section" aria-labelledby={headingId} data-testid="steps">
      <h2 id={headingId}>Steps</h2>
      {props.groups.length === 0 || props.groups.every((group) => group.rows.length === 0) ? (
        <ViewState kind="empty" title="No steps yet" message="No step has reported for this Run." />
      ) : null}
      {props.groups
        .filter((group) => group.rows.length > 0)
        .map((group) => {
          const label = `Attempt ${group.attempt?.number ?? "unknown"}`;
          const columns: Column<StepGroup["rows"][number]>[] = [
            {
              key: "step",
              header: "Step",
              render: (row) => (
                <>
                  <span>{row.index + 1}. </span>
                  <UntrustedText value={row.stepId} maxLength={120} />
                </>
              ),
            },
            {
              key: "status",
              header: "Status",
              render: (row) => <StatusBadge status={row.status} />,
            },
            {
              key: "reason",
              header: "Reason",
              render: (row) => (row.reasonCode ? humanizeCode(row.reasonCode) : "—"),
            },
            {
              key: "duration",
              header: "Duration",
              render: (row) => formatDuration(row.durationMs),
            },
            {
              key: "expected",
              header: "Expected",
              render: (row) =>
                withheld(row.stepId) ?? (
                  <UntrustedText value={formatStructured(row.expected)} block maxLength={2000} />
                ),
            },
            {
              key: "observed",
              header: "Observed",
              render: (row) =>
                withheld(row.stepId) ?? (
                  <>
                    <UntrustedText value={formatStructured(row.observed)} block maxLength={2000} />
                    {row.error ? (
                      <p>
                        Error <code>{row.error.code}</code>:{" "}
                        <UntrustedText value={row.error.message} maxLength={500} />
                      </p>
                    ) : null}
                  </>
                ),
            },
            {
              key: "evidence",
              header: "Evidence",
              render: (row) => (
                <StepEvidence
                  attemptId={group.attemptId}
                  paths={row.evidencePaths}
                  bundle={props.bundles[group.attemptId]}
                  onSelect={props.onSelect}
                />
              ),
            },
          ];
          return (
            <DataTable
              key={group.attemptId}
              caption={`Steps of ${label.toLowerCase()}`}
              columns={columns}
              rows={group.rows}
              rowKey={(row) => row.key}
            />
          );
        })}
    </section>
  );
}
