import { type ReactNode, useState } from "react";
import { api } from "../../api";
import type { Me } from "../../api/session";
import { BulkActionBar } from "../../components/bulk-action-bar";
import { ConfirmButton } from "../../components/confirm-action";
import type { Column } from "../../components/data-table";
import { SearchableTable } from "../../components/searchable-table";
import { StatusBadge } from "../../components/status";
import { UntrustedText } from "../../components/untrusted-text";
import { StatusView, ViewState } from "../../components/view-state";
import { usePaged, useResource } from "../../hooks/use-resource";
import { useScopedSelection } from "../../hooks/use-scoped-selection";
import type { ProjectSummary } from "../../routes/home";

interface TestSummary {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly archivedAt: string | null;
}

interface SecretRef {
  readonly id: string;
  readonly locator: string;
  readonly secretVersion: number;
  readonly revokedAt?: string | null;
}

interface RunSummary {
  readonly id: string;
  readonly status: string;
  readonly createdAt: string;
  readonly testId?: string;
}

interface BundleEntry {
  readonly artifactId: string;
  readonly relativePath: string;
  readonly kind: string;
  readonly sizeBytes: number;
  readonly state: "available" | "missing" | "expired" | "partial";
}

interface Bundle {
  readonly entries: readonly BundleEntry[];
}

export interface DeletionOperation {
  readonly id: string;
  readonly resourceRefs: readonly string[];
  readonly requestedBy: string;
  readonly revokedAt: string;
  readonly physicalState: "pending" | "running" | "completed" | "failed";
  readonly physicalDeletionDeadlineAt: string | null;
  readonly backupExpiryDeadlineAt: string | null;
  readonly deadlineReason: string;
  readonly backupHolds: readonly string[];
  readonly errors: readonly string[];
}

const artifactStateText: Record<BundleEntry["state"], string> = {
  available: "Available",
  missing: "Missing (never collected for this attempt)",
  expired: "Expired (tombstone kept; deletion tracked below)",
  partial: "Partial",
};

interface SectionProps {
  readonly project: ProjectSummary;
  readonly me: Me;
  readonly onChanged: () => Promise<void>;
}

function context(project: ProjectSummary, me: Me, extra: { label: string; value: string }[]) {
  return [
    { label: "Workspace", value: me.workspace.name },
    { label: "Project", value: project.name },
    ...extra,
  ];
}

function RemoveReferenceSection({ project, me, onChanged }: SectionProps): ReactNode {
  const secrets = usePaged<SecretRef>("/secrets");
  const reason = me.permissions.secret
    ? null
    : "Your role cannot manage secrets (secret access is required).";
  const active = secrets.items.filter((item) => !item.revokedAt);
  const columns: Column<SecretRef>[] = [
    {
      key: "name",
      header: "Secret reference",
      render: (item) => <UntrustedText value={item.locator} maxLength={120} />,
    },
    { key: "version", header: "Version", render: (item) => item.secretVersion },
    {
      key: "actions",
      header: "Action",
      render: (item) =>
        reason ? (
          "—"
        ) : (
          <ConfirmButton
            label="Remove reference"
            subject={item.locator}
            tone="danger"
            dialog={{
              title: "Remove this secret reference?",
              description:
                "The reference stops resolving. The stored value is not exported or shown. Tests that use it fail with an authentication failure.",
              context: context(project, me, [{ label: "Reference", value: item.locator }]),
              confirmLabel: "Remove reference",
              destructive: true,
            }}
            onConfirm={async (idempotencyKey) => {
              await api("DELETE", `/secrets/${encodeURIComponent(item.id)}`, { idempotencyKey });
              await secrets.reload();
              await onChanged();
            }}
            successMessage="Reference removed"
          />
        ),
    },
  ];
  return (
    <section aria-labelledby="remove-reference-heading" className="settings-section">
      <h2 id="remove-reference-heading">Remove a reference</h2>
      <p className="hint">
        Removing a reference stops tests from resolving it. It deletes no test, revision, result or
        artifact.
      </p>
      {reason ? <p className="hint">{reason}</p> : null}
      <StatusView
        status={secrets.status}
        error={secrets.error}
        onRetry={() => void secrets.reload()}
      >
        <SearchableTable
          caption="Active secret references"
          columns={columns}
          rows={active}
          rowKey={(item) => item.id}
          searchText={(item) => item.locator}
          empty={
            <ViewState
              kind="empty"
              title="No active references"
              message="There are no secret references to remove."
            />
          }
          urlPrefix="ref"
        />
      </StatusView>
    </section>
  );
}

function ArchiveTestSection({ project, me, onChanged }: SectionProps): ReactNode {
  const tests = usePaged<TestSummary>(`/projects/${encodeURIComponent(project.id)}/tests`);
  const reason = me.permissions.write
    ? null
    : "Your role cannot archive tests (write access is required).";
  const selection = useScopedSelection(project.id);
  const columns: Column<TestSummary>[] = [
    {
      key: "select",
      header: "Select",
      render: (item) =>
        item.archivedAt || reason ? (
          "—"
        ) : (
          <input
            type="checkbox"
            aria-label={`Select ${item.name}`}
            checked={selection.selected.has(item.id)}
            onChange={() => selection.toggle(item.id)}
          />
        ),
    },
    {
      key: "name",
      header: "Test",
      sortValue: (item) => item.name.toLowerCase(),
      render: (item) => <UntrustedText value={item.name} maxLength={120} />,
    },
    {
      key: "state",
      header: "State",
      sortValue: (item) => (item.archivedAt ? 1 : 0),
      render: (item) => (item.archivedAt ? "Archived" : "Active"),
    },
    {
      key: "actions",
      header: "Action",
      render: (item) =>
        item.archivedAt || reason ? (
          "—"
        ) : (
          <ConfirmButton
            label="Archive test"
            subject={item.name}
            tone="danger"
            dialog={{
              title: "Archive this test?",
              description:
                "The test leaves active lists and no longer runs in schedules or suites. Its revisions, runs, results and artifacts are kept.",
              context: context(project, me, [{ label: "Test", value: item.name }]),
              confirmLabel: "Archive test",
              destructive: true,
            }}
            onConfirm={async (idempotencyKey) => {
              await api("DELETE", `/tests/${encodeURIComponent(item.id)}`, {
                ifMatch: item.version,
                idempotencyKey,
              });
              await tests.reload();
              await onChanged();
            }}
            successMessage="Test archived"
          />
        ),
    },
  ];
  return (
    <section aria-labelledby="archive-test-heading" className="settings-section">
      <h2 id="archive-test-heading">Archive a test</h2>
      <p className="hint">Archiving hides a test from active use. History and evidence stay.</p>
      {reason ? <p className="hint">{reason}</p> : null}
      {reason ? null : (
        <BulkActionBar
          noun="test"
          count={selection.count}
          label="Archive selected tests"
          confirmLabel="Archive selected"
          description="Each selected test leaves active lists. Revisions, runs, results and artifacts are kept. Only the selected tests are archived."
          destructive
          context={context(project, me, [])}
          onClear={selection.clear}
          onConfirm={async (idempotencyKey) => {
            const chosen = tests.items.filter((item) => selection.selected.has(item.id));
            for (const item of chosen)
              await api("DELETE", `/tests/${encodeURIComponent(item.id)}`, {
                ifMatch: item.version,
                idempotencyKey: `${idempotencyKey}:${item.id}`,
              });
            selection.clear();
            await tests.reload();
            await onChanged();
          }}
        />
      )}
      <StatusView status={tests.status} error={tests.error} onRetry={() => void tests.reload()}>
        <SearchableTable
          caption="Tests"
          columns={columns}
          rows={tests.items}
          rowKey={(item) => item.id}
          searchText={(item) => item.name}
          filters={[
            {
              key: "state",
              label: "State",
              options: [
                { value: "active", label: "Active" },
                { value: "archived", label: "Archived" },
              ],
              match: (item, value) => (value === "archived") === Boolean(item.archivedAt),
            },
          ]}
          empty={
            <ViewState kind="empty" title="No tests" message="This project has no tests yet." />
          }
          urlPrefix="tst"
          pager={{
            hasMore: tests.hasMore,
            loading: tests.status === "loading",
            onLoadMore: () => void tests.loadMore(),
          }}
        />
      </StatusView>
    </section>
  );
}

function ArtifactsOfRun({
  runId,
  project,
  me,
  onChanged,
}: SectionProps & { runId: string }): ReactNode {
  const bundle = useResource<Bundle>(`/runs/${encodeURIComponent(runId)}/bundle`);
  const reason =
    me.permissions.admin || me.permissions.write ? null : "Your role cannot expire artifacts.";
  const columns: Column<BundleEntry>[] = [
    {
      key: "path",
      header: "Artifact",
      render: (item) => <UntrustedText value={item.relativePath} maxLength={120} />,
    },
    { key: "kind", header: "Kind", render: (item) => item.kind },
    {
      key: "size",
      header: "Size",
      render: (item) => `${item.sizeBytes.toLocaleString("en-US")} bytes`,
    },
    { key: "state", header: "State", render: (item) => artifactStateText[item.state] },
    {
      key: "actions",
      header: "Action",
      render: (item) =>
        item.state === "expired" || item.state === "missing" || reason ? (
          "—"
        ) : (
          <ConfirmButton
            label="Expire artifact"
            subject={item.relativePath}
            tone="danger"
            dialog={{
              title: "Expire this artifact?",
              description:
                "Access ends now and a tombstone is recorded. Physical removal follows the retention rules and is never earlier than a legal hold allows. The run keeps saying the evidence existed and expired.",
              context: context(project, me, [
                { label: "Run", value: runId },
                { label: "Artifact", value: item.relativePath },
              ]),
              confirmLabel: "Expire artifact",
              destructive: true,
            }}
            onConfirm={async (idempotencyKey) => {
              await api("DELETE", `/artifacts/${encodeURIComponent(item.artifactId)}`, {
                idempotencyKey,
              });
              await bundle.reload();
              await onChanged();
            }}
            successMessage="Artifact expired; deletion is tracked below"
          />
        ),
    },
  ];
  return (
    <StatusView status={bundle.status} error={bundle.error} onRetry={() => void bundle.reload()}>
      <SearchableTable
        caption={`Artifacts of run ${runId}`}
        columns={columns}
        rows={bundle.data?.entries ?? []}
        rowKey={(item) => item.artifactId}
        searchText={(item) => `${item.relativePath} ${item.kind} ${item.state}`}
        empty={
          <ViewState
            kind="empty"
            title="No artifacts recorded"
            message="This run has no artifacts."
          />
        }
        urlPrefix="art"
      />
    </StatusView>
  );
}

function ExpireArtifactSection(props: SectionProps): ReactNode {
  const runs = usePaged<RunSummary>("/runs", { projectId: props.project.id }, 20);
  const [runId, setRunId] = useState<string | null>(null);
  const columns: Column<RunSummary>[] = [
    { key: "id", header: "Run", render: (run) => <code>{run.id}</code> },
    { key: "status", header: "Status", render: (run) => <StatusBadge status={run.status} /> },
    {
      key: "createdAt",
      header: "Created",
      sortValue: (run) => run.createdAt,
      render: (run) => <time dateTime={run.createdAt}>{run.createdAt}</time>,
    },
    {
      key: "actions",
      header: "Action",
      render: (run) => (
        <button
          type="button"
          className="button secondary"
          aria-pressed={runId === run.id}
          onClick={() => setRunId(run.id)}
        >
          Show artifacts<span className="visually-hidden"> of {run.id}</span>
        </button>
      ),
    },
  ];
  return (
    <section aria-labelledby="expire-artifact-heading" className="settings-section">
      <h2 id="expire-artifact-heading">Expire an artifact</h2>
      <p className="hint">
        Expiring ends access to one piece of evidence and records a tombstone. The run, its result
        and the other artifacts stay.
      </p>
      <StatusView status={runs.status} error={runs.error} onRetry={() => void runs.reload()}>
        <SearchableTable
          caption="Recent runs"
          columns={columns}
          rows={runs.items}
          rowKey={(run) => run.id}
          searchText={(run) => `${run.id} ${run.status}`}
          empty={
            <ViewState
              kind="empty"
              title="No runs yet"
              message="Runs for this project appear here."
            />
          }
          urlPrefix="run"
          pager={{
            hasMore: runs.hasMore,
            loading: runs.status === "loading",
            onLoadMore: () => void runs.loadMore(),
          }}
        />
      </StatusView>
      {runId ? <ArtifactsOfRun key={runId} runId={runId} {...props} /> : null}
    </section>
  );
}

export function DeletionOperationsSection({
  project,
  refreshKey,
}: {
  project: ProjectSummary;
  refreshKey: number;
}): ReactNode {
  const operations = usePaged<DeletionOperation>("/deletion-operations", {
    projectId: project.id,
    r: String(refreshKey),
  });
  const columns: Column<DeletionOperation>[] = [
    { key: "id", header: "Operation", render: (item) => <code>{item.id}</code> },
    { key: "refs", header: "Items", render: (item) => item.resourceRefs.length },
    {
      key: "revoked",
      header: "Access ended",
      sortValue: (item) => item.revokedAt,
      render: (item) => <time dateTime={item.revokedAt}>{item.revokedAt}</time>,
    },
    {
      key: "state",
      header: "Physical deletion",
      render: (item) => (
        <StatusBadge
          status={
            item.physicalState === "completed"
              ? "verified"
              : item.physicalState === "failed"
                ? "failed"
                : "pending"
          }
          label={
            item.physicalState === "completed"
              ? "Completed"
              : item.physicalState === "failed"
                ? "Failed"
                : "Scheduled"
          }
        />
      ),
    },
    {
      key: "deadline",
      header: "Due",
      render: (item) =>
        item.physicalDeletionDeadlineAt ? (
          <time dateTime={item.physicalDeletionDeadlineAt}>{item.physicalDeletionDeadlineAt}</time>
        ) : (
          "Held"
        ),
    },
    {
      key: "holds",
      header: "Holds",
      render: (item) => (item.backupHolds.length > 0 ? item.backupHolds.join(", ") : "None"),
    },
    {
      key: "by",
      header: "Requested by",
      render: (item) => <UntrustedText value={item.requestedBy} maxLength={60} />,
    },
  ];
  return (
    <section aria-labelledby="deletions-heading" className="settings-section">
      <h2 id="deletions-heading">Deletion history and tombstones</h2>
      <p className="hint">
        Access to deleted evidence ends immediately. Physical removal is due by the date shown and
        is delayed, never skipped, by a legal hold. Backups expire separately.
      </p>
      <StatusView
        status={operations.status}
        error={operations.error}
        onRetry={() => void operations.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No deletions requested"
            message="Nothing has been removed or expired for this project."
          />
        }
      >
        <SearchableTable
          caption="Deletion operations"
          columns={columns}
          rows={operations.items}
          rowKey={(item) => item.id}
          searchText={(item) => `${item.id} ${item.physicalState} ${item.requestedBy}`}
          empty={
            <ViewState
              kind="empty"
              title="No deletions requested"
              message="Nothing has been removed or expired."
            />
          }
          urlPrefix="del"
          pager={{
            hasMore: operations.hasMore,
            loading: operations.status === "loading",
            onLoadMore: () => void operations.loadMore(),
          }}
        />
      </StatusView>
    </section>
  );
}

function PurgeSection({
  project,
  etag,
  me,
  onChanged,
  reloadProject,
}: SectionProps & { etag: string | null; reloadProject: () => Promise<void> }): ReactNode {
  const reason = me.permissions.admin
    ? null
    : "Your role cannot purge a project (admin access is required).";
  const archived = project.archivedAt !== null;
  const base = `/projects/${encodeURIComponent(project.id)}`;
  return (
    <section aria-labelledby="purge-heading" className="settings-section danger-zone">
      <h2 id="purge-heading">Purge project data</h2>
      <p className="hint">
        Purging ends access to every artifact and input of this project in one operation. It does
        not remove tests, revisions, run results or the audit trail, and it never bypasses a legal
        hold. Only an archived project with no unfinished runs can be purged.
      </p>
      {archived ? (
        <p>
          <StatusBadge status="paused" label="Archived" /> Archived {project.archivedAt}.
        </p>
      ) : (
        <>
          <p>
            <StatusBadge status="verified" label="Active" /> Archive the project before purging it.
          </p>
          <ConfirmButton
            label="Archive project"
            tone="secondary"
            disabledReason={
              me.permissions.write
                ? null
                : "Your role cannot archive projects (write access is required)."
            }
            dialog={{
              title: "Archive this project?",
              description: "An archived project accepts no new runs. Nothing is deleted.",
              context: context(project, me, []),
              confirmLabel: "Archive project",
            }}
            onConfirm={async (idempotencyKey) => {
              await api("POST", `${base}/archive`, { ifMatch: etag, idempotencyKey });
              await reloadProject();
            }}
            successMessage="Project archived"
          />
        </>
      )}
      <ConfirmButton
        label="Purge project data"
        tone="danger"
        disabledReason={reason ?? (archived ? null : "Archive the project first.")}
        dialog={{
          title: "Purge all artifacts and inputs of this project?",
          description:
            "Access to every artifact and input ends now and cannot be undone. Physical removal follows the retention rules; legal holds delay it.",
          context: context(project, me, [{ label: "Slug", value: project.slug }]),
          confirmLabel: "Purge project data",
          destructive: true,
          typed: { label: "Project slug", expected: project.slug },
        }}
        onConfirm={async (idempotencyKey) => {
          await api("POST", `${base}/purge`, {
            body: { confirmationToken: project.slug },
            idempotencyKey,
          });
          await onChanged();
        }}
        successMessage="Purge requested; deletion is tracked below"
      />
    </section>
  );
}

/** Retention and deletion of one project: three distinct actions plus the tombstone history (UX-048). */
export function RetentionPage({
  project,
  etag,
  me,
  reloadProject,
}: {
  project: ProjectSummary;
  etag: string | null;
  me: Me;
  reloadProject: () => Promise<void>;
}): ReactNode {
  const [refreshKey, setRefreshKey] = useState(0);
  const onChanged = async () => setRefreshKey((value) => value + 1);
  return (
    <>
      <p className="hint">
        Three actions are kept apart on purpose: removing a reference, archiving a test and expiring
        an artifact. Each says what stays.
      </p>
      <RemoveReferenceSection project={project} me={me} onChanged={onChanged} />
      <ArchiveTestSection project={project} me={me} onChanged={onChanged} />
      <ExpireArtifactSection project={project} me={me} onChanged={onChanged} />
      <PurgeSection
        project={project}
        etag={etag}
        me={me}
        onChanged={onChanged}
        reloadProject={reloadProject}
      />
      <DeletionOperationsSection project={project} refreshKey={refreshKey} />
    </>
  );
}
