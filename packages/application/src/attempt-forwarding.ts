import { type PersistenceDatabase, StaleFenceError } from "@testmaster/persistence";
import { liveController, NO_INTERNAL_ORIGIN } from "./controller-instances.js";
import { holderOf, type RemoteAttemptRoute } from "./remote-attempt-routes.js";
import type { RelayAttempt } from "./tunnel-relay.js";

/** A live controller another controller may forward a worker's call to (ADR-035). */
export interface ForwardTarget {
  controllerId: string;
  /** Bare origin of the controller's internal listener; never the public origin. */
  internalOrigin: string;
}

/** Header a forwarded request carries: it names the forwarder and only ever suppresses forwarding. */
export const FORWARDED_HEADER = "x-testmaster-forwarded";

/** A controller is a target only while it is live and has a reachable internal origin. */
function liveTarget(database: PersistenceDatabase, controllerId: string): ForwardTarget | null {
  const controller = liveController(database, controllerId);
  if (!controller || controller.internalOrigin === NO_INTERNAL_ORIGIN) return null;
  return { controllerId, internalOrigin: controller.internalOrigin };
}

/**
 * Where a worker's call for an Attempt this controller does not hold must go: the live controller
 * that recorded the Attempt as active. Null (answer locally: `lease_lost`) when no controller
 * recorded it, the Attempt ended, this controller is the holder, or the holder is not live.
 * `database` needs the `"*"` scope.
 */
export function attemptForwardTarget(
  database: PersistenceDatabase,
  ownId: string,
  attemptId: string,
): ForwardTarget | null {
  const route = holderOf(database, attemptId);
  if (route?.state !== "active" || route.controllerId === ownId) return null;
  return liveTarget(database, route.controllerId);
}

/**
 * Where a worker stream for an Attempt must go: the live controller whose relay holds the session
 * of the tunnel the Attempt's Run was admitted through. Null (answer locally) when this controller
 * is that relay or the Attempt, the tunnel or the relay is not there.
 */
export function tunnelStreamForwardTarget(
  database: PersistenceDatabase,
  ownId: string,
  attemptId: string,
  runTunnel: (route: RemoteAttemptRoute) => string | undefined,
): ForwardTarget | null {
  const route = holderOf(database, attemptId);
  if (route?.state !== "active") return null;
  const tunnelId = runTunnel(route);
  if (!tunnelId) return null;
  const relay = database.get(
    "SELECT relay_id FROM tunnels WHERE workspace_id=? AND id=? AND state='active'",
    route.workspaceId,
    tunnelId,
  )?.relay_id;
  if (typeof relay !== "string" || relay === ownId) return null;
  return liveTarget(database, relay);
}

/** How often a relay that does not hold an Attempt re-reads its lease. */
export const ROUTED_ATTEMPT_POLL_MS = 1000;

/**
 * The relay's view of an Attempt another controller holds (ADR-035). The `AttemptSession` cannot
 * move, but the Attempt's validity is in the database: its route is `active` and the lease it
 * claimed under is leased to the same worker, unexpired, under the same fence. `released` aborts
 * within one poll of either ending; `dispose` stops the poll.
 */
export function routedRelayAttempt(
  database: PersistenceDatabase,
  ownId: string,
  attemptId: string,
): RelayAttempt | undefined {
  const route = holderOf(database, attemptId);
  if (route?.state !== "active" || route.controllerId === ownId) return undefined;
  const assertCurrent = (): void => {
    const current = holderOf(database, attemptId);
    const leased =
      current &&
      current.state === "active" &&
      current.controllerId === route.controllerId &&
      current.fence === route.fence &&
      database.get(
        "SELECT 1 AS valid FROM job_leases j JOIN attempts a ON a.workspace_id=j.workspace_id AND a.job_id=j.id AND a.fence=j.fence WHERE a.workspace_id=? AND a.id=? AND j.lease_owner=? AND j.fence=? AND j.state='leased' AND j.dispatchable=1 AND j.lease_expires_at>?",
        route.workspaceId,
        attemptId,
        `remote:${route.workerId}`,
        route.fence,
        new Date().toISOString(),
      );
    if (!leased) throw new StaleFenceError();
  };
  const released = new AbortController();
  let poll: NodeJS.Timeout | null = null;
  return {
    workerId: route.workerId,
    workspaceId: route.workspaceId,
    runId: route.runId,
    settled: false,
    released: released.signal,
    assertCurrent,
    watch() {
      poll ??= setInterval(() => {
        try {
          assertCurrent();
        } catch (error) {
          // A lapsed lease ends the hold; a database failure is not proof of that and is retried.
          if (error instanceof StaleFenceError) released.abort();
        }
      }, ROUTED_ATTEMPT_POLL_MS);
      poll.unref();
    },
    dispose() {
      clearInterval(poll ?? undefined);
      poll = null;
    },
  };
}
