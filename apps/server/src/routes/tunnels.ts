import type { TunnelInput } from "@testmaster/contracts";
import type { RouteContext, RouteModule } from "./types.js";

const id = (context: RouteContext): string => context.params.id as string;
/** Tunnels to a developer's loopback target (ADR-031); the session itself is an upgrade. */
export const tunnelRoutes: RouteModule = {
  handlers: {
    "GET /tunnels": ({ service, page }) => page(service.tunnels.list()),
    "POST /tunnels": ({ service, body }) => service.tunnels.create(body as TunnelInput),
    "GET /tunnels/{id}": (context) => context.service.tunnels.get(id(context)),
    "DELETE /tunnels/{id}": (context) => context.service.tunnels.revoke(id(context)),
  },
  // `POST /tunnels` keeps no idempotency receipt: the receipt would store the one-use open token.
  synchronous: ["DELETE /tunnels/{id}"],
};
