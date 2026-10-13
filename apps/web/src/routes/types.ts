import type { ReactNode } from "react";

/**
 * A page contributed to the shell. Slices add `routes/<area>.tsx` exporting `routes: PortalRoute[]`
 * and one line in `routes/index.ts`. `path` is absolute ("/projects/:projectId"); the shell turns
 * "/" into the index route.
 */
export interface PortalRoute {
  readonly path: string;
  readonly title: string;
  readonly element: ReactNode;
  readonly nav?: { readonly label: string; readonly section: string };
  /** Entry in the project sub-navigation for routes under /projects/:projectId/. */
  readonly projectNav?: { readonly label: string; readonly order: number };
}
