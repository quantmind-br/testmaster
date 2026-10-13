import type { SuiteInput, SuitePatchInput, SuiteRunInput } from "@testmaster/contracts";
import type { RouteContext, RouteModule } from "./types.js";

const id = (context: RouteContext): string => context.params.id as string;
/** Lists: ordered, cross-project sets of tests with an explicit environment per project (REQ-034). */
export const suiteRoutes: RouteModule = {
  handlers: {
    "GET /suites": ({ service, page }) => page(service.suites.list()),
    "POST /suites": ({ service, body }) => service.suites.create(body as SuiteInput),
    "POST /suites/preview": ({ service, body }) => service.suites.preview(body as SuiteInput),
    "GET /suites/{id}": (context) => context.service.suites.get(id(context)),
    "DELETE /suites/{id}": (context) =>
      context.service.suites.archive(id(context), context.ifMatch()),
    "PATCH /suites/{id}": (context) =>
      context.service.suites.update(
        id(context),
        context.body as SuitePatchInput,
        context.ifMatch(),
      ),
    "GET /suites/{id}/expansion": (context) => context.service.suites.expansion(id(context)),
    "POST /suites/{id}/runs": (context) =>
      context.service.suites.run(id(context), (context.body ?? {}) as SuiteRunInput, {
        origin: "api",
        ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
      }),
  },
  synchronous: ["POST /suites", "PATCH /suites/{id}", "DELETE /suites/{id}"],
  status: { "POST /suites": 201, "POST /suites/{id}/runs": 202 },
};
