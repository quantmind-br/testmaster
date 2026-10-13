import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { useSelectContext } from "../components/portal-context";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView } from "../components/view-state";
import { usePageTitle } from "../hooks/use-page-title";
import { useResource } from "../hooks/use-resource";
import type { ProjectSummary } from "../routes/home";
import { NotFoundPage } from "../routes/not-found";

interface ProjectPageProps {
  readonly title: string;
  readonly children: (
    project: ProjectSummary,
    etag: string | null,
    reload: () => Promise<void>,
  ) => ReactNode;
}

/**
 * Loads the project named by the URL, publishes it to the context bar and renders the page body.
 * A project that does not exist and one the caller may not see render the same not-found page.
 */
export function ProjectPage({ title, children }: ProjectPageProps): ReactNode {
  const { projectId = "" } = useParams();
  const project = useResource<ProjectSummary>(`/projects/${encodeURIComponent(projectId)}`);
  useSelectContext(project.data ? { id: project.data.id, name: project.data.name } : null);
  usePageTitle(
    project.status === "not-found" ? "Not found" : `${title} · ${project.data?.name ?? "Project"}`,
  );
  if (project.status === "not-found") return <NotFoundPage />;
  return (
    <StatusView status={project.status} error={project.error} onRetry={() => void project.reload()}>
      {project.data ? (
        <>
          <p>
            <Link to={`/projects/${encodeURIComponent(project.data.id)}`}>
              <UntrustedText value={project.data.name} maxLength={120} />
            </Link>
          </p>
          <h1>{title}</h1>
          {children(project.data, project.etag, () => project.reload())}
        </>
      ) : null}
    </StatusView>
  );
}
