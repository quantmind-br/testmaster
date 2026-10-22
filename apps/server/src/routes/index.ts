import { routeCatalog } from "@testmaster/contracts";
import { artifactGatewayRoutes } from "./artifact-gateway.js";
import { auditRoutes } from "./audit.js";
import { authRoutes } from "./auth.js";
import { authoringRoutes } from "./authoring.js";
import { coreRoutes } from "./core.js";
import { deliveryRoutes } from "./deliveries.js";
import { eventRoutes } from "./events.js";
import { githubRoutes } from "./github.js";
import { identityRoutes } from "./identity.js";
import { integrationRoutes } from "./integrations.js";
import { onboardingRoutes } from "./onboarding.js";
import { operationsRoutes } from "./operations.js";
import { runViewRoutes } from "./run-views.js";
import { scheduleRoutes } from "./schedules.js";
import { settingsRoutes } from "./settings.js";
import { suiteRoutes } from "./suites.js";
import { tunnelRoutes } from "./tunnels.js";
import type { RouteHandler, RouteModule } from "./types.js";
import { visualBaselineRoutes } from "./visual-baselines.js";
import { workerRoutes } from "./workers.js";

export type { RouteContext, RouteHandler, RouteModule } from "./types.js";
export const routeModules: RouteModule[] = [
  coreRoutes,
  eventRoutes,
  identityRoutes,
  githubRoutes,
  integrationRoutes,
  settingsRoutes,
  onboardingRoutes,
  authoringRoutes,
  scheduleRoutes,
  suiteRoutes,
  auditRoutes,
  artifactGatewayRoutes,
  runViewRoutes,
  deliveryRoutes,
  workerRoutes,
  tunnelRoutes,
  visualBaselineRoutes,
  authRoutes,
  operationsRoutes,
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
  const catalog = new Map(routeCatalog.map((route) => [`${route.method} ${route.path}`, route]));
  const table = new Map<string, ResolvedRoute>();
  for (const module of modules) {
    for (const [key, handler] of Object.entries(module.handlers)) {
      const route = catalog.get(key);
      if (!route) throw new Error(`Route handler ${key} is not in the route catalog`);
      if (route.response.kind === "unavailable")
        throw new Error(`Route handler ${key} is catalogued as unavailable`);
      if (table.has(key)) throw new Error(`Route ${key} is claimed by more than one module`);
      table.set(key, {
        handler,
        synchronous: module.synchronous?.includes(key) ?? false,
        status: route.response.status,
      });
    }
    for (const key of module.synchronous ?? [])
      if (!(key in module.handlers))
        throw new Error(`Synchronous route ${key} has no handler in its module`);
  }
  return table;
}
