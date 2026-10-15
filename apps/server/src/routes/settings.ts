import { ContractError, type SecretRotationInput } from "@testmaster/contracts";
import type { RouteContext, RouteModule } from "./types.js";

/** `POST /projects/{id}/purge` body, validated against the catalog `ConfirmationInput`. */
interface PurgeBody {
  confirmationToken: string;
}
const id = (context: RouteContext): string => context.params.id as string;
/**
 * Portal settings: secret rotation and history, project purge, deletion operations, model providers
 * and environment revisions (S5b). Every handler is a thin call into one service method.
 */
export const settingsRoutes: RouteModule = {
  handlers: {
    // Rotation stores the new value before the receipt commits (an async keychain write), so the
    // service owns the Idempotency-Key exactly as `POST /secrets` does; a replay never rotates twice.
    "POST /secrets/{id}/rotate": (context) => {
      const input = context.body as SecretRotationInput;
      return context.service.secrets.rotate(
        id(context),
        input.value,
        context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {},
      );
    },
    "GET /secrets/{id}/history": (context) =>
      context.page(context.service.secrets.history(id(context))),
    "POST /projects/{id}/purge": (context) => {
      const input = context.body as PurgeBody;
      return context.service.retention.purgeProject(id(context), input.confirmationToken);
    },
    "GET /deletion-operations": (context) => {
      const projectId = context.query.projectId;
      if (projectId !== undefined && !projectId)
        throw new ContractError("INVALID_ARGUMENT", "projectId must not be empty");
      return context.page(
        context.service.retention.listDeletionOperations(projectId ? { projectId } : {}),
      );
    },
    "GET /projects/{id}/model-providers": (context) => context.service.model.settings(id(context)),
    "GET /environments/{id}/revisions": (context) =>
      context.page(context.service.environments.revisions(id(context))),
  },
  synchronous: ["POST /projects/{id}/purge"],
};
