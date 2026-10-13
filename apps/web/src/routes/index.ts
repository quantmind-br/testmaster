import { routes as github } from "./github";
import { routes as home } from "./home";
import { routes as project } from "./project";
import type { PortalRoute } from "./types";

/** One line per area; slices append their `routes/<area>.tsx` here. */
export const portalRoutes: readonly PortalRoute[] = [...home, ...project, ...github];
