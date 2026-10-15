import type {
  ConflictDecisionInput,
  NormalizationInput,
  OnboardingStateInput,
  PrerequisiteInput,
} from "@testmaster/contracts";
import { holdConnectionOpen } from "./authoring.js";
import type { RouteContext, RouteModule } from "./types.js";

const id = (context: RouteContext): string => context.params.id as string;
/**
 * Portal onboarding, source history, requirement review and the feature map. Every route is a
 * catalog route: the portal calls nothing that CLI and MCP clients cannot also call.
 */
export const onboardingRoutes: RouteModule = {
  handlers: {
    "GET /projects/{id}/onboarding": (context) => context.service.onboarding.get(id(context)),
    "PUT /projects/{id}/onboarding": (context) =>
      context.service.onboarding.save(
        id(context),
        context.body as OnboardingStateInput,
        context.ifMatch(),
      ),
    "POST /projects/{id}/onboarding/checks": (context) =>
      context.service.onboarding.check(id(context), context.body as PrerequisiteInput),
    "GET /sources/{id}/revisions": (context) => {
      const { service } = context;
      const projectId = service.sources.get(id(context)).source.projectId;
      const latest = service.discovery.list(projectId)[0];
      const excludes = latest ? service.discovery.get(latest.id).codeSnapshot.excludes : [];
      return service.sources.history(id(context), excludes);
    },
    "GET /projects/{id}/discovery": (context) =>
      context.page(context.service.discovery.list(id(context))),
    "GET /projects/{id}/requirements/review": (context) =>
      context.service.requirements.review(id(context)),
    "POST /projects/{id}/requirements/normalizations": async (context) => {
      holdConnectionOpen(context.reply);
      const input = context.body as NormalizationInput;
      await context.service.requirements.normalize({ projectId: id(context), ...input });
      return context.service.requirements.review(id(context));
    },
    "POST /projects/{id}/requirements/decisions": (context) => {
      context.service.requirements.adjudicate(id(context), context.body as ConflictDecisionInput);
      return context.service.requirements.review(id(context));
    },
    "POST /requirements/{id}/approve": (context) =>
      context.service.requirements.approve(id(context), context.ifMatch()),
    "GET /projects/{id}/feature-map": (context) => context.service.featureMap.get(id(context)),
  },
  // Only synchronous handlers can be wrapped: `executeIdempotent` stores the receipt of a handler
  // that has returned, so the asynchronous checks and normalizations are not listed.
  synchronous: [
    "PUT /projects/{id}/onboarding",
    "POST /projects/{id}/requirements/decisions",
    "POST /requirements/{id}/approve",
  ],
};
