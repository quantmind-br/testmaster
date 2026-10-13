import { type ReactNode, StrictMode } from "react";
import { createBrowserRouter, Outlet, type RouteObject, redirect } from "react-router";
import { RouterProvider } from "react-router/dom";
import { ApiError, setUnauthenticatedHandler } from "./api";
import { loadMe } from "./api/session";
import { AppShell } from "./components/app-shell";
import { LiveRegionProvider } from "./components/live-region";
import { PortalContextProvider } from "./components/portal-context";
import { ViewState } from "./components/view-state";
import { portalRoutes } from "./routes";
import { LoginPage, loginLoader } from "./routes/login";
import { NotFoundPage } from "./routes/not-found";
import { RecoverPage } from "./routes/recover";
import type { PortalRoute } from "./routes/types";

/** Sends an anonymous visitor to the login page and returns them to the same address after. */
export async function sessionLoader({ request }: { request: Request }) {
  try {
    return await loadMe();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      const url = new URL(request.url);
      throw redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    }
    throw error;
  }
}

function Providers(): ReactNode {
  return (
    <LiveRegionProvider>
      <PortalContextProvider>
        <Outlet />
      </PortalContextProvider>
    </LiveRegionProvider>
  );
}

function LoadFailure(): ReactNode {
  return (
    <main id="main" className="centered">
      <h1>TestMaster</h1>
      <ViewState
        kind="error"
        message="The portal could not load your session."
        onRetry={() => window.location.reload()}
      />
    </main>
  );
}

export function toRouteObjects(routes: readonly PortalRoute[]): RouteObject[] {
  return routes.map((route) =>
    route.path === "/"
      ? { index: true, element: route.element, handle: { title: route.title } }
      : {
          path: route.path.replace(/^\//, ""),
          element: route.element,
          handle: { title: route.title },
        },
  );
}

export function createRoutes(routes: readonly PortalRoute[] = portalRoutes): RouteObject[] {
  return [
    {
      element: <Providers />,
      hydrateFallbackElement: (
        <main id="main" className="centered">
          <ViewState kind="loading" />
        </main>
      ),
      errorElement: <LoadFailure />,
      children: [
        { path: "/login", loader: loginLoader, element: <LoginPage /> },
        { path: "/recover", element: <RecoverPage /> },
        {
          id: "session",
          path: "/",
          loader: sessionLoader,
          element: <AppShell routes={routes} />,
          children: [...toRouteObjects(routes), { path: "*", element: <NotFoundPage /> }],
        },
      ],
    },
  ];
}

export function App(): ReactNode {
  const router = createBrowserRouter(createRoutes());
  // A 401 in the middle of a session (expiry, revoked session) returns to login, keeping the page.
  setUnauthenticatedHandler(() => {
    const here = window.location.pathname + window.location.search;
    if (!/^\/(login|recover)/.test(here))
      void router.navigate(`/login?next=${encodeURIComponent(here)}`, { replace: true });
  });
  return (
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>
  );
}
