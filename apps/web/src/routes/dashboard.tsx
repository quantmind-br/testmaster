import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { type Column, DataTable } from "../components/data-table";
import { FormField } from "../components/form";
import { useAnnounce } from "../components/live-region";
import { useSelectContext } from "../components/portal-context";
import { Icon } from "../components/status";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView, ViewState } from "../components/view-state";
import { usePageTitle } from "../hooks/use-page-title";
import { useResource } from "../hooks/use-resource";
import { useUrlState } from "../hooks/use-url-state";
import {
  describeExclusions,
  describeMetricFamilies,
  type ExclusionRow,
  type MetricFamilyView,
  type MetricRow,
  type MetricsPayload,
} from "../lib/metrics-view";
import { enumField } from "../lib/url-state";
import "./dashboard.css";
import type { ProjectSummary } from "./home";
import { NotFoundPage } from "./not-found";
import type { PortalRoute } from "./types";

const windowDays = ["7", "30", "90"] as const;
const filters = { days: enumField(windowDays, "30") };
const dayMs = 24 * 60 * 60 * 1000;
/** The server reads at most this many Runs per window; asking for it makes truncation explicit. */
const runLimit = 200;

const metricColumns: Column<MetricRow>[] = [
  { key: "label", header: "Metric", render: (row) => row.label },
  {
    key: "rate",
    header: "Rate",
    render: (row) =>
      row.available ? (
        <strong data-rate={row.key}>{row.display}</strong>
      ) : (
        <span className="badge tone-neutral" data-rate={row.key}>
          <Icon shape="info" />
          <span>{row.display}</span>
        </span>
      ),
  },
  { key: "fraction", header: "Numerator and denominator", render: (row) => row.fraction },
  { key: "definition", header: "Definition", render: (row) => row.definition },
];

const exclusionColumns: Column<ExclusionRow>[] = [
  { key: "label", header: "Excluded from the rates", render: (row) => row.label },
  {
    key: "count",
    header: "Runs",
    render: (row) => <span data-exclusion={row.key}>{row.count}</span>,
  },
];

interface QuarantineRow {
  readonly id: string;
  readonly owner: string;
  readonly reason: string;
  readonly expiresAt: string;
  readonly active: boolean;
  readonly runsInWindow: number;
  readonly failedRunsInWindow: number;
}

const quarantineColumns: Column<QuarantineRow>[] = [
  { key: "test", header: "Test", render: (row) => <code>{row.id}</code> },
  {
    key: "owner",
    header: "Owner",
    render: (row) => <UntrustedText value={row.owner} maxLength={80} />,
  },
  {
    key: "reason",
    header: "Reason",
    render: (row) => <UntrustedText value={row.reason} maxLength={200} />,
  },
  {
    key: "expires",
    header: "Expires",
    render: (row) => <time dateTime={row.expiresAt}>{row.expiresAt}</time>,
  },
  {
    key: "active",
    header: "Quarantine",
    render: (row) => (
      <span className={`badge ${row.active ? "tone-warning" : "tone-neutral"}`}>
        <Icon shape={row.active ? "stop" : "clock"} />
        <span>{row.active ? "Active" : "Expired"}</span>
      </span>
    ),
  },
  { key: "runs", header: "Runs in window", render: (row) => row.runsInWindow },
  { key: "failed", header: "Failed Runs in window", render: (row) => row.failedRunsInWindow },
];

interface ReasonRow {
  readonly id: string;
  readonly count: number;
}
const reasonColumns: Column<ReasonRow>[] = [
  {
    key: "reason",
    header: "Reason code",
    render: (row) => (
      <code>
        <UntrustedText value={row.id} maxLength={80} />
      </code>
    ),
  },
  { key: "count", header: "Blocked Runs", render: (row) => row.count },
];

const countColumns: Column<{ id: string; count: number }>[] = [
  { key: "name", header: "Count", render: (row) => row.id },
  { key: "value", header: "Runs or Attempts", render: (row) => row.count },
];

function FamilySection({ family }: { family: MetricFamilyView }): ReactNode {
  const headingId = `family-${family.family}`;
  return (
    <section aria-labelledby={headingId} data-family={family.family}>
      <h2 id={headingId}>{family.title}</h2>
      <p>{family.question}</p>
      <DataTable
        caption={`${family.title} metrics`}
        columns={metricColumns}
        rows={family.rows}
        rowKey={(row) => row.key}
      />
    </section>
  );
}

function DashboardBody({ data, days }: { data: MetricsPayload; days: string }): ReactNode {
  const families = describeMetricFamilies(data);
  const exclusions = describeExclusions(data);
  const quarantined: QuarantineRow[] = data.quarantined.map((item) => ({
    ...item,
    id: item.testId,
  }));
  const blocked = Object.entries(data.metrics.blockedReasons).map(([id, count]) => ({ id, count }));
  const counts = Object.entries(data.metrics.counts).map(([id, count]) => ({ id, count }));
  return (
    <>
      <p data-testid="window-summary">
        {data.considered} Run(s) from the last {days} days,{" "}
        <time dateTime={data.window.since}>{data.window.since}</time> to{" "}
        <time dateTime={data.window.until}>{data.window.until}</time>.
      </p>
      {data.truncated ? (
        <div className="banner tone-warning" role="status" data-testid="truncation-notice">
          <Icon shape="warn" />
          <span>
            Showing the newest {data.considered} Runs. Older Runs in this window are not counted, so
            every rate below describes only these Runs.
          </span>
        </div>
      ) : null}
      {data.considered === 0 ? (
        <ViewState
          kind="empty"
          title="No Runs in this window"
          message="No rate can be computed without Runs. Rates below say so instead of showing 0%."
        />
      ) : null}
      <p>The four families answer different questions and are never combined into one number.</p>
      {families.map((family) => (
        <FamilySection key={family.family} family={family} />
      ))}
      <section aria-labelledby="exclusions-heading">
        <h2 id="exclusions-heading">Exclusions</h2>
        <p>
          Every exclusion is reported, including those at zero, so an absent exclusion is a stated
          fact.
        </p>
        <DataTable
          caption="Exclusions from the rates"
          columns={exclusionColumns}
          rows={exclusions}
          rowKey={(row) => row.key}
        />
      </section>
      <section aria-labelledby="quarantine-heading">
        <h2 id="quarantine-heading">Quarantine</h2>
        <p data-testid="quarantine-statement">
          Quarantined tests are not removed from these rates: every Run of a quarantined test stays
          in every denominator, and a quarantined failure still counts as a failure.
        </p>
        <DataTable
          caption="Quarantined tests"
          columns={quarantineColumns}
          rows={quarantined}
          rowKey={(row) => row.id}
          empty={
            <ViewState
              kind="empty"
              title="No tests are quarantined"
              message="No test in this project has a quarantine record."
            />
          }
        />
      </section>
      <section aria-labelledby="blocked-heading">
        <h2 id="blocked-heading">Blocked Runs by reason</h2>
        <DataTable
          caption="Blocked Runs by reason"
          columns={reasonColumns}
          rows={blocked}
          rowKey={(row) => row.id}
          empty={
            <ViewState
              kind="empty"
              title="No blocked Runs"
              message="No Run in this window ended blocked."
            />
          }
        />
      </section>
      <section aria-labelledby="retry-heading">
        <h2 id="retry-heading">Retry policy</h2>
        <p data-testid="retry-policy">
          <UntrustedText value={data.metrics.retryPolicy} maxLength={400} />
        </p>
      </section>
      <section aria-labelledby="counts-heading">
        <h2 id="counts-heading">Run counts</h2>
        <DataTable
          caption="Run and Attempt counts"
          columns={countColumns}
          rows={counts}
          rowKey={(row) => row.id}
        />
      </section>
      <section aria-labelledby="limitations-heading">
        <h2 id="limitations-heading">Limitations</h2>
        <ul data-testid="limitations">
          {data.limitations.map((limitation) => (
            <li key={limitation}>
              <UntrustedText value={limitation} maxLength={400} />
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function Dashboard(): ReactNode {
  const { projectId = "" } = useParams();
  const [values, update] = useUrlState(filters);
  const [asOf, setAsOf] = useState(() => Date.now());
  const announce = useAnnounce();
  const project = useResource<ProjectSummary>(`/projects/${encodeURIComponent(projectId)}`);
  const query = useMemo(
    () => ({
      since: new Date(asOf - Number(values.days) * dayMs).toISOString(),
      until: new Date(asOf).toISOString(),
      limit: runLimit,
    }),
    [asOf, values.days],
  );
  const metrics = useResource<MetricsPayload>(
    `/projects/${encodeURIComponent(projectId)}/metrics`,
    query,
  );
  useSelectContext(project.data ? { id: project.data.id, name: project.data.name } : null);
  usePageTitle("Dashboard");
  const loaded = metrics.data;
  useEffect(() => {
    if (loaded)
      announce(`Dashboard updated for the last ${values.days} days: ${loaded.considered} Runs.`);
  }, [loaded, values.days, announce]);
  if (project.status === "not-found" || metrics.status === "not-found") return <NotFoundPage />;
  return (
    <>
      <h1>Dashboard</h1>
      <div className="dashboard-controls">
        <FormField label="Time window">
          {(control) => (
            <select
              {...control}
              value={values.days}
              onChange={(event) => {
                const next = windowDays.find((value) => value === event.target.value);
                if (next) update({ days: next });
              }}
            >
              {windowDays.map((value) => (
                <option key={value} value={value}>
                  Last {value} days
                </option>
              ))}
            </select>
          )}
        </FormField>
        <button
          type="button"
          className="button secondary"
          onClick={() => setAsOf(Date.now())}
          aria-busy={metrics.refreshing}
        >
          Refresh
        </button>
      </div>
      <StatusView
        status={metrics.status}
        error={metrics.error}
        onRetry={() => void metrics.reload()}
      >
        {loaded ? <DashboardBody data={loaded} days={values.days} /> : null}
      </StatusView>
    </>
  );
}

export const routes: PortalRoute[] = [
  {
    path: "/projects/:projectId/dashboard",
    title: "Dashboard",
    element: <Dashboard />,
    projectNav: { label: "Dashboard", order: 85 },
  },
];
