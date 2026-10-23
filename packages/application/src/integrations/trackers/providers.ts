import {
  ContractError,
  type JiraSettings,
  type LinearSettings,
  trackerProviderIds,
} from "@testmaster/contracts";
import type { EgressOptions } from "../../notifications/https.js";
import type { IntegrationSecrets, StoredIntegration } from "../provider.js";
import type { IntegrationProviderRegistry } from "../registry.js";
import { integrationProviders } from "../registry.js";
import { resolveTrackerSecret, type TrackerAdapter, trackerEgress } from "./adapter.js";
import { createJiraAdapter, createJiraProvider } from "./jira.js";
import { createLinearAdapter, createLinearProvider, linearDefaultApiUrl } from "./linear.js";

/** True for the providers a ticket can be imported from and an issue filed in. */
export function isTrackerProvider(provider: string): provider is "jira" | "linear" {
  return (trackerProviderIds as readonly string[]).includes(provider);
}

/** Registers jira and linear once; an adapter registered earlier (a test double) wins. */
export function registerTrackerProviders(
  registry: IntegrationProviderRegistry = integrationProviders,
): void {
  if (!registry.peek("jira")) registry.register(createJiraProvider());
  if (!registry.peek("linear")) registry.register(createLinearProvider());
}

/**
 * The adapter of one stored tracker integration, with its credential released under the origin
 * binding of the secret. The egress knobs are the shared `trackerEgress` unless a caller passes
 * its own.
 */
export async function buildTrackerAdapter(
  integration: StoredIntegration,
  secrets: IntegrationSecrets,
  options: EgressOptions = trackerEgress,
): Promise<TrackerAdapter> {
  if (integration.provider === "jira") {
    const settings = integration.settings as JiraSettings;
    const token = await resolveTrackerSecret(secrets, settings.apiTokenSecretRef, settings.baseUrl);
    return createJiraAdapter(settings, token, options);
  }
  if (integration.provider === "linear") {
    const settings = integration.settings as LinearSettings;
    const key = await resolveTrackerSecret(
      secrets,
      settings.apiKeySecretRef,
      settings.apiUrl ?? linearDefaultApiUrl,
    );
    return createLinearAdapter(settings, key, options);
  }
  throw new ContractError("INVALID_ARGUMENT", "Integration is not an issue tracker", {
    provider: integration.provider,
  });
}
