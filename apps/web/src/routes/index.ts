import { routes as discovery } from "./discovery";
import { routes as featureMap } from "./feature-map";
import { routes as home } from "./home";
import { routes as onboarding } from "./onboarding";
import { routes as project } from "./project";
import { routes as requirements } from "./requirements";
import { routes as sources } from "./sources";
import type { PortalRoute } from "./types";

/** One line per area; slices append their `routes/<area>.tsx` here. */
export const portalRoutes: readonly PortalRoute[] = [
  ...home,
  ...project,
  ...onboarding,
  ...sources,
  ...discovery,
  ...requirements,
  ...featureMap,
];
