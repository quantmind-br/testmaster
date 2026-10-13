import { type ReactNode, useId, useState } from "react";
import { api } from "../api";
import { ConfirmDialog } from "../components/confirm-dialog";
import { type Column, DataTable } from "../components/data-table";
import { FormField } from "../components/form";
import { useAnnounce } from "../components/live-region";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView, ViewState } from "../components/view-state";
import { usePageTitle } from "../hooks/use-page-title";
import { usePaged, useResource } from "../hooks/use-resource";
import { useUrlState } from "../hooks/use-url-state";
import { enumField } from "../lib/url-state";
import { IncidentDetailPage, IncidentsPage } from "./operations-incidents";
import {
  adminReason,
  Badge,
  describeFailure,
  formatTime,
  GuardedButton,
  humanize,
  Notice,
  ownerReason,
  ReasonActionPanel,
  Refusal,
  SeverityBadge,
  useOperationsAccess,
} from "./operations-shared";
import type { PortalRoute } from "./types";

/* Shapes of the /v1 operations responses (packages/contracts/src/m4/operations.ts). */
interface OperationsStatus {
  readonly admission: {
    readonly state: "enabled" | "paused" | "draining";
    readonly reason: string | null;
    readonly changedBy: string | null;
    readonly changedAt: string | null;
  };
  readonly globalAdmission: string;
  readonly isolation: { readonly isolated: boolean; readonly review: string | null };
  readonly work: {
    readonly activeRuns: number;
    readonly queuedJobs: number;
    readonly drained: boolean;
  };
  readonly backup: {
    readonly configured: boolean;
    readonly schedule: string | null;
    readonly lastSuccessAt: string | null;
    readonly lastFailureAt: string | null;
  };
  readonly retention: {
    readonly lastRunAt: string | null;
    readonly metadataWindowDays: number;
    readonly auditWindowDays: number;
    readonly runsPurged: number;
    readonly auditEventsPurged: number;
    readonly auditSummaries: number;
  };
}

interface AdminOperation {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly error: { readonly code: string; readonly message: string } | null;
}

interface DlqEntry {
  readonly source: string;
  readonly id: string;
  readonly state: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly subject: string;
}

interface AlertView {
  readonly id: string;
  readonly rule: string;
  readonly subject: string;
  readonly severity: string;
  readonly state: string;
  readonly summary: string;
  readonly owner: string;
  readonly runbook: string;
  readonly lastSeenAt: string;
  readonly acknowledgedBy: string | null;
  readonly acknowledgedAt: string | null;
}

interface AlertRule {
  readonly id: string;
  readonly title: string;
  readonly severity: string;
  readonly owner: string;
  readonly runbook: string;
  readonly description: string;
  readonly threshold: unknown;
}

interface SloIndicator {
  readonly id: string;
  readonly title: string;
  readonly unit: "ratio" | "seconds";
  readonly window: string;
  readonly proposedTarget: number | null;
  readonly observed: number | null;
  readonly measurement: "measured" | "not_measured";
  readonly numerator: number | null;
  readonly denominator: number;
  readonly buckets: readonly { readonly le: number; readonly count: number }[];
  readonly errorBudgetRemaining: number | null;
  readonly notes: string;
}

interface SloReport {
  readonly generatedAt: string;
  readonly indicators: readonly SloIndicator[];
}

/* ---------------------------------------------------------------- status */

const admissionLook = {
  enabled: { tone: "success", shape: "check", label: "Enabled" },
  paused: { tone: "warning", shape: "stop", label: "Paused" },
  draining: { tone: "warning", shape: "clock", label: "Draining" },
} as const;

const operationStateLook: Record<
  string,
  {
    tone: "success" | "danger" | "info" | "neutral";
    shape: "check" | "cross" | "spinner" | "clock";
  }
> = {
  requested: { tone: "neutral", shape: "clock" },
  running: { tone: "info", shape: "spinner" },
  completed: { tone: "success", shape: "check" },
  failed: { tone: "danger", shape: "cross" },
};

function OperationStateBadge({ state }: { state: string }): ReactNode {
  const look = operationStateLook[state] ?? { tone: "neutral" as const, shape: "clock" as const };
  return <Badge tone={look.tone} shape={look.shape} label={humanize(state)} />;
}

const operationColumns: Column<AdminOperation>[] = [
  { key: "kind", header: "Operation", render: (op) => humanize(op.kind) },
  { key: "state", header: "State", render: (op) => <OperationStateBadge state={op.state} /> },
  {
    key: "by",
    header: "Requested by",
    render: (op) => <UntrustedText value={op.requestedBy} maxLength={80} />,
  },
  {
    key: "reason",
    header: "Reason",
    render: (op) => <UntrustedText value={op.reason} maxLength={200} />,
  },
  { key: "at", header: "Requested at", render: (op) => formatTime(op.createdAt) },
];

function Facts({ rows }: { rows: readonly (readonly [string, ReactNode])[] }): ReactNode {
  return (
    <dl className="context">
      {rows.map(([label, value]) => (
        <div key={label} className="context-row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function OperationsStatusPage(): ReactNode {
  usePageTitle("Operations");
  const access = useOperationsAccess();
  const status = useResource<OperationsStatus>("/operations/status");
  const history = usePaged<AdminOperation>("/operations", {}, 20);
  const admin = adminReason(access);
  const owner = ownerReason(access);
  const data = status.data;

  async function refresh(): Promise<void> {
    await Promise.all([status.reload(), history.reload()]);
  }

  async function admission(action: "pause" | "drain" | "resume", reason: string, done: string) {
    await api("POST", "/operations/admission", { body: { action, reason } });
    await refresh();
    return done;
  }

  return (
    <>
      <h1>Operations</h1>
      <StatusView status={status.status} error={status.error} onRetry={() => void status.reload()}>
        {data ? (
          <>
            <Admission data={data} admin={admin} onAction={admission} />
            <Isolation data={data} owner={owner} onDone={refresh} />
            <section aria-labelledby="ops-work-heading" className="ops-panel">
              <h2 id="ops-work-heading">Work in flight</h2>
              <Facts
                rows={[
                  ["Active Runs", String(data.work.activeRuns)],
                  ["Queued jobs", String(data.work.queuedJobs)],
                  [
                    "Drained",
                    data.work.drained ? "Yes, no Run is active" : "No, Runs are still active",
                  ],
                ]}
              />
            </section>
            <BackupAndRetention data={data} owner={owner} onDone={refresh} />
          </>
        ) : null}
      </StatusView>
      <h2>Recent operations</h2>
      <StatusView
        status={history.status}
        error={history.error}
        onRetry={() => void history.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No operations yet"
            message="Administrative operations appear here once one is requested."
          />
        }
      >
        <DataTable
          caption="Recent administrative operations"
          columns={operationColumns}
          rows={history.items}
          rowKey={(op) => op.id}
          pager={{
            hasMore: history.hasMore,
            loading: history.loadingMore,
            onLoadMore: () => void history.loadMore(),
          }}
        />
      </StatusView>
    </>
  );
}

function Admission({
  data,
  admin,
  onAction,
}: {
  data: OperationsStatus;
  admin: string | null;
  onAction: (action: "pause" | "drain" | "resume", reason: string, done: string) => Promise<string>;
}): ReactNode {
  const state = data.admission.state;
  const look = admissionLook[state];
  const guard = (own: string | null) => admin ?? own;
  return (
    <ReasonActionPanel
      id="ops-admission"
      heading="Run admission"
      intro={
        <>
          <p>
            <Badge tone={look.tone} shape={look.shape} label={look.label} />
          </p>
          <Facts
            rows={[
              ["Reason", <UntrustedText key="r" value={data.admission.reason} maxLength={300} />],
              [
                "Changed by",
                <UntrustedText key="b" value={data.admission.changedBy} maxLength={80} />,
              ],
              ["Changed at", formatTime(data.admission.changedAt)],
              ["Deployment-wide admission", humanize(data.globalAdmission)],
            ]}
          />
          <p>
            New Runs are refused while admission is paused or draining. Queued and running work
            continues.
          </p>
        </>
      }
      context={[{ label: "Current state", value: look.label }]}
      actions={[
        {
          key: "pause",
          label: "Pause admission",
          confirmTitle: "Pause Run admission?",
          confirmDescription:
            "New Runs in this workspace are refused until admission is resumed. Running work continues.",
          confirmLabel: "Confirm pause",
          destructive: true,
          disabledReason: guard(state === "paused" ? "Admission is already paused." : null),
          run: (reason) => onAction("pause", reason, "Admission paused."),
        },
        {
          key: "drain",
          label: "Drain admission",
          confirmTitle: "Drain this workspace?",
          confirmDescription:
            "New Runs are refused so active work can finish; the workspace reports drained when none remains.",
          confirmLabel: "Confirm drain",
          destructive: true,
          disabledReason: guard(state === "draining" ? "Admission is already draining." : null),
          run: (reason) => onAction("drain", reason, "Admission is draining."),
        },
        {
          key: "resume",
          label: "Resume admission",
          confirmTitle: "Resume Run admission?",
          confirmDescription: "New Runs are admitted again.",
          confirmLabel: "Confirm resume",
          disabledReason: guard(state === "enabled" ? "Admission is already enabled." : null),
          run: (reason) => onAction("resume", reason, "Admission resumed."),
        },
      ]}
    />
  );
}

function Isolation({
  data,
  owner,
  onDone,
}: {
  data: OperationsStatus;
  owner: string | null;
  onDone: () => Promise<void>;
}): ReactNode {
  const { isolated, review } = data.isolation;
  const unavailable =
    owner ??
    (!isolated
      ? "The workspace is not isolated by a restore."
      : review !== "operator_confirmed"
        ? "The restore review has not been confirmed by an operator yet."
        : null);
  return (
    <ReasonActionPanel
      id="ops-isolation"
      heading="Restore isolation"
      intro={
        <>
          <p>
            {isolated ? (
              <Badge tone="warning" shape="lock" label="Isolated by a restore" />
            ) : (
              <Badge tone="success" shape="check" label="Not isolated" />
            )}
          </p>
          <Facts
            rows={[["Restore review", review ? humanize(review) : "No restore review recorded"]]}
          />
          <p>
            While isolated, schedules, integrations and notification channels stay inactive.
            Releasing isolation does not re-enable integrations that the restore paused.
          </p>
        </>
      }
      context={[{ label: "Isolation", value: isolated ? "Isolated" : "Not isolated" }]}
      actions={[
        {
          key: "release",
          label: "Release isolation",
          confirmTitle: "Release restore isolation?",
          confirmDescription:
            "Integrations the restore paused stay paused until an admin re-enables each of them.",
          confirmLabel: "Confirm release",
          destructive: true,
          disabledReason: unavailable,
          run: async (reason) => {
            await api("POST", "/operations/isolation/release", { body: { reason } });
            await onDone();
            return "Isolation released.";
          },
        },
      ]}
    />
  );
}

function BackupAndRetention({
  data,
  owner,
  onDone,
}: {
  data: OperationsStatus;
  owner: string | null;
  onDone: () => Promise<void>;
}): ReactNode {
  const { backup, retention } = data;
  return (
    <>
      <ReasonActionPanel
        id="ops-backup"
        heading="Backups"
        intro={
          <>
            <p>
              {backup.configured ? (
                <Badge tone="success" shape="check" label="Backups configured" />
              ) : (
                <Badge tone="warning" shape="warn" label="Backups not configured" />
              )}
            </p>
            <Facts
              rows={[
                ["Schedule", backup.schedule ?? "None"],
                [
                  "Last successful backup",
                  backup.lastSuccessAt
                    ? formatTime(backup.lastSuccessAt)
                    : "No successful backup recorded",
                ],
                [
                  "Last failed backup",
                  backup.lastFailureAt ? formatTime(backup.lastFailureAt) : "No failure recorded",
                ],
              ]}
            />
          </>
        }
        context={[{ label: "Schedule", value: backup.schedule ?? "None" }]}
        actions={[
          {
            key: "request",
            label: "Request backup",
            confirmTitle: "Request a backup now?",
            confirmDescription:
              "The backup agent that holds the backup key creates it; this only queues the request.",
            confirmLabel: "Confirm backup request",
            disabledReason:
              owner ??
              (backup.configured ? null : "Backups are not configured for this deployment."),
            run: async (reason) => {
              await api("POST", "/operations/backups", { body: { reason } });
              await onDone();
              return "Backup requested. The backup agent will create it.";
            },
          },
        ]}
      />
      <section aria-labelledby="ops-retention-heading" className="ops-panel">
        <h2 id="ops-retention-heading">Retention</h2>
        <Facts
          rows={[
            [
              "Last purge",
              retention.lastRunAt ? formatTime(retention.lastRunAt) : "No purge has run yet",
            ],
            ["Metadata window", `${retention.metadataWindowDays} days`],
            ["Audit window", `${retention.auditWindowDays} days`],
            ["Runs purged", String(retention.runsPurged)],
            ["Audit events purged", String(retention.auditEventsPurged)],
            ["Audit summaries kept", String(retention.auditSummaries)],
          ]}
        />
      </section>
    </>
  );
}

/* ------------------------------------------------------------------- DLQ */

function DlqPage(): ReactNode {
  usePageTitle("Dead-letter queue");
  const access = useOperationsAccess();
  const announce = useAnnounce();
  const noteId = useId();
  const entries = usePaged<DlqEntry>("/operations/dlq");
  const [chosen, setChosen] = useState<DlqEntry | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reason = adminReason(access);

  const columns: Column<DlqEntry>[] = [
    { key: "source", header: "Source", render: (entry) => humanize(entry.source) },
    {
      key: "subject",
      header: "Subject",
      render: (entry) => <UntrustedText value={entry.subject} maxLength={120} />,
    },
    { key: "id", header: "Entry", render: (entry) => <code>{entry.id}</code> },
    { key: "attempts", header: "Attempts", render: (entry) => String(entry.attempts) },
    {
      key: "error",
      header: "Last error",
      render: (entry) => (
        <UntrustedText value={entry.lastError} maxLength={300} fallback="No error recorded" />
      ),
    },
    { key: "created", header: "Dead-lettered", render: (entry) => formatTime(entry.createdAt) },
    {
      key: "action",
      header: "Action",
      render: (entry) => (
        <GuardedButton
          label="Requeue"
          accessibleName={`Requeue ${entry.id}`}
          reason={reason}
          reasonId={noteId}
          variant="secondary"
          onClick={() => {
            setNotice(null);
            setChosen(entry);
          }}
        />
      ),
    },
  ];

  async function requeue(): Promise<void> {
    if (!chosen) return;
    try {
      await api("POST", "/operations/dlq/requeue", {
        body: { source: chosen.source, id: chosen.id },
      });
    } catch (error) {
      throw new Error(describeFailure(error));
    }
    const message = `Requeued ${chosen.id}. It will be delivered again.`;
    setChosen(null);
    setNotice(message);
    announce(message);
    await entries.reload();
  }

  return (
    <>
      <h1>Dead-letter queue</h1>
      <p>
        Entries that exhausted their delivery attempts. Requeueing reopens an entry for a new
        delivery cycle; it never reruns a Run.
      </p>
      <Notice message={notice} />
      {reason ? (
        <p id={noteId} className="ops-reason">
          Requeue unavailable: {reason}
        </p>
      ) : null}
      <StatusView
        status={entries.status}
        error={entries.error}
        onRetry={() => void entries.reload()}
        empty={
          <ViewState
            kind="empty"
            title="The queue is empty"
            message="No delivery or job has been dead-lettered."
          />
        }
      >
        <DataTable
          caption="Dead-lettered entries"
          columns={columns}
          rows={entries.items}
          rowKey={(entry) => `${entry.source}:${entry.id}`}
          pager={{
            hasMore: entries.hasMore,
            loading: entries.loadingMore,
            onLoadMore: () => void entries.loadMore(),
          }}
        />
      </StatusView>
      <ConfirmDialog
        open={chosen !== null}
        title="Requeue this entry?"
        description="The entry is reopened for a new delivery cycle."
        context={[
          { label: "Source", value: chosen ? humanize(chosen.source) : "" },
          { label: "Entry", value: chosen?.id ?? "" },
          { label: "Subject", value: chosen ? chosen.subject.slice(0, 120) : "" },
        ]}
        confirmLabel="Confirm requeue"
        onConfirm={requeue}
        onCancel={() => setChosen(null)}
      />
    </>
  );
}

/* ---------------------------------------------------------------- alerts */

const alertFilters = {
  state: enumField(["", "firing", "acknowledged", "resolved"], ""),
};

const alertStateLook: Record<
  string,
  { tone: "danger" | "info" | "success"; shape: "warn" | "info" | "check" }
> = {
  firing: { tone: "danger", shape: "warn" },
  acknowledged: { tone: "info", shape: "info" },
  resolved: { tone: "success", shape: "check" },
};

function AlertsPage(): ReactNode {
  usePageTitle("Alerts");
  const access = useOperationsAccess();
  const announce = useAnnounce();
  const noteId = useId();
  const [url, setUrl] = useUrlState(alertFilters);
  const alerts = usePaged<AlertView>("/alerts", { state: url.state });
  const rules = usePaged<AlertRule>("/alert-rules");
  const [failure, setFailure] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reason = adminReason(access);

  async function acknowledge(alert: AlertView): Promise<void> {
    setFailure(null);
    setNotice(null);
    try {
      await api("POST", `/alerts/${encodeURIComponent(alert.id)}/acknowledge`, { body: {} });
    } catch (error) {
      setFailure(error);
      return;
    }
    const message = `Acknowledged alert ${alert.rule}.`;
    setNotice(message);
    announce(message);
    await alerts.reload();
  }

  const alertColumns: Column<AlertView>[] = [
    {
      key: "severity",
      header: "Severity",
      render: (alert) => <SeverityBadge severity={alert.severity} />,
    },
    {
      key: "state",
      header: "State",
      render: (alert) => {
        const look = alertStateLook[alert.state] ?? {
          tone: "info" as const,
          shape: "info" as const,
        };
        return <Badge tone={look.tone} shape={look.shape} label={humanize(alert.state)} />;
      },
    },
    {
      key: "summary",
      header: "Alert",
      render: (alert) => (
        <>
          <UntrustedText value={alert.summary} maxLength={300} />
          {alert.subject ? (
            <>
              <br />
              <span className="mono">
                <UntrustedText value={alert.subject} maxLength={120} />
              </span>
            </>
          ) : null}
        </>
      ),
    },
    { key: "rule", header: "Rule", render: (alert) => <code>{alert.rule}</code> },
    {
      key: "owner",
      header: "Owner",
      render: (alert) => <UntrustedText value={alert.owner} maxLength={80} />,
    },
    { key: "runbook", header: "Runbook", render: (alert) => <code>{alert.runbook}</code> },
    { key: "seen", header: "Last seen", render: (alert) => formatTime(alert.lastSeenAt) },
    {
      key: "action",
      header: "Action",
      render: (alert) =>
        alert.state === "firing" ? (
          <GuardedButton
            label="Acknowledge"
            accessibleName={`Acknowledge ${alert.rule}`}
            reason={reason}
            reasonId={noteId}
            variant="secondary"
            onClick={() => void acknowledge(alert)}
          />
        ) : alert.acknowledgedBy ? (
          <span>
            Acknowledged by <UntrustedText value={alert.acknowledgedBy} maxLength={80} />
          </span>
        ) : (
          <span>None needed</span>
        ),
    },
  ];

  const ruleColumns: Column<AlertRule>[] = [
    {
      key: "title",
      header: "Rule",
      render: (rule) => (
        <>
          <strong>{rule.title}</strong>
          <br />
          <code>{rule.id}</code>
        </>
      ),
    },
    {
      key: "severity",
      header: "Severity",
      render: (rule) => <SeverityBadge severity={rule.severity} />,
    },
    { key: "owner", header: "Owner", render: (rule) => rule.owner },
    { key: "runbook", header: "Runbook", render: (rule) => <code>{rule.runbook}</code> },
    {
      key: "threshold",
      header: "Threshold",
      render: (rule) => <code>{JSON.stringify(rule.threshold)}</code>,
    },
    { key: "description", header: "What it detects", render: (rule) => rule.description },
  ];

  return (
    <>
      <h1>Alerts</h1>
      <div className="ops-filter">
        <FormField
          label="State"
          id="alerts-state"
          hint="Kept in the address, so the view can be shared."
        >
          {(control) => (
            <select
              {...control}
              name="state"
              value={url.state}
              onChange={(event) => setUrl({ state: event.currentTarget.value as typeof url.state })}
            >
              <option value="">All states</option>
              <option value="firing">Firing</option>
              <option value="acknowledged">Acknowledged</option>
              <option value="resolved">Resolved</option>
            </select>
          )}
        </FormField>
      </div>
      <Notice message={notice} />
      <Refusal error={failure} />
      {reason ? (
        <p id={noteId} className="ops-reason">
          Acknowledge unavailable: {reason}
        </p>
      ) : null}
      <StatusView
        status={alerts.status}
        error={alerts.error}
        onRetry={() => void alerts.reload()}
        empty={
          <ViewState
            kind="empty"
            title={url.state ? `No ${url.state} alerts` : "No alerts"}
            message={
              url.state
                ? "Choose another state to see more alerts."
                : "No rule has fired for this workspace."
            }
          />
        }
      >
        <DataTable
          caption={url.state ? `Alerts (${url.state})` : "Alerts"}
          columns={alertColumns}
          rows={alerts.items}
          rowKey={(alert) => alert.id}
          pager={{
            hasMore: alerts.hasMore,
            loading: alerts.loadingMore,
            onLoadMore: () => void alerts.loadMore(),
          }}
        />
      </StatusView>
      <h2>Alert rules</h2>
      <p>Every rule names an owner and a runbook.</p>
      <StatusView status={rules.status} error={rules.error} onRetry={() => void rules.reload()}>
        <DataTable
          caption="Alert rules"
          columns={ruleColumns}
          rows={rules.items}
          rowKey={(rule) => rule.id}
        />
      </StatusView>
    </>
  );
}

/* ------------------------------------------------------------------- SLO */

function formatValue(value: number, unit: SloIndicator["unit"]): string {
  return unit === "ratio" ? `${(value * 100).toFixed(2)}%` : `${value} s`;
}

function SloCard({ indicator }: { indicator: SloIndicator }): ReactNode {
  const headingId = `slo-${indicator.id}`;
  const measured = indicator.measurement === "measured" && indicator.observed !== null;
  const bucketColumns: Column<SloIndicator["buckets"][number]>[] = [
    {
      key: "le",
      header: "Upper bound",
      render: (bucket) =>
        Number.isFinite(bucket.le) ? formatValue(bucket.le, indicator.unit) : "No upper bound",
    },
    { key: "count", header: "Observations", render: (bucket) => String(bucket.count) },
  ];
  return (
    <section aria-labelledby={headingId} className="ops-panel" data-testid={`slo-${indicator.id}`}>
      <h2 id={headingId}>{indicator.title}</h2>
      <p>
        Window: {indicator.window}. Sample: {indicator.numerator ?? 0} of {indicator.denominator}{" "}
        events.
      </p>
      <div className="ops-grid">
        <section className="ops-box" aria-label={`${indicator.title}: observed`}>
          <h3>Observed</h3>
          {measured && indicator.observed !== null ? (
            <>
              <p className="ops-value">{formatValue(indicator.observed, indicator.unit)}</p>
              <Badge tone="success" shape="check" label="Measured" />
            </>
          ) : (
            <>
              <p className="ops-value">Not measured</p>
              <Badge tone="neutral" shape="question" label="Not measured" />
              <p>No events were recorded in this window, so no value is claimed.</p>
            </>
          )}
          <p>
            Error budget remaining:{" "}
            {indicator.errorBudgetRemaining === null
              ? measured
                ? "Not defined for this indicator"
                : "Unknown until measured"
              : indicator.errorBudgetRemaining.toFixed(4)}
          </p>
        </section>
        <section className="ops-box proposal" aria-label={`${indicator.title}: proposed target`}>
          <h3>Proposed target</h3>
          <p className="ops-value">
            {indicator.proposedTarget === null
              ? "No target proposed"
              : formatValue(indicator.proposedTarget, indicator.unit)}
          </p>
          <Badge tone="info" shape="info" label="Proposal, not a measurement" />
          <p>A proposed objective for review. It is never presented as an observed value.</p>
        </section>
      </div>
      <p>
        <UntrustedText value={indicator.notes} maxLength={400} />
      </p>
      <DataTable
        caption={`${indicator.title}: bucket counts`}
        columns={bucketColumns}
        rows={indicator.buckets}
        rowKey={(bucket) => String(bucket.le)}
        empty={<p>No buckets are recorded for this indicator.</p>}
      />
    </section>
  );
}

function SloPage(): ReactNode {
  usePageTitle("SLO indicators");
  const report = useResource<SloReport>("/operations/slo");
  return (
    <>
      <h1>SLO indicators</h1>
      <p>
        Observed values come from recorded events. Proposed targets are objectives awaiting review
        and are shown apart from them.
      </p>
      <StatusView status={report.status} error={report.error} onRetry={() => void report.reload()}>
        {report.data ? (
          <>
            <p>Generated {formatTime(report.data.generatedAt)}.</p>
            {report.data.indicators.map((indicator) => (
              <SloCard key={indicator.id} indicator={indicator} />
            ))}
          </>
        ) : null}
      </StatusView>
    </>
  );
}

export const routes: PortalRoute[] = [
  {
    path: "/operations",
    title: "Operations",
    element: <OperationsStatusPage />,
    nav: { label: "Operations status", section: "Operations" },
  },
  {
    path: "/operations/dlq",
    title: "Dead-letter queue",
    element: <DlqPage />,
    nav: { label: "Dead-letter queue", section: "Operations" },
  },
  {
    path: "/operations/alerts",
    title: "Alerts",
    element: <AlertsPage />,
    nav: { label: "Alerts", section: "Operations" },
  },
  {
    path: "/operations/slo",
    title: "SLO indicators",
    element: <SloPage />,
    nav: { label: "SLO indicators", section: "Operations" },
  },
  {
    path: "/operations/incidents",
    title: "Incidents",
    element: <IncidentsPage />,
    nav: { label: "Incidents", section: "Operations" },
  },
  { path: "/operations/incidents/:incidentId", title: "Incident", element: <IncidentDetailPage /> },
];
