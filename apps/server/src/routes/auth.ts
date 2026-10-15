import type {
  AuthCheckpointInput,
  AuthProfileInput,
  AuthProfilePatch,
} from "@testmaster/contracts";
import type { RouteContext, RouteModule } from "./types.js";

const id = (context: RouteContext): string => context.params.id as string;
/** Dynamic authentication: profiles, session lifecycle and manual checkpoints (SEC-023, SEC-024). */
export const authRoutes: RouteModule = {
  handlers: {
    "GET /auth-profiles": ({ service, query, page }) =>
      page(service.authProfiles.list(query.projectId)),
    "POST /auth-profiles": ({ service, body }) =>
      service.authProfiles.create(body as AuthProfileInput),
    "GET /auth-profiles/{id}": (context) => context.service.authProfiles.get(id(context)),
    "PATCH /auth-profiles/{id}": (context) =>
      context.service.authProfiles.update(
        id(context),
        context.body as AuthProfilePatch,
        context.ifMatch(),
      ),
    "POST /auth-profiles/{id}/test-login": (context) =>
      context.service.authProfiles.testLogin(
        id(context),
        (context.body as { environmentId: string }).environmentId,
      ),
    "POST /auth-profiles/{id}/authorize": (context) =>
      context.service.authProfiles.authorize(
        id(context),
        (context.body as { environmentId: string }).environmentId,
      ),
    "POST /auth-profiles/{id}/complete-authorization": (context) => {
      const { environmentId, ...input } = context.body as {
        environmentId: string;
        authorizationId: string;
        inputRef: string;
      };
      return context.service.authProfiles.completeAuthorization(id(context), input, environmentId);
    },
    "POST /auth-profiles/{id}/import-state": (context) =>
      context.service.authProfiles.importState(
        id(context),
        context.body as { inputRef: string; ttlSeconds?: number },
      ),
    "POST /auth-profiles/{id}/export-state": (context) =>
      context.service.authProfiles.exportState(
        id(context),
        context.body as { password: string; ttlSeconds?: number },
      ),
    "POST /auth-profiles/{id}/revoke-session": (context) =>
      context.service.authProfiles.revokeSession(id(context)),
    "GET /auth-checkpoints": ({ service, query, page }) =>
      page(
        service.authCheckpoints.list({
          ...(query.runId ? { runId: query.runId } : {}),
          ...(query.authProfileId ? { profileId: query.authProfileId } : {}),
          ...(query.state ? { state: query.state } : {}),
        }),
      ),
    "POST /auth-checkpoints": ({ service, body }) =>
      service.authCheckpoints.create(body as AuthCheckpointInput),
    "GET /auth-checkpoints/{id}": (context) => context.service.authCheckpoints.get(id(context)),
    "POST /auth-checkpoints/{id}/continue": (context) =>
      context.service.authCheckpoints.continue(id(context), context.body as { inputRef?: string }),
    "POST /auth-checkpoints/{id}/cancel": (context) =>
      context.service.authCheckpoints.cancel(id(context)),
  },
  synchronous: ["POST /auth-checkpoints"],
};
