import type { ReactNode } from "react";
import { Link } from "react-router";
import { api } from "../../api";
import { useMe } from "../../components/app-shell";
import { type Column, DataTable } from "../../components/data-table";
import { useAnnounce } from "../../components/live-region";
import { UntrustedText } from "../../components/untrusted-text";
import { StatusView, ViewState } from "../../components/view-state";
import { usePaged } from "../../hooks/use-resource";
import { useUrlState } from "../../hooks/use-url-state";
import {
  type DeliveryRow,
  deliveryStates,
  type IntegrationDocument,
  isNotificationDelivery,
  isNotificationProvider,
  notificationTypeLabels,
  notificationTypes,
  providerLabels,
  uncertainText,
} from "../../lib/notifications";
import { enumField, stringField } from "../../lib/url-state";
import { ActionFailure, shortText } from "../admin/parts";
import { adminStates, StateBadge } from "../admin/state-badge";
import { useGuardedAction } from "../admin/use-guarded-action";

/** Filters live in the URL so a filtered history can be shared and restored. */
const filters = {
  state: enumField(["", ...deliveryStates], ""),
  type: enumField(["", ...notificationTypes], ""),
  integration: stringField("", 80),
};

export const requeueHelp =
  "Requeueing reopens the delivery with the same delivery ID and bytes. It never reruns a Run, a Batch or a gate.";

/** Disabled-with-reason for roles that may read deliveries but not requeue them. */
export const requeueNeedsAdmin = "Requeue needs the workspace admin role.";

/** Where the delivery went: the integration's name when it is known, else its ID. */
export function destinationOf(
  row: DeliveryRow,
  integrations: readonly IntegrationDocument[],
): ReactNode {
  if (!isNotificationDelivery(row)) return "GitHub check";
  const integration = integrations.find((entry) => entry.id === row.integrationId);
  const provider = isNotificationProvider(row.provider)
    ? providerLabels[row.provider]
    : row.provider;
  return (
    <>
      {integration ? (
        <UntrustedText value={integration.name} maxLength={80} />
      ) : (
        <code>{row.integrationId}</code>
      )}
      <br />
      <span>{provider}</span>
    </>
  );
}

export function deliveryTypeText(row: DeliveryRow): string {
  if (!isNotificationDelivery(row)) return row.checkName ?? "GitHub check";
  const known = notificationTypes.find((type) => type === row.type);
  return known ? notificationTypeLabels[known] : row.type;
}

interface DeliveriesPanelProps {
  readonly integrations: readonly IntegrationDocument[];
}

export function DeliveriesPanel({ integrations }: DeliveriesPanelProps): ReactNode {
  const me = useMe();
  const announce = useAnnounce();
  const action = useGuardedAction();
  const [url, setUrl] = useUrlState(filters);
  const deliveries = usePaged<DeliveryRow>("/deliveries", {
    state: url.state,
    type: url.type,
    integrationId: url.integration,
  });
  const canRequeue = me.permissions.admin;

  async function requeue(row: DeliveryRow): Promise<void> {
    const done = await action.run(() =>
      api("POST", `/deliveries/${encodeURIComponent(row.id)}/retry`),
    );
    if (!done) return;
    announce(`${shortText(row.id, 40)} was requeued and is pending again`);
    await deliveries.reload();
  }

  const columns: Column<DeliveryRow>[] = [
    {
      key: "id",
      header: "Delivery",
      render: (row) => (
        <Link to={`/settings/notifications/deliveries/${encodeURIComponent(row.id)}`}>
          <code>{row.id}</code>
        </Link>
      ),
    },
    { key: "type", header: "Event", render: (row) => deliveryTypeText(row) },
    {
      key: "destination",
      header: "Destination",
      render: (row) => destinationOf(row, integrations),
    },
    {
      key: "state",
      header: "State",
      render: (row) => (
        <>
          <StateBadge state={row.state} />
          {isNotificationDelivery(row) && row.outcomeUncertain ? (
            <p className="attempt-note">{uncertainText}</p>
          ) : null}
        </>
      ),
    },
    { key: "attempts", header: "Attempts", render: (row) => row.attempts },
    {
      key: "when",
      header: "Next attempt / delivered",
      render: (row) => {
        const at =
          isNotificationDelivery(row) && row.deliveredAt ? row.deliveredAt : row.nextAttemptAt;
        return at ? <time dateTime={at}>{at}</time> : "—";
      },
    },
    {
      key: "reason",
      header: "Last reason",
      render: (row) => (
        <UntrustedText
          value={(isNotificationDelivery(row) ? row.lastReasonCode : null) ?? row.lastError}
          maxLength={120}
        />
      ),
    },
    {
      key: "actions",
      header: "Actions",
      render: (row) => {
        if (row.state !== "dead_letter") return "—";
        return (
          <>
            <button
              type="button"
              className="button secondary"
              aria-label={`Requeue ${shortText(row.id, 40)}`}
              aria-disabled={!canRequeue || action.busy}
              aria-describedby={canRequeue ? undefined : `requeue-${row.id}`}
              onClick={() => {
                if (canRequeue && !action.busy) void requeue(row);
              }}
            >
              Requeue
            </button>
            {canRequeue ? null : (
              <p className="reason" id={`requeue-${row.id}`}>
                {requeueNeedsAdmin}
              </p>
            )}
          </>
        );
      },
    },
  ];

  const filtered = url.state !== "" || url.type !== "" || url.integration !== "";
  return (
    <section className="admin-panel" aria-labelledby="deliveries-heading">
      <h2 id="deliveries-heading">Delivery history</h2>
      <p className="help">
        Deliveries are at-least-once and keep one delivery ID across retries, so receivers
        deduplicate on it. A request that may have reached its destination without an observed
        answer is marked as an uncertain outcome. {requeueHelp} Dead letters are shown here
        independently of any Run verdict.
      </p>
      <div className="admin-toolbar">
        <div className="field">
          <label htmlFor="filter-state">State</label>
          <select
            id="filter-state"
            value={url.state}
            onChange={(event) =>
              setUrl({ state: deliveryStates.find((s) => s === event.target.value) ?? "" })
            }
          >
            <option value="">All states</option>
            {deliveryStates.map((state) => (
              <option key={state} value={state}>
                {adminStates[state]?.label ?? state}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-type">Event</label>
          <select
            id="filter-type"
            value={url.type}
            onChange={(event) =>
              setUrl({ type: notificationTypes.find((t) => t === event.target.value) ?? "" })
            }
          >
            <option value="">All events</option>
            {notificationTypes.map((type) => (
              <option key={type} value={type}>
                {notificationTypeLabels[type]}
              </option>
            ))}
          </select>
        </div>
        {integrations.length > 0 ? (
          <div className="field">
            <label htmlFor="filter-integration">Integration</label>
            <select
              id="filter-integration"
              value={url.integration}
              onChange={(event) => setUrl({ integration: event.target.value })}
            >
              <option value="">All integrations</option>
              {integrations.map((integration) => (
                <option key={integration.id} value={integration.id}>
                  {shortText(integration.name, 80)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {filtered ? (
          <button
            type="button"
            className="button secondary"
            onClick={() => setUrl({ state: "", type: "", integration: "" })}
          >
            Clear filters
          </button>
        ) : null}
        <button type="button" className="button secondary" onClick={() => void deliveries.reload()}>
          Refresh deliveries
        </button>
      </div>
      <ActionFailure message={action.failure} />
      <StatusView
        status={deliveries.status}
        error={deliveries.error}
        onRetry={() => void deliveries.reload()}
        empty={
          <ViewState
            kind="empty"
            title={filtered ? "No deliveries match these filters" : "No deliveries yet"}
            message={
              filtered
                ? "Clear a filter to see more of the history."
                : "Deliveries appear here once an integration has something to tell."
            }
          />
        }
      >
        <DataTable
          caption="Deliveries"
          columns={columns}
          rows={deliveries.items}
          rowKey={(row) => row.id}
          pager={{
            hasMore: deliveries.hasMore,
            loading: deliveries.loadingMore,
            onLoadMore: () => void deliveries.loadMore(),
          }}
        />
      </StatusView>
    </section>
  );
}
