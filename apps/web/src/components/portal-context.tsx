import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

export interface Selection {
  readonly id: string;
  readonly name: string;
}

interface PortalContextValue {
  readonly project: Selection | null;
  readonly environment: Selection | null;
  setProject(selection: Selection | null): void;
  setEnvironment(selection: Selection | null): void;
}

const Context = createContext<PortalContextValue | null>(null);

/** Holds the project and environment shown in the always-visible context bar. */
export function PortalContextProvider({ children }: { children: ReactNode }): ReactNode {
  const [project, setProject] = useState<Selection | null>(null);
  const [environment, setEnvironment] = useState<Selection | null>(null);
  const value = useMemo(
    () => ({ project, environment, setProject, setEnvironment }),
    [project, environment],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function usePortalContext(): PortalContextValue {
  const value = useContext(Context);
  if (!value) throw new Error("PortalContextProvider is missing");
  return value;
}

/** Declares the project (and optional environment) the page is about, for the context bar. */
export function useSelectContext(
  project: Selection | null,
  environment: Selection | null = null,
): void {
  const { setProject, setEnvironment } = usePortalContext();
  const projectId = project?.id ?? null;
  const projectName = project?.name ?? null;
  const environmentId = environment?.id ?? null;
  const environmentName = environment?.name ?? null;
  useEffect(() => {
    setProject(projectId === null ? null : { id: projectId, name: projectName ?? projectId });
    setEnvironment(
      environmentId === null ? null : { id: environmentId, name: environmentName ?? environmentId },
    );
    return () => {
      setProject(null);
      setEnvironment(null);
    };
  }, [projectId, projectName, environmentId, environmentName, setProject, setEnvironment]);
}
