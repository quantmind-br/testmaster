import type {
  IssueImportInput,
  IssueLinkDraftInput,
  IssueLinkExecuteInput,
} from "@testmaster/contracts";
import { ContractError } from "@testmaster/contracts";
import type { RouteContext, RouteModule } from "./types.js";

const id = (context: RouteContext): string => context.params.id as string;
/**
 * Issue trackers (ADR-034): tickets enter as sources, failed Runs become drafts, and an issue is
 * created only through preview, the previewed hash and an acknowledgement.
 */
export const trackerRoutes: RouteModule = {
  handlers: {
    "POST /integrations/{id}/issues/import": (context) =>
      context.service.trackers.import(id(context), context.body as IssueImportInput),
    "GET /issue-links": ({ service, query, page }) => {
      if (!query.runId && !query.projectId)
        throw new ContractError("INVALID_ARGUMENT", "runId or projectId is required", {
          field: "projectId",
        });
      return page(
        service.trackers.list({
          ...(query.runId ? { runId: query.runId } : {}),
          ...(query.projectId ? { projectId: query.projectId } : {}),
        }),
      );
    },
    "POST /issue-links": ({ service, body }) => service.trackers.draft(body as IssueLinkDraftInput),
    "POST /issue-links/{id}/preview": (context) => context.service.trackers.preview(id(context)),
    "POST /issue-links/{id}/execute": (context) =>
      context.service.trackers.execute(id(context), context.body as IssueLinkExecuteInput),
    "POST /projects/{id}/issue-links/sync": (context) => context.service.trackers.sync(id(context)),
  },
  // Drafting and previewing touch no tracker, so they keep an idempotency receipt; the others
  // call out over the network and must not hold a database transaction while they wait.
  synchronous: ["POST /issue-links", "POST /issue-links/{id}/preview"],
};
