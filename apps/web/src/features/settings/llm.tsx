import { type ReactNode, useState } from "react";
import { api } from "../../api";
import type { Me } from "../../api/session";
import { ConfirmButton } from "../../components/confirm-action";
import { ImpactPanel } from "../../components/impact-panel";
import { StatusBadge } from "../../components/status";
import { UntrustedText } from "../../components/untrusted-text";
import { StatusView, ViewState } from "../../components/view-state";
import { useResource } from "../../hooks/use-resource";
import { consentImpact } from "../../lib/impact";
import type { ProjectSummary } from "../../routes/home";

export interface ModelConsent {
  readonly dataClasses: readonly string[];
  readonly allowUnknownCost: boolean;
  readonly grantedBy: string;
  readonly grantedAt: string;
  readonly revokedAt: string | null;
}

export interface ModelProvider {
  readonly id: string;
  readonly baseUrl: string;
  readonly remote: boolean;
  readonly models: readonly string[];
  readonly allowedByProfile: boolean;
  readonly consent: ModelConsent | null;
}

export interface ModelConsentSettings {
  readonly projectId: string;
  readonly dataClasses: readonly { readonly id: string; readonly description: string }[];
  readonly providers: readonly ModelProvider[];
}

function ProviderCard({
  provider,
  settings,
  project,
  me,
  reload,
}: {
  provider: ModelProvider;
  settings: ModelConsentSettings;
  project: ProjectSummary;
  me: Me;
  reload: () => Promise<void>;
}): ReactNode {
  const active = provider.consent && provider.consent.revokedAt === null ? provider.consent : null;
  const [classes, setClasses] = useState<readonly string[]>(active?.dataClasses ?? []);
  const [allowUnknownCost, setAllowUnknownCost] = useState(active?.allowUnknownCost ?? false);
  const path = `/projects/${encodeURIComponent(project.id)}/model-consents/${encodeURIComponent(provider.id)}`;
  const adminReason = me.permissions.admin
    ? null
    : "Your role cannot change data sharing (admin access is required).";
  const grantReason =
    adminReason ??
    (!provider.allowedByProfile
      ? "This provider is not allowed by the server's profile policy."
      : classes.length === 0
        ? "Choose at least one category of data to share."
        : null);
  const status = active ? "verified" : provider.consent?.revokedAt ? "paused" : "pending";
  const statusLabel = active
    ? "Sharing enabled"
    : provider.consent?.revokedAt
      ? "Revoked"
      : "Not shared";
  const impact = consentImpact({
    providerId: provider.id,
    remote: provider.remote,
    baseUrl: provider.baseUrl,
    dataClasses: classes,
    allowUnknownCost,
    revoke: false,
  });
  const context = [
    { label: "Workspace", value: me.workspace.name },
    { label: "Project", value: project.name },
    {
      label: "Provider",
      value: `${provider.id} (${provider.remote ? "remote" : "local"}) at ${provider.baseUrl}`,
    },
  ];
  return (
    <article className="provider-card" aria-label={`Provider ${provider.id}`}>
      <h3>
        <UntrustedText value={provider.id} maxLength={80} />{" "}
        <StatusBadge status={status} label={statusLabel} />
      </h3>
      <dl className="context">
        <dt>Endpoint</dt>
        <dd>
          <code>{provider.baseUrl}</code> ({provider.remote ? "remote" : "this host"})
        </dd>
        <dt>Models</dt>
        <dd>{provider.models.length > 0 ? provider.models.join(", ") : "None listed"}</dd>
        {active ? (
          <>
            <dt>Shared categories</dt>
            <dd>{active.dataClasses.join(", ")}</dd>
            <dt>Granted</dt>
            <dd>
              {active.grantedAt} by <UntrustedText value={active.grantedBy} maxLength={80} />
            </dd>
          </>
        ) : null}
      </dl>
      <fieldset>
        <legend>Data this project may send to this provider</legend>
        {settings.dataClasses.map((category) => (
          <div className="field" key={category.id}>
            <label>
              <input
                type="checkbox"
                checked={classes.includes(category.id)}
                onChange={(event) =>
                  setClasses((current) =>
                    event.target.checked
                      ? [...current, category.id]
                      : current.filter((value) => value !== category.id),
                  )
                }
              />{" "}
              {category.id}
            </label>
            <p className="hint">{category.description}</p>
          </div>
        ))}
      </fieldset>
      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={allowUnknownCost}
            onChange={(event) => setAllowUnknownCost(event.target.checked)}
          />{" "}
          Allow calls to models with no known price
        </label>
      </div>
      <ImpactPanel impacts={impact} />
      <div className="actions">
        <ConfirmButton
          label={active ? "Update data sharing" : "Allow data sharing"}
          tone="primary"
          disabledReason={grantReason}
          dialog={{
            title: `${active ? "Update" : "Allow"} data sharing with ${provider.id}?`,
            description: `Categories sent: ${classes.join(", ")}. ${provider.remote ? "This provider is remote." : "This provider runs on this host."}`,
            context,
            confirmLabel: active ? "Update sharing" : "Allow sharing",
          }}
          onConfirm={async (key) => {
            await api("PUT", path, {
              body: { dataClasses: classes, allowUnknownCost },
              idempotencyKey: key,
            });
            await reload();
          }}
          successMessage="Data sharing saved"
        />
        {active ? (
          <ConfirmButton
            label="Revoke data sharing"
            tone="danger"
            disabledReason={adminReason}
            dialog={{
              title: `Revoke data sharing with ${provider.id}?`,
              description: consentImpact({
                providerId: provider.id,
                remote: provider.remote,
                baseUrl: provider.baseUrl,
                dataClasses: [],
                allowUnknownCost: false,
                revoke: true,
              })
                .map((impact) => `${impact.area}: ${impact.text}`)
                .join(" "),
              context,
              confirmLabel: "Revoke sharing",
              destructive: true,
            }}
            onConfirm={async (key) => {
              await api("DELETE", path, { idempotencyKey: key });
              await reload();
            }}
            successMessage="Data sharing revoked"
          />
        ) : null}
      </div>
    </article>
  );
}

/** Per-provider opt-in naming the categories sent (UX-047). Nothing is shared by default. */
export function LlmSection({ project, me }: { project: ProjectSummary; me: Me }): ReactNode {
  const settings = useResource<ModelConsentSettings>(
    `/projects/${encodeURIComponent(project.id)}/model-consents`,
  );
  return (
    <section aria-labelledby="llm-heading" className="settings-section">
      <h2 id="llm-heading">Model data sharing</h2>
      <p className="hint">
        Generation and analysis may send project data to a model provider. Nothing is shared until
        you allow named categories for a provider.
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
          <ProviderCard
            key={`${provider.id}:${provider.consent?.grantedAt ?? ""}:${provider.consent?.revokedAt ?? ""}`}
            provider={provider}
            settings={settings.data as ModelConsentSettings}
            project={project}
            me={me}
            reload={() => settings.reload()}
          />
        ))}
      </StatusView>
    </section>
  );
}
