import { routes as home } from "./home";
import { routes as project } from "./project";
import { routes as retention } from "./retention";
import { routes as secrets } from "./secrets";
import { routes as settings } from "./settings";
import type { PortalRoute } from "./types";

/** One line per area; slices append their `routes/<area>.tsx` here. */
export const portalRoutes: readonly PortalRoute[] = [
  ...home,
  ...project,
  ...retention,
  ...secrets,
  ...settings,
];
