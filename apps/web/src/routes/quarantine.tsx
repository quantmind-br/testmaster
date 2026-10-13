import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { ApiError, api } from "../api";
import { type ConfirmContext, ConfirmDialog } from "../components/confirm-dialog";
import { type Column, DataTable } from "../components/data-table";
import { ErrorSummary, type FieldIssue, FormField } from "../components/form";
import { useAnnounce } from "../components/live-region";
import { useSelectContext } from "../components/portal-context";
import { Icon } from "../components/status";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView, ViewState } from "../components/view-state";
import { usePageTitle } from "../hooks/use-page-title";
import { usePaged, useResource } from "../hooks/use-resource";
import type { MetricsPayload } from "../lib/metrics-view";
import {
  buildQuarantineRows,
  currentSelection,
  describeChange,
  gateEffect,
  historyNotice,
  type QuarantineChange,
  type QuarantineForm,
  type QuarantineRecord,
  type QuarantineRow,
  quarantineBody,
  reducedCoverage,
  type Selectedness,
  type SelectionSide,
  toLocalInput,
  validateQuarantine,
} from "../lib/quarantine-view";
import type { ProjectSummary } from "./home";
import { NotFoundPage } from "./not-found";
import type { PortalRoute } from "./types";

interface TestOption {
  readonly id: string;
  readonly name: string;
  readonly archivedAt: string | null;
}
interface EnvironmentOption {
  readonly id: string;
  readonly archivedAt: string | null;
}

interface Previews {
  readonly exclude: SelectionSide;
  readonly strict: SelectionSide;
}

/** The same selection under both quarantine policies, so the effect is read, not assumed. */
async function previewSelection(
  projectId: string,
  environmentId: string,
  testIds: readonly string[],
): Promise<Previews> {
  const preview = (quarantinePolicy: "exclude" | "strict") =>
    api<SelectionSide>("POST", "/execution-previews", {
      body: { projectId, environmentId, testIds, quarantinePolicy, allowEmpty: true },
    }).then((response) => response.data);
  const [exclude, strict] = await Promise.all([preview("exclude"), preview("strict")]);
  return { exclude, strict };
}

interface PendingChange {
  readonly change: QuarantineChange;
  readonly testId: string;
  readonly form: QuarantineForm | null;
  readonly version: number | null;
  readonly expiresAt: string | null;
  readonly before: Selectedness;
}

const emptyForm: QuarantineForm = { testId: "", reason: "", expiresAtLocal: "" };

function StateBadge({ state }: { state: QuarantineRow["state"] }): ReactNode {
  return state === "active" ? (
    <span className="badge tone-warning" data-state="active">
      <Icon shape="stop" />
      <span>Active</span>
    </span>
  ) : (
    <span className="badge tone-neutral" data-state="expired">
      <Icon shape="clock" />
      <span>Expired</span>
    </span>
  );
}

function QuarantinePage(): ReactNode {
  const { projectId = "" } = useParams();
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const announce = useAnnounce();
  const project = useResource<ProjectSummary>(base);
  const records = usePaged<QuarantineRecord>(`${base}/quarantine`, {}, 100);
  const metrics = useResource<MetricsPayload>(`${base}/metrics`);
  const tests = usePaged<TestOption>(`${base}/tests`, {}, 100);
  const environments = usePaged<EnvironmentOption>(`${base}/environments`, {}, 100);
  useSelectContext(project.data ? { id: project.data.id, name: project.data.name } : null);
  usePageTitle(project.status === "not-found" ? "Not found" : "Quarantine");

  const [form, setForm] = useState<QuarantineForm>(emptyForm);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [submitCount, setSubmitCount] = useState(0);
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<ApiError | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [previews, setPreviews] = useState<Previews | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);

  const rows = useMemo(
    () => buildQuarantineRows(records.items, metrics.data?.quarantined ?? null, new Date()),
    [records.items, metrics.data],
  );
  const testName = useMemo(
    () => new Map(tests.items.map((test) => [test.id, test.name])),
    [tests.items],
  );
  const environmentId =
    project.data?.defaultEnvironmentId ??
    environments.items.find((environment) => environment.archivedAt === null)?.id ??
    null;
  const activeIds = rows.filter((row) => row.state === "active").map((row) => row.testId);
  const activeKey = activeIds.join(",");

  // The gate effect of each active quarantine comes from the selection preview.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `activeKey` is the stable form of `activeIds`
  useEffect(() => {
    if (!environmentId || activeIds.length === 0 || records.status === "loading") {
      setPreviews(null);
      setPreviewFailed(false);
      return;
    }
    let current = true;
    previewSelection(projectId, environmentId, activeIds)
      .then((result) => {
        if (!current) return;
        setPreviews(result);
        setPreviewFailed(false);
      })
      .catch(() => {
        if (!current) return;
        setPreviews(null);
        setPreviewFailed(true);
      });
    return () => {
      current = false;
    };
  }, [projectId, environmentId, activeKey, records.status]);

  useEffect(() => {
    if (focusToken > 0) document.getElementById("quarantine-reason")?.focus();
  }, [focusToken]);

  if (project.status === "not-found") return <NotFoundPage />;

  // The effect on the gate is read for the project's environment, so it must be known first.
  const ready = project.status !== "loading" && environments.status !== "loading";
  const existing = rows.find((row) => row.testId === form.testId) ?? null;
  const issueFor = (field: string) =>
    issues.find((issue) => issue.fieldId === `quarantine-${field}`)?.message ?? null;

  async function reloadAll(): Promise<void> {
    await Promise.all([records.reload(), metrics.reload()]);
  }

  async function review(
    change: QuarantineChange,
    input: Omit<PendingChange, "before" | "change">,
  ): Promise<void> {
    setChecking(true);
    setFormError(null);
    let before: Selectedness = "unknown";
    if (environmentId) {
      try {
        before = currentSelection(
          input.testId,
          (await previewSelection(projectId, environmentId, [input.testId])).exclude,
        );
      } catch {
        before = "unknown";
      }
    }
    setChecking(false);
    setPending({ ...input, change, before });
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (checking || !ready) return;
    setNotice(null);
    const found = validateQuarantine(form, new Date()).map((issue) => ({
      fieldId: `quarantine-${issue.field}`,
      message: issue.message,
    }));
    setIssues(found);
    setSubmitCount((count) => count + 1);
    if (found.length > 0) return;
    void review(existing ? "edit" : "quarantine", {
      testId: form.testId,
      form,
      version: existing?.version ?? null,
      expiresAt: quarantineBody(form, null).expiresAt,
    });
  }

  async function confirm(): Promise<void> {
    if (!pending) return;
    const name = testName.get(pending.testId) ?? pending.testId;
    const path = `/tests/${encodeURIComponent(pending.testId)}/quarantine`;
    try {
      if (pending.change === "remove") {
        await api("DELETE", path, { ifMatch: pending.version });
        setNotice(`Quarantine removed for ${name}. The test is selected by default again.`);
      } else if (pending.form) {
        await api("PUT", path, { body: quarantineBody(pending.form, pending.version) });
        setNotice(
          `Quarantine saved for ${name}. Failed Runs of this test stay in history and metrics.`,
        );
        setForm(emptyForm);
      }
      announce(`Quarantine updated for ${name}.`);
      setPending(null);
    } catch (error) {
      await reloadAll();
      if (error instanceof ApiError && error.code === "REVISION_CONFLICT")
        throw new Error(
          "This quarantine changed since the page loaded. The list was reloaded; review it and try again.",
        );
      throw error;
    }
    await reloadAll();
  }

  function edit(row: QuarantineRow): void {
    setForm({
      testId: row.testId,
      reason: row.reason,
      expiresAtLocal: toLocalInput(row.expiresAt),
    });
    setIssues([]);
    setNotice(null);
    setFocusToken((token) => token + 1);
  }

  const effectFor = (row: QuarantineRow) => gateEffect(row, previews);
  const columns: Column<QuarantineRow>[] = [
    {
      key: "test",
      header: "Test",
      render: (row) => (
        <>
          <UntrustedText value={testName.get(row.testId) ?? row.testId} maxLength={120} />
          <div>
            <code>{row.testId}</code>
          </div>
        </>
      ),
    },
    { key: "owner", header: "Owner", render: (row) => <code>{row.owner}</code> },
    {
      key: "reason",
      header: "Reason",
      render: (row) => <UntrustedText value={row.reason} maxLength={400} block />,
    },
    {
      key: "expires",
      header: "Expires",
      render: (row) => (
        <>
          <time dateTime={row.expiresAt}>{row.expiresAt}</time> <StateBadge state={row.state} />
        </>
      ),
    },
    {
      key: "runs",
      header: "Runs in window",
      render: (row) => (row.runsInWindow === null ? "Not loaded" : row.runsInWindow),
    },
    {
      key: "failed",
      header: "Failed Runs in window",
      render: (row) => (row.failedRunsInWindow === null ? "Not loaded" : row.failedRunsInWindow),
    },
    {
      key: "effect",
      header: "Effect on the gate",
      render: (row) =>
        previewFailed && row.state === "active" ? gateEffect(row, null).text : effectFor(row).text,
    },
    {
      key: "actions",
      header: "Actions",
      render: (row) => {
        const name = testName.get(row.testId) ?? row.testId;
        return (
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button
              type="button"
              className="button secondary"
              aria-label={`Edit quarantine for ${name}`}
              onClick={() => edit(row)}
            >
              Edit
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={checking || !ready}
              aria-label={`Remove quarantine for ${name}`}
              onClick={() =>
                void review("remove", {
                  testId: row.testId,
                  form: null,
                  version: row.version,
                  expiresAt: null,
                })
              }
            >
              Remove
            </button>
          </div>
        );
      },
    },
  ];

  const dialogContext: ConfirmContext[] = pending
    ? [
        { label: "Test", value: testName.get(pending.testId) ?? pending.testId },
        {
          label: "Today",
          value: describeChange(pending.change, pending.before, pending.expiresAt).before,
        },
        {
          label: "After this change",
          value: describeChange(pending.change, pending.before, pending.expiresAt).after,
        },
        ...(pending.form ? [{ label: "Expires", value: pending.expiresAt ?? "" }] : []),
      ]
    : [];
  const titles: Record<QuarantineChange, string> = {
    quarantine: "Quarantine this test?",
    edit: "Update this quarantine?",
    remove: "Remove this quarantine?",
  };
  const verbs: Record<QuarantineChange, string> = {
    quarantine: "Quarantine test",
    edit: "Save changes",
    remove: "Remove quarantine",
  };

  return (
    <>
      <h1>Quarantine</h1>
      <div className="banner tone-info" role="note" data-testid="quarantine-notice">
        <Icon shape="info" />
        <span>{historyNotice}</span>
      </div>
      <p data-testid="coverage-note">{reducedCoverage(rows)}</p>
      {notice ? (
        <p role="status" className="banner tone-success">
          <Icon shape="check" />
          <span>{notice}</span>
        </p>
      ) : null}
      <h2>{existing ? "Edit quarantine" : "Quarantine a test"}</h2>
      <form onSubmit={submit} noValidate aria-label="Quarantine a test">
        <ErrorSummary key={submitCount} issues={issues} />
        <FormField id="quarantine-testId" label="Test" required error={issueFor("testId")}>
          {(control) => (
            <select
              {...control}
              style={{ maxWidth: "100%" }}
              value={form.testId}
              onChange={(event) => setForm({ ...form, testId: event.target.value })}
            >
              <option value="">Choose a test</option>
              {tests.items
                .filter((test) => test.archivedAt === null)
                .map((test) => (
                  <option key={test.id} value={test.id}>
                    {test.name} ({test.id})
                  </option>
                ))}
            </select>
          )}
        </FormField>
        <FormField
          id="quarantine-reason"
          label="Reason"
          hint="Recorded with your name in the audit log. Say what is wrong and what will fix it."
          required
          error={issueFor("reason")}
        >
          {(control) => (
            <textarea
              {...control}
              style={{ maxWidth: "100%" }}
              rows={3}
              value={form.reason}
              onChange={(event) => setForm({ ...form, reason: event.target.value })}
            />
          )}
        </FormField>
        <FormField
          id="quarantine-expiresAt"
          label="Expires at"
          hint="Required, in your time zone and in the future. After this moment the test is selected again."
          required
          error={issueFor("expiresAt")}
        >
          {(control) => (
            <input
              {...control}
              style={{ maxWidth: "100%" }}
              type="datetime-local"
              value={form.expiresAtLocal}
              onChange={(event) => setForm({ ...form, expiresAtLocal: event.target.value })}
            />
          )}
        </FormField>
        {formError ? (
          <ViewState kind="error" error={formError} message={formError.message} />
        ) : null}
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <button type="submit" className="button" aria-disabled={checking || !ready}>
            {checking
              ? "Checking the gate effect…"
              : !ready
                ? "Loading the project…"
                : existing
                  ? "Review changes"
                  : "Review quarantine"}
          </button>
          {form.testId || form.reason || form.expiresAtLocal ? (
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setForm(emptyForm);
                setIssues([]);
              }}
            >
              Clear form
            </button>
          ) : null}
        </div>
      </form>
      <h2>Quarantined tests</h2>
      <StatusView
        status={records.status}
        error={records.error}
        onRetry={() => void records.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No quarantined tests"
            message="No test is quarantined in this project. Every test is selected by default."
          />
        }
      >
        <DataTable
          caption="Quarantined tests"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.testId}
          pager={{
            hasMore: records.hasMore,
            loading: records.loadingMore,
            onLoadMore: () => void records.loadMore(),
          }}
        />
        {metrics.status === "error" ? (
          <ViewState
            kind="partial"
            message="Run counts could not be loaded, so they show as not loaded rather than zero."
          />
        ) : null}
      </StatusView>
      <ConfirmDialog
        open={pending !== null}
        title={pending ? titles[pending.change] : ""}
        description="Review what this does to the gate before you confirm. This decision is recorded in the audit log."
        context={dialogContext}
        confirmLabel={pending ? verbs[pending.change] : ""}
        destructive={pending?.change === "remove"}
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
    </>
  );
}

export const routes: PortalRoute[] = [
  {
    path: "/projects/:projectId/quarantine",
    title: "Quarantine",
    element: <QuarantinePage />,
    projectNav: { label: "Quarantine", order: 90 },
  },
];
