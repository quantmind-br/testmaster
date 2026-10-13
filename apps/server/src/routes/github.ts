import type {
  GithubManifestConversionInput,
  GithubManifestInput,
  GithubRepositoryPatch,
  GithubRotateWebhookSecretInput,
  PreviewDeploymentInput,
} from "@testmaster/contracts";
import type { RouteContext, RouteModule } from "./types.js";

const id = (context: RouteContext): string => context.params.id as string;
/** GitHub App setup, repository bindings, pull request and check status, and manual previews (ADR-020). */
export const githubRoutes: RouteModule = {
  handlers: {
    "POST /integrations/github/manifests": ({ service, body }) =>
      service.github.manifest(body as GithubManifestInput),
    "POST /integrations/github/manifests/{state}/conversion": ({ service, params, body }) =>
      service.github.convertManifest(params.state as string, body as GithubManifestConversionInput),
    "GET /integrations/{id}/github/installations": (context) =>
      context.page(context.service.github.installations(id(context))),
    "PATCH /integrations/{id}/github/repositories/{repositoryId}": (context) =>
      context.service.github.updateRepository(
        id(context),
        context.params.repositoryId as string,
        context.body as GithubRepositoryPatch,
      ),
    "GET /integrations/{id}/github/pulls": (context) =>
      context.page(context.service.github.pulls(id(context), 500)),
    "GET /integrations/{id}/github/checks": (context) =>
      context.page(context.service.github.checks(id(context), 500)),
    "POST /integrations/{id}/github/checks/{checkId}/retry": (context) =>
      context.service.github.retryCheck(id(context), context.params.checkId as string),
    "POST /integrations/{id}/github/rotate-webhook-secret": (context) =>
      context.service.github.rotateWebhookSecret(
        id(context),
        (context.body as GithubRotateWebhookSecretInput).secretRef,
      ),
    "POST /preview-deployments": ({ service, body }) =>
      service.github.previewDeployment(body as PreviewDeploymentInput),
  },
  synchronous: [
    "PATCH /integrations/{id}/github/repositories/{repositoryId}",
    "POST /integrations/{id}/github/checks/{checkId}/retry",
    "POST /integrations/{id}/github/rotate-webhook-secret",
  ],
  status: { "POST /integrations/github/manifests": 201 },
};
