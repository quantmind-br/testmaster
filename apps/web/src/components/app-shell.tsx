import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  matchPath,
  NavLink,
  Outlet,
  useLoaderData,
  useLocation,
  useNavigate,
  useOutletContext,
} from "react-router";
import { logout, type Me } from "../api/session";
import { siteName } from "../hooks/use-page-title";
import type { PortalRoute } from "../routes/types";
import { DemoBanner } from "./demo-banner";
import { useAnnounce } from "./live-region";
import { usePortalContext } from "./portal-context";

/** Workspace, project and environment stay visible on every page. */
export function ContextBar({ me }: { me: Me }): ReactNode {
  const { project, environment } = usePortalContext();
  return (
    <ul className="context-bar" aria-label="Current context" data-testid="context-bar">
      <li>
        <span className="label">Workspace</span>
        <strong>{me.workspace.name}</strong>
      </li>
      <li>
        <span className="label">Project</span>
        <strong>{project ? project.name : "None selected"}</strong>
      </li>
      <li>
        <span className="label">Environment</span>
        <strong>{environment ? environment.name : "None selected"}</strong>
      </li>
    </ul>
  );
}

function groupNavigation(routes: readonly PortalRoute[]): [string, PortalRoute[]][] {
  const sections = new Map<string, PortalRoute[]>();
  for (const route of routes) {
    if (!route.nav) continue;
    const group = sections.get(route.nav.section) ?? [];
    group.push(route);
    sections.set(route.nav.section, group);
  }
  return [...sections];
}

/** Project pages share a sub-navigation: routes under `/projects/:projectId/` that declare `projectNav`. */
export function projectNavigation(
  routes: readonly PortalRoute[],
  pathname: string,
): { id: string; links: { label: string; path: string }[] } | null {
  const match = matchPath({ path: "/projects/:projectId", end: false }, pathname);
  const id = match?.params.projectId;
  if (!id) return null;
  const links = routes
    .flatMap((route) => (route.projectNav ? [{ ...route.projectNav, route }] : []))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
    .map(({ label, route }) => ({
      label,
      path: route.path.replace(":projectId", encodeURIComponent(id)),
    }));
  return { id, links };
}

export function AppShell({ routes }: { routes: readonly PortalRoute[] }): ReactNode {
  const me = useLoaderData() as Me;
  const location = useLocation();
  const navigate = useNavigate();
  const announce = useAnnounce();
  const project = projectNavigation(routes, location.pathname);
  const main = useRef<HTMLElement>(null);
  const firstRender = useRef(true);
  const [signingOut, setSigningOut] = useState(false);

  // Move focus to the page and announce its title after every navigation, except the first load.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only pathname changes are navigations
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    main.current?.focus({ preventScroll: false });
    announce(document.title.replace(` — ${siteName}`, ""));
  }, [location.pathname]);

  async function signOut(): Promise<void> {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
    } finally {
      navigate("/login", { replace: true });
    }
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <DemoBanner workspace={me.workspace} />
      <header className="shell-header">
        <NavLink to="/" className="brand">
          {siteName}
        </NavLink>
        <ContextBar me={me} />
        <div>
          <span>{me.principal.displayName}</span>{" "}
          <button
            type="button"
            className="button secondary"
            aria-disabled={signingOut}
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      </header>
      <div className="shell-body">
        <nav className="shell-nav" aria-label="Primary">
          {groupNavigation(routes).map(([section, entries]) => (
            <section key={section} aria-label={section}>
              <h2>{section}</h2>
              <ul>
                {entries.map((route) => (
                  <li key={route.path}>
                    <NavLink to={route.path} end={route.path === "/"}>
                      {route.nav?.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {project ? (
            <section aria-label="Project" data-testid="project-nav">
              <h2>Project</h2>
              <ul>
                <li>
                  <NavLink to={`/projects/${encodeURIComponent(project.id)}`} end>
                    Overview
                  </NavLink>
                </li>
                {project.links.map((link) => (
                  <li key={link.path}>
                    <NavLink to={link.path}>{link.label}</NavLink>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </nav>
        <main id="main" className="shell-main" tabIndex={-1} ref={main}>
          <Outlet context={me} />
        </main>
      </div>
    </div>
  );
}

/** The signed-in identity, available to every page rendered inside the shell. */
export function useMe(): Me {
  return useOutletContext<Me>();
}
