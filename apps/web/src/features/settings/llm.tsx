import type { ReactNode } from "react";
import { StatusBadge } from "../../components/status";
import { UntrustedText } from "../../components/untrusted-text";
import { StatusView, ViewState } from "../../components/view-state";
import { useResource } from "../../hooks/use-resource";
import type { ProjectSummary } from "../../routes/home";

export interface ModelProvider {
  readonly id: string;
  readonly baseUrl: string;
  readonly remote: boolean;
  readonly models: readonly string[];
  readonly allowedByProfile: boolean;
}

export interface ModelProviderSettings {
  readonly projectId: string;
  readonly providers: readonly ModelProvider[];
}

function ProviderCard({ provider }: { provider: ModelProvider }): ReactNode {
  return (
    <article className="provider-card" aria-label={`Provider ${provider.id}`}>
      <h3>
        <UntrustedText value={provider.id} maxLength={80} />{" "}
        <StatusBadge
          status={provider.allowedByProfile ? "verified" : "blocked"}
          label={provider.allowedByProfile ? "Allowed by policy" : "Blocked by policy"}
        />
      </h3>
      <dl className="context">
        <dt>Endpoint</dt>
        <dd>
          <code>{provider.baseUrl}</code> ({provider.remote ? "remote" : "this host"})
        </dd>
        <dt>Models</dt>
        <dd>{provider.models.length > 0 ? provider.models.join(", ") : "None listed"}</dd>
      </dl>
      {provider.allowedByProfile ? null : (
        <p className="hint">
          The server's profile policy does not allow this provider, so no model call can use it.
        </p>
      )}
    </article>
  );
}

/** Read-only list of the model providers the server is configured with and whether policy admits them. */
export function LlmSection({ project }: { project: ProjectSummary }): ReactNode {
  const settings = useResource<ModelProviderSettings>(
    `/projects/${encodeURIComponent(project.id)}/model-providers`,
  );
  return (
    <section aria-labelledby="llm-heading" className="settings-section">
      <h2 id="llm-heading">Model providers</h2>
      <p className="hint">
        Generation and analysis may send project data to an allowed model provider. The server's
        profile policy decides which providers are allowed.
      </p>
      <StatusView
        status={settings.status}
        error={settings.error}
        onRetry={() => void settings.reload()}
      >
        {settings.data && settings.data.providers.length === 0 ? (
          <ViewState
            kind="empty"
            title="No model provider configured"
            message="This server has no model provider configured, so nothing can be sent."
          />
        ) : null}
        {settings.data?.providers.map((provider) => (
          <ProviderCard key={provider.id} provider={provider} />
        ))}
      </StatusView>
    </section>
  );
}
