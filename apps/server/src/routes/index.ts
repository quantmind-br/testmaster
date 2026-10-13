import { routeCatalog } from "@testmaster/contracts";
import { authoringRoutes } from "./authoring.js";
import { coreRoutes } from "./core.js";
import { eventRoutes } from "./events.js";
import { identityRoutes } from "./identity.js";
import { integrationRoutes } from "./integrations.js";
import { onboardingRoutes } from "./onboarding.js";
import { scheduleRoutes } from "./schedules.js";
import { settingsRoutes } from "./settings.js";
import { suiteRoutes } from "./suites.js";
import type { RouteHandler, RouteModule } from "./types.js";

export type { RouteContext, RouteHandler, RouteModule } from "./types.js";
export const routeModules: RouteModule[] = [
  coreRoutes,
  eventRoutes,
  identityRoutes,
  integrationRoutes,
  settingsRoutes,
  onboardingRoutes,
  authoringRoutes,
  scheduleRoutes,
  suiteRoutes,
];
export interface ResolvedRoute {
  handler: RouteHandler;
  synchronous: boolean;
  status: number;
}
/** Merges modules into one key table; a duplicated or unknown key is a programming error. */
export function buildRouteTable(
  modules: readonly RouteModule[] = routeModules,
): Map<string, ResolvedRoute> {
  const known = new Set(routeCatalog.map((route) => `${route.method} ${route.path}`));
  const table = new Map<string, ResolvedRoute>();
  for (const module of modules) {
    for (const [key, handler] of Object.entries(module.handlers)) {
      if (!known.has(key)) throw new Error(`Route handler ${key} is not in the route catalog`);
      if (table.has(key)) throw new Error(`Route ${key} is claimed by more than one module`);
      table.set(key, {
        handler,
        synchronous: module.synchronous?.includes(key) ?? false,
        status: module.status?.[key] ?? 200,
      });
    }
    for (const key of module.synchronous ?? [])
      if (!(key in module.handlers))
        throw new Error(`Synchronous route ${key} has no handler in its module`);
  }
  return table;
}
