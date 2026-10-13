import { routes as comparisons } from "./comparisons";
import { routes as dashboard } from "./dashboard";
import { routes as flaky } from "./flaky";
import { routes as healing } from "./healing";
import { routes as home } from "./home";
import { routes as project } from "./project";
import { routes as quarantine } from "./quarantine";
import { routes as runs } from "./runs";
import type { PortalRoute } from "./types";

/** One line per area; slices append their `routes/<area>.tsx` here. */
export const portalRoutes: readonly PortalRoute[] = [
  ...home,
  ...project,
  ...healing,
  ...dashboard,
  ...comparisons,
  ...flaky,
  ...quarantine,
  ...runs,
];
