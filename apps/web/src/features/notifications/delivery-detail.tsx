import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { api } from "../../api";
import { useMe } from "../../components/app-shell";
import { type Column, DataTable } from "../../components/data-table";
import { useAnnounce } from "../../components/live-region";
import { Icon } from "../../components/status";
import { UntrustedText } from "../../components/untrusted-text";
import { StatusView, ViewState } from "../../components/view-state";
import { usePageTitle } from "../../hooks/use-page-title";
import { useResource } from "../../hooks/use-resource";
import {
  type CheckDelivery,
  type DeliveryDetail,
  type NotificationAttempt,
  type NotificationDeliveryDetail,
  uncertainText,
} from "../../lib/notifications";
import { NotFoundPage } from "../../routes/not-found";
import { ActionFailure, shortText } from "../admin/parts";
import { StateBadge } from "../admin/state-badge";
import { useGuardedAction } from "../admin/use-guarded-action";
import { deliveryTypeText, requeueHelp, requeueNeedsAdmin } from "./deliveries-panel";

type Field = readonly [label: string, value: ReactNode];

function Fields({ fields }: { fields: readonly Field[] }): ReactNode {
  return (
    <dl className="context">
      {fields.map(([label, value]) => (
        <div key={label} className="context-row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function timestamp(value: string | null | undefined): ReactNode {
  return value ? <time dateTime={value}>{value}</time> : "—";
}

function code(value: string | null | undefined): ReactNode {
  return value ? <code>{value}</code> : "—";
}

const attemptColumns: Column<NotificationAttempt>[] = [
  { key: "number", header: "Attempt", render: (attempt) => attempt.number },
  { key: "started", header: "Started", render: (attempt) => timestamp(attempt.startedAt) },
  { key: "finished", header: "Finished", render: (attempt) => timestamp(attempt.finishedAt) },
  {
    key: "outcome",
    header: "Outcome",
    render: (attempt) => (
      <>
        <StateBadge state={attempt.uncertain ? "uncertain" : attempt.outcome} />
        {attempt.uncertain ? <p className="attempt-note">{uncertainText}</p> : null}
      </>
    ),
  },
  { key: "http", header: "HTTP status", render: (attempt) => attempt.httpStatus ?? "—" },
  {
    key: "reason",
    header: "Reason",
    render: (attempt) => <UntrustedText value={attempt.reasonCode} />,
  },
  {
    key: "detail",
    header: "Detail",
    render: (attempt) => <UntrustedText value={attempt.detail} maxLength={300} />,
  },
];

function NotificationBody({ delivery }: { delivery: NotificationDeliveryDetail }): ReactNode {
  const { payload } = delivery;
  const counts = payload.summary.counts;
  return (
    <>
      <h2>Delivery</h2>
      <Fields
        fields={[
          ["State", <StateBadge key="state" state={delivery.state} />],
          ["Event", deliveryTypeText(delivery)],
          ["Delivery ID", <code key="id">{delivery.deliveryId}</code>],
          [
            "Event reference",
            <UntrustedText key="ref" value={delivery.eventRef} maxLength={120} />,
          ],
          ["Integration", code(delivery.integrationId)],
          ["Provider", delivery.provider],
          ["Attempts", delivery.attempts],
          ["Next attempt", timestamp(delivery.nextAttemptAt)],
          ["Delivered", timestamp(delivery.deliveredAt)],
          ["Created", timestamp(delivery.createdAt)],
          ["Payload hash", code(delivery.payloadHash)],
          [
            "Last reason",
            <UntrustedText
              key="reason"
              value={delivery.lastReasonCode ?? delivery.lastError}
              maxLength={200}
            />,
          ],
        ]}
      />
      <h2>Payload summary</h2>
      <p className="help">
        What a receiver is sent: identifiers, the outcome and a link. It carries no titles, logs,
        screenshots or secret values.
      </p>
      <Fields
        fields={[
          ["Test delivery", payload.test ? "Yes — a labelled test, never a Run or a check" : "No"],
          ["Occurred", timestamp(payload.occurredAt)],
          ["Project", code(payload.projectId)],
          ["Run", code(payload.runId)],
          ["Batch", code(payload.batchId)],
          ["Schedule", code(payload.scheduleId)],
          ["Outcome", payload.summary.outcome ?? "—"],
          ["Gate", payload.summary.gate ?? "—"],
          [
            "Counts",
            counts
              ? Object.entries(counts)
                  .map(([name, value]) => `${name} ${value}`)
                  .join(", ")
              : "—",
          ],
          ["Reason code", code(payload.summary.reasonCode)],
          ["Link", <UntrustedText key="link" value={payload.link} maxLength={300} />],
        ]}
      />
      <h2>Attempts</h2>
      <DataTable
        caption="Delivery attempts"
        columns={attemptColumns}
        rows={delivery.attemptLog}
        rowKey={(attempt) => String(attempt.number)}
        empty={
          <ViewState
            kind="empty"
            title="No attempts yet"
            message="The dispatcher has not tried to deliver this yet."
          />
        }
      />
    </>
  );
}

function CheckBody({ delivery }: { delivery: CheckDelivery }): ReactNode {
  return (
    <>
      <h2>Delivery</h2>
      <Fields
        fields={[
          ["State", <StateBadge key="state" state={delivery.state} />],
          ["Kind", "GitHub check delivery"],
          ["Check", deliveryTypeText(delivery)],
          ["Subject commit", code(delivery.subjectSha)],
          ["Conclusion", delivery.conclusion ?? "—"],
          ["Attempts", delivery.attempts],
          ["Next attempt", timestamp(delivery.nextAttemptAt)],
          ["Last error", <UntrustedText key="error" value={delivery.lastError} maxLength={300} />],
        ]}
      />
    </>
  );
}

export function DeliveryDetailPage(): ReactNode {
  const { deliveryId = "" } = useParams();
  const me = useMe();
  const announce = useAnnounce();
  const action = useGuardedAction();
  const delivery = useResource<DeliveryDetail>(`/deliveries/${encodeURIComponent(deliveryId)}`);
  usePageTitle(delivery.status === "not-found" ? "Not found" : "Delivery");
  const canRequeue = me.permissions.admin;

  async function requeue(): Promise<void> {
    const done = await action.run(() =>
      api("POST", `/deliveries/${encodeURIComponent(deliveryId)}/retry`),
    );
    if (!done) return;
    announce(`${shortText(deliveryId, 40)} was requeued and is pending again`);
    await delivery.reload();
  }

  const data = delivery.data;
  // A missing delivery and one the caller may not read are the same page.
  if (delivery.status === "not-found") return <NotFoundPage />;
  return (
    <>
      <h1>
        Delivery <UntrustedText value={deliveryId} maxLength={60} />
      </h1>
      <StatusView
        status={delivery.status}
        error={delivery.error}
        onRetry={() => void delivery.reload()}
      >
        <p>
          <Link to="/settings/notifications">Back to notifications</Link>
        </p>
        {data?.state === "dead_letter" ? (
          <section className="banner tone-danger" aria-label="Dead letter">
            <Icon shape="cross" />
            <div>
              <p className="state-title">This delivery is in the dead-letter queue.</p>
              <p>It is independent of any Run verdict. {requeueHelp}</p>
              <button
                type="button"
                className="button secondary"
                aria-disabled={!canRequeue || action.busy}
                aria-describedby={canRequeue ? undefined : "requeue-reason"}
                onClick={() => {
                  if (canRequeue && !action.busy) void requeue();
                }}
              >
                Requeue
              </button>
              {canRequeue ? null : (
                <p className="reason" id="requeue-reason">
                  {requeueNeedsAdmin}
                </p>
              )}
            </div>
          </section>
        ) : null}
        <ActionFailure message={action.failure} />
        {data && "attemptLog" in data && data.outcomeUncertain ? (
          <p className="banner tone-warning">
            <Icon shape="question" />
            <span>{uncertainText}</span>
          </p>
        ) : null}
        {data && "attemptLog" in data ? <NotificationBody delivery={data} /> : null}
        {data && !("attemptLog" in data) ? <CheckBody delivery={data} /> : null}
      </StatusView>
    </>
  );
}
