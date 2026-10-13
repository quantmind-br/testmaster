import { ContractError, type IntegrationProviderIdValue } from "@testmaster/contracts";
import {
  assertAdapterCompatible,
  assertWellFormedProvider,
  type IntegrationProvider,
} from "./provider.js";

/** Adapters keyed by provider ID. An adapter must be compatible with the core contract to be used. */
export class IntegrationProviderRegistry {
  private readonly providers = new Map<IntegrationProviderIdValue, IntegrationProvider>();
  register(provider: IntegrationProvider): void {
    assertWellFormedProvider(provider);
    if (this.providers.has(provider.id))
      throw new ContractError("INVALID_ARGUMENT", "Integration adapter is already registered", {
        provider: provider.id,
      });
    this.providers.set(provider.id, provider);
  }
  /** The registered adapter whether or not it is compatible; used to describe it. */
  peek(id: string): IntegrationProvider | null {
    return this.providers.get(id as IntegrationProviderIdValue) ?? null;
  }
  /** The adapter to run: unknown or incompatible adapters are refused before any of their code runs. */
  resolve(id: string): IntegrationProvider {
    const provider = this.peek(id);
    if (!provider)
      throw new ContractError("NOT_FOUND", "Integration provider is not available", {
        provider: id,
      });
    assertAdapterCompatible(provider);
    return provider;
  }
  list(): IntegrationProvider[] {
    return [...this.providers.values()];
  }
}
/** Process-wide registry. The core ships no adapter; GitHub, Slack, email and webhook register here. */
export const integrationProviders = new IntegrationProviderRegistry();
