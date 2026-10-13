import type { ReactNode } from "react";
import { Link } from "react-router";
import { useMe } from "../components/app-shell";
import { type Column, DataTable, type SortState } from "../components/data-table";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView, ViewState } from "../components/view-state";
import { usePageTitle } from "../hooks/use-page-title";
import { usePaged } from "../hooks/use-resource";
import { useUrlState } from "../hooks/use-url-state";
import { enumField } from "../lib/url-state";
import type { PortalRoute } from "./types";

const filters = {
  sort: enumField(["", "name", "state"], ""),
  dir: enumField(["ascending", "descending"], "ascending"),
};

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt?: string;
  readonly archivedAt: string | null;
  readonly defaultEnvironmentId: string | null;
}

const columns: Column<ProjectSummary>[] = [
  {
    key: "name",
    header: "Project",
    sortValue: (project) => project.name.toLowerCase(),
    render: (project) => (
      <Link to={`/projects/${encodeURIComponent(project.id)}`}>
        <UntrustedText value={project.name} maxLength={120} />
      </Link>
    ),
  },
  { key: "slug", header: "Slug", render: (project) => <code>{project.slug}</code> },
  {
    key: "state",
    header: "State",
    sortValue: (project) => (project.archivedAt ? 1 : 0),
    render: (project) => (project.archivedAt ? "Archived" : "Active"),
  },
];

function WorkspaceHome(): ReactNode {
  usePageTitle("Workspace home");
  const me = useMe();
  const projects = usePaged<ProjectSummary>("/projects");
  const [url, setUrl] = useUrlState(filters);
  const sort: SortState | null = url.sort === "" ? null : { key: url.sort, direction: url.dir };
  return (
    <>
      <h1>
        <UntrustedText value={me.workspace.name} maxLength={120} />
      </h1>
      <h2>Projects</h2>
      <StatusView
        status={projects.status}
        error={projects.error}
        onRetry={() => void projects.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No projects yet"
            message="Create a project from the CLI or the API to start generating tests."
          />
        }
      >
        <DataTable
          caption="Projects"
          columns={columns}
          rows={projects.items}
          rowKey={(project) => project.id}
          sort={sort}
          onSortChange={(next) =>
            setUrl(next ? { sort: next.key as typeof url.sort, dir: next.direction } : { sort: "" })
          }
          pager={{
            hasMore: projects.hasMore,
            loading: projects.loadingMore,
            onLoadMore: () => void projects.loadMore(),
          }}
        />
      </StatusView>
    </>
  );
}

export const routes: PortalRoute[] = [
  {
    path: "/",
    title: "Workspace home",
    element: <WorkspaceHome />,
    nav: { label: "Workspace home", section: "Workspace" },
  },
];
