import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { type Column, DataTable } from "../components/data-table";
import { useSelectContext } from "../components/portal-context";
import { Icon, type Shape } from "../components/status";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView, ViewState } from "../components/view-state";
import { usePageTitle } from "../hooks/use-page-title";
import { useResource } from "../hooks/use-resource";
import { useUrlState } from "../hooks/use-url-state";
import type { Coverage, FeatureCoverageMap, ProjectRef } from "../lib/m4-types";
import { enumField } from "../lib/url-state";
import { NotFoundPage } from "./not-found";
import type { PortalRoute } from "./types";

type Row = FeatureCoverageMap["rows"][number];

const coverageView: Record<
  Coverage,
  { label: string; detail: string; shape: Shape; tone: string }
> = {
  no_tests: {
    label: "No coverage",
    detail: "No test is linked to this item.",
    shape: "cross",
    tone: "danger",
  },
  tests_without_valid_run: {
    label: "Tests, no valid run",
    detail: "Tests exist but no run reached a verdict yet.",
    shape: "warn",
    tone: "warning",
  },
  valid_run: {
    label: "Has a valid run",
    detail: "At least one linked test has a run that passed or failed.",
    shape: "check",
    tone: "success",
  },
};

const kindLabels: Record<Row["kind"], string> = {
  requirement: "Requirement",
  endpoint: "Endpoint",
  route: "Page route",
  desired: "Desired behaviour",
};

const filters = {
  coverage: enumField(["", "no_tests", "tests_without_valid_run", "valid_run"] as const, ""),
};

function CoverageBadge({ coverage }: { coverage: Coverage }): ReactNode {
  const view = coverageView[coverage];
  return (
    <span className={`badge tone-${view.tone}`} data-coverage={coverage} title={view.detail}>
      <Icon shape={view.shape} />
      <span>{view.label}</span>
    </span>
  );
}

function FeatureMapPage(): ReactNode {
  const { projectId = "" } = useParams();
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const project = useResource<ProjectRef>(base);
  const map = useResource<FeatureCoverageMap>(`${base}/feature-map`);
  const [url, setUrl] = useUrlState(filters);
  useSelectContext(project.data ? { id: project.data.id, name: project.data.name } : null);
  usePageTitle("Feature map");
  if (project.status === "not-found") return <NotFoundPage />;
  const columns: Column<Row>[] = [
    {
      key: "item",
      header: "Item",
      render: (row) => (
        <>
          <span className="label">{kindLabels[row.kind]}</span>{" "}
          <UntrustedText value={row.title} maxLength={200} />
        </>
      ),
    },
    {
      key: "coverage",
      header: "Coverage",
      render: (row) => <CoverageBadge coverage={row.coverage} />,
    },
    {
      key: "sources",
      header: "Sources",
      render: (row) =>
        row.sources.length === 0 ? (
          "—"
        ) : (
          <ul className="plain">
            {row.sources.map((source) => (
              <li key={source.revisionId}>
                {source.sourceId ? (
                  <Link to={`${base}/sources/${encodeURIComponent(source.sourceId)}`}>
                    <UntrustedText value={source.sourceName} maxLength={80} />
                  </Link>
                ) : (
                  <UntrustedText value={source.sourceName} maxLength={80} />
                )}
                {source.current ? "" : " (superseded revision)"}
              </li>
            ))}
          </ul>
        ),
    },
    {
      key: "where",
      header: "Endpoints, routes and files",
      render: (row) => {
        const items = [...row.endpoints, ...row.routes, ...row.files];
        return items.length === 0 ? (
          "—"
        ) : (
          <UntrustedText value={items.slice(0, 6).join(", ")} maxLength={300} />
        );
      },
    },
    {
      key: "tests",
      header: "Tests",
      render: (row) =>
        row.tests.length === 0 ? (
          "None"
        ) : (
          <ul className="plain">
            {row.tests.map((test) => (
              <li key={test.testId}>
                <UntrustedText value={test.name} maxLength={80} /> (revision {test.revisionOrdinal},
                via {test.via})
              </li>
            ))}
          </ul>
        ),
    },
    {
      key: "evidence",
      header: "Latest valid evidence",
      render: (row) => {
        const valid = row.evidence.filter((item) => item.valid);
        const latest = valid[0];
        return latest ? (
          <>
            <code>{latest.runId}</code> {latest.outcome}
          </>
        ) : row.evidence.length > 0 ? (
          `${row.evidence.length} run(s), none with a verdict`
        ) : (
          "—"
        );
      },
    },
  ];
  return (
    <>
      <h1>Feature map</h1>
      <StatusView status={map.status} error={map.error} onRetry={() => void map.reload()}>
        {map.data ? (
          <>
            <p>
              Absence is shown as absence: an item with no linked test is listed as{" "}
              <strong>No coverage</strong>, never as covered.
            </p>
            <ul className="summary" aria-label="Coverage summary" data-testid="coverage-summary">
              <li data-count="no_tests">
                <CoverageBadge coverage="no_tests" /> {map.data.summary.noTests}
              </li>
              <li data-count="tests_without_valid_run">
                <CoverageBadge coverage="tests_without_valid_run" />{" "}
                {map.data.summary.testsWithoutValidRun}
              </li>
              <li data-count="valid_run">
                <CoverageBadge coverage="valid_run" /> {map.data.summary.validRun}
              </li>
            </ul>
            <p>
              {map.data.discovery ? (
                <>
                  Based on the discovery of{" "}
                  <Link to={`${base}/discovery/${encodeURIComponent(map.data.discovery.id)}`}>
                    <time dateTime={map.data.discovery.createdAt}>
                      {map.data.discovery.createdAt}
                    </time>
                  </Link>
                  .
                </>
              ) : (
                <>
                  No discovery has run yet. <Link to={`${base}/discovery`}>Run a discovery</Link> to
                  add endpoints and routes.
                </>
              )}
            </p>
            <label className="choice">
              Show{" "}
              <select
                value={url.coverage}
                onChange={(event) =>
                  setUrl({ coverage: event.target.value as typeof url.coverage })
                }
              >
                <option value="">All items</option>
                <option value="no_tests">No coverage</option>
                <option value="tests_without_valid_run">Tests, no valid run</option>
                <option value="valid_run">Has a valid run</option>
              </select>
            </label>
            <DataTable
              caption="Feature coverage"
              columns={columns}
              rows={map.data.rows.filter(
                (row) => url.coverage === "" || row.coverage === url.coverage,
              )}
              rowKey={(row) => row.key}
              empty={
                <ViewState
                  kind="empty"
                  title="Nothing to show"
                  message="No requirement or discovered feature matches this filter."
                />
              }
            />
            {map.data.truncated ? <p>The list was cut at its size limit.</p> : null}
            <section aria-label="Limitations">
              <h2>Limitations</h2>
              <ul>
                {map.data.limitations.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          </>
        ) : null}
      </StatusView>
    </>
  );
}

export const routes: PortalRoute[] = [
  {
    path: "/projects/:projectId/feature-map",
    title: "Feature map",
    element: <FeatureMapPage />,
    projectNav: { label: "Feature map", order: 50 },
  },
];
