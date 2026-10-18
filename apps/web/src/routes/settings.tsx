import type { ReactNode } from "react";
import { useMe } from "../components/app-shell";
import { ProjectPage } from "../features/project-page";
import { EnvironmentsSection } from "../features/settings/environments";
import { LimitsSection } from "../features/settings/limits";
import { LlmSection } from "../features/settings/llm";
import { UsageSection } from "../features/settings/usage";
import type { PortalRoute } from "./types";

function ProjectSettings(): ReactNode {
  const me = useMe();
  return (
    <ProjectPage title="Project settings">
      {(project, etag, reload) => (
        <>
          <EnvironmentsSection
            project={project}
            projectEtag={etag}
            me={me}
            reloadProject={reload}
          />
          <LlmSection project={project} />
          <UsageSection project={project} />
          <LimitsSection />
        </>
      )}
    </ProjectPage>
  );
}

export const routes: PortalRoute[] = [
  {
    path: "/projects/:projectId/settings",
    title: "Project settings",
    element: <ProjectSettings />,
    projectNav: { label: "Settings", order: 100 },
  },
];
