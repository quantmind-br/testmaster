import type { WorkerEnrollmentInput } from "@testmaster/contracts";
import type { RouteContext, RouteModule } from "./types.js";

const id = (context: RouteContext): string => context.params.id as string;

/** Worker pool administration: enrollment (one-use token), inventory, drain and revoke. */
export const workerRoutes: RouteModule = {
  handlers: {
    "GET /workers": ({ service, page }) => page(service.workerPool.list()),
    "POST /workers": ({ service, body }) =>
      service.workerPool.createEnrollment(body as WorkerEnrollmentInput),
    "GET /workers/{id}": (context) => context.service.workerPool.get(id(context)),
    "POST /workers/{id}/drain": (context) => context.service.workerPool.drain(id(context)),
    "POST /workers/{id}/revoke": (context) => context.service.workerPool.revoke(id(context)),
  },
  synchronous: ["POST /workers", "POST /workers/{id}/drain", "POST /workers/{id}/revoke"],
  status: { "POST /workers": 201 },
};
