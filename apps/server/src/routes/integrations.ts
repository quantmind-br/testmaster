import type { IntegrationInput, IntegrationPatchInput } from "@testmaster/contracts";
import type { RouteContext, RouteModule } from "./types.js";

const id = (context: RouteContext): string => context.params.id as string;
/** Integration configuration, labelled test deliveries and the signed inbound webhook intake (C5). */
export const integrationRoutes: RouteModule = {
  handlers: {
    "GET /integrations": ({ service, page }) => page(service.integrations.list()),
    "POST /integrations": ({ service, body }) =>
      service.integrations.create(body as IntegrationInput),
    "PATCH /integrations/{id}": (context) =>
      context.service.integrations.update(
        id(context),
        context.body as IntegrationPatchInput,
        context.ifMatch(),
      ),
    "POST /integrations/{id}/test": (context) => context.service.integrations.test(id(context)),
    // Signature route: no bearer or cookie. The provider adapter verifies the signature over the
    // raw bytes, and intake spans every workspace, so it runs in the controller scope.
    "POST /integrations/{provider}/webhooks": (context) =>
      context.service
        .controllerScope()
        .integrations.receiveWebhook(context.params.provider as string, {
          headers: context.request.headers,
          rawBody: context.rawBody ?? Buffer.alloc(0),
        }),
  },
  synchronous: ["POST /integrations", "PATCH /integrations/{id}"],
};
