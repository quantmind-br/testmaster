import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { type Column, DataTable } from "../../components/data-table";
import { useSelectContext } from "../../components/portal-context";
import { UntrustedText } from "../../components/untrusted-text";
import { StatusView, ViewState } from "../../components/view-state";
import { usePageTitle } from "../../hooks/use-page-title";
import { usePaged, useResource } from "../../hooks/use-resource";
import type { ProjectSummary } from "../home";
import { NotFoundPage } from "../not-found";
import { enc, type TestDoc } from "./model";
import { Pill } from "./parts";

const columns: Column<TestDoc>[] = [
  {
    key: "name",
    header: "Test",
    sortValue: (test) => test.name.toLowerCase(),
    render: (test) => (
      <Link to={`/tests/${enc(test.id)}`}>
        <UntrustedText value={test.name} maxLength={160} />
      </Link>
    ),
  },
  {
    key: "priority",
    header: "Priority",
    sortValue: (test) => test.priority,
    render: (test) => test.priority,
  },
  {
    key: "active",
    header: "Active revision",
    render: (test) =>
      test.activeRevisionId ? (
        <code>{test.activeRevisionId}</code>
      ) : (
        <Pill label="No active revision" tone="warning" shape="warn" />
      ),
  },
  {
    key: "state",
    header: "State",
    render: (test) =>
      test.archivedAt ? (
        <Pill label="Archived" tone="neutral" shape="stop" />
      ) : (
        <Pill label="Active" tone="success" shape="check" />
      ),
  },
];

export function TestsPage(): ReactNode {
  const { projectId = "" } = useParams();
  const project = useResource<ProjectSummary>(`/projects/${enc(projectId)}`);
  const tests = usePaged<TestDoc>(`/projects/${enc(projectId)}/tests`);
  useSelectContext(project.data ? { id: project.data.id, name: project.data.name } : null);
  usePageTitle("Tests");
  if (project.status === "not-found") return <NotFoundPage />;
  return (
    <StatusView status={project.status} error={project.error} onRetry={() => void project.reload()}>
      <h1>Tests</h1>
      <div className="link-row">
        <Link to={`/projects/${enc(projectId)}/proposals`}>Proposals</Link>
        <Link to={`/projects/${enc(projectId)}`}>Project overview</Link>
      </div>
      <StatusView
        status={tests.status}
        error={tests.error}
        onRetry={() => void tests.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No tests yet"
            message="Accept a proposal to create the first test."
            action={<Link to={`/projects/${enc(projectId)}/proposals`}>Go to proposals</Link>}
          />
        }
      >
        <DataTable
          caption="Tests"
          columns={columns}
          rows={tests.items}
          rowKey={(test) => test.id}
          pager={{
            hasMore: tests.hasMore,
            loading: false,
            onLoadMore: () => void tests.loadMore(),
          }}
        />
      </StatusView>
    </StatusView>
  );
}
