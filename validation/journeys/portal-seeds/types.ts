import type { ServerStack } from "../server-stack.js";
import type { HttpsClient } from "../tls-proxy.js";

/**
 * What a seeder sees. `client` is the signed-in workspace owner (cookie session plus CSRF);
 * `remember`/`recall` share ids between seeders of one sweep run (for example a project id).
 */
export interface SweepContext {
  readonly stack: ServerStack;
  readonly client: HttpsClient;
  remember(key: string, value: string): void;
  recall(key: string): string | undefined;
}

/**
 * One slice's contribution to the portal accessibility sweep
 * (`portal-accessibility.portal.test.ts`). The sweep discovers pages from
 * `apps/web/src/routes/index.ts`; it never lists routes itself. A slice adds one file
 * `validation/journeys/portal-seeds/<area>.ts` that default-exports a `SweepSeed`; the loader
 * picks every file in this directory, so no shared file changes when a slice adds pages.
 */
export interface SweepSeed {
  /**
   * Resolvers for route parameters by name without the colon (`projectId`, `runId`, ...). A
   * resolver creates whatever data it needs and returns a real id. Two seeds must not resolve the
   * same parameter.
   */
  readonly params?: Readonly<Record<string, (context: SweepContext) => Promise<string>>>;
  /**
   * Extra data a page needs, keyed by the route path exactly as declared in its
   * `PortalRoute.path`. Runs once, before the page is first visited.
   */
  readonly routes?: Readonly<Record<string, (context: SweepContext) => Promise<void>>>;
  /**
   * Route paths that are visited with a nonexistent id because no real one can exist in the sweep
   * stack, each with the reason. A parametrised route that is neither resolvable nor listed here
   * fails the sweep, so a new page can never silently skip its checks.
   */
  readonly allowUnseeded?: Readonly<Record<string, string>>;
  /**
   * Route paths whose generic loading/error/forbidden interception is skipped, with the reason
   * (for example a page that renders no remote data).
   */
  readonly skipStateChecks?: Readonly<Record<string, string>>;
}
