import type {
  ScheduleInput,
  SchedulePatchInput,
  SchedulePreviewInput,
} from "@testmaster/contracts";
import type { RouteContext, RouteModule } from "./types.js";

const id = (context: RouteContext): string => context.params.id as string;
/** Revisioned schedules with their firing history (REQ-035, OPS-016…019). */
export const scheduleRoutes: RouteModule = {
  handlers: {
    "GET /schedules": ({ service, page }) => page(service.schedules.list()),
    "POST /schedules": ({ service, body }) => service.schedules.create(body as ScheduleInput),
    "POST /schedules/preview": ({ service, body }) =>
      service.schedules.preview(body as SchedulePreviewInput),
    "GET /schedules/{id}": (context) => context.service.schedules.get(id(context)),
    "DELETE /schedules/{id}": (context) =>
      context.service.schedules.archive(id(context), context.ifMatch()),
    "PATCH /schedules/{id}": (context) =>
      context.service.schedules.update(
        id(context),
        context.body as SchedulePatchInput,
        context.ifMatch(),
      ),
    "POST /schedules/{id}/pause": (context) =>
      context.service.schedules.pause(id(context), context.ifMatch()),
    "POST /schedules/{id}/resume": (context) =>
      context.service.schedules.resume(id(context), context.ifMatch()),
    "GET /schedules/{id}/revisions": (context) =>
      context.page(context.service.schedules.revisions(id(context))),
    "GET /schedules/{id}/firings": (context) =>
      context.page(context.service.schedules.firings(id(context))),
  },
  synchronous: [
    "POST /schedules",
    "PATCH /schedules/{id}",
    "DELETE /schedules/{id}",
    "POST /schedules/{id}/pause",
    "POST /schedules/{id}/resume",
  ],
  status: { "POST /schedules": 201 },
};
