import type { ReactNode } from "react";
import { useParams } from "react-router";
import { type Column, DataTable } from "../components/data-table";
import { useSelectContext } from "../components/portal-context";
import { StatusBadge } from "../components/status";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView, ViewState } from "../components/view-state";
import { usePageTitle } from "../hooks/use-page-title";
import { usePaged, useResource } from "../hooks/use-resource";
import type { ProjectSummary } from "./home";
import { NotFoundPage } from "./not-found";
import type { PortalRoute } from "./types";

interface EnvironmentSummary {
  readonly id: string;
  readonly name: string;
  readonly archivedAt: string | null;
}

interface RunSummary {
  readonly id: string;
  readonly status: string;
  readonly createdAt: string;
  readonly testId?: string;
}

const environmentColumns: Column<EnvironmentSummary>[] = [
  {
    key: "name",
    header: "Environment",
    render: (item) => <UntrustedText value={item.name} maxLength={120} />,
  },
  { key: "state", header: "State", render: (item) => (item.archivedAt ? "Archived" : "Active") },
];

const runColumns: Column<RunSummary>[] = [
  { key: "id", header: "Run", render: (run) => <code>{run.id}</code> },
  { key: "status", header: "Status", render: (run) => <StatusBadge status={run.status} /> },
  {
    key: "createdAt",
    header: "Created",
    render: (run) => <time dateTime={run.createdAt}>{run.createdAt}</time>,
  },
];

function ProjectOverview(): ReactNode {
  const { projectId = "" } = useParams();
  const project = useResource<ProjectSummary>(`/projects/${encodeURIComponent(projectId)}`);
  const environments = usePaged<EnvironmentSummary>(
    `/projects/${encodeURIComponent(projectId)}/environments`,
  );
  const runs = usePaged<RunSummary>("/runs", { projectId }, 10);
  const defaultEnvironment =
    environments.items.find((item) => item.id === project.data?.defaultEnvironmentId) ?? null;
  useSelectContext(
    project.data ? { id: project.data.id, name: project.data.name } : null,
    defaultEnvironment ? { id: defaultEnvironment.id, name: defaultEnvironment.name } : null,
  );
  usePageTitle(project.status === "not-found" ? "Not found" : (project.data?.name ?? "Project"));
  // A missing project and a project the caller may not see are the same page.
  if (project.status === "not-found") return <NotFoundPage />;
  return (
    <StatusView status={project.status} error={project.error} onRetry={() => void project.reload()}>
      {project.data ? (
        <>
          <h1>
            <UntrustedText value={project.data.name} maxLength={120} />
          </h1>
          <dl className="context">
            <dt>Slug</dt>
            <dd>
              <code>{project.data.slug}</code>
            </dd>
            <dt>State</dt>
            <dd>{project.data.archivedAt ? "Archived" : "Active"}</dd>
            <dt>Default environment</dt>
            <dd>
              {defaultEnvironment ? (
                <UntrustedText value={defaultEnvironment.name} maxLength={120} />
              ) : (
                "None"
              )}
            </dd>
          </dl>
          <h2>Environments</h2>
          <StatusView
            status={environments.status}
            error={environments.error}
            onRetry={() => void environments.reload()}
            empty={
              <ViewState
                kind="empty"
                title="No environments"
                message="This project has no environments yet."
              />
            }
          >
            <DataTable
              caption="Environments"
              columns={environmentColumns}
              rows={environments.items}
              rowKey={(item) => item.id}
            />
          </StatusView>
          <h2>Recent runs</h2>
          <StatusView
            status={runs.status}
            error={runs.error}
            onRetry={() => void runs.reload()}
            empty={
              <ViewState
                kind="empty"
                title="No runs yet"
                message="Runs for this project appear here."
              />
            }
          >
            <DataTable
              caption="Recent runs"
              columns={runColumns}
              rows={runs.items}
              rowKey={(run) => run.id}
            />
          </StatusView>
        </>
      ) : null}
    </StatusView>
  );
}

export const routes: PortalRoute[] = [
  { path: "/projects/:projectId", title: "Project", element: <ProjectOverview /> },
];
