import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { api } from "../api";
import { ConfirmDialog } from "../components/confirm-dialog";
import { type Column, DataTable } from "../components/data-table";
import { ErrorSummary, type FieldIssue, FormField } from "../components/form";
import { useAnnounce } from "../components/live-region";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView, ViewState } from "../components/view-state";
import { ActionFailure, shortText } from "../features/admin/parts";
import { StateBadge } from "../features/admin/state-badge";
import { useGuardedAction } from "../features/admin/use-guarded-action";
import { usePageTitle } from "../hooks/use-page-title";
import { usePaged } from "../hooks/use-resource";
import {
  drainBlockedReason,
  formatAge,
  parseLabelLines,
  visibleLabels,
  type WorkerDocument,
  type WorkerEnrollmentReceipt,
  workerName,
} from "../lib/workers";
import type { PortalRoute } from "./types";

const startCommand =
  "testmaster worker start --mode server --config <server.json> --enroll-token-file <file>";

/** The one-time enrollment token. It lives only in this component's state and never in storage or the URL. */
function TokenPanel({
  receipt,
  onDismiss,
}: {
  receipt: WorkerEnrollmentReceipt;
  onDismiss: () => void;
}): ReactNode {
  const announce = useAnnounce();
  const heading = useId();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => panel.current?.focus(), []);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(receipt.enrollmentToken);
      announce("Enrollment token copied to the clipboard");
    } catch {
      announce("The token could not be copied. Select it and copy it manually.");
    }
  }
  return (
    <section
      className="token-panel"
      ref={panel}
      tabIndex={-1}
      aria-labelledby={heading}
      data-testid="enrollment-panel"
    >
      <h3 id={heading}>
        Enrollment token for <UntrustedText value={workerName(receipt.worker)} maxLength={80} />
      </h3>
      <p>
        <strong>This token is shown once.</strong> TestMaster stores only its hash and cannot show
        it again. Closing this panel or leaving the page discards it.
      </p>
      <code className="token" data-testid="enrollment-token">
        {receipt.enrollmentToken}
      </code>
      <p>
        It expires at <time dateTime={receipt.tokenExpiresAt}>{receipt.tokenExpiresAt}</time>.
      </p>
      <p>Save the token to a file only you can read (mode 0600), then start the worker:</p>
      <pre className="command">{startCommand}</pre>
      <div className="row-actions">
        <button type="button" className="button secondary" onClick={() => void copy()}>
          Copy token
        </button>
        <button type="button" className="button" onClick={onDismiss}>
          I saved the token, dismiss it
        </button>
      </div>
    </section>
  );
}

function EnrollForm({
  onEnrolled,
}: {
  onEnrolled: (receipt: WorkerEnrollmentReceipt) => void;
}): ReactNode {
  const formId = useId();
  const action = useGuardedAction();
  const [name, setName] = useState("");
  const [labels, setLabels] = useState("");
  const [issues, setIssues] = useState<readonly FieldIssue[]>([]);
  const [submitCount, setSubmitCount] = useState(0);
  const nameId = `${formId}-name`;
  const labelsId = `${formId}-labels`;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitCount((count) => count + 1);
    const found: FieldIssue[] = [];
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.length > 200)
      found.push({ fieldId: nameId, message: "Enter a worker name of 1 to 200 characters." });
    const parsed = parseLabelLines(labels);
    if (parsed.error !== null) found.push({ fieldId: labelsId, message: parsed.error });
    setIssues(found);
    if (found.length > 0 || parsed.labels === null) return;
    const done = await action.run(() =>
      api<WorkerEnrollmentReceipt>("POST", "/workers", {
        body: {
          name: trimmed,
          ...(Object.keys(parsed.labels).length > 0 ? { labels: parsed.labels } : {}),
        },
      }),
    );
    if (!done) return;
    setName("");
    setLabels("");
    onEnrolled(done.value.data);
  }

  return (
    <form className="admin-form" onSubmit={(event) => void submit(event)} noValidate>
      <ErrorSummary key={submitCount} issues={issues} />
      <FormField
        label="Worker name"
        required
        id={nameId}
        error={issues.find((i) => i.fieldId === nameId)?.message ?? null}
      >
        {(control) => (
          <input
            {...control}
            type="text"
            autoComplete="off"
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </FormField>
      <FormField
        label="Labels"
        id={labelsId}
        hint="Optional. One key=value pair per line, for example pool=default. Keys start with a lowercase letter."
        error={issues.find((i) => i.fieldId === labelsId)?.message ?? null}
      >
        {(control) => (
          <textarea
            {...control}
            rows={3}
            value={labels}
            onChange={(event) => setLabels(event.target.value)}
          />
        )}
      </FormField>
      <ActionFailure message={action.failure} />
      <div className="form-actions">
        <button type="submit" className="button" aria-disabled={action.busy}>
          {action.busy ? "Creating…" : "Create enrollment"}
        </button>
      </div>
    </form>
  );
}

function WorkersPage(): ReactNode {
  usePageTitle("Workers");
  const workers = usePaged<WorkerDocument>("/workers");
  const announce = useAnnounce();
  const drain = useGuardedAction();
  const [receipt, setReceipt] = useState<WorkerEnrollmentReceipt | null>(null);
  const [revoking, setRevoking] = useState<WorkerDocument | null>(null);
  // The age text is relative to the moment the list was last read.
  const [now, setNow] = useState(() => Date.now());
  // Only the first read replaces the page with a loading view; reloads keep the form mounted.
  const [loaded, setLoaded] = useState(false);
  const settled = workers.status === "ready" || workers.status === "empty";
  useEffect(() => {
    if (settled) setLoaded(true);
  }, [settled]);

  async function refresh(): Promise<void> {
    await workers.reload();
    setNow(Date.now());
  }

  async function drainWorker(worker: WorkerDocument): Promise<void> {
    const done = await drain.run(() =>
      api("POST", `/workers/${encodeURIComponent(worker.id)}/drain`),
    );
    if (!done) return;
    announce(`${shortText(workerName(worker))} is draining and claims no new work`);
    await refresh();
  }

  async function revokeWorker(worker: WorkerDocument): Promise<void> {
    await api("POST", `/workers/${encodeURIComponent(worker.id)}/revoke`);
    setRevoking(null);
    announce(`${shortText(workerName(worker))} was revoked`);
    await refresh();
  }

  const columns: Column<WorkerDocument>[] = [
    {
      key: "name",
      header: "Worker",
      render: (worker) => (
        <>
          <UntrustedText value={workerName(worker)} maxLength={80} />
          <br />
          <code>{worker.id}</code>
        </>
      ),
    },
    { key: "state", header: "State", render: (worker) => <StateBadge state={worker.state} /> },
    {
      key: "heartbeat",
      header: "Last heartbeat",
      render: (worker) =>
        worker.lastHeartbeatAt ? (
          <>
            <time dateTime={worker.lastHeartbeatAt}>{worker.lastHeartbeatAt}</time>
            <br />
            <span>{formatAge(worker.lastHeartbeatAt, now)}</span>
          </>
        ) : (
          "Never"
        ),
    },
    {
      key: "slots",
      header: "Slots",
      render: (worker) => worker.labels.slots ?? "Not declared (counts as 2)",
    },
    {
      key: "capabilities",
      header: "Capabilities",
      render: (worker) =>
        worker.capabilities.length > 0 ? (
          <UntrustedText value={worker.capabilities.join(", ")} maxLength={200} />
        ) : (
          "None reported"
        ),
    },
    {
      key: "labels",
      header: "Labels",
      render: (worker) => {
        const labels = visibleLabels(worker);
        return labels.length > 0 ? (
          <UntrustedText
            value={labels.map(([key, value]) => `${key}=${value}`).join(", ")}
            maxLength={200}
          />
        ) : (
          "None"
        );
      },
    },
    {
      key: "actions",
      header: "Actions",
      render: (worker) => {
        const name = shortText(workerName(worker));
        const drainReason = drainBlockedReason(worker.state);
        return (
          <>
            <div className="row-actions">
              <button
                type="button"
                className="button secondary"
                aria-label={`Drain ${name}`}
                aria-disabled={drainReason !== null || drain.busy}
                aria-describedby={drainReason ? `drain-${worker.id}` : undefined}
                onClick={() => {
                  if (drainReason === null && !drain.busy) void drainWorker(worker);
                }}
              >
                Drain
              </button>
              <button
                type="button"
                className="button danger"
                aria-label={`Revoke ${name}`}
                aria-disabled={worker.state === "revoked"}
                aria-describedby={worker.state === "revoked" ? `revoke-${worker.id}` : undefined}
                onClick={() => {
                  if (worker.state !== "revoked") setRevoking(worker);
                }}
              >
                Revoke
              </button>
            </div>
            {drainReason ? (
              <p className="reason" id={`drain-${worker.id}`}>
                {drainReason}
              </p>
            ) : null}
            {worker.state === "revoked" ? (
              <p className="reason" id={`revoke-${worker.id}`}>
                This worker is already revoked.
              </p>
            ) : null}
          </>
        );
      },
    },
  ];

  let body: ReactNode;
  if (workers.status === "loading" && !loaded) body = <ViewState kind="loading" />;
  else if (workers.status === "forbidden")
    body = (
      <ViewState
        kind="forbidden"
        message="Only workspace administrators can enroll, drain or revoke workers."
      />
    );
  else if (workers.status === "error")
    body = <ViewState kind="error" error={workers.error} onRetry={() => void workers.reload()} />;
  else
    body = (
      <>
        <section className="admin-panel" aria-labelledby="enroll-heading">
          <h2 id="enroll-heading">Enroll a worker</h2>
          <p className="help">
            Enrollment creates the worker in the Enrolling state and a one-use token. Start the
            worker with that token and it becomes Ready.
          </p>
          {receipt ? <TokenPanel receipt={receipt} onDismiss={() => setReceipt(null)} /> : null}
          <EnrollForm
            onEnrolled={(created) => {
              setReceipt(created);
              announce("Worker enrolled. The enrollment token is shown once.");
              void refresh();
            }}
          />
        </section>
        <section className="admin-panel" aria-labelledby="pool-heading">
          <h2 id="pool-heading">Worker pool</h2>
          <p className="help">
            Drain stops new claims while current work finishes. Revoke is final: the worker's lease
            claims are refused at once and the jobs it holds are fenced for reconciliation.
          </p>
          <div className="admin-toolbar">
            <button type="button" className="button secondary" onClick={() => void refresh()}>
              Refresh workers
            </button>
          </div>
          <ActionFailure message={drain.failure} />
          <StatusView
            status={workers.status}
            error={workers.error}
            onRetry={() => void workers.reload()}
            empty={
              <ViewState
                kind="empty"
                title="No workers yet"
                message="Enroll a worker above. Runs wait in the queue until a ready worker claims them."
              />
            }
          >
            <DataTable
              caption="Workers"
              columns={columns}
              rows={workers.items}
              rowKey={(worker) => worker.id}
              pager={{
                hasMore: workers.hasMore,
                loading: workers.loadingMore,
                onLoadMore: () => void workers.loadMore(),
              }}
            />
          </StatusView>
        </section>
      </>
    );

  return (
    <>
      <h1>Workers</h1>
      {body}
      <ConfirmDialog
        open={revoking !== null}
        destructive
        title="Revoke this worker?"
        description="Revoking is final. The worker's lease claims are refused at once, its credential stops working and the jobs it holds are fenced for reconciliation. A revoked worker cannot be drained or restored."
        context={
          revoking
            ? [
                { label: "Worker", value: shortText(workerName(revoking)) },
                { label: "ID", value: revoking.id },
                { label: "State", value: revoking.state },
              ]
            : []
        }
        confirmLabel="Revoke worker"
        onConfirm={() => (revoking ? revokeWorker(revoking) : undefined)}
        onCancel={() => setRevoking(null)}
      />
    </>
  );
}

export const routes: PortalRoute[] = [
  {
    path: "/settings/workers",
    title: "Workers",
    element: <WorkersPage />,
    nav: { label: "Workers", section: "Admin" },
  },
];
