import { routes as audit } from "./audit";
import { routes as auth } from "./auth";
import { routes as authoring } from "./authoring";
import { routes as comparisons } from "./comparisons";
import { routes as dashboard } from "./dashboard";
import { routes as discovery } from "./discovery";
import { routes as featureMap } from "./feature-map";
import { routes as flaky } from "./flaky";
import { routes as healing } from "./healing";
import { routes as home } from "./home";
import { routes as lists } from "./lists";
import { routes as notifications } from "./notifications";
import { routes as onboarding } from "./onboarding";
import { routes as project } from "./project";
import { routes as quarantine } from "./quarantine";
import { routes as requirements } from "./requirements";
import { routes as retention } from "./retention";
import { routes as runs } from "./runs";
import { routes as schedules } from "./schedules";
import { routes as secrets } from "./secrets";
import { routes as settings } from "./settings";
import { routes as sources } from "./sources";
import { routes as team } from "./team";
import type { PortalRoute } from "./types";
import { routes as workers } from "./workers";

/** One line per area; slices append their `routes/<area>.tsx` here. */
export const portalRoutes: readonly PortalRoute[] = [
  ...home,
  ...project,
  ...retention,
  ...secrets,
  ...settings,
  ...onboarding,
  ...sources,
  ...discovery,
  ...requirements,
  ...featureMap,
  ...authoring,
  ...lists,
  ...schedules,
  ...team,
  ...audit,
  ...healing,
  ...dashboard,
  ...comparisons,
  ...flaky,
  ...quarantine,
  ...runs,
  ...notifications,
  ...workers,
  ...auth,
];
