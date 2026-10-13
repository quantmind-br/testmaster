import {
  ContractError,
  type ModelConsentInput,
  type SecretRotationInput,
} from "@testmaster/contracts";
import type { RouteContext, RouteModule } from "./types.js";

/** `POST /projects/{id}/purge` body, validated against the catalog `ConfirmationInput`. */
interface PurgeBody {
  confirmationToken: string;
}
const id = (context: RouteContext): string => context.params.id as string;
const provider = (context: RouteContext): string => context.params.provider as string;
/**
 * Portal settings: secret rotation and history, project purge, deletion operations, model data
 * sharing and environment revisions (S5b). Every handler is a thin call into one service method.
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
    "GET /projects/{id}/model-consents": (context) => context.service.model.settings(id(context)),
    "PUT /projects/{id}/model-consents/{provider}": (context) => {
      const input = context.body as ModelConsentInput;
      context.service.model.grantConsent(
        id(context),
        provider(context),
        input.dataClasses,
        input.allowUnknownCost ?? false,
      );
      return context.service.model.settings(id(context));
    },
    "DELETE /projects/{id}/model-consents/{provider}": (context) => {
      context.service.model.revokeConsent(id(context), provider(context));
      return context.service.model.settings(id(context));
    },
    "GET /environments/{id}/revisions": (context) =>
      context.page(context.service.environments.revisions(id(context))),
  },
  synchronous: [
    "POST /projects/{id}/purge",
    "PUT /projects/{id}/model-consents/{provider}",
    "DELETE /projects/{id}/model-consents/{provider}",
  ],
};
