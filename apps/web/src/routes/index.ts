import { routes as home } from "./home";
import { routes as lists } from "./lists";
import { routes as project } from "./project";
import { routes as schedules } from "./schedules";
import type { PortalRoute } from "./types";

/** One line per area; slices append their `routes/<area>.tsx` here. */
export const portalRoutes: readonly PortalRoute[] = [...home, ...project, ...lists, ...schedules];
