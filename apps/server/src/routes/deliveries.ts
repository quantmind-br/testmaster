import { ContractError, type NotificationType, notificationTypes } from "@testmaster/contracts";
import type { RouteContext, RouteModule } from "./types.js";

const id = (context: RouteContext): string => context.params.id as string;
const states = ["pending", "delivered", "dead_letter"] as const;
type DeliveryState = (typeof states)[number];

function stateFilter(value: string | undefined): DeliveryState | undefined {
  if (value === undefined) return undefined;
  const found = states.find((state) => state === value);
  if (!found)
    throw new ContractError("INVALID_ARGUMENT", "Unknown delivery state", { state: value });
  return found;
}
function typeFilter(value: string | undefined): NotificationType | undefined {
  if (value === undefined) return undefined;
  const found = notificationTypes.find((type) => type === value);
  if (!found)
    throw new ContractError("INVALID_ARGUMENT", "Unknown notification type", { type: value });
  return found;
}

/**
 * `/deliveries` serves both families side by side: GitHub check deliveries (`dlv_`) and
 * notification deliveries (`ntd_`). The ID prefix decides which service owns an ID.
 */
export const deliveryRoutes: RouteModule = {
  handlers: {
    "GET /deliveries": ({ service, query, page }) => {
      const state = stateFilter(query.state);
      const type = typeFilter(query.type);
      const checks =
        type || query.integrationId ? [] : service.delivery.list(state ? { state } : {});
      const notifications = service.notifications.list({
        ...(state ? { state } : {}),
        ...(type ? { type } : {}),
        ...(query.integrationId ? { integrationId: query.integrationId } : {}),
      });
      const merged = [...checks, ...notifications].sort((left, right) => {
        const l = String(left.createdAt);
        const r = String(right.createdAt);
        return l === r ? right.id.localeCompare(left.id) : r.localeCompare(l);
      });
      return page(merged);
    },
    "GET /deliveries/{id}": (context) => {
      const deliveryId = id(context);
      if (deliveryId.startsWith("ntd_")) return context.service.notifications.get(deliveryId);
      const found = context.service.delivery.list().find((item) => item.id === deliveryId);
      if (!found)
        throw new ContractError("NOT_FOUND", "Delivery does not exist", { id: deliveryId });
      return found;
    },
    "POST /deliveries/{id}/retry": (context) => {
      const deliveryId = id(context);
      return deliveryId.startsWith("ntd_")
        ? context.service.notifications.requeue(deliveryId)
        : context.service.delivery.requeue(deliveryId);
    },
  },
  synchronous: ["POST /deliveries/{id}/retry"],
};
