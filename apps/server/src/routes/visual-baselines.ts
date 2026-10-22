import type { VisualBaselineCreateInput } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import type { RouteContext, RouteModule } from "./types.js";

const id = (context: RouteContext): string => context.params.id as string;
/** Visual baselines (ADR-032): drafts from a Run's captured image, approved by another principal. */
export const visualBaselineRoutes: RouteModule = {
  handlers: {
    "GET /visual-baselines": ({ service, query, page }) => {
      if (!query.projectId)
        throw new ContractError("INVALID_ARGUMENT", "projectId is required", {
          field: "projectId",
        });
      return page(
        service.visualBaselines.list({
          projectId: query.projectId,
          ...(query.testId ? { testId: query.testId } : {}),
        }),
      );
    },
    "POST /visual-baselines": ({ service, body }) =>
      service.visualBaselines.create(body as VisualBaselineCreateInput),
    "POST /visual-baselines/{id}/approve": (context) =>
      context.service.visualBaselines.approve(
        id(context),
        context.body as { expectedVersion: number },
      ),
  },
  // Creating reads evidence asynchronously, so only approval keeps an idempotency receipt.
  synchronous: ["POST /visual-baselines/{id}/approve"],
};
