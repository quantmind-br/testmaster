import { routes as home } from "./home";
import { routes as notifications } from "./notifications";
import { routes as project } from "./project";
import type { PortalRoute } from "./types";
import { routes as workers } from "./workers";

/** One line per area; slices append their `routes/<area>.tsx` here. */
export const portalRoutes: readonly PortalRoute[] = [
  ...home,
  ...project,
  ...notifications,
  ...workers,
];
