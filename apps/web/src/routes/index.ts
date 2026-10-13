import { routes as audit } from "./audit";
import { routes as home } from "./home";
import { routes as project } from "./project";
import { routes as team } from "./team";
import type { PortalRoute } from "./types";

/** One line per area; slices append their `routes/<area>.tsx` here. */
export const portalRoutes: readonly PortalRoute[] = [...home, ...project, ...team, ...audit];
