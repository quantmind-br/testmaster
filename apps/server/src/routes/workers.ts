import type { WorkerHeartbeat } from "@testmaster/application";
import {
  ContractError,
  parseStrictJson,
  validate,
  type WorkerEnrollmentInput,
} from "@testmaster/contracts";
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
    // Authenticated by the worker credential itself; no session, cookie or user token is read.
    "POST /workers/{id}/heartbeat": (context) => {
      const header = context.request.headers.authorization;
      const token =
        typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!context.rawBody) throw new ContractError("INVALID_ARGUMENT", "A JSON body is required");
      const body = parseStrictJson(context.rawBody, 4096);
      validate("HeartbeatInput", body);
      return context.service
        .controllerScope()
        .workerPool.heartbeat(token, id(context), body as WorkerHeartbeat);
    },
  },
  synchronous: ["POST /workers", "POST /workers/{id}/drain", "POST /workers/{id}/revoke"],
  status: { "POST /workers": 201 },
};
