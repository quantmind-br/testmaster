import { type ReactNode, useState } from "react";
import { api } from "../../api";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { type Column, DataTable } from "../../components/data-table";
import { useAnnounce } from "../../components/live-region";
import { UntrustedText } from "../../components/untrusted-text";
import { StatusView, ViewState } from "../../components/view-state";
import type { UsePaged } from "../../hooks/use-resource";
import {
  describeRules,
  type IntegrationDocument,
  isNotificationProvider,
  providerLabels,
  type TestReceipt,
} from "../../lib/notifications";
import { ActionFailure, shortText } from "../admin/parts";
import { StateBadge } from "../admin/state-badge";
import { useGuardedAction } from "../admin/use-guarded-action";
import { IntegrationFormPanel, type ProjectChoice } from "./integration-form";

type FormMode =
  | { readonly kind: "closed" }
  | { readonly kind: "form"; readonly integration: IntegrationDocument | null };

interface IntegrationsPanelProps {
  readonly integrations: UsePaged<IntegrationDocument>;
  readonly projects: readonly ProjectChoice[];
}

export function IntegrationsPanel({ integrations, projects }: IntegrationsPanelProps): ReactNode {
  const announce = useAnnounce();
  const action = useGuardedAction();
  const [mode, setMode] = useState<FormMode>({ kind: "closed" });
  const [receipt, setReceipt] = useState<TestReceipt | null>(null);
  const [revoking, setRevoking] = useState<IntegrationDocument | null>(null);
  const projectNames = Object.fromEntries(projects.map((project) => [project.id, project.name]));

  async function patchState(
    integration: IntegrationDocument,
    state: "active" | "paused",
  ): Promise<void> {
    const done = await action.run(() =>
      api("PATCH", `/integrations/${encodeURIComponent(integration.id)}`, {
        body: { state },
        ifMatch: integration.version,
      }),
    );
    if (!done) return;
    announce(`${shortText(integration.name)} is now ${state}`);
    await integrations.reload();
  }

  async function sendTest(integration: IntegrationDocument): Promise<void> {
    setReceipt(null);
    const done = await action.run(() =>
      api<TestReceipt>("POST", `/integrations/${encodeURIComponent(integration.id)}/test`),
    );
    if (!done) return;
    setReceipt(done.value.data);
    announce(`Test delivery for ${shortText(integration.name)} finished`);
    await integrations.reload();
  }

  async function revoke(integration: IntegrationDocument): Promise<void> {
    await api("PATCH", `/integrations/${encodeURIComponent(integration.id)}`, {
      body: { state: "revoked" },
      ifMatch: integration.version,
    });
    setRevoking(null);
    announce(`${shortText(integration.name)} was revoked`);
    await integrations.reload();
  }

  const columns: Column<IntegrationDocument>[] = [
    {
      key: "name",
      header: "Integration",
      render: (integration) => (
        <>
          <UntrustedText value={integration.name} maxLength={80} />
          <br />
          <code>{integration.id}</code>
        </>
      ),
    },
    {
      key: "provider",
      header: "Provider",
      render: (integration) =>
        isNotificationProvider(integration.provider)
          ? providerLabels[integration.provider]
          : integration.provider,
    },
    {
      key: "state",
      header: "State",
      render: (integration) => (
        <>
          <StateBadge state={integration.state} />
          {integration.adapterStatus === "compatible" ? null : (
            <p className="reason">Adapter {integration.adapterStatus}</p>
          )}
        </>
      ),
    },
    {
      key: "events",
      header: "Events",
      render: (integration) => (
        <UntrustedText value={integration.events.join(", ")} maxLength={200} />
      ),
    },
    {
      key: "scope",
      header: "Project scope",
      render: (integration) =>
        integration.projectIds.length === 0 ? (
          "All projects"
        ) : (
          <UntrustedText
            value={integration.projectIds.map((id) => projectNames[id] ?? id).join(", ")}
            maxLength={160}
          />
        ),
    },
    { key: "rules", header: "Rules", render: (integration) => describeRules(integration) },
    {
      key: "lastTest",
      header: "Last test delivery",
      render: (integration) =>
        integration.lastTest ? (
          <>
            <strong>Test delivery</strong> <StateBadge state={integration.lastTest.state} />
            <br />
            <time dateTime={integration.lastTest.at}>{integration.lastTest.at}</time>
            {integration.lastTest.detail ? (
              <>
                <br />
                <UntrustedText value={integration.lastTest.detail} maxLength={160} />
              </>
            ) : null}
          </>
        ) : (
          "None yet"
        ),
    },
    {
      key: "actions",
      header: "Actions",
      render: (integration) => {
        const name = shortText(integration.name);
        const revoked = integration.state === "revoked";
        const paused = integration.state === "paused";
        const testReason = revoked
          ? "A revoked integration cannot send."
          : paused
            ? "Resume the integration to send a test delivery."
            : null;
        const reasonId = `reason-${integration.id}`;
        return (
          <>
            <div className="row-actions">
              <button
                type="button"
                className="button secondary"
                aria-label={`Edit ${name}`}
                aria-disabled={revoked}
                aria-describedby={revoked ? reasonId : undefined}
                onClick={() => {
                  if (!revoked) setMode({ kind: "form", integration });
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="button secondary"
                aria-label={`Send test delivery for ${name}`}
                aria-disabled={testReason !== null || action.busy}
                aria-describedby={testReason ? reasonId : undefined}
                onClick={() => {
                  if (testReason === null && !action.busy) void sendTest(integration);
                }}
              >
                Send test delivery
              </button>
              <button
                type="button"
                className="button secondary"
                aria-label={`${paused ? "Resume" : "Pause"} ${name}`}
                aria-disabled={revoked || action.busy}
                aria-describedby={revoked ? reasonId : undefined}
                onClick={() => {
                  if (!revoked && !action.busy)
                    void patchState(integration, paused ? "active" : "paused");
                }}
              >
                {paused ? "Resume" : "Pause"}
              </button>
              <button
                type="button"
                className="button danger"
                aria-label={`Revoke ${name}`}
                aria-disabled={revoked}
                aria-describedby={revoked ? reasonId : undefined}
                onClick={() => {
                  if (!revoked) setRevoking(integration);
                }}
              >
                Revoke
              </button>
            </div>
            {revoked ? (
              <p className="reason" id={reasonId}>
                Revoked integrations are final.
              </p>
            ) : testReason ? (
              <p className="reason" id={reasonId}>
                {testReason}
              </p>
            ) : null}
          </>
        );
      },
    },
  ];

  let body: ReactNode;
  if (integrations.status === "forbidden")
    body = (
      <ViewState
        kind="forbidden"
        title="Integrations are not available to you"
        message="Only workspace administrators can view or change notification integrations. The delivery history below is still readable."
      />
    );
  else
    body = (
      <StatusView
        status={integrations.status}
        error={integrations.error}
        onRetry={() => void integrations.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No integrations yet"
            message="Create an integration to send Slack, email or webhook notifications."
          />
        }
      >
        <DataTable
          caption="Notification integrations"
          columns={columns}
          rows={integrations.items}
          rowKey={(integration) => integration.id}
          pager={{
            hasMore: integrations.hasMore,
            loading: integrations.loadingMore,
            onLoadMore: () => void integrations.loadMore(),
          }}
        />
      </StatusView>
    );

  return (
    <section className="admin-panel" aria-labelledby="integrations-heading">
      <h2 id="integrations-heading">Integrations</h2>
      <p className="help">
        An integration tells Slack, an SMTP mailbox or an HTTPS webhook when a Run, a Batch or a
        schedule needs attention. A notification never changes a Run, a Batch or a gate. A test
        delivery is labelled as a test and is never a Run, a check or a notification of record.
      </p>
      {integrations.status === "forbidden" ? null : (
        <div className="admin-toolbar">
          <button
            type="button"
            className="button"
            onClick={() => setMode({ kind: "form", integration: null })}
          >
            New integration
          </button>
        </div>
      )}
      <ActionFailure message={action.failure} />
      {receipt ? (
        <p className="banner tone-info" role="status" data-testid="test-delivery-result">
          <strong>Test delivery</strong>
          <StateBadge state={receipt.state} />
          <span>
            <code>{receipt.deliveryId}</code>
            {receipt.detail ? (
              <>
                {" "}
                <UntrustedText value={receipt.detail} maxLength={160} />
              </>
            ) : null}
          </span>
        </p>
      ) : null}
      {mode.kind === "form" ? (
        <IntegrationFormPanel
          key={mode.integration?.id ?? "new"}
          integration={mode.integration}
          projects={projects}
          onCancel={() => setMode({ kind: "closed" })}
          onSaved={(saved) => {
            setMode({ kind: "closed" });
            announce(`${shortText(saved.name)} was saved`);
            void integrations.reload();
          }}
        />
      ) : null}
      {body}
      <ConfirmDialog
        open={revoking !== null}
        destructive
        title="Revoke this integration?"
        description="Revoking is final. Secret bindings are removed, the integration stops sending and pending deliveries stay pending. It cannot be resumed."
        context={
          revoking
            ? [
                { label: "Integration", value: shortText(revoking.name) },
                { label: "ID", value: revoking.id },
                { label: "Provider", value: revoking.provider },
              ]
            : []
        }
        confirmLabel="Revoke integration"
        onConfirm={() => (revoking ? revoke(revoking) : undefined)}
        onCancel={() => setRevoking(null)}
      />
    </section>
  );
}
