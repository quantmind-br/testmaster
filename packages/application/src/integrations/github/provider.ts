import {
  type GithubIntegrationSettings,
  githubEventTypes,
  SCHEMA_VERSION,
  validate,
} from "@testmaster/contracts";
import type {
  DeliveryOutcome,
  InboundOutcome,
  InboundRequest,
  IntegrationContext,
  IntegrationProvider,
  StoredIntegration,
  TestDeliveryContext,
} from "../provider.js";
import type { GithubService } from "./service.js";

export const githubProviderVersion = "1.0.0";

/** The GitHub adapter (INT-014): versioned, declares its capabilities, and delegates to the service. */
export function createGithubProvider(
  service: GithubService,
): IntegrationProvider<GithubIntegrationSettings> {
  return {
    id: "github",
    version: githubProviderVersion,
    schemaVersion: SCHEMA_VERSION,
    capabilities: ["checks", "comments", "previews", "webhooks", "deployments"],
    supportedEvents: githubEventTypes,
    parseSettings: (input: unknown) =>
      validate("GithubIntegrationSettings", input) as GithubIntegrationSettings,
    async sendTest(
      _context: TestDeliveryContext,
      integration: StoredIntegration<GithubIntegrationSettings>,
    ): Promise<DeliveryOutcome> {
      const result = await service.verifyApp(service.fromStored(integration));
      return { state: result.ok ? "delivered" : "failed", detail: result.detail };
    },
    receive: (context: IntegrationContext, request: InboundRequest): Promise<InboundOutcome> =>
      service.receive(context, request),
  };
}
