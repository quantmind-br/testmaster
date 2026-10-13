import type { ReactNode } from "react";
import { useMe } from "../components/app-shell";
import { ProjectPage } from "../features/project-page";
import { RetentionPage } from "../features/retention/retention";
import type { PortalRoute } from "./types";

function Retention(): ReactNode {
  const me = useMe();
  return (
    <ProjectPage title="Retention and deletion">
      {(project, etag, reload) => (
        <RetentionPage project={project} etag={etag} me={me} reloadProject={reload} />
      )}
    </ProjectPage>
  );
}

export const routes: PortalRoute[] = [
  {
    path: "/projects/:projectId/retention",
    title: "Retention and deletion",
    element: <Retention />,
    projectNav: { label: "Retention", order: 110 },
  },
];
